#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import shutil
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

REPO = Path.cwd().resolve()
APP = REPO / "tools/dashboard/app.py"
VENV_PYTHON = REPO / "tools/dashboard/.venv/bin/python3"
INVENTORY = REPO / "docs/document-inventory.json"
SERVICE = "openclaw-dashboard.service"
STAMP = datetime.now().strftime("%Y%m%d-%H%M%S")
BACKUP = APP.with_name(f"{APP.name}.before-documentation-center-{STAMP}")
ROUTE_MARKER = "# DOCUMENTATION CENTER ROUTES"
NAV_LINK = '  <a href="/documentation">Foundational Documentation</a>'

DOCUMENTATION_CODE = r'''
# =============================================================================
# DOCUMENTATION CENTER ROUTES
# =============================================================================

DOCUMENTATION_ROOT = Path(__file__).resolve().parents[2] / "docs"
DOCUMENTATION_INVENTORY = DOCUMENTATION_ROOT / "document-inventory.json"

DOCUMENTATION_FEATURED_PATHS = (
    "foundation/FOUNDATIONAL_DOCUMENTS.md",
    "foundation/PROJECT_OVERVIEW.md",
    "foundation/SOUL.md",
    "foundation/AI_GOVERNANCE_MANIFEST.md",
    "foundation/RESTORE_MANIFEST.md",
    "foundation/OPERATIONS_RUNBOOK.md",
    "architecture/RANCHBOT_ARCHITECTURE.md",
    "architecture/DASHBOARD_REPORT.md",
    "architecture/PROJECT_CONTEXT.md",
    "architecture/TOOLS.md",
)


def documentation_load_inventory():
    fallback = {"schema_version": 1, "generated_at": "Unknown", "documents": []}
    if not DOCUMENTATION_INVENTORY.is_file():
        return fallback
    try:
        data = json.loads(DOCUMENTATION_INVENTORY.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return fallback

    documents = data.get("documents", [])
    if not isinstance(documents, list):
        documents = []

    safe_documents = []
    for item in documents:
        if not isinstance(item, dict):
            continue
        relative_path = str(
            item.get("relative_path") or item.get("path") or item.get("file") or ""
        ).strip()
        if relative_path.startswith("docs/"):
            relative_path = relative_path[5:]
        if not relative_path:
            continue
        safe_documents.append({
            "relative_path": relative_path,
            "title": str(item.get("title") or Path(relative_path).stem.replace("_", " ").replace("-", " ").title()),
            "category": str(item.get("category") or "Uncategorized"),
            "status": str(item.get("status") or "Unknown"),
            "version": str(item.get("version") or "Unknown"),
            "owner": str(item.get("owner") or "Unknown"),
            "last_reviewed": str(item.get("last_reviewed") or "Unknown"),
            "metadata_present": bool(item.get("metadata_present", False)),
            "size_bytes": int(item.get("size_bytes") or 0),
        })
    data["documents"] = safe_documents
    return data


def documentation_resolve_path(relative_path):
    requested = Path(str(relative_path))
    if requested.is_absolute():
        raise ValueError("Absolute paths are not allowed.")
    if requested.suffix.lower() not in {".md", ".mdx"}:
        raise ValueError("Only Markdown documents may be viewed.")
    root = DOCUMENTATION_ROOT.resolve()
    candidate = (root / requested).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise ValueError("Document is outside the documentation library.") from exc
    if not candidate.is_file():
        raise FileNotFoundError("Document does not exist.")
    return candidate


def documentation_human_size(size_bytes):
    value = float(max(0, size_bytes))
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024 or unit == "GB":
            return f"{int(value)} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024
    return f"{value:.1f} GB"


def documentation_shell(title, body):
    safe_title = html.escape(str(title))
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{safe_title}</title>
<style>
:root {{color-scheme:dark;--page:#0b1220;--panel:#111b2d;--soft:#172338;--line:#2d3c55;--text:#edf3fb;--muted:#aebdd0;--accent:#7cc4ff;--success:#55d48a;}}
*{{box-sizing:border-box}} body{{margin:0;background:var(--page);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.55}}
.page{{max-width:1440px;margin:0 auto;padding:26px}} a{{color:var(--accent)}} nav{{display:flex;flex-wrap:wrap;gap:10px;margin:18px 0 24px}}
nav a{{background:var(--soft);border:1px solid var(--line);border-radius:8px;color:var(--text);padding:9px 13px;text-decoration:none}}
.toolbar,.health,.document-card,.document-viewer,.empty-state{{background:var(--panel);border:1px solid var(--line);border-radius:12px}}
.toolbar{{display:grid;grid-template-columns:minmax(260px,1fr) minmax(180px,280px);gap:12px;margin-bottom:18px;padding:16px}}
input,select,button{{background:var(--page);border:1px solid var(--line);border-radius:8px;color:var(--text);font:inherit;padding:11px}} input,select{{width:100%}}
.summary-grid{{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));margin:18px 0}} .health{{padding:16px}}
.health-number{{font-size:1.8rem;font-weight:700;margin-top:5px}} .healthy{{color:var(--success)}} .muted{{color:var(--muted)}}
.section-heading{{border-bottom:1px solid var(--line);margin-top:30px;padding-bottom:8px}} .document-grid{{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(280px,1fr))}}
.document-card{{display:flex;flex-direction:column;min-height:190px;padding:17px}} .document-card h3{{margin:0 0 8px}} .document-card p{{margin:4px 0}} .open-link{{margin-top:auto!important;padding-top:14px}}
.badge{{background:var(--soft);border:1px solid var(--line);border-radius:999px;display:inline-block;font-size:.84rem;margin:3px 4px 3px 0;padding:3px 9px}}
.document-viewer{{margin-top:20px;overflow-wrap:anywhere;padding:clamp(18px,3vw,38px)}} .document-viewer pre,.document-viewer code{{background:#080d16}}
.document-viewer pre{{border:1px solid var(--line);border-radius:8px;overflow-x:auto;padding:15px}} .document-viewer code{{border-radius:4px;padding:2px 5px}} .document-viewer pre code{{padding:0}}
.document-viewer table{{border-collapse:collapse;display:block;overflow-x:auto;width:100%}} .document-viewer th,.document-viewer td{{border:1px solid var(--line);padding:8px 11px;text-align:left}}
.document-viewer blockquote{{border-left:4px solid var(--accent);color:var(--muted);margin-left:0;padding-left:16px}} .breadcrumb{{color:var(--muted);margin:10px 0 18px}}
.empty-state{{color:var(--muted);padding:26px;text-align:center}} @media(max-width:700px){{.page{{padding:16px}}.toolbar{{grid-template-columns:1fr}}}}
</style></head><body><div class="page"><h1>📚 {safe_title}</h1>
<nav><a href="/">Overview</a><a href="/ranchbrain">RanchBrain</a><a href="/ranchbrain/review">Review Pending Notes</a><a href="/backup-recovery">Backup &amp; Recovery Center</a><a href="/documentation">Foundational Documentation</a></nav>
{body}</div></body></html>"""


@app.route("/documentation")
def documentation_center():
    inventory = documentation_load_inventory()
    documents = inventory.get("documents", [])
    search_term = str(request.args.get("q") or "").strip()
    selected_category = str(request.args.get("category") or "").strip()
    categories = sorted({str(item.get("category") or "Uncategorized") for item in documents}, key=str.casefold)
    filtered = list(documents)
    if selected_category:
        filtered = [item for item in filtered if str(item.get("category", "")).casefold() == selected_category.casefold()]
    if search_term:
        needle = search_term.casefold()
        filtered = [item for item in filtered if needle in " ".join([
            str(item.get("title") or ""), str(item.get("relative_path") or ""),
            str(item.get("category") or ""), str(item.get("owner") or ""), str(item.get("status") or "")
        ]).casefold()]
    filtered.sort(key=lambda item: (
        0 if item.get("relative_path") in DOCUMENTATION_FEATURED_PATHS else 1,
        str(item.get("category") or "").casefold(), str(item.get("title") or "").casefold()))

    foundational_count = sum(1 for item in documents if str(item.get("relative_path") or "").startswith("foundation/"))
    architecture_count = sum(1 for item in documents if str(item.get("relative_path") or "").startswith("architecture/"))
    missing_metadata = sum(1 for item in documents if not item.get("metadata_present"))

    options = ['<option value="">All categories</option>']
    for category in categories:
        selected = " selected" if category.casefold() == selected_category.casefold() else ""
        options.append(f'<option value="{html.escape(category, quote=True)}"{selected}>{html.escape(category)}</option>')

    grouped = {}
    for item in filtered:
        grouped.setdefault(str(item.get("category") or "Uncategorized"), []).append(item)

    sections = []
    for category in sorted(grouped, key=str.casefold):
        cards = []
        for item in grouped[category]:
            relative_path = str(item["relative_path"])
            path_url = quote(relative_path, safe="/")
            cards.append(f"""<article class="document-card"><h3>{html.escape(str(item['title']))}</h3>
<p class="muted">{html.escape(relative_path)}</p><div><span class="badge">{html.escape(str(item['status']))}</span><span class="badge">Version {html.escape(str(item['version']))}</span></div>
<p><b>Owner:</b> {html.escape(str(item['owner']))}</p><p><b>Reviewed:</b> {html.escape(str(item['last_reviewed']))}</p><p><b>Size:</b> {html.escape(documentation_human_size(item['size_bytes']))}</p>
<p class="open-link"><a href="/documentation/view/{path_url}">Open document →</a></p></article>""")
        sections.append(f'<section><h2 class="section-heading">{html.escape(category)} ({len(cards)})</h2><div class="document-grid">{"".join(cards)}</div></section>')
    if not sections:
        sections.append('<div class="empty-state">No documentation matched your search.</div>')

    body = f"""<p class="muted">Browse OpenClaw documentation in a read-only browser interface.</p>
<div class="summary-grid"><div class="health"><div class="muted">Documentation health</div><div class="health-number healthy">Healthy</div></div>
<div class="health"><div class="muted">Documents indexed</div><div class="health-number">{len(documents)}</div></div>
<div class="health"><div class="muted">Foundation</div><div class="health-number">{foundational_count}</div></div>
<div class="health"><div class="muted">Architecture</div><div class="health-number">{architecture_count}</div></div>
<div class="health"><div class="muted">Without metadata</div><div class="health-number">{missing_metadata}</div></div>
<div class="health"><div class="muted">Current results</div><div class="health-number">{len(filtered)}</div></div></div>
<form method="GET" action="/documentation" class="toolbar"><div><label for="documentation-search"><b>Search documentation</b></label>
<input id="documentation-search" name="q" type="search" value="{html.escape(search_term, quote=True)}" placeholder="Search title, category, path, owner, or status"></div>
<div><label for="documentation-category"><b>Category</b></label><select id="documentation-category" name="category">{"".join(options)}</select></div>
<div><button type="submit">Search Documentation</button><a href="/documentation" style="display:inline-block;margin-left:10px;">Clear</a></div></form>{"".join(sections)}"""
    return documentation_shell("OpenClaw Documentation Center", body)


@app.route("/documentation/view/<path:doc_path>")
def documentation_view(doc_path):
    try:
        source_path = documentation_resolve_path(doc_path)
    except FileNotFoundError:
        abort(404)
    except ValueError:
        abort(400)
    relative_path = source_path.relative_to(DOCUMENTATION_ROOT.resolve())
    try:
        source_text = source_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        abort(500)
    rendered = markdown.markdown(source_text, extensions=["fenced_code", "tables", "toc", "sane_lists"], output_format="html5")
    inventory = documentation_load_inventory()
    metadata = next((item for item in inventory.get("documents", []) if item.get("relative_path") == str(relative_path)), {})
    title = str(metadata.get("title") or source_path.stem.replace("_", " ").title())
    body = f"""<p class="breadcrumb"><a href="/documentation">Documentation Center</a>&nbsp;→&nbsp;{html.escape(str(relative_path))}</p>
<div class="summary-grid"><div class="health"><div class="muted">Category</div><div>{html.escape(str(metadata.get('category','Unknown')))}</div></div>
<div class="health"><div class="muted">Version</div><div>{html.escape(str(metadata.get('version','Unknown')))}</div></div>
<div class="health"><div class="muted">Status</div><div>{html.escape(str(metadata.get('status','Unknown')))}</div></div>
<div class="health"><div class="muted">Last reviewed</div><div>{html.escape(str(metadata.get('last_reviewed','Unknown')))}</div></div></div>
<article class="document-viewer">{rendered}</article>"""
    return documentation_shell(title, body)
'''


