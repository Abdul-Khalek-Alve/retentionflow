"""RetentionFlow AI — inference & evaluation API (FastAPI).

Start locally:   uvicorn app:app --reload --port 8000
Interactive docs: http://localhost:8000/docs

The API is read-only and stateless: it holds no personal data beyond the
public UCI dataset. Advisor actions / audit logs live in the frontend's
database (Lovable Cloud / Supabase), not here.
"""
from __future__ import annotations

import io
import json
import subprocess
import sys
import time
from functools import lru_cache
from typing import Any, Literal

import joblib
import numpy as np
import pandas as pd
from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field

from retentionflow.features import (ARTIFACTS_DIR, CHECKPOINTS, COURSE_NAMES, RISK_BANDS, WHATIF_LEVERS,
                                    all_features, load_data, risk_band)
from retentionflow.modelling import compute_drift, explain_rows, make_explainer, predict_interval

DISCLAIMER = ("AI predictions are probabilistic and reflect statistical patterns in historical data. "
              "This score is decision-support only and must never be used to automatically suspend, "
              "terminate or deny academic services. The advisor's judgement is the decision of record.")
WHATIF_CAVEAT = ("Simulated scenario. The model learned associations, not causes: a lower simulated risk shows "
                 "how similar historical students fared, not a guaranteed effect of the intervention.")

Checkpoint = Literal["sem1", "sem2"]

app = FastAPI(title="RetentionFlow AI API", version="1.0.0",
              description="Dropout-risk prediction, explanation, uncertainty, what-if simulation, "
                          "fairness audit and drift monitoring for student-success advisors.")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


# --------------------------------------------------------------------------
# Loading
# --------------------------------------------------------------------------
def _ensure_artifacts():
    if not (ARTIFACTS_DIR / "sem2" / "model.joblib").exists():
        print("[startup] artifacts missing -> running train.py (one-off, ~2 min)")
        subprocess.run([sys.executable, "train.py"], check=True, cwd=ARTIFACTS_DIR.parent)


@lru_cache(maxsize=None)
def bundle(cp: str) -> dict[str, Any]:
    _ensure_artifacts()
    d = ARTIFACTS_DIR / cp
    try:
        m = joblib.load(d / "model.joblib")
    except Exception as exc:  # e.g. artifacts saved with a different scikit-learn version
        print(f"[startup] could not load artifacts ({exc!r}) -> retraining")
        subprocess.run([sys.executable, "train.py"], check=True, cwd=ARTIFACTS_DIR.parent)
        m = joblib.load(d / "model.joblib")
    explainer, units = make_explainer(m["model"], joblib.load(d / "background.joblib"))
    ev = explainer.expected_value
    base = float(np.ravel(ev)[-1])
    return {**m, "explainer": explainer, "units": units, "base_value": base,
            "report": json.loads((d / "report.json").read_text()),
            "fairness": json.loads((d / "fairness.json").read_text()),
            "cohort": json.loads((d / "cohort.json").read_text()),
            "drift_ref": json.loads((d / "drift_reference.json").read_text())}


@lru_cache(maxsize=1)
def dataset() -> pd.DataFrame:
    return load_data()


@app.on_event("startup")
def _warm():
    for cp in CHECKPOINTS:
        bundle(cp)
    dataset()


# --------------------------------------------------------------------------
# Core scoring
# --------------------------------------------------------------------------
def _score(cp: str, X: pd.DataFrame, explain: bool = True, top_k: int = 8) -> list[dict]:
    b = bundle(cp)
    X = X[all_features(cp)]
    p = b["model"].predict_proba(X)[:, 1]
    lo, hi = predict_interval(b["ensemble"], X)
    shap_rows = explain_rows(b["model"], b["explainer"], X) if explain else [None] * len(X)
    out = []
    for i in range(len(X)):
        thr = b["threshold"]
        r = {"risk": round(float(p[i]), 4), "risk_low": round(float(lo[i]), 4), "risk_high": round(float(hi[i]), 4),
             "interval_level": 0.90, "band": risk_band(float(p[i])), "threshold": thr,
             "flagged": bool(p[i] >= thr), "uncertain": bool(lo[i] < thr <= hi[i])}
        if explain:
            contrib = sorted(shap_rows[i].items(), key=lambda kv: -abs(kv[1]))
            r["explanation"] = {
                "method": "SHAP (Lundberg & Lee, 2017)", "units": b["units"], "base_value": round(b["base_value"], 4),
                "factors": [{"feature": f, "value": _val(X.iloc[i][f], f), "contribution": round(v, 4),
                             "direction": "raises risk" if v > 0 else "lowers risk"} for f, v in contrib[:top_k]],
                "other_features_total": round(sum(v for _, v in contrib[top_k:]), 4),
            }
        out.append(r)
    return out


