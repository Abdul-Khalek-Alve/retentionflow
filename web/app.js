"use strict";
const W = JSON.parse(document.getElementById("model-data").textContent);
const COLS = W.cohort.columns;
const ROWS = W.cohort.rows.map(r => Object.fromEntries(COLS.map((c, i) => [c, r[i]])));
const BY_ID = Object.fromEntries(ROWS.map(r => [r.id, r]));
const DISCLAIMER = "AI predictions are probabilistic and reflect patterns in historical data. This score is decision support only and must never be used to automatically suspend, terminate or deny academic services. The advisor's judgement is the decision of record.";
const CAVEAT = "Simulated scenario. The model learned associations, not causes: a lower simulated risk shows how similar historical students fared, not a guaranteed effect of the intervention.";

const LABELS = {
  "Application mode": "Application route", "Course": "Course", "Previous qualification": "Prior qualification type",
  "Mother's qualification": "Mother's qualification", "Father's qualification": "Father's qualification",
  "Mother's occupation": "Mother's occupation", "Father's occupation": "Father's occupation",
  "Application order": "Course preference rank", "Previous qualification (grade)": "Prior qualification grade",
  "Admission grade": "Admission grade", "Age at enrollment": "Age at enrolment", "Unemployment rate": "National unemployment rate",
  "Inflation rate": "National inflation rate", "GDP": "GDP growth", "Daytime/evening attendance": "Daytime attendance",
  "Displaced": "Studying away from home", "Educational special needs": "Educational special needs", "Debtor": "Owes money to the university",
  "Tuition fees up to date": "Tuition fees up to date", "Scholarship holder": "Scholarship holder",
  "Curricular units 1st sem (credited)": "Sem 1 units credited", "Curricular units 1st sem (enrolled)": "Sem 1 units enrolled",
  "Curricular units 1st sem (evaluations)": "Sem 1 assessments attempted", "Curricular units 1st sem (approved)": "Sem 1 units passed",
  "Curricular units 1st sem (grade)": "Sem 1 average grade", "Curricular units 1st sem (without evaluations)": "Sem 1 units not assessed",
  "Curricular units 2nd sem (credited)": "Sem 2 units credited", "Curricular units 2nd sem (enrolled)": "Sem 2 units enrolled",
  "Curricular units 2nd sem (evaluations)": "Sem 2 assessments attempted", "Curricular units 2nd sem (approved)": "Sem 2 units passed",
  "Curricular units 2nd sem (grade)": "Sem 2 average grade", "Nacionality": "Nationality", "Marital status": "Marital status", "International": "International student", "Gender": "Gender", "Curricular units 2nd sem (without evaluations)": "Sem 2 units not assessed",
};
const BINARY = ["Daytime/evening attendance", "Displaced", "Educational special needs", "Debtor", "Tuition fees up to date", "Scholarship holder"];
const lab = f => LABELS[f] || f;
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pct = (p, d = 0) => (p * 100).toFixed(d) + "%";
const fmt3 = v => (v == null ? "–" : v.toFixed(3));
const course = code => W.course_names[String(code)] || `Course ${code}`;
const fval = (f, v) => {
  if (f === "Course") return course(v);
  if (BINARY.includes(f)) return v ? "Yes" : "No";
  if (/grade\)$/.test(f) && f.startsWith("Curricular")) return `${(+v).toFixed(1)} /20`;
  if (f === "Admission grade" || f === "Previous qualification (grade)") return `${(+v).toFixed(1)} /200`;
  if (["Application mode", "Previous qualification", "Mother's qualification", "Father's qualification", "Mother's occupation", "Father's occupation"].includes(f)) return `code ${v}`;
  if (["Unemployment rate", "Inflation rate", "GDP"].includes(f)) return (+v).toFixed(1) + (f === "GDP" ? "" : "%");
  return String(Number.isInteger(+v) ? v : (+v).toFixed(2));
};
const bandHTML = b => `<span class="band ${b}">${b}</span>`;

/* ---------------- state ---------------- */
const S = { cp: "sem1", view: "triage", student: "S1529", q: "", band: "", course: "", uncertainOnly: false, reveal: false,
  sort: "risk", dir: -1, page: 0, changes: {}, scenarios: [], modelTab: "performance", driftScenario: "none", csv: null,
  reviews: [], dbState: "loading", uid: null, profiles: {} };
try { const saved = JSON.parse(localStorage.getItem("rf-prefs") || "{}"); if (saved.cp === "sem1" || saved.cp === "sem2") S.cp = saved.cp; } catch (e) {}
const savePrefs = () => { try { localStorage.setItem("rf-prefs", JSON.stringify({ cp: S.cp })); } catch (e) {} };

/* score every held-out student at both decision points, in the browser */
const SCORES = {};
const t0 = performance.now();
for (const cp in W.checkpoints) SCORES[cp] = Object.fromEntries(ROWS.map(r => [r.id, RF.score(W.checkpoints[cp], r)]));
const SCORE_MS = performance.now() - t0;
const CP = () => W.checkpoints[S.cp];
const sc = id => SCORES[S.cp][id];

/* ---------------- small SVG helpers ---------------- */
const axisText = (x, y, s, anchor = "start", cls = "") => `<text x="${x}" y="${y}" text-anchor="${anchor}" font-size="11" fill="var(--muted)" class="${cls}">${esc(s)}</text>`;
function intervalScale(r, kind = "ai", idp = "") {
  const t = CP().threshold, P = v => (v * 100).toFixed(2) + "%";
  return `<div class="iscale ${kind}" role="img" aria-label="Risk ${pct(r.risk)}, 90% range ${pct(r.lo)} to ${pct(r.hi)}, review threshold ${pct(t)}">
    <div class="itrack"><span class="iseg" style="left:0;width:40%;background:var(--low-soft)"></span><span class="iseg" style="left:40%;width:30%;background:var(--med-soft)"></span><span class="iseg" style="left:70%;width:30%;background:var(--high-soft)"></span>
      <span class="irange" ${idp ? `id="${idp}-rng"` : ""} style="left:${P(r.lo)};width:max(4px, ${P(r.hi - r.lo)})"></span><span class="ithr" style="left:${P(t)}"></span><span class="idot" ${idp ? `id="${idp}-dot"` : ""} style="left:${P(r.risk)}"></span></div>
    <div class="iticks"><span style="left:0">0%</span><span style="left:40%">40%</span><span style="left:70%">70%</span><span style="left:100%">100%</span></div>
    <p class="small muted">90% range <span class="mono" ${idp ? `id="${idp}-rtxt"` : ""}>${pct(r.lo)}–${pct(r.hi)}</span> · dashed line = review threshold <span class="mono">${pct(t)}</span></p></div>`;
}
function contribChart(contribs, row, n = 8) {
  const sorted = Object.entries(contribs).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  const top = sorted.slice(0, n), rest = sorted.slice(n).reduce((s, [, v]) => s + v, 0);
  const items = [...top.map(([f, v]) => ({ name: lab(f), val: fval(f, row[f]), v })), { name: `${sorted.length - n} other features combined`, val: "", v: rest, other: true }];
  const max = Math.max(...items.map(i => Math.abs(i.v)), 0.1);
  return `<div class="contrib" role="list" aria-label="Contribution of each feature to the predicted risk">${items.map(it => {
    const w = (Math.abs(it.v) / max * 100).toFixed(1) + "%", cls = it.other ? "oth" : it.v >= 0 ? "up" : "down";
    return `<div class="crow" role="listitem"><span class="cl">${esc(it.name)}${it.val !== "" ? ` <span class="cvv">= ${esc(it.val)}</span>` : ""}</span>
      <span class="cbar"><span class="half neg">${it.v < 0 ? `<i class="${cls}" style="width:${w}"></i>` : ""}</span><span class="half pos">${it.v >= 0 ? `<i class="${cls}" style="width:${w}"></i>` : ""}</span></span>
      <span class="cv mono">${it.v >= 0 ? "+" : "−"}${Math.abs(it.v).toFixed(2)}</span></div>`; }).join("")}
    <div class="crow cax"><span class="cl"></span><span class="cbar"><span class="half neg" style="text-align:right">← lowers risk</span><span class="half pos">raises risk →</span></span><span class="cv"></span></div></div>`;
}
function summarySentence(contribs, row) {
  const s = Object.entries(contribs).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  const up = s.filter(([, v]) => v > 0.15).slice(0, 3), down = s.filter(([, v]) => v < -0.15).slice(0, 2);
  const say = ([f]) => `${lab(f).toLowerCase()} (${fval(f, row[f])})`;
  let t = up.length ? `Main risk drivers: ${up.map(say).join(", ")}.` : "No single factor strongly raises this student's risk.";
  if (down.length) t += ` Main protective factors: ${down.map(say).join(", ")}.`;
  return t;
}

/* ---------------- views ---------------- */
const app = document.getElementById("app");
document.getElementById("disclaimer").textContent = DISCLAIMER;

function filteredRows() {
  const q = S.q.trim().toLowerCase();
  let rs = ROWS.filter(r => {
    const s = sc(r.id);
    if (S.band && s.band !== S.band) return false;
    if (S.course && String(r.Course) !== S.course) return false;
    if (S.uncertainOnly && !s.uncertain) return false;
    if (q && !(r.id.toLowerCase().includes(q) || course(r.Course).toLowerCase().includes(q))) return false;
    return true;
  });
  const key = { risk: r => sc(r.id).risk, id: r => r.id, course: r => course(r.Course), passed: r => r["Curricular units 1st sem (approved)"] }[S.sort];
  rs.sort((a, b) => { const A = key(a), B = key(b); return (A < B ? -1 : A > B ? 1 : 0) * S.dir; });
  return rs;
}
function treemap(items, x, y, w, h) {       // squarified treemap
  const total = items.reduce((s, i) => s + i.value, 0), out = [];
  let rest = items.slice().sort((a, b) => b.value - a.value), rx = x, ry = y, rw = w, rh = h;
  const worst = (row, len, area) => { const s = row.reduce((a, b) => a + b.value, 0) * area; const mx = Math.max(...row.map(r => r.value)) * area, mn = Math.min(...row.map(r => r.value)) * area; return Math.max(len * len * mx / (s * s), s * s / (len * len * mn)); };
  while (rest.length) {
    const area = (rw * rh) / rest.reduce((s, i) => s + i.value, 0), len = Math.min(rw, rh);
    let row = [rest[0]], i = 1;
    while (i < rest.length && worst([...row, rest[i]], len, area) <= worst(row, len, area)) { row.push(rest[i]); i++; }
    const rowArea = row.reduce((s, r) => s + r.value, 0) * area, thick = rowArea / len;
    let off = 0;
    for (const r of row) {
      const sz = r.value * area / thick;
      out.push(rw >= rh ? { ...r, x: rx, y: ry + off, w: thick, h: sz } : { ...r, x: rx + off, y: ry, w: sz, h: thick });
      off += sz;
    }
    if (rw >= rh) { rx += thick; rw -= thick; } else { ry += thick; rh -= thick; }
    rest = rest.slice(i);
  }
  return out;
}
const riskColor = m => m < 0.25 ? "var(--low)" : m < 0.4 ? "var(--med)" : "var(--high)";

function viewTriage() {
  const all = ROWS.map(r => sc(r.id)), t = CP().threshold;
  const n = all.length, flagged = all.filter(s => s.flagged).length, unc = all.filter(s => s.uncertain).length;
  const bands = { High: 0, Medium: 0, Low: 0 }; all.forEach(s => bands[s.band]++);
  // treemap data
  const byC = {}; ROWS.forEach(r => { const k = String(r.Course); (byC[k] ||= { key: k, n: 0, sum: 0, high: 0 }); byC[k].n++; byC[k].sum += sc(r.id).risk; if (sc(r.id).band === "High") byC[k].high++; });
  const tiles = treemap(Object.values(byC).map(c => ({ ...c, value: c.n, mean: c.sum / c.n })), 0, 0, 520, 300);
  let tm = `<svg class="chart" viewBox="0 0 520 300" role="img" aria-label="Courses sized by students, coloured by mean predicted risk">`;
  for (const tl of tiles) {
    const sel = S.course === tl.key;
    tm += `<g class="tile" data-course="${tl.key}" style="cursor:pointer" tabindex="0" role="button" aria-label="${esc(course(+tl.key))}: ${tl.n} students, mean risk ${pct(tl.mean)}">
      <rect x="${tl.x + 1}" y="${tl.y + 1}" width="${Math.max(tl.w - 2, 0)}" height="${Math.max(tl.h - 2, 0)}" rx="4" fill="${riskColor(tl.mean)}" fill-opacity="${0.18 + tl.mean * 0.9}" stroke="${sel ? "var(--ink)" : "var(--surface)"}" stroke-width="${sel ? 2.5 : 1}"/>`;
    if (tl.w > 70 && tl.h > 34) {
      const nm = course(+tl.key), maxc = Math.floor((tl.w - 12) / 6.4);
      tm += `<text x="${tl.x + 7}" y="${tl.y + 17}" font-size="11.5" font-weight="600" fill="var(--ink)">${esc(nm.length > maxc ? nm.slice(0, maxc - 1) + "…" : nm)}</text>
             <text x="${tl.x + 7}" y="${tl.y + 31}" font-size="10.5" class="mono" fill="var(--ink)">${tl.n} · ${pct(tl.mean)}</text>`;
    }
    tm += `</g>`;
  }
  tm += `</svg>`;
  // histogram
  const bins = new Array(20).fill(0); all.forEach(s => bins[Math.min(19, Math.floor(s.risk * 20))]++);
  const bmax = Math.max(...bins), HX = v => 34 + v * 470, HY = c => 170 - c / bmax * 150;
  let hg = `<svg class="chart" viewBox="0 0 520 196" role="img" aria-label="Distribution of predicted risk across the cohort">`;
  [0, Math.round(bmax / 2), bmax].forEach(v => { hg += `<line x1="34" x2="504" y1="${HY(v)}" y2="${HY(v)}" stroke="var(--line)" stroke-width="1"/>` + axisText(28, HY(v) + 4, v, "end", "mono"); });
  bins.forEach((c, i) => { const b = (i + .5) / 20; hg += `<rect class="gy" x="${HX(i / 20) + 1}" y="${HY(c)}" width="${470 / 20 - 2}" height="${170 - HY(c)}" fill="${b < .4 ? "var(--low)" : b < .7 ? "var(--med)" : "var(--high)"}" fill-opacity=".75" rx="2"/>`; });
  hg += `<line x1="${HX(t)}" x2="${HX(t)}" y1="12" y2="172" stroke="var(--ink)" stroke-dasharray="4 3"/>` + axisText(HX(t) + 4, 22, `threshold ${pct(t)}`);
  [0, .25, .5, .75, 1].forEach(v => hg += axisText(HX(v), 188, pct(v), v === 0 ? "start" : v === 1 ? "end" : "middle", "mono"));
  hg += `</svg>`;
  // table
  const rs = filteredRows(), per = 25, pages = Math.max(1, Math.ceil(rs.length / per)); S.page = Math.min(S.page, pages - 1);
  const slice = rs.slice(S.page * per, S.page * per + per);
  const courseOpts = Object.keys(byC).sort((a, b) => course(+a).localeCompare(course(+b))).map(k => `<option value="${k}" ${S.course === k ? "selected" : ""}>${esc(course(+k))}</option>`).join("");
  const sortBtn = (k, label, cls = "") => `<th class="${cls}"><button data-sort="${k}" aria-label="Sort by ${label}">${label}${S.sort === k ? (S.dir < 0 ? " ↓" : " ↑") : ""}</button></th>`;
  const passedCol = S.cp === "sem2" ? "Curricular units 2nd sem (approved)" : "Curricular units 1st sem (approved)";
  return `
  <section class="stack">
    <div class="headrow"><div><h2>Cohort triage</h2><p class="muted">${n} held-out students ranked by AI-estimated dropout risk at the ${esc(CP().label.toLowerCase())}. Review, don't automate.</p></div><span class="prov ai">AI prediction</span></div>
    <div class="kpis">
      <div class="kpi"><div class="v" data-count="${n}">${n}</div><div class="l">Students in cohort</div></div>
      <div class="kpi"><div class="v" data-count="${flagged}">${flagged}</div><div class="l">Flagged for review (≥ ${pct(t)})</div></div>
      <div class="kpi"><div class="v" style="color:var(--high)" data-count="${bands.High}">${bands.High}</div><div class="l">High risk (&gt; 70%)</div></div>
      <div class="kpi"><div class="v" style="color:var(--med)" data-count="${bands.Medium}">${bands.Medium}</div><div class="l">Medium risk (40–70%)</div></div>
      <div class="kpi"><div class="v" style="color:var(--low)" data-count="${bands.Low}">${bands.Low}</div><div class="l">Low risk (&lt; 40%)</div></div>
      <div class="kpi"><div class="v" data-count="${unc}">${unc}</div><div class="l">Uncertain predictions</div></div>
    </div>
  </section>
  <section class="panel stack">
    <div class="headrow"><div><h3>Contact first today</h3><p class="small muted">Flagged students where the model sees the most room for support to help: risk × the largest drop one support lever could make.</p></div><button class="btn" data-ask="Who should I contact first today, and why? Use the tools to check the top candidates.">Ask the co-pilot why</button></div>
    <div class="prio">${priorities().slice(0, 5).map(p => `<button data-openid="${p.id}" aria-label="Open ${p.id}"><span class="row" style="justify-content:space-between"><span class="mono" style="font-weight:600">${p.id}</span>${bandHTML(p.band)}</span>${caseChip(p.id) ? `<span style="display:block;margin-top:4px">${caseChip(p.id)}</span>` : ""}
      <span class="mono" style="font-size:1.35rem;font-weight:600">${pct(p.risk)}</span><span class="why">${esc(course(BY_ID[p.id].Course))}</span>
      <span class="why"><strong style="color:var(--ink)">${esc(p.lever)}</strong> could lower risk by <span class="mono" style="color:var(--low)">${(p.drop * 100).toFixed(0)} pts</span></span></button>`).join("")}</div>
  </section>
  <section class="grid2">
    <div class="panel"><div class="headrow"><h3>Risk by course</h3>${S.course ? `<button class="btn" id="clear-course">Show all courses</button>` : ""}</div>
      <p class="small muted" style="margin-top:4px">Area = students in the cohort · colour = mean predicted risk. Select a course to filter the list.</p><div class="legend" style="margin-top:6px"><span><i style="background:var(--low)"></i>mean &lt; 25%</span><span><i style="background:var(--med)"></i>25–40%</span><span><i style="background:var(--high)"></i>&gt; 40%</span></div>
      <div style="margin-top:10px">${tm}</div></div>
    <div class="panel"><h3>How risk is spread</h3><p class="small muted" style="margin-top:4px">Students per 5-point risk bucket. Students right of the dashed line are flagged for an advisor to review.</p><div style="margin-top:10px">${hg}</div>
      <div class="legend" style="margin-top:6px"><span><i style="background:var(--low)"></i>Low</span><span><i style="background:var(--med)"></i>Medium</span><span><i style="background:var(--high)"></i>High</span></div></div>
  </section>
  <section class="panel">
    <div class="headrow"><h3>Students</h3><span class="small muted">${rs.length} shown</span></div>
    <div class="row" style="margin:12px 0">
      <input type="search" id="f-q" placeholder="Search student ID or course" value="${esc(S.q)}" aria-label="Search students" style="flex:1 1 200px">
      <select id="f-band" aria-label="Filter by risk band"><option value="">All bands</option>${["High", "Medium", "Low"].map(b => `<option ${S.band === b ? "selected" : ""}>${b}</option>`).join("")}</select>
      <select id="f-course" aria-label="Filter by course"><option value="">All courses</option>${courseOpts}</select>
      <label class="toggle"><input type="checkbox" id="f-unc" ${S.uncertainOnly ? "checked" : ""}> Uncertain only</label>
      <label class="toggle" title="Shows the real outcome of these held-out students. For evaluation and demonstration only."><input type="checkbox" id="f-reveal" ${S.reveal ? "checked" : ""}> Show actual outcome (evaluation mode)</label>
    </div>
    <div class="tablebox"><table>
      <thead><tr>${sortBtn("id", "Student")}${sortBtn("course", "Course")}${sortBtn("risk", "AI risk · 90% range")}<th>Band</th><th>Flags</th>${sortBtn("passed", S.cp === "sem2" ? "Sem 2 passed" : "Sem 1 passed", "r")}<th>Fees paid</th>${S.reveal ? "<th>Actual outcome</th>" : ""}</tr></thead>
      <tbody>${slice.map(r => { const s = sc(r.id); return `<tr class="click" data-id="${r.id}" tabindex="0">
        <td class="mono">${r.id}</td><td>${esc(course(r.Course))}</td>
        <td><div class="riskcell"><span class="mono" style="width:3.2em">${pct(s.risk)}</span><span class="mini"><span class="rng" style="left:${s.lo * 100}%;width:${Math.max((s.hi - s.lo) * 100, 1)}%"></span><span class="pt" style="left:calc(${s.risk * 100}% - 1.5px)"></span></span></div></td>
        <td>${bandHTML(s.band)}</td><td>${s.uncertain ? `<span class="chip unc">Uncertain</span>` : ""} ${s.flagged ? `<span class="chip">Flagged</span>` : ""} ${caseChip(r.id)}</td>
        <td class="r mono">${r[passedCol]}</td><td>${r["Tuition fees up to date"] ? "Yes" : "No"}</td>${S.reveal ? `<td>${esc(r.Target)}</td>` : ""}</tr>`; }).join("") || `<tr><td colspan="8" class="muted">No students match these filters.</td></tr>`}</tbody>
    </table></div>
    <div class="pager"><span class="small muted">Page ${S.page + 1} of ${pages}</span><div class="row"><button class="btn" id="pg-prev" ${S.page === 0 ? "disabled" : ""}>Previous</button><button class="btn" id="pg-next" ${S.page >= pages - 1 ? "disabled" : ""}>Next</button></div></div>
  </section>`;
}

