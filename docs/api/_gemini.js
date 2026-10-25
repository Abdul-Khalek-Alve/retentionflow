// Gemini adapter for the co-pilot. The page speaks the Anthropic Messages shape (text / tool_use /
// tool_result blocks); this module translates one round to Gemini generateContent (function calling)
// and back, so the browser-side agent loop and its tools stay unchanged.
// Env: GEMINI_API_KEY (required), GEMINI_MODEL (optional), GEMINI_BASE_URL (optional, for testing).
const BASE = () => (process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com") + "/v1beta/models/";
const MODELS = () => [process.env.GEMINI_MODEL, "gemini-flash-latest", "gemini-3.6-flash", "gemini-2.5-flash"].filter(Boolean);

function toGemini(system, messages, tools) {
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
  const body = { contents, systemInstruction: { parts: [{ text: system }] }, generationConfig: { maxOutputTokens: 1200, temperature: 0.3 } };
  if (tools && tools.length) body.tools = [{ functionDeclarations: tools.map(t => ({ name: t.name, description: t.description, parametersJsonSchema: t.input_schema })) }];
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
async function geminiRound(key, system, messages, tools) {
  const body = JSON.stringify(toGemini(system, messages, tools));
  let last = { status: 502, error: "upstream_error", message: "Could not reach the Gemini API." };
  const models = WORKING ? [WORKING.model, ...MODELS().filter(m => m !== WORKING.model)] : MODELS();
  for (const model of models) {
    // Try the documented header first; some newer "AQ." keys are only accepted as a ?key= parameter.
    const modes = WORKING && WORKING.model === model ? [WORKING.mode, WORKING.mode === "header" ? "query" : "header"] : ["header", "query"];
    for (const mode of modes) {
      const url = BASE() + encodeURIComponent(model) + ":generateContent" + (mode === "query" ? "?key=" + encodeURIComponent(key) : "");
      const headers = { "Content-Type": "application/json", ...(mode === "header" ? { "x-goog-api-key": key } : {}) };
      let r, j;
      try { r = await fetch(url, { method: "POST", headers, body }); j = await r.json().catch(() => ({})); }
      catch (e) { last = { status: 502, error: "upstream_error", message: "Could not reach the Gemini API." }; break; }
      if (r.ok) { WORKING = { model, mode }; return fromGemini(j, model); }
      const msg = (j.error && j.error.message) || `Gemini HTTP ${r.status}`;
      if (r.status === 404) { last = { status: 404, error: "model_not_found", message: msg }; break; }          // try the next model
      if ((r.status === 401 || r.status === 403) && mode === modes[0]) { last = { status: r.status, error: "authentication_error", message: msg }; continue; }
      if (r.status === 429) return { status: 429, error: "rate_limited", message: "Gemini rate limit reached. Wait a moment and try again." };
      if (r.status === 401 || r.status === 403) return { status: r.status, error: "authentication_error", message: "The Gemini API key was rejected: " + msg };
      return { status: r.status, error: "upstream_error", message: msg };
    }
    if (last.error === "authentication_error") return { ...last, message: "The Gemini API key was rejected: " + last.message };
  }
  return last;
}
module.exports = { geminiRound, toGemini, fromGemini };
