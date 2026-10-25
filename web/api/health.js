const { redisUrl, send } = require("./_lib");
module.exports = async (req, res) => send(res, 200, {
  ok: true,
  copilot: !!(process.env.GEMINI_API_KEY || process.env.ANTHROPIC_API_KEY),
  provider: process.env.COPILOT_PROVIDER || (process.env.GEMINI_API_KEY ? "gemini" : process.env.ANTHROPIC_API_KEY ? "anthropic" : null),
  store: !!redisUrl(),
  code_required: !!process.env.ADVISOR_CODE,
  model: process.env.GEMINI_API_KEY ? (process.env.GEMINI_MODEL || "gemini-flash-latest") : (process.env.COPILOT_MODEL || "claude-haiku-5-5"),
});
