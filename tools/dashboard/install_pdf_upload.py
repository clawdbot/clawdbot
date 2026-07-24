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
BACKUP = APP.with_name(f"{APP.name}.before-pdf-upload-{STAMP}")

MARKER = "# PDF DOCUMENT UPLOAD ROUTES"
ANCHOR = "# BACKUP & RECOVERY CENTER"

PDF_CODE = r'''
# =============================================================================
# PDF DOCUMENT UPLOAD ROUTES
# =============================================================================

PDF_DOCUMENT_ROOT = Path("/mnt/ai-storage/openclaw-documents")
PDF_METADATA_ROOT = PDF_DOCUMENT_ROOT / ".metadata"
PDF_UPLOAD_LOG = PDF_METADATA_ROOT / "uploads.jsonl"

PDF_UPLOAD_CATEGORIES = (
    "Assets",
    "Property",
    "Home-Assistant",
    "Medical",
    "Receipts",
    "Projects",
    "Procedures",
    "Unsorted",
)

PDF_MAX_UPLOAD_BYTES = 50 * 1024 * 1024
app.config["MAX_CONTENT_LENGTH"] = PDF_MAX_UPLOAD_BYTES


def pdf_upload_safe_destination(category, original_name):
    if category not in PDF_UPLOAD_CATEGORIES:
        raise ValueError("Invalid document category.")

    safe_name = secure_filename(str(original_name or ""))
    if not safe_name:
        raise ValueError("The file does not have a usable filename.")

    if Path(safe_name).suffix.lower() != ".pdf":
        raise ValueError("Only PDF files may be uploaded.")

    destination_directory = PDF_DOCUMENT_ROOT / category
    destination_directory.mkdir(parents=True, exist_ok=True)

    destination = destination_directory / safe_name

    if destination.exists():
        stem = destination.stem
        suffix = destination.suffix
        timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        destination = destination_directory / f"{stem}-{timestamp}{suffix}"

        counter = 1
        while destination.exists():
            destination = destination_directory / (
                f"{stem}-{timestamp}-{counter}{suffix}"
            )
            counter += 1

    return destination


def pdf_upload_validate(path):
    if not path.is_file():
        raise ValueError("Uploaded file was not saved.")

    size = path.stat().st_size

    if size <= 0:
        raise ValueError("The uploaded PDF is empty.")

    if size > PDF_MAX_UPLOAD_BYTES:
        raise ValueError("The uploaded PDF exceeds the 50 MB limit.")

    with path.open("rb") as handle:
        signature = handle.read(5)

    if signature != b"%PDF-":
        raise ValueError("The uploaded file does not have a valid PDF signature.")

    try:
        reader = PdfReader(str(path), strict=False)
        page_count = len(reader.pages)
    except Exception as exc:
        raise ValueError(
            "The uploaded file could not be parsed as a valid PDF."
        ) from exc

    if page_count < 1:
        raise ValueError("The uploaded PDF does not contain any pages.")

    return {
        "size_bytes": size,
        "page_count": page_count,
        "encrypted": bool(reader.is_encrypted),
    }


def pdf_upload_record(metadata):
    PDF_METADATA_ROOT.mkdir(parents=True, exist_ok=True)

    with PDF_UPLOAD_LOG.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(metadata, ensure_ascii=False) + "\n")


def pdf_upload_resolve(category, filename):
    if category not in PDF_UPLOAD_CATEGORIES:
        raise ValueError("Invalid category.")

    safe_name = secure_filename(str(filename or ""))

    if safe_name != filename:
        raise ValueError("Invalid filename.")

    if Path(safe_name).suffix.lower() != ".pdf":
        raise ValueError("Only PDF files may be opened.")

    root = PDF_DOCUMENT_ROOT.resolve()
    candidate = (root / category / safe_name).resolve()

    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise ValueError("Document is outside the PDF library.") from exc

    if not candidate.is_file():
        raise FileNotFoundError("PDF was not found.")

    return candidate


@app.errorhandler(413)
def pdf_upload_too_large(_error):
    body = """<div class="empty-state">
<h2>Upload unsuccessful</h2>
<p>The selected file exceeds the 50 MB upload limit.</p>
<p><a href="/documentation/upload">Return to PDF upload</a></p>
</div>"""
    return documentation_shell("PDF Upload", body), 413


@app.route("/documentation/upload", methods=["GET", "POST"])
def documentation_upload_pdf():
    message = ""
    message_class = "empty-state"

    if request.method == "POST":
        upload = request.files.get("pdf_file")
        category = str(request.form.get("category") or "Unsorted").strip()
        title = str(request.form.get("title") or "").strip()
        notes = str(request.form.get("notes") or "").strip()

        temporary_path = None
        final_path = None

        try:
            if upload is None or not upload.filename:
                raise ValueError("Select a PDF file before uploading.")

            final_path = pdf_upload_safe_destination(
                category,
                upload.filename,
            )

            temporary_path = final_path.with_name(
                f".{final_path.name}.uploading-{time.time_ns()}"
            )

            upload.save(temporary_path)
            validation = pdf_upload_validate(temporary_path)

            temporary_path.replace(final_path)

            metadata = {
                "uploaded_at": datetime.now().astimezone().isoformat(),
                "original_filename": str(upload.filename),
                "stored_filename": final_path.name,
                "relative_path": str(final_path.relative_to(PDF_DOCUMENT_ROOT)),
                "category": category,
                "title": title or final_path.stem,
                "notes": notes,
                "size_bytes": validation["size_bytes"],
                "page_count": validation["page_count"],
                "encrypted": validation["encrypted"],
            }

            try:
                pdf_upload_record(metadata)
            except Exception:
                final_path.unlink(missing_ok=True)
                raise

            open_url = (
                f"/documentation/pdf/{quote(category)}/"
                f"{quote(final_path.name)}"
            )

            message_class = "document-viewer"
            message = f"""<h2>PDF uploaded successfully</h2>
<p><b>Title:</b> {html.escape(metadata['title'])}</p>
<p><b>Stored file:</b> {html.escape(metadata['relative_path'])}</p>
<p><b>Pages:</b> {metadata['page_count']}</p>
<p><b>Size:</b> {html.escape(documentation_human_size(metadata['size_bytes']))}</p>
<p><a href="{open_url}" target="_blank" rel="noopener">Open uploaded PDF →</a></p>"""

        except ValueError as exc:
            if temporary_path:
                temporary_path.unlink(missing_ok=True)

            message = f"""<h2>Upload unsuccessful</h2>
<p>{html.escape(str(exc))}</p>"""

        except Exception:
            if temporary_path:
                temporary_path.unlink(missing_ok=True)

            message = """<h2>Upload unsuccessful</h2>
<p>An unexpected error occurred while storing the PDF.</p>"""

    category_options = []

    for category_name in PDF_UPLOAD_CATEGORIES:
        selected = " selected" if category_name == "Unsorted" else ""
        category_options.append(
            f'<option value="{html.escape(category_name, quote=True)}"'
            f'{selected}>{html.escape(category_name)}</option>'
        )

    body = f"""
<p class="breadcrumb">
<a href="/documentation">Documentation Center</a>
&nbsp;→&nbsp;Upload PDF
</p>

<div class="document-viewer">
<h2>Upload a PDF document</h2>

<p class="muted">
The original PDF will be stored on the external AI drive.
Only valid PDF files up to 50 MB are accepted.
</p>

<form method="POST"
      action="/documentation/upload"
      enctype="multipart/form-data">

<p>
<label for="pdf-file"><b>PDF file</b></label><br>
<input id="pdf-file"
       name="pdf_file"
       type="file"
       accept="application/pdf,.pdf"
       required>
</p>

<p>
<label for="pdf-category"><b>Category</b></label><br>
<select id="pdf-category" name="category">
{"".join(category_options)}
</select>
</p>

<p>
<label for="pdf-title"><b>Document title</b></label><br>
<input id="pdf-title"
       name="title"
       type="text"
       maxlength="200"
       placeholder="Optional descriptive title">
</p>

<p>
<label for="pdf-notes"><b>Notes</b></label><br>
<textarea id="pdf-notes"
          name="notes"
          maxlength="2000"
          rows="5"
          style="width:100%;background:var(--page);border:1px solid var(--line);border-radius:8px;color:var(--text);font:inherit;padding:11px;"
          placeholder="Optional notes about this document"></textarea>
</p>

<p>
<button type="submit">Upload PDF</button>
</p>
</form>
</div>

{f'<div class="{message_class}" style="margin-top:18px;padding:20px;">{message}</div>' if message else ''}
"""

    return documentation_shell("Upload PDF", body)


@app.route("/documentation/pdf/<category>/<filename>")
def documentation_open_pdf(category, filename):
    try:
        path = pdf_upload_resolve(category, filename)
    except FileNotFoundError:
        abort(404)
    except ValueError:
        abort(400)

    return send_from_directory(
        str(path.parent),
        path.name,
        mimetype="application/pdf",
        as_attachment=False,
        conditional=True,
    )
'''


