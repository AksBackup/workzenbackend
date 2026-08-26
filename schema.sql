-- ============================================================
-- HRMS Database Schema — Oracle MySQL HeatWave (Always Free)
-- Phase 1 deliverable
--
-- Design notes for whoever builds the API layer (Phase 2):
--   - MySQL has no Postgres-style Row Level Security. EVERY query
--     touching a table with a company_id column MUST filter by the
--     company_id taken from the verified Firebase ID token's custom
--     claims. This is not optional — it is the only tenant isolation
--     this schema has. Never trust a company_id passed in a request body.
--   - firebase_uid columns link a row to a Firebase Auth account.
--     They are nullable where the account may not exist yet
--     (e.g. an employee row created by biometric enrollment before
--     credentials are generated).
--   - All timestamps are UTC. Convert to local time in the client.
--   - Engine: InnoDB everywhere (required for foreign keys).
--   - Charset: utf8mb4 (needed for names, emoji in notifications, etc).
-- ============================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ---------------------------------------------------------
-- 1. LICENSING
-- ---------------------------------------------------------

CREATE TABLE licenses (
    id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    license_key         VARCHAR(64) NOT NULL UNIQUE,
    company_id          BIGINT UNSIGNED NULL,          -- set on activation, permanent after
    status              ENUM('unused','active','revoked','expired') NOT NULL DEFAULT 'unused',
    max_employees       INT UNSIGNED NOT NULL DEFAULT 50,
    device_fingerprint  VARCHAR(128) NULL,              -- machine id bound on activation
    issued_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    activated_at        DATETIME NULL,
    expires_at          DATETIME NULL,
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE companies (
    id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name                VARCHAR(150) NOT NULL,
    license_id          BIGINT UNSIGNED NOT NULL,
    address             VARCHAR(255) NULL,
    phone               VARCHAR(30) NULL,
    email               VARCHAR(150) NULL,
    status              ENUM('active','suspended') NOT NULL DEFAULT 'active',
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_company_license FOREIGN KEY (license_id) REFERENCES licenses(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE licenses
    ADD CONSTRAINT fk_license_company FOREIGN KEY (company_id) REFERENCES companies(id);

-- ---------------------------------------------------------
-- 2. USERS: ADMIN (exactly one per company) + EMPLOYEES
-- ---------------------------------------------------------

CREATE TABLE admins (
    id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    company_id          BIGINT UNSIGNED NOT NULL UNIQUE,   -- UNIQUE enforces "1 admin per company"
    firebase_uid        VARCHAR(128) NOT NULL UNIQUE,
    name                VARCHAR(100) NOT NULL,
    email               VARCHAR(150) NOT NULL,
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_admin_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE employees (
    id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    company_id          BIGINT UNSIGNED NOT NULL,
    emp_code            VARCHAR(20) NOT NULL,               -- auto-generated, e.g. "ACM-0007"
    firebase_uid        VARCHAR(128) NULL UNIQUE,            -- null until credentials are issued
    name                VARCHAR(100) NOT NULL,
    designation         VARCHAR(100) NULL,
    department          VARCHAR(100) NULL,
    doj                 DATE NULL,
    salary              DECIMAL(12,2) NULL,
    photo_url           VARCHAR(255) NULL,
    biometric_template_id VARCHAR(128) NULL,                 -- id returned by scanner SDK on enroll
    status              ENUM('active','inactive') NOT NULL DEFAULT 'active',
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_employee_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
    UNIQUE KEY uq_company_empcode (company_id, emp_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX idx_employees_company ON employees(company_id);

-- ---------------------------------------------------------
-- 3. DEVICES (fingerprint scanners / attendance terminals)
-- ---------------------------------------------------------

CREATE TABLE devices (
    id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    company_id          BIGINT UNSIGNED NOT NULL,
    device_name         VARCHAR(100) NOT NULL,
    serial_no           VARCHAR(100) NULL,
    location             VARCHAR(100) NULL,
    ip_address          VARCHAR(45) NULL,
    status              ENUM('online','offline') NOT NULL DEFAULT 'offline',
    last_heartbeat      DATETIME NULL,
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_device_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------
-- 4. ATTENDANCE
-- one row per employee per day; check_in/check_out updated in place
-- ---------------------------------------------------------

CREATE TABLE attendance (
    id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    company_id          BIGINT UNSIGNED NOT NULL,
    employee_id         BIGINT UNSIGNED NOT NULL,
    date                DATE NOT NULL,
    check_in            DATETIME NULL,
    check_out           DATETIME NULL,
    source              ENUM('scanner','manual','mobile') NOT NULL DEFAULT 'scanner',
    device_id           BIGINT UNSIGNED NULL,
    synced_from_local    BOOLEAN NOT NULL DEFAULT FALSE,     -- true if this came from the offline queue
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_attendance_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
    CONSTRAINT fk_attendance_employee FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
    CONSTRAINT fk_attendance_device FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE SET NULL,
    UNIQUE KEY uq_employee_date (employee_id, date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX idx_attendance_company_date ON attendance(company_id, date);

-- ---------------------------------------------------------
-- 5. LEAVE MANAGEMENT
-- ---------------------------------------------------------

CREATE TABLE leave_types (
    id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    company_id          BIGINT UNSIGNED NOT NULL,
    name                VARCHAR(50) NOT NULL,               -- Casual, Sick, Earned, etc.
    yearly_quota        INT UNSIGNED NOT NULL DEFAULT 0,
    carry_forward       BOOLEAN NOT NULL DEFAULT FALSE,
    CONSTRAINT fk_leavetype_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE leave_balances (
    id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    employee_id         BIGINT UNSIGNED NOT NULL,
    leave_type_id       BIGINT UNSIGNED NOT NULL,
    year                SMALLINT UNSIGNED NOT NULL,
    allocated           DECIMAL(5,1) NOT NULL DEFAULT 0,
    used                DECIMAL(5,1) NOT NULL DEFAULT 0,
    CONSTRAINT fk_leavebal_employee FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
    CONSTRAINT fk_leavebal_type FOREIGN KEY (leave_type_id) REFERENCES leave_types(id) ON DELETE CASCADE,
    UNIQUE KEY uq_emp_type_year (employee_id, leave_type_id, year)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE leave_applications (
    id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    company_id          BIGINT UNSIGNED NOT NULL,
    employee_id         BIGINT UNSIGNED NOT NULL,
    leave_type_id       BIGINT UNSIGNED NOT NULL,
    from_date           DATE NOT NULL,
    to_date             DATE NOT NULL,
    days_count          DECIMAL(5,1) NOT NULL,
    reason              VARCHAR(255) NULL,
    status              ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
    applied_on          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    approved_by         BIGINT UNSIGNED NULL,               -- admins.id
    approved_on         DATETIME NULL,
    CONSTRAINT fk_leaveapp_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
    CONSTRAINT fk_leaveapp_employee FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
    CONSTRAINT fk_leaveapp_type FOREIGN KEY (leave_type_id) REFERENCES leave_types(id),
    CONSTRAINT fk_leaveapp_admin FOREIGN KEY (approved_by) REFERENCES admins(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------
-- 6. TASKS / FOLLOW-UPS
-- ---------------------------------------------------------

CREATE TABLE tasks (
    id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    company_id          BIGINT UNSIGNED NOT NULL,
    employee_id         BIGINT UNSIGNED NOT NULL,
    title               VARCHAR(150) NOT NULL,
    description         TEXT NULL,
    due_date            DATE NULL,
    status              ENUM('pending','in_progress','completed') NOT NULL DEFAULT 'pending',
    created_by          BIGINT UNSIGNED NULL,               -- admins.id, null if self-created
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_task_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
    CONSTRAINT fk_task_employee FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------
-- 7. COMPANY CALENDAR (holidays / events) + weekly off
-- ---------------------------------------------------------

CREATE TABLE holidays (
    id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    company_id          BIGINT UNSIGNED NOT NULL,
    date                DATE NOT NULL,
    name                VARCHAR(100) NOT NULL,
    type                ENUM('national','festival','optional','event') NOT NULL DEFAULT 'festival',
    CONSTRAINT fk_holiday_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
    UNIQUE KEY uq_company_date_name (company_id, date, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE weekly_off_config (
    id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    company_id          BIGINT UNSIGNED NOT NULL,
    department          VARCHAR(100) NULL,                  -- null = applies to whole company
    off_days_bitmask    TINYINT UNSIGNED NOT NULL DEFAULT 1, -- bit0=Sun ... bit6=Sat
    alternate_saturdays VARCHAR(20) NULL,                    -- e.g. "2nd,4th" or null
    CONSTRAINT fk_weeklyoff_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------
-- 8. NOTIFICATIONS LOG
-- ---------------------------------------------------------

CREATE TABLE notifications (
    id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    company_id          BIGINT UNSIGNED NOT NULL,
    channel             ENUM('sms','email','push') NOT NULL,
    audience             VARCHAR(100) NOT NULL,               -- 'all', department name, or employee_id
    subject             VARCHAR(150) NULL,
    body                TEXT NULL,
    status              ENUM('sent','failed','queued') NOT NULL DEFAULT 'queued',
    sent_at             DATETIME NULL,
    CONSTRAINT fk_notification_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET FOREIGN_KEY_CHECKS = 1;