def _val(v, f):
    if f == "Course":
        return COURSE_NAMES.get(int(v), str(v))
    return float(v) if isinstance(v, (float, np.floating)) else int(v)


def _student_row(student_id: str) -> pd.DataFrame:
    try:
        i = int(student_id.lstrip("Ss"))
        return dataset().loc[[i]]
    except (ValueError, KeyError):
        raise HTTPException(404, f"Unknown student_id {student_id}")


# --------------------------------------------------------------------------
# Endpoints
# --------------------------------------------------------------------------
@app.get("/", include_in_schema=False)
def root():
    """Send visitors (and markers) straight to the interactive API docs."""
    return RedirectResponse("/docs")


@app.get("/health")
def health():
    return {"status": "ok", "checkpoints": list(CHECKPOINTS)}


@app.get("/meta")
def meta():
    return {
        "checkpoints": {k: v["label"] for k, v in CHECKPOINTS.items()},
        "risk_bands": {"Low": "< 0.40", "Medium": "0.40 – 0.70", "High": "> 0.70"},
        "whatif_levers": WHATIF_LEVERS,
        "models": {cp: {"champion": bundle(cp)["report"]["champion_label"], "threshold": bundle(cp)["threshold"]}
                   for cp in CHECKPOINTS},
        "disclaimer": DISCLAIMER, "whatif_caveat": WHATIF_CAVEAT,
        "dataset": {"name": "Predict Students' Dropout and Academic Success (UCI ID 697)",
                    "licence": "CC BY 4.0", "citation": "Martins et al. (2021)", "doi": "10.24432/C5MC89",
                    "demo_cohort": "885 held-out test students (never used for training or tuning)"},
    }


@app.get("/cohort")
def cohort(checkpoint: Checkpoint = "sem1", band: str | None = None, course: str | None = None,
           uncertain_only: bool = False, reveal_outcome: bool = Query(False, description="Evaluation mode only")):
    rows = bundle(checkpoint)["cohort"]
    if band:
        rows = [r for r in rows if r["band"].lower() == band.lower()]
    if course:
        rows = [r for r in rows if r["course"].lower() == course.lower()]
    if uncertain_only:
        rows = [r for r in rows if r["uncertain"]]
    rows = sorted(rows, key=lambda r: -r["risk"])
    keep = ["student_id", "course", "age", "risk", "risk_low", "risk_high", "band", "flagged", "uncertain"]
    out = []
    for r in rows:
        o = {k: r[k] for k in keep}
        o["sem1_units_approved"] = r["observed"]["Curricular units 1st sem (approved)"]
        o["sem1_grade"] = r["observed"]["Curricular units 1st sem (grade)"]
        o["tuition_up_to_date"] = r["observed"]["Tuition fees up to date"]
        o["scholarship"] = r["observed"]["Scholarship holder"]
        if reveal_outcome:
            o["actual_outcome"] = r["actual_outcome"]
        out.append(o)
    return {"checkpoint": checkpoint, "count": len(out), "students": out}


@app.get("/cohort/summary")
def cohort_summary(checkpoint: Checkpoint = "sem1"):
    rows = bundle(checkpoint)["cohort"]
    df = pd.DataFrame([{k: r[k] for k in ["course", "band", "risk", "flagged", "uncertain"]} for r in rows])
    by_course = []
    for c, s in df.groupby("course"):
        by_course.append({"course": c, "students": int(len(s)), "mean_risk": round(float(s["risk"].mean()), 4),
                          "high": int((s["band"] == "High").sum()), "medium": int((s["band"] == "Medium").sum()),
                          "low": int((s["band"] == "Low").sum()), "flagged": int(s["flagged"].sum())})
    hist, edges = np.histogram(df["risk"], bins=20, range=(0, 1))
    return {"checkpoint": checkpoint, "students": len(df),
            "bands": df["band"].value_counts().to_dict(), "flagged": int(df["flagged"].sum()),
            "uncertain": int(df["uncertain"].sum()),
            "by_course": sorted(by_course, key=lambda d: -d["mean_risk"]),
            "risk_histogram": [{"from": round(float(edges[i]), 2), "to": round(float(edges[i + 1]), 2),
                                "count": int(hist[i])} for i in range(len(hist))]}


@app.get("/students/{student_id}")
def student(student_id: str, checkpoint: Checkpoint = "sem1"):
    t0 = time.perf_counter()
    row = _student_row(student_id)
    res = _score(checkpoint, row)[0]
    observed = {f: _val(row.iloc[0][f], f) for f in all_features(checkpoint)}
    return {"student_id": student_id, "checkpoint": checkpoint, "observed": observed, "prediction": res,
            "disclaimer": DISCLAIMER, "latency_ms": round((time.perf_counter() - t0) * 1000, 1)}