function studentPicker() {
  return `<div class="field"><label for="pick">Student</label><input type="text" id="pick" list="pick-list" value="${S.student}" style="width:9em" class="mono" aria-describedby="pick-hint">
    <datalist id="pick-list">${ROWS.map(r => `<option value="${r.id}">`).join("")}</datalist><span id="pick-hint" class="small muted">Type an ID such as S1529</span></div>`;
}
function obsPanel(row) {
  const feats = CP().features;
  const groups = [
    ["Academic", feats.filter(f => f.startsWith("Curricular"))],
    ["Financial", ["Debtor", "Tuition fees up to date", "Scholarship holder"]],
    ["Enrolment", ["Course", "Age at enrollment", "Admission grade", "Previous qualification (grade)", "Application order", "Daytime/evening attendance", "Displaced", "Educational special needs"]],
  ];
  return `<div class="panel"><div class="headrow"><h3>Observed record</h3><span class="prov obs">Observed</span></div>
    <p class="small muted" style="margin-top:4px">Facts from the student record, as held at the ${esc(CP().label.toLowerCase())}.</p>
    <div style="margin-top:12px">${groups.map(([g, fs]) => `<div class="obsgroup"><div class="eyebrow" style="margin-bottom:6px">${g}</div><dl class="obsgrid">${fs.map(f => `<dt>${esc(lab(f))}</dt><dd>${esc(fval(f, row[f]))}</dd>`).join("")}</dl></div>`).join("")}</div></div>`;
}
function viewStudent() {
  const row = BY_ID[S.student];
  if (!row) return `<section class="panel">${studentPicker()}<p style="margin-top:10px">No held-out student has the ID “${esc(S.student)}”. IDs run from S0000 to S4423; only the 885 test students are in this cohort.</p></section>`;
  const s = sc(row.id), contribs = RF.shap(CP().model, row);
  return `
  <section class="headrow"><div><h2>Student ${row.id}</h2><p class="muted">${esc(course(row.Course))} · age ${row["Age at enrollment"]} · ${esc(CP().label)}</p></div>${studentPicker()}</section>
  <section class="grid-side">
    ${obsPanel(row)}
    <div class="stack">
      <div class="panel ai stack">
        <div class="headrow"><h3>AI risk estimate</h3><span class="prov ai">AI prediction</span></div>
        <p class="notice small">${esc(DISCLAIMER)}</p>
        <div class="bigrisk"><span class="pct" data-countpct="${s.risk}">${pct(s.risk)}</span>${bandHTML(s.band)}<span class="muted small">estimated probability of dropping out${s.flagged ? " · <strong>flagged for review</strong>" : ""}</span></div>
        ${intervalScale(s)}
        <div class="traj" aria-label="Risk at each decision point"><span class="lbl">Trajectory</span>${["sem1", "sem2"].map(k => { const x = SCORES[k][row.id]; return `<span class="step ${k === S.cp ? "on" : ""}">${k === "sem1" ? "End of Sem 1" : "End of Sem 2"} <strong class="mono">${pct(x.risk)}</strong> ${bandHTML(x.band)}</span>`; }).join('<span class="muted" aria-hidden="true">→</span>')}</div>
        ${s.uncertain ? `<p class="notice warn small"><strong>The model is not confident about this student.</strong> The 90% uncertainty range crosses the review threshold. Rely more on your own judgement and gather more information before acting.</p>` : `<p class="small muted">The 90% range comes from 30 re-trained versions of the model. A narrow range means they agree.</p>`}
        <div><h3 style="font-size:1rem">Why the model estimated this risk</h3>
          <p class="small muted" style="margin-top:2px">${esc(summarySentence(contribs, row))}</p>
          <div style="margin-top:8px">${contribChart(contribs, row)}</div>
          <p class="small muted">SHAP contributions in log-odds (Lundberg &amp; Lee, 2017). They show association in historical data, not cause.</p></div>
        <div class="row"><a class="btn simbtn" href="#whatif" id="go-whatif">Simulate support options</a><button class="btn" data-ask="Brief me on ${row.id}: what is driving the risk, how confident is the model, and what support should I consider? Check the main support options with the simulator.">Brief me with the co-pilot</button></div>
      </div>
      ${reviewCard(row, s)}
    </div>
  </section>`;
}

/* ---------------- What-If ---------------- */
function whatIfState() {
  const row = BY_ID[S.student], feats = CP().features;
  const scen = { ...row }; for (const k in S.changes) if (feats.includes(k)) scen[k] = S.changes[k];
  const changed = Object.keys(S.changes).filter(k => feats.includes(k) && S.changes[k] !== row[k]);
  const cur = sc(row.id), sim = RF.score(CP(), scen);
  return { row, scen, changed, cur, sim, d: sim.risk - cur.risk };
}
function deltaText(st) {
  return st.changed.length ? `${st.d < 0 ? "▼" : "▲"} ${(Math.abs(st.d) * 100).toFixed(1)} points · ${st.cur.band} → ${st.sim.band}` : "Change a lever to run a scenario";
}
const deltaColor = st => st.d < -0.005 ? "var(--low)" : st.d > 0.005 ? "var(--high)" : "var(--muted)";
function viewWhatIf() {
  const row = BY_ID[S.student];
  if (!row) return `<section class="panel">${studentPicker()}<p style="margin-top:10px">Choose a held-out student first.</p></section>`;
  const feats = CP().features, levers = Object.entries(W.levers).filter(([f]) => feats.includes(f));
  const st = whatIfState();
  const leverHTML = levers.map(([f, L]) => {
    const v = f in S.changes ? S.changes[f] : row[f], ch = st.changed.includes(f), id = "lv-" + f.replace(/[^a-z0-9]/gi, "");
    if (L.type === "binary") return `<div class="lever ${ch ? "changed" : ""}" data-lrow="${esc(f)}"><label for="${id}">${esc(L.label)}<br><span class="small muted">Observed: ${row[f] ? "Yes" : "No"}</span></label>
      <span class="switch"><input type="checkbox" role="switch" id="${id}" data-lever="${esc(f)}" ${v ? "checked" : ""}><span></span></span></div>`;
    const step = L.type === "float" ? 0.5 : 1;
    return `<div class="lever ${ch ? "changed" : ""}" data-lrow="${esc(f)}"><label for="${id}">${esc(L.label)}<br><span class="small muted">Observed: ${esc(fval(f, row[f]))}</span></label><span class="mono" data-lval="${esc(f)}">${esc(fval(f, v))}</span>
      <input type="range" id="${id}" data-lever="${esc(f)}" min="${L.min}" max="${L.max}" step="${step}" value="${v}"></div>`;
  }).join("");
  const card = (title, r, kind, idp) => `<div class="panel ${kind === "sim" ? "sim" : "ai"} stack"><div class="headrow"><h3>${title}</h3><span class="prov ${kind}">${kind === "sim" ? "Simulated" : "AI prediction"}</span></div>
    <div class="bigrisk"><span class="pct" style="font-size:2.1rem" ${idp ? `id="${idp}-pct"` : ""}>${pct(r.risk)}</span><span ${idp ? `id="${idp}-band"` : ""}>${bandHTML(r.band)}${r.uncertain ? ` <span class="chip unc">Uncertain</span>` : ""}</span></div>
    ${intervalScale(r, kind, idp)}</div>`;
  return `
  <section class="headrow"><div><h2>What-If simulator</h2><p class="muted">Student ${row.id} · ${esc(course(row.Course))}. Change support levers and watch the model's estimate respond.</p></div>${studentPicker()}</section>
  <section class="grid-side">
    <div class="panel stack"><div class="headrow"><h3>Support levers</h3><button class="btn" id="wi-reset" ${st.changed.length ? "" : "disabled"}>Reset</button></div>
      <p class="small muted">Only levers an advisor or the university can influence. Sensitive attributes are never adjustable.</p>
      <div class="levers">${leverHTML}</div>
      <button class="btn" data-ask="For ${row.id}, test each support lever with the simulator and tell me which single change and which combination lower the risk most. Keep it short.">Ask the co-pilot to find the best lever</button></div>
    <div class="stack">
      ${card("Current estimate", st.cur, "ai", "")}
      <div class="panel" style="text-align:center"><span class="delta" id="wi-delta" style="color:${deltaColor(st)}">${deltaText(st)}</span></div>
      ${card("Simulated scenario", st.sim, "sim", "sim")}
      <p class="notice sim small">${esc(CAVEAT)}</p>
      <div class="panel sim" id="wi-why" ${st.changed.length ? "" : "hidden"}><h3>Why the simulated estimate changed</h3><div style="margin-top:8px" id="wi-contrib">${contribChart(RF.shap(CP().model, st.scen), st.scen)}</div>
        <div class="row" style="margin-top:8px"><button class="btn simbtn" id="wi-save" ${S.scenarios.length >= 3 ? "disabled" : ""}>Save scenario for comparison</button><span class="small muted">${S.scenarios.length}/3 saved</span></div></div>
      ${S.scenarios.length ? `<div class="panel"><h3>Saved scenarios</h3><div class="tablebox" style="margin-top:10px"><table><thead><tr><th>Student</th><th>Changes</th><th class="r">Simulated risk</th><th>Band</th><th></th></tr></thead><tbody>
        ${S.scenarios.map((x, i) => `<tr><td class="mono">${x.id}</td><td style="white-space:normal">${esc(x.desc)}</td><td class="r mono">${pct(x.risk)} <span class="muted">(${x.d < 0 ? "−" : "+"}${(Math.abs(x.d) * 100).toFixed(1)})</span></td><td>${bandHTML(x.band)}</td><td><button class="btn" data-del="${i}" aria-label="Remove scenario">Remove</button></td></tr>`).join("")}
      </tbody></table></div></div>` : ""}
    </div>
  </section>`;
}
/* update the What-If view in place so the risk marker and range glide to their new positions */
function patchWhatIf() {
  if (S.view !== "whatif" || !BY_ID[S.student]) return;
  const st = whatIfState(), P = v => (v * 100).toFixed(2) + "%", $ = id => document.getElementById(id);
  if (!$("sim-pct")) return render(true);
  $("sim-pct").textContent = pct(st.sim.risk);
  $("sim-band").innerHTML = bandHTML(st.sim.band) + (st.sim.uncertain ? ` <span class="chip unc">Uncertain</span>` : "");
  $("sim-rng").style.left = P(st.sim.lo); $("sim-rng").style.width = `max(4px, ${P(st.sim.hi - st.sim.lo)})`;
  $("sim-dot").style.left = P(st.sim.risk); $("sim-rtxt").textContent = `${pct(st.sim.lo)}–${pct(st.sim.hi)}`;
  $("wi-delta").textContent = deltaText(st); $("wi-delta").style.color = deltaColor(st);
  $("wi-why").hidden = !st.changed.length; if (st.changed.length) $("wi-contrib").innerHTML = contribChart(RF.shap(CP().model, st.scen), st.scen);
  $("wi-reset").disabled = !st.changed.length;
  document.querySelectorAll("[data-lrow]").forEach(el => el.classList.toggle("changed", st.changed.includes(el.dataset.lrow)));
  document.querySelectorAll("[data-lval]").forEach(el => { const f = el.dataset.lval; el.textContent = fval(f, f in S.changes ? S.changes[f] : st.row[f]); });
  document.querySelectorAll("[data-lever]").forEach(el => { const f = el.dataset.lever, v = f in S.changes ? S.changes[f] : st.row[f]; if (el.type === "checkbox") el.checked = !!v; else if (+el.value !== +v) el.value = v; });
}
/* "contact first": risk × the largest drop one actionable lever could make */
const PRIO_CACHE = {};
function bestLever(cp, row) {
  const opts = [["Tuition fees up to date", 1, "Agree a fee plan"], ["Debtor", 0, "Clear the debt"], ["Scholarship holder", 1, "Offer a scholarship or grant"]];
  let best = { drop: 0, lever: "Academic support" }; const base = RF.prob(cp.model, row);
  for (const [f, v, name] of opts) { if (row[f] === v) continue; const p = RF.prob(cp.model, { ...row, [f]: v }); if (base - p > best.drop) best = { drop: base - p, lever: name }; }
  return best;
}
function priorities() {
  if (PRIO_CACHE[S.cp]) return PRIO_CACHE[S.cp];
  const cp = CP();
  const list = ROWS.filter(r => sc(r.id).flagged).map(r => { const s = sc(r.id), b = bestLever(cp, r); return { id: r.id, risk: s.risk, band: s.band, uncertain: s.uncertain, ...b, score: s.risk * b.drop }; });
  return (PRIO_CACHE[S.cp] = list.sort((a, b) => b.score - a.score));
}

