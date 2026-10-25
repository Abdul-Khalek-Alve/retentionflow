const { redisUrl, rateLimit, send } = require("./_lib");
module.exports = async (req, res) => {
  const out = {
    ok: true,
    copilot: !!(process.env.GEMINI_API_KEY || process.env.ANTHROPIC_API_KEY),
    provider: process.env.COPILOT_PROVIDER || (process.env.GEMINI_API_KEY ? "gemini" : process.env.ANTHROPIC_API_KEY ? "anthropic" : null),
    store: !!redisUrl(),
    code_required: !!process.env.ADVISOR_CODE,
    model: process.env.GEMINI_API_KEY ? (process.env.GEMINI_MODEL || "auto") : (process.env.COPILOT_MODEL || "claude-haiku-5-5"),
  };
  const q = (req.query && req.query.probe) || new URL(req.url, "http://x").searchParams.get("probe");
  if (q && out.provider === "gemini") {
    if (!(await rateLimit(req, "probe", 10, 600))) return send(res, 429, { ...out, probe: { ok: false, error: "rate_limited" } });
    out.probe = await require("./_gemini").probe(process.env.GEMINI_API_KEY);
  }
  send(res, 200, out);
};