class WhatIfRequest(BaseModel):
    student_id: str
    checkpoint: Checkpoint = "sem1"
    changes: dict[str, float] = Field(..., examples=[{"Tuition fees up to date": 1, "Scholarship holder": 1}])


@app.post("/whatif")
def whatif(req: WhatIfRequest):
    bad = [k for k in req.changes if k not in WHATIF_LEVERS or k not in all_features(req.checkpoint)]
    if bad:
        raise HTTPException(400, f"Not an adjustable lever at this checkpoint: {bad}")
    row = _student_row(req.student_id)
    scen = row.copy()
    for k, v in req.changes.items():
        lever = WHATIF_LEVERS[k]
        v = min(max(v, lever.get("min", 0)), lever.get("max", 1))
        scen[k] = v
    before, after = _score(req.checkpoint, pd.concat([row, scen]))
    return {"student_id": req.student_id, "checkpoint": req.checkpoint, "changes": req.changes,
            "current": before, "simulated": after,
            "risk_change": round(after["risk"] - before["risk"], 4),
            "band_change": f"{before['band']} → {after['band']}", "caveat": WHATIF_CAVEAT}


class PredictRequest(BaseModel):
    checkpoint: Checkpoint = "sem1"
    features: dict[str, float]


@app.post("/predict")
def predict(req: PredictRequest):
    missing = [f for f in all_features(req.checkpoint) if f not in req.features]
    if missing:
        raise HTTPException(400, f"Missing features: {missing}")
    return {"prediction": _score(req.checkpoint, pd.DataFrame([req.features]))[0], "disclaimer": DISCLAIMER}


def _read_csv(raw: bytes) -> pd.DataFrame:
    text = raw.decode("utf-8-sig")
    df = pd.read_csv(io.StringIO(text), sep=";" if text.count(";") > text.count(",") else ",")
    df.columns = [c.strip().replace("\t", "") for c in df.columns]
    return df


@app.post("/score-csv")
async def score_csv(checkpoint: Checkpoint = "sem1", file: UploadFile = File(...)):
    """Batch-score an uploaded cohort CSV (same columns as the UCI export) and check it for drift."""
    df = _read_csv(await file.read())
    missing = [f for f in all_features(checkpoint) if f not in df]
    if missing:
        raise HTTPException(400, f"CSV is missing columns: {missing}")
    if len(df) > 5000:
        raise HTTPException(413, "Max 5000 rows per upload")
    scored = _score(checkpoint, df, explain=False)
    return {"rows": len(df), "predictions": scored,
            "drift": compute_drift(bundle(checkpoint)["drift_ref"], df), "disclaimer": DISCLAIMER}


@app.get("/evaluation")
def evaluation(checkpoint: Checkpoint = "sem1"):
    return bundle(checkpoint)["report"]


@app.get("/fairness")
def fairness(checkpoint: Checkpoint = "sem1"):
    return {"checkpoint": checkpoint, "excluded_from_training": bundle(checkpoint)["report"]["excluded_sensitive"],
            "audit": bundle(checkpoint)["fairness"]}


@app.get("/drift/demo")
def drift_demo(checkpoint: Checkpoint = "sem1",
               scenario: Literal["none", "financial_shock", "older_intake"] = "none"):
    """Compare the held-out cohort (or a simulated shifted intake) against the training distribution."""
    ids = [int(r["student_id"][1:]) for r in bundle(checkpoint)["cohort"]]
    X = dataset().loc[ids].copy()
    rng = np.random.default_rng(7)
    if scenario == "financial_shock":       # 25% more students fall behind on fees / become debtors
        hit = rng.random(len(X)) < 0.25
        X.loc[hit, "Tuition fees up to date"] = 0
        X.loc[hit, "Debtor"] = 1
    elif scenario == "older_intake":        # mature-age intake shifts age +6 years
        X["Age at enrollment"] = X["Age at enrollment"] + 6
    drift = compute_drift(bundle(checkpoint)["drift_ref"], X)
    p = bundle(checkpoint)["model"].predict_proba(X[all_features(checkpoint)])[:, 1]
    return {"checkpoint": checkpoint, "scenario": scenario,
            "simulated": scenario != "none",
            "mean_predicted_risk": round(float(p.mean()), 4),
            "features_drifting": [d for d in drift if d["status"] != "stable"],
            "all_features": drift,
            "guidance": "PSI >= 0.25 = major drift: re-validate the model before trusting new scores; "
                        "0.10–0.25 = monitor."}