/* ---------------- Platform: inside claude.ai (artifact capabilities) or on the web (Vercel /api) ---------------- */
const WEB = !(window.claude && typeof window.claude.use === "function");
const WEBCFG = { copilot: false, store: false, code_required: false, model: "", provider: null };
const ident = { get name() { try { return localStorage.getItem("rf-advisor") || ""; } catch (e) { return ""; } }, set name(v) { try { localStorage.setItem("rf-advisor", v); } catch (e) {} },
  get code() { try { return sessionStorage.getItem("rf-code") || ""; } catch (e) { return ""; } }, set code(v) { try { sessionStorage.setItem("rf-code", v); } catch (e) {} } };
async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { "Content-Type": "application/json", ...(ident.code ? { "x-advisor-code": ident.code } : {}), ...(opts.headers || {}) } });
  let j = {}; try { j = await r.json(); } catch (e) {}
  if (!r.ok) throw { code: j.error || "upstream_error", message: j.message || `HTTP ${r.status}`, status: r.status };
  return j;
}
/* A drop-in for the artifact `sample` capability: runs the tool-use loop against /api/copilot (Anthropic Messages API). */
function webSample(input, opts = {}) {
  return (async () => {
    const system = input[0].content, messages = input.slice(1).map(t => ({ role: t.role, content: t.content }));
    const tools = (opts.tools || []).map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema || { type: "object", properties: {} } }));
    const byName = Object.fromEntries((opts.tools || []).map(t => [t.name, t]));
    let shown = "", full = "";
    const reveal = async add => {                    // typewriter reveal so answers feel live
      const words = add.split(/(\s+)/);
      for (let i = 0; i < words.length; i += 6) { if (opts.signal && opts.signal.aborted) break; shown += words.slice(i, i + 6).join(""); opts.onText && opts.onText({ text: shown, delta: "" }); await new Promise(r => setTimeout(r, 16)); }
    };
    const MAX_ROUNDS = 8, NUDGE = "Now answer the advisor's question in plain English, using only the tool results above. Do not call any more tools.";
    let finalRound = false;
    const post = async (choice) => {
      try { return await api("/api/copilot", { method: "POST", body: JSON.stringify({ system, messages, tools, tool_choice: choice }), signal: opts.signal }); }
      catch (e) { if (opts.signal && opts.signal.aborted) throw { code: "cancelled", text: shown }; throw { ...e, text: shown || undefined }; }
    };
    // Ask for a text-only answer from the evidence gathered so far (used when a round comes back empty or the round limit is reached).
    const answerNow = async () => {
      if (finalRound) return; finalRound = true;
      const last = messages[messages.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content)) last.content = [...last.content, { type: "text", text: NUDGE }];
      else messages.push({ role: "user", content: NUDGE });
      const j = await post("none");
      const text = (j.content || []).filter(b => b.type === "text").map(b => b.text).join("");
      if (text.trim()) { const add = (full ? "\n\n" : "") + text; full += add; await reveal(add); }
    };
    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (opts.signal && opts.signal.aborted) throw { code: "cancelled", text: shown };
      const j = await post("auto");
      const blocks = j.content || [], text = blocks.filter(b => b.type === "text").map(b => b.text).join("");
      if (text.trim()) { const add = (full ? "\n\n" : "") + text; full += add; await reveal(add); }
      const uses = blocks.filter(b => b.type === "tool_use");
      if (j.stop_reason !== "tool_use" || !uses.length) { if (!text.trim() && round > 0) await answerNow(); break; }
      messages.push({ role: "assistant", content: blocks });
      const results = [];
      for (const u of uses) {
        let content, is_error = false;
        try { const out = await byName[u.name].execute(u.input || {}, { signal: opts.signal }); content = typeof out === "string" ? out : JSON.stringify(out); }
        catch (e) { content = "Error: " + (e && e.message ? e.message : String(e)); is_error = true; }
        results.push({ type: "tool_result", tool_use_id: u.id, content: content.slice(0, 30000), ...(is_error ? { is_error: true } : {}) });
      }
      messages.push({ role: "user", content: results });
      if (round === MAX_ROUNDS - 1) await answerNow();   // out of rounds: answer from what the tools returned
    }
    if (!full.trim()) throw { code: "empty_completion" };
    if (shown !== full) { shown = full; opts.onText && opts.onText({ text: full, delta: "" }); }
    return { text: full, truncated: false, modelTierApplied: "quick" };
  })();
}
webSample.limits = async () => ({ maxPromptBytes: 200000, tools: { maxCount: 10 } });
/* ---------------- Advisor records: the shared store when connected, otherwise this browser ----------------
   Three append-only record kinds: reviews (advisor decisions), outcomes (what happened at follow-up) and
   ratings (co-pilot answer quality). Nothing is ever edited or deleted, so the log doubles as an audit trail. */
const LOCAL = {
  get(kind) { try { return JSON.parse(localStorage.getItem("rf-log-" + kind) || "[]"); } catch (e) { return []; } },
  add(kind, item) { const all = LOCAL.get(kind); all.unshift(item); try { localStorage.setItem("rf-log-" + kind, JSON.stringify(all.slice(0, 2000))); } catch (e) { throw { code: "local_unavailable" }; } return item; },
};
S.outcomes = []; S.copilotRatings = []; S.storeMode = "loading";
const asReview = i => ({ ...i, reviewer: i.advisor || i.reviewer || "Advisor", reviewerName: i.advisor || i.reviewerName || "Advisor" });
let webPoll = null;
async function webLoad() {
  if (S.storeMode === "local") { S.reviews = LOCAL.get("reviews").map(asReview); S.outcomes = LOCAL.get("outcomes"); S.copilotRatings = LOCAL.get("ratings"); return; }
  const get = k => api("/api/store?kind=" + k);
  const [rv, rt, oc] = await Promise.all([get("reviews"), get("ratings"), get("outcomes").catch(() => ({ items: [] }))]);
  S.reviews = (rv.items || []).map(asReview); S.copilotRatings = rt.items || []; S.outcomes = oc.items || [];
}
async function initWeb() {
  try { Object.assign(WEBCFG, await api("/api/health")); } catch (e) {}
  S.storeMode = WEBCFG.store ? "shared" : "local";
  try { await webLoad(); } catch (e) { S.storeMode = "local"; await webLoad(); }
  S.dbState = "ready"; S.uid = "web";
  if (S.storeMode === "shared") {
    clearInterval(webPoll);
    webPoll = setInterval(async () => {
      if (document.hidden) return;
      try { const before = [S.reviews, S.outcomes, S.copilotRatings].map(x => x.length).join("/"); await webLoad();
        if (before !== [S.reviews, S.outcomes, S.copilotRatings].map(x => x.length).join("/") && ["student", "feedback", "triage"].includes(S.view)) render(true); } catch (e) {}
    }, 20000);
  }
  render(true);
}
// The single write path for every record kind.
const DB_COLLECTION = { reviews: "reviews", outcomes: "outcomes", ratings: "copilot" };
async function appendRecord(kind, item) {
  if (WEB && S.storeMode === "shared") { const r = await api("/api/store?kind=" + kind, { method: "POST", body: JSON.stringify(item) }); return r.item; }
  if (WEB) return LOCAL.add(kind, { ...item, at: new Date().toISOString() });
  const ref = DB.doc(DB_COLLECTION[kind] + "/" + S.uid), cur = await ref.get();       // artifact database: one document per advisor
  const items = (cur.exists && cur.data().items) ? [...cur.data().items] : [];
  const rec = { ...item, at: new Date().toISOString() }; items.push(rec); await ref.set({ items: items.slice(-400) }); return rec;
}
const storeNote = () => WEB && S.storeMode === "local" ? `<p class="notice warn small"><strong>Saved in this browser only.</strong> No shared store is connected to this deployment, so reviews and outcomes stay on this device. Download them from Advisor feedback, or connect Upstash Redis in Vercel to share them between advisors.</p>` : "";

/* ---------------- Advisor decision workflow ---------------- */
const BANDS = ["Low", "Medium", "High"];
const ASSESS = { agree: "Agree with the AI", lower: "Risk is lower than the AI says", higher: "Risk is higher than the AI says", override: "Set the band myself" };
const ACTIONS = { contact_now: "Contact the student now", check_in: "Book a check-in meeting", financial_counselling: "Refer: financial counselling", academic_support: "Refer: academic support", wellbeing_referral: "Refer: wellbeing service", monitor: "Monitor only", none: "No action needed" };
const PRIORITY = { urgent: "Urgent (48 hours)", week: "This week", month: "This month" };
const TAGS = { personal: "Personal circumstances I know about", finance_changed: "Financial situation has changed", academic_changed: "Academic progress has changed", engagement: "Engagement or attendance concerns", data_issue: "Record looks out of date or wrong", explanation: "The explanation did not make sense", other: "Other" };
const OUTCOMES = { support_accepted: "Contacted: support accepted", support_declined: "Contacted: support declined", not_reached: "Could not reach the student", resolved: "Situation resolved", still_at_risk: "Still at risk", withdrew: "Student withdrew" };
const CLOSES = ["support_accepted", "resolved", "withdrew"];
const RUBRIC = [["clarity", "Clarity", "I understood why the model gave this score"], ["usefulness", "Usefulness", "The explanation helped me decide what to do"], ["trust", "Trust", "I trust this estimate for this student"], ["actionability", "Actionability", "It points to something I can act on"]];
const shiftBand = (b, d) => BANDS[Math.min(2, Math.max(0, BANDS.indexOf(b) + d))];
const assessOf = r => r.decision === "disagree" ? (r.direction === "lower" ? "lower" : r.direction === "higher" ? "higher" : "disagree") : r.decision;
const advisorBand = r => r.decision === "override" ? (r.override_band || r.ai_band) : r.decision === "disagree" ? (r.direction === "lower" ? shiftBand(r.ai_band, -1) : r.direction === "higher" ? shiftBand(r.ai_band, 1) : r.ai_band) : r.ai_band;
const bandMove = r => Math.sign(BANDS.indexOf(advisorBand(r)) - BANDS.indexOf(r.ai_band));      // +1 advisor raised, −1 lowered, 0 same
const today = () => new Date().toISOString().slice(0, 10);
const plusDays = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const newest = (a, b) => String(b.at).localeCompare(String(a.at));
const assessText = r => ({ agree: "Agreed", lower: "Said lower", higher: "Said higher", override: "Set band", disagree: "Disagreed" }[assessOf(r)] || r.decision);
function caseOf(id) {
  const rv = S.reviews.filter(r => r.student_id === id).sort(newest); if (!rv.length) return null;
  const last = rv[0], oc = S.outcomes.filter(o => o.student_id === id && String(o.at) >= String(last.at)).sort(newest);
  const closed = last.planned_action === "none" || oc.some(o => o.closed);
  const overdue = !closed && last.follow_up && last.follow_up < today();
  return { last, reviews: rv, outcomes: oc, closed, overdue, status: closed ? "Closed" : overdue ? "Follow-up overdue" : "Open case" };
}
const caseChip = id => { const c = caseOf(id); return c ? `<span class="chip case ${c.closed ? "closed" : c.overdue ? "late" : "open"}">${c.status}</span>` : ""; };

