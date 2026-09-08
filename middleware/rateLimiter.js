const { ipKeyGenerator } = require("express-rate-limit");

// ======================================================
// FAILED LOGIN TRACKING & COOLDOWN STORE (IN-MEMORY)
// ======================================================
// Key: `${clientIp}_${normalizedEmail}`
// Value: { key: string, failedAttempts: number, lockedUntil: number | null, expiresAt: number }
// ======================================================

const failedAttemptsStore = new Map();

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const COOLDOWN_DURATION_MS = 5 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 5;

// Periodic cleanup of expired records
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, record] of failedAttemptsStore.entries()) {
    const isLockExpired = !record.lockedUntil || now >= record.lockedUntil;
    const isRecordExpired = now >= record.expiresAt;
    if (isLockExpired && isRecordExpired) {
      failedAttemptsStore.delete(key);
    }
  }
}, CLEANUP_INTERVAL_MS);

if (cleanupTimer.unref) {
  cleanupTimer.unref();
}

/**
 * Normalizes client IP to ensure loopbacks (::1, ::ffff:127.0.0.1, 127.0.0.1)
 * and IPv6 subnets produce consistent keys.
 */
function normalizeClientIp(req) {
  let rawIp = req.ip || req.socket?.remoteAddress || "127.0.0.1";

  if (typeof rawIp === "string" && rawIp.startsWith("::ffff:")) {
    rawIp = rawIp.substring(7);
  }

  if (rawIp === "::1" || rawIp === "127.0.0.1" || rawIp === "localhost") {
    return "127.0.0.1";
  }

  try {
    return ipKeyGenerator(rawIp);
  } catch (err) {
    return rawIp;
  }
}

/**
 * Generate rate limit key from normalized client IP and normalized email.
 */
function getRateLimitKey(req) {
  const clientIp = normalizeClientIp(req);
  const email = (req.body?.email || "").trim().toLowerCase();
  return `${clientIp}_${email}`;
}

/**
 * Middleware: Check whether IP + email combination is currently locked.
 * Must be executed BEFORE any database lookup or password comparison.
 * While locked (lockedUntil > Date.now()), rejects immediately with HTTP 429.
 */
function checkLoginCooldown(req, res, next) {
  const key = getRateLimitKey(req);
  const record = failedAttemptsStore.get(key);

  if (record && record.lockedUntil) {
    if (Date.now() < record.lockedUntil) {
      return res.status(429).json({
        status: false,
        message: "Too many login attempts. Please try again after 5 minutes.",
      });
    } else {
      // Cooldown expired: remove record and allow normal login
      failedAttemptsStore.delete(key);
    }
  }

  next();
}

/**
 * Helper: Record a failed authentication attempt.
 * Increments failure count; marks key locked for 15 minutes on the 5th failure.
 */
function recordFailedLogin(req) {
  const key = getRateLimitKey(req);
  const now = Date.now();
  let record = failedAttemptsStore.get(key);

  if (!record || (record.expiresAt && now >= record.expiresAt && !record.lockedUntil)) {
    record = {
      key,
      failedAttempts: 1,
      lockedUntil: null,
      expiresAt: now + COOLDOWN_DURATION_MS,
    };
  } else {
    record.failedAttempts += 1;
    record.expiresAt = now + COOLDOWN_DURATION_MS;
  }

  if (record.failedAttempts >= MAX_FAILED_ATTEMPTS) {
    record.lockedUntil = now + COOLDOWN_DURATION_MS;
  }

  failedAttemptsStore.set(key, record);
}

/**
 * Helper: Clear failed login tracking record on successful authentication.
 */
function clearFailedLogin(req) {
  const key = getRateLimitKey(req);
  failedAttemptsStore.delete(key);
}

module.exports = {
  checkLoginCooldown,
  recordFailedLogin,
  clearFailedLogin,
};
