"""Model building, explanation, uncertainty and drift helpers."""
from __future__ import annotations

import numpy as np
import pandas as pd
import shap
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import HistGradientBoostingClassifier, RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler

from .features import RANDOM_STATE, features_for


# --------------------------------------------------------------------------
# Baseline 0: the rule-based heuristic from the proposal (Section 4.1)
# --------------------------------------------------------------------------
def heuristic_rule(X: pd.DataFrame, checkpoint: str) -> np.ndarray:
    """Flag at-risk if debtor OR fees not up to date OR >2 failed units."""
    failed = X["Curricular units 1st sem (enrolled)"] - X["Curricular units 1st sem (approved)"]
    if checkpoint == "sem2":
        failed = failed + (X["Curricular units 2nd sem (enrolled)"] - X["Curricular units 2nd sem (approved)"])
    return ((X["Debtor"] == 1) | (X["Tuition fees up to date"] == 0) | (failed > 2)).astype(int).to_numpy()


# --------------------------------------------------------------------------
# ML pipelines
# --------------------------------------------------------------------------
def build_preprocessor(checkpoint: str) -> ColumnTransformer:
    f = features_for(checkpoint)
    return ColumnTransformer(
        [
            ("nominal", OneHotEncoder(handle_unknown="ignore", min_frequency=10, sparse_output=False), f["nominal"]),
            ("numeric", StandardScaler(), f["numeric"]),
            ("binary", "passthrough", f["binary"]),
        ],
        verbose_feature_names_out=False,
    )


def build_model(kind: str, checkpoint: str, **params) -> Pipeline:
    if kind == "logreg":
        clf = LogisticRegression(max_iter=3000, class_weight="balanced", C=params.get("C", 1.0))
    elif kind == "rf":
        clf = RandomForestClassifier(
            n_estimators=params.get("n_estimators", 400),
            max_depth=params.get("max_depth"),
            min_samples_leaf=params.get("min_samples_leaf", 3),
            class_weight="balanced_subsample",
            random_state=RANDOM_STATE,
            n_jobs=-1,
        )
    elif kind == "hgb":
        clf = HistGradientBoostingClassifier(
            learning_rate=params.get("learning_rate", 0.05),
            max_depth=params.get("max_depth", 4),
            max_iter=params.get("max_iter", 300),
            class_weight="balanced",
            random_state=RANDOM_STATE,
        )
    else:
        raise ValueError(kind)
    return Pipeline([("preprocess", build_preprocessor(checkpoint)), ("clf", clf)])


MODEL_LABELS = {
    "heuristic": "Rule-based heuristic (baseline 0)",
    "logreg": "Logistic Regression, class-balanced (baseline 1)",
    "rf": "Random Forest (proposed candidate)",
    "hgb": "Gradient Boosting (refinement candidate)",
}


# --------------------------------------------------------------------------
# Explanations: SHAP values aggregated back to the original feature names
# --------------------------------------------------------------------------
def make_explainer(pipe: Pipeline, background: pd.DataFrame):
    pre, clf = pipe.named_steps["preprocess"], pipe.named_steps["clf"]
    bg = pre.transform(background)
    if isinstance(clf, LogisticRegression):
        return shap.LinearExplainer(clf, bg), "log-odds"
    return shap.TreeExplainer(clf), ("probability" if isinstance(clf, RandomForestClassifier) else "log-odds")


def _origin_map(pipe: Pipeline) -> list[str]:
    """Map each transformed column back to the raw feature it came from."""
    pre = pipe.named_steps["preprocess"]
    raw = set(pre.feature_names_in_)
    nominal = sorted(pre.named_transformers_["nominal"].feature_names_in_, key=len, reverse=True)
    out = []
    for name in pre.get_feature_names_out():
        if name in raw:
            out.append(name)
        else:
            out.append(next(c for c in nominal if name.startswith(c + "_")))
    return out