function timeline(c) {
  if (!c) return `<p class="small muted">No reviews recorded for this student yet.</p>`;
  const ev = [...c.reviews.map(r => ({ t: "review", r })), ...S.outcomes.filter(o => o.student_id === c.last.student_id).map(o => ({ t: "outcome", r: o }))].sort((a, b) => newest(a.r, b.r));
  return ev.map(({ t, r }) => t === "review"
    ? `<div class="hist-item"><span class="mono small">${esc(String(r.at).slice(0, 16).replace("T", " "))}</span> · <strong>${esc(r.reviewerName || r.advisor || "Advisor")}</strong> · ${esc(assessText(r))} (AI ${pct(r.ai_risk)} ${esc(r.ai_band)} → advisor ${esc(advisorBand(r))}) · ${esc(ACTIONS[r.planned_action] || r.planned_action)}${r.follow_up ? ` · follow up ${esc(r.follow_up)}` : ""}${(r.reason_tags || []).length ? `<br><span class="small">${r.reason_tags.map(k => `<span class="chip">${esc(TAGS[k] || k)}</span>`).join(" ")}</span>` : ""}${r.reason ? `<br><span class="muted">${esc(r.reason)}</span>` : ""}</div>`
    : `<div class="hist-item outcome"><span class="mono small">${esc(String(r.at).slice(0, 16).replace("T", " "))}</span> · <strong>${esc(r.advisor || "Advisor")}</strong> · Outcome: ${esc(OUTCOMES[r.outcome] || r.outcome)}${r.closed ? " · case closed" : ""}${r.note ? `<br><span class="muted">${esc(r.note)}</span>` : ""}</div>`).join("");
}
function identityFields(pre) {
  if (!WEB) return "";
  return `<div class="row"><div class="field" style="flex:1 1 180px"><label for="${pre}-name">Your name (shown in the audit log)</label><input type="text" id="${pre}-name" maxlength="60" value="${esc(ident.name)}" autocomplete="name"></div>${WEBCFG.code_required && S.storeMode === "shared" ? `<div class="field" style="flex:1 1 140px"><label for="${pre}-code">Advisor access code</label><input type="password" id="${pre}-code" maxlength="60" value="${esc(ident.code)}" autocomplete="off"></div>` : ""}</div>`;
}
function outcomeCard(row, c) {
  if (!c || c.closed) return "";
  return `<form class="panel stack" id="outcome-form" novalidate>
    <div class="headrow"><h3>Close the loop: record the follow-up</h3>${caseChip(row.id)}</div>
    <p class="small">Planned: <strong>${esc(ACTIONS[c.last.planned_action] || c.last.planned_action)}</strong>${c.last.priority ? ` · ${esc(PRIORITY[c.last.priority] || c.last.priority)}` : ""}${c.last.follow_up ? ` · follow up by <span class="mono">${esc(c.last.follow_up)}</span>` : ""} · decided by ${esc(c.last.reviewerName || "Advisor")}.</p>
    <div class="field"><label for="oc-outcome">What happened?</label><select id="oc-outcome">${Object.entries(OUTCOMES).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></div>
    <div class="field"><label for="oc-note">Note (optional)</label><textarea id="oc-note" maxlength="400" placeholder="For example: agreed a fee plan with student finance on 12 Nov."></textarea></div>
    <label class="small"><input type="checkbox" id="oc-close" checked> Close this case</label>
    ${identityFields("oc")}
    <div class="row"><button class="btn primary" type="submit" id="oc-save">Save outcome</button><span class="small" id="oc-msg" role="status"></span></div>
    <p class="small muted">Outcomes are compared with the AI's original estimate on the Advisor feedback page, which is how the system learns where the model was right or wrong.</p>
  </form>`;
}
function reviewCard(row, s) {
  const c = caseOf(row.id);
  if (S.dbState !== "ready") return `<div class="panel stack"><h3>Advisor decision</h3><p class="small muted">${S.dbState === "loading" ? "Connecting to the review log…" : "Reviews are saved to a shared, signed-in log. Open this page while signed in to record a review."}</p>${timeline(c)}</div>`;
  return `${outcomeCard(row, c)}<form class="panel stack" id="review-form" novalidate>
    <div class="headrow"><h3>${c ? "Update your decision" : "Advisor decision"}</h3>${c ? caseChip(row.id) : `<span class="small muted">You make the final call</span>`}</div>
    ${storeNote()}
    <p class="small">The AI estimates <strong class="mono">${pct(s.risk)}</strong> (90% range ${pct(s.lo)}–${pct(s.hi)}), band <strong>${esc(s.band)}</strong>${s.flagged ? ", flagged for review" : ""}${s.uncertain ? `, and it is <strong>uncertain</strong>` : ""}.</p>
    <div class="field"><span class="lbl" id="as-l">1 · Your assessment</span>
      <div class="radios" role="radiogroup" aria-labelledby="as-l">${Object.entries(ASSESS).map(([v, l]) => `<label><input type="radio" name="assess" value="${v}" id="as-${v}" ${v === "agree" ? "checked" : ""}> ${l}</label>`).join("")}</div></div>
    <div class="row" id="ovr-row" hidden><div class="field"><label for="ovr-band">Your band</label><select id="ovr-band">${BANDS.map(b => `<option ${b === s.band ? "selected" : ""}>${b}</option>`).join("")}</select></div></div>
    <div class="field"><span class="lbl" id="tg-l">2 · Why? <span id="reason-req" hidden>(pick a reason or write one; required when you disagree)</span></span>
      <div class="radios tags" role="group" aria-labelledby="tg-l">${Object.entries(TAGS).map(([k, v]) => `<label><input type="checkbox" name="tag" value="${k}"> ${v}</label>`).join("")}</div>
      <textarea id="rv-reason" maxlength="600" placeholder="What do you know that the model does not?" aria-label="Reason"></textarea></div>
    <div class="field"><span class="lbl">3 · Decision and follow-up</span>
      <div class="row">
        <div class="field" style="flex:2 1 220px"><label for="rv-action">Action</label><select id="rv-action">${Object.entries(ACTIONS).map(([k, v]) => `<option value="${k}" ${k === (s.flagged ? "contact_now" : "monitor") ? "selected" : ""}>${v}</option>`).join("")}</select></div>
        <div class="field" style="flex:1 1 150px" id="pri-f"><label for="rv-priority">Priority</label><select id="rv-priority">${Object.entries(PRIORITY).map(([k, v]) => `<option value="${k}" ${k === (s.band === "High" ? "urgent" : "week") ? "selected" : ""}>${v}</option>`).join("")}</select></div>
        <div class="field" style="flex:1 1 150px" id="fu-f"><label for="rv-follow">Follow up by</label><input type="date" id="rv-follow" value="${plusDays(s.band === "High" ? 7 : 14)}" min="${today()}"></div>
      </div>
      <span class="small muted">Nothing is sent to the student. This records your decision and puts the student in your caseload.</span></div>
    <div class="field"><span class="lbl">4 · Rate the explanation (1 = poor, 5 = excellent)</span>
      <div class="rubric">${RUBRIC.map(([k, n, d]) => `<div><strong class="small">${n}</strong><br><span class="small muted">${d}</span></div><div class="scale" role="radiogroup" aria-label="${n}">${[1, 2, 3, 4, 5].map(v => `<label><input type="radio" name="rb-${k}" value="${v}" id="rb-${k}-${v}" ${v === 3 ? "checked" : ""}>${v}</label>`).join("")}</div>`).join("")}</div></div>
    ${identityFields("rv")}
    <div class="row"><button class="btn primary" type="submit" id="rv-save">Save decision</button><span class="small" id="rv-msg" role="status"></span></div>
    <div><div class="eyebrow" style="margin-bottom:4px">Case history</div>${timeline(c)}</div>
  </form>`;
}
function syncReview(form) {
  if (!form || form.id !== "review-form") return;
  const a = form.querySelector("input[name=assess]:checked").value, act = form.querySelector("#rv-action").value;
  form.querySelector("#ovr-row").hidden = a !== "override"; form.querySelector("#reason-req").hidden = a === "agree";
  const noFollow = act === "none"; form.querySelector("#fu-f").hidden = noFollow; form.querySelector("#pri-f").hidden = noFollow;
}
function readIdentity(form, pre, msg) {
  if (!WEB) { if (!S.uid) { msg.textContent = "Sign in to save decisions."; msg.style.color = "var(--high)"; return false; } return true; }
  const nm = (form.querySelector("#" + pre + "-name") || {}).value || "";
  if (!nm.trim()) { msg.textContent = "Add your name so the audit log shows who made this decision."; msg.style.color = "var(--high)"; form.querySelector("#" + pre + "-name").focus(); return false; }
  ident.name = nm.trim(); const cd = form.querySelector("#" + pre + "-code"); if (cd) ident.code = cd.value.trim();
  return true;
}
const saveError = e => e && e.code === "bad_code" ? "That access code is wrong. Ask the project owner for the advisor code." : e && e.code === "invalid_argument" ? "Your access level can view reviews but not add them." : e && e.code === "local_unavailable" ? "This browser is blocking local storage, so the decision could not be kept." : e && e.code === "rate_limited" ? "Too many saves in a short time. Wait a few minutes." : "Could not save. Check your connection and try again.";
async function saveReview(form) {
  const msg = form.querySelector("#rv-msg"), btn = form.querySelector("#rv-save");
  const a = form.querySelector("input[name=assess]:checked").value, reason = form.querySelector("#rv-reason").value.trim();
  const tags = [...form.querySelectorAll("input[name=tag]:checked")].map(x => x.value);
  if (a !== "agree" && !reason && !tags.length) { msg.textContent = "Pick a reason or write one before saving a disagreement."; msg.style.color = "var(--high)"; form.querySelector("#rv-reason").focus(); return; }
  if (!readIdentity(form, "rv", msg)) return;
  const row = BY_ID[S.student], s = sc(row.id), act = form.querySelector("#rv-action").value;
  const item = { id: Math.random().toString(36).slice(2, 10), student_id: row.id, checkpoint: S.cp, advisor: ident.name || undefined,
    ai_risk: +s.risk.toFixed(4), ai_band: s.band, ai_uncertain: s.uncertain, ai_flagged: s.flagged,
    decision: a === "lower" || a === "higher" ? "disagree" : a, direction: a === "lower" || a === "higher" ? a : null,
    override_band: a === "override" ? form.querySelector("#ovr-band").value : null, reason_tags: tags, reason: reason.slice(0, 600),
    planned_action: act, priority: act === "none" ? null : form.querySelector("#rv-priority").value, follow_up: act === "none" ? null : (form.querySelector("#rv-follow").value || null) };
  RUBRIC.forEach(([k]) => item[k] = +form.querySelector(`input[name=rb-${k}]:checked`).value);
  btn.disabled = true; msg.textContent = "Saving…"; msg.style.color = "";
  try {
    const saved = await appendRecord("reviews", item);
    if (WEB) S.reviews.unshift(asReview({ ...item, ...saved }));
    msg.textContent = WEB && S.storeMode === "local" ? "Decision saved in this browser." : "Decision saved to the audit log."; msg.style.color = "var(--low)";
    setTimeout(() => render(true), 700);
  } catch (e) { msg.textContent = saveError(e); msg.style.color = "var(--high)"; btn.disabled = false; }
}
async function saveOutcome(form) {
  const msg = form.querySelector("#oc-msg"), btn = form.querySelector("#oc-save");
  if (!readIdentity(form, "oc", msg)) return;
  const c = caseOf(S.student); if (!c) return;
  const item = { id: Math.random().toString(36).slice(2, 10), student_id: S.student, review_id: c.last.id, checkpoint: c.last.checkpoint, advisor: ident.name || undefined,
    outcome: form.querySelector("#oc-outcome").value, note: form.querySelector("#oc-note").value.trim().slice(0, 400), closed: form.querySelector("#oc-close").checked };
  btn.disabled = true; msg.textContent = "Saving…"; msg.style.color = "";
  try {
    const saved = await appendRecord("outcomes", item);
    if (WEB) S.outcomes.unshift({ ...item, ...saved });
    msg.textContent = "Outcome saved."; msg.style.color = "var(--low)"; setTimeout(() => render(true), 600);
  } catch (e) { msg.textContent = saveError(e); msg.style.color = "var(--high)"; btn.disabled = false; }
}
let DB = null, USER = null;
async function initDb() {
  if (WEB) return initWeb();
  try {
    if (!window.claude || !window.claude.use) throw 0;
    [DB, USER] = await Promise.all([claude.use("db"), claude.use("user")]);
    if (!DB) throw 0;
    S.uid = USER ? await USER.id() : null;
    S.dbState = "ready"; S.storeMode = "shared";
    DB.collection("reviews").onSnapshot(async snap => {
      const items = [];
      snap.docs.forEach(d => { const data = d.data() || {}; (data.items || []).forEach(it => items.push({ ...it, reviewer: d.id })); });
      if (USER && items.length) { try { S.profiles = await USER.profiles([...new Set(items.map(i => i.reviewer))]); } catch (e) {} }
      items.forEach(i => i.reviewerName = (S.profiles[i.reviewer] && S.profiles[i.reviewer].name) || (i.reviewer === S.uid ? "You" : "Advisor"));
      S.reviews = items; if (["student", "feedback", "triage"].includes(S.view)) render(true);
    }, () => { S.dbState = "off"; render(true); });
    DB.collection("outcomes").onSnapshot(snap => {
      const items = []; snap.docs.forEach(d => ((d.data() || {}).items || []).forEach(it => items.push({ ...it, advisor: it.advisor || ((S.profiles[d.id] || {}).name) || "Advisor" })));
      S.outcomes = items; if (["student", "feedback", "triage"].includes(S.view)) render(true);
    }, () => {});
    DB.collection("copilot").onSnapshot(snap => {
      const items = []; snap.docs.forEach(d => ((d.data() || {}).items || []).forEach(it => items.push(it)));
      S.copilotRatings = items; if (S.view === "feedback") render(true);
    }, () => {});
  } catch (e) { S.dbState = "off"; }
  if (["student", "feedback"].includes(S.view)) render(true);
}

