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
BACKUP = APP.with_name(
    f"{APP.name}.before-shared-navigation-{STAMP}"
)

MARKER = "# OPENCLAW SHARED DASHBOARD NAVIGATION"
ANCHOR = "# DOCUMENTATION CENTER ROUTES"

SHARED_NAVIGATION_CODE = r'''
# =============================================================================
# OPENCLAW SHARED DASHBOARD NAVIGATION
# =============================================================================

OPENCLAW_NAVIGATION_ITEMS = (
    ("/", "Overview"),
    ("/ranchbrain", "RanchBrain"),
    ("/documentation", "Knowledge Center"),
    ("/documentation/pdfs", "PDF Library"),
    ("/documentation/upload", "Upload PDF"),
    ("/backup-recovery", "Backup & Recovery Center"),
    ("/ranchbrain/review", "Review Pending Notes"),
)


def openclaw_shared_navigation(tag_name="div"):
    """Return the standard OpenClaw navigation used on every dashboard page."""

    if tag_name not in {"div", "nav"}:
        tag_name = "div"

    class_attribute = ' class="nav"' if tag_name == "div" else ""

    links = []

    for route, label in OPENCLAW_NAVIGATION_ITEMS:
        links.append(
            f'<a href="{html.escape(route, quote=True)}">'
            f'{html.escape(label)}</a>'
        )

    return (
        f"<{tag_name}{class_attribute}>"
        + "".join(links)
        + f"</{tag_name}>"
    )


def openclaw_replace_existing_navigation(page_html):
    """
    Replace the first existing dashboard navigation block with the
    shared OpenClaw navigation.

    This supports both older <div class="nav"> menus and newer <nav> menus.
    """

    if not isinstance(page_html, str) or not page_html:
        return page_html

    replacements = (
        (
            '<div class="nav">',
            "</div>",
            openclaw_shared_navigation("div"),
        ),
        (
            "<nav>",
            "</nav>",
            openclaw_shared_navigation("nav"),
        ),
    )

    for start_marker, end_marker, replacement in replacements:
        start = page_html.find(start_marker)

        if start == -1:
            continue

        end = page_html.find(
            end_marker,
            start + len(start_marker),
        )

        if end == -1:
            continue

        end += len(end_marker)

        return (
            page_html[:start]
            + replacement
            + page_html[end:]
        )

    return page_html


@app.after_request
def openclaw_apply_shared_navigation(response):
    """
    Apply one consistent navigation menu to all OpenClaw HTML pages.

    Non-HTML responses, PDFs, JSON, downloads, and static assets are
    returned unchanged.
    """

    if response.direct_passthrough:
        return response

    mimetype = str(response.mimetype or "").lower()

    if mimetype != "text/html":
        return response

    try:
        page_html = response.get_data(as_text=True)
        updated_html = openclaw_replace_existing_navigation(page_html)

        if updated_html != page_html:
            response.set_data(updated_html)
            response.headers["Content-Length"] = str(
                len(response.get_data())
            )

    except Exception:
        # Navigation enhancement must never prevent the page from loading.
        return response

    return response
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

    if MARKER in text:
        print("Shared navigation is already installed.")
        return

    if ANCHOR not in text:
        raise RuntimeError(
            "Documentation Center anchor was not found."
        )

    text = text.replace(
        ANCHOR,
        SHARED_NAVIGATION_CODE + "\n\n" + ANCHOR,
        1,
    )

    APP.write_text(text, encoding="utf-8")


def load_app():
    spec = importlib.util.spec_from_file_location(
        "openclaw_shared_navigation_test",
        APP,
    )

    if spec is None or spec.loader is None:
        raise RuntimeError(
            "Unable to load the dashboard application."
        )

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    return module


def verify_page(response, page_name):
    if response.status_code != 200:
        raise RuntimeError(
            f"{page_name} returned HTTP "
            f"{response.status_code}."
        )

    html_text = response.get_data(as_text=True)

    expected_labels = (
        "Overview",
        "RanchBrain",
        "Knowledge Center",
        "PDF Library",
        "Upload PDF",
        "Backup &amp; Recovery Center",
        "Review Pending Notes",
    )

    for label in expected_labels:
        if label not in html_text:
            raise RuntimeError(
                f"{page_name} is missing navigation item: "
                f"{label}"
            )

    if 'href="/documentation"' not in html_text:
        raise RuntimeError(
            f"{page_name} is missing the Knowledge Center link."
        )

    print(f"PASS    {page_name}")


def test_app():
    run([
        PYTHON,
        "-m",
        "py_compile",
        APP,
    ])

    module = load_app()
    client = module.app.test_client()

    test_pages = (
        ("/", "Overview"),
        ("/ranchbrain", "RanchBrain"),
        ("/documentation", "Knowledge Center"),
        ("/documentation/pdfs", "PDF Library"),
        ("/documentation/upload", "Upload PDF"),
        ("/backup-recovery", "Backup & Recovery"),
    )

    for path, name in test_pages:
        response = client.get(path)
        verify_page(response, name)


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

    live_html = Path(
        "/tmp/openclaw-shared-navigation-live.html"
    )

    run([
        "curl",
        "--fail",
        "--silent",
        "--show-error",
        "--output",
        live_html,
        "http://127.0.0.1:5051/",
    ])

    text = live_html.read_text(
        encoding="utf-8",
        errors="replace",
    )

    required = (
        'href="/documentation"',
        ">Knowledge Center</a>",
        'href="/documentation/pdfs"',
        ">PDF Library</a>",
        'href="/documentation/upload"',
        ">Upload PDF</a>",
    )

    for value in required:
        if value not in text:
            raise RuntimeError(
                f"Live dashboard is missing: {value}"
            )

    print("PASS    Live Overview navigation")


def rollback():
    if not BACKUP.exists():
        return

    print(f"Rolling back from: {BACKUP}")

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
    print(
        "===== OPENCLAW SHARED NAVIGATION INSTALLER ====="
    )
    print(f"Repository: {REPO}")

    try:
        if not APP.is_file():
            raise RuntimeError(
                f"Dashboard application is missing: {APP}"
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
    print("Shared dashboard navigation is active.")
    print(f"Backup: {BACKUP}")
    print(
        "Open: http://intelmini.local:5051/"
    )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
