// GET  /api/store?kind=reviews|outcomes|ratings  -> latest items (newest first)
// POST /api/store?kind=reviews|outcomes|ratings  -> append one item (append-only audit log; no update or delete route)
const { redis, redisUrl, rateLimit, body, send } = require("./_lib");
const KINDS = { reviews: "rf:reviews", outcomes: "rf:outcomes", ratings: "rf:ratings" };
const ACTIONS = ["contact_now", "check_in", "financial_counselling", "academic_support", "wellbeing_referral", "monitor", "none"];
const TAGS = ["personal", "finance_changed", "academic_changed", "engagement", "data_issue", "explanation", "other"];
const OUTCOMES = ["support_accepted", "support_declined", "not_reached", "resolved", "still_at_risk", "withdrew"];
const BANDS = ["Low", "Medium", "High"];
const clean = (v, n) => String(v == null ? "" : v).slice(0, n);
const num = (v, lo, hi) => { const x = Number(v); return Number.isFinite(x) ? Math.min(Math.max(x, lo), hi) : null; };
function sanitize(kind, x) {
  const id = clean(x.id, 16), cp = x.checkpoint === "sem2" ? "sem2" : "sem1", advisor = clean(x.advisor, 60) || "Advisor";
  if (kind === "reviews") {
    const decision = ["agree", "disagree", "override"].includes(x.decision) ? x.decision : null;
    if (!decision || !/^S\d{4}$/.test(String(x.student_id))) return null;
    return { id, student_id: x.student_id, checkpoint: cp, advisor,
      ai_risk: num(x.ai_risk, 0, 1), ai_band: BANDS.includes(x.ai_band) ? x.ai_band : null, ai_uncertain: !!x.ai_uncertain, ai_flagged: !!x.ai_flagged, decision,
      direction: decision === "disagree" && ["lower", "higher"].includes(x.direction) ? x.direction : null,
      override_band: decision === "override" && BANDS.includes(x.override_band) ? x.override_band : null,
      reason_tags: Array.isArray(x.reason_tags) ? [...new Set(x.reason_tags.filter(t => TAGS.includes(t)))] : [], reason: clean(x.reason, 600),
      planned_action: ACTIONS.includes(x.planned_action) ? x.planned_action : "monitor", priority: ["urgent", "week", "month"].includes(x.priority) ? x.priority : null,
      follow_up: /^\d{4}-\d{2}-\d{2}$/.test(String(x.follow_up || "")) ? x.follow_up : null,
      clarity: num(x.clarity, 1, 5), usefulness: num(x.usefulness, 1, 5), trust: num(x.trust, 1, 5), actionability: num(x.actionability, 1, 5) };
  }
  if (kind === "outcomes") {
    if (!/^S\d{4}$/.test(String(x.student_id)) || !OUTCOMES.includes(x.outcome)) return null;
    return { id, student_id: x.student_id, review_id: clean(x.review_id, 16), checkpoint: cp, advisor, outcome: x.outcome, note: clean(x.note, 400), closed: !!x.closed };
  }
  return { helpful: !!x.helpful, question: clean(x.question, 300), tools: num(x.tools, 0, 50), checkpoint: cp, view: clean(x.view, 20), advisor: clean(x.advisor, 60) };
}
module.exports = async (req, res) => {
  const kind = String((req.query && req.query.kind) || new URL(req.url, "http://x").searchParams.get("kind") || "");
  const listKey = KINDS[kind];
  if (!listKey) return send(res, 400, { error: "bad_kind" });
  if (!redisUrl()) return send(res, 503, { error: "not_configured", message: "Connect an Upstash Redis store to this Vercel project." });
  try {
    if (req.method === "GET") {
      const rows = await redis(["LRANGE", listKey, 0, 1999]);
      return send(res, 200, { items: rows.map(s => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean) });
    }
    if (req.method === "POST") {
      if (process.env.ADVISOR_CODE && req.headers["x-advisor-code"] !== process.env.ADVISOR_CODE) return send(res, 403, { error: "bad_code", message: "Wrong advisor access code." });
      if (!(await rateLimit(req, "store", 60, 600))) return send(res, 429, { error: "rate_limited", message: "Too many saves. Wait a few minutes." });
      const item = sanitize(kind, body(req));
      if (!item) return send(res, 400, { error: "bad_item" });
      item.at = new Date().toISOString();
      await redis(["LPUSH", listKey, JSON.stringify(item)]);
      await redis(["LTRIM", listKey, 0, 4999]);
      return send(res, 200, { ok: true, item });
    }
    return send(res, 405, { error: "method_not_allowed" });
  } catch (e) { return send(res, 502, { error: "store_error", message: "The review store did not respond." }); }
};