/* ---------------- Model & fairness ---------------- */
const NAMES = { heuristic: "Rule-based heuristic", logreg: "Logistic Regression", rf: "Random Forest", hgb: "Gradient Boosting" };
function liveCheck() {
  const cp = CP(); let maxd = 0, tp = 0, fp = 0, fn = 0, tn = 0;
  ROWS.forEach(r => { const s = sc(r.id); maxd = Math.max(maxd, Math.abs(s.risk - cp.python_reference[r.id])); const y = r.Target === "Dropout"; if (s.flagged && y) tp++; else if (s.flagged) fp++; else if (y) fn++; else tn++; });
  const cm = cp.report.test_results.logreg.confusion_matrix, same = cm[0][0] === tn && cm[0][1] === fp && cm[1][0] === fn && cm[1][1] === tp;
  return { maxd, tp, fp, fn, tn, same, P: tp / (tp + fp), R: tp / (tp + fn) };
}
function calibChart(cal) {
  const X = v => 40 + v * 300, Y = v => 310 - v * 290;
  let s = `<svg class="chart" viewBox="0 0 360 340" role="img" aria-label="Calibration: predicted versus observed dropout rate" style="max-width:420px">`;
  [0, .25, .5, .75, 1].forEach(v => { s += `<line x1="${X(0)}" x2="${X(1)}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--line)"/>` + axisText(34, Y(v) + 4, pct(v), "end", "mono") + axisText(X(v), 326, pct(v), "middle", "mono"); });
  s += `<line x1="${X(0)}" y1="${Y(0)}" x2="${X(1)}" y2="${Y(1)}" stroke="var(--muted)" stroke-dasharray="4 4"/>`;
  s += `<polyline fill="none" stroke="var(--ai)" stroke-width="2" points="${cal.map(c => `${X(c.mean_predicted)},${Y(c.observed_rate)}`).join(" ")}"/>`;
  cal.forEach(c => s += `<circle cx="${X(c.mean_predicted)}" cy="${Y(c.observed_rate)}" r="4" fill="var(--ai)"/>`);
  s += axisText(X(.02), Y(.93), "dashed = perfect calibration");
  return s + `</svg><p class="small muted">x: mean predicted risk in each tenth of the cohort · y: share who actually dropped out.</p>`;
}
function barPair(groups, keyA, keyB, labA, labB) {
  const W0 = 340, H = 190, bw = 22, gap = 18, gw = 2 * bw + gap, X0 = 34, Y = v => 160 - v * 140;
  let s = `<svg class="chart" style="max-width:${Math.max(W0, X0 + groups.length * (gw + 10)) * 1.25}px" viewBox="0 0 ${Math.max(W0, X0 + groups.length * (gw + 10))} ${H}" role="img" aria-label="${labA} and ${labB} by group">`;
  [0, .5, 1].forEach(v => s += `<line x1="${X0}" x2="${X0 + groups.length * (gw + 10)}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--line)"/>` + axisText(X0 - 4, Y(v) + 4, pct(v), "end", "mono"));
  groups.forEach((g, i) => {
    const x = X0 + 8 + i * (gw + 10);
    [[keyA, "var(--ai)"], [keyB, "var(--high)"]].forEach(([k, c], j) => { const v = g[k] ?? 0; s += `<rect class="gy" x="${x + j * (bw + 2)}" y="${Y(v)}" width="${bw}" height="${160 - Y(v)}" fill="${c}" fill-opacity=".8" rx="2"/><text x="${x + j * (bw + 2) + bw / 2}" y="${Y(v) - 4}" text-anchor="middle" font-size="10" class="mono" fill="var(--muted)">${Math.round(v * 100)}</text>`; });
    s += axisText(x + bw, 176, g.group, "middle") + axisText(x + bw, 188, `n=${g.n}`, "middle", "mono");
  });
  return s + `</svg>`;
}
function psiChart(d) {
  const top = d.slice(0, 12), max = Math.max(0.3, ...top.map(x => x.psi)), LW = 230, W0 = 620, X = v => LW + Math.min(v, max) / max * (W0 - LW - 60), rowH = 22, H = top.length * rowH + 34;
  let s = `<svg class="chart" viewBox="0 0 ${W0} ${H}" role="img" aria-label="Population stability index per feature">`;
  [0.1, 0.25].forEach(v => s += `<line x1="${X(v)}" x2="${X(v)}" y1="4" y2="${H - 26}" stroke="${v === .1 ? "var(--med)" : "var(--high)"}" stroke-dasharray="4 3"/>` + axisText(X(v), H - 10, v === .1 ? "0.10 monitor" : "0.25 re-validate", "middle", "mono"));
  top.forEach((x, i) => { const y = 6 + i * rowH; s += `<text x="${LW - 8}" y="${y + 13}" text-anchor="end" font-size="11.5" fill="var(--ink)">${esc(lab(x.feature))}</text><rect class="gx" x="${LW}" y="${y + 3}" width="${Math.max(X(x.psi) - LW, 1.5)}" height="13" rx="2" fill="${x.status === "major" ? "var(--high)" : x.status === "moderate" ? "var(--med)" : "var(--ai)"}" fill-opacity=".8"/><text x="${X(x.psi) + 5}" y="${y + 14}" font-size="10.5" class="mono" fill="var(--muted)">${x.psi > max ? "≥" : ""}${x.psi.toFixed(3)}</text>`; });
  return s + `</svg>`;
}
function driftRows(scn) {
  const rows = ROWS.map(r => ({ ...r })), rnd = RF.rng(7);
  if (scn === "financial_shock") rows.forEach(r => { if (rnd() < 0.25) { r["Tuition fees up to date"] = 0; r.Debtor = 1; } });
  if (scn === "older_intake") rows.forEach(r => r["Age at enrollment"] += 6);
  return rows;
}
function parseCSV(text) {
  text = text.replace(/^﻿/, "");
  const delim = (text.split("\n")[0].match(/;/g) || []).length > (text.split("\n")[0].match(/,/g) || []).length ? ";" : ",";
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  const split = l => { const out = []; let cur = "", q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === delim && !q) { out.push(cur); cur = ""; } else cur += ch; } out.push(cur); return out.map(x => x.trim()); };
  const head = split(lines[0]).map(h => h.replace(/\t/g, "").trim());
  return lines.slice(1).map(l => { const v = split(l), o = {}; head.forEach((h, i) => { const n = Number(v[i]); o[h] = v[i] !== "" && !Number.isNaN(n) ? n : v[i]; }); return o; });
}
function viewModel() {
  const cp = CP(), rep = cp.report, L = liveCheck();
  const tabs = [["performance", "Performance"], ["calibration", "Calibration & uncertainty"], ["fairness", "Fairness"], ["drift", "Drift monitor"]];
  let body = "";
  if (S.modelTab === "performance") {
    const cs = rep.success_criteria, tr = rep.test_results, cmp = rep.comparisons[`${rep.champion}_vs_heuristic`];
    const ci = (k, m) => tr[k].ci95 && tr[k].ci95[m] ? `<span class="muted"> (${fmt3(tr[k].ci95[m][0])}–${fmt3(tr[k].ci95[m][1])})</span>` : "";
    body = `<div class="grid-side">
      <div class="stack">
        <div class="panel"><h3>Success criteria from the proposal</h3><div class="check" style="margin-top:12px">
          ${[["Dropout F1 > 0.82", cs["dropout_f1_gt_0.82"], fmt3(tr[rep.champion].f1)], ["Precision > 78%", cs["precision_gt_0.78"], pct(tr[rep.champion].precision, 1)], ["Recall > 80%", cs["recall_gt_0.80"], pct(tr[rep.champion].recall, 1)], ["Latency < 200 ms (Python API, p95)", cs["latency_p95_lt_200ms"], rep.latency.p95_ms.toFixed(0) + " ms"]]
            .map(([n, ok, v]) => `<span class="${ok ? "ok" : "no"}" aria-label="${ok ? "met" : "not met"}">${ok ? "✓" : "✗"}</span><span>${n}</span><span class="mono">${v}</span>`).join("")}
          </div><p class="small muted" style="margin-top:10px">${S.cp === "sem1" ? "Warning one semester earlier costs some recall: the end-of-Semester-1 model misses two targets narrowly." : "At the end of Semester 2 the model meets every target set in the proposal."}</p></div>
        <div class="panel"><h3>Is the improvement meaningful?</h3><p style="margin-top:8px">Against the rule-based heuristic, Logistic Regression gains <strong class="mono">${(cmp.mean * 100).toFixed(1)}</strong> macro-F1 points (95% CI <span class="mono">${(cmp.ci95[0] * 100).toFixed(1)} to ${(cmp.ci95[1] * 100).toFixed(1)}</span>, paired bootstrap, 1,000 resamples). The interval ${cmp.significant ? "excludes zero, so the gain is unlikely to be chance." : "includes zero."}</p></div>
        <div class="panel"><h3>Live check in this browser</h3><p class="small" style="margin-top:8px">This page re-ran the trained model on all ${ROWS.length} held-out students in <span class="mono">${SCORE_MS.toFixed(0)} ms</span> (both decision points, 31 models each).</p>
          <ul class="plain small" style="margin-top:8px"><li>Largest difference from the Python pipeline's probabilities: <span class="mono">${L.maxd.toExponential(1)}</span> (the reference is stored to 6 decimals).</li>
          <li>Confusion matrix here: TN <span class="mono">${L.tn}</span> · FP <span class="mono">${L.fp}</span> · FN <span class="mono">${L.fn}</span> · TP <span class="mono">${L.tp}</span> — ${L.same ? `<span class="ok">identical</span> to the Python test report` : `<span class="no">differs</span> from the Python report`}.</li></ul></div>
      </div>
      <div class="panel"><h3>Held-out test results</h3><p class="small muted" style="margin-top:4px">${rep.split.test} students never used for training or tuning. Dropout is the positive class. Brackets show 95% bootstrap confidence intervals.</p>
        <div class="tablebox" style="margin-top:10px"><table><thead><tr><th>Model</th><th class="r">Precision</th><th class="r">Recall</th><th class="r">Dropout F1</th><th class="r">Macro F1</th><th class="r">ROC-AUC</th></tr></thead><tbody>
        ${["heuristic", "logreg", "rf", "hgb"].map(k => `<tr${k === rep.champion ? ' style="background:var(--ai-soft)"' : ""}><td>${NAMES[k]}${k === rep.champion ? " <span class='prov ai'>Champion</span>" : ""}</td><td class="r mono">${fmt3(tr[k].precision)}</td><td class="r mono">${fmt3(tr[k].recall)}</td><td class="r mono">${fmt3(tr[k].f1)}${ci(k, "f1")}</td><td class="r mono">${fmt3(tr[k].macro_f1)}</td><td class="r mono">${tr[k].roc_auc ? fmt3(tr[k].roc_auc) : "–"}</td></tr>`).join("")}
        </tbody></table></div>
        <ul class="plain small" style="margin-top:12px">
          <li>Split: stratified 60/20/20 (${rep.split.train} train · ${rep.split.validation} validation · ${rep.split.test} test), random state 42.</li>
          <li>Hyper-parameters tuned by 5-fold cross-validation on the training set. Champion and threshold chosen on validation only.</li>
          <li>Review threshold <span class="mono">${rep.threshold}</span>: the highest F1 that keeps validation recall at or above 80%.</li>
          <li>Random Forest (the proposal's candidate) and Gradient Boosting were tuned too. Logistic Regression won on validation, so it is the model this page runs.</li>
          <li>Sensitive attributes excluded from training: ${rep.excluded_sensitive.map(x => esc(lab(x))).join(", ")}.</li>
        </ul>
        <h3 style="margin-top:16px;font-size:1rem">Error analysis</h3>
        <p class="small" style="margin-top:4px">${rep.errors.counts.false_negative} dropouts missed and ${rep.errors.counts.false_positive} false alarms. ${esc(rep.errors.interpretation)}</p>
        <div class="tablebox" style="margin-top:8px"><table><thead><tr><th>Average profile</th><th class="r">Caught (TP)</th><th class="r">Missed (FN)</th><th class="r">False alarm (FP)</th></tr></thead><tbody>
          ${["Curricular units 1st sem (approved)", "Curricular units 1st sem (grade)", "Tuition fees up to date", "Debtor", "Scholarship holder", "Age at enrollment"].map(f => { const p = rep.errors.profile_means; const fmtv = v => BINARY.includes(f) ? pct(v) : v.toFixed(1); return `<tr><td>${esc(lab(f))}</td><td class="r mono">${fmtv(p.caught_dropouts_TP[f])}</td><td class="r mono">${fmtv(p.missed_dropouts_FN[f])}</td><td class="r mono">${fmtv(p.false_alarms_FP[f])}</td></tr>`; }).join("")}
        </tbody></table></div>
      </div></div>`;
  } else if (S.modelTab === "calibration") {
    const u = rep.uncertainty, eu = u.error_rate_when_uncertain, ec = u.error_rate_when_confident;
    body = `<div class="grid2">
      <div class="panel"><h3>Calibration</h3><p class="small muted" style="margin-top:4px">Brier score <span class="mono">${fmt3(rep.test_results[rep.champion].brier)}</span> (lower is better). Points near the diagonal mean a “60%” really behaves like 60%.</p><div style="margin-top:10px">${calibChart(rep.calibration)}</div></div>
      <div class="stack">
        <div class="panel"><h3>Do the risk bands mean what they say?</h3><div class="tablebox" style="margin-top:10px"><table><thead><tr><th>Band</th><th class="r">Students</th><th class="r">Actually dropped out</th></tr></thead><tbody>
          ${rep.risk_bands.map(b => `<tr><td>${bandHTML(b.band)}</td><td class="r mono">${b.n}</td><td class="r mono">${pct(b.observed_dropout_rate, 1)}</td></tr>`).join("")}</tbody></table></div></div>
        <div class="panel"><h3>Does the uncertainty flag help?</h3><p class="small" style="margin-top:6px">${pct(u.share_uncertain, 1)} of students are marked uncertain (their 90% range crosses the threshold). The model is wrong on <strong class="mono">${pct(eu, 0)}</strong> of them, against <strong class="mono">${pct(ec, 0)}</strong> of confident cases.</p>
          <svg class="chart" viewBox="0 0 400 120" role="img" aria-label="Error rate for uncertain versus confident cases" style="margin-top:10px">
            <text x="0" y="34" font-size="12" fill="var(--ink)">Uncertain</text><rect x="90" y="20" width="${eu * 280}" height="20" rx="3" fill="var(--med)"/><text x="${96 + eu * 280}" y="35" font-size="11" class="mono" fill="var(--muted)">${pct(eu)}</text>
            <text x="0" y="80" font-size="12" fill="var(--ink)">Confident</text><rect x="90" y="66" width="${ec * 280}" height="20" rx="3" fill="var(--ai)"/><text x="${96 + ec * 280}" y="81" font-size="11" class="mono" fill="var(--muted)">${pct(ec)}</text>
            <text x="90" y="112" font-size="11" fill="var(--muted)">error rate on held-out students</text></svg>
          <p class="small muted">${esc(u.method)}.</p></div>
      </div></div>`;
  } else if (S.modelTab === "fairness") {
    body = `<div class="stack"><p class="notice small">Gender, nationality, marital status and international status are not model inputs. They are used here only to audit outcomes. A disparate impact ratio below 0.80 (the four-fifths rule) needs review. Flag-rate gaps can reflect genuinely different dropout rates, so read them alongside recall and false-positive rate.</p>
      <div class="grid2">${cp.fairness.map(a => `<div class="panel"><div class="headrow"><h3>${esc(a.attribute)}</h3><span class="mono small ${a.disparate_impact_ratio < 0.8 ? "no" : "ok"}">DIR ${a.disparate_impact_ratio.toFixed(2)}</span></div>
        <div class="legend" style="margin-top:6px"><span><i style="background:var(--ai)"></i>Recall (dropouts caught)</span><span><i style="background:var(--high)"></i>False-positive rate</span></div>
        <div style="margin-top:6px">${barPair(a.groups, "recall", "false_positive_rate", "Recall", "False-positive rate")}</div>
        <p class="small muted">Recall gap ${pct(a.equal_opportunity_gap)} · actual dropout rate ${a.groups.map(g => `${esc(g.group)} ${pct(g.actual_dropout_rate)}`).join(", ")}.</p></div>`).join("")}</div>
      <div class="panel"><h3>What the audit means for advisors</h3><ul class="plain small" style="margin-top:8px"><li>Younger students (20 or under) who drop out are caught less often than mature-age students. Advisors should not read a Low score for a young student as clearance.</li><li>Scholarship holders are flagged far less, which matches their much lower dropout rate. Financial support is the strongest protective signal in the data.</li><li>Gender is excluded, yet flag rates still differ, because correlated features (course, age) carry part of the signal. This is monitored rather than hidden.</li></ul></div></div>`;
  } else {
    const rows = S.csv ? S.csv.rows : driftRows(S.driftScenario), d = RF.drift(cp.drift_reference, rows);
    const mean = rows.reduce((s, r) => s + RF.prob(cp.model, r), 0) / rows.length, moving = d.filter(x => x.status !== "stable");
    body = `<div class="grid-side">
      <div class="panel stack"><h3>Compare an intake with the training data</h3>
        <div class="field"><label for="drift-scn">Scenario</label><select id="drift-scn" ${S.csv ? "disabled" : ""}>
          <option value="none" ${S.driftScenario === "none" ? "selected" : ""}>Held-out cohort as recorded</option>
          <option value="financial_shock" ${S.driftScenario === "financial_shock" ? "selected" : ""}>Simulated financial shock (25% fall behind on fees)</option>
          <option value="older_intake" ${S.driftScenario === "older_intake" ? "selected" : ""}>Simulated older intake (+6 years)</option></select></div>
        <div class="field"><label for="csv-up">Or check a cohort file (UCI column names, comma or semicolon)</label><input type="file" id="csv-up" accept=".csv,text/csv">
          ${S.csv ? `<span class="small">${esc(S.csv.name)} · ${S.csv.rows.length} rows · <button class="btn" id="csv-clear" type="button">Clear file</button></span>` : ""}<span class="small" id="csv-msg" role="status"></span></div>
        ${S.driftScenario !== "none" && !S.csv ? `<p class="notice sim small"><span class="prov sim">Simulated</span> This intake is a what-if, generated from the held-out cohort.</p>` : ""}
        <div class="kpis" style="grid-template-columns:repeat(2,minmax(0,1fr))"><div class="kpi"><div class="v">${moving.length}</div><div class="l">Features drifting</div></div><div class="kpi"><div class="v">${pct(mean, 1)}</div><div class="l">Mean predicted risk</div></div></div>
        <p class="small muted">Population Stability Index against the training distribution. Below 0.10 is stable, 0.10–0.25 should be monitored, and 0.25 or more means re-validate the model before trusting new scores.</p></div>
      <div class="panel"><h3>Most-shifted features</h3><div style="margin-top:10px">${psiChart(d)}</div>
        ${moving.length ? `<p class="notice warn small">${moving.map(x => `${esc(lab(x.feature))} (${x.psi.toFixed(2)})`).join(", ")} ${moving.length === 1 ? "has" : "have"} shifted. ${moving.some(x => x.status === "major") ? "Re-validate the model before relying on scores for this intake." : "Keep monitoring."}</p>` : `<p class="small muted">No feature has drifted beyond 0.10. Scores for this intake can be read as validated.</p>`}</div>
    </div>`;
  }
  return `<section class="headrow"><div><h2>Model &amp; fairness</h2><p class="muted">Evidence for the ${esc(cp.label.toLowerCase())} model.</p></div>
    <div class="subtabs" role="group" aria-label="Model sections">${tabs.map(([k, l]) => `<button data-mt="${k}" aria-pressed="${S.modelTab === k}">${l}</button>`).join("")}</div></section>${body}`;
}

