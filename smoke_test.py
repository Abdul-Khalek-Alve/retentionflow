"""End-to-end smoke test. Local:  python smoke_test.py
Against a deployment:            python smoke_test.py https://your-app.replit.app
"""
import sys
import time

import httpx

BASE = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else None

if BASE:
    c = httpx.Client(base_url=BASE, timeout=60)
else:
    from fastapi.testclient import TestClient
    import app
    c = TestClient(app.app).__enter__()

def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    return cond

ok = True
ok &= check("health", c.get("/health").json()["status"] == "ok")
co = c.get("/cohort", params={"checkpoint": "sem1"}).json()
ok &= check("cohort has 885 held-out students", co["count"] == 885)
ok &= check("outcomes hidden by default", "actual_outcome" not in co["students"][0])
t0 = time.perf_counter()
st = c.get("/students/S1529", params={"checkpoint": "sem1"}).json()
ms = (time.perf_counter() - t0) * 1000
p = st["prediction"]
ok &= check("risk inside its 90% interval", p["risk_low"] <= p["risk"] <= p["risk_high"])
ok &= check("SHAP factors returned", len(p["explanation"]["factors"]) == 8)
ok &= check(f"student endpoint latency {ms:.0f} ms", ms < 1500)
w = c.post("/whatif", json={"student_id": "S1529", "changes": {"Tuition fees up to date": 1}}).json()
ok &= check("what-if lowers risk when fees are paid", w["risk_change"] < 0)
ok &= check("sensitive attribute cannot be a lever",
            c.post("/whatif", json={"student_id": "S1529", "changes": {"Gender": 0}}).status_code == 400)
d = c.get("/drift/demo", params={"scenario": "financial_shock"}).json()
ok &= check("drift detected under financial shock", any(x["feature"] == "Tuition fees up to date" for x in d["features_drifting"]))
ok &= check("no drift on the held-out cohort", c.get("/drift/demo").json()["features_drifting"] == [])
ev = c.get("/evaluation", params={"checkpoint": "sem2"}).json()
ok &= check("evaluation report available", "test_results" in ev and "uncertainty" in ev)
print("\nALL PASSED" if ok else "\nSOME CHECKS FAILED")
sys.exit(0 if ok else 1)
