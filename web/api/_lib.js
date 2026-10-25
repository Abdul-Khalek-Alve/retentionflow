// Shared helpers for the RetentionFlow AI Vercel functions. No secrets live in code:
// ANTHROPIC_API_KEY, the Upstash/KV REST credentials and the optional ADVISOR_CODE are Vercel env vars.
const redisUrl = () => process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const redisToken = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
async function redis(command) {
  const r = await fetch(redisUrl(), { method: "POST", headers: { Authorization: `Bearer ${redisToken()}`, "Content-Type": "application/json" }, body: JSON.stringify(command) });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || `Redis HTTP ${r.status}`);
  return j.result;
}
// tiny fixed-window rate limit per IP (best effort; skipped when no store is configured)
async function rateLimit(req, bucket, max, windowSec) {
  if (!redisUrl()) return true;
  const ip = String(req.headers["x-forwarded-for"] || "anon").split(",")[0].trim();
  const key = `rf:rl:${bucket}:${ip}:${Math.floor(Date.now() / 1000 / windowSec)}`;
  try { const n = await redis(["INCR", key]); if (n === 1) await redis(["EXPIRE", key, windowSec]); return n <= max; } catch (e) { return true; }
}
function body(req) { if (req.body && typeof req.body === "object") return req.body; try { return JSON.parse(req.body || "{}"); } catch (e) { return {}; } }
function send(res, status, obj) { res.statusCode = status; res.setHeader("Content-Type", "application/json"); res.setHeader("Cache-Control", "no-store"); res.end(JSON.stringify(obj)); }
module.exports = { redis, redisUrl, rateLimit, body, send };