def run(command: list[str], check: bool = True) -> subprocess.CompletedProcess:
    print("+", " ".join(command))
    return subprocess.run(command, cwd=REPO, text=True, check=check)


def ensure_environment() -> None:
    if REPO.name != "openclaw":
        raise RuntimeError("Run this script from the OpenClaw repository root.")
    for path in (APP, VENV_PYTHON, INVENTORY):
        if not path.exists():
            raise RuntimeError(f"Required path is missing: {path}")


def ensure_markdown() -> None:
    check = subprocess.run([str(VENV_PYTHON), "-c", "import markdown"], cwd=REPO, check=False)
    if check.returncode == 0:
        print("Markdown package is already installed.")
    else:
        run([str(VENV_PYTHON), "-m", "pip", "install", "Markdown>=3.6,<4"])


def add_import(text: str, import_line: str) -> str:
    """Add an import only within the module's top-level import section."""
    if import_line.strip() in {
        line.strip()
        for line in text.splitlines()
        if line == line.lstrip()
    }:
        return text

    lines = text.splitlines(keepends=True)
    insertion_index = 0
    import_section_started = False

    for index, line in enumerate(lines):
        stripped = line.strip()

        if not stripped:
            if import_section_started:
                insertion_index = index
            continue

        is_top_level = line == line.lstrip()
        is_import = (
            is_top_level
            and (
                stripped.startswith("import ")
                or stripped.startswith("from ")
            )
        )

        if is_import:
            import_section_started = True
            insertion_index = index + 1
            continue

        if import_section_started:
            break

        if stripped.startswith("#!") or stripped.startswith("#"):
            insertion_index = index + 1
            continue

        break

    lines.insert(insertion_index, import_line)
    return "".join(lines)


