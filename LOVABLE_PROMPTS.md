# Lovable prompts: RetentionFlow AI dashboard

Paste these into Lovable **one at a time**, in order, and check the preview
after each one. Replace `https://YOUR-API.replit.app` with your deployed API URL.
If Lovable invents data, reply: *"Remove all mock data. Every number must come
from the API."*

---

## Prompt 1: Foundation (paste as the first message of a new project)

```
Build "RetentionFlow AI", a decision-support dashboard for university Student Success
Advisors. It helps them spot students at risk of dropping out, understand why, and
simulate support options. All AI is done by an existing external REST API. The frontend
must NEVER calculate, estimate or mock risk scores. Every number comes from the API.

Tech: React + Vite + TypeScript + Tailwind + shadcn/ui + Recharts + TanStack Query.
Create src/config.ts exporting API_BASE = "https://YOUR-API.replit.app" and a typed
API client in src/lib/api.ts. The API's interactive docs are at API_BASE + "/docs".

Endpoints (all JSON):
- GET  /meta                                 -> checkpoints, risk_bands, whatif_levers, disclaimer, whatif_caveat, dataset
- GET  /cohort?checkpoint=sem1|sem2          -> { count, students: [{student_id, course, age, risk, risk_low, risk_high,
                                                band, flagged, uncertain, sem1_units_approved, sem1_grade,
                                                tuition_up_to_date, scholarship}] }   (sorted by risk desc)
- GET  /cohort/summary?checkpoint=           -> { students, bands, flagged, uncertain,
                                                by_course:[{course, students, mean_risk, high, medium, low, flagged}],
                                                risk_histogram:[{from,to,count}] }
- GET  /students/{id}?checkpoint=            -> { observed:{feature:value}, prediction:{ risk, risk_low, risk_high,
                                                interval_level, band, threshold, flagged, uncertain,
                                                explanation:{ units, base_value, factors:[{feature, value,
                                                contribution, direction}], other_features_total } }, disclaimer }
- POST /whatif {student_id, checkpoint, changes:{feature:number}} -> { current, simulated, risk_change, band_change, caveat }
- GET  /evaluation?checkpoint=               -> model evaluation report
- GET  /fairness?checkpoint=                 -> subgroup fairness audit
- GET  /drift/demo?checkpoint=&scenario=none|financial_shock|older_intake -> drift report
- POST /score-csv?checkpoint= (multipart file) -> batch predictions + drift

Global layout: a left sidebar (Cohort Triage, Student Diagnostic, What-If Simulator,
Model & Fairness, Advisor Feedback, About & Limitations) and a top bar with a
"Decision point" toggle: "End of Semester 1 (early warning)" / "End of Semester 2".
Store the checkpoint in global state and pass it to every API call.

Visual language (apply everywhere):
- OBSERVED data (facts from records) = neutral slate cards with a small "OBSERVED" tag.
- AI PREDICTED output = indigo-accented cards with a small "AI PREDICTION" tag.
- SIMULATED output = amber dashed-border cards with a "SIMULATED" tag.
- Risk bands: Low = green, Medium = amber, High = red. Always show the band TEXT, not colour alone.
- A persistent footer banner showing meta.disclaimer.
- Accessible: WCAG AA contrast, keyboard navigable, aria-labels on charts.
- Loading skeletons and friendly error states ("AI service waking up, retrying…"):
  the API may cold-start, so retry 3 times with backoff and a 60 s timeout.

Build the Cohort Triage page now (home route):
1. KPI tiles: students in cohort, flagged for review, High / Medium / Low counts,
   and "Uncertain predictions" (students whose interval crosses the threshold).
2. A Recharts Treemap of by_course: rectangle size = students, colour = mean_risk
   (green→red). The tooltip shows high/medium/low counts. Clicking a course filters the table.
3. A risk histogram (risk_histogram) with a vertical reference line at the model threshold.
4. A student table: Student ID, Course, Risk (as % with a thin bar showing the
   risk_low–risk_high interval), Band badge, an "Uncertain" badge when uncertain=true,
   Sem 1 units passed, Fees up to date (Yes/No). Sortable, searchable, filterable by
   band, course and "uncertain only". Clicking a row opens Student Diagnostic for that student.
Title: "Cohort Triage". Subtitle: "Ranked by AI-estimated dropout risk. Review, don't automate."
```

## Prompt 2: Student Diagnostic

```
Build the Student Diagnostic page (/student/:id). Use GET /students/{id}?checkpoint=.
Split-screen layout:
LEFT, "Observed record" (OBSERVED style): group observed features into Academic
(curricular units, grades), Financial (Debtor, Tuition fees up to date, Scholarship holder)
and Enrolment (course, age, admission grade, application mode). Show 0/1 flags as Yes/No.
RIGHT, "AI risk estimate" (AI PREDICTION style):
 a) A large risk percentage with the band badge, and a horizontal 0–100% scale showing
    a dot at risk, a shaded band from risk_low to risk_high labelled "90% uncertainty
    range", and a dashed line at the threshold labelled "review threshold".
 b) If uncertain=true, show an amber callout: "The model is not confident about this
    student: the uncertainty range crosses the review threshold. Rely more on your
    own judgement and gather more information."
 c) A SHAP waterfall chart from explanation.factors (horizontal bars): red bars for
    "raises risk", green for "lowers risk", sorted by absolute contribution, with labels like
    "Tuition fees up to date = No". Add an "Other features" bar for other_features_total.
    Caption: "Why the model estimated this risk (SHAP contributions, units: {units}).
    Shows association in historical data, not cause."
 d) A plain-English summary built from the top 3 factors, e.g. "Main risk drivers:
    unpaid tuition fees, outstanding debt. Main protective factor: 7 units passed."
A button "Simulate support options →" opens the What-If page for this student.
Show meta.disclaimer as a visible notice at the top of the right panel.
```

