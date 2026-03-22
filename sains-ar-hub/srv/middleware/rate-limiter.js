'use strict';

// Simple in-process rate limiter using a sliding window.
// For production multi-instance deployment, replace with Redis-backed rate limiter.

const noop = (req, res, next) => next();

let customerPortalLimiter = noop;
let webhookLimiter = noop;

try {
  const rateLimit = require('express-rate-limit');

  customerPortalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    validate: false,
    keyGenerator: (req) => req.user?.id || req.ip,
    message: { error: 'Too many requests. Please wait 1 minute before retrying.', code: 429 },
  });

  webhookLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 1000,
    validate: false,
    keyGenerator: (req) => req.ip,
    message: { error: 'Webhook rate limit exceeded', code: 429 },
  });
} catch {
  // express-rate-limit not installed — noop middleware already assigned
}

module.exports = { customerPortalLimiter, webhookLimiter };