def patch_app() -> None:
    shutil.copy2(APP, BACKUP)
    print(f"Backup created: {BACKUP}")
    text = APP.read_text(encoding="utf-8")

    if ROUTE_MARKER not in text:
        anchor = "# BACKUP & RECOVERY CENTER"
        if anchor not in text:
            raise RuntimeError("Could not locate Backup & Recovery Center anchor.")
        text = text.replace(anchor, DOCUMENTATION_CODE + "\n\n" + anchor, 1)

    review_link = '  <a href="/ranchbrain/review">Review Pending Notes</a>'
    if NAV_LINK not in text:
        if review_link not in text:
            raise RuntimeError("Could not locate dashboard navigation blocks.")
        text = text.replace(review_link, review_link + "\n" + NAV_LINK)

    for line in ("import html\n", "import json\n", "import markdown\n", "from urllib.parse import quote\n"):
        text = add_import(text, line)

    flask_lines = [line for line in text.splitlines() if line.startswith("from flask import ")]
    if not flask_lines:
        raise RuntimeError("Could not locate Flask import statement.")
    flask_line = flask_lines[0]
    names = [name.strip() for name in flask_line.removeprefix("from flask import ").split(",")]
    for required in ("abort", "request"):
        if required not in names:
            names.append(required)
    text = text.replace(flask_line, "from flask import " + ", ".join(names), 1)
    APP.write_text(text, encoding="utf-8")


