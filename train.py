"""RetentionFlow AI — reproducible training & evaluation pipeline.

Run:  python train.py
Writes everything the API needs into ./artifacts/ (models, metrics, fairness,
error analysis, drift reference, demo cohort). Takes ~2-4 minutes on a laptop.

Evaluation design (no leakage):
  * stratified 60 / 20 / 20 split -> train / validation / test (random_state=42)
  * hyper-parameters tuned with 5-fold stratified CV on TRAIN only
  * decision threshold and champion model chosen on VALIDATION only
  * TEST is touched once, for the final reported numbers (with 95% bootstrap CIs)
"""
from __future__ import annotations

import json
import time
import warnings

import joblib
import numpy as np
import pandas as pd
from sklearn.calibration import calibration_curve
from sklearn.metrics import (brier_score_loss, confusion_matrix, f1_score, precision_score,
                             recall_score, roc_auc_score, accuracy_score)
from sklearn.model_selection import GridSearchCV, StratifiedKFold, train_test_split

from retentionflow.features import (ARTIFACTS_DIR, BINARY, CHECKPOINTS, COURSE_NAMES, LABEL, NOMINAL,
                                    RANDOM_STATE, SENSITIVE, all_features, features_for, load_data, risk_band)
from retentionflow.modelling import (MODEL_LABELS, build_model, drift_reference, explain_rows,
                                     fit_bootstrap_ensemble, heuristic_rule, make_explainer, predict_interval)

warnings.filterwarnings("ignore")

GRIDS = {
    "logreg": {"clf__C": [0.1, 1.0, 10.0]},
    "rf": {"clf__n_estimators": [300], "clf__max_depth": [8, 14, None], "clf__min_samples_leaf": [1, 3, 5]},
    "hgb": {"clf__learning_rate": [0.03, 0.08], "clf__max_depth": [3, 5], "clf__max_iter": [200, 400]},
}
N_BOOT = 1000


def metrics(y, pred, proba=None) -> dict:
    m = {
        "accuracy": accuracy_score(y, pred),
        "precision": precision_score(y, pred, zero_division=0),      # dropout class
        "recall": recall_score(y, pred),
        "f1": f1_score(y, pred),
        "macro_f1": f1_score(y, pred, average="macro"),
    }
    if proba is not None:
        m["roc_auc"] = roc_auc_score(y, proba)
        m["brier"] = brier_score_loss(y, proba)
    return {k: float(v) for k, v in m.items()}


def bootstrap_ci(y, pred, proba, rng) -> dict:
    y, pred = np.asarray(y), np.asarray(pred)
    keys = ["precision", "recall", "f1", "macro_f1"] + (["roc_auc"] if proba is not None else [])
    samples = {k: [] for k in keys}
    for _ in range(N_BOOT):
        i = rng.integers(0, len(y), len(y))
        if y[i].min() == y[i].max():
            continue
        m = metrics(y[i], pred[i], None if proba is None else np.asarray(proba)[i])
        for k in keys:
            samples[k].append(m[k])
    return {k: [float(np.quantile(v, 0.025)), float(np.quantile(v, 0.975))] for k, v in samples.items()}


def paired_delta(y, pred_a, pred_b, rng) -> dict:
    """95% bootstrap CI of macro-F1(a) - macro-F1(b) on the same resamples."""
    y = np.asarray(y)
    d = []
    for _ in range(N_BOOT):
        i = rng.integers(0, len(y), len(y))
        d.append(f1_score(y[i], pred_a[i], average="macro") - f1_score(y[i], pred_b[i], average="macro"))
    lo, hi = np.quantile(d, [0.025, 0.975])
    return {"mean": float(np.mean(d)), "ci95": [float(lo), float(hi)], "significant": bool(lo > 0 or hi < 0)}


MIN_RECALL = 0.80   # proposal success criterion: missing a dropout is the costly error


def best_threshold(y, proba) -> float:
    """Highest dropout-F1 among thresholds that keep validation recall >= 80%."""
    grid = np.round(np.arange(0.20, 0.81, 0.01), 2)
    ok = [(f1_score(y, (proba >= t).astype(int)), t) for t in grid
          if recall_score(y, (proba >= t).astype(int)) >= MIN_RECALL]
    if ok:
        return float(max(ok)[1])
    scores = [f1_score(y, (proba >= t).astype(int), average="macro") for t in grid]
    return float(grid[int(np.argmax(scores))])


