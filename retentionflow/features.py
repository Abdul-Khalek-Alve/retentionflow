"""Data loading and feature definitions for RetentionFlow AI.

Dataset: UCI "Predict Students' Dropout and Academic Success" (ID 697),
Martins et al. (2021), CC BY 4.0. https://doi.org/10.24432/C5MC89

Two decision points ("checkpoints") are supported so advisors can choose the
forecast horizon:
  * sem1 — end of Semester 1: only enrolment + 1st-semester data (the
           early-warning point committed to in the proposal; no 2nd-semester
           columns, so there is no temporal leakage).
  * sem2 — end of Semester 2: adds 2nd-semester academic records.

Sensitive attributes (gender, nationality, marital status, international
status) are EXCLUDED from training and kept only for the fairness audit.
"""
from __future__ import annotations

from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
DATA_PATH = ROOT / "data" / "dataset.csv"
ARTIFACTS_DIR = ROOT / "artifacts"
RANDOM_STATE = 42

TARGET = "Target"
LABEL = "Dropout"

# --- Feature groups ---------------------------------------------------------
NOMINAL = [
    "Application mode",
    "Course",
    "Previous qualification",
    "Mother's qualification",
    "Father's qualification",
    "Mother's occupation",
    "Father's occupation",
]
NUMERIC_ENROLMENT = [
    "Application order",
    "Previous qualification (grade)",
    "Admission grade",
    "Age at enrollment",
    "Unemployment rate",
    "Inflation rate",
    "GDP",
]
BINARY = [
    "Daytime/evening attendance",
    "Displaced",
    "Educational special needs",
    "Debtor",
    "Tuition fees up to date",
    "Scholarship holder",
]
SEM1 = [
    "Curricular units 1st sem (credited)",
    "Curricular units 1st sem (enrolled)",
    "Curricular units 1st sem (evaluations)",
    "Curricular units 1st sem (approved)",
    "Curricular units 1st sem (grade)",
    "Curricular units 1st sem (without evaluations)",
]
SEM2 = [c.replace("1st sem", "2nd sem") for c in SEM1]

# Excluded from model inputs; used only for subgroup fairness auditing.
SENSITIVE = ["Gender", "Nacionality", "Marital status", "International"]

CHECKPOINTS = {
    "sem1": {"label": "End of Semester 1 (early warning)", "numeric": NUMERIC_ENROLMENT + SEM1},
    "sem2": {"label": "End of Semester 2", "numeric": NUMERIC_ENROLMENT + SEM1 + SEM2},
}

# Features an advisor may change in the What-If simulator (actionable levers).
WHATIF_LEVERS = {
    "Tuition fees up to date": {"type": "binary", "label": "Tuition fees up to date (e.g. fee plan agreed)"},
    "Debtor": {"type": "binary", "label": "Outstanding debt to the university"},
    "Scholarship holder": {"type": "binary", "label": "Holds a scholarship / emergency grant"},
    "Curricular units 1st sem (approved)": {"type": "int", "min": 0, "max": 26, "label": "Sem 1 units passed"},
    "Curricular units 1st sem (grade)": {"type": "float", "min": 0, "max": 20, "label": "Sem 1 average grade (/20)"},
    "Curricular units 1st sem (evaluations)": {"type": "int", "min": 0, "max": 45, "label": "Sem 1 assessments attempted"},
    "Curricular units 2nd sem (approved)": {"type": "int", "min": 0, "max": 20, "label": "Sem 2 units passed"},
    "Curricular units 2nd sem (grade)": {"type": "float", "min": 0, "max": 20, "label": "Sem 2 average grade (/20)"},
    "Curricular units 2nd sem (evaluations)": {"type": "int", "min": 0, "max": 33, "label": "Sem 2 assessments attempted"},
}

# Course codes from the UCI variable documentation.
COURSE_NAMES = {
    33: "Biofuel Production Technologies",
    171: "Animation and Multimedia Design",
    8014: "Social Service (evening)",
    9003: "Agronomy",
    9070: "Communication Design",
    9085: "Veterinary Nursing",
    9119: "Informatics Engineering",
    9130: "Equinculture",
    9147: "Management",
    9238: "Social Service",
    9254: "Tourism",
    9500: "Nursing",
    9556: "Oral Hygiene",
    9670: "Advertising and Marketing Management",
    9773: "Journalism and Communication",
    9853: "Basic Education",
    9991: "Management (evening)",
}

RISK_BANDS = [(0.40, "Low"), (0.70, "Medium"), (1.01, "High")]


def features_for(checkpoint: str) -> dict[str, list[str]]:
    cp = CHECKPOINTS[checkpoint]
    return {"nominal": NOMINAL, "numeric": cp["numeric"], "binary": BINARY}


def all_features(checkpoint: str) -> list[str]:
    f = features_for(checkpoint)
    return f["nominal"] + f["numeric"] + f["binary"]


def risk_band(p: float) -> str:
    for cut, name in RISK_BANDS:
        if p < cut:
            return name
    return "High"


def load_data(path: Path | str = DATA_PATH) -> pd.DataFrame:
    """Load the official UCI export (semicolon-delimited) and add the binary label."""
    df = pd.read_csv(path, sep=";")
    df.columns = [c.strip().replace("\t", "") for c in df.columns]
    df[LABEL] = (df[TARGET] == "Dropout").astype(int)
    return df