/* ---------------- Advisor feedback: the human–AI feedback loop ---------------- */
const MIN_SIGNAL = 5;   // reviews needed before the page draws conclusions
function implied(R, thr) {
  // Advisor-implied review threshold: the cut-off on the AI's risk that best reproduces advisors' own "needs follow-up" judgement.
  const pts = R.map(r => ({ p: r.ai_risk, y: advisorBand(r) !== "Low" })).filter(x => Number.isFinite(x.p));
  if (pts.length < 8 || pts.every(x => x.y) || pts.every(x => !x.y)) return null;
  const acc = t => pts.filter(x => (x.p >= t) === x.y).length / pts.length;
  let best = { t: thr, a: acc(thr) };
  for (let t = 0.05; t <= 0.951; t += 0.01) { const a = acc(t); if (a > best.a + 1e-9 || (Math.abs(a - best.a) < 1e-9 && Math.abs(t - thr) < Math.abs(best.t - thr))) best = { t, a }; }
  return { t: best.t, a: best.a, base: acc(thr), n: pts.length };
}
function signals(R, O, imp, thr) {
  const out = [], rate = (xs, f) => xs.length ? xs.filter(f).length / xs.length : 0;
  if (R.length < MIN_SIGNAL) return [["info", `Collecting evidence: ${R.length} of ${MIN_SIGNAL} reviews needed before the page reports patterns.`]];
  const low = R.filter(r => r.ai_band === "Low"), high = R.filter(r => r.ai_band === "High");
  if (low.length >= 3 && rate(low, r => bandMove(r) > 0) >= 0.25) out.push(["warn", `Advisors raised the risk for ${pct(rate(low, r => bandMove(r) > 0))} of Low-band students they reviewed. The model may be missing silent dropouts: review false negatives and consider a lower threshold at the next retraining.`]);
  if (high.length >= 3 && rate(high, r => bandMove(r) < 0) >= 0.25) out.push(["warn", `Advisors lowered the risk for ${pct(rate(high, r => bandMove(r) < 0))} of High-band students. Check these for false alarms before the next retraining.`]);
  const unc = R.filter(r => r.ai_uncertain), con = R.filter(r => !r.ai_uncertain);
  if (unc.length >= 2 && con.length >= 2) {
    const du = rate(unc, r => r.decision !== "agree"), dc = rate(con, r => r.decision !== "agree");
    out.push(du > dc + 0.1 ? ["good", `Advisors disagree more often when the model is uncertain (${pct(du)} against ${pct(dc)}), so the uncertainty flag is pointing human judgement where it is needed.`]
      : ["info", `Disagreement is similar for uncertain (${pct(du)}) and confident (${pct(dc)}) predictions.`]);
  }
  const tag = k => R.filter(r => (r.reason_tags || []).includes(k)).length;
  if (tag("data_issue") >= 2) out.push(["warn", `${tag("data_issue")} reviews say the student record looked out of date or wrong. Check data freshness before trusting new scores.`]);
  if (tag("explanation") >= 2) out.push(["warn", `${tag("explanation")} reviews found the explanation unclear. Review the SHAP wording for these students.`]);
  const mean = k => R.reduce((s, r) => s + (r[k] || 0), 0) / R.length;
  if (mean("trust") < 3) out.push(["warn", `Mean trust is ${mean("trust").toFixed(1)} out of 5. Advisors are not relying on the estimates, which is safe but limits their value; look at the reasons given.`]);
  const firstReview = id => R.filter(r => r.student_id === id).sort((a, b) => String(a.at).localeCompare(String(b.at)))[0];
  const bad = O.filter(o => ["still_at_risk", "withdrew"].includes(o.outcome)).map(o => firstReview(o.student_id)).filter(r => r && r.ai_band === "Low");
  if (bad.length) out.push(["warn", `${bad.length} student${bad.length > 1 ? "s" : ""} the model rated Low ${bad.length > 1 ? "were" : "was"} later still at risk or withdrew. ${bad.length > 1 ? "They are" : "This student is"} included in the retraining export as a missed case.`]);
  if (imp && Math.abs(imp.t - thr) >= 0.05) out.push(["info", `Advisors' own decisions are best matched by a review threshold of about ${pct(imp.t)}, against the model's ${pct(thr)} (agreement ${pct(imp.a)} against ${pct(imp.base)} on ${imp.n} reviews). Treat this as a prompt to re-examine the threshold, not as a new threshold.`]);
  if (!out.some(x => x[0] === "warn")) out.push(["good", "No systematic disagreement between advisors and the model so far."]);
  return out;
}
function viewFeedback() {
  if (S.dbState !== "ready") return `<section class="stack"><h2>Human–AI feedback loop</h2><div class="panel"><p>${S.dbState === "loading" ? "Connecting to the review log…" : "The review log needs a signed-in viewer. Open this page while signed in to see and add reviews."}</p></div></section>`;
  const R = S.reviews, O = S.outcomes || [], n = R.length, CR = S.copilotRatings || [];
  const thr = CP().threshold, Rcp = R.filter(r => r.checkpoint === S.cp), imp = implied(Rcp, thr);
  const rate = (xs, f) => xs.length ? pct(xs.filter(f).length / xs.length) : "–";
  const students = [...new Set(R.map(r => r.student_id))], cases = students.map(caseOf).filter(Boolean);
  const open = cases.filter(c => !c.closed), overdue = open.filter(c => c.overdue);
  const byBand = BANDS.map(b => { const x = R.filter(r => r.ai_band === b); return { b, x }; });
  const tagCounts = Object.entries(TAGS).map(([k, v]) => ({ k, v, n: R.filter(r => (r.reason_tags || []).includes(k)).length })).filter(t => t.n).sort((a, b) => b.n - a.n);
  const latestOutcome = id => O.filter(o => o.student_id === id).sort(newest)[0];
  const firstReview = id => R.filter(r => r.student_id === id).sort((a, b) => String(a.at).localeCompare(String(b.at)))[0];
  const outRows = BANDS.map(b => { const ids = students.filter(id => { const f = firstReview(id); return f && f.ai_band === b && latestOutcome(id); }); const oc = ids.map(latestOutcome);
    return { b, n: ids.length, good: oc.filter(o => ["support_accepted", "resolved"].includes(o.outcome)).length, bad: oc.filter(o => ["still_at_risk", "withdrew"].includes(o.outcome)).length }; });
  const bars = RUBRIC.map(([k, nm]) => ({ nm, v: n ? R.reduce((s, r) => s + (r[k] || 0), 0) / n : 0 }));
  const sig = signals(R, O, imp, thr);
  const exports = n ? `<div class="row"><button class="btn" id="fb-export" data-export="reviews">Reviews (CSV)</button>${O.length ? `<button class="btn" data-export="outcomes">Outcomes (CSV)</button>` : ""}<button class="btn primary" data-export="retrain">Retraining feedback (CSV)</button></div>` : "";
  const loopDiagram = `<div class="loop" aria-label="Feedback loop"><span>AI estimate</span><i aria-hidden="true">→</i><span>Advisor decision</span><i aria-hidden="true">→</i><span>Follow-up outcome</span><i aria-hidden="true">→</i><span>Signals and retraining data</span><i aria-hidden="true">↺</i></div>`;
  const cpPanel = `<section class="panel"><div class="headrow"><h3>Co-pilot answer quality</h3><span class="small muted">Generative AI evaluation</span></div>
    <p class="small" style="margin-top:6px">${CR.length ? `<strong class="mono">${CR.length}</strong> rated answers · <strong class="mono">${pct(CR.filter(r => r.helpful).length / CR.length)}</strong> rated helpful · answers used on average <strong class="mono">${(CR.reduce((s, r) => s + (r.tools || 0), 0) / CR.length).toFixed(1)}</strong> grounding tool calls.` : "No co-pilot answers rated yet. Ask the co-pilot a question and rate the answer."}</p>
    ${CR.filter(r => !r.helpful).length ? `<div class="eyebrow" style="margin:10px 0 4px">Answers rated not helpful (review these)</div><ul class="small">${CR.filter(r => !r.helpful).slice(0, 8).map(r => `<li>${esc(r.question)} <span class="muted">(${r.tools || 0} tool calls)</span></li>`).join("")}</ul>` : ""}</section>`;
  if (!n) return `<section class="headrow"><div><h2>Human–AI feedback loop</h2><p class="muted">Advisors' decisions and follow-up outcomes are recorded here and fed back as evidence about the model.</p></div></section>${storeNote()}${loopDiagram}
    <section class="panel"><h3>No decisions recorded yet</h3><p style="margin-top:6px">Open a student in the diagnostic view, record your decision and a follow-up date, then come back here after the follow-up to record what happened.</p><p style="margin-top:10px"><a class="btn primary" href="#student" data-open="${S.student}">Review student ${S.student}</a></p></section>${cpPanel}`;
  return `<section class="headrow"><div><h2>Human–AI feedback loop</h2><p class="muted">Every decision and outcome is an append-only record. Together they show where advisors and the model agree, and they produce new labelled data for retraining.</p></div>${exports}</section>
  ${storeNote()}${loopDiagram}
  <section class="kpis">
    <div class="kpi"><div class="v">${n}</div><div class="l">Decisions recorded</div></div>
    <div class="kpi"><div class="v">${rate(R, r => r.decision === "agree")}</div><div class="l">Agreed with the AI</div></div>
    <div class="kpi"><div class="v">${rate(R, r => bandMove(r) > 0)}</div><div class="l">Advisor raised the risk</div></div>
    <div class="kpi"><div class="v">${rate(R, r => bandMove(r) < 0)}</div><div class="l">Advisor lowered the risk</div></div>
    <div class="kpi"><div class="v">${open.length}${overdue.length ? ` <span class="small" style="color:var(--high)">(${overdue.length} late)</span>` : ""}</div><div class="l">Open cases</div></div>
    <div class="kpi"><div class="v">${O.length}</div><div class="l">Outcomes recorded</div></div>
  </section>
  <section class="panel"><div class="headrow"><h3>What the feedback says about the model</h3><span class="prov ai">Feedback signals</span></div>
    <ul class="signals">${sig.map(([k, t]) => `<li class="${k}">${esc(t)}</li>`).join("")}</ul>
    <p class="small muted">Signals are recomputed every time a decision or outcome is saved. They inform the next retraining; they never change the live model on their own.</p></section>
  <section class="grid2">
    <div class="panel"><h3>Where advisors and the model differ</h3><div class="tablebox" style="margin-top:10px"><table><thead><tr><th>AI band</th><th class="r">Decisions</th><th class="r">Agreed</th><th class="r">Raised</th><th class="r">Lowered</th></tr></thead><tbody>
      ${byBand.map(({ b, x }) => `<tr><td>${bandHTML(b)}</td><td class="r mono">${x.length}</td><td class="r mono">${rate(x, r => r.decision === "agree")}</td><td class="r mono">${rate(x, r => bandMove(r) > 0)}</td><td class="r mono">${rate(x, r => bandMove(r) < 0)}</td></tr>`).join("")}
      <tr><td>Uncertain predictions</td><td class="r mono">${R.filter(r => r.ai_uncertain).length}</td><td class="r mono">${rate(R.filter(r => r.ai_uncertain), r => r.decision === "agree")}</td><td class="r mono">${rate(R.filter(r => r.ai_uncertain), r => bandMove(r) > 0)}</td><td class="r mono">${rate(R.filter(r => r.ai_uncertain), r => bandMove(r) < 0)}</td></tr></tbody></table></div>
      ${imp ? `<p class="small" style="margin-top:8px">Advisor-implied threshold (${esc(CP().label)}): <strong class="mono">${pct(imp.t)}</strong> against the model's <strong class="mono">${pct(thr)}</strong>, from ${imp.n} decisions.</p>` : `<p class="small muted" style="margin-top:8px">The advisor-implied threshold appears after at least 8 decisions at this decision point, with some students judged Low and some not.</p>`}</div>
    <div class="panel"><h3>Why advisors disagreed</h3>${tagCounts.length ? `<svg class="chart" viewBox="0 0 460 ${tagCounts.length * 30 + 10}" role="img" aria-label="Reasons given by advisors" style="margin-top:10px">${tagCounts.map((t, i) => { const w = 200 * t.n / tagCounts[0].n; return `<text x="236" y="${i * 30 + 20}" text-anchor="end" font-size="11.5" fill="var(--ink)">${esc(t.v.length > 38 ? t.v.slice(0, 37) + "…" : t.v)}</text><rect x="244" y="${i * 30 + 6}" width="${Math.max(w, 2)}" height="18" rx="3" fill="var(--sim)" fill-opacity=".8"/><text x="${250 + w}" y="${i * 30 + 20}" font-size="11" class="mono" fill="var(--muted)">${t.n}</text>`; }).join("")}</svg>` : `<p class="small muted" style="margin-top:8px">No reasons recorded yet. Reasons are collected whenever an advisor disagrees.</p>`}</div>
  </section>
  <section class="grid2">
    <div class="panel"><h3>Follow-up outcomes against the AI band</h3><p class="small muted" style="margin-top:4px">Latest outcome per student, by the AI band at the first review. Resolved = support accepted or situation resolved; still at risk includes withdrawals.</p><div class="tablebox" style="margin-top:10px"><table><thead><tr><th>AI band</th><th class="r">With outcome</th><th class="r">Resolved</th><th class="r">Still at risk</th></tr></thead><tbody>
      ${outRows.map(x => `<tr><td>${bandHTML(x.b)}</td><td class="r mono">${x.n}</td><td class="r mono">${x.n ? pct(x.good / x.n) : "–"}</td><td class="r mono">${x.n ? pct(x.bad / x.n) : "–"}</td></tr>`).join("")}</tbody></table></div>
      <p class="small muted" style="margin-top:8px">If Low-band students end up still at risk, the model is missing cases; those students are flagged in the retraining export.</p></div>
    <div class="panel"><h3>Explanation quality rubric</h3><p class="small muted" style="margin-top:4px">Mean rating, 1–5.</p>
      <svg class="chart" viewBox="0 0 460 ${bars.length * 34 + 30}" role="img" aria-label="Mean rubric scores" style="margin-top:10px">
      ${[1, 2, 3, 4, 5].map(v => `<line x1="${120 + (v - 1) * 75}" x2="${120 + (v - 1) * 75}" y1="4" y2="${bars.length * 34 + 6}" stroke="var(--line)"/>${axisText(120 + (v - 1) * 75, bars.length * 34 + 22, v, "middle", "mono")}`).join("")}
      ${bars.map((b, i) => `<text x="110" y="${i * 34 + 22}" text-anchor="end" font-size="12" fill="var(--ink)">${b.nm}</text><rect class="gx" x="120" y="${i * 34 + 8}" width="${Math.max((b.v - 1) * 75, 2)}" height="20" rx="3" fill="var(--ai)" fill-opacity=".85"/><text x="${126 + Math.max((b.v - 1) * 75, 2)}" y="${i * 34 + 23}" font-size="11" class="mono" fill="var(--muted)">${b.v.toFixed(2)}</text>`).join("")}
      </svg></div>
  </section>
  <section class="panel"><div class="headrow"><h3>Caseload: open cases</h3><span class="small muted">Sorted by follow-up date</span></div>${open.length ? `<div class="tablebox" style="margin-top:10px"><table><thead><tr><th>Student</th><th>AI</th><th>Advisor</th><th>Decision</th><th>Action</th><th>Priority</th><th>Follow up by</th></tr></thead><tbody>
    ${open.sort((a, b) => String(a.last.follow_up || "9").localeCompare(String(b.last.follow_up || "9"))).map(c => `<tr><td class="mono"><a href="#student" data-open="${esc(c.last.student_id)}">${esc(c.last.student_id)}</a></td><td>${pct(c.last.ai_risk)} ${bandHTML(c.last.ai_band)}</td><td>${bandHTML(advisorBand(c.last))} <span class="small muted">${esc(c.last.reviewerName)}</span></td><td>${esc(assessText(c.last))}</td><td>${esc(ACTIONS[c.last.planned_action] || c.last.planned_action)}</td><td>${esc(PRIORITY[c.last.priority] || "–")}</td><td class="mono" style="${c.overdue ? "color:var(--high);font-weight:600" : ""}">${esc(c.last.follow_up || "–")}${c.overdue ? " (late)" : ""}</td></tr>`).join("")}</tbody></table></div>` : `<p class="small muted" style="margin-top:6px">No open cases. Every reviewed student has a recorded outcome or needed no action.</p>`}</section>
  <section class="panel"><h3>Audit log: latest decisions</h3><div class="tablebox" style="margin-top:10px"><table><thead><tr><th>When</th><th>Advisor</th><th>Student</th><th>AI</th><th>Decision</th><th>Action</th><th>Reasons</th></tr></thead><tbody>
    ${R.slice().sort(newest).slice(0, 50).map(r => `<tr><td class="mono small">${esc(String(r.at).slice(0, 16).replace("T", " "))}</td><td>${esc(r.reviewerName)}</td><td class="mono"><a href="#student" data-open="${esc(r.student_id)}">${esc(r.student_id)}</a></td><td>${pct(r.ai_risk)} ${bandHTML(r.ai_band)}</td><td>${esc(assessText(r))} → ${bandHTML(advisorBand(r))}</td><td>${esc(ACTIONS[r.planned_action] || r.planned_action)}</td><td style="white-space:normal;min-width:180px">${esc([(r.reason_tags || []).map(k => TAGS[k] || k).join("; "), r.reason].filter(Boolean).join(" · "))}</td></tr>`).join("")}
  </tbody></table></div></section>${cpPanel}`;
}
async function exportCSV(kind = "reviews") {
  const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`, R = S.reviews, O = S.outcomes || [];
  let head, rows, name;
  if (kind === "outcomes") {
    head = ["at", "advisor", "student_id", "checkpoint", "review_id", "outcome", "closed", "note"]; rows = O.map(o => head.map(h => o[h])); name = "retentionflow_outcomes.csv";
  } else if (kind === "retrain") {
    // One row per reviewed student and decision point: the AI's estimate, the advisor's judgement, the outcome and the model inputs.
    const keyed = {}; R.slice().sort(newest).forEach(r => { const k = r.student_id + "|" + r.checkpoint; if (!keyed[k]) keyed[k] = r; });
    const feats = [...new Set(Object.values(W.checkpoints).flatMap(c => c.features))];
    head = ["student_id", "checkpoint", "ai_risk", "ai_band", "ai_uncertain", "advisor_band", "advisor_move", "reason_tags", "latest_outcome", "outcome_label", "missed_by_model", ...feats];
    rows = Object.values(keyed).map(r => { const o = O.filter(x => x.student_id === r.student_id).sort(newest)[0], row = BY_ID[r.student_id] || {};
      const label = o ? (["still_at_risk", "withdrew"].includes(o.outcome) ? 1 : ["support_accepted", "resolved"].includes(o.outcome) ? 0 : "") : "";
      return [r.student_id, r.checkpoint, r.ai_risk, r.ai_band, r.ai_uncertain, advisorBand(r), bandMove(r), (r.reason_tags || []).join(";"), o ? o.outcome : "", label, r.ai_band === "Low" && (label === 1 || bandMove(r) > 0) ? 1 : 0, ...feats.map(f => row[f])]; });
    name = "retentionflow_retraining_feedback.csv";
  } else {
    head = ["at", "reviewer", "student_id", "checkpoint", "ai_risk", "ai_band", "ai_uncertain", "decision", "direction", "override_band", "advisor_band", "reason_tags", "planned_action", "priority", "follow_up", "clarity", "usefulness", "trust", "actionability", "reason"];
    rows = R.map(r => head.map(h => h === "reviewer" ? r.reviewerName : h === "advisor_band" ? advisorBand(r) : h === "reason_tags" ? (r.reason_tags || []).join(";") : r[h])); name = "retentionflow_advisor_reviews.csv";
  }
  const csv = [head.join(","), ...rows.map(r => r.map(q).join(","))].join("\n");
  if (WEB) { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); return; }
  try { const dl = await claude.use("downloads"); if (!dl) throw 0; await dl.save({ filename: name, data: csv }); }
  catch (e) { const b = document.querySelector(`[data-export="${kind}"]`); if (b) b.textContent = "Download unavailable in this view"; }
}

