"""Export the trained models so the browser dashboard can run them.

Run after train.py:   python export_web_model.py   -> artifacts/web_model.json

The champion at both checkpoints is a class-balanced Logistic Regression, whose
inference is fully specified by its fitted preprocessing (one-hot categories,
scaler means/scales) and its coefficients. This script exports exactly those
fitted numbers — for the champion and for all 30 bootstrap ensemble members —
plus the SHAP background mean, and then re-computes every held-out prediction
and SHAP value from the exported numbers to prove they match scikit-learn/SHAP.
"""
from __future__ import annotations

import json

import joblib
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression

from retentionflow.features import (ARTIFACTS_DIR, BINARY, CHECKPOINTS, COURSE_NAMES, NOMINAL, SENSITIVE,
                                    WHATIF_LEVERS, all_features, features_for, load_data)
from retentionflow.modelling import explain_rows, make_explainer


def export_pipeline(pipe) -> dict:
    pre, clf = pipe.named_steps["preprocess"], pipe.named_steps["clf"]
    if not isinstance(clf, LogisticRegression):
        raise SystemExit("Champion is not Logistic Regression — the browser export only supports LR.")
    out_names = list(pre.get_feature_names_out())
    ohe = pre.named_transformers_["nominal"]
    nominal = {}
    for col, cats in zip(ohe.feature_names_in_, ohe.categories_):
        mapping = {}
        for c in cats:   # transform each seen category to find its output column (handles 'infrequent')
            row = pd.DataFrame([{k: (c if k == col else ohe.categories_[i][0])
                                 for i, k in enumerate(ohe.feature_names_in_)}])
            vec = ohe.transform(row[ohe.feature_names_in_])[0]
            start = [n for n in out_names].index(ohe.get_feature_names_out()[0])
            block = [j for j, n in enumerate(ohe.get_feature_names_out()) if n.startswith(col + "_")]
            hot = [j for j in block if vec[j] == 1]
            mapping[str(int(c))] = int(start + hot[0]) if hot else -1
        nominal[col] = mapping
    sc = pre.named_transformers_["numeric"]
    numeric = {c: {"col": out_names.index(c), "mean": float(m), "scale": float(s)}
               for c, m, s in zip(sc.feature_names_in_, sc.mean_, sc.scale_)}
    binary = {c: out_names.index(c) for c in BINARY}
    return {"n_out": len(out_names), "nominal": nominal, "numeric": numeric, "binary": binary,
            "coef": [float(v) for v in clf.coef_[0]], "intercept": float(clf.intercept_[0])}


def js_like_transform(m: dict, row: pd.Series) -> np.ndarray:
    x = np.zeros(m["n_out"])
    for col, mp in m["nominal"].items():
        j = mp.get(str(int(row[col])), -1)
        if j >= 0:
            x[j] = 1.0
    for col, s in m["numeric"].items():
        x[s["col"]] = (row[col] - s["mean"]) / s["scale"]
    for col, j in m["binary"].items():
        x[j] = row[col]
    return x


def main():
    df = load_data()
    web = {"checkpoints": {}, "levers": WHATIF_LEVERS, "course_names": {str(k): v for k, v in COURSE_NAMES.items()}}
    test_ids = None
    for cp in CHECKPOINTS:
        b = joblib.load(ARTIFACTS_DIR / cp / "model.joblib")
        bg = joblib.load(ARTIFACTS_DIR / cp / "background.joblib")
        main_m = export_pipeline(b["model"])
        explainer, _ = make_explainer(b["model"], bg)
        # SHAP LinearExplainer: phi_j = coef_j * (x_j - reference_mean_j); export its reference mean
        main_m["bg_mean"] = [float(v) for v in np.ravel(explainer.mean)]
        main_m["expected_value"] = float(np.ravel(explainer.expected_value)[-1])
        members = [export_pipeline(p) for p in b["ensemble"]]
        cohort = json.loads((ARTIFACTS_DIR / cp / "cohort.json").read_text())
        ids = [int(r["student_id"][1:]) for r in cohort]
        test_ids = ids

        # ---- parity check: exported numbers vs scikit-learn / SHAP -------------
        X = df.loc[ids, all_features(cp)]
        p_sk = b["model"].predict_proba(X)[:, 1]
        shap_sk = explain_rows(b["model"], explainer, X)
        max_p, max_s = 0.0, 0.0
        for k, (i, row) in enumerate(X.iterrows()):
            x = js_like_transform(main_m, row)
            z = main_m["intercept"] + float(np.dot(main_m["coef"], x))
            p = 1 / (1 + np.exp(-z))
            max_p = max(max_p, abs(p - p_sk[k]))
            phi = np.array(main_m["coef"]) * (x - np.array(main_m["bg_mean"]))
            for f, v in shap_sk[k].items():
                cols = ([j for j in main_m["nominal"][f].values() if j >= 0] if f in main_m["nominal"]
                        else [main_m["numeric"][f]["col"]] if f in main_m["numeric"] else [main_m["binary"][f]])
                cols = sorted(set(cols))
                max_s = max(max_s, abs(phi[cols].sum() - v))
        print(f"{cp}: max |p_export - p_sklearn| = {max_p:.2e} ; max |shap_export - shap| = {max_s:.2e}")
        assert max_p < 1e-9 and max_s < 1e-6, "parity check failed"

        report = json.loads((ARTIFACTS_DIR / cp / "report.json").read_text())
        web["checkpoints"][cp] = {
            "label": CHECKPOINTS[cp]["label"], "features": all_features(cp),
            "numeric": features_for(cp)["numeric"], "threshold": b["threshold"],
            "model": main_m, "ensemble": members,
            "report": report,
            "fairness": json.loads((ARTIFACTS_DIR / cp / "fairness.json").read_text()),
            "drift_reference": json.loads((ARTIFACTS_DIR / cp / "drift_reference.json").read_text()),
            "python_reference": {f"S{i:04d}": round(float(p), 6) for i, p in zip(ids, p_sk)},
        }

    # held-out cohort rows (raw values; outcome kept for the evaluation view only)
    cols = all_features("sem2") + SENSITIVE + ["Target"]
    rows = []
    for i in test_ids:
        vals = []
        for k in cols:
            v = df.loc[i, k]
            vals.append(v if isinstance(v, str) else (round(float(v), 10) if float(v) != int(v) else int(v)))
        rows.append([f"S{i:04d}"] + vals)
    web["cohort"] = {"columns": ["id"] + cols, "rows": rows}   # columnar to keep the page small
    web["dataset"] = {"name": "Predict Students' Dropout and Academic Success (UCI ID 697)", "licence": "CC BY 4.0",
                      "citation": "Martins, Tolledo, Machado, Baptista & Realinho (2021)", "doi": "10.24432/C5MC89",
                      "rows": int(len(df))}
    out = ARTIFACTS_DIR / "web_model.json"
    out.write_text(json.dumps(web, separators=(",", ":")))
    print(f"[OK] {out} ({out.stat().st_size/1024:.0f} KB)")


if __name__ == "__main__":
    main()
