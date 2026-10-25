// POST /api/copilot  — forwards one round of the co-pilot conversation to Anthropic's Messages API.
// The page runs the agent loop and executes the tools itself (they call the trained model in the browser);
// this function only holds the API key, adds the fixed safety rules, and caps size and rate.
const { rateLimit, body, send } = require("./_lib");
const FIXED_RULES = `You are the RetentionFlow AI co-pilot for university Student Success Advisors (an ICT605 student project).
Only help with student-retention advising, the RetentionFlow dashboard, its model and its evidence. Politely decline unrelated requests.
Every number you state must come from a tool result. Never recommend punitive or automatic actions. Never reason from gender, nationality, marital status or international status. The advisor makes every decision.`;
module.exports = async (req, res) => {
  if (req.method !== "POST") return send(res, 405, { error: "method_not_allowed" });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return send(res, 503, { error: "not_configured", message: "Set ANTHROPIC_API_KEY in the Vercel project settings." });
  if (!(await rateLimit(req, "copilot", 40, 600))) return send(res, 429, { error: "rate_limited", message: "Too many co-pilot requests. Wait a few minutes." });
  const b = body(req);
  const messages = Array.isArray(b.messages) ? b.messages.slice(-30) : null;
  if (!messages || !messages.length) return send(res, 400, { error: "bad_request", message: "messages required" });
  const raw = JSON.stringify({ system: b.system, messages, tools: b.tools });
  if (raw.length > 200000) return send(res, 413, { error: "too_large", message: "Conversation too long. Start a new chat." });
  const tools = Array.isArray(b.tools) ? b.tools.slice(0, 10).map(t => ({ name: String(t.name).slice(0, 64), description: String(t.description || "").slice(0, 1000), input_schema: t.input_schema || { type: "object", properties: {} } })) : undefined;
  try {
    const r = await fetch((process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com") + "/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: process.env.COPILOT_MODEL || "claude-haiku-5-5", max_tokens: 1200,
        system: FIXED_RULES + "\n\n" + String(b.system || "").slice(0, 12000), messages, ...(tools ? { tools } : {}) }),
    });
    const j = await r.json();
    if (!r.ok) return send(res, r.status, { error: (j.error && j.error.type) || "upstream_error", message: (j.error && j.error.message) || "Anthropic API error" });
    return send(res, 200, { content: j.content, stop_reason: j.stop_reason, model: j.model });
  } catch (e) { return send(res, 502, { error: "upstream_error", message: "Could not reach the Anthropic API." }); }
};
