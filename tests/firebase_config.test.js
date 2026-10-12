// Smoke test for GET /platform/firebase-config (no DB / Firebase needed).
const assert = require('assert');
const path = require('path');
const Module = require('module');
const orig = Module._load;
Module._load = function (req, ...a) {
  if (req === '../db') return { query: async () => [[]] };
  if (req === '../middleware/platformAuth') return {};
  if (req === '../middleware/screenLock') return {};
  if (req === '../utils/asyncHandler') return (f) => f;
  if (req === 'express') { const r = () => ({ use(){}, get(){}, post(){}, put(){}, delete(){} }); const e = () => ({}); e.Router = r; return e; }
  return orig.call(this, req, ...a);
};
const { firebaseConfigHandler } = require(path.join(__dirname, '..', 'src', 'routes', 'lockStatus.js'));

function call() {
  const out = { headers: {}, status: 200 };
  const res = {
    set(k, v) { out.headers[k] = v; return res; },
    status(c) { out.status = c; return res; },
    json(b) { out.body = b; return res; },
  };
  firebaseConfigHandler({}, res);
  return out;
}
const VARS = ['FIREBASE_WEB_API_KEY', 'FIREBASE_AUTH_DOMAIN', 'FIREBASE_PROJECT_ID', 'FIREBASE_WEB_APP_ID', 'FIREBASE_MESSAGING_SENDER_ID', 'FIREBASE_STORAGE_BUCKET'];
VARS.forEach((v) => delete process.env[v]);

let r = call();
assert.strictEqual(r.status, 503);
assert.strictEqual(r.headers['Cache-Control'], 'no-store');
assert.deepStrictEqual(r.body.missing, VARS.slice(0, 4));
assert.ok(r.body.message.includes('FIREBASE_WEB_API_KEY'));

process.env.FIREBASE_WEB_API_KEY = 'k'; process.env.FIREBASE_AUTH_DOMAIN = 'a.firebaseapp.com';
process.env.FIREBASE_PROJECT_ID = 'p';
r = call();
assert.strictEqual(r.status, 503);
assert.deepStrictEqual(r.body.missing, ['FIREBASE_WEB_APP_ID']);

process.env.FIREBASE_WEB_APP_ID = '1:2:web:3';
r = call();
assert.strictEqual(r.status, 200);
assert.strictEqual(r.headers['Cache-Control'], 'no-store');
assert.deepStrictEqual(r.body, { apiKey: 'k', authDomain: 'a.firebaseapp.com', projectId: 'p', appId: '1:2:web:3' });

process.env.FIREBASE_STORAGE_BUCKET = 'b';
assert.strictEqual(call().body.storageBucket, 'b');
console.log('firebase_config.test.js ok');
