const { redisUrl, send } = require("./_lib");
module.exports = async (req, res) => send(res, 200, {
  ok: true,
  copilot: !!process.env.ANTHROPIC_API_KEY,
  store: !!redisUrl(),
  code_required: !!process.env.ADVISOR_CODE,
  model: process.env.COPILOT_MODEL || "claude-haiku-5-5",
});