def load_dashboard():
    spec = importlib.util.spec_from_file_location("openclaw_dashboard_test", APP)
    if spec is None or spec.loader is None:
        raise RuntimeError("Unable to load dashboard module.")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_app() -> None:
    run([str(VENV_PYTHON), "-m", "py_compile", str(APP)])
    module = load_dashboard()
    client = module.app.test_client()
    for path, expected in [
        ("/documentation", 200),
        ("/documentation?q=Restore", 200),
        ("/documentation/view/foundation/RESTORE_MANIFEST.md", 200),
    ]:
        response = client.get(path)
        print(f"Test {path}: {response.status_code}")
        if response.status_code != expected:
            raise RuntimeError(f"Route test failed: {path}")
    response = client.get("/documentation/view/../../etc/passwd")
    if response.status_code not in (400, 404):
        raise RuntimeError("Path traversal protection test failed.")


def restart_and_test() -> None:
    run(["systemctl", "--user", "restart", SERVICE])
    time.sleep(3)
    run(["systemctl", "--user", "is-active", "--quiet", SERVICE])
    run(["curl", "--fail", "--silent", "--show-error", "http://127.0.0.1:5051/documentation"])


def rollback() -> None:
    if BACKUP.exists():
        print(f"Rolling back from {BACKUP}")
        shutil.copy2(BACKUP, APP)
        subprocess.run(["systemctl", "--user", "restart", SERVICE], cwd=REPO, check=False)


def main() -> int:
    print("===== OPENCLAW DOCUMENTATION CENTER INSTALLER =====")
    print(f"Repository: {REPO}")
    try:
        ensure_environment()
        ensure_markdown()
        patch_app()
        test_app()
        restart_and_test()
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        rollback()
        return 1
    print("\nINSTALLATION COMPLETE")
    print("Open: http://intelmini.local:5051/documentation")
    print(f"Backup: {BACKUP}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
