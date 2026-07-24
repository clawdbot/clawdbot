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
PYTHON = REPO / "tools/dashboard/.venv/bin/python3"
SERVICE = "openclaw-dashboard.service"

STAMP = datetime.now().strftime("%Y%m%d-%H%M%S")
BACKUP = APP.with_name(f"{APP.name}.before-pdf-library-{STAMP}")

MARKER = "# PDF DOCUMENT LIBRARY ROUTES"
ANCHOR = "# BACKUP & RECOVERY CENTER"

LIBRARY_CODE = r'''
# =============================================================================
# PDF DOCUMENT LIBRARY ROUTES
# =============================================================================

def pdf_library_load_metadata():
    records = []

    if not PDF_UPLOAD_LOG.is_file():
        return records

    try:
        with PDF_UPLOAD_LOG.open("r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()

                if not line:
                    continue

                try:
                    item = json.loads(line)
                except (ValueError, TypeError):
                    continue

                if isinstance(item, dict):
                    records.append(item)

    except OSError:
        return []

    return records


def pdf_library_scan_files():
    metadata_records = pdf_library_load_metadata()

    metadata_by_path = {
        str(item.get("relative_path") or ""): item
        for item in metadata_records
        if item.get("relative_path")
    }

    documents = []

    for category in PDF_UPLOAD_CATEGORIES:
        directory = PDF_DOCUMENT_ROOT / category

        if not directory.is_dir():
            continue

        for path in directory.glob("*.pdf"):
            if not path.is_file():
                continue

            relative_path = str(path.relative_to(PDF_DOCUMENT_ROOT))
            metadata = metadata_by_path.get(relative_path, {})

            try:
                stat = path.stat()
            except OSError:
                continue

            documents.append({
                "title": str(
                    metadata.get("title")
                    or path.stem.replace("-", " ").replace("_", " ").title()
                ),
                "category": category,
                "filename": path.name,
                "relative_path": relative_path,
                "notes": str(metadata.get("notes") or ""),
                "uploaded_at": str(metadata.get("uploaded_at") or ""),
                "page_count": metadata.get("page_count"),
                "size_bytes": int(metadata.get("size_bytes") or stat.st_size),
                "modified_timestamp": stat.st_mtime,
                "encrypted": bool(metadata.get("encrypted", False)),
            })

    documents.sort(
        key=lambda item: (
            -float(item.get("modified_timestamp") or 0),
            str(item.get("title") or "").casefold(),
        )
    )

    return documents


def pdf_library_display_date(value, fallback_timestamp=None):
    if value:
        try:
            parsed = datetime.fromisoformat(value)
            return parsed.astimezone().strftime("%B %d, %Y at %I:%M %p")
        except (ValueError, TypeError):
            pass

    if fallback_timestamp:
        try:
            return datetime.fromtimestamp(
                fallback_timestamp
            ).astimezone().strftime("%B %d, %Y at %I:%M %p")
        except (ValueError, OSError, TypeError):
            pass

    return "Unknown"


@app.route("/documentation/pdfs")
def documentation_pdf_library():
    documents = pdf_library_scan_files()

    search_term = str(request.args.get("q") or "").strip()
    selected_category = str(
        request.args.get("category") or ""
    ).strip()

    filtered = list(documents)

    if selected_category:
        filtered = [
            item for item in filtered
            if item["category"].casefold()
            == selected_category.casefold()
        ]

    if search_term:
        needle = search_term.casefold()

        filtered = [
            item for item in filtered
            if needle in " ".join([
                item["title"],
                item["filename"],
                item["category"],
                item["notes"],
                item["relative_path"],
            ]).casefold()
        ]

    category_options = [
        '<option value="">All categories</option>'
    ]

    for category in PDF_UPLOAD_CATEGORIES:
        selected = (
            " selected"
            if category.casefold() == selected_category.casefold()
            else ""
        )

        category_options.append(
            f'<option value="{html.escape(category, quote=True)}"'
            f'{selected}>{html.escape(category)}</option>'
        )

    category_counts = {}

    for item in documents:
        category_counts[item["category"]] = (
            category_counts.get(item["category"], 0) + 1
        )

    total_size = sum(item["size_bytes"] for item in documents)

    cards = []

    for item in filtered:
        open_url = (
            f"/documentation/pdf/{quote(item['category'])}/"
            f"{quote(item['filename'])}"
        )

        page_text = (
            str(item["page_count"])
            if item.get("page_count") is not None
            else "Unknown"
        )

        encrypted_badge = (
            '<span class="badge">Encrypted</span>'
            if item.get("encrypted")
            else ""
        )

        notes_html = ""

        if item["notes"]:
            notes_html = (
                f"<p><b>Notes:</b> "
                f"{html.escape(item['notes'])}</p>"
            )

        uploaded_display = pdf_library_display_date(
            item.get("uploaded_at"),
            item.get("modified_timestamp"),
        )

        cards.append(
            f"""<article class="document-card">
<h3>{html.escape(item['title'])}</h3>
<p class="muted">{html.escape(item['relative_path'])}</p>
<div>
<span class="badge">{html.escape(item['category'])}</span>
<span class="badge">{page_text} pages</span>
{encrypted_badge}
</div>
<p><b>Uploaded:</b> {html.escape(uploaded_display)}</p>
<p><b>Size:</b> {html.escape(documentation_human_size(item['size_bytes']))}</p>
{notes_html}
<p class="open-link">
<a href="{open_url}" target="_blank" rel="noopener">
Open PDF →
</a>
</p>
</article>"""
        )

    if cards:
        results_html = (
            '<div class="document-grid">'
            + "".join(cards)
            + "</div>"
        )
    else:
        results_html = (
            '<div class="empty-state">'
            "No uploaded PDFs matched your search."
            "</div>"
        )

    category_summary = ", ".join(
        f"{html.escape(category)}: {count}"
        for category, count in sorted(
            category_counts.items(),
            key=lambda item: item[0].casefold(),
        )
    ) or "No PDFs uploaded"

    body = f"""
<p class="muted">
Search and open PDFs stored on the external AI drive.
</p>

<div class="summary-grid">
<div class="health">
<div class="muted">Uploaded PDFs</div>
<div class="health-number">{len(documents)}</div>
</div>

<div class="health">
<div class="muted">Current results</div>
<div class="health-number">{len(filtered)}</div>
</div>

<div class="health">
<div class="muted">Total PDF storage</div>
<div class="health-number">{html.escape(documentation_human_size(total_size))}</div>
</div>

<div class="health">
<div class="muted">Categories used</div>
<div class="health-number">{len(category_counts)}</div>
</div>
</div>

<div class="health" style="margin-bottom:18px;">
<div class="muted">Library breakdown</div>
<div>{category_summary}</div>
</div>

<form method="GET"
      action="/documentation/pdfs"
      class="toolbar">

<div>
<label for="pdf-library-search">
<b>Search PDF library</b>
</label>

<input id="pdf-library-search"
       name="q"
       type="search"
       value="{html.escape(search_term, quote=True)}"
       placeholder="Search title, filename, category, or notes">
</div>

<div>
<label for="pdf-library-category">
<b>Category</b>
</label>

<select id="pdf-library-category" name="category">
{"".join(category_options)}
</select>
</div>

<div>
<button type="submit">Search PDFs</button>

<a href="/documentation/pdfs"
   style="display:inline-block;margin-left:10px;">
Clear
</a>
</div>
</form>

<p>
<a href="/documentation/upload">Upload another PDF →</a>
</p>

{results_html}
"""

    return documentation_shell("Uploaded PDF Library", body)
'''


