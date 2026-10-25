# RetentionFlow AI — AI Service (ICT605 Group Project, NONAME 06)

The Python service that holds all of RetentionFlow AI's machine learning. The
Lovable dashboard calls this API; it never calculates risk itself.

| What | Where |
|---|---|
| Data loading, feature groups, sensitive-attribute exclusion | `retentionflow/features.py` |
| Models, SHAP, bootstrap uncertainty, drift (PSI) | `retentionflow/modelling.py` |
| Reproducible training + evaluation | `train.py` → `artifacts/` |
| Report figures | `make_figures.py` → `artifacts/figures/` |
| REST API | `app.py` (FastAPI, docs at `/docs`) |
| End-to-end check | `smoke_test.py` |
| Deployment | `.replit` (Replit) or `Dockerfile` (Render / Hugging Face Spaces) |

## 1. Run it locally (≈5 minutes)

```bash
python -m venv .venv && source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python train.py          # trains + evaluates both checkpoints (~1–3 min)
python make_figures.py   # optional: report figures
uvicorn app:app --reload --port 8000
python smoke_test.py     # in a second terminal: should print ALL PASSED
```
Open http://localhost:8000/docs to try every endpoint.

## 2. Data

UCI *Predict Students' Dropout and Academic Success* (ID 697), Martins et al.
(2021), CC BY 4.0, https://doi.org/10.24432/C5MC89. Bundled at
`data/dataset.csv` (4,424 rows, 37 columns, no missing values). There are no API keys
or credentials anywhere.

## 3. Method (what is actually implemented)

* **Target**: Dropout (1) vs Graduate/Enrolled (0), a 32.1% positive rate.
* **Two decision points**: `sem1` uses enrolment + first-semester data only
  (early warning, no temporal leakage); `sem2` adds second-semester data.
* **Sensitive attributes excluded from training**: gender, nationality, marital status,
  international status. They are kept only for the fairness audit.
* **Split**: stratified 60/20/20 train/validation/test, `random_state=42`.
  Hyper-parameters are tuned by 5-fold CV on train. The decision threshold and
  champion are chosen on validation, and the test set is used once.
* **Threshold policy**: the highest F1 that keeps validation recall ≥ 80% (missing
  a dropout is the costly error).
* **Models compared**: the proposal's rule-based heuristic, class-balanced Logistic
  Regression, Random Forest (the proposed candidate) and Gradient Boosting (the
  refinement promised in the proposal). The champion is whichever wins on
  validation: **Logistic Regression at both checkpoints**.
* **Explanations**: per-student SHAP (LinearExplainer for LR, TreeExplainer for
  trees). One-hot columns are summed back to the original feature.
* **Uncertainty**: a 90% interval from 30 bootstrap re-fits. A student is
  "uncertain" when the interval crosses the threshold. Test metrics carry 95%
  bootstrap CIs, plus a paired bootstrap test against the baseline.
* **Monitoring**: Population Stability Index drift against the training
  distribution (`/drift/demo`, `/score-csv`).

## 4. Held-out test results (n = 885)

| Checkpoint | Model | Precision | Recall | Dropout F1 | Macro F1 |
|---|---|---|---|---|---|
| sem1 | Heuristic rule | 0.726 | 0.736 | 0.731 | 0.801 |
| sem1 | **Logistic Regression** | **0.780** | **0.789** | **0.785** | **0.841** |
| sem2 | Heuristic rule | 0.636 | 0.887 | 0.741 | 0.790 |
| sem2 | **Logistic Regression** | **0.864** | **0.806** | **0.834** | **0.880** |

The full results, including Random Forest and Gradient Boosting, CIs, calibration,
fairness and error analysis, are in `artifacts/<checkpoint>/report.json`. Exact
numbers can shift slightly between scikit-learn versions.

## 5. API endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | liveness |
| GET | `/meta` | checkpoints, risk bands, What-If levers, disclaimer text |
| GET | `/cohort?checkpoint=sem1` | ranked held-out students (outcomes hidden unless `reveal_outcome=true`) |
| GET | `/cohort/summary` | per-course risk (treemap), band counts, risk histogram |
| GET | `/students/{id}` | observed data + risk + 90% interval + SHAP factors |
| POST | `/whatif` | current vs simulated risk for advisor-chosen levers |
| POST | `/predict` | score one arbitrary feature vector |
| POST | `/score-csv` | batch-score an uploaded cohort CSV + drift report |
| GET | `/evaluation` | full evaluation report |
| GET | `/fairness` | subgroup recall / FPR / disparate impact |
| GET | `/drift/demo?scenario=financial_shock` | drift monitor demo (simulated shifted intake) |

## 6. Deploy

**Replit**: import this folder (or its GitHub repo), press **Run**, then **Deploy →
Autoscale** (or Reserved VM). The build step installs the requirements and runs
`train.py`. Copy the `https://….replit.app` URL into the Lovable app's
`src/config.ts`.

**Fallback (Docker)**: Render → New Web Service → this repo → Docker, or a
Hugging Face Space with the Docker SDK (set the port to 8000).

## 7. Acknowledgements

scikit-learn, SHAP, FastAPI, pandas, NumPy, Matplotlib. Generative AI assistance
(Claude) was used to help draft code and documentation. All results were
produced by running the code above.
