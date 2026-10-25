/* RetentionFlow AI — in-browser inference engine.
   Re-implements the fitted scikit-learn pipeline exactly: one-hot + standard scaling +
   logistic regression, a 30-member bootstrap ensemble for the 90% range, and
   exact linear SHAP (phi_j = coef_j * (x_j - reference_mean_j)). */
const RF = (() => {
  const transform = (m, row) => {
    const x = new Float64Array(m.n_out);
    for (const col in m.nominal) { const j = m.nominal[col][String(Math.trunc(row[col]))]; if (j !== undefined && j >= 0) x[j] = 1; }
    for (const col in m.numeric) { const s = m.numeric[col]; x[s.col] = (row[col] - s.mean) / s.scale; }
    for (const col in m.binary) x[m.binary[col]] = row[col];
    return x;
  };
  const logit = (m, x) => { let z = m.intercept; for (let j = 0; j < x.length; j++) z += m.coef[j] * x[j]; return z; };
  const sigmoid = z => 1 / (1 + Math.exp(-z));
  const prob = (m, row) => sigmoid(logit(m, transform(m, row)));
  const quantile = (sorted, q) => {           // numpy default ("linear") interpolation
    const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  };
  const interval = (members, row, level = 0.9) => {
    const ps = members.map(mm => prob(mm, row)).sort((a, b) => a - b);
    return [quantile(ps, (1 - level) / 2), quantile(ps, 1 - (1 - level) / 2)];
  };
  const blocks = m => {                       // output columns owned by each raw feature
    if (m._blocks) return m._blocks;
    const b = {};
    for (const col in m.nominal) b[col] = [...new Set(Object.values(m.nominal[col]).filter(j => j >= 0))];
    for (const col in m.numeric) b[col] = [m.numeric[col].col];
    for (const col in m.binary) b[col] = [m.binary[col]];
    return (m._blocks = b);
  };
  const shap = (m, row) => {
    const x = transform(m, row), out = {}, b = blocks(m);
    for (const f in b) { let s = 0; for (const j of b[f]) s += m.coef[j] * (x[j] - m.bg_mean[j]); out[f] = s; }
    return out;
  };
  const band = p => (p < 0.4 ? "Low" : p < 0.7 ? "Medium" : "High");
  const score = (cp, row) => {
    const p = prob(cp.model, row), [lo, hi] = interval(cp.ensemble, row), t = cp.threshold;
    return { risk: p, lo, hi, band: band(p), flagged: p >= t, uncertain: lo < t && t <= hi };
  };
  // ---- drift: Population Stability Index, same binning as numpy.histogram ----
  const psi = (e, a) => { let s = 0; for (let i = 0; i < e.length; i++) { const ee = Math.max(e[i], 1e-4), aa = Math.max(a[i], 1e-4); s += (aa - ee) * Math.log(aa / ee); } return s; };
  const drift = (ref, rows) => {
    const out = [];
    for (const c in ref.numeric) {
      const r = ref.numeric[c], edges = r.edges.map((e, i) => e === null ? (i === 0 ? -Infinity : Infinity) : e);
      const counts = new Array(edges.length - 1).fill(0); let sum = 0, n = 0;
      for (const row of rows) {
        const v = row[c]; if (v === undefined || v === null || Number.isNaN(v)) continue;
        let k = edges.length - 2;
        for (let i = 0; i < edges.length - 1; i++) { if (v >= edges[i] && v < edges[i + 1]) { k = i; break; } }
        counts[k]++; sum += v; n++;
      }
      const tot = Math.max(n, 1);
      out.push({ feature: c, type: "numeric", psi: psi(r.props, counts.map(x => x / tot)), ref_mean: r.mean, cur_mean: sum / tot });
    }
    for (const c in ref.categorical) {
      const r = ref.categorical[c], cur = {}; let n = 0;
      for (const row of rows) { if (row[c] === undefined) continue; const k = String(Math.trunc(row[c])); cur[k] = (cur[k] || 0) + 1; n++; }
      const keys = [...new Set([...Object.keys(r), ...Object.keys(cur)])];
      out.push({ feature: c, type: "categorical", psi: psi(keys.map(k => r[k] || 0), keys.map(k => (cur[k] || 0) / Math.max(n, 1))) });
    }
    for (const d of out) d.status = d.psi >= 0.25 ? "major" : d.psi >= 0.1 ? "moderate" : "stable";
    return out.sort((a, b) => b.psi - a.psi);
  };
  const rng = seed => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  return { transform, prob, interval, shap, band, score, drift, rng };
})();
if (typeof module !== "undefined") module.exports = RF;