## Prompt 3: What-If Simulator

```
Build the What-If Simulator page (/whatif/:id). Load the student via /students/{id} and the
levers via /meta.whatif_levers (only show levers whose feature exists in the
student's observed data for the current checkpoint). Binary levers = switches;
int/float levers = sliders with min/max from the lever, starting at the student's observed value.
Add a "Run simulation" button that POSTs /whatif with only the changed levers.
Show the results side by side: "Current (AI PREDICTION)" vs "Simulated scenario
(SIMULATED, amber dashed)". Each shows the risk %, band, and the interval scale from the
diagnostic page. Between them show the risk change as an arrow, e.g. "▼ 48.6 points,
Medium → Low". Also show the simulated SHAP waterfall.
Always display the API "caveat" text under the result in an amber notice.
Add a "Reset" button and up to 3 saved scenarios to compare in a small table
(lever changes, simulated risk, band). Never show a simulated value without the SIMULATED tag.
```

## Prompt 4: Advisor review, audit trail and feedback (enable Lovable Cloud)

```
Enable Lovable Cloud (Supabase) with email/password auth. Advisors must sign in to
record actions; browsing stays read-only without login.
Create table advisor_reviews: id uuid pk, created_at timestamptz default now(),
advisor_id uuid references auth.users, student_id text, checkpoint text,
ai_risk numeric, ai_band text, ai_uncertain boolean,
decision text check in ('agree','disagree','override'), override_band text null,
reason text, clarity int 1-5, usefulness int 1-5, trust int 1-5, actionability int 1-5,
planned_action text check in ('none','monitor','academic_support','financial_counselling','wellbeing_referral'),
comment text. RLS: advisors can insert their own rows and read their own rows; all
authenticated users can read aggregate counts via a view advisor_review_stats.
Make the table append-only (no update/delete policies). It is the audit trail.

On the Student Diagnostic page add a "Advisor review" card under the AI panel:
- "Do you agree with the AI's assessment?" Agree / Disagree / Override band.
- If Override: choose a band AND a reason (required).
- Planned action (select). No email or action fires automatically; it is a record only.
- Explanation quality rubric: four 1–5 ratings (Clarity, Usefulness, Trust,
  Actionability) with one-line descriptions.
- Save → insert into advisor_reviews with the AI values snapshotted at the time of review.
Show the student's previous reviews (timestamp, decision, action) below the card.

Build the Advisor Feedback page: agreement rate, override rate (by AI band),
mean rubric scores (bar chart), share of reviews on "uncertain" predictions, a table of
the latest 50 reviews, and an "Export CSV" button. Title: "Human–AI feedback loop".
```

## Prompt 5: Model & Fairness (governance view)

```
Build the Model & Fairness page with four tabs, using /evaluation, /fairness and /drift/demo.
Tab "Performance": a table of test_results for heuristic, logreg, rf and hgb (precision,
recall, F1, macro F1, ROC-AUC) with 95% CIs shown as "0.785 (0.751–0.819)"; highlight
the champion; show comparisons (paired bootstrap difference vs the heuristic baseline
and whether it is significant); a success-criteria checklist from success_criteria
(✓/✗, honest, no hiding of misses); and split + threshold details.
Tab "Calibration & uncertainty": a line chart of calibration (mean_predicted vs observed_rate)
with a diagonal reference; a risk_bands table (band, n, observed dropout rate); and an
uncertainty card: share uncertain, error rate when uncertain vs confident (bar chart).
Tab "Fairness": for each audit attribute, a grouped bar chart of recall and false-positive
rate by group, the disparate impact ratio (red warning if < 0.8), and the attribute's note.
List excluded_from_training as "Sensitive attributes not used by the model".
Tab "Drift monitor": a scenario select (none / financial_shock / older_intake) calling
/drift/demo, a bar chart of PSI per feature with reference lines at 0.10 and 0.25,
status badges, mean predicted risk, and the guidance text. Label shifted scenarios as
SIMULATED. Add a CSV upload (POST /score-csv) that shows the drift table for an uploaded cohort.
```

## Prompt 6: About & Limitations

```
Build the About & Limitations page: purpose and intended users; "Intended use"
(prioritising advisor outreach, understanding risk drivers, exploring support options)
and "Not intended for" (automated suspension, admissions or scholarship decisions,
punitive action, judging individuals by demographics) as two clear lists; data source
(meta.dataset with licence and citation); how the AI works in five plain-English bullets
(prediction, SHAP explanations, uncertainty range, simulation caveat, drift monitoring);
known limitations (single Portuguese institution 2008–2019, associational not causal,
lower recall for younger students — see Fairness tab, no live data feed); and a contact
line for data protection queries.
```
