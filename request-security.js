// Log before parsing, keeping query names but never their values. This also
// covers unknown credential parameter names and avoids multiline log injection.
function logRequest(req, res, next) {
    const [pathname, ...query] = req.originalUrl.split("?");
    const params = new URLSearchParams(query.join("?"));
    for (const key of new Set(params.keys())) params.set(key, "[REDACTED]");
    const url = pathname + (query.length ? `?${params}` : "");
    console.log(`${req.method} ${url.replace(/[\r\n\u0000-\u001f\u007f]/g, "")}`);
    next();
}

// Bounded, single-process, per-IP fixed windows. Count attempts before parsing
// or bcrypt, including malformed bodies. Expired entries are removed each minute.
function createAuthRateLimiter({ now = Date.now, maxKeys = 10000 } = {}) {
    const limits = { "/signup": 20, "/login": 30, "/forgot-password": 10, "/reset-password": 20 };
    const windowMs = 15 * 60 * 1000;
    const buckets = new Map();
    let sweepAt = 0;
    return (req, res, next) => {
        const route = req.path.toLowerCase().replace(/\/+$/, "");
        const limit = limits[route];
        if (req.method !== "POST" || !limit) return next();
        const time = now();
        if (time >= sweepAt) {
            for (const [key, value] of buckets) if (value.expires <= time) buckets.delete(key);
            sweepAt = time + 60000;
        }
        const key = `${req.ip}:${route}`;
        let bucket = buckets.get(key);
        if (bucket && bucket.expires <= time) { buckets.delete(key); bucket = undefined; }
        const reject = (seconds) => {
            res.set("Retry-After", String(Math.max(1, seconds)));
            return res.status(429).json({ success: false, message: "Too many authentication requests; try again later" });
        };
        // Fail closed at capacity rather than evicting active limits.
        if (!bucket) {
            if (buckets.size >= maxKeys) return reject(60);
            bucket = { count: 0, expires: time + windowMs };
            buckets.set(key, bucket);
        }
        if (bucket.count >= limit) return reject(Math.ceil((bucket.expires - time) / 1000));
        bucket.count++;
        next();
    };
}

module.exports = { logRequest, createAuthRateLimiter };