/* ---------------- About ---------------- */
function viewAbout() {
  const d = W.dataset;
  return `<section class="prose"><h2>About RetentionFlow AI</h2>
    <p>RetentionFlow AI helps student success advisors find students who may drop out early enough to help, understand why the model thinks so, and explore which support might change the picture. It was built by group NONAME 06 for ICT605 at Murdoch University.</p></section>
  <section class="grid2">
    <div class="panel"><h3>Intended use</h3><ul class="plain" style="margin-top:8px"><li>Prioritising which students an advisor contacts first.</li><li>Understanding the academic and financial factors behind a student's risk.</li><li>Exploring support options (fee plans, scholarships, academic help) before a conversation.</li><li>Recording advisor decisions in an auditable log.</li></ul></div>
    <div class="panel"><h3>Not intended for</h3><ul class="plain" style="margin-top:8px"><li>Automatic suspension, exclusion or withdrawal of any student.</li><li>Admissions, scholarship or funding decisions.</li><li>Punitive or disciplinary action.</li><li>Judging individuals by demographic group.</li></ul></div>
  </section>
  <section class="grid2">
    <div class="panel"><h3>How the AI works</h3><ul class="plain small" style="margin-top:8px">
      <li><strong>Prediction.</strong> A class-balanced logistic regression, trained in Python (scikit-learn) and run unchanged in this page, estimates each student's probability of dropping out.</li>
      <li><strong>Decision points.</strong> One model uses only enrolment and Semester 1 data (early warning), the other adds Semester 2.</li>
      <li><strong>Explanations.</strong> Exact SHAP contributions show which recorded facts pushed the estimate up or down.</li>
      <li><strong>Uncertainty.</strong> 30 versions trained on bootstrap resamples give a 90% range. When it crosses the threshold, the student is marked uncertain.</li>
      <li><strong>Simulation.</strong> The What-If view re-scores a student with changed support levers. It shows association, not a promised effect.</li>
      <li><strong>Monitoring.</strong> The drift monitor compares any intake with the training data before its scores are trusted.</li></ul></div>
    <div class="panel"><h3>Known limitations</h3><ul class="plain small" style="margin-top:8px">
      <li>Data come from one Portuguese polytechnic over 2008–2019 and may not transfer to other institutions without re-validation.</li>
      <li>The early-warning model narrowly misses the proposal's recall and F1 targets.</li>
      <li>Dropouts aged 20 or under are caught less often than older students (see the Fairness tab).</li>
      <li>There is no live data feed. The demo cohort is the 885 held-out test students, identified only by a dataset row number.</li>
      <li>The What-If simulator cannot prove that an intervention causes a lower risk.</li></ul></div>
  </section>
  <section class="panel small"><h3>Data, licence and acknowledgements</h3><p style="margin-top:8px">${esc(d.name)}, ${esc(d.citation)}, ${esc(d.licence)}, <a href="https://doi.org/${d.doi}" target="_blank" rel="noopener">doi.org/${d.doi}</a>. ${d.rows.toLocaleString()} student records with no personal identifiers. Built with scikit-learn, SHAP, pandas and FastAPI (training and evaluation pipeline). Generative AI assistance (Claude) helped write code and documentation. Every reported number comes from running that pipeline. Source: <a href="https://github.com/Abdul-Khalek-Alve/retentionflow" target="_blank" rel="noopener">github.com/Abdul-Khalek-Alve/retentionflow</a>.</p>
    <p class="muted" style="margin-top:8px">References: Breiman (2001) Random forests; Lundberg &amp; Lee (2017) A unified approach to interpreting model predictions; Efron &amp; Tibshirani (1993) An introduction to the bootstrap; Martins et al. (2021) Early prediction of student's performance in higher education.</p></section>`;
}

/* ---------------- render + events ---------------- */
const VIEWS = { triage: viewTriage, student: viewStudent, whatif: viewWhatIf, model: viewModel, feedback: viewFeedback, about: viewAbout };
function render(keepScroll) {
  const y = window.scrollY, focusId = document.activeElement && document.activeElement.id, sel = document.activeElement && document.activeElement.selectionStart;
  document.querySelectorAll("[data-cp]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.cp === S.cp)));
  document.querySelectorAll("nav.tabs a").forEach(a => { if (a.dataset.view === S.view) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
  // keep an in-progress review draft across live re-renders
  const draft = {}; const f = document.getElementById("review-form");
  if (f) f.querySelectorAll("input,select,textarea").forEach(el => { draft[el.id] = el.type === "radio" || el.type === "checkbox" ? el.checked : el.value; });
  app.innerHTML = VIEWS[S.view]();
  const f2 = document.getElementById("review-form");
  if (f2 && keepScroll) { f2.querySelectorAll("input,select,textarea").forEach(el => { if (el.id in draft) { if (el.type === "radio" || el.type === "checkbox") el.checked = draft[el.id]; else el.value = draft[el.id]; } }); syncReview(f2); }
  if (keepScroll) window.scrollTo(0, y);
  if (focusId) { const el = document.getElementById(focusId); if (el && keepScroll) { el.focus({ preventScroll: true }); try { if (sel != null) el.setSelectionRange(sel, sel); } catch (e) {} } }
}
function animateEntry() {
  app.classList.remove("enter"); void app.offsetWidth; app.classList.add("enter");
  clearTimeout(animateEntry.t); animateEntry.t = setTimeout(() => app.classList.remove("enter"), 1200);
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  app.querySelectorAll("[data-count]").forEach(el => { const end = +el.dataset.count, t0 = performance.now(); const step = now => { const k = Math.min(1, (now - t0) / 700), e = 1 - Math.pow(1 - k, 3); el.textContent = Math.round(end * e); if (k < 1) requestAnimationFrame(step); }; requestAnimationFrame(step); });
  app.querySelectorAll("[data-countpct]").forEach(el => { const end = +el.dataset.countpct, t0 = performance.now(); const step = now => { const k = Math.min(1, (now - t0) / 700), e = 1 - Math.pow(1 - k, 3); el.textContent = pct(end * e); if (k < 1) requestAnimationFrame(step); }; requestAnimationFrame(step); });
}
function go(view) { S.view = view; if (location.hash !== "#" + view) { try { history.replaceState(null, "", "#" + view); } catch (e) {} } render(false); window.scrollTo(0, 0); animateEntry(); CO.refresh(); }
window.addEventListener("hashchange", () => { const v = location.hash.slice(1); if (VIEWS[v] && v !== S.view) go(v); });
document.querySelectorAll("[data-cp]").forEach(b => b.addEventListener("click", () => { S.cp = b.dataset.cp; S.changes = {}; savePrefs(); render(true); animateEntry(); CO.refresh(); }));
document.querySelectorAll("nav.tabs a").forEach(a => a.addEventListener("click", e => { e.preventDefault(); go(a.dataset.view); }));

app.addEventListener("click", e => {
  const t = e.target;
  const tr = t.closest("tr.click"); if (tr) { S.student = tr.dataset.id; S.changes = {}; go("student"); return; }
  const pb = t.closest("[data-openid]"); if (pb) { S.student = pb.dataset.openid; S.changes = {}; go("student"); return; }
  const ask = t.closest("[data-ask]"); if (ask) { CO.open(); CO.ask(ask.dataset.ask); return; }
  const tile = t.closest(".tile"); if (tile) { S.course = S.course === tile.dataset.course ? "" : tile.dataset.course; S.page = 0; render(true); return; }
  const op = t.closest("[data-open]"); if (op) { e.preventDefault(); S.student = op.dataset.open; go("student"); return; }
  if (t.closest("[data-sort]")) { const k = t.closest("[data-sort]").dataset.sort; S.dir = S.sort === k ? -S.dir : (k === "risk" ? -1 : 1); S.sort = k; render(true); return; }
  if (t.id === "clear-course") { S.course = ""; render(true); return; }
  if (t.id === "pg-prev") { S.page--; render(true); return; }
  if (t.id === "pg-next") { S.page++; render(true); return; }
  if (t.id === "go-whatif") { e.preventDefault(); go("whatif"); return; }
  if (t.id === "wi-reset") { S.changes = {}; patchWhatIf(); return; }
  if (t.id === "wi-save") {
    const row = BY_ID[S.student], scen = { ...row, ...S.changes }, s = RF.score(CP(), scen), cur = sc(row.id);
    const desc = Object.keys(S.changes).filter(k => S.changes[k] !== row[k]).map(k => `${lab(k)}: ${fval(k, row[k])} → ${fval(k, S.changes[k])}`).join("; ");
    S.scenarios.push({ id: row.id, desc, risk: s.risk, band: s.band, d: s.risk - cur.risk }); render(true); return;
  }
  if (t.dataset.del !== undefined) { S.scenarios.splice(+t.dataset.del, 1); render(true); return; }
  if (t.dataset.mt) { S.modelTab = t.dataset.mt; render(true); return; }
  if (t.id === "csv-clear") { S.csv = null; render(true); return; }
  const ex = t.closest("[data-export]"); if (ex) { exportCSV(ex.dataset.export); return; }
});
app.addEventListener("keydown", e => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const tr = e.target.closest("tr.click"), tile = e.target.closest(".tile");
  if (tr || tile) { e.preventDefault(); (tr || tile).dispatchEvent(new MouseEvent("click", { bubbles: true })); }
});
let qTimer;
app.addEventListener("input", e => {
  const t = e.target;
  if (t.id === "f-q") { clearTimeout(qTimer); qTimer = setTimeout(() => { S.q = t.value; S.page = 0; render(true); }, 180); return; }
  if (t.dataset.lever && t.type === "range") { S.changes[t.dataset.lever] = +t.value; patchWhatIf(); return; }
});
app.addEventListener("change", e => {
  const t = e.target;
  if (t.id === "f-band") { S.band = t.value; S.page = 0; render(true); }
  else if (t.id === "f-course") { S.course = t.value; S.page = 0; render(true); }
  else if (t.id === "f-unc") { S.uncertainOnly = t.checked; S.page = 0; render(true); }
  else if (t.id === "f-reveal") { S.reveal = t.checked; render(true); }
  else if (t.id === "pick") { const v = t.value.trim().toUpperCase(); S.student = /^S\d+$/.test(v) ? "S" + v.slice(1).padStart(4, "0") : v; S.changes = {}; render(true); animateEntry(); CO.refresh(); }
  else if (t.dataset.lever && t.type === "checkbox") { S.changes[t.dataset.lever] = t.checked ? 1 : 0; patchWhatIf(); }
  else if (t.id === "drift-scn") { S.driftScenario = t.value; render(true); }
  else if (t.name === "assess" || t.id === "rv-action") syncReview(t.form);
  else if (t.id === "csv-up" && t.files && t.files[0]) {
    const file = t.files[0], msg = document.getElementById("csv-msg");
    if (file.size > 8e6) { msg.textContent = "That file is over 8 MB. Use a smaller cohort file."; return; }
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const rows = parseCSV(String(rd.result)), missing = CP().features.filter(f => !(f in (rows[0] || {})));
        if (!rows.length) throw new Error("The file has no data rows.");
        if (missing.length) { msg.textContent = `Missing columns: ${missing.slice(0, 4).join(", ")}${missing.length > 4 ? ` and ${missing.length - 4} more` : ""}.`; msg.style.color = "var(--high)"; return; }
        S.csv = { name: file.name, rows: rows.slice(0, 20000) }; render(true);
      } catch (err) { msg.textContent = "Could not read that file as CSV."; msg.style.color = "var(--high)"; }
    };
    rd.readAsText(file);
  }
});
app.addEventListener("submit", e => { if (e.target.id === "review-form") { e.preventDefault(); saveReview(e.target); } else if (e.target.id === "outcome-form") { e.preventDefault(); saveOutcome(e.target); } });
app.addEventListener("keydown", e => { if (e.key === "Enter" && e.target.id === "pick") { e.preventDefault(); e.target.dispatchEvent(new Event("change", { bubbles: true })); } });
/* ---------------- AI co-pilot (Claude via the page's `sample` capability) ----------------
   Grounding: Claude never sees free-floating numbers. It calls the page's own tools, which run the
   trained model in this browser (risk, 90% range, SHAP, What-If, cohort, evidence), and every tool
   call is shown to the advisor as a trace chip under the answer. */