def run(command, check=True):
    print("+", " ".join(str(part) for part in command))
    return subprocess.run(
        [str(part) for part in command],
        cwd=REPO,
        text=True,
        check=check,
    )


def add_top_level_import(text, import_line):
    if import_line.strip() in {
        line.strip()
        for line in text.splitlines()
        if line == line.lstrip()
    }:
        return text

    lines = text.splitlines(keepends=True)
    insertion_index = 0
    imports_started = False

    for index, line in enumerate(lines):
        stripped = line.strip()

        if not stripped:
            if imports_started:
                insertion_index = index
            continue

        top_level = line == line.lstrip()
        is_import = top_level and (
            stripped.startswith("import ")
            or stripped.startswith("from ")
        )

        if is_import:
            imports_started = True
            insertion_index = index + 1
            continue

        if imports_started:
            break

        if stripped.startswith("#!") or stripped.startswith("#"):
            insertion_index = index + 1
            continue

        break

    lines.insert(insertion_index, import_line)
    return "".join(lines)


def patch_flask_import(text):
    lines = text.splitlines(keepends=True)

    for index, line in enumerate(lines):
        if not line.startswith("from flask import "):
            continue

        newline = "\n" if line.endswith("\n") else ""
        names = [
            item.strip()
            for item in line.strip()
            .removeprefix("from flask import ")
            .split(",")
        ]

        for required in (
            "Flask",
            "abort",
            "redirect",
            "request",
            "send_from_directory",
        ):
            if required not in names:
                names.append(required)

        lines[index] = "from flask import " + ", ".join(names) + newline
        return "".join(lines)

    raise RuntimeError("Flask import was not found.")