def fairness_table(df_test: pd.DataFrame, y, pred) -> list[dict]:
    d = df_test.copy()
    d["_y"], d["_p"] = np.asarray(y), np.asarray(pred)
    d["Age band"] = pd.cut(d["Age at enrollment"], [0, 20, 25, 200], labels=["<=20", "21-25", ">25"])
    d["Gender label"] = d["Gender"].map({1: "Male", 0: "Female"})
    d["International label"] = d["International"].map({1: "International", 0: "Domestic"})
    d["Scholarship label"] = d["Scholarship holder"].map({1: "Scholarship", 0: "No scholarship"})
    out = []
    for attr in ["Gender label", "International label", "Age band", "Scholarship label"]:
        overall_flag = d["_p"].mean()
        groups = []
        for g, s in d.groupby(attr, observed=True):
            pos, neg = s[s["_y"] == 1], s[s["_y"] == 0]
            groups.append({
                "group": str(g), "n": int(len(s)),
                "actual_dropout_rate": float(s["_y"].mean()),
                "flag_rate": float(s["_p"].mean()),
                "recall": float(pos["_p"].mean()) if len(pos) else None,
                "false_positive_rate": float(neg["_p"].mean()) if len(neg) else None,
                "precision": float(s.loc[s["_p"] == 1, "_y"].mean()) if s["_p"].sum() else None,
            })
        rates = [g["flag_rate"] for g in groups if g["n"] >= 20]
        recalls = [g["recall"] for g in groups if g["recall"] is not None and g["n"] >= 20]
        out.append({
            "attribute": attr.replace(" label", ""),
            "groups": groups,
            "disparate_impact_ratio": float(min(rates) / max(rates)) if rates and max(rates) > 0 else None,
            "equal_opportunity_gap": float(max(recalls) - min(recalls)) if recalls else None,
            "overall_flag_rate": float(overall_flag),
            "note": "DIR < 0.8 (four-fifths rule) warrants review; differences in flag rate can reflect "
                    "genuinely different base rates, so read alongside recall and FPR.",
        })
    return out


