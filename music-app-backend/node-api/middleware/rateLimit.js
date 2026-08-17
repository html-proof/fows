const rateLimit = require('express-rate-limit');

// General API limiter: 120 req/min per IP.
const generalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please try again shortly.' },
});

// Resolve/stream limiter: tighter because each call hits a provider.
const resolveLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Resolve rate limit exceeded. Please slow down.' },
});

module.exports = { generalLimiter, resolveLimiter };