def explain_rows(pipe: Pipeline, explainer, X: pd.DataFrame) -> list[dict[str, float]]:
    Xt = pipe.named_steps["preprocess"].transform(X)
    sv = explainer.shap_values(Xt)
    if isinstance(sv, list):           # older shap: list per class
        sv = sv[1]
    sv = np.asarray(sv)
    if sv.ndim == 3:                   # (n, features, classes)
        sv = sv[:, :, 1]
    origins = _origin_map(pipe)
    if len(origins) != sv.shape[1]:
        origins = list(pipe.named_steps["preprocess"].get_feature_names_out())
    rows = []
    for r in sv:
        agg: dict[str, float] = {}
        for feat, v in zip(origins, r):
            agg[feat] = agg.get(feat, 0.0) + float(v)
        rows.append(agg)
    return rows


# --------------------------------------------------------------------------
# Per-student uncertainty
# --------------------------------------------------------------------------
def fit_bootstrap_ensemble(kind: str, checkpoint: str, params: dict, X: pd.DataFrame, y: pd.Series,
                           n_members: int = 30) -> list[Pipeline]:
    """Refit the model on bootstrap resamples -> distribution of predicted risk."""
    rng = np.random.default_rng(RANDOM_STATE)
    small = dict(params)
    if kind == "rf":
        small["n_estimators"] = 60     # keep inference latency low
    members = []
    for _ in range(n_members):
        idx = rng.integers(0, len(X), len(X))
        m = build_model(kind, checkpoint, **small)
        if kind == "rf":
            m.named_steps["clf"].set_params(n_jobs=1)
        m.fit(X.iloc[idx], y.iloc[idx])
        members.append(m)
    return members


def predict_interval(members: list[Pipeline], X: pd.DataFrame, level: float = 0.90) -> tuple[np.ndarray, np.ndarray]:
    P = np.column_stack([m.predict_proba(X)[:, 1] for m in members])
    lo = np.quantile(P, (1 - level) / 2, axis=1)
    hi = np.quantile(P, 1 - (1 - level) / 2, axis=1)
    return lo, hi


# --------------------------------------------------------------------------
# Feature drift (Population Stability Index)
# --------------------------------------------------------------------------
def drift_reference(X: pd.DataFrame, numeric: list[str], categorical: list[str]) -> dict:
    ref = {"numeric": {}, "categorical": {}}
    for c in numeric:
        edges = np.unique(np.quantile(X[c], np.linspace(0, 1, 11)))
        edges[0], edges[-1] = -np.inf, np.inf
        counts, _ = np.histogram(X[c], bins=edges)
        ref["numeric"][c] = {"edges": [float(e) if np.isfinite(e) else None for e in edges],
                             "props": (counts / counts.sum()).tolist(),
                             "mean": float(X[c].mean())}
    for c in categorical:
        vc = X[c].value_counts(normalize=True)
        ref["categorical"][c] = {str(k): float(v) for k, v in vc.items()}
    return ref


def _psi(expected: np.ndarray, actual: np.ndarray) -> float:
    e = np.clip(np.asarray(expected, float), 1e-4, None)
    a = np.clip(np.asarray(actual, float), 1e-4, None)
    return float(np.sum((a - e) * np.log(a / e)))


def compute_drift(ref: dict, X: pd.DataFrame) -> list[dict]:
    out = []
    for c, r in ref["numeric"].items():
        if c not in X:
            continue
        edges = np.array([(-np.inf if i == 0 else np.inf) if e is None else e for i, e in enumerate(r["edges"])])
        counts, _ = np.histogram(X[c], bins=edges)
        psi = _psi(r["props"], counts / max(counts.sum(), 1))
        out.append({"feature": c, "type": "numeric", "psi": round(psi, 4),
                    "reference_mean": round(r["mean"], 3), "current_mean": round(float(X[c].mean()), 3)})
    for c, r in ref["categorical"].items():
        if c not in X:
            continue
        cur = X[c].astype(str).value_counts(normalize=True)
        keys = set(r) | set(cur.index)
        psi = _psi([r.get(k, 0) for k in keys], [cur.get(k, 0) for k in keys])
        out.append({"feature": c, "type": "categorical", "psi": round(psi, 4)})
    for d in out:
        d["status"] = "major drift" if d["psi"] >= 0.25 else "moderate drift" if d["psi"] >= 0.10 else "stable"
    return sorted(out, key=lambda d: -d["psi"])