const CO = (() => {
  const $ = id => document.getElementById(id);
  let SAMPLE = null, toolsOK = false, ctl = null, busy = false;
  const turns = [];            // [{role, content}] sent to Claude (after the rules turn)
  const log = [];              // [{role, text, trace, q, rated, err}]
  const KEY = ["Curricular units 1st sem (approved)", "Curricular units 1st sem (enrolled)", "Curricular units 1st sem (grade)", "Curricular units 2nd sem (approved)", "Curricular units 2nd sem (enrolled)", "Curricular units 2nd sem (grade)", "Tuition fees up to date", "Debtor", "Scholarship holder", "Age at enrollment", "Admission grade", "Course"];
  const r2 = v => Math.round(v * 1000) / 10;
  const normId = v => { const x = String(v || "").trim().toUpperCase(); return /^S?\d+$/.test(x) ? "S" + x.replace(/^S/, "").padStart(4, "0") : x; };
  const cpOf = v => (v === "sem2" || v === "sem1") ? v : S.cp;

  function advisorCase(id) {
    const c = caseOf(id); if (!c) return "No advisor has reviewed this student yet.";
    const o = c.outcomes[0];
    return { status: c.status, last_decision: assessText(c.last), advisor_band: advisorBand(c.last), ai_band_at_review: c.last.ai_band, planned_action: ACTIONS[c.last.planned_action] || c.last.planned_action,
      follow_up_by: c.last.follow_up || null, reasons: (c.last.reason_tags || []).map(k => TAGS[k] || k), note: c.last.reason || "", latest_outcome: o ? OUTCOMES[o.outcome] || o.outcome : null, decided_by: c.last.reviewerName || "Advisor" };
  }
  function studentFacts(id, cpKey) {
    const row = BY_ID[normId(id)]; if (!row) throw new Error(`No held-out student ${id}. IDs look like S1529.`);
    const cp = W.checkpoints[cpKey], s = SCORES[cpKey][row.id], sh = RF.shap(cp.model, row);
    const top = Object.entries(sh).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 6)
      .map(([f, v]) => ({ factor: lab(f), value: fval(f, row[f]), effect: v > 0 ? "raises risk" : "lowers risk", strength: +Math.abs(v).toFixed(2) }));
    const observed = {}; KEY.filter(f => cp.features.includes(f)).forEach(f => observed[lab(f)] = fval(f, row[f]));
    const other = cpKey === "sem1" ? "sem2" : "sem1";
    return { student_id: row.id, decision_point: cp.label, risk_pct: r2(s.risk), range_90_pct: [r2(s.lo), r2(s.hi)], band: s.band,
      flagged_for_review: s.flagged, uncertain: s.uncertain, review_threshold_pct: r2(cp.threshold), top_factors: top, observed,
      risk_at_other_decision_point_pct: r2(SCORES[other][row.id].risk), advisor_case: advisorCase(row.id) };
  }
  const TOOLS = [
    { name: "get_student", description: "Returns one held-out student's AI risk estimate (percent), 90% uncertainty range, band, review flag, the SHAP factors driving it, and key observed record fields. Use before saying anything about a student.",
      inputSchema: { type: "object", properties: { student_id: { type: "string", description: "e.g. S1529" }, decision_point: { type: "string", enum: ["sem1", "sem2"] } }, required: ["student_id"] },
      execute: i => { const out = studentFacts(i.student_id, cpOf(i.decision_point)); trace(`get_student ${out.student_id} → ${out.risk_pct}%`); return out; } },
    { name: "simulate_support", description: "Re-scores a student with changed support levers using the trained model and returns current vs simulated risk. Levers: 'Tuition fees up to date' (0/1), 'Debtor' (0/1), 'Scholarship holder' (0/1), 'Curricular units 1st sem (approved)', 'Curricular units 1st sem (grade)' (0-20), and the 2nd sem equivalents at sem2. Association, not causation.",
      inputSchema: { type: "object", properties: { student_id: { type: "string" }, changes: { type: "object", description: "lever name -> new numeric value" }, decision_point: { type: "string", enum: ["sem1", "sem2"] } }, required: ["student_id", "changes"] },
      execute: i => {
        const cpKey = cpOf(i.decision_point), cp = W.checkpoints[cpKey], row = BY_ID[normId(i.student_id)];
        if (!row) throw new Error(`No held-out student ${i.student_id}.`);
        const ch = i.changes && typeof i.changes === "object" ? i.changes : {}, scen = { ...row }, applied = {};
        for (const [k, v] of Object.entries(ch)) {
          const L = W.levers[k]; if (!L || !cp.features.includes(k)) throw new Error(`'${k}' is not an adjustable lever at this decision point. Sensitive attributes can never be changed.`);
          const n = Math.min(Math.max(Number(v), L.min ?? 0), L.max ?? 1); if (Number.isNaN(n)) throw new Error(`Bad value for ${k}`); scen[k] = n; applied[k] = n;
        }
        const cur = SCORES[cpKey][row.id], sim = RF.score(cp, scen);
        trace(`simulate ${row.id}: ${Object.keys(applied).map(k => lab(k)).join(" + ") || "no change"} → ${r2(sim.risk)}%`);
        if (S.view === "whatif" && S.student === row.id && cpKey === S.cp) { S.changes = { ...applied }; patchWhatIf(); }
        return { student_id: row.id, changes: Object.fromEntries(Object.entries(applied).map(([k, v]) => [lab(k), fval(k, v)])), current_risk_pct: r2(cur.risk), current_band: cur.band,
          simulated_risk_pct: r2(sim.risk), simulated_band: sim.band, change_points: +(r2(sim.risk) - r2(cur.risk)).toFixed(1), simulated_range_90_pct: [r2(sim.lo), r2(sim.hi)], caveat: "Associational estimate, not a guaranteed effect." };
      } },
    { name: "find_students", description: "Lists held-out students from the cohort, sorted by risk or by 'movable' (risk x the largest drop one financial support lever could give). Optional filters: band (Low/Medium/High), course name, uncertain_only, flagged_only. Returns at most 10.",
      inputSchema: { type: "object", properties: { sort_by: { type: "string", enum: ["risk", "movable"] }, band: { type: "string" }, course: { type: "string" }, uncertain_only: { type: "boolean" }, flagged_only: { type: "boolean" }, limit: { type: "number" } } },
      execute: i => {
        let rs = ROWS.map(r => ({ r, s: sc(r.id) }));
        if (i.band) rs = rs.filter(x => x.s.band.toLowerCase() === String(i.band).toLowerCase());
        if (i.course) rs = rs.filter(x => course(x.r.Course).toLowerCase().includes(String(i.course).toLowerCase()));
        if (i.uncertain_only) rs = rs.filter(x => x.s.uncertain);
        if (i.flagged_only) rs = rs.filter(x => x.s.flagged);
        const prio = Object.fromEntries(priorities().map(p => [p.id, p]));
        if (i.sort_by === "movable") rs = rs.filter(x => prio[x.r.id]).sort((a, b) => prio[b.r.id].score - prio[a.r.id].score);
        else rs.sort((a, b) => b.s.risk - a.s.risk);
        const n = Math.min(Math.max(Number(i.limit) || 5, 1), 10);
        trace(`find_students ${i.sort_by || "risk"}${i.band ? " · " + i.band : ""}${i.course ? " · " + i.course : ""} → ${Math.min(n, rs.length)} of ${rs.length}`);
        return { matched: rs.length, decision_point: CP().label, students: rs.slice(0, n).map(({ r, s }) => ({ student_id: r.id, course: course(r.Course), risk_pct: r2(s.risk), band: s.band, uncertain: s.uncertain,
          best_single_lever: prio[r.id] ? `${prio[r.id].lever} (−${r2(prio[r.id].drop)} pts)` : null })) };
      } },
    { name: "cohort_overview", description: "Cohort-level summary at the current decision point: counts by band, flagged and uncertain counts, and the five courses with the highest mean predicted risk.",
      execute: () => {
        const all = ROWS.map(r => sc(r.id)), byC = {};
        ROWS.forEach(r => { const k = course(r.Course); (byC[k] ||= { n: 0, sum: 0 }); byC[k].n++; byC[k].sum += sc(r.id).risk; });
        trace("cohort_overview");
        return { decision_point: CP().label, students: all.length, flagged: all.filter(s => s.flagged).length, uncertain: all.filter(s => s.uncertain).length,
          bands: { High: all.filter(s => s.band === "High").length, Medium: all.filter(s => s.band === "Medium").length, Low: all.filter(s => s.band === "Low").length },
          highest_risk_courses: Object.entries(byC).map(([c, v]) => ({ course: c, students: v.n, mean_risk_pct: r2(v.sum / v.n) })).sort((a, b) => b.mean_risk_pct - a.mean_risk_pct).slice(0, 5) };
      } },
    { name: "model_evidence", description: "Held-out test evidence for the current decision point: champion vs baseline metrics with 95% CIs, success criteria, uncertainty usefulness, risk band reliability, error analysis and fairness audit summary.",
      execute: () => {
        const rep = CP().report, tr = rep.test_results; trace("model_evidence");
        const m = k => ({ precision: +tr[k].precision.toFixed(3), recall: +tr[k].recall.toFixed(3), dropout_f1: +tr[k].f1.toFixed(3), dropout_f1_ci95: tr[k].ci95.f1.map(v => +v.toFixed(3)), macro_f1: +tr[k].macro_f1.toFixed(3) });
        return { decision_point: rep.checkpoint_label, champion: "Logistic Regression (class-balanced)", test_students: rep.split.test, champion_metrics: m("logreg"), heuristic_baseline: m("heuristic"), random_forest: m("rf"), gradient_boosting: m("hgb"),
          improvement_vs_heuristic_macro_f1: rep.comparisons.logreg_vs_heuristic, success_criteria: rep.success_criteria,
          uncertainty: { share_uncertain: rep.uncertainty.share_uncertain, error_rate_uncertain: rep.uncertainty.error_rate_when_uncertain, error_rate_confident: rep.uncertainty.error_rate_when_confident },
          risk_bands: rep.risk_bands, errors: rep.errors.counts, excluded_from_training: rep.excluded_sensitive,
          fairness: CP().fairness.map(a => ({ attribute: a.attribute, disparate_impact_ratio: +a.disparate_impact_ratio.toFixed(2), recall_gap: +a.equal_opportunity_gap.toFixed(2), groups: a.groups.map(g => ({ group: g.group, n: g.n, recall: g.recall && +g.recall.toFixed(2), actual_dropout_rate: +g.actual_dropout_rate.toFixed(2) })) })) };
      } },
    { name: "open_student", description: "Opens a student's diagnostic view on the advisor's screen. Use when the advisor asks to see or open a student.",
      inputSchema: { type: "object", properties: { student_id: { type: "string" }, view: { type: "string", enum: ["student", "whatif"] } }, required: ["student_id"] },
      execute: i => { const id = normId(i.student_id); if (!BY_ID[id]) throw new Error(`No held-out student ${i.student_id}.`); S.student = id; S.changes = {}; go(i.view === "whatif" ? "whatif" : "student"); trace(`open ${id}`); return { opened: id }; } },
  ];

  function rules() {
    return `You are the RetentionFlow AI co-pilot for a university Student Success Advisor. You help them triage students at risk of dropping out, understand the model's reasons, and plan supportive outreach.

Ground rules (always follow):
- Every number you state must come from a tool result in this conversation. Call get_student before discussing a student and simulate_support before claiming any intervention effect. Never invent figures, names, or facts not in the tools.
- Risk values are model estimates from historical data (a Portuguese polytechnic, 2008-2019). Say "estimated risk", give the 90% range when it matters, and say so plainly when a student is marked uncertain.
- Simulations show association, not causation. Never promise an outcome.
- Never recommend punitive, automatic or exclusionary actions (suspension, withdrawal, denial of services). Suggest supportive options; the advisor decides.
- Never reason from gender, nationality, marital status or international status. They are not model inputs.
- Students are identified only by ID. Address outreach drafts to "Dear student" unless the advisor gives a name.
- Be concise and practical: short headings, bullets, under 180 words unless asked to draft a message. Plain English for non-technical advisors.

Current screen: view "${S.view}", decision point ${CP().label} (sem key "${S.cp}"), selected student ${S.student}. Review threshold ${(CP().threshold * 100).toFixed(0)}%. Bands: Low < 40%, Medium 40-70%, High > 70%.${toolsOK ? "" : `

Tools are unavailable in this view, so here is the selected student's data: ${JSON.stringify(safeFacts())}`}`;
  }
  const safeFacts = () => { try { return studentFacts(S.student, S.cp); } catch (e) { return null; } };

  let curTrace = null;
  function trace(t) { if (curTrace) { curTrace.push(t); paint(); } }

  function md(src) {             // tiny, escaped markdown: headings, bold, bullets, paragraphs, student links
    const lines = esc(src).split(/\n/); let html = "", inList = false;
    const inline = s => s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\b(S\d{4})\b/g, '<a href="#student" data-cpopen="$1">$1</a>');
    for (const raw of lines) {
      const l = raw.trim();
      if (/^[-*•] /.test(l)) { if (!inList) { html += "<ul>"; inList = true; } html += `<li>${inline(l.slice(2))}</li>`; continue; }
      if (inList) { html += "</ul>"; inList = false; }
      if (!l) continue;
      const h = l.match(/^#{1,4}\s+(.*)/); if (h) { html += `<h4>${inline(h[1])}</h4>`; continue; }
      html += `<p>${inline(l)}</p>`;
    }
    return html + (inList ? "</ul>" : "");
  }
  function chips() {
    const id = S.student;
    if (S.view === "student" || S.view === "whatif") return [`Brief me on ${id}`, `Which support helps ${id} most?`, `Draft a supportive outreach email to ${id}`, `What should I ask ${id} in our meeting?`];
    if (S.view === "triage") return ["Who should I contact first today?", "Which courses need attention?", "Which flagged students is the model unsure about?"];
    return ["Summarise the evidence for our report", "Is the model fair across groups?", "Where does the model make mistakes?"];
  }
  function context() {
    const s = BY_ID[S.student] ? sc(S.student) : null;
    $("cp-context").innerHTML = `Looking at <strong>${esc({ triage: "Cohort triage", student: "Student diagnostic", whatif: "What-If simulator", model: "Model & fairness", feedback: "Advisor feedback", about: "About" }[S.view])}</strong> · ${esc(CP().label)}${s && (S.view === "student" || S.view === "whatif") ? ` · <span class="mono">${S.student}</span> ${pct(s.risk)} ${bandHTML(s.band)}` : ""}`;
    $("cp-chips").innerHTML = chips().map(c => `<button type="button" data-chip="${esc(c)}">${esc(c)}</button>`).join("");
  }
  function paint() {
    const el = $("cp-log");
    if (!log.length) {
      el.innerHTML = `<div class="cp-empty"><p><strong>Hello. I'm your advisor co-pilot.</strong></p><p>I read the same model this dashboard runs. I can brief you on a student, test support options in the simulator, find who to contact first, draft outreach, and explain the evidence. Every figure I quote comes from a tool call you can see.</p>${SAMPLE === null ? `<p class="notice warn small">${WEB ? "The co-pilot isn't connected on this deployment yet. The owner needs to add a GEMINI_API_KEY (or ANTHROPIC_API_KEY) in Vercel." : "The co-pilot needs Claude, which is available when this page is open in claude.ai while you are signed in."}</p>` : ""}</div>`;
      return;
    }
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    el.innerHTML = log.map((m, i) => m.role === "user" ? `<div class="msg user"><div class="bubble">${esc(m.text)}</div></div>` :
      `<div class="msg ai">${m.trace && m.trace.length ? `<div class="trace" aria-label="Tools used">${m.trace.map(t => `<span>${esc(t)}</span>`).join("")}</div>` : ""}
        <div class="bubble">${m.text ? md(m.text) : `<span class="thinking"><i></i><i></i><i></i> ${m.trace && m.trace.length ? "Checking the model…" : "Thinking…"}</span>`}${m.err ? `<p class="small" style="color:var(--high);margin-top:6px">${esc(m.err)}</p>` : ""}</div>
        ${m.done ? `<div class="msg-tools"><span>Was this helpful?</span><button type="button" data-rate="${i}:1" aria-pressed="${m.rated === 1}">Helpful</button><button type="button" data-rate="${i}:0" aria-pressed="${m.rated === 0}">Not helpful</button><button type="button" data-copy="${i}">Copy</button>${m.ratedMsg ? `<span>${esc(m.ratedMsg)}</span>` : ""}</div>` : ""}</div>`).join("");
    if (atBottom || busy) el.scrollTop = el.scrollHeight;
  }
  const ERR = { empty_completion: "The co-pilot checked the model but did not write an answer. Ask again, or try a narrower question.", rate_limited: "Too many co-pilot requests in a short time. Wait a few minutes and ask again.", authentication_error: "The AI provider rejected the API key saved in Vercel. Check GEMINI_API_KEY.", model_not_found: "No AI model is available for this key. Set GEMINI_MODEL in Vercel.", bad_code: "Wrong advisor access code.", not_configured: "The co-pilot isn't configured on this deployment.", too_large: "The conversation is too long. Start a new chat.",  overloaded_error: "The AI service is very busy right now. Wait a few seconds and ask again.", not_granted: "Claude access was declined for this page, so the co-pilot is off for this visit.", sampling_disabled: "Claude is not available for this account.", rate_limited: "Too many requests right now. Wait a moment and ask again.",
    session_expired: "Your claude.ai session expired. Sign in again.", refused: "Claude declined that request. Try rephrasing it.", tools_unavailable: "Tools are unavailable here.", prompt_too_large: "The conversation is too long. Start a new chat." };
  async function ask(q) {
    q = String(q || "").trim(); if (!q || busy) return;
    if (!SAMPLE) { log.push({ role: "user", text: q }, { role: "ai", text: "", err: WEB ? "The co-pilot isn't connected on this deployment yet. The owner needs to add a GEMINI_API_KEY (or ANTHROPIC_API_KEY) in Vercel." : "The co-pilot needs Claude, which is available when this page is open in claude.ai while you are signed in.", done: false }); paint(); return; }
    busy = true; $("cp-send").disabled = true; $("cp-stop").hidden = false;
    log.push({ role: "user", text: q }); const m = { role: "ai", text: "", trace: [], q }; log.push(m); curTrace = m.trace; paint();
    turns.push({ role: "user", content: q });
    ctl = new AbortController();
    try {
      const input = [{ role: "user", content: rules() }, ...turns.slice(-12)];
      const opts = { signal: ctl.signal, modelTier: "quick", onText: ({ text }) => { m.text = text; paint(); } };
      if (toolsOK) opts.tools = TOOLS; else opts.cache = false;
      const res = await SAMPLE(input, opts);
      m.text = res.text; if (res.truncated) m.err = "Answer cut short. Ask for less at a time.";
      turns.push({ role: "assistant", content: res.text });
      m.done = true;
    } catch (e) {
      m.text = (e && e.text) || m.text || "";
      if (e && e.code === "refused") m.text = "";
      if (!e || e.code !== "cancelled") m.err = (ERR[e && e.code] || "The co-pilot could not finish.") + (WEB && e && e.message ? ` Details: ${e.message}` : "");
      if (e && e.code === "cancelled") m.err = "Stopped.";
      if (m.text) { turns.push({ role: "assistant", content: m.text }); m.done = true; } else turns.pop();
      if (e && ["not_granted", "sampling_disabled"].includes(e.code)) SAMPLE = null;
    } finally {
      busy = false; curTrace = null; $("cp-send").disabled = false; $("cp-stop").hidden = true; paint();
    }
  }
  async function rate(i, v) {
    const m = log[i]; if (!m) return; m.rated = v; m.ratedMsg = "Thanks, noted."; paint();
    if (!WEB && (!DB || !S.uid)) { m.ratedMsg = "Rating kept for this visit (sign in to save it)."; paint(); return; }
    try {
      const item = { helpful: !!v, question: m.q.slice(0, 300), tools: (m.trace || []).length, checkpoint: S.cp, view: S.view, advisor: ident.name || undefined };
      const saved = await appendRecord("ratings", item); if (WEB) S.copilotRatings.unshift({ ...item, ...saved });
      m.ratedMsg = WEB && S.storeMode === "local" ? "Thanks, saved in this browser." : "Thanks, saved to the evaluation log.";
    } catch (e) { m.ratedMsg = e && e.code === "bad_code" ? "Enter the advisor access code in a review form first." : "Could not save the rating."; }
    paint();
  }
  function open() { $("copilot").classList.add("open"); $("copilot").setAttribute("aria-hidden", "false"); $("cp-toggle").setAttribute("aria-expanded", "true"); document.body.classList.add("cp-docked"); context(); paint(); setTimeout(() => $("cp-input").focus({ preventScroll: true }), 50); }
  function close() { $("copilot").classList.remove("open"); $("copilot").setAttribute("aria-hidden", "true"); $("cp-toggle").setAttribute("aria-expanded", "false"); document.body.classList.remove("cp-docked"); $("cp-toggle").focus({ preventScroll: true }); }
  async function init() {
    $("cp-toggle").addEventListener("click", () => $("copilot").classList.contains("open") ? close() : open());
    $("cp-close").addEventListener("click", close);
    $("cp-clear").addEventListener("click", () => { if (ctl) ctl.abort(); log.length = 0; turns.length = 0; paint(); });
    $("cp-stop").addEventListener("click", () => ctl && ctl.abort());
    $("cp-form").addEventListener("submit", e => { e.preventDefault(); const v = $("cp-input").value; $("cp-input").value = ""; ask(v); });
    $("cp-input").addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("cp-form").requestSubmit(); } });
    document.addEventListener("keydown", e => { if (e.key === "Escape" && $("copilot").classList.contains("open")) close(); });
    $("copilot").addEventListener("click", e => {
      const c = e.target.closest("[data-chip]"); if (c) { ask(c.dataset.chip); return; }
      const o = e.target.closest("[data-cpopen]"); if (o) { e.preventDefault(); if (BY_ID[o.dataset.cpopen]) { S.student = o.dataset.cpopen; S.changes = {}; go("student"); } return; }
      const r = e.target.closest("[data-rate]"); if (r) { const [i, v] = r.dataset.rate.split(":").map(Number); rate(i, v); return; }
      const cp = e.target.closest("[data-copy]"); if (cp) { const t = log[+cp.dataset.copy].text; navigator.clipboard?.writeText(t).then(() => { cp.textContent = "Copied"; }, () => { cp.textContent = "Select the text to copy"; }); }
    });
    context(); paint();
    try {
      if (WEB) { await initDbPromise; if (WEBCFG.copilot) { SAMPLE = webSample; toolsOK = true; const pv = WEBCFG.provider === "gemini" ? "Google Gemini" : "Claude"; $("cp-note").textContent = `Generated by ${pv} from this page's model outputs. It can be wrong. Check figures against the dashboard; decisions stay with you.`; } else SAMPLE = null; }
      else if (window.claude && claude.use) {
        SAMPLE = await claude.use("sample");
        if (SAMPLE) { const lim = await SAMPLE.limits().catch(() => null); toolsOK = !!(lim && lim.tools); }
      }
    } catch (e) { SAMPLE = null; }
    paint();
  }
  return { init, open, close, ask, refresh: () => { if ($("copilot").classList.contains("open")) context(); } };
})();

const start = location.hash.slice(1);
if (VIEWS[start]) S.view = start;
render(false);
animateEntry();
const initDbPromise = initDb();
CO.init();