def run_checkpoint(cp: str, df: pd.DataFrame, idx_train, idx_val, idx_test) -> dict:
    print(f"\n=== Checkpoint {cp}: {CHECKPOINTS[cp]['label']} ===")
    feats = all_features(cp)
    X, y = df[feats], df[LABEL]
    Xtr, ytr, Xva, yva, Xte, yte = X.loc[idx_train], y.loc[idx_train], X.loc[idx_val], y.loc[idx_val], X.loc[idx_test], y.loc[idx_test]
    rng = np.random.default_rng(RANDOM_STATE)
    cv = StratifiedKFold(5, shuffle=True, random_state=RANDOM_STATE)

    fitted, tuning, results = {}, {}, {}
    for kind, grid in GRIDS.items():
        t0 = time.time()
        gs = GridSearchCV(build_model(kind, cp), grid, scoring="f1_macro", cv=cv, n_jobs=-1)
        gs.fit(Xtr, ytr)
        best = gs.best_estimator_
        thr = best_threshold(yva, best.predict_proba(Xva)[:, 1])
        fitted[kind] = (best, thr)
        val_pred = (best.predict_proba(Xva)[:, 1] >= thr).astype(int)
        tuning[kind] = {"best_params": {k.replace("clf__", ""): v for k, v in gs.best_params_.items()},
                        "cv_macro_f1": float(gs.best_score_), "threshold": thr,
                        "val_macro_f1": f1_score(yva, val_pred, average="macro"), "fit_seconds": round(time.time() - t0, 1)}
        print(f"  {kind:7s} cv={gs.best_score_:.4f} val={tuning[kind]['val_macro_f1']:.4f} thr={thr} {gs.best_params_}")

    champion = max(["rf", "hgb", "logreg"], key=lambda k: tuning[k]["val_macro_f1"])
    print(f"  champion (chosen on validation): {champion}")

    # ---- final held-out test evaluation --------------------------------
    preds = {"heuristic": heuristic_rule(Xte, cp)}
    probas = {"heuristic": None}
    for kind, (m, thr) in fitted.items():
        probas[kind] = m.predict_proba(Xte)[:, 1]
        preds[kind] = (probas[kind] >= thr).astype(int)
    for kind in ["heuristic", "logreg", "rf", "hgb"]:
        results[kind] = {"label": MODEL_LABELS[kind], **metrics(yte, preds[kind], probas[kind]),
                         "ci95": bootstrap_ci(yte, preds[kind], probas[kind], rng),
                         "confusion_matrix": confusion_matrix(yte, preds[kind]).tolist()}
        r = results[kind]
        print(f"  TEST {kind:9s} macroF1={r['macro_f1']:.3f} F1={r['f1']:.3f} P={r['precision']:.3f} R={r['recall']:.3f}")

    comparisons = {
        f"{champion}_vs_logreg": paired_delta(yte, preds[champion], preds["logreg"], rng) if champion != "logreg" else None,
        f"{champion}_vs_heuristic": paired_delta(yte, preds[champion], preds["heuristic"], rng),
    }

    model, thr = fitted[champion]
    p_te = probas[champion]
    yhat = preds[champion]

    # ---- calibration ---------------------------------------------------
    frac_pos, mean_pred = calibration_curve(yte, p_te, n_bins=10, strategy="quantile")
    calibration = [{"mean_predicted": float(a), "observed_rate": float(b)} for a, b in zip(mean_pred, frac_pos)]

    # ---- risk band reliability (does "High" really mean high?) ----------
    bands = pd.Series([risk_band(p) for p in p_te], index=Xte.index)
    band_table = [{"band": b, "n": int((bands == b).sum()),
                   "observed_dropout_rate": float(yte[bands == b].mean()) if (bands == b).any() else None}
                  for b in ["Low", "Medium", "High"]]

    # ---- uncertainty: bootstrap ensemble --------------------------------
    print("  fitting bootstrap ensemble for uncertainty ...")
    ens = fit_bootstrap_ensemble(champion, cp, tuning[champion]["best_params"], Xtr, ytr)
    lo, hi = predict_interval(ens, Xte)
    straddles = (lo < thr) & (hi >= thr)
    err = yhat != yte.to_numpy()
    uncertainty = {
        "method": "90% interval from 30 bootstrap re-fits of the champion model (Efron & Tibshirani, 1993)",
        "mean_interval_width": float(np.mean(hi - lo)),
        "share_uncertain": float(straddles.mean()),
        "error_rate_when_uncertain": float(err[straddles].mean()) if straddles.any() else None,
        "error_rate_when_confident": float(err[~straddles].mean()) if (~straddles).any() else None,
        "definition": "A case is 'uncertain' when its 90% interval crosses the decision threshold.",
    }

    # ---- error analysis -------------------------------------------------
    key = ["Curricular units 1st sem (approved)", "Curricular units 1st sem (grade)", "Tuition fees up to date",
           "Debtor", "Scholarship holder", "Age at enrollment", "Admission grade"]
    tp = Xte[(yte == 1) & (yhat == 1)]
    fn = Xte[(yte == 1) & (yhat == 0)]
    fp = Xte[(yte == 0) & (yhat == 1)]
    errors = {
        "counts": {"true_positive": len(tp), "false_negative": len(fn), "false_positive": len(fp),
                   "true_negative": int(((yte == 0) & (yhat == 0)).sum())},
        "profile_means": {name: {k: float(part[k].mean()) for k in key} for name, part in
                          [("caught_dropouts_TP", tp), ("missed_dropouts_FN", fn), ("false_alarms_FP", fp)]},
        "interpretation": "Missed dropouts (FN) typically look academically 'safe' (units passed and grades near "
                          "the cohort average, fees paid): the 'silent dropout' the system targets is still the "
                          "hardest case. These students need the human review layer, not just the score.",
    }

    # ---- explanations: global importance --------------------------------
    explainer, units = make_explainer(model, Xtr.sample(200, random_state=RANDOM_STATE))
    sample = Xte.sample(min(300, len(Xte)), random_state=RANDOM_STATE)
    sv = pd.DataFrame(explain_rows(model, explainer, sample))
    global_imp = sv.abs().mean().sort_values(ascending=False)
    global_importance = [{"feature": f, "mean_abs_shap": float(v)} for f, v in global_imp.head(15).items()]

    # ---- latency benchmark (predict + interval + SHAP for one student) ---
    times = []
    for i in range(50):
        row = Xte.iloc[[i]]
        t0 = time.perf_counter()
        model.predict_proba(row); predict_interval(ens, row); explain_rows(model, explainer, row)
        times.append((time.perf_counter() - t0) * 1000)
    latency = {"p50_ms": float(np.percentile(times, 50)), "p95_ms": float(np.percentile(times, 95)), "target_ms": 200}

    # ---- fairness ----------------------------------------------------------
    fairness = fairness_table(df.loc[idx_test], yte, yhat)

    # ---- demo cohort (held-out test students only) -----------------------
    cohort = []
    for j, (i, row) in enumerate(df.loc[idx_test].iterrows()):
        cohort.append({
            "student_id": f"S{i:04d}",
            "course_code": int(row["Course"]),
            "course": COURSE_NAMES.get(int(row["Course"]), str(row["Course"])),
            "age": int(row["Age at enrollment"]),
            "risk": float(p_te[j]), "risk_low": float(lo[j]), "risk_high": float(hi[j]),
            "band": risk_band(float(p_te[j])), "flagged": bool(yhat[j]), "uncertain": bool(straddles[j]),
            "observed": {k: (float(row[k]) if isinstance(row[k], (float, np.floating)) else int(row[k]))
                         for k in features_for(cp)["numeric"] + BINARY},
            "actual_outcome": row["Target"],   # for evaluation mode only — hide by default in the UI
        })

    # ---- persist -----------------------------------------------------------
    out = ARTIFACTS_DIR / cp
    out.mkdir(parents=True, exist_ok=True)
    joblib.dump({"model": model, "threshold": thr, "ensemble": ens, "kind": champion}, out / "model.joblib")
    joblib.dump(Xtr.sample(200, random_state=RANDOM_STATE), out / "background.joblib")
    (out / "drift_reference.json").write_text(json.dumps(
        drift_reference(Xtr, features_for(cp)["numeric"], NOMINAL + BINARY)))
    report = {
        "checkpoint": cp, "checkpoint_label": CHECKPOINTS[cp]["label"],
        "split": {"train": len(Xtr), "validation": len(Xva), "test": len(Xte), "random_state": RANDOM_STATE,
                  "design": "stratified 60/20/20; tuning on train CV, threshold+champion on validation, test used once"},
        "features_used": feats, "excluded_sensitive": SENSITIVE,
        "champion": champion, "champion_label": MODEL_LABELS[champion], "threshold": thr, "shap_units": units,
        "tuning": tuning, "test_results": results, "comparisons": comparisons,
        "calibration": calibration, "risk_bands": band_table, "uncertainty": uncertainty,
        "errors": errors, "global_importance": global_importance, "latency": latency,
        "success_criteria": {
            "dropout_f1_gt_0.82": results[champion]["f1"] > 0.82,
            "precision_gt_0.78": results[champion]["precision"] > 0.78,
            "recall_gt_0.80": results[champion]["recall"] > 0.80,
            "latency_p95_lt_200ms": latency["p95_ms"] < 200,
        },
    }
    (out / "report.json").write_text(json.dumps(report, indent=2, default=float))
    (out / "fairness.json").write_text(json.dumps(fairness, indent=2))
    (out / "cohort.json").write_text(json.dumps(cohort))
    print(f"  latency p95={latency['p95_ms']:.0f} ms | uncertain={uncertainty['share_uncertain']:.1%} "
          f"err(uncertain)={uncertainty['error_rate_when_uncertain']} err(confident)={uncertainty['error_rate_when_confident']:.3f}")
    return report


def main():
    df = load_data()
    idx = df.index
    idx_train, idx_tmp = train_test_split(idx, test_size=0.40, stratify=df[LABEL], random_state=RANDOM_STATE)
    idx_val, idx_test = train_test_split(idx_tmp, test_size=0.50, stratify=df.loc[idx_tmp, LABEL], random_state=RANDOM_STATE)
    ARTIFACTS_DIR.mkdir(exist_ok=True)
    summary = {cp: run_checkpoint(cp, df, idx_train, idx_val, idx_test)["test_results"] for cp in CHECKPOINTS}
    (ARTIFACTS_DIR / "summary.json").write_text(json.dumps(summary, indent=2))
    print("\n[OK] artifacts written to", ARTIFACTS_DIR)


if __name__ == "__main__":
    main()
