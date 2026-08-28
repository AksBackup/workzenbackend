/**
 * Wraps an async route handler so a rejected promise (e.g. a failed DB
 * query) is passed to Express's error-handling middleware instead of
 * becoming an unhandled rejection that crashes the whole process.
 *
 * Every route handler in this project should be wrapped with this -
 * an unwrapped handler that throws takes down the server for every
 * company using it, not just the one request that failed.
 */
function asyncHandler(fn) {
    return function (req, res, next) {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}

module.exports = asyncHandler;
