"""Build the dashboard.
   web/retentionflow.html  -> body-only page published as the Claude artifact
   docs/index.html + docs/api/  -> standalone site for Vercel / GitHub Pages (Root Directory: docs)
Run from the repository root or anywhere:  python web/build.py"""
import pathlib, shutil
here = pathlib.Path(__file__).resolve().parent
root = here.parent
model = next(p for p in [root / "artifacts/web_model.json", root.parent / "retentionflow-api/artifacts/web_model.json"] if p.exists())
tpl = (here / "template.html").read_text(encoding="utf-8")
page = (tpl.replace("__MODEL_JSON__", model.read_text(encoding="utf-8").replace("</", "<\\/"))
           .replace("__ENGINE_JS__", (here / "engine.js").read_text(encoding="utf-8"))
           .replace("__APP_JS__", (here / "app.js").read_text(encoding="utf-8")))
(here / "retentionflow.html").write_text(page, encoding="utf-8")
head = ('<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
        '<meta name="description" content="RetentionFlow AI: early-warning decision support for student success advisors (ICT605, Murdoch University).">'
        '<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>')
i = page.index("<style>")
docs = root / "docs"; docs.mkdir(exist_ok=True)
(docs / "index.html").write_text(head + page[:i] + "</head><body>" + page[i:] + "</body></html>", encoding="utf-8")
if (docs / "api").exists(): shutil.rmtree(docs / "api")
shutil.copytree(here / "api", docs / "api")
print(f"built web/retentionflow.html and docs/index.html ({len(page)//1024} KB) + docs/api/")
