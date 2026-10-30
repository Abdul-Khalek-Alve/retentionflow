// Gemini adapter for the co-pilot. The page speaks the Anthropic Messages shape (text / tool_use /
// tool_result blocks); this module translates one round to Gemini generateContent (function calling)
// and back, so the browser-side agent loop and its tools stay unchanged.
// Env: GEMINI_API_KEY (required), GEMINI_MODEL (optional), GEMINI_BASE_URL (optional, for testing).
const BASE = () => (process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com") + "/v1beta/models/";
const MODELS = () => [process.env.GEMINI_MODEL, "gemini-flash-latest", "gemini-3.6-flash", "gemini-2.5-flash"].filter(Boolean);

function toGemini(system, messages, tools, opts = {}) {
  const names = {};                                  // tool_use_id -> function name
  const contents = messages.map(m => {
    const role = m.role === "assistant" ? "model" : "user";
    if (typeof m.content === "string") return { role, parts: [{ text: m.content }] };
    const parts = m.content.map(b => {
      if (b._gemini_part) { if (b.type === "tool_use") names[b.id] = b.name; return b._gemini_part; }   // keeps thought signatures
      if (b.type === "text") return { text: b.text };
      if (b.type === "tool_use") { names[b.id] = b.name; return { functionCall: { name: b.name, args: b.input || {} } }; }
      if (b.type === "tool_result") {
        let response; try { response = JSON.parse(b.content); } catch (e) { response = { content: String(b.content) }; }
        if (typeof response !== "object" || Array.isArray(response) || response === null) response = { result: response };
        if (b.is_error) response = { error: String(b.content) };
        return { functionResponse: { name: names[b.tool_use_id] || "tool", response } };
      }
      return { text: "" };
    }).filter(p => !(p.text === "" && Object.keys(p).length === 1));
    return { role, parts };
  });
  const body = { contents, systemInstruction: { parts: [{ text: system }] }, generationConfig: { maxOutputTokens: Number(process.env.GEMINI_MAX_TOKENS) || 8192, temperature: 0.3 } };   // thinking models spend part of this budget before they write
  if (tools && tools.length) body.tools = [{ functionDeclarations: tools.map(t => ({ name: t.name, description: t.description, parametersJsonSchema: t.input_schema })) }];
  if (body.tools && opts.toolChoice === "none") body.toolConfig = { functionCallingConfig: { mode: "NONE" } };   // "answer now" round: text only
  return body;
}

function fromGemini(j, model) {
  const cand = (j.candidates || [])[0] || {}, parts = (cand.content && cand.content.parts) || [];
  let n = 0;
  const content = parts.filter(p => !p.thought).map(p => {
    if (p.functionCall) return { type: "tool_use", id: `g${Date.now().toString(36)}${n++}`, name: p.functionCall.name, input: p.functionCall.args || {}, _gemini_part: p };
    if (typeof p.text === "string") return { type: "text", text: p.text, _gemini_part: p };
    return null;
  }).filter(Boolean);
  const stop_reason = content.some(b => b.type === "tool_use") ? "tool_use" : (cand.finishReason === "MAX_TOKENS" ? "max_tokens" : "end_turn");
  if (!content.length && cand.finishReason === "SAFETY") return { error: "refused", message: "Gemini declined to answer that request." };
  return { content, stop_reason, model };
}

let WORKING = null;                                 // {model, mode} that last succeeded (kept per warm instance)
const AUTH_MODES = ["header", "query", "bearer"];   // x-goog-api-key header, ?key= parameter, Authorization: Bearer
function req(key, mode, url) {
  const u = mode === "query" ? url + (url.includes("?") ? "&" : "?") + "key=" + encodeURIComponent(key) : url;
  const h = { "Content-Type": "application/json" };
  if (mode === "header") h["x-goog-api-key"] = key;
  if (mode === "bearer") h.Authorization = "Bearer " + key;
  return { u, h };
}
const isBusy = (status, msg) => status === 503 || status === 500 || status === 504 || /high demand|overloaded|UNAVAILABLE|try again later/i.test(msg);
const isAuthErr = (status, msg) => status === 401 || status === 403 || (status === 400 && /api key|api_key|credential|ACCESS_TOKEN/i.test(msg));
// Ask Google which models this key can call with generateContent; prefer Flash models (fast, cheap).
async function discoverModels(key, mode) {
  const { u, h } = req(key, mode, BASE().replace(/\/$/, "") + "?pageSize=200");
  try {
    const r = await fetch(u, { headers: h }); const j = await r.json().catch(() => ({}));
    if (!r.ok) return [];
    const names = (j.models || []).filter(m => (m.supportedGenerationMethods || []).includes("generateContent")).map(m => String(m.name).replace(/^models\//, ""));
    const score = n => (/flash/.test(n) ? 0 : 10) + (/lite|image|tts|audio|live|embed|vision/.test(n) ? 5 : 0) + (/preview|exp/.test(n) ? 1 : 0);
    return names.sort((x, y) => score(x) - score(y) || y.localeCompare(x)).slice(0, 4);
  } catch (e) { return []; }
}
async function callOnce(key, model, mode, body) {
  const { u, h } = req(key, mode, BASE() + encodeURIComponent(model) + ":generateContent");
  try { const r = await fetch(u, { method: "POST", headers: h, body }); return { status: r.status, ok: r.ok, j: await r.json().catch(() => ({})) }; }
  catch (e) { return { status: 0, ok: false, j: { error: { message: "Could not reach the Gemini API: " + (e && e.message) } } }; }
}
async function geminiRound(key, system, messages, tools, opts = {}) {
  const body = JSON.stringify(toGemini(system, messages, tools, opts));
  if (WORKING) {                                    // fast path once a combination is known to work
    const r = await callOnce(key, WORKING.model, WORKING.mode, body);
    if (r.ok) return fromGemini(r.j, WORKING.model);
    const em = (r.j.error && r.j.error.message) || "";
    if (r.status !== 404 && !isBusy(r.status, em) && !isAuthErr(r.status, em)) return mapErr(r);
    WORKING = null;
  }
  // 1) find an auth mode the key accepts, using the first candidate model
  let models = MODELS(), mode = null, lastErr = null;
  for (const m of AUTH_MODES) {
    const r = await callOnce(key, models[0], m, body);
    if (r.ok) { WORKING = { model: models[0], mode: m }; return fromGemini(r.j, models[0]); }
    const msg = (r.j.error && r.j.error.message) || "";
    lastErr = r;
    if (!isAuthErr(r.status, msg)) { mode = m; break; }   // auth accepted (e.g. 404 model, 400 bad request)
  }
  if (!mode) { console.error("[copilot] Gemini rejected the key in every auth mode:", lastErr.status, lastErr.j.error && lastErr.j.error.message); return { status: 401, error: "authentication_error", message: "Google rejected the Gemini API key: " + ((lastErr.j.error && lastErr.j.error.message) || lastErr.status) }; }
  const lastMsg = (lastErr.j.error && lastErr.j.error.message) || "";
  if (lastErr.status !== 404 && !isBusy(lastErr.status, lastMsg)) return mapErr(lastErr);
  let busySeen = isBusy(lastErr.status, lastMsg);
  // 2) the first model is missing or busy: try the rest, then whatever this key can actually use
  const tried = new Set([models[0]]);
  const discovered = await discoverModels(key, mode);
  const fallbacks = ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-flash-lite-latest"];
  for (const model of [...models.slice(1), ...discovered, ...fallbacks].slice(0, 9)) {
    if (tried.has(model)) continue; tried.add(model);
    const r = await callOnce(key, model, mode, body);
    if (r.ok) { WORKING = { model, mode }; console.log("[copilot] using Gemini model", model, "auth", mode); return fromGemini(r.j, model); }
    const m2 = (r.j.error && r.j.error.message) || "";
    if (isBusy(r.status, m2)) { busySeen = true; continue; }        // overloaded: move on to another model
    if (r.status !== 404) return mapErr(r);
  }
  if (busySeen) return { status: 503, error: "overloaded_error", message: "Gemini is very busy right now. Wait a few seconds and ask again." };
  console.error("[copilot] no usable Gemini model; tried", [...tried].join(", "));
  return { status: 404, error: "model_not_found", message: `No Gemini model was available for this key (tried ${[...tried].join(", ")}). Set GEMINI_MODEL in Vercel.` };
}
function mapErr(r) {
  const msg = (r.j.error && r.j.error.message) || `Gemini HTTP ${r.status}`;
  console.error("[copilot] Gemini error", r.status, msg);
  if (r.status === 429) return { status: 429, error: "rate_limited", message: "Gemini rate limit or quota reached: " + msg };
  if (isAuthErr(r.status, msg)) return { status: 401, error: "authentication_error", message: "Google rejected the Gemini API key: " + msg };
  return { status: r.status || 502, error: "upstream_error", message: "Gemini error: " + msg };
}
// Diagnostic used by /api/health?probe=1 — one tiny request, reports the outcome (never the key).
async function probe(key) {
  const out = await geminiRound(key, "Reply with the single word OK.", [{ role: "user", content: "Say OK" }], []);
  return out.error ? { ok: false, error: out.error, message: out.message } : { ok: true, model: out.model, auth: WORKING && WORKING.mode, reply: (out.content || []).map(b => b.text || "").join("").slice(0, 40) };
}
module.exports = { geminiRound, toGemini, fromGemini, probe };
