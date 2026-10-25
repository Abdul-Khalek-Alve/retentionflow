"""Generate report-ready evaluation figures from artifacts/*/report.json.

Run after train.py:  python make_figures.py   -> artifacts/figures/*.png
"""
import json

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

from retentionflow.features import ARTIFACTS_DIR, CHECKPOINTS

FIG = ARTIFACTS_DIR / "figures"
FIG.mkdir(parents=True, exist_ok=True)
plt.rcParams.update({"font.size": 10, "axes.spines.top": False, "axes.spines.right": False})
ORDER = ["heuristic", "logreg", "rf", "hgb"]
NAMES = {"heuristic": "Heuristic rule", "logreg": "Logistic Reg.", "rf": "Random Forest", "hgb": "Grad. Boosting"}

for cp in CHECKPOINTS:
    r = json.loads((ARTIFACTS_DIR / cp / "report.json").read_text())
    fair = json.loads((ARTIFACTS_DIR / cp / "fairness.json").read_text())
    label = r["checkpoint_label"]

    # 1. Model comparison with 95% bootstrap CIs
    fig, ax = plt.subplots(figsize=(8, 4))
    metrics = ["precision", "recall", "f1", "macro_f1"]
    w = 0.2
    for j, k in enumerate(ORDER):
        res = r["test_results"][k]
        vals = [res[m] for m in metrics]
        err = [[v - res["ci95"][m][0] for v, m in zip(vals, metrics)], [res["ci95"][m][1] - v for v, m in zip(vals, metrics)]]
        ax.bar([i + (j - 1.5) * w for i in range(len(metrics))], vals, w, yerr=err, capsize=3,
               label=NAMES[k] + (" (champion)" if k == r["champion"] else ""))
    ax.axhline(0.80, ls="--", lw=1, color="grey")
    ax.set_xticks(range(len(metrics)), ["Precision", "Recall", "Dropout F1", "Macro F1"])
    ax.set_ylim(0.5, 1.08); ax.set_ylabel("Held-out test score")
    ax.set_title(f"Baseline vs candidates — {label}\n(error bars = 95% bootstrap CI, n={r['split']['test']})")
    ax.legend(fontsize=8, ncol=4, loc="upper center", frameon=False)
    fig.tight_layout(); fig.savefig(FIG / f"{cp}_model_comparison.png", dpi=160); plt.close(fig)

    # 2. Calibration
    fig, ax = plt.subplots(figsize=(4.5, 4.5))
    xs = [c["mean_predicted"] for c in r["calibration"]]; ys = [c["observed_rate"] for c in r["calibration"]]
    ax.plot([0, 1], [0, 1], ls="--", color="grey", lw=1, label="Perfect calibration")
    ax.plot(xs, ys, marker="o", label=NAMES[r["champion"]])
    ax.set_xlabel("Predicted dropout probability"); ax.set_ylabel("Observed dropout rate")
    ax.set_title(f"Calibration — {cp}  (Brier={r['test_results'][r['champion']]['brier']:.3f})")
    ax.legend(fontsize=8); fig.tight_layout(); fig.savefig(FIG / f"{cp}_calibration.png", dpi=160); plt.close(fig)

    # 3. Uncertainty vs error
    u = r["uncertainty"]
    fig, ax = plt.subplots(figsize=(5, 3.5))
    ax.bar(["Confident cases", "Uncertain cases"], [u["error_rate_when_confident"], u["error_rate_when_uncertain"]],
           color=["#4c78a8", "#e45756"])
    ax.set_ylabel("Error rate on test set")
    ax.set_title(f"Uncertainty flags the risky calls — {cp}\n({u['share_uncertain']:.0%} of students marked uncertain)")
    fig.tight_layout(); fig.savefig(FIG / f"{cp}_uncertainty.png", dpi=160); plt.close(fig)

    # 4. Fairness: recall by subgroup
    fig, axes = plt.subplots(1, len(fair), figsize=(12, 3.4), sharey=True)
    for ax, a in zip(axes, fair):
        g = [x for x in a["groups"] if x["recall"] is not None]
        ax.bar([x["group"] for x in g], [x["recall"] for x in g], color="#72b7b2")
        ax.set_title(f"{a['attribute']}\nDIR={a['disparate_impact_ratio']:.2f}", fontsize=9)
        ax.tick_params(axis="x", labelsize=8, rotation=20)
    axes[0].set_ylabel("Recall (dropouts caught)")
    fig.suptitle(f"Subgroup recall — {label}", fontsize=10)
    fig.tight_layout(); fig.savefig(FIG / f"{cp}_fairness.png", dpi=160); plt.close(fig)

    # 5. Global SHAP importance
    gi = r["global_importance"][:10][::-1]
    fig, ax = plt.subplots(figsize=(7, 4))
    ax.barh([g["feature"] for g in gi], [g["mean_abs_shap"] for g in gi], color="#54a24b")
    ax.set_xlabel(f"Mean |SHAP| ({r['shap_units']})"); ax.set_title(f"Top drivers of predicted risk — {cp}")
    fig.tight_layout(); fig.savefig(FIG / f"{cp}_global_shap.png", dpi=160); plt.close(fig)

print("[OK] figures written to", FIG)