def patch_app():
    shutil.copy2(APP, BACKUP)
    print(f"Backup created: {BACKUP}")

    text = APP.read_text(encoding="utf-8")

    if MARKER not in text:
        if ANCHOR not in text:
            raise RuntimeError("Could not locate the insertion anchor.")

        text = text.replace(
            ANCHOR,
            PDF_CODE + "\n\n" + ANCHOR,
            1,
        )

    text = add_top_level_import(
        text,
        "from werkzeug.utils import secure_filename\n",
    )

    text = add_top_level_import(
        text,
        "from pypdf import PdfReader\n",
    )

    text = patch_flask_import(text)

    navigation = (
        '<a href="/documentation">'
        'Foundational Documentation</a>'
    )

    upload_navigation = (
        '<a href="/documentation/upload">'
        'Upload PDF</a>'
    )

    if upload_navigation not in text:
        if navigation not in text:
            raise RuntimeError(
                "Documentation navigation link was not found."
            )

        text = text.replace(
            navigation,
            navigation + upload_navigation,
        )

    APP.write_text(text, encoding="utf-8")


def load_app():
    spec = importlib.util.spec_from_file_location(
        "openclaw_dashboard_pdf_test",
        APP,
    )

    if spec is None or spec.loader is None:
        raise RuntimeError("Unable to load the dashboard module.")

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
        ("/documentation/pdf/Unsorted/does-not-exist.pdf", 404),
    )

    for path, expected in tests:
        response = client.get(path)
        print(f"Test {path}: {response.status_code}")

        if response.status_code != expected:
            raise RuntimeError(
                f"Route test failed for {path}: "
                f"expected {expected}, got {response.status_code}"
            )


def restart_and_test():
    run(["systemctl", "--user", "restart", SERVICE])
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
        "http://127.0.0.1:5051/documentation/upload",
    ])


def rollback():
    if BACKUP.exists():
        print(f"Rolling back from {BACKUP}")
        shutil.copy2(BACKUP, APP)

        subprocess.run(
            ["systemctl", "--user", "restart", SERVICE],
            cwd=REPO,
            check=False,
        )


def main():
    print("===== OPENCLAW PDF UPLOAD INSTALLER =====")
    print(f"Repository: {REPO}")

    try:
        if not APP.is_file():
            raise RuntimeError(f"Dashboard app missing: {APP}")

        if not PYTHON.is_file():
            raise RuntimeError(f"Dashboard Python missing: {PYTHON}")

        document_root = Path("/mnt/ai-storage/openclaw-documents")

        if not document_root.is_dir():
            raise RuntimeError(
                f"PDF document directory missing: {document_root}"
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
    print("Open: http://intelmini.local:5051/documentation/upload")
    print(f"Backup: {BACKUP}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