def run(command, check=True):
    command = [str(part) for part in command]
    print("+", " ".join(command))

    return subprocess.run(
        command,
        cwd=REPO,
        text=True,
        check=check,
    )


def patch_app():
    shutil.copy2(APP, BACKUP)
    print(f"Backup created: {BACKUP}")

    text = APP.read_text(encoding="utf-8")

    required_upload_marker = "# PDF DOCUMENT UPLOAD ROUTES"

    if required_upload_marker not in text:
        raise RuntimeError(
            "PDF upload feature is not installed."
        )

    if MARKER not in text:
        if ANCHOR not in text:
            raise RuntimeError(
                "Could not locate dashboard insertion anchor."
            )

        text = text.replace(
            ANCHOR,
            LIBRARY_CODE + "\n\n" + ANCHOR,
            1,
        )

    upload_link = (
        '<a href="/documentation/upload">'
        'Upload PDF</a>'
    )

    library_link = (
        '<a href="/documentation/pdfs">'
        'PDF Library</a>'
    )

    if library_link not in text:
        if upload_link not in text:
            raise RuntimeError(
                "Upload PDF navigation link was not found."
            )

        text = text.replace(
            upload_link,
            upload_link + library_link,
        )

    APP.write_text(text, encoding="utf-8")


def load_app():
    spec = importlib.util.spec_from_file_location(
        "openclaw_dashboard_pdf_library_test",
        APP,
    )

    if spec is None or spec.loader is None:
        raise RuntimeError(
            "Unable to load dashboard module."
        )

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    return module


def test_app():
    run([PYTHON, "-m", "py_compile", APP])

    module = load_app()
    client = module.app.test_client()

    tests = (
        ("/documentation", 200),
        ("/documentation/upload", 200),
        ("/documentation/pdfs", 200),
        ("/documentation/pdfs?q=OpenClaw", 200),
    )

    for path, expected in tests:
        response = client.get(path)

        print(
            f"Test {path}: {response.status_code}"
        )

        if response.status_code != expected:
            raise RuntimeError(
                f"Route test failed for {path}: "
                f"expected {expected}, "
                f"received {response.status_code}"
            )


def restart_and_test():
    run([
        "systemctl",
        "--user",
        "restart",
        SERVICE,
    ])

    time.sleep(3)

    run([
        "systemctl",
        "--user",
        "is-active",
        "--quiet",
        SERVICE,
    ])

    run([
        "curl",
        "--fail",
        "--silent",
        "--show-error",
        "-o",
        "/dev/null",
        "http://127.0.0.1:5051/documentation/pdfs",
    ])


def rollback():
    if BACKUP.exists():
        print(f"Rolling back from {BACKUP}")
        shutil.copy2(BACKUP, APP)

        subprocess.run(
            [
                "systemctl",
                "--user",
                "restart",
                SERVICE,
            ],
            cwd=REPO,
            check=False,
        )


def main():
    print("===== OPENCLAW PDF LIBRARY INSTALLER =====")
    print(f"Repository: {REPO}")

    try:
        if not APP.is_file():
            raise RuntimeError(
                f"Dashboard app is missing: {APP}"
            )

        patch_app()
        test_app()
        restart_and_test()

    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        rollback()
        return 1

    print()
    print("INSTALLATION COMPLETE")
    print(
        "Open: "
        "http://intelmini.local:5051/documentation/pdfs"
    )
    print(f"Backup: {BACKUP}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
