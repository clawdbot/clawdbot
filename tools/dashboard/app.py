from flask import (
    Flask,
    Response,
    abort,
    redirect,
    request,
    send_from_directory,
    stream_with_context,
)
from werkzeug.exceptions import HTTPException
from pathlib import Path
from datetime import datetime
import os
import sys
import subprocess
import shutil
import tarfile
import requests
import csv
import re
import json
import time
import base64
import hashlib
import uuid
import psycopg2
import html as html_module

import matplotlib
import html
import markdown
from urllib.parse import quote
from werkzeug.utils import secure_filename
from pypdf import PdfReader

OPENCLAW_ROOT = Path(__file__).resolve().parents[2]
if str(OPENCLAW_ROOT) not in sys.path:
    sys.path.insert(0, str(OPENCLAW_ROOT))

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
from tools.ai_intelligence.ollama_config import OllamaConfig

app = Flask(__name__)

OLLAMA_CONFIG = OllamaConfig.from_env()
OLLAMA_HOST = OLLAMA_CONFIG.base_url
OLLAMA_TIMEOUT_SECONDS = OLLAMA_CONFIG.default_timeout_seconds
M4_SSH_HOST = os.environ.get("OPENCLAW_M4_SSH_HOST", "192.168.50.117")
M4_SSH_USER = os.environ.get("OPENCLAW_M4_SSH_USER", "andrewgraves")
M4_SSH_KEY = os.environ.get(
    "OPENCLAW_M4_SSH_KEY",
    str(Path.home() / ".ssh/openclaw_dev_backup_ed25519"),
)
INTELMINI_STORAGE_HOST = os.environ.get(
    "OPENCLAW_INTELMINI_STORAGE_HOST",
    "100.85.36.72",
)
INTELMINI_STORAGE_USER = os.environ.get(
    "OPENCLAW_INTELMINI_STORAGE_USER",
    "gravesab",
)
INTELMINI_STORAGE_KEY = os.environ.get(
    "OPENCLAW_INTELMINI_STORAGE_KEY",
    str(Path.home() / ".ssh/openclaw_dev_backup_ed25519"),
)

REPORT_DIR = Path.home() / "ai/projects/openclaw/reports"
GRAPH_DIR = REPORT_DIR / "graphs"
TREND_FILE = REPORT_DIR / "trends.csv"
MODELS = [
    "llama3.2:3b",
    "hermes3:8b",
    "gemma3:12b",
    "nomic-embed-text:latest",
    "gpt-oss:20b",
    "glm-4.7-flash:latest",
]

BACKUP_DIR = Path.home() / "openclaw-backups"

AI_REPORT_DIR = OPENCLAW_ROOT / "reports/ai_intelligence"
AI_EVALUATION_PATH = AI_REPORT_DIR / "evaluation_lab/evaluation-lab-latest.json"
AI_APPROVAL_PATH = AI_REPORT_DIR / "evaluation_approvals/evaluation-approval-latest.json"
AI_CANDIDATES_PATH = (
    AI_REPORT_DIR
    / "evaluation_approvals/approved-scorecard-candidates-latest.json"
)
AI_BENCHMARK_PATH = (
    AI_REPORT_DIR / "benchmark_runs/local-benchmark-latest.json"
)
AI_VALIDATION_PATH = (
    AI_REPORT_DIR
    / "benchmark_validation/benchmark-validation-latest.json"
)
AI_REVIEW_PATH = (
    AI_REPORT_DIR / "benchmark_reviews/benchmark-review-latest.json"
)
AI_PROMOTION_DIR = AI_REPORT_DIR / "scorecard_promotions"
AI_SCORECARD_PATH = OPENCLAW_ROOT / "config/ai_intelligence/scorecard.json"
AI_MODEL_REGISTRY_PATH = (
    OPENCLAW_ROOT / "config/ai_intelligence/model_registry.json"
)
AI_APPROVAL_TOOL = (
    OPENCLAW_ROOT / "tools/ai_intelligence/approve_evaluation_lab.py"
)
AI_PROMOTION_TOOL = (
    OPENCLAW_ROOT / "tools/ai_intelligence/promote_approved_scorecard.py"
)
AI_INTELLIGENCE_PYTHON = (
    OPENCLAW_ROOT / "tools/ai_intelligence/.venv/bin/python"
)



def run_command(cmd, timeout=20):
    try:
        return subprocess.check_output(
            cmd,
            shell=True,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=timeout
        ).strip()
    except Exception as e:
        return str(e)


def get_disk_info(path, label):
    if not Path(path).exists():
        return {
            "label": label,
            "path": path,
            "total": "not mounted",
            "used": "not mounted",
            "free": "not mounted",
            "pct": "—",
            "pct_num": None,
            "color": "#64748b",
            "status": "Not mounted on this host",
            "available": False,
        }

    try:
        out = subprocess.check_output(
            ["df", "-P", "-h", "--", path],
            text=True,
            timeout=10,
            stderr=subprocess.STDOUT,
        ).strip()

        lines = out.splitlines()
        if len(lines) < 2:
            raise ValueError("disk usage command returned no data row")
        fields = lines[-1].split()
        if len(fields) < 6:
            raise ValueError("disk usage command returned an incomplete data row")
        total, used, free, pct = fields[1:5]
        pct_num = int(pct.replace("%", ""))

        if pct_num >= 90:
            color = "#ef4444"
            status = "Critical"
        elif pct_num >= 80:
            color = "#facc15"
            status = "Warning"
        else:
            color = "#22c55e"
            status = "Healthy"

        return {
            "label": label,
            "path": path,
            "total": total,
            "used": used,
            "free": free,
            "pct": pct,
            "pct_num": pct_num,
            "color": color,
            "status": status,
            "available": True,
        }
    except Exception:
        return {
            "label": label,
            "path": path,
            "total": "unknown",
            "used": "unknown",
            "free": "unknown",
            "pct": "—",
            "pct_num": None,
            "color": "#64748b",
            "status": "Storage status unavailable",
            "available": False,
        }


def get_remote_external_storage_info():
    remote_command = (
        "findmnt -n -T /mnt/ai-storage -o TARGET,SOURCE,FSTYPE && "
        "df -P -h -- /mnt/ai-storage"
    )
    try:
        out = subprocess.check_output(
            [
                "ssh",
                "-i",
                INTELMINI_STORAGE_KEY,
                "-o",
                "BatchMode=yes",
                "-o",
                "IdentitiesOnly=yes",
                "-o",
                "StrictHostKeyChecking=yes",
                "-o",
                "ConnectTimeout=5",
                f"{INTELMINI_STORAGE_USER}@{INTELMINI_STORAGE_HOST}",
                remote_command,
            ],
            text=True,
            timeout=10,
            stderr=subprocess.STDOUT,
        ).strip()
        lines = out.splitlines()
        if len(lines) < 3:
            raise ValueError("remote storage probe returned incomplete data")

        mount_fields = lines[0].split()
        disk_fields = lines[-1].split()
        if (
            len(mount_fields) < 3
            or mount_fields[0] != "/mnt/ai-storage"
            or len(disk_fields) < 6
        ):
            raise ValueError("remote storage is not mounted at the expected path")

        total, used, free, pct = disk_fields[1:5]
        pct_num = int(pct.replace("%", ""))
        if pct_num >= 90:
            color, status = "#ef4444", "Critical"
        elif pct_num >= 80:
            color, status = "#facc15", "Warning"
        else:
            color, status = "#22c55e", "Healthy"

        return {
            "label": "External AI Storage — Intel Mini",
            "path": "/mnt/ai-storage",
            "total": total,
            "used": used,
            "free": free,
            "pct": pct,
            "pct_num": pct_num,
            "color": color,
            "status": status,
            "available": True,
            "source": mount_fields[1],
            "filesystem": mount_fields[2],
            "remote_host": INTELMINI_STORAGE_HOST,
        }
    except Exception:
        return {
            "label": "External AI Storage — Intel Mini",
            "path": "/mnt/ai-storage",
            "total": "unavailable",
            "used": "unavailable",
            "free": "unavailable",
            "pct": "—",
            "pct_num": None,
            "color": "#64748b",
            "status": "Intel Mini probe unavailable",
            "available": False,
            "source": "unknown",
            "filesystem": "unknown",
            "remote_host": INTELMINI_STORAGE_HOST,
        }


def get_external_storage_info():
    local_mount = run_command(
        "findmnt -n -T /mnt/ai-storage -o TARGET",
        timeout=5,
    )
    if local_mount == "/mnt/ai-storage":
        return get_disk_info(
            "/mnt/ai-storage",
            "External AI Storage",
        )
    return get_remote_external_storage_info()


def get_disk_used_percent(path):
    try:
        out = subprocess.check_output(
            f"df -P {path} | awk 'NR==2 {{print $5}}'",
            shell=True,
            text=True,
            timeout=10
        ).strip()
        return float(out.replace("%", ""))
    except Exception:
        return None


def storage_chart_html(external_now=None):
    chart_file = GRAPH_DIR / "storage_usage.png"

    internal_now = get_disk_used_percent("/")

    labels = []
    internal_values = []
    external_values = []

    if TREND_FILE.exists():
        try:
            with TREND_FILE.open() as f:
                rows = list(csv.DictReader(f))

            time_col = find_column(rows, ["timestamp", "time", "datetime", "date"])
            disk_col = find_column(
                rows,
                ["disk_used_percent", "disk_used_pct", "disk_pct", "disk"],
            )
            external_disk_col = find_column(
                rows,
                [
                    "external_disk_used_percent",
                    "external_disk_used_pct",
                    "external_disk_pct",
                ],
            )

            for row in rows[-24:]:
                raw_time = row.get(time_col, "") if time_col else ""

                try:
                    dt = datetime.strptime(raw_time, "%Y-%m-%d %H:%M:%S")
                    label = dt.strftime("%m/%d %H:%M")
                except Exception:
                    label = raw_time or datetime.now().strftime("%m/%d %H:%M")

                disk_pct = parse_number(row.get(disk_col)) if disk_col else None
                external_disk_pct = (
                    parse_number(row.get(external_disk_col))
                    if external_disk_col
                    else None
                )

                labels.append(label)
                internal_values.append(disk_pct)
                external_values.append(external_disk_pct)
        except Exception:
            labels = []
            internal_values = []
            external_values = []

    if not labels:
        labels = [datetime.now().strftime("%m/%d %H:%M")]
        internal_values = [internal_now]
        external_values = [external_now]

    GRAPH_DIR.mkdir(parents=True, exist_ok=True)

    plt.figure(figsize=(12, 4.8), facecolor="#0f172a")
    ax = plt.gca()
    ax.set_facecolor("#0f172a")

    if any(value is not None for value in internal_values):
        ax.plot(
            labels,
            internal_values,
            marker="o",
            linewidth=2,
            label="Internal Ubuntu Disk (/)",
        )
    if any(value is not None for value in external_values):
        ax.plot(
            labels,
            external_values,
            marker="o",
            linewidth=2,
            label="External AI Storage (/mnt/ai-storage)",
        )

    ax.set_title("Internal and External Disk Space Used", color="white", pad=15)
    ax.set_xlabel("Date/Time (MM/DD HH:MM)", color="white")
    ax.set_ylabel("Disk Used (%)", color="white")
    ax.set_ylim(0, 100)

    ax.grid(True, linestyle="--", alpha=0.35)
    ax.tick_params(axis="x", colors="white", rotation=45)
    ax.tick_params(axis="y", colors="white")

    for spine in ax.spines.values():
        spine.set_color("#94a3b8")

    handles, legend_labels = ax.get_legend_handles_labels()
    if handles:
        legend = ax.legend()
        for t in legend.get_texts():
            t.set_color("white")
        legend.get_frame().set_facecolor("#0f172a")
        legend.get_frame().set_edgecolor("#334155")

    plt.tight_layout()
    plt.savefig(chart_file, facecolor="#0f172a")
    plt.close()

    return f'<img class="chart" src="/graphs/{chart_file.name}?t={datetime.now().timestamp()}">'


def storage_panel_html():
    external_disk = get_external_storage_info()
    disks = [
        get_disk_info("/", "Internal Ubuntu Disk"),
        external_disk,
    ]

    html = """
<div class="panel">
<h2>Storage Health</h2>
<h3>Disk Usage Over Time</h3>
"""

    html += storage_chart_html(
        external_now=(
            float(external_disk["pct_num"])
            if external_disk["available"]
            else None
        )
    )

    html += """
<h3 style="margin-top:20px;">Current Disk Status</h3>
"""

    for d in disks:
        pct = d["pct_num"]
        usage_bar = ""
        if d["available"]:
            usage_bar = f"""
    <div style="background:#1e293b;border:1px solid #334155;border-radius:10px;overflow:hidden;height:26px;margin-top:12px;">
        <div style="width:{pct}%;background:{d['color']};height:26px;text-align:center;color:black;font-weight:bold;line-height:26px;">
            {d['pct']}
        </div>
    </div>
"""
        else:
            usage_bar = """
    <div style="background:#1e293b;border:1px dashed #64748b;border-radius:10px;
                padding:12px;margin-top:12px;color:#cbd5e1;">
        No usage percentage is plotted until this storage path is mounted.
    </div>
"""

        html += f"""
<div style="background:#0f172a;border:1px solid #334155;border-radius:10px;padding:15px;margin-top:12px;">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:15px;">
        <div style="font-size:18px;font-weight:bold;">
            {d['label']} <span style="color:#cbd5e1;">({d['path']})</span>
            <span style="background:{d['color']};color:black;border-radius:6px;padding:3px 8px;font-size:13px;margin-left:8px;">
                {d['status']}
            </span>
        </div>
        <div style="color:#cbd5e1;font-weight:bold;">
            {d['pct'] + ' used' if d['available'] else 'Unavailable'}
        </div>
    </div>

    {usage_bar}

    <div style="display:flex;justify-content:space-between;color:#e5e7eb;margin-top:10px;font-size:15px;">
        <div><b>Used:</b> {d['used']}</div>
        <div><b>Free:</b> {d['free']}</div>
        <div><b>Total:</b> {d['total']}</div>
    </div>
    {
        '<div style="color:#cbd5e1;margin-top:8px;font-size:14px;">'
        f"Read-only source: {html_module.escape(d.get('source', 'local'))} "
        f"({html_module.escape(d.get('filesystem', 'local'))}) on "
        f"{html_module.escape(d.get('remote_host', 'this host'))}"
        '</div>'
        if d.get('remote_host')
        else ''
    }
</div>
"""

    html += """
<div style="display:flex;gap:30px;justify-content:center;margin-top:16px;color:#e5e7eb;">
    <div><span style="display:inline-block;width:14px;height:14px;background:#22c55e;border-radius:4px;"></span> Healthy (&lt; 80%)</div>
    <div><span style="display:inline-block;width:14px;height:14px;background:#facc15;border-radius:4px;"></span> Warning (80% - 90%)</div>
    <div><span style="display:inline-block;width:14px;height:14px;background:#ef4444;border-radius:4px;"></span> Critical (&gt; 90%)</div>
</div>
</div>
"""
    return html



def parse_number(value):
    if value is None:
        return None

    text = str(value).strip()

    percent_match = re.search(r"\((\d+(?:\.\d+)?)%\)", text)
    if percent_match:
        return float(percent_match.group(1))

    match = re.search(r"-?\d+(?:\.\d+)?", text)
    if match:
        return float(match.group(0))

    return None


def get_latest_summary():
    if not REPORT_DIR.exists():
        return None
    summaries = sorted(REPORT_DIR.glob("home_ai_summary_*.txt"))
    return summaries[-1] if summaries else None


def classify_warning(text):
    t = text.lower()

    if (
        "device-pair" in t
        or "notify poll failed" in t
        or "active pairing error" in t
        or "pairing error detected" in t
    ) and "no active pairing error detected" not in t:
        return {
            "title": "Gateway Communication Warning",
            "color": "#d6a800",
            "details": "The OpenClaw gateway could not verify device pairing state. AI inference still appears operational."
        }

    if "connection refused" in t or "max retries exceeded" in t or "11434" in t:
        return {
            "title": "Ollama Connectivity Warning",
            "color": "#cc8400",
            "details": "The dashboard could not reach the Ollama API endpoint."
        }

    return {
        "title": "System Status",
        "color": "#555555",
        "details": text
    }


def check_ai_drift():
    latest = get_latest_summary()

    if not latest:
        return None

    try:
        content = latest.read_text(errors="ignore")
    except Exception:
        return None

    warning_lines = []

    for line in content.splitlines():
        lower = line.lower()
        if (
            "failed" in lower
            or "error" in lower
            or "degradation" in lower
            or "connection refused" in lower
            or "notify poll failed" in lower
            or "not connected" in lower
        ):
            warning_lines.append(line)

    return {
        "file": str(latest),
        "warnings": warning_lines
    }


def test_model(model_name):
    is_embedding_model = model_name.startswith("nomic-embed-")
    endpoint = "/api/embed" if is_embedding_model else "/api/generate"
    payload = (
        {"model": model_name, "input": "OpenClaw health check"}
        if is_embedding_model
        else {
            "model": model_name,
            "prompt": "Reply with exactly: Ollama is working correctly.",
            "stream": False,
        }
    )

    try:
        response = requests.post(
            f"{OLLAMA_HOST}{endpoint}",
            json=payload,
            timeout=OLLAMA_TIMEOUT_SECONDS
        )
        response.raise_for_status()

        data = response.json()
        if is_embedding_model:
            embeddings = data.get("embeddings", [])
            if not embeddings or not embeddings[0]:
                raise ValueError("Ollama returned no embedding vector")
            text = f"Embedding check passed ({len(embeddings[0])} dimensions)"
        else:
            text = data.get("response", "").strip().split("\n")[0]
            if not text:
                if data.get("done") is True:
                    text = "Generation check passed"
                else:
                    raise ValueError("Ollama returned an incomplete response")

        if len(text) > 120:
            text = text[:120]

        return {
            "success": True,
            "response": text
        }

    except requests.exceptions.Timeout:
        return {
            "success": False,
            "status": "timeout",
            "response": (
                "Installed model did not complete within "
                f"{OLLAMA_TIMEOUT_SECONDS:g} seconds"
            ),
        }
    except Exception as e:
        return {
            "success": False,
            "status": "failed",
            "response": str(e)
        }


def model_status_panel_html(ollama, run_live_checks=False):
    output = "<div class='panel'><h2>Model Status</h2><div class='output'>"

    if not ollama["connected"]:
        output += (
            "\nAI model server is unreachable.\n"
            f"Endpoint: {html_module.escape(ollama['endpoint'])}\n"
            f"Reason: {html_module.escape(ollama['error'])}\n"
            "Individual model tests were skipped because they would all "
            "repeat the same connection failure.\n"
        )
    else:
        installed_models = set(ollama.get("model_names", []))
        for model in MODELS:
            output += f"\n{model}\n"
            if model not in installed_models:
                output += (
                    "FAILED: Model is not installed on the configured "
                    "AI server.\n"
                )
                continue
            if not run_live_checks:
                capability = (
                    "embedding"
                    if model.startswith("nomic-embed-")
                    else "generation"
                )
                output += (
                    f"AVAILABLE: Installed {capability} model. "
                    "Live test not requested.\n"
                )
                continue
            result = test_model(model)
            if result["success"]:
                output += (
                    f"SUCCESS: {html_module.escape(result['response'])}\n"
                )
            elif result.get("status") == "timeout":
                output += (
                    f"WARNING: {html_module.escape(result['response'])}\n"
                )
            else:
                output += (
                    f"FAILED: {html_module.escape(result['response'])}\n"
                )

    output += "</div>"
    if ollama["connected"] and not run_live_checks:
        output += """
<form method="GET" action="/model-health" style="margin-top:14px;">
  <button type="submit">Run Live Model Tests</button>
</form>
"""
    elif run_live_checks:
        output += """
<p style="margin-bottom:0;">
  <a href="/" style="color:#93c5fd;font-weight:bold;">
    Return to fast inventory status
  </a>
</p>
"""
    return output + "</div>"


@app.route("/api/model-health/live")
def live_model_health_api():
    ollama = get_m4_ollama_status()
    if not ollama["connected"]:
        return {
            "server_connected": False,
            "endpoint": ollama["endpoint"],
            "error": ollama["error"],
            "models": [],
        }

    installed_models = set(ollama.get("model_names", []))
    results = []
    for model in MODELS:
        if model not in installed_models:
            results.append(
                {
                    "model": model,
                    "status": "failed",
                    "message": "Model is not installed on the configured AI server.",
                }
            )
            continue

        result = test_model(model)
        results.append(
            {
                "model": model,
                "status": (
                    "success"
                    if result["success"]
                    else result.get("status", "failed")
                ),
                "message": result["response"],
            }
        )

    return {
        "server_connected": True,
        "endpoint": ollama["endpoint"],
        "models": results,
    }


@app.route("/model-health")
def live_model_health_page():
    body = """
<div class="panel">
  <h2>Live Model Tests</h2>
  <p id="live-test-progress" style="color:#fbbf24;font-weight:bold;">
    Tests are running. Large models can take several minutes to load.
  </p>
  <div id="live-test-results" class="output">
Connecting to the configured AI server...
  </div>
  <p style="margin-bottom:0;">
    <a href="/" style="color:#93c5fd;font-weight:bold;">
      Return to Dashboard
    </a>
  </p>
</div>
<script>
const progress = document.getElementById("live-test-progress");
const results = document.getElementById("live-test-results");

fetch("/api/model-health/live")
  .then((response) => {
    if (!response.ok) {
      throw new Error(`Health request failed with HTTP ${response.status}`);
    }
    return response.json();
  })
  .then((report) => {
    if (!report.server_connected) {
      progress.textContent = "AI model server is unreachable.";
      progress.style.color = "#ef4444";
      results.textContent =
        `Endpoint: ${report.endpoint}\\nReason: ${report.error}`;
      return;
    }

    const lines = [`Endpoint: ${report.endpoint}`, ""];
    for (const item of report.models) {
      const label = item.status === "success"
        ? "SUCCESS"
        : item.status === "timeout"
          ? "WARNING"
          : "FAILED";
      lines.push(`${item.model}`);
      lines.push(`${label}: ${item.message}`);
      lines.push("");
    }
    results.textContent = lines.join("\\n");
    const failures = report.models.filter(
      (item) => item.status === "failed"
    ).length;
    const warnings = report.models.filter(
      (item) => item.status === "timeout"
    ).length;
    progress.textContent =
      `Tests complete: ${report.models.length - failures - warnings} passed, ` +
      `${warnings} warning(s), ${failures} failure(s).`;
    progress.style.color = failures ? "#ef4444" : warnings ? "#fbbf24" : "#22c55e";
  })
  .catch((error) => {
    progress.textContent = "Live model tests could not complete.";
    progress.style.color = "#ef4444";
    results.textContent = error.message;
  });
</script>
"""
    return ranchbrain_shell("Live Model Tests", body)


def find_column(rows, names):
    if not rows:
        return None

    headers = list(rows[0].keys())

    for name in names:
        if name in headers:
            return name

    for header in headers:
        h = header.lower()
        for name in names:
            if name.lower() in h:
                return header

    return None


def make_chart(title, rows, column_names, filename, ylabel):
    column = find_column(rows, column_names)

    if not column:
        print("Missing trend column for", title)
        return None

    points = []

    for index, row in enumerate(rows):
        value = parse_number(row.get(column))
        if value is not None:
            points.append((index, value))

    if len(points) < 2:
        print("Not enough valid values for", title)
        return None

    x = [p[0] for p in points]
    y = [p[1] for p in points]

    plt.figure(figsize=(10, 3.2))
    plt.plot(x, y, marker="o", linewidth=1.5)

    plt.title(title)
    plt.ylabel(ylabel)
    plt.xlabel("Date/Time")
    plt.xticks(rotation=45, ha="right")

    tick_step = max(1, len(x) // 6)
    tick_positions = x[::tick_step]
    tick_labels = [str(pos) for pos in tick_positions]

    plt.xticks(tick_positions, tick_labels)
    plt.grid(True, alpha=0.35)
    plt.gca().xaxis.set_major_formatter(mdates.DateFormatter('%m/%d %H:%M'))
    plt.gcf().autofmt_xdate(rotation=45)
    plt.tight_layout()

    output_file = GRAPH_DIR / filename
    plt.savefig(output_file, dpi=120)
    plt.close()

    return filename




def check_service(name, command):
    result = run_command(command).lower()

    if (
        "active" in result
        or "running" in result
        or "healthy" in result
        or "pong" in result
        or "ok" in result
    ):
        return (name, "Connected", "#16a34a")

    return (name, "Offline / Warning", "#b91c1c")


def build_system_health():
    checks = []

    checks.append(
        check_service(
            "OpenClaw Gateway",
            "systemctl --user is-active openclaw-gateway.service"
        )
    )

    checks.append(
        check_service(
            "OpenClaw Listener",
            "systemctl --user is-active openclaw-listener.service"
        )
    )

    checks.append(
        check_service(
            "Docker",
            "systemctl is-active docker"
        )
    )

    checks.append(
        check_service(
            "Redis",
            "docker ps --format '{{.Names}}' | grep redis"
        )
    )

    checks.append(
        check_service(
            "PostgreSQL",
            "docker ps --format '{{.Names}}' | grep postgres"
        )
    )

    checks.append(
        check_service(
            "Home Assistant",
            "docker ps --format '{{.Names}}' | grep homeassistant"
        )
    )

    checks.append(
        check_service(
            "Scrypted",
            "docker ps --format '{{.Names}}' | grep scrypted"
        )
    )

    checks.append(
        check_service(
            "Ollama API",
            "curl -s http://127.0.0.1:11434/api/tags"
        )
    )

    return checks




def collect_trend_sample():
    script = Path.home() / "ai/projects/openclaw/tools/home_manager/collect_trends.sh"
    try:
        result = subprocess.run(
            ["/usr/bin/bash", str(script)],
            cwd=str(Path.home() / "ai/projects/openclaw"),
            capture_output=True,
            text=True,
            timeout=90,
        )
        return {
            "success": result.returncode == 0,
            "message": (result.stdout + result.stderr).strip()[-1200:],
        }
    except Exception as e:
        return {
            "success": False,
            "message": str(e),
        }





def generate_trend_charts():
    if not TREND_FILE.exists():
        return []

    GRAPH_DIR.mkdir(parents=True, exist_ok=True)

    try:
        with TREND_FILE.open() as f:
            rows = list(csv.DictReader(f))
    except Exception:
        return []

    if not rows:
        return []

    time_col = find_column(rows, ["timestamp", "time", "datetime", "date"])
    recent_rows = rows[-24:]

    labels = []
    for row in recent_rows:
        raw_time = row.get(time_col, "") if time_col else ""

        try:
            dt = datetime.strptime(raw_time, "%Y-%m-%d %H:%M:%S")
            labels.append(dt.strftime("%m/%d %H:%M"))
        except Exception:
            labels.append(raw_time or datetime.now().strftime("%m/%d %H:%M"))

    def values_for(column_name):
        col = find_column(rows, [column_name])
        if not col:
            return None

        values = []
        last_good = None

        for row in rows:
            v = parse_number(row.get(col))
            if v is not None and v > 0:
                last_good = v

        for row in recent_rows:
            v = parse_number(row.get(col))
            if v is not None and v > 0:
                last_good = v
                values.append(v)
            elif last_good is not None:
                values.append(last_good)
            else:
                values.append(0)

        return values

    def style_chart(ax, title, ylabel, percent_axis=False):
        ax.set_title(title, color="white", pad=15)
        ax.set_xlabel("Date/Time (MM/DD HH:MM)", color="white")
        ax.set_ylabel(ylabel, color="white")

        if percent_axis:
            ax.set_ylim(0, 100)

        ax.grid(True, linestyle="--", alpha=0.35)
        ax.tick_params(axis="x", colors="white", rotation=45)
        ax.tick_params(axis="y", colors="white")

        for spine in ax.spines.values():
            spine.set_color("#94a3b8")

        legend = ax.legend(loc="best")
        for item in legend.get_texts():
            item.set_color("white")
        legend.get_frame().set_facecolor("#0f172a")
        legend.get_frame().set_edgecolor("#334155")

    def save_line_chart(filename, title, ylabel, series, percent_axis=False):
        chart_path = GRAPH_DIR / filename

        plt.figure(figsize=(12, 4.8), facecolor="#0f172a")
        ax = plt.gca()
        ax.set_facecolor("#0f172a")

        for label, values in series:
            ax.plot(labels, values, marker="o", linewidth=2, label=label)

        style_chart(ax, title, ylabel, percent_axis=percent_axis)
        plt.tight_layout()
        plt.savefig(chart_path, facecolor="#0f172a")
        plt.close()

        return filename

    chart_files = []

    latency = values_for("ollama_latency_ms")
    if latency:
        chart_files.append(
            save_line_chart(
                "ollama_latency.png",
                "Intel Mini Ollama Latency",
                "Latency (ms)",
                [("Intel Mini Ollama Latency", latency)],
            )
        )

    intel_mem = values_for("mem_used_gib")
    m4_mem = values_for("m4_mem_used_gib")
    memory_series = []

    if intel_mem:
        memory_series.append(("Intel Mini Memory Usage", intel_mem))

    if m4_mem:
        memory_series.append(("M4 Memory Usage", m4_mem))

    if memory_series:
        chart_files.append(
            save_line_chart(
                "memory_usage.png",
                "Memory Usage Over Time (Both Computers)",
                "Memory Used (GiB)",
                memory_series,
            )
        )

    m4_cpu = values_for("m4_cpu_used_pct")
    if m4_cpu:
        chart_files.append(
            save_line_chart(
                "m4_cpu_usage.png",
                "M4 CPU Usage",
                "CPU Used (%)",
                [("M4 CPU Usage", m4_cpu)],
                percent_axis=True,
            )
        )

    m4_disk = values_for("m4_disk_used_pct")
    if m4_disk:
        chart_files.append(
            save_line_chart(
                "m4_disk_usage.png",
                "M4 Disk Usage",
                "Disk Used (%)",
                [("M4 Disk Usage", m4_disk)],
                percent_axis=True,
            )
        )

    m4_ollama = values_for("m4_ollama_response_ms")
    if m4_ollama:
        chart_files.append(
            save_line_chart(
                "m4_ollama_response.png",
                "M4 Ollama Response Time",
                "Response Time (ms)",
                [("M4 Ollama Response Time", m4_ollama)],
            )
        )

    return chart_files

@app.route("/graphs/<path:filename>")
def graphs(filename):
    return send_from_directory(GRAPH_DIR, filename)







def ai_routing_telemetry_panel_html():
    report_path = REPORT_DIR / "ai_intelligence" / "routing-telemetry-latest.json"
    text_path = REPORT_DIR / "ai_intelligence" / "routing-telemetry-latest.txt"

    if not report_path.exists():
        return """
        <div class='panel'>
            <h2>AI Routing Telemetry</h2>
            <div class='warning-box'>
                No routing telemetry report found yet.<br><br>
                Generate with tools/ai_intelligence/report_routing_telemetry.py
            </div>
        </div>
        """

    try:
        summary = json.loads(report_path.read_text(encoding="utf-8"))
    except Exception as exc:
        return f"""
        <div class='panel'>
            <h2>AI Routing Telemetry</h2>
            <div class='warning-box'>
                Failed to read routing telemetry report.<br><br>
                {html.escape(str(exc)[:160])}
            </div>
        </div>
        """

    report_age_seconds = max(0, int(time.time() - report_path.stat().st_mtime))
    report_age_minutes = report_age_seconds // 60
    report_is_stale = report_age_seconds > 600
    status = str(summary.get("status", "unknown"))
    display_status = "stale" if report_is_stale else status
    configured = summary.get("configured_versus_observed", {})
    matched_count = int(configured.get("matched", 0) or 0)
    drift_count = int(configured.get("drift", 0) or 0)
    not_observed_count = int(configured.get("not_observed", 0) or 0)
    failover_count = int(summary.get("recent_failover_count", 0) or 0)
    failure_count = int(summary.get("recent_failure_count", 0) or 0)
    observations = summary.get("recent_observations", [])
    if not isinstance(observations, list):
        observations = []
    failover_observations = [
        item
        for item in observations
        if isinstance(item, dict) and item.get("failover_occurred")
    ]
    test_failovers = [
        item
        for item in failover_observations
        if str(item.get("request_id", "")).startswith(("dev-", "test-"))
    ]
    live_failover_count = max(0, failover_count - len(test_failovers))

    if report_is_stale:
        operator_status = "Report needs refresh"
        color = "#f97316"
        operator_summary = (
            "The telemetry report is more than 10 minutes old. "
            "Its routing observations may no longer describe current activity."
        )
        action_text = "Refresh telemetry before making a routing decision."
    elif failure_count > 0:
        operator_status = "Action required"
        color = "#ef4444"
        operator_summary = (
            f"{failure_count} recent AI request failure(s) were recorded."
        )
        action_text = "Review the failed requests and model-host health."
    elif live_failover_count > 0:
        operator_status = "Fallback used successfully"
        color = "#fbbf24"
        operator_summary = (
            f"{live_failover_count} live request(s) used a fallback model, "
            "and no failed requests were recorded."
        )
        action_text = (
            "No immediate action is required; review the fallback cause "
            "if it was unexpected."
        )
    elif test_failovers:
        operator_status = "Development test recorded"
        color = "#60a5fa"
        operator_summary = (
            f"{len(test_failovers)} successful development fallback test(s) "
            "were recorded. No failed requests were recorded."
        )
        action_text = "No action is required when this test was expected."
    elif drift_count:
        operator_status = "Routing difference detected"
        color = "#fbbf24"
        operator_summary = (
            f"{drift_count} component(s) used a model other than the "
            "configured primary. No failed requests were recorded."
        )
        action_text = "Review the routing difference if it was unexpected."
    else:
        operator_status = "Healthy"
        color = "#7CFC00"
        operator_summary = "No routing failures or unexpected fallbacks were recorded."
        action_text = "No action is required."

    difference_items = []
    for row in configured.get("rows", []):
        if not isinstance(row, dict) or row.get("deployment_status") != "drift":
            continue
        component = str(row.get("component_id", "unknown")).replace("_", " ").title()
        expected = str(row.get("configured_primary_model", "unknown"))
        observed = str(row.get("latest_observed_model", "unknown"))
        difference_items.append(
            f"<li><b>{html.escape(component)}:</b> configured for "
            f"{html.escape(expected)}, observed {html.escape(observed)}</li>"
        )
    differences_html = (
        "<ul>" + "".join(difference_items) + "</ul>"
        if difference_items
        else "<p>No model-routing differences were recorded.</p>"
    )
    preview = ""
    if text_path.exists():
        preview = html.escape(
            "\n".join(text_path.read_text(encoding="utf-8").splitlines()[:12])
        )

    return f"""
    <div class='panel'>
        <h2>AI Routing Telemetry</h2>
        <div class='status-box'>
            <div style="font-size:20px;font-weight:bold;color:{color};">
                {html.escape(operator_status)}
            </div>
            <p>{html.escape(operator_summary)}</p>
            <p><b>What to do:</b> {html.escape(action_text)}</p>
            <b>Report age:</b> {report_age_minutes} minute(s)<br>
            <b>Updated:</b> {html.escape(datetime.fromtimestamp(report_path.stat().st_mtime).strftime('%Y-%m-%d %H:%M:%S'))}
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-top:14px;">
            <div class="status-box"><b>Failed requests</b><br>{failure_count}</div>
            <div class="status-box"><b>Successful fallback tests</b><br>{len(test_failovers)}</div>
            <div class="status-box"><b>Live fallbacks</b><br>{live_failover_count}</div>
            <div class="status-box"><b>Routing differences</b><br>{drift_count}</div>
        </div>
        <div class="status-box" style="margin-top:14px;">
            <b>Model-routing differences</b>
            {differences_html}
            <p style="color:#cbd5e1;">
                {not_observed_count} configured component(s) had no request
                telemetry in this reporting window. “Not observed” means no
                request was recorded; it does not mean the component failed.
            </p>
        </div>
        <details style="margin-top:14px;">
            <summary style="cursor:pointer;font-weight:bold;">Technical details</summary>
            <div class='output'>{preview or 'No text summary available.'}</div>
            <p>
                Matched: {matched_count} · Drift: {drift_count} ·
                Not observed: {not_observed_count} ·
                Raw status: {html.escape(display_status)}
            </p>
        </details>
    </div>
    """


def m4_ai_health_panel_html(ollama=None):
    ollama = ollama or get_m4_ollama_status()
    ollama_status = "Online" if ollama["connected"] else "Offline"
    ollama_color = "#22c55e" if ollama["connected"] else "#ef4444"
    response_ms = ollama.get("response_ms", "unknown")
    model_count = ollama.get("model_count", "unknown")
    model_names = ollama.get("detected_models") or ollama.get("error", "unknown")

    m4 = {
        "reachable": False,
        "memory_used_gib": "unknown",
        "memory_total_gib": "unknown",
        "memory_percent": "unknown",
        "ollama_process": "unknown",
        "ollama_cpu": "unknown",
        "uptime": "unknown",
        "error": "",
    }

    remote_script = r"""
python3 - <<'PY_REMOTE'
import subprocess, re, json

result = {}

try:
    vm = subprocess.check_output(["vm_stat"], text=True)
    memsize = int(subprocess.check_output(["sysctl", "-n", "hw.memsize"], text=True).strip())
    page_size = int(re.search(r"page size of (\d+) bytes", vm).group(1))

    values = {}
    for line in vm.splitlines():
        if ":" in line:
            key, val = line.split(":", 1)
            m = re.search(r"(\d+)", val.replace(".", ""))
            if m:
                values[key.strip()] = int(m.group(1))

    free = values.get("Pages free", 0)
    spec = values.get("Pages speculative", 0)
    used_bytes = memsize - ((free + spec) * page_size)

    used_gib = used_bytes / (1024**3)
    total_gib = memsize / (1024**3)
    pct = (used_gib / total_gib) * 100 if total_gib else 0

    result["memory_used_gib"] = f"{used_gib:.1f}"
    result["memory_total_gib"] = f"{total_gib:.1f}"
    result["memory_percent"] = f"{pct:.0f}%"
except Exception as e:
    result["memory_error"] = str(e)

try:
    pids = subprocess.check_output("pgrep -f '[o]llama' || true", shell=True, text=True).strip().splitlines()
    result["ollama_process"] = "Running" if pids else "Not running"

    if pids:
        pid = pids[0]
        cpu = subprocess.check_output(f"ps -p {pid} -o %cpu= | awk '{{print $1}}'", shell=True, text=True).strip()
        result["ollama_cpu"] = cpu + "%"
    else:
        result["ollama_cpu"] = "0%"
except Exception as e:
    result["ollama_process"] = "unknown"
    result["ollama_cpu"] = "unknown"
    result["process_error"] = str(e)

try:
    result["uptime"] = subprocess.check_output("uptime | sed 's/^ *//'", shell=True, text=True).strip()
except Exception:
    result["uptime"] = "unknown"

print(json.dumps(result))
PY_REMOTE
"""

    try:
        out = subprocess.check_output(
            [
                "ssh",
                "-i", M4_SSH_KEY,
                "-o", "BatchMode=yes",
                "-o", "ConnectTimeout=5",
                f"{M4_SSH_USER}@{M4_SSH_HOST}",
                remote_script,
            ],
            text=True,
            timeout=10,
            stderr=subprocess.STDOUT,
        ).strip()

        remote = json.loads(out.splitlines()[-1])
        m4.update(remote)
        m4["reachable"] = True
    except Exception as e:
        m4["error"] = str(e)[:160]

    ssh_status = "Available" if m4["reachable"] else "Unavailable"
    ssh_color = "#22c55e" if m4["reachable"] else "#fbbf24"

    html = f"""
<div class='panel'>
<h2>🧠 M4 AI Server Health</h2>

<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:14px;">

<div style="background:#0f172a;border:1px solid #334155;border-radius:10px;padding:15px;">
<b>Remote metrics (optional)</b><br><br>
<span style="color:{ssh_color};font-weight:bold;">{ssh_status}</span><br>
M4 SSH host: {html_module.escape(M4_SSH_HOST)}
</div>

<div style="background:#0f172a;border:1px solid #334155;border-radius:10px;padding:15px;">
<b>Ollama API</b><br><br>
<span style="color:{ollama_color};font-weight:bold;">{ollama_status}</span><br>
Response: {response_ms} ms
</div>

<div style="background:#0f172a;border:1px solid #334155;border-radius:10px;padding:15px;">
<b>M4 Memory</b><br><br>
Used: {m4['memory_used_gib']} GiB / {m4['memory_total_gib']} GiB<br>
Percent: {m4['memory_percent']}
</div>

<div style="background:#0f172a;border:1px solid #334155;border-radius:10px;padding:15px;">
<b>Ollama Process</b><br><br>
Status: {m4['ollama_process']}<br>
CPU: {m4['ollama_cpu']}
</div>

</div>

<div class="output" style="margin-top:15px;">
Models Loaded: {model_count}

Detected Models:
{model_names}

M4 Uptime:
{m4['uptime']}

Errors:
{m4['error'] if m4['error'] else 'None'}
</div>
</div>
"""
    return html



def get_m4_ollama_status():
    endpoint = f"{OLLAMA_HOST}/api/tags"
    start = time.time()

    try:
        r = requests.get(endpoint, timeout=5)
        r.raise_for_status()
        data = r.json()
        response_ms = int((time.time() - start) * 1000)

        names = []
        for item in data.get("models", []):
            name = item.get("name", "")
            if name:
                names.append(name)

        primary = "gpt-oss:20b" if "gpt-oss:20b" in names else (names[0] if names else "Unknown")
        detected = ", ".join(names)

        return {
            "connected": True,
            "endpoint": endpoint,
            "model_count": len(names),
            "display_count": len(names),
            "primary": primary,
            "detected_models": detected,
            "model_names": names,
            "response_ms": response_ms,
        }

    except Exception as e:
        return {
            "connected": False,
            "endpoint": endpoint,
            "error": str(e),
            "model_count": 0,
            "display_count": 0,
            "primary": "Unavailable",
            "detected_models": "",
            "model_names": [],
            "response_ms": "failed",
        }



def latest_backup_html():
    backup_dir = Path.home() / "openclaw-dashboard-backups"
    backup_dir.mkdir(parents=True, exist_ok=True)

    backups = sorted(
        backup_dir.glob("openclaw-dashboard-backup-*.tar.gz"),
        key=lambda x: x.stat().st_mtime,
        reverse=True
    )

    if not backups:
        return "<div class='warning-box' style='margin-top:10px;'><b>Last Verified Backup:</b> No dashboard backup found yet.</div>"

    latest = backups[0]
    dt = datetime.fromtimestamp(latest.stat().st_mtime).strftime("%Y-%m-%d %H:%M:%S")
    size_mb = latest.stat().st_size / (1024 * 1024)

    return f"""
    <div class='status-box' style='margin-top:10px;'>
        <b>Backup Verified</b><br><br>
        <b>Name:</b> {latest.name}<br>
        <b>Date:</b> {dt}<br>
        <b>Size:</b> {size_mb:.2f} MB
    </div>
    """


RANCHBRAIN_ENV_FILES = (
    Path(
        os.environ.get(
            "OPENCLAW_RANCHBRAIN_ENV_FILE",
            Path.home() / ".openclaw/credentials/chat-agent.env",
        )
    ),
    Path.home() / ".openclaw/credentials/ai-intelligence-dev.env",
)
RANCHBRAIN_REVIEW_TOOL = Path.home() / "ai/projects/openclaw/tools/ranchbrain/ranchbrain-review.py"
OPENCLAW_PYTHON = Path.home() / "ai/projects/openclaw/.venv/bin/python"


def load_ranchbrain_env():
    values = {}

    env_file = next(
        (path for path in RANCHBRAIN_ENV_FILES if path.is_file()),
        None,
    )
    if env_file is None:
        return values

    for raw_line in env_file.read_text().splitlines():
        line = raw_line.strip()

        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        values[key.strip()] = value.strip()

    return values


def ranchbrain_db():
    env = load_ranchbrain_env()

    return psycopg2.connect(
        host=env.get("OPENCLAW_DB_HOST", "127.0.0.1"),
        port=int(env.get("OPENCLAW_DB_PORT", "5432")),
        dbname=env.get("OPENCLAW_DB_NAME", "openclaw"),
        user=env.get("OPENCLAW_DB_USER", "openclaw"),
        password=env.get("OPENCLAW_DB_PASSWORD", ""),
        connect_timeout=8,
    )


def ranchbrain_schema_is_ready():
    conn = ranchbrain_db()
    cur = conn.cursor()
    try:
        cur.execute("SELECT to_regclass('public.long_term_memory');")
        row = cur.fetchone()
        return bool(row and row[0])
    finally:
        cur.close()
        conn.close()


def get_ranchbrain_counts():
    conn = ranchbrain_db()
    cur = conn.cursor()

    cur.execute("""
        SELECT
            COUNT(*) FILTER (WHERE category = 'ranchbrain_note'),
            COUNT(*) FILTER (WHERE category = 'ranchbrain_pending'),
            COUNT(*) FILTER (WHERE category = 'ranchbrain_rejected')
        FROM long_term_memory
        WHERE agent_name = 'RanchBrain';
    """)

    row = cur.fetchone()

    cur.close()
    conn.close()

    return {
        "approved": int(row[0]),
        "pending": int(row[1]),
        "rejected": int(row[2]),
    }


def get_ranchbrain_notes(category):
    conn = ranchbrain_db()
    cur = conn.cursor()

    cur.execute("""
        SELECT id, content, source, created_at
        FROM long_term_memory
        WHERE agent_name = 'RanchBrain'
          AND category = %s
        ORDER BY created_at DESC
        LIMIT 100;
    """, (category,))

    rows = cur.fetchall()

    cur.close()
    conn.close()

    return rows


def openclaw_shared_navigation():
    """Return the canonical navigation for OpenClaw dashboard pages."""
    links = (
        ("/", "Overview"),
        ("/ranchbrain", "RanchBrain"),
        ("/notes", "Vault"),
        ("/ai-scorecard?view=all", "All Models Scorecard"),
        ("/ai-scorecard", "Review Queue"),
        ("/documentation", "Foundational Documentation"),
        ("/pdf", "PDF"),
        ("/backup-recovery", "Backup & Recovery Center"),
    )

    link_style = (
        "background:#334155;"
        "color:white;"
        "text-decoration:none;"
        "padding:10px 14px;"
        "border-radius:7px;"
        "font-weight:bold;"
        "display:inline-block;"
    )

    anchors = "".join(
        f'<a href="{href}" style="{link_style}">{label}</a>'
        for href, label in links
    )

    return (
        '<div class="nav openclaw-shared-navigation" '
        'style="display:flex;gap:10px;flex-wrap:wrap;'
        'margin-bottom:20px;">'
        f"{anchors}"
        "</div>"
    )


def ranchbrain_shell(title, body):
    return f"""
<!DOCTYPE html>
<html>
<head>
<title>{html_module.escape(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body {{
  background:#1e293b;
  color:white;
  font-family:Arial,sans-serif;
  padding:20px;
}}
.nav {{
  display:flex;
  gap:10px;
  flex-wrap:wrap;
  margin-bottom:20px;
}}
.nav a {{
  background:#334155;
  color:white;
  text-decoration:none;
  padding:10px 14px;
  border-radius:7px;
  font-weight:bold;
}}
.panel {{
  background:#273549;
  padding:20px;
  border-radius:10px;
  margin-bottom:20px;
}}
.note {{
  background:#0f172a;
  border:1px solid #475569;
  border-radius:10px;
  padding:15px;
  margin-top:12px;
}}
.meta {{
  color:#cbd5e1;
  margin-top:10px;
  font-size:14px;
  overflow-wrap:anywhere;
}}
.output {{
  background:#020d24;
  padding:15px;
  border-radius:6px;
  white-space:pre-wrap;
  overflow-x:auto;
}}
.table-scroll {{
  width:100%;
  overflow-x:auto;
}}
table.dashboard-table {{
  width:100%;
  min-width:640px;
  border-collapse:collapse;
  table-layout:fixed;
}}
table.dashboard-table th,
table.dashboard-table td {{
  padding:11px 12px;
  text-align:left;
  vertical-align:top;
  border-bottom:1px solid #475569;
  overflow-wrap:anywhere;
}}
table.dashboard-table th {{
  color:#e2e8f0;
  background:#334155;
  border-bottom:2px solid #64748b;
  font-weight:bold;
}}
table.dashboard-table tbody tr:hover td {{
  background:#2f4057;
}}
table.dashboard-table code {{
  white-space:normal;
  overflow-wrap:anywhere;
}}
button {{
  border:0;
  border-radius:6px;
  padding:10px 14px;
  font-weight:bold;
  cursor:pointer;
}}
.approve {{ background:#22c55e; color:#052e16; }}
.reject {{ background:#ef4444; color:white; }}
</style>
</head>
<body>
{openclaw_shared_navigation()}
<h1>{html_module.escape(title)}</h1>
{body}
</body>
</html>
"""


@app.route("/ranchbrain")
def ranchbrain_dashboard():
    try:
        if not ranchbrain_schema_is_ready():
            body = """
<div class="panel" style="border-left:7px solid #fbbf24;">
  <h2>Development Database Setup Required</h2>
  <p>
    RanchBrain is connected to the approved development PostgreSQL service,
    but its <code>long_term_memory</code> schema has not been initialized.
  </p>
  <p>
    No production data was queried or copied, and no inferred schema was
    created. RanchBrain will remain read-only and unavailable here until an
    authoritative migration is added and approved for development.
  </p>
</div>
"""
            return ranchbrain_shell("RanchBrain", body)

        counts = get_ranchbrain_counts()
        approved = get_ranchbrain_notes("ranchbrain_note")

        body = f"""
<div class="panel">
  <h2>Knowledge Status</h2>
  <p>Approved: <b>{counts['approved']}</b></p>
  <p>Pending: <b>{counts['pending']}</b></p>
  <p>Rejected: <b>{counts['rejected']}</b></p>
  <p><a href="/ranchbrain/review">Open Review Page</a></p>
</div>

<div class="panel">
  <h2>Approved Notes</h2>
"""

        if not approved:
            body += "<p>No approved notes found.</p>"
        else:
            for memory_id, content, source, created_at in approved:
                body += f"""
<div class="note">
  <h3>Memory ID {memory_id}</h3>
  <div>{html_module.escape(str(content))}</div>
  <div class="meta">
    Created: {html_module.escape(str(created_at))}<br>
    File: {html_module.escape(str(source))}
  </div>
</div>
"""

        body += "</div>"

        return ranchbrain_shell("RanchBrain", body)

    except Exception as exc:
        return ranchbrain_shell(
            "RanchBrain",
            f"<div class='panel'>Error: {html_module.escape(str(exc))}</div>",
        ), 500


def run_review_action(action, memory_id):
    review_env = os.environ.copy()
    review_env.update(load_ranchbrain_env())
    result = subprocess.run(
        [
            str(OPENCLAW_PYTHON),
            str(RANCHBRAIN_REVIEW_TOOL),
            f"{action} {memory_id}",
        ],
        text=True,
        capture_output=True,
        timeout=180,
        env=review_env,
    )

    return result.returncode == 0


@app.route("/ranchbrain/review/approve", methods=["POST"])
def ranchbrain_review_approve():
    memory_id = request.form.get("memory_id", "").strip()

    if not memory_id.isdigit():
        return redirect("/ranchbrain/review")

    run_review_action("approve", memory_id)
    return redirect("/ranchbrain/review")


@app.route("/ranchbrain/review/reject", methods=["POST"])
def ranchbrain_review_reject():
    memory_id = request.form.get("memory_id", "").strip()

    if not memory_id.isdigit():
        return redirect("/ranchbrain/review")

    run_review_action("reject", memory_id)
    return redirect("/ranchbrain/review")


def load_json_object(path):
    if not path.is_file():
        return None

    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"Expected a JSON object: {path}")
    return value


def scorecard_action_is_local():
    return request.remote_addr in {"127.0.0.1", "::1"}


def scorecard_evaluation_records():
    evaluations = {}
    for path in sorted(AI_EVALUATION_PATH.parent.glob("evaluation-lab-*.json")):
        value = load_json_object(path)
        pipeline_id = str((value or {}).get("pipeline_id", ""))
        if pipeline_id:
            evaluations[pipeline_id] = {"path": path, "value": value}

    decisions = {}
    if AI_APPROVAL_PATH.parent.is_dir():
        for path in sorted(
            AI_APPROVAL_PATH.parent.glob("evaluation-approval-*.json")
        ):
            if path.name == AI_APPROVAL_PATH.name:
                continue
            value = load_json_object(path)
            pipeline_id = str((value or {}).get("pipeline_id", ""))
            if pipeline_id:
                decisions[pipeline_id] = value
    latest_decision = load_json_object(AI_APPROVAL_PATH)
    latest_pipeline = str((latest_decision or {}).get("pipeline_id", ""))
    if latest_pipeline:
        decisions[latest_pipeline] = latest_decision

    pending = [
        record
        for pipeline_id, record in evaluations.items()
        if pipeline_id not in decisions
    ]
    pending.sort(
        key=lambda record: (
            str(record["value"].get("created_at")
                or record["value"].get("generated_at")
                or ""),
            str(record["value"].get("pipeline_id", "")),
        )
    )
    return {
        "evaluations": evaluations,
        "decisions": decisions,
        "pending": pending,
    }


def scorecard_evaluation_path(pipeline_id):
    queue = scorecard_evaluation_records()
    record = queue["evaluations"].get(str(pipeline_id))
    return record["path"] if record else None


def scorecard_snapshot():
    queue = scorecard_evaluation_records()
    selected = queue["pending"][0] if queue["pending"] else None
    if selected:
        evaluation = selected["value"]
    else:
        evaluation = load_json_object(AI_EVALUATION_PATH)
    pipeline_id = str((evaluation or {}).get("pipeline_id", ""))
    approval = queue["decisions"].get(pipeline_id)
    candidates = load_json_object(AI_CANDIDATES_PATH)
    scorecard = load_json_object(AI_SCORECARD_PATH)
    model_registry = load_json_object(AI_MODEL_REGISTRY_PATH)

    if (
        evaluation
        and approval
        and str(approval.get("pipeline_id", ""))
        != str(evaluation.get("pipeline_id", ""))
    ):
        approval = None

    audits = []
    if AI_PROMOTION_DIR.is_dir():
        for path in sorted(
            AI_PROMOTION_DIR.glob("scorecard-promotion-*.json"),
            reverse=True,
        )[:20]:
            if path.name == "scorecard-promotion-latest.json":
                continue
            audit = load_json_object(path)
            if audit:
                audits.append(audit)

    eligible = []
    if evaluation:
        for benchmark_id, result in evaluation.get(
            "benchmark_reconciliation", {}
        ).items():
            if (
                result.get("promotion_eligible") is True
                and result.get("winner_passed_deterministic_validation")
                is True
                and result.get("final_winner")
            ):
                eligible.append(
                    {
                        "benchmark_id": benchmark_id,
                        "model": result["final_winner"],
                        "status": result.get("final_status", "unknown"),
                    }
                )

    decision_id = str((approval or {}).get("decision_id", ""))
    applied_decisions = {
        str(audit.get("decision_id", ""))
        for audit in audits
        if audit.get("status") == "applied"
    }

    return {
        "evaluation": evaluation,
        "approval": approval,
        "candidates": candidates,
        "scorecard": scorecard,
        "model_registry": model_registry,
        "eligible": eligible,
        "audits": audits,
        "promotion_applied": bool(decision_id and decision_id in applied_decisions),
        "pending_count": len(queue["pending"]),
        "completed_count": len(queue["decisions"]),
    }


def run_scorecard_action(tool, *arguments):
    result = subprocess.run(
        [str(AI_INTELLIGENCE_PYTHON), str(tool), *arguments],
        cwd=str(OPENCLAW_ROOT),
        capture_output=True,
        text=True,
        timeout=180,
        check=False,
    )
    output = (result.stdout + "\n" + result.stderr).strip()
    return result.returncode == 0, output[-2000:]


def scorecard_redirect(result, message):
    return redirect(
        "/ai-scorecard?result="
        + quote(result)
        + "&message="
        + quote(message[:1000])
    )


@app.route("/ai-scorecard")
def ai_scorecard():
    try:
        snapshot = scorecard_snapshot()
        evaluation = snapshot["evaluation"] or {}
        approval = snapshot["approval"] or {}
        pipeline_id = str(evaluation.get("pipeline_id", ""))
        decision_id = str(approval.get("decision_id", ""))
        decision = str(approval.get("decision", "none"))
        action_allowed = scorecard_action_is_local()
        result = str(request.args.get("result") or "")
        message = str(request.args.get("message") or "")

        notice = ""
        if message:
            color = "#14532d" if result == "success" else "#7f1d1d"
            notice = (
                f'<div class="panel" style="background:{color};">'
                f"{html_module.escape(message)}</div>"
            )

        eligible_rows = ""
        for candidate in snapshot["eligible"]:
            eligible_rows += f"""
<tr>
  <td>{html_module.escape(str(candidate['benchmark_id']))}</td>
  <td>{html_module.escape(str(candidate['model']))}</td>
  <td>{html_module.escape(str(candidate['status']))}</td>
  <td>
    <a href="/ai-scorecard/evidence/{quote(str(candidate['benchmark_id']))}?pipeline_id={
        quote(pipeline_id)
    }"
       style="display:inline-block;background:#2563eb;color:white;
              padding:10px 14px;border-radius:7px;text-decoration:none;
              font-weight:bold;white-space:nowrap;">
      View Decision Details
    </a>
  </td>
</tr>
"""
        if not eligible_rows:
            eligible_rows = "<tr><td colspan='4'>No promotion-eligible winners.</td></tr>"

        audit_rows = ""
        for audit in snapshot["audits"]:
            changes = ", ".join(
                f"{item.get('registry_id')}.{item.get('criterion')}: "
                f"{item.get('old_score')} → {item.get('new_score')}"
                for item in audit.get("changes", [])
            )
            audit_rows += f"""
<tr>
  <td>{html_module.escape(str(audit.get('applied_at', 'unknown')))}</td>
  <td>{html_module.escape(str(audit.get('decision_id', 'unknown')))}</td>
  <td>{html_module.escape(str(audit.get('status', 'unknown')))}</td>
  <td>{html_module.escape(changes or 'No changes recorded')}</td>
</tr>
"""
        if not audit_rows:
            audit_rows = "<tr><td colspan='4'>No scorecard promotions recorded.</td></tr>"

        all_model_rows = ""
        for model in (snapshot["model_registry"] or {}).get("models", []):
            model_id = str(model.get("id", "unknown"))
            has_scores = model_id in (snapshot["scorecard"] or {}).get("models", {})
            all_model_rows += f"""
<tr>
  <td style="padding:11px 12px;text-align:left;vertical-align:top;
             border-bottom:1px solid #475569;">{
      html_module.escape(str(model.get('display_name', model_id)))
  }</td>
  <td style="padding:11px 12px;text-align:left;vertical-align:top;
             border-bottom:1px solid #475569;overflow-wrap:anywhere;">
    <code>{html_module.escape(model_id)}</code>
  </td>
  <td style="padding:11px 12px;text-align:left;vertical-align:top;
             border-bottom:1px solid #475569;">{
      html_module.escape(str(model.get('provider', 'unknown')))
  }</td>
  <td style="padding:11px 12px;text-align:left;vertical-align:top;
             border-bottom:1px solid #475569;">{
      html_module.escape(str(model.get('deployment', 'unknown')))
  }</td>
  <td style="padding:11px 12px;text-align:left;vertical-align:top;
             border-bottom:1px solid #475569;overflow-wrap:anywhere;">{
      html_module.escape(str(model.get('status', 'unknown')))
  }</td>
  <td style="padding:11px 12px;text-align:left;vertical-align:top;
             border-bottom:1px solid #475569;">{
      'Available' if has_scores else 'Not scored'
  }</td>
</tr>
"""
        if not all_model_rows:
            all_model_rows = (
                "<tr><td colspan='6'>No registered models found.</td></tr>"
            )

        actions = """
<div class="panel">
  <h2>Approval Actions</h2>
  <p>Actions are disabled on non-local connections. Use an SSH tunnel to
  <code>127.0.0.1:5051</code> to approve, reject, or promote.</p>
</div>
"""
        if action_allowed:
            approval_forms = ""
            if pipeline_id and decision == "none":
                pipeline_value = html_module.escape(
                    pipeline_id,
                    quote=True,
                )
                approval_forms = f"""
<div style="display:flex;gap:18px;flex-wrap:wrap;">
  <form method="POST" action="/ai-scorecard/approve"
        style="flex:1;min-width:300px;padding:18px;border:2px solid #22c55e;
               border-radius:10px;background:#163329;box-sizing:border-box;">
    <h3 style="margin-top:0;">Approve this evaluation</h3>
    <p>Use when the evidence is acceptable. This records approval only;
       automatic routing stays off.</p>
    <input type="hidden" name="pipeline_id" value="{pipeline_value}">
    <input name="note" placeholder="Optional approval note"
           style="display:block;width:100%;margin:12px 0;padding:10px;
                  box-sizing:border-box;">
    <button class="approve" type="submit"
            style="width:100%;padding:12px;font-size:16px;">
      Approve Evaluation
    </button>
  </form>
  <form method="POST" action="/ai-scorecard/reject"
        style="flex:1;min-width:300px;padding:18px;border:2px solid #ef4444;
               border-radius:10px;background:#3a2025;box-sizing:border-box;">
    <h3 style="margin-top:0;">Reject this evaluation</h3>
    <p>Use when the evidence is incomplete or the recommendation should
       not be eligible for promotion.</p>
    <input type="hidden" name="pipeline_id" value="{pipeline_value}">
    <input name="note" placeholder="Optional rejection note"
           style="display:block;width:100%;margin:12px 0;padding:10px;
                  box-sizing:border-box;">
    <button class="reject" type="submit"
            style="width:100%;padding:12px;font-size:16px;">
      Reject Evaluation
    </button>
  </form>
</div>
"""
            elif decision == "approved" and decision_id and not snapshot["promotion_applied"]:
                promote_confirmation = html_module.escape(
                    f"PROMOTE {decision_id}",
                    quote=True,
                )
                approval_forms = f"""
<form method="POST" action="/ai-scorecard/promote"
      style="max-width:680px;padding:18px;border:2px solid #22c55e;
             border-radius:10px;background:#163329;">
  <h3 style="margin-top:0;">Promote the approved scorecard</h3>
  <p>This updates the official scorecard. It does not enable automatic
     routing.</p>
  <label for="promote-confirmation"><b>Confirmation</b></label>
  <div style="display:flex;gap:8px;margin:8px 0 12px;">
    <input id="promote-confirmation" name="confirmation"
           placeholder="{promote_confirmation}"
           style="flex:1;min-width:0;padding:10px;">
    <button type="button" data-confirmation="{promote_confirmation}"
            onclick="this.form.elements.confirmation.value=this.dataset.confirmation"
            style="background:#475569;">Fill promotion confirmation</button>
  </div>
  <button class="approve" type="submit"
          style="width:100%;padding:12px;font-size:16px;">
    Promote Approved Scorecard
  </button>
</form>
"""
            else:
                approval_forms = (
                    "<p>No action is currently available for this pipeline.</p>"
                )
            actions = f"""
<div class="panel">
  <h2>Approval Actions — Local Connection</h2>
  <p>Review the evidence, add an optional note, then choose Approve or
     Reject. Clicking the decision button is your confirmation, and every
     change remains audited.</p>
  {approval_forms}
</div>
"""

        if decision == "rejected" and request.args.get("view") != "all":
            completed_note = str(approval.get("note") or "").strip()
            note_line = (
                "<p><b>Decision note:</b> "
                + html_module.escape(completed_note)
                + "</p>"
                if completed_note
                else ""
            )
            body = f"""
<div class="panel" style="border:2px solid #64748b;">
  <h2>Review Queue</h2>
  <h3>No pending scorecard reviews</h3>
  <p>The latest evaluation has been rejected and preserved in the decision
     history. A newly generated evaluation will automatically appear here
     as the next Approve/Reject item.</p>
  <button type="button"
     onclick="window.alert('Nothing to review.');"
     style="display:inline-block;background:#2563eb;color:white;border:0;
            padding:11px 16px;border-radius:7px;cursor:pointer;
            font-weight:bold;font-size:16px;">Check for Next Review</button>
</div>
<div class="panel">
  <h2>Most Recent Completed Review</h2>
  <p><b>Pipeline:</b> {html_module.escape(pipeline_id)}</p>
  <p><b>Decision:</b> Rejected</p>
  <p><b>Decision ID:</b> {html_module.escape(decision_id)}</p>
  {note_line}
  <p><b>Production model changed:</b> No</p>
  <p><b>Automatic routing enabled:</b> No</p>
</div>
<div class="panel">
  <h2>Decision Details</h2>
  <p>The recommendation and its available evidence remain accessible for
     audit and review.</p>
  <a href="/ai-scorecard/evidence/{quote(next(iter(evaluation.get(
      'benchmark_reconciliation', {}
  )), ''))}?pipeline_id={quote(pipeline_id)}"
     style="display:inline-block;background:#475569;color:white;
            padding:10px 14px;border-radius:7px;text-decoration:none;
            font-weight:bold;">View Completed Decision Details</a>
</div>
"""
            return ranchbrain_shell("AI Model Scorecard Review Queue", body)

        queue_link = """
<div class="panel" style="border:2px solid #64748b;">
  <h2>Scorecard Navigation</h2>
  <a href="/ai-scorecard"
     style="display:inline-block;background:#2563eb;color:white;
            padding:11px 16px;border-radius:7px;text-decoration:none;
            font-weight:bold;">Open Approval / Reject Queue</a>
</div>
"""
        all_models_panel = ""
        if request.args.get("view") == "all":
            all_models_panel = f"""
<div class="panel">
  <h2>All Registered Models</h2>
  <p>This inventory includes production, fallback, evaluation, watch, local,
     and cloud models from the authoritative model registry.</p>
  <div class="table-scroll">
    <table class="dashboard-table all-models-table"
           style="width:100%;min-width:820px;border-collapse:collapse;
                  table-layout:fixed;">
      <colgroup>
        <col style="width:19%;">
        <col style="width:21%;">
        <col style="width:17%;">
        <col style="width:14%;">
        <col style="width:15%;">
        <col style="width:14%;">
      </colgroup>
      <tr>
        <th style="padding:12px;text-align:left;border-bottom:2px solid #64748b;">Model</th>
        <th style="padding:12px;text-align:left;border-bottom:2px solid #64748b;">Registry ID</th>
        <th style="padding:12px;text-align:left;border-bottom:2px solid #64748b;">Provider</th>
        <th style="padding:12px;text-align:left;border-bottom:2px solid #64748b;">Deployment</th>
        <th style="padding:12px;text-align:left;border-bottom:2px solid #64748b;">Status</th>
        <th style="padding:12px;text-align:left;border-bottom:2px solid #64748b;">Scorecard</th>
      </tr>
      {all_model_rows}
    </table>
  </div>
</div>
"""
        body = f"""
{notice}
{queue_link}
{all_models_panel}
<div class="panel">
  <h2>Current Evaluation</h2>
  <p><b>Pipeline:</b> {html_module.escape(pipeline_id or 'unavailable')}</p>
  <p><b>Decision:</b> {html_module.escape(decision)}</p>
  <p><b>Decision ID:</b> {html_module.escape(decision_id or 'none')}</p>
  <p><b>Official promotion:</b>
     {'Applied' if snapshot['promotion_applied'] else 'Not applied'}</p>
  <p><b>Automatic routing:</b> Not enabled by scorecard promotion.</p>
</div>
<div class="panel">
  <h2>Promotion-Eligible Winners</h2>
  <div class="table-scroll">
    <table class="dashboard-table winners-table">
      <colgroup>
        <col style="width:22%;"><col style="width:22%;">
        <col style="width:16%;"><col style="width:40%;">
      </colgroup>
      <tr><th>Benchmark</th><th>Model</th><th>Status</th><th>Evidence</th></tr>
      {eligible_rows}
    </table>
  </div>
</div>
{actions}
<div class="panel">
  <h2>Promotion Audit History</h2>
  <div class="table-scroll">
    <table class="dashboard-table audit-table">
      <colgroup>
        <col style="width:20%;"><col style="width:28%;">
        <col style="width:14%;"><col style="width:38%;">
      </colgroup>
      <tr><th>Applied</th><th>Decision</th><th>Status</th><th>Changes</th></tr>
      {audit_rows}
    </table>
  </div>
</div>
"""
        return ranchbrain_shell("AI Model Scorecard", body)
    except Exception as exc:
        return ranchbrain_shell(
            "AI Model Scorecard",
            f"<div class='panel'>Error: {html_module.escape(str(exc))}</div>",
        ), 500


@app.route("/ai-scorecard/evidence/<benchmark_id>")
def ai_scorecard_evidence(benchmark_id):
    requested_pipeline = str(request.args.get("pipeline_id") or "")
    requested_path = (
        scorecard_evaluation_path(requested_pipeline)
        if requested_pipeline
        else AI_EVALUATION_PATH
    )
    if requested_pipeline and requested_path is None:
        abort(404)
    evaluation = load_json_object(requested_path) or {}
    reconciliation = evaluation.get("benchmark_reconciliation", {})
    if benchmark_id not in reconciliation:
        abort(404)

    benchmark_report = load_json_object(AI_BENCHMARK_PATH) or {}
    validation_report = load_json_object(AI_VALIDATION_PATH) or {}
    review_report = load_json_object(AI_REVIEW_PATH) or {}
    decision = reconciliation.get(benchmark_id, {})
    selected_model = str(decision.get("final_winner") or "")

    benchmark_definition = next(
        (
            item
            for item in benchmark_report.get("benchmarks", [])
            if str(item.get("id", "")) == benchmark_id
        ),
        {},
    )
    prompt = str(benchmark_definition.get("prompt") or "")
    responses = [
        item
        for item in benchmark_report.get("results", [])
        if str(item.get("benchmark_id", "")) == benchmark_id
    ]
    validations = [
        item
        for item in validation_report.get("results", [])
        if str(item.get("benchmark_id", "")) == benchmark_id
    ]
    review = (
        review_report.get("benchmark_reviews", {}).get(benchmark_id, {})
    )
    is_fixture = evaluation.get("data_classification") == "ui_validation_fixture"
    source_count = sum(
        bool(value)
        for value in (benchmark_definition, responses, validations, review)
    )

    source_notice = (
        "<div class='panel' style='background:#713f12;'>"
        "<b>Development fixture:</b> this recommendation validates the "
        "dashboard workflow and is not a live benchmark decision.</div>"
        if is_fixture
        else ""
    )
    if source_count == 0:
        source_notice += (
            "<div class='panel' style='background:#7f1d1d;'>"
            "<b>Evidence unavailable:</b> no benchmark, validation, or "
            "review source reports exist for this decision. Do not approve "
            "it as a real model recommendation.</div>"
        )

    prompt_panel = f"""
<div class="panel">
  <h2>Original Benchmark Prompt</h2>
  <pre style="white-space:pre-wrap;">{
      html_module.escape(prompt or "Prompt source is unavailable.")
  }</pre>
</div>
"""

    response_panels = ""
    for item in responses:
        model = str(item.get("ollama_name") or "unknown")
        selected = " — selected winner" if model == selected_model else ""
        response_panels += f"""
<details class="panel" {'open' if model == selected_model else ''}>
  <summary style="cursor:pointer;font-size:18px;font-weight:bold;">
    {html_module.escape(model + selected)}
  </summary>
  <p><b>Status:</b> {html_module.escape(str(item.get('status', 'unknown')))}
     &nbsp; <b>Latency:</b>
     {html_module.escape(str(item.get('latency_seconds', 'unknown')))}s</p>
  <pre style="white-space:pre-wrap;">{
      html_module.escape(
          str(item.get("response") or item.get("error") or "No response recorded.")
      )
  }</pre>
</details>
"""
    if not response_panels:
        response_panels = (
            "<div class='panel'><h2>Model Responses</h2>"
            "<p>No model response source is available.</p></div>"
        )

    validation_rows = ""
    for item in validations:
        finding_text = "; ".join(
            f"{finding.get('severity', 'unknown')}: "
            f"{finding.get('message', finding.get('description', ''))}"
            for finding in item.get("findings", [])
        )
        validation_rows += f"""
<tr>
  <td>{html_module.escape(str(item.get('ollama_name', 'unknown')))}</td>
  <td>{'Passed' if item.get('passed_deterministic_checks') else 'Failed'}</td>
  <td>{html_module.escape(finding_text or 'No findings recorded')}</td>
</tr>
"""
    if not validation_rows:
        validation_rows = (
            "<tr><td colspan='3'>No deterministic validation source is "
            "available.</td></tr>"
        )

    scores = review.get("scores", {})
    findings = review.get("findings", {})
    review_rows = ""
    for model in sorted(set(scores) | set(findings)):
        review_rows += f"""
<tr>
  <td>{html_module.escape(str(model))}</td>
  <td>{html_module.escape(str(scores.get(model, 'unscored')))}</td>
  <td>{html_module.escape('; '.join(str(value) for value in findings.get(model, []))
                          or 'No reviewer findings recorded')}</td>
</tr>
"""
    if not review_rows:
        review_rows = (
            "<tr><td colspan='3'>No reviewer evidence is available.</td></tr>"
        )

    body = f"""
<p><a href="/ai-scorecard" style="color:#93c5fd;font-weight:bold;">
  ← Back to AI Model Scorecard
</a></p>
{source_notice}
<div class="panel">
  <h2>Decision Summary</h2>
  <p><b>Benchmark:</b> {html_module.escape(benchmark_id)}</p>
  <p><b>Selected model:</b>
     {html_module.escape(selected_model or 'No winner selected')}</p>
  <p><b>Final status:</b>
     {html_module.escape(str(decision.get('final_status', 'unknown')))}</p>
  <p><b>Deterministic validation passed:</b>
     {'Yes' if decision.get('winner_passed_deterministic_validation') else 'No'}</p>
  <p><b>Promotion eligible:</b>
     {'Yes' if decision.get('promotion_eligible') else 'No'}</p>
</div>
{prompt_panel}
<div class="panel">
  <h2>Deterministic Validation</h2>
  <div class="table-scroll">
    <table class="dashboard-table evidence-table">
      <colgroup>
        <col style="width:25%;"><col style="width:15%;"><col style="width:60%;">
      </colgroup>
      <tr><th>Model</th><th>Result</th><th>Findings</th></tr>
      {validation_rows}
    </table>
  </div>
</div>
<div class="panel">
  <h2>Reviewer Scores and Findings</h2>
  <div class="table-scroll">
    <table class="dashboard-table evidence-table">
      <colgroup>
        <col style="width:25%;"><col style="width:15%;"><col style="width:60%;">
      </colgroup>
      <tr><th>Model</th><th>Score</th><th>Findings</th></tr>
      {review_rows}
    </table>
  </div>
</div>
<h2>Original Model Responses</h2>
{response_panels}
"""
    return ranchbrain_shell(
        f"Evidence — {benchmark_id}",
        body,
    )


def require_local_scorecard_action():
    if not scorecard_action_is_local():
        abort(403)


@app.route("/ai-scorecard/approve", methods=["POST"])
def ai_scorecard_approve():
    require_local_scorecard_action()
    evaluation_path = scorecard_evaluation_path(request.form.get("pipeline_id", ""))
    evaluation = load_json_object(evaluation_path) if evaluation_path else {}
    pipeline_id = str(evaluation.get("pipeline_id", ""))
    if not pipeline_id or request.form.get("pipeline_id", "") != pipeline_id:
        return scorecard_redirect(
            "error",
            "The evaluation changed. Refresh the page and try again.",
        )
    note = str(request.form.get("note") or "").strip()[:500]
    arguments = [
        "--evaluation-file",
        str(evaluation_path),
        "--approve",
        pipeline_id,
    ]
    if note:
        arguments.extend(["--note", note])
    success, output = run_scorecard_action(AI_APPROVAL_TOOL, *arguments)
    if success:
        return redirect("/ai-scorecard")
    return scorecard_redirect("error", output)


@app.route("/ai-scorecard/reject", methods=["POST"])
def ai_scorecard_reject():
    require_local_scorecard_action()
    evaluation_path = scorecard_evaluation_path(request.form.get("pipeline_id", ""))
    evaluation = load_json_object(evaluation_path) if evaluation_path else {}
    pipeline_id = str(evaluation.get("pipeline_id", ""))
    if not pipeline_id or request.form.get("pipeline_id", "") != pipeline_id:
        return scorecard_redirect(
            "error",
            "The evaluation changed. Refresh the page and try again.",
        )
    note = str(request.form.get("note") or "").strip()[:500]
    arguments = [
        "--evaluation-file",
        str(evaluation_path),
        "--reject",
        pipeline_id,
    ]
    if note:
        arguments.extend(["--note", note])
    success, output = run_scorecard_action(AI_APPROVAL_TOOL, *arguments)
    if success:
        return redirect("/ai-scorecard")
    return scorecard_redirect("error", output)


@app.route("/ai-scorecard/promote", methods=["POST"])
def ai_scorecard_promote():
    require_local_scorecard_action()
    approval = load_json_object(AI_APPROVAL_PATH) or {}
    decision_id = str(approval.get("decision_id", ""))
    if (
        approval.get("decision") != "approved"
        or not decision_id
        or request.form.get("confirmation", "") != f"PROMOTE {decision_id}"
    ):
        return scorecard_redirect("error", "Promotion confirmation did not match.")
    success, output = run_scorecard_action(
        AI_PROMOTION_TOOL,
        "--apply",
        decision_id,
    )
    return scorecard_redirect("success" if success else "error", output)



# ===========================================================

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
{openclaw_shared_navigation()}
{body}</div></body></html>"""


@app.route("/pdf")
def pdf_center():
    body = """
<div class="document-viewer">
  <h2>PDF</h2>

  <p class="muted">
    Open the PDF library or upload a new PDF document.
  </p>

  <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:24px;">
    <a href="/documentation/pdfs"
       style="background:#334155;color:white;text-decoration:none;
              padding:16px 20px;border-radius:8px;font-weight:bold;
              display:inline-block;">
      PDF Library
    </a>

    <a href="/documentation/upload"
       style="background:#334155;color:white;text-decoration:none;
              padding:16px 20px;border-radius:8px;font-weight:bold;
              display:inline-block;">
      Upload PDF
    </a>
  </div>
</div>
"""

    return documentation_shell("PDF", body)


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



# =============================================================================
# AI STORAGE (Intel Mini 4TB) SHARED HELPERS
# =============================================================================

AI_STORAGE_ROOT = Path("/mnt/ai-storage")
RANCHBRAIN_VAULT_ROOT = AI_STORAGE_ROOT / "ranchbrain"

RANCHBRAIN_VAULT_SECTIONS = (
    "notes",
    "photos",
    "documents",
    "manuals",
    "Foundation",
    "invoices",
    "maps",
    "memories",
    "projects",
    "receipts",
    "reports",
    "assets",
)

RANCHBRAIN_VAULT_ROOT_FILES = (
    "Dashboard.md",
    "Property.md",
)

RANCHBRAIN_VAULT_SUFFIXES = {
    ".md",
    ".txt",
    ".pdf",
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".webp",
    ".heic",
}

RANCHBRAIN_VAULT_IMAGE_SUFFIXES = {
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".webp",
    ".heic",
}

RANCHBRAIN_VAULT_TEXT_SUFFIXES = {".md", ".txt"}


def ai_storage_is_local():
    local_mount = run_command(
        "findmnt -n -T /mnt/ai-storage -o TARGET",
        timeout=5,
    )
    return local_mount == "/mnt/ai-storage" and AI_STORAGE_ROOT.is_dir()


def ai_storage_ssh(remote_command, timeout=30, binary=False):
    result = subprocess.run(
        [
            "ssh",
            "-i",
            INTELMINI_STORAGE_KEY,
            "-o",
            "BatchMode=yes",
            "-o",
            "IdentitiesOnly=yes",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            "ConnectTimeout=8",
            f"{INTELMINI_STORAGE_USER}@{INTELMINI_STORAGE_HOST}",
            remote_command,
        ],
        capture_output=True,
        text=not binary,
        timeout=timeout,
        check=False,
    )

    if result.returncode != 0:
        detail = result.stderr or result.stdout or b""
        if isinstance(detail, bytes):
            detail = detail.decode("utf-8", errors="replace")
        lines = detail.strip().splitlines()
        raise RuntimeError(
            lines[-1] if lines else "Intel Mini storage probe failed."
        )

    return result.stdout


def ai_storage_validate_relative_path(
    relative_path,
    *,
    allowed_top_levels=None,
    allowed_suffixes=None,
    allow_root_files=None,
):
    text = str(relative_path or "").replace("\\", "/").strip().lstrip("/")

    if not text:
        raise ValueError("Missing document path.")

    parts = text.split("/")

    if any(
        (not part) or part in {".", ".."} or part.startswith(".")
        for part in parts
    ):
        raise ValueError("Invalid document path.")

    suffix = Path(parts[-1]).suffix.lower()

    if allowed_suffixes is not None and suffix not in allowed_suffixes:
        raise ValueError("Unsupported document type.")

    if len(parts) == 1:
        if allow_root_files is not None and parts[0] not in allow_root_files:
            raise ValueError("Invalid document path.")
        return text

    if allowed_top_levels is not None and parts[0] not in allowed_top_levels:
        raise ValueError("Invalid document section.")

    return text


def ai_storage_guess_mimetype(path_name):
    suffix = Path(path_name).suffix.lower()
    return {
        ".pdf": "application/pdf",
        ".md": "text/markdown; charset=utf-8",
        ".txt": "text/plain; charset=utf-8",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".heic": "image/heic",
    }.get(suffix, "application/octet-stream")


def ai_storage_stream_remote(root_path, relative_path, mimetype=None):
    relative = str(relative_path).replace("\\", "/").lstrip("/")
    encoded_root = base64.b64encode(str(root_path).encode("utf-8")).decode("ascii")
    encoded_path = base64.b64encode(relative.encode("utf-8")).decode("ascii")
    remote_program = (
        "import base64, os, sys\n"
        f"root = base64.b64decode('{encoded_root}').decode('utf-8')\n"
        f"path = base64.b64decode('{encoded_path}').decode('utf-8')\n"
        "full = os.path.join(root, path)\n"
        "if not os.path.isfile(full):\n"
        "    sys.stderr.write('Document was not found.\\n')\n"
        "    sys.exit(2)\n"
        "with open(full, 'rb') as handle:\n"
        "    while True:\n"
        "        chunk = handle.read(1024 * 1024)\n"
        "        if not chunk:\n"
        "            break\n"
        "        sys.stdout.buffer.write(chunk)\n"
    )
    encoded_program = base64.b64encode(
        remote_program.encode("utf-8")
    ).decode("ascii")
    remote_command = (
        "python3 -c 'import base64;"
        f'exec(base64.b64decode("{encoded_program}"))'
        "'"
    )

    process = subprocess.Popen(
        [
            "ssh",
            "-i",
            INTELMINI_STORAGE_KEY,
            "-o",
            "BatchMode=yes",
            "-o",
            "IdentitiesOnly=yes",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            "ConnectTimeout=8",
            f"{INTELMINI_STORAGE_USER}@{INTELMINI_STORAGE_HOST}",
            remote_command,
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    first_chunk = process.stdout.read(1024 * 1024) if process.stdout else b""

    if not first_chunk:
        process.wait(timeout=20)
        if process.returncode not in (0, None):
            raise FileNotFoundError("Document was not found.")

    @stream_with_context
    def generate():
        try:
            if first_chunk:
                yield first_chunk
            while True:
                chunk = process.stdout.read(1024 * 1024)
                if not chunk:
                    break
                yield chunk
        finally:
            if process.poll() is None:
                process.wait(timeout=60)

    filename = Path(relative).name
    headers = {
        "Content-Disposition": (
            f"inline; filename*=UTF-8''{quote(filename)}"
        ),
        "Cache-Control": "private, max-age=120",
    }
    return Response(
        generate(),
        mimetype=mimetype or ai_storage_guess_mimetype(filename),
        headers=headers,
        direct_passthrough=True,
    )


def ai_storage_read_text(root_path, relative_path, timeout=30):
    relative = str(relative_path).replace("\\", "/").lstrip("/")

    if ai_storage_is_local():
        path = (Path(root_path) / relative).resolve()
        path.relative_to(Path(root_path).resolve())
        return path.read_text(encoding="utf-8", errors="replace")

    encoded_root = base64.b64encode(str(root_path).encode("utf-8")).decode("ascii")
    encoded_path = base64.b64encode(relative.encode("utf-8")).decode("ascii")
    remote_command = (
        "python3 -c 'import base64,os,sys;"
        f"root=base64.b64decode(\"{encoded_root}\").decode();"
        f"path=base64.b64decode(\"{encoded_path}\").decode();"
        "full=os.path.join(root,path);"
        "sys.exit(2) if not os.path.isfile(full) else "
        "sys.stdout.write(open(full,encoding=\"utf-8\",errors=\"replace\").read())'"
    )
    return ai_storage_ssh(remote_command, timeout=timeout)


# =============================================================================
# PDF DOCUMENT UPLOAD ROUTES
# =============================================================================

PDF_DOCUMENT_ROOT = Path("/mnt/ai-storage/openclaw-documents")
PDF_METADATA_ROOT = PDF_DOCUMENT_ROOT / ".metadata"
PDF_UPLOAD_LOG = PDF_METADATA_ROOT / "uploads.jsonl"
PDF_REMOTE_STAGING_ROOT = Path("/mnt/ai-storage/.openclaw-upload-staging")

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


def pdf_document_storage_is_local():
    return ai_storage_is_local() and PDF_DOCUMENT_ROOT.is_dir()


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


def pdf_upload_remote_destination(category, original_name, sha256):
    if category not in PDF_UPLOAD_CATEGORIES:
        raise ValueError("Invalid document category.")

    safe_name = secure_filename(str(original_name or ""))
    if not safe_name:
        raise ValueError("The file does not have a usable filename.")

    if Path(safe_name).suffix.lower() != ".pdf":
        raise ValueError("Only PDF files may be uploaded.")

    digest_suffix = str(sha256)[:12]
    stored_name = f"{Path(safe_name).stem}-{digest_suffix}.pdf"
    return pdf_library_validate_relative_path(f"{category}/{stored_name}")


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
        "sha256": pdf_upload_sha256(path),
    }


def pdf_upload_sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def pdf_upload_find_duplicate(sha256):
    conn = ranchbrain_db()
    cur = conn.cursor()
    try:
        cur.execute(
            """
            SELECT relative_path, title
            FROM reference_documents
            WHERE storage_root = %s
              AND sha256 = %s
              AND storage_state = 'available'
            LIMIT 1
            """,
            (str(PDF_DOCUMENT_ROOT), sha256),
        )
        row = cur.fetchone()
        if not row:
            return None
        return {"relative_path": row[0], "title": row[1]}
    finally:
        cur.close()
        conn.close()


def pdf_upload_record(metadata):
    conn = ranchbrain_db()
    cur = conn.cursor()
    try:
        cur.execute(
            """
            INSERT INTO reference_documents (
                storage_root, relative_path, original_filename, category,
                document_type, mime_type, title, notes, size_bytes, sha256,
                page_count, encrypted, source_host, storage_state
            ) VALUES (
                %s, %s, %s, %s, 'pdf', 'application/pdf', %s, %s,
                %s, %s, %s, %s, %s, 'available'
            )
            """,
            (
                str(PDF_DOCUMENT_ROOT),
                metadata["relative_path"],
                metadata["original_filename"],
                metadata["category"],
                metadata["title"],
                metadata["notes"],
                metadata["size_bytes"],
                metadata["sha256"],
                metadata["page_count"],
                metadata["encrypted"],
                metadata["source_host"],
            ),
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()


def pdf_upload_copy_remote(local_path, relative_path, expected_sha256):
    relative = pdf_library_validate_relative_path(relative_path)
    upload_token = uuid.uuid4().hex
    staging_path = PDF_REMOTE_STAGING_ROOT / f"{upload_token}.part"
    ai_storage_ssh(
        "mkdir -p -- /mnt/ai-storage/.openclaw-upload-staging",
        timeout=20,
    )
    remote_target = (
        f"{INTELMINI_STORAGE_USER}@{INTELMINI_STORAGE_HOST}:"
        f"{staging_path}"
    )
    result = subprocess.run(
        [
            "scp",
            "-i",
            INTELMINI_STORAGE_KEY,
            "-o",
            "BatchMode=yes",
            "-o",
            "IdentitiesOnly=yes",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            "ConnectTimeout=8",
            str(local_path),
            remote_target,
        ],
        capture_output=True,
        text=True,
        timeout=180,
        check=False,
    )
    if result.returncode != 0:
        pdf_upload_cleanup_remote_stage(staging_path)
        detail = (result.stderr or result.stdout or "").strip().splitlines()
        raise RuntimeError(
            detail[-1] if detail else "Remote PDF copy to Intel Mini failed."
        )
    encoded_stage = base64.b64encode(str(staging_path).encode()).decode("ascii")
    encoded_relative = base64.b64encode(relative.encode()).decode("ascii")
    remote_program = (
        "import base64, hashlib, os\n"
        "from pathlib import Path\n"
        f"stage = Path(base64.b64decode('{encoded_stage}').decode())\n"
        "root = Path('/mnt/ai-storage/openclaw-documents')\n"
        f"relative = base64.b64decode('{encoded_relative}').decode()\n"
        "destination = root / relative\n"
        "digest = hashlib.sha256()\n"
        "with stage.open('rb') as handle:\n"
        "    for chunk in iter(lambda: handle.read(1024 * 1024), b''):\n"
        "        digest.update(chunk)\n"
        f"if digest.hexdigest() != '{expected_sha256}':\n"
        "    stage.unlink(missing_ok=True)\n"
        "    raise SystemExit('uploaded PDF checksum mismatch')\n"
        "destination.parent.mkdir(parents=True, exist_ok=True)\n"
        "if destination.exists():\n"
        "    existing = hashlib.sha256(destination.read_bytes()).hexdigest()\n"
        "    stage.unlink(missing_ok=True)\n"
        f"    if existing != '{expected_sha256}':\n"
        "        raise SystemExit('destination collision with different content')\n"
        "    print('existing')\n"
        "else:\n"
        "    os.replace(stage, destination)\n"
        "    print('created')\n"
    )
    encoded_program = base64.b64encode(remote_program.encode()).decode("ascii")
    try:
        finalization = ai_storage_ssh(
            "python3 -c 'import base64;"
            f'exec(base64.b64decode("{encoded_program}"))'
            "'",
            timeout=60,
        )
    except Exception:
        pdf_upload_cleanup_remote_stage(staging_path)
        raise
    return str(finalization).strip() == "created"


def pdf_upload_cleanup_remote_stage(staging_path):
    encoded = base64.b64encode(str(staging_path).encode()).decode("ascii")
    try:
        ai_storage_ssh(
            "python3 -c 'import base64,pathlib;"
            f"p=pathlib.Path(base64.b64decode(\"{encoded}\").decode());"
            "p.unlink(missing_ok=True)'",
            timeout=15,
        )
    except Exception:
        pass


def pdf_upload_remove_remote(relative_path):
    relative = pdf_library_validate_relative_path(relative_path)
    encoded = base64.b64encode(relative.encode()).decode("ascii")
    ai_storage_ssh(
        "python3 -c 'import base64,pathlib;"
        "root=pathlib.Path(\"/mnt/ai-storage/openclaw-documents\");"
        f"p=base64.b64decode(\"{encoded}\").decode();"
        "(root/p).unlink(missing_ok=True)'",
        timeout=15,
    )


def pdf_library_validate_relative_path(relative_path):
    return ai_storage_validate_relative_path(
        relative_path,
        allowed_top_levels=PDF_UPLOAD_CATEGORIES,
        allowed_suffixes={".pdf"},
    )


def pdf_upload_resolve(relative_path):
    relative = pdf_library_validate_relative_path(relative_path)

    if not pdf_document_storage_is_local():
        return {
            "mode": "remote",
            "relative_path": relative,
            "filename": Path(relative).name,
        }

    root = PDF_DOCUMENT_ROOT.resolve()
    candidate = (root / relative).resolve()

    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise ValueError("Document is outside the PDF library.") from exc

    if not candidate.is_file():
        raise FileNotFoundError("PDF was not found.")

    return {
        "mode": "local",
        "path": candidate,
        "relative_path": relative,
        "filename": candidate.name,
    }


def pdf_library_stream_remote(relative_path):
    relative = pdf_library_validate_relative_path(relative_path)
    return ai_storage_stream_remote(
        PDF_DOCUMENT_ROOT,
        relative,
        mimetype="application/pdf",
    )


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
    remote_mode = not pdf_document_storage_is_local()

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

            if remote_mode:
                temporary_path = Path("/tmp") / (
                    f"openclaw-pdf-upload-{time.time_ns()}.pdf"
                )
                upload.save(temporary_path)
                validation = pdf_upload_validate(temporary_path)
                duplicate = pdf_upload_find_duplicate(validation["sha256"])
                if duplicate:
                    temporary_path.unlink(missing_ok=True)
                    temporary_path = None
                    raise ValueError(
                        "This PDF is already stored as "
                        f"{duplicate['relative_path']}."
                    )
                relative_path = pdf_upload_remote_destination(
                    category,
                    upload.filename,
                    validation["sha256"],
                )
                remote_file_created = pdf_upload_copy_remote(
                    temporary_path,
                    relative_path,
                    validation["sha256"],
                )
                metadata = {
                    "uploaded_at": datetime.now().astimezone().isoformat(),
                    "original_filename": str(upload.filename),
                    "stored_filename": Path(relative_path).name,
                    "relative_path": relative_path,
                    "category": category,
                    "title": title or Path(relative_path).stem,
                    "notes": notes,
                    "size_bytes": validation["size_bytes"],
                    "page_count": validation["page_count"],
                    "encrypted": validation["encrypted"],
                    "sha256": validation["sha256"],
                    "source_host": INTELMINI_STORAGE_HOST,
                }
                try:
                    pdf_upload_record(metadata)
                except Exception:
                    if remote_file_created:
                        try:
                            pdf_upload_remove_remote(relative_path)
                        except Exception:
                            pass
                    raise
                temporary_path.unlink(missing_ok=True)
                temporary_path = None
            else:
                final_path = pdf_upload_safe_destination(
                    category,
                    upload.filename,
                )

                temporary_path = final_path.with_name(
                    f".{final_path.name}.uploading-{time.time_ns()}"
                )

                upload.save(temporary_path)
                validation = pdf_upload_validate(temporary_path)
                duplicate = pdf_upload_find_duplicate(validation["sha256"])
                if duplicate:
                    temporary_path.unlink(missing_ok=True)
                    temporary_path = None
                    raise ValueError(
                        "This PDF is already stored as "
                        f"{duplicate['relative_path']}."
                    )

                temporary_path.replace(final_path)
                temporary_path = None

                metadata = {
                    "uploaded_at": datetime.now().astimezone().isoformat(),
                    "original_filename": str(upload.filename),
                    "stored_filename": final_path.name,
                    "relative_path": str(
                        final_path.relative_to(PDF_DOCUMENT_ROOT)
                    ),
                    "category": category,
                    "title": title or final_path.stem,
                    "notes": notes,
                    "size_bytes": validation["size_bytes"],
                    "page_count": validation["page_count"],
                    "encrypted": validation["encrypted"],
                    "sha256": validation["sha256"],
                    "source_host": os.uname().nodename,
                }

                try:
                    pdf_upload_record(metadata)
                except Exception:
                    final_path.unlink(missing_ok=True)
                    raise

            open_url = (
                "/documentation/pdf/"
                f"{quote(metadata['relative_path'], safe='/')}"
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
                Path(temporary_path).unlink(missing_ok=True)

            message = f"""<h2>Upload unsuccessful</h2>
<p>{html.escape(str(exc))}</p>"""

        except Exception as exc:
            if temporary_path:
                Path(temporary_path).unlink(missing_ok=True)

            message = f"""<h2>Upload unsuccessful</h2>
<p>An unexpected error occurred while storing the PDF.</p>
<p class="muted">{html.escape(str(exc))}</p>"""

    category_options = []

    for category_name in PDF_UPLOAD_CATEGORIES:
        selected = " selected" if category_name == "Unsorted" else ""
        category_options.append(
            f'<option value="{html.escape(category_name, quote=True)}"'
            f'{selected}>{html.escape(category_name)}</option>'
        )

    storage_note = (
        "This development host does not mount /mnt/ai-storage. "
        f"Uploads are stored on Intel Mini ({html.escape(INTELMINI_STORAGE_HOST)}) "
        "at /mnt/ai-storage/openclaw-documents."
        if remote_mode
        else "Uploads are stored on the local external AI drive at "
        f"{html.escape(str(PDF_DOCUMENT_ROOT))}."
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

<div class="health" style="margin:16px 0;">
<div class="muted">Upload destination</div>
<div>{storage_note}</div>
</div>

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


@app.route("/documentation/pdf/<path:doc_path>")
def documentation_open_pdf(doc_path):
    try:
        resolved = pdf_upload_resolve(doc_path)
    except FileNotFoundError:
        abort(404)
    except ValueError:
        abort(400)

    if resolved["mode"] == "remote":
        try:
            return pdf_library_stream_remote(resolved["relative_path"])
        except FileNotFoundError:
            abort(404)
        except HTTPException:
            raise
        except Exception:
            abort(502)

    path = resolved["path"]
    return send_from_directory(
        str(path.parent),
        path.name,
        mimetype="application/pdf",
        as_attachment=False,
        conditional=True,
    )


# =============================================================================
# PDF DOCUMENT LIBRARY ROUTES
# =============================================================================

def pdf_library_load_metadata_from_text(raw_text):
    records = []

    for line in str(raw_text or "").splitlines():
        line = line.strip()

        if not line:
            continue

        try:
            item = json.loads(line)
        except (ValueError, TypeError):
            continue

        if isinstance(item, dict):
            records.append(item)

    return records


def pdf_library_load_metadata():
    if not PDF_UPLOAD_LOG.is_file():
        return []

    try:
        return pdf_library_load_metadata_from_text(
            PDF_UPLOAD_LOG.read_text(encoding="utf-8")
        )
    except OSError:
        return []


def pdf_library_build_document(relative_path, size_bytes, modified_timestamp, metadata):
    path_name = Path(relative_path).name
    category = relative_path.split("/", 1)[0]

    return {
        "title": str(
            metadata.get("title")
            or Path(path_name).stem.replace("-", " ").replace("_", " ").title()
        ),
        "category": category,
        "filename": path_name,
        "relative_path": relative_path,
        "notes": str(metadata.get("notes") or ""),
        "uploaded_at": str(metadata.get("uploaded_at") or ""),
        "page_count": metadata.get("page_count"),
        "size_bytes": int(metadata.get("size_bytes") or size_bytes or 0),
        "modified_timestamp": float(modified_timestamp or 0),
        "encrypted": bool(metadata.get("encrypted", False)),
    }


def pdf_library_scan_files_local():
    metadata_by_path = {
        str(item.get("relative_path") or ""): item
        for item in pdf_library_load_metadata()
        if item.get("relative_path")
    }

    documents = []

    for category in PDF_UPLOAD_CATEGORIES:
        directory = PDF_DOCUMENT_ROOT / category

        if not directory.is_dir():
            continue

        for path in directory.rglob("*.pdf"):
            if not path.is_file():
                continue

            relative_path = str(path.relative_to(PDF_DOCUMENT_ROOT)).replace(
                "\\",
                "/",
            )

            try:
                pdf_library_validate_relative_path(relative_path)
            except ValueError:
                continue

            metadata = metadata_by_path.get(relative_path, {})

            try:
                stat = path.stat()
            except OSError:
                continue

            documents.append(
                pdf_library_build_document(
                    relative_path,
                    stat.st_size,
                    stat.st_mtime,
                    metadata,
                )
            )

    documents.sort(
        key=lambda item: (
            -float(item.get("modified_timestamp") or 0),
            str(item.get("title") or "").casefold(),
        )
    )

    return documents


def pdf_library_scan_files_remote():
    categories_json = json.dumps(list(PDF_UPLOAD_CATEGORIES))
    remote_program = (
        "import json\n"
        "import os\n"
        "from pathlib import Path\n"
        "\n"
        "root = Path('/mnt/ai-storage/openclaw-documents')\n"
        f"categories = {categories_json}\n"
        "documents = []\n"
        "metadata_records = []\n"
        "metadata_log = root / '.metadata' / 'uploads.jsonl'\n"
        "\n"
        "if metadata_log.is_file():\n"
        "    for line in metadata_log.read_text(encoding='utf-8', errors='replace').splitlines():\n"
        "        line = line.strip()\n"
        "        if not line:\n"
        "            continue\n"
        "        try:\n"
        "            item = json.loads(line)\n"
        "        except Exception:\n"
        "            continue\n"
        "        if isinstance(item, dict):\n"
        "            metadata_records.append(item)\n"
        "\n"
        "metadata_by_path = {\n"
        "    str(item.get('relative_path') or '').replace('\\\\', '/'): item\n"
        "    for item in metadata_records\n"
        "    if item.get('relative_path')\n"
        "}\n"
        "\n"
        "for category in categories:\n"
        "    directory = root / category\n"
        "    if not directory.is_dir():\n"
        "        continue\n"
        "    for path in directory.rglob('*.pdf'):\n"
        "        if not path.is_file():\n"
        "            continue\n"
        "        relative_path = str(path.relative_to(root)).replace('\\\\', '/')\n"
        "        parts = relative_path.split('/')\n"
        "        if any((not part) or part in {'.', '..'} or part.startswith('.') for part in parts):\n"
        "            continue\n"
        "        if parts[0] not in categories:\n"
        "            continue\n"
        "        try:\n"
        "            stat = path.stat()\n"
        "        except OSError:\n"
        "            continue\n"
        "        metadata = metadata_by_path.get(relative_path, {})\n"
        "        documents.append({\n"
        "            'title': str(\n"
        "                metadata.get('title')\n"
        "                or path.stem.replace('-', ' ').replace('_', ' ').title()\n"
        "            ),\n"
        "            'category': category,\n"
        "            'filename': path.name,\n"
        "            'relative_path': relative_path,\n"
        "            'notes': str(metadata.get('notes') or ''),\n"
        "            'uploaded_at': str(metadata.get('uploaded_at') or ''),\n"
        "            'page_count': metadata.get('page_count'),\n"
        "            'size_bytes': int(metadata.get('size_bytes') or stat.st_size),\n"
        "            'modified_timestamp': float(stat.st_mtime),\n"
        "            'encrypted': bool(metadata.get('encrypted', False)),\n"
        "        })\n"
        "\n"
        "documents.sort(\n"
        "    key=lambda item: (\n"
        "        -float(item.get('modified_timestamp') or 0),\n"
        "        str(item.get('title') or '').casefold(),\n"
        "    )\n"
        ")\n"
        "print(json.dumps({\n"
        "    'host': os.uname().nodename,\n"
        "    'document_count': len(documents),\n"
        "    'documents': documents,\n"
        "}))\n"
    )
    encoded_program = base64.b64encode(
        remote_program.encode("utf-8")
    ).decode("ascii")
    remote_command = (
        "python3 -c 'import base64;"
        f'exec(base64.b64decode("{encoded_program}"))'
        "'"
    )
    payload = json.loads(ai_storage_ssh(remote_command, timeout=45))

    if not isinstance(payload, dict) or not isinstance(
        payload.get("documents"),
        list,
    ):
        raise ValueError("Intel Mini PDF library probe returned invalid data.")

    documents = []

    for item in payload["documents"]:
        if not isinstance(item, dict):
            continue

        relative_path = str(item.get("relative_path") or "").replace("\\", "/")

        try:
            relative_path = pdf_library_validate_relative_path(relative_path)
        except ValueError:
            continue

        documents.append(
            pdf_library_build_document(
                relative_path,
                item.get("size_bytes") or 0,
                item.get("modified_timestamp") or 0,
                item,
            )
        )

    documents.sort(
        key=lambda item: (
            -float(item.get("modified_timestamp") or 0),
            str(item.get("title") or "").casefold(),
        )
    )

    return documents, str(payload.get("host") or INTELMINI_STORAGE_HOST)


def pdf_library_scan_files():
    if pdf_document_storage_is_local():
        return {
            "documents": pdf_library_scan_files_local(),
            "mode": "local",
            "host": "this host",
            "available": True,
            "error": "",
        }

    try:
        documents, host = pdf_library_scan_files_remote()
        return {
            "documents": documents,
            "mode": "remote",
            "host": host,
            "available": True,
            "error": "",
        }
    except Exception as exc:
        return {
            "documents": [],
            "mode": "remote",
            "host": INTELMINI_STORAGE_HOST,
            "available": False,
            "error": str(exc),
        }


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
    scan = pdf_library_scan_files()
    documents = scan["documents"]
    scan_error = str(scan.get("error") or "")

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
            "/documentation/pdf/"
            f"{quote(item['relative_path'], safe='/')}"
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

    if scan_error:
        results_html = (
            '<div class="empty-state">'
            "<h2>PDF library unavailable</h2>"
            "<p>Could not read the document library from the Intel Mini.</p>"
            f"<p class=\"muted\">{html.escape(scan_error)}</p>"
            "</div>"
        )
    elif cards:
        results_html = (
            '<div class="document-grid">'
            + "".join(cards)
            + "</div>"
        )
    elif documents:
        results_html = (
            '<div class="empty-state">'
            "No uploaded PDFs matched your search."
            "</div>"
        )
    else:
        results_html = (
            '<div class="empty-state">'
            "No PDFs were found in the document library."
            "</div>"
        )

    category_summary = ", ".join(
        f"{html.escape(category)}: {count}"
        for category, count in sorted(
            category_counts.items(),
            key=lambda item: item[0].casefold(),
        )
    ) or "No PDFs uploaded"

    if scan["mode"] == "local":
        source_note = (
            "Reading PDFs from local external storage at "
            f"{html.escape(str(PDF_DOCUMENT_ROOT))}."
        )
    else:
        source_note = (
            "Development host does not mount /mnt/ai-storage. "
            "Reading the PDF library from Intel Mini "
            f"({html.escape(str(scan.get('host') or INTELMINI_STORAGE_HOST))}) "
            "over SSH."
        )

    body = f"""
<p class="muted">
Search and open PDFs stored on the external AI drive.
</p>

<div class="health" style="margin-bottom:18px;">
<div class="muted">Library source</div>
<div>{source_note}</div>
</div>

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


# =============================================================================
# RANCHBRAIN VAULT (4TB) BROWSER
# =============================================================================

def ranchbrain_vault_validate_relative_path(relative_path):
    return ai_storage_validate_relative_path(
        relative_path,
        allowed_top_levels=RANCHBRAIN_VAULT_SECTIONS,
        allowed_suffixes=RANCHBRAIN_VAULT_SUFFIXES,
        allow_root_files=RANCHBRAIN_VAULT_ROOT_FILES,
    )


def ranchbrain_vault_build_item(relative_path, size_bytes, modified_timestamp, metadata=None):
    metadata = metadata or {}
    path_name = Path(relative_path).name
    suffix = Path(path_name).suffix.lower()
    section = (
        relative_path.split("/", 1)[0]
        if "/" in relative_path
        else "root"
    )

    return {
        "title": str(
            metadata.get("title")
            or Path(path_name).stem.replace("-", " ").replace("_", " ").title()
        ),
        "section": section,
        "filename": path_name,
        "relative_path": relative_path,
        "notes": str(metadata.get("notes") or metadata.get("description") or ""),
        "tags": metadata.get("tags") or [],
        "suffix": suffix,
        "size_bytes": int(size_bytes or 0),
        "modified_timestamp": float(modified_timestamp or 0),
        "document_type": str(metadata.get("document_type") or suffix.lstrip(".")),
    }


def ranchbrain_vault_load_sidecar_local(path):
    sidecar = Path(str(path) + ".metadata.json")
    if not sidecar.is_file():
        return {}
    try:
        data = json.loads(sidecar.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError, TypeError):
        return {}


def ranchbrain_vault_scan_local():
    root = RANCHBRAIN_VAULT_ROOT
    documents = []

    if not root.is_dir():
        return documents

    for root_file in RANCHBRAIN_VAULT_ROOT_FILES:
        path = root / root_file
        if not path.is_file():
            continue
        try:
            stat = path.stat()
        except OSError:
            continue
        documents.append(
            ranchbrain_vault_build_item(
                root_file,
                stat.st_size,
                stat.st_mtime,
                ranchbrain_vault_load_sidecar_local(path),
            )
        )

    for section in RANCHBRAIN_VAULT_SECTIONS:
        directory = root / section
        if not directory.is_dir():
            continue
        for path in directory.rglob("*"):
            if not path.is_file():
                continue
            if path.name.startswith(".") or path.name.startswith("._"):
                continue
            if path.name.endswith(".metadata.json"):
                continue
            relative_path = str(path.relative_to(root)).replace("\\", "/")
            try:
                ranchbrain_vault_validate_relative_path(relative_path)
            except ValueError:
                continue
            try:
                stat = path.stat()
            except OSError:
                continue
            documents.append(
                ranchbrain_vault_build_item(
                    relative_path,
                    stat.st_size,
                    stat.st_mtime,
                    ranchbrain_vault_load_sidecar_local(path),
                )
            )

    documents.sort(
        key=lambda item: (
            -float(item.get("modified_timestamp") or 0),
            str(item.get("title") or "").casefold(),
        )
    )
    return documents


def ranchbrain_vault_scan_remote():
    sections_json = json.dumps(list(RANCHBRAIN_VAULT_SECTIONS))
    root_files_json = json.dumps(list(RANCHBRAIN_VAULT_ROOT_FILES))
    suffixes_json = json.dumps(sorted(RANCHBRAIN_VAULT_SUFFIXES))
    remote_program = (
        "import json, os\n"
        "from pathlib import Path\n"
        "root = Path('/mnt/ai-storage/ranchbrain')\n"
        f"sections = {sections_json}\n"
        f"root_files = {root_files_json}\n"
        f"suffixes = set({suffixes_json})\n"
        "documents = []\n"
        "\n"
        "def load_sidecar(path):\n"
        "    sidecar = Path(str(path) + '.metadata.json')\n"
        "    if not sidecar.is_file():\n"
        "        return {}\n"
        "    try:\n"
        "        data = json.loads(sidecar.read_text(encoding='utf-8', errors='replace'))\n"
        "        return data if isinstance(data, dict) else {}\n"
        "    except Exception:\n"
        "        return {}\n"
        "\n"
        "def build_item(relative_path, size_bytes, modified_timestamp, metadata):\n"
        "    path_name = Path(relative_path).name\n"
        "    suffix = Path(path_name).suffix.lower()\n"
        "    section = relative_path.split('/', 1)[0] if '/' in relative_path else 'root'\n"
        "    return {\n"
        "        'title': str(metadata.get('title') or path_name.rsplit('.', 1)[0].replace('-', ' ').replace('_', ' ').title()),\n"
        "        'section': section,\n"
        "        'filename': path_name,\n"
        "        'relative_path': relative_path,\n"
        "        'notes': str(metadata.get('notes') or metadata.get('description') or ''),\n"
        "        'tags': metadata.get('tags') or [],\n"
        "        'suffix': suffix,\n"
        "        'size_bytes': int(size_bytes or 0),\n"
        "        'modified_timestamp': float(modified_timestamp or 0),\n"
        "        'document_type': str(metadata.get('document_type') or suffix.lstrip('.')),\n"
        "    }\n"
        "\n"
        "for root_file in root_files:\n"
        "    path = root / root_file\n"
        "    if path.is_file():\n"
        "        stat = path.stat()\n"
        "        documents.append(build_item(root_file, stat.st_size, stat.st_mtime, load_sidecar(path)))\n"
        "\n"
        "for section in sections:\n"
        "    directory = root / section\n"
        "    if not directory.is_dir():\n"
        "        continue\n"
        "    for path in directory.rglob('*'):\n"
        "        if not path.is_file():\n"
        "            continue\n"
        "        if path.name.startswith('.') or path.name.startswith('._'):\n"
        "            continue\n"
        "        if path.name.endswith('.metadata.json'):\n"
        "            continue\n"
        "        relative_path = str(path.relative_to(root)).replace('\\\\', '/')\n"
        "        parts = relative_path.split('/')\n"
        "        if any((not part) or part in {'.', '..'} or part.startswith('.') for part in parts):\n"
        "            continue\n"
        "        suffix = Path(path.name).suffix.lower()\n"
        "        if suffix not in suffixes:\n"
        "            continue\n"
        "        try:\n"
        "            stat = path.stat()\n"
        "        except OSError:\n"
        "            continue\n"
        "        documents.append(build_item(relative_path, stat.st_size, stat.st_mtime, load_sidecar(path)))\n"
        "\n"
        "documents.sort(key=lambda item: (-float(item.get('modified_timestamp') or 0), str(item.get('title') or '').casefold()))\n"
        "print(json.dumps({'host': os.uname().nodename, 'documents': documents, 'sections_present': sorted({item['section'] for item in documents})}))\n"
    )
    encoded_program = base64.b64encode(remote_program.encode("utf-8")).decode("ascii")
    remote_command = (
        "python3 -c 'import base64;"
        f'exec(base64.b64decode("{encoded_program}"))'
        "'"
    )
    payload = json.loads(ai_storage_ssh(remote_command, timeout=60))
    if not isinstance(payload, dict) or not isinstance(payload.get("documents"), list):
        raise ValueError("Intel Mini vault probe returned invalid data.")

    documents = []
    for item in payload["documents"]:
        if not isinstance(item, dict):
            continue
        relative_path = str(item.get("relative_path") or "").replace("\\", "/")
        try:
            relative_path = ranchbrain_vault_validate_relative_path(relative_path)
        except ValueError:
            continue
        documents.append(
            ranchbrain_vault_build_item(
                relative_path,
                item.get("size_bytes") or 0,
                item.get("modified_timestamp") or 0,
                item,
            )
        )

    documents.sort(
        key=lambda item: (
            -float(item.get("modified_timestamp") or 0),
            str(item.get("title") or "").casefold(),
        )
    )
    return documents, str(payload.get("host") or INTELMINI_STORAGE_HOST)


def ranchbrain_vault_scan():
    if ai_storage_is_local() and RANCHBRAIN_VAULT_ROOT.is_dir():
        return {
            "documents": ranchbrain_vault_scan_local(),
            "mode": "local",
            "host": "this host",
            "available": True,
            "error": "",
        }

    try:
        documents, host = ranchbrain_vault_scan_remote()
        return {
            "documents": documents,
            "mode": "remote",
            "host": host,
            "available": True,
            "error": "",
        }
    except Exception as exc:
        return {
            "documents": [],
            "mode": "remote",
            "host": INTELMINI_STORAGE_HOST,
            "available": False,
            "error": str(exc),
        }


def ranchbrain_vault_resolve(relative_path):
    relative = ranchbrain_vault_validate_relative_path(relative_path)

    if not (ai_storage_is_local() and RANCHBRAIN_VAULT_ROOT.is_dir()):
        return {
            "mode": "remote",
            "relative_path": relative,
            "filename": Path(relative).name,
            "suffix": Path(relative).suffix.lower(),
        }

    root = RANCHBRAIN_VAULT_ROOT.resolve()
    candidate = (root / relative).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise ValueError("Document is outside the RanchBrain vault.") from exc

    if not candidate.is_file():
        raise FileNotFoundError("Document was not found.")

    return {
        "mode": "local",
        "path": candidate,
        "relative_path": relative,
        "filename": candidate.name,
        "suffix": candidate.suffix.lower(),
    }


@app.route("/notes")
def notes_dashboard():
    scan = ranchbrain_vault_scan()
    documents = scan["documents"]
    scan_error = str(scan.get("error") or "")

    search_term = str(request.args.get("q") or "").strip()
    selected_section = str(request.args.get("section") or "").strip()

    filtered = list(documents)

    if selected_section:
        filtered = [
            item for item in filtered
            if item["section"].casefold() == selected_section.casefold()
        ]

    if search_term:
        needle = search_term.casefold()
        filtered = [
            item for item in filtered
            if needle in " ".join([
                item["title"],
                item["filename"],
                item["section"],
                item["notes"],
                item["relative_path"],
                item["document_type"],
                " ".join(str(tag) for tag in item.get("tags") or []),
            ]).casefold()
        ]

    section_options = ['<option value="">All sections</option>']
    for section in ("root",) + RANCHBRAIN_VAULT_SECTIONS:
        selected = (
            " selected"
            if section.casefold() == selected_section.casefold()
            else ""
        )
        section_options.append(
            f'<option value="{html.escape(section, quote=True)}"'
            f'{selected}>{html.escape(section)}</option>'
        )

    section_counts = {section: 0 for section in RANCHBRAIN_VAULT_SECTIONS}
    section_counts["root"] = 0
    for item in documents:
        section_counts[item["section"]] = section_counts.get(item["section"], 0) + 1

    cards = []
    for item in filtered:
        open_url = f"/notes/open/{quote(item['relative_path'], safe='/')}"
        type_badge = html.escape(item["suffix"].lstrip(".") or "file")
        notes_html = ""
        if item["notes"]:
            notes_html = f"<p><b>Notes:</b> {html.escape(item['notes'])}</p>"

        modified_display = pdf_library_display_date(
            None,
            item.get("modified_timestamp"),
        )

        cards.append(
            f"""<article class="document-card">
<h3>{html.escape(item['title'])}</h3>
<p class="muted">{html.escape(item['relative_path'])}</p>
<div>
<span class="badge">{html.escape(item['section'])}</span>
<span class="badge">{type_badge}</span>
</div>
<p><b>Modified:</b> {html.escape(modified_display)}</p>
<p><b>Size:</b> {html.escape(documentation_human_size(item['size_bytes']))}</p>
{notes_html}
<p class="open-link"><a href="{open_url}">Open →</a></p>
</article>"""
        )

    if scan_error:
        results_html = (
            '<div class="empty-state">'
            "<h2>Vault unavailable</h2>"
            "<p>Could not read the RanchBrain vault from the Intel Mini 4TB drive.</p>"
            f"<p class=\"muted\">{html.escape(scan_error)}</p>"
            "</div>"
        )
    elif cards:
        results_html = (
            '<div class="document-grid">' + "".join(cards) + "</div>"
        )
    elif documents:
        results_html = (
            '<div class="empty-state">No vault documents matched your search.</div>'
        )
    else:
        results_html = (
            '<div class="empty-state">No vault documents were found.</div>'
        )

    section_summary = ", ".join(
        f"{html.escape(section)}: {count}"
        for section, count in sorted(
            ((k, v) for k, v in section_counts.items() if v > 0),
            key=lambda item: item[0].casefold(),
        )
    ) or "No documents"

    # Always show planned sections, including empty ones.
    empty_sections = [
        section for section in RANCHBRAIN_VAULT_SECTIONS
        if section_counts.get(section, 0) == 0
    ]
    empty_note = (
        f"<p class=\"muted\">Empty sections: {html.escape(', '.join(empty_sections))}</p>"
        if empty_sections
        else ""
    )

    if scan["mode"] == "local":
        source_note = (
            "Reading the RanchBrain vault from local external storage at "
            f"{html.escape(str(RANCHBRAIN_VAULT_ROOT))}."
        )
    else:
        source_note = (
            "Development host does not mount /mnt/ai-storage. "
            "Reading notes, manuals, photos, and other vault documents from Intel Mini "
            f"({html.escape(str(scan.get('host') or INTELMINI_STORAGE_HOST))}) "
            "over SSH."
        )

    body = f"""
<p class="muted">
Browse notes, pictures, manuals, and other application documents stored on the Intel Mini 4TB drive.
</p>

<div class="health" style="margin-bottom:18px;">
<div class="muted">Vault source</div>
<div>{source_note}</div>
</div>

<div class="summary-grid">
<div class="health">
<div class="muted">Vault documents</div>
<div class="health-number">{len(documents)}</div>
</div>
<div class="health">
<div class="muted">Current results</div>
<div class="health-number">{len(filtered)}</div>
</div>
<div class="health">
<div class="muted">Sections used</div>
<div class="health-number">{sum(1 for count in section_counts.values() if count)}</div>
</div>
<div class="health">
<div class="muted">Total size</div>
<div class="health-number">{html.escape(documentation_human_size(sum(item['size_bytes'] for item in documents)))}</div>
</div>
</div>

<div class="health" style="margin-bottom:18px;">
<div class="muted">Section breakdown</div>
<div>{section_summary}</div>
{empty_note}
</div>

<form method="GET" action="/notes" class="toolbar">
<div>
<label for="vault-search"><b>Search vault</b></label>
<input id="vault-search" name="q" type="search"
       value="{html.escape(search_term, quote=True)}"
       placeholder="Search title, path, section, notes, or type">
</div>
<div>
<label for="vault-section"><b>Section</b></label>
<select id="vault-section" name="section">
{"".join(section_options)}
</select>
</div>
<div>
<button type="submit">Search Vault</button>
<a href="/notes" style="display:inline-block;margin-left:10px;">Clear</a>
</div>
</form>

<p><a href="/ranchbrain/review">Open Postgres note review queue →</a></p>

{results_html}
"""
    return documentation_shell("RanchBrain Vault", body)


@app.route("/notes/open/<path:doc_path>")
def notes_open_document(doc_path):
    try:
        resolved = ranchbrain_vault_resolve(doc_path)
    except FileNotFoundError:
        abort(404)
    except ValueError:
        abort(400)

    suffix = resolved["suffix"]
    relative = resolved["relative_path"]

    if suffix in RANCHBRAIN_VAULT_TEXT_SUFFIXES:
        try:
            content = ai_storage_read_text(RANCHBRAIN_VAULT_ROOT, relative)
        except Exception:
            abort(502)

        if suffix == ".md":
            rendered = markdown.markdown(
                content,
                extensions=["fenced_code", "tables"],
            )
        else:
            rendered = f"<pre>{html.escape(content)}</pre>"

        body = f"""
<p class="breadcrumb">
<a href="/notes">Vault</a>&nbsp;→&nbsp;{html.escape(relative)}
</p>
<div class="document-viewer">
{rendered}
</div>
"""
        return documentation_shell(Path(relative).name, body)

    if suffix == ".pdf" or suffix in RANCHBRAIN_VAULT_IMAGE_SUFFIXES:
        if resolved["mode"] == "remote":
            try:
                return ai_storage_stream_remote(
                    RANCHBRAIN_VAULT_ROOT,
                    relative,
                    mimetype=ai_storage_guess_mimetype(relative),
                )
            except FileNotFoundError:
                abort(404)
            except HTTPException:
                raise
            except Exception:
                abort(502)

        path = resolved["path"]
        return send_from_directory(
            str(path.parent),
            path.name,
            mimetype=ai_storage_guess_mimetype(path.name),
            as_attachment=False,
            conditional=True,
        )

    abort(400)


@app.route("/ranchbrain/review")
def ranchbrain_review_dashboard():
    try:
        if not ranchbrain_schema_is_ready():
            body = """
<div class="panel" style="border-left:7px solid #fbbf24;">
  <h2>Notes Setup Required</h2>
  <p>
    The review queue is connected to the approved development PostgreSQL
    service, but its <code>long_term_memory</code> schema has not been
    initialized.
  </p>
  <p>
    No production data was queried or copied. Review actions remain unavailable
    until an authoritative migration is added and approved for development.
  </p>
  <p><a href="/notes">Open the 4TB RanchBrain Vault →</a></p>
</div>
"""
            return ranchbrain_shell("Notes Review", body)

        pending = get_ranchbrain_notes("ranchbrain_pending")

        body = """
<div class="panel">
  <h2>Pending Notes</h2>
  <p><a href="/notes">Open the 4TB RanchBrain Vault →</a></p>
"""

        if not pending:
            body += "<p>No notes are waiting for approval.</p>"
        else:
            for memory_id, content, source, created_at in pending:
                body += f"""
<div class="note">
  <h3>Pending Memory ID {memory_id}</h3>
  <div>{html_module.escape(str(content))}</div>
  <div class="meta">
    Captured: {html_module.escape(str(created_at))}<br>
    File: {html_module.escape(str(source))}
  </div>

  <form method="POST" action="/ranchbrain/review/approve" style="display:inline-block;margin-top:12px;">
    <input type="hidden" name="memory_id" value="{memory_id}">
    <button class="approve" type="submit">Approve</button>
  </form>

  <form method="POST" action="/ranchbrain/review/reject" style="display:inline-block;margin-top:12px;margin-left:8px;">
    <input type="hidden" name="memory_id" value="{memory_id}">
    <button class="reject" type="submit">Reject</button>
  </form>
</div>
"""

        body += "</div>"
        return ranchbrain_shell("Notes Review", body)

    except Exception as exc:
        return ranchbrain_shell(
            "Notes Review",
            f"<div class='panel'>Error: {html_module.escape(str(exc))}</div>",
        ), 500


# BACKUP & RECOVERY CENTER
# ===========================================================

BACKUP_ROOT = Path("/mnt/ai-storage/openclaw-backups")
PRODUCTION_BACKUP_MANAGER = (
    Path.home()
    / "ai/projects/openclaw/tools/system_manager/openclaw-backup-manager.sh"
)
DASHBOARD_BACKUP_MANAGER = (
    Path.home()
    / "ai/projects/openclaw/tools/dashboard/dashboard-property-backup-manager.sh"
)
DEVELOPMENT_BACKUP_MANAGER = (
    Path.home()
    / "ai/projects/openclaw/tools/system_manager/openclaw-dev-backup.sh"
)

BACKUP_WARNING_DAYS = {
    "production": 10,
    "development": 8,
    "dashboard": 10,
}

REMOTE_BACKUP_REPORT_PATH = (
    REPORT_DIR
    / "system_manager"
    / "openclaw_remote_backup_verification_status.json"
)


def backup_center_remote_probe(verify=False):
    """
    Read backup and QNAP state from the Intel Mini over SSH.

    The normal probe reads metadata only. Verification additionally reads the
    latest archives and checksum files but never changes remote files.
    """
    remote_program = r'''
import datetime
import glob
import hashlib
import json
import os
import shutil
import tarfile

root = "/mnt/ai-storage/openclaw-backups"
verify = __VERIFY__
specs = [
    ("production", "OpenClaw Production", root, "openclaw-checkpoint-*.tar.gz"),
    ("development", "OpenClaw Development", root + "/dev", "openclaw-dev-backup-*.tar.gz"),
    ("dashboard", "Dashboard and PropertyManager", root + "/dashboard-property-backups", "dashboard-property-backup-*.tar.gz"),
]

def human_size(value):
    size = float(value)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if size < 1024 or unit == "TB":
            return f"{int(size)} {unit}" if unit == "B" else f"{size:.1f} {unit}"
        size /= 1024

def checksum_status(path):
    checksum_path = path + ".sha256"
    if not os.path.isfile(checksum_path):
        return "not_available", "No checksum file found."
    expected = open(checksum_path, encoding="utf-8", errors="replace").read().split()[0]
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest().lower() == expected.lower():
        return "verified", "SHA-256 checksum matched."
    return "failed", "SHA-256 checksum did not match."

backups = []
history = []
for key, label, directory, pattern in specs:
    candidates = [
        path for path in glob.glob(os.path.join(directory, pattern))
        if os.path.isfile(path)
    ]
    candidates.sort(key=os.path.getmtime, reverse=True)
    for path in candidates[:10]:
        stat = os.stat(path)
        history.append({
            "type": label,
            "filename": os.path.basename(path),
            "timestamp_epoch": stat.st_mtime,
            "timestamp": datetime.datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %I:%M %p"),
            "size": human_size(stat.st_size),
            "location": directory,
        })
    if not candidates:
        backups.append({
            "key": key,
            "label": label,
            "directory": directory,
            "filename": "None found",
            "timestamp_epoch": None,
            "size": "unknown",
            "status": "missing",
            "message": "No matching backup found.",
            "checksum_status": "not_available",
        })
        continue
    latest = candidates[0]
    stat = os.stat(latest)
    entry = {
        "key": key,
        "label": label,
        "directory": directory,
        "filename": os.path.basename(latest),
        "timestamp_epoch": stat.st_mtime,
        "modified": datetime.datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %I:%M:%S %p"),
        "size": human_size(stat.st_size),
        "status": "available",
        "message": "Latest remote backup metadata loaded.",
        "checksum_status": "not_checked",
        "checksum_message": "Checksum was not checked.",
    }
    if verify:
        try:
            with tarfile.open(latest, "r:gz") as archive:
                for _member in archive:
                    pass
            entry["status"] = "verified"
            entry["message"] = "Archive passed gzip and tar validation."
        except Exception as exc:
            entry["status"] = "failed"
            entry["message"] = f"Archive validation failed: {exc}"
        checksum, checksum_message = checksum_status(latest)
        entry["checksum_status"] = checksum
        entry["checksum_message"] = checksum_message
        if checksum == "failed":
            entry["status"] = "failed"
            entry["message"] = "Archive validation or checksum verification failed."
    backups.append(entry)

qnap_path = "/mnt/qnap-backup"
qnap = {"mounted": os.path.ismount(qnap_path), "path": qnap_path}
if qnap["mounted"]:
    usage = shutil.disk_usage(qnap_path)
    qnap.update({
        "total": human_size(usage.total),
        "used": human_size(usage.used),
        "free": human_size(usage.free),
        "percent_number": round((usage.used / usage.total) * 100) if usage.total else 0,
    })

history.sort(key=lambda item: item["timestamp_epoch"], reverse=True)
print(json.dumps({
    "host": os.uname().nodename,
    "checked_at": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
    "backups": backups,
    "history": history[:30],
    "qnap": qnap,
}))
'''.replace("__VERIFY__", "True" if verify else "False")
    encoded_program = base64.b64encode(
        remote_program.encode("utf-8")
    ).decode("ascii")
    remote_command = (
        "python3 -c 'import base64;"
        f'exec(base64.b64decode("{encoded_program}"))'
        "'"
    )
    result = subprocess.run(
        [
            "ssh",
            "-i",
            INTELMINI_STORAGE_KEY,
            "-o",
            "BatchMode=yes",
            "-o",
            "IdentitiesOnly=yes",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            "ConnectTimeout=8",
            f"{INTELMINI_STORAGE_USER}@{INTELMINI_STORAGE_HOST}",
            remote_command,
        ],
        capture_output=True,
        text=True,
        timeout=1800 if verify else 20,
        check=False,
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip().splitlines()
        raise RuntimeError(
            detail[-1] if detail else "Intel Mini backup probe failed."
        )
    data = json.loads(result.stdout)
    if not isinstance(data, dict) or not isinstance(data.get("backups"), list):
        raise ValueError("Intel Mini backup probe returned invalid data.")
    return data


def backup_center_remote_latest(entry, warning_days):
    result = {
        "directory": str(entry.get("directory", "unknown")),
        "exists": entry.get("status") != "missing",
        "file": None,
        "filename": str(entry.get("filename", "None found")),
        "timestamp": "Never",
        "age_days": None,
        "size": str(entry.get("size", "unknown")),
        "status": "critical",
        "status_label": "Critical",
        "status_color": "#ef4444",
        "message": str(entry.get("message", "No backup was found.")),
    }
    timestamp = entry.get("timestamp_epoch")
    if timestamp is None:
        return result
    age_days = max(0, int((time.time() - float(timestamp)) // 86400))
    if age_days > warning_days:
        status, label, color = "critical", "Critical", "#ef4444"
        message = f"Remote backup is overdue at {age_days} days old."
    elif age_days >= max(1, warning_days - 2):
        status, label, color = "warning", "Warning", "#facc15"
        message = f"Remote backup is approaching its {warning_days}-day limit."
    else:
        status, label, color = "healthy", "Healthy", "#22c55e"
        message = "Remote backup is current."
    result.update({
        "file": str(Path(result["directory"]) / result["filename"]),
        "timestamp": datetime.fromtimestamp(float(timestamp)).strftime(
            "%Y-%m-%d %I:%M:%S %p"
        ),
        "age_days": age_days,
        "status": status,
        "status_label": label,
        "status_color": color,
        "message": message,
    })
    return result


def backup_center_m4_time_machine():
    """Read Time Machine status from the M4 without changing its state."""
    remote_command = (
        "hostname; tmutil status 2>&1; "
        "printf '\\nOPENCLAW_LATEST_BACKUP\\n'; "
        "tmutil latestbackup 2>&1; "
        "printf '\\nOPENCLAW_DESTINATION\\n'; "
        "tmutil destinationinfo 2>&1"
    )
    try:
        result = subprocess.run(
            [
                "ssh",
                "-i",
                M4_SSH_KEY,
                "-o",
                "BatchMode=yes",
                "-o",
                "IdentitiesOnly=yes",
                "-o",
                "StrictHostKeyChecking=yes",
                "-o",
                "ConnectTimeout=8",
                f"{M4_SSH_USER}@{M4_SSH_HOST}",
                remote_command,
            ],
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
        if result.returncode != 0:
            raise RuntimeError(
                (result.stderr or result.stdout).strip()
                or "M4 Time Machine probe failed."
            )
        output = result.stdout
        latest_section = output.split(
            "OPENCLAW_LATEST_BACKUP",
            1,
        )[1].split("OPENCLAW_DESTINATION", 1)[0].strip()
        latest_path = latest_section.splitlines()[-1].strip()
        timestamp_match = re.search(
            r"/(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})"
            r"\.backup",
            latest_path,
        )
        if not timestamp_match:
            raise ValueError("M4 latest backup timestamp was unavailable.")
        latest_at = datetime(
            *[int(value) for value in timestamp_match.groups()]
        )
        age_hours = max(
            0,
            int(
                (
                    datetime.now() - latest_at
                ).total_seconds() // 3600
            ),
        )
        running = bool(re.search(r"Running\s*=\s*1", output))
        destination_match = re.search(
            r"^Name\s*:\s*(.+)$",
            output,
            flags=re.MULTILINE,
        )
        destination = (
            destination_match.group(1).strip()
            if destination_match
            else "unknown"
        )
        if age_hours <= 30:
            status, label, color = "healthy", "Current", "#22c55e"
        elif age_hours <= 48:
            status, label, color = "warning", "Delayed", "#facc15"
        else:
            status, label, color = "critical", "Stale", "#ef4444"
        content = "\n".join([
            f"Status: {label}",
            f"Computer: {output.splitlines()[0].strip()}",
            f"Destination: {destination}",
            f"Backup Running: {'yes' if running else 'no'}",
            f"Latest Backup: {latest_at.strftime('%Y-%m-%d %I:%M:%S %p')}",
            f"Age: {age_hours} hour(s)",
            "Expected Frequency: Daily",
        ])
        return {
            "found": True,
            "file": "Live read-only M4 Time Machine probe",
            "content": content,
            "values": {
                "latest_backup_path": latest_path,
                "age_hours": age_hours,
                "running": running,
                "destination": destination,
            },
            "status": status,
            "status_label": label,
            "status_color": color,
        }
    except Exception as exc:
        return {
            "found": False,
            "file": "M4 Time Machine live probe unavailable",
            "content": f"Could not read M4 Time Machine status: {exc}",
            "values": {},
            "status": "warning",
            "status_label": "Remote Status Unavailable",
            "status_color": "#facc15",
        }


def backup_center_human_size(size_bytes):
    try:
        size = float(size_bytes)
    except Exception:
        return "unknown"

    units = ["B", "KB", "MB", "GB", "TB"]

    for unit in units:
        if size < 1024 or unit == units[-1]:
            if unit == "B":
                return f"{int(size)} {unit}"
            return f"{size:.1f} {unit}"
        size /= 1024

    return "unknown"


def backup_center_latest(directory, pattern, warning_days):
    directory = Path(directory)

    result = {
        "directory": str(directory),
        "exists": directory.exists(),
        "file": None,
        "filename": "None found",
        "timestamp": "Never",
        "age_days": None,
        "size": "unknown",
        "status": "critical",
        "status_label": "Critical",
        "status_color": "#ef4444",
        "message": "No backup was found.",
    }

    if not directory.exists():
        result["message"] = f"Backup directory does not exist: {directory}"
        return result

    try:
        files = [
            item for item in directory.glob(pattern)
            if item.is_file() and not item.name.startswith(".")
        ]
    except Exception as exc:
        result["message"] = f"Could not inspect backup directory: {exc}"
        return result

    if not files:
        return result

    latest = max(files, key=lambda item: item.stat().st_mtime)
    stat = latest.stat()
    now = time.time()
    age_days = max(0, int((now - stat.st_mtime) // 86400))

    if age_days > warning_days:
        status = "critical"
        status_label = "Critical"
        status_color = "#ef4444"
        message = f"Backup is overdue at {age_days} days old."
    elif age_days >= max(1, warning_days - 2):
        status = "warning"
        status_label = "Warning"
        status_color = "#facc15"
        message = f"Backup is approaching its {warning_days}-day limit."
    else:
        status = "healthy"
        status_label = "Healthy"
        status_color = "#22c55e"
        message = "Backup is current."

    result.update({
        "file": str(latest),
        "filename": latest.name,
        "timestamp": datetime.fromtimestamp(
            stat.st_mtime
        ).strftime("%Y-%m-%d %I:%M:%S %p"),
        "age_days": age_days,
        "size": backup_center_human_size(stat.st_size),
        "status": status,
        "status_label": status_label,
        "status_color": status_color,
        "message": message,
    })

    return result


def backup_center_read_report(candidates):
    """
    Read Time Machine health from either the current JSON status file
    or an older colon-delimited text watchdog report.
    """
    for candidate in candidates:
        candidate = Path(candidate)

        if not candidate.exists() or not candidate.is_file():
            continue

        try:
            content = candidate.read_text(errors="replace").strip()
            values = {}

            if candidate.suffix.lower() == ".json":
                parsed = json.loads(content)

                if not isinstance(parsed, dict):
                    raise ValueError("JSON report root is not an object.")

                values = {
                    str(key).strip().lower(): value
                    for key, value in parsed.items()
                }
            else:
                for line in content.splitlines():
                    if ":" not in line:
                        continue

                    key, value = line.split(":", 1)
                    values[key.strip().lower()] = value.strip()

            raw_status = str(values.get("status", "unknown")).strip().lower()
            error_text = str(values.get("error", "") or "").strip()
            configured = str(
                values.get("destination_configured", "true")
            ).strip().lower()
            qnap_ping = str(values.get("qnap_ping", "unknown")).strip().lower()
            smb_445 = str(values.get("smb_445", "unknown")).strip().lower()

            if (
                raw_status in {"current", "ok", "healthy"}
                and configured in {"true", "yes", "1"}
                and not error_text
            ):
                status = "healthy"
                label = "Current"
                color = "#22c55e"
            elif raw_status in {
                "warning", "watch", "stale", "delayed", "running"
            }:
                status = "warning"
                label = raw_status.title()
                color = "#facc15"
            else:
                status = "critical"
                label = (
                    raw_status.title()
                    if raw_status and raw_status != "unknown"
                    else "Critical"
                )
                color = "#ef4444"

            checked_at = str(values.get("checked_at", "unknown"))
            last_backup = str(values.get("last_backup_path", "unknown"))
            destination = str(
                values.get("destination_name", "unknown")
            )
            activity = str(values.get("backup_activity", "unknown"))

            summary_lines = [
                f"Status: {values.get('status', 'unknown')}",
                f"Checked At: {checked_at}",
                f"Computer: {values.get('host', 'unknown')}",
                f"Destination: {destination}",
                f"Backup Activity: {activity}",
                f"QNAP Reachable: {qnap_ping}",
                f"SMB Port 445: {smb_445}",
                f"Last Backup: {last_backup}",
            ]

            if error_text:
                summary_lines.append(f"Error: {error_text}")

            return {
                "found": True,
                "file": str(candidate),
                "content": "\n".join(summary_lines),
                "values": values,
                "status": status,
                "status_label": label,
                "status_color": color,
            }

        except Exception as exc:
            return {
                "found": False,
                "file": str(candidate),
                "content": f"Could not read Time Machine report: {exc}",
                "values": {},
                "status": "critical",
                "status_label": "Report Error",
                "status_color": "#ef4444",
            }

    return {
        "found": False,
        "file": "No Time Machine status report found",
        "content": "No Time Machine status report was found.",
        "values": {},
        "status": "warning",
        "status_label": "Report Missing",
        "status_color": "#facc15",
    }


def backup_center_qnap(remote_data=None):
    """
    Check that the QNAP share is mounted and writable, and obtain storage
    data without parsing df output. This works even when the share name
    contains spaces.
    """
    mount_path = Path("/mnt/qnap-backup")

    if remote_data is not None:
        mounted = bool(remote_data.get("mounted"))
        if not mounted:
            return {
                "mounted": False,
                "writable": None,
                "status": "warning",
                "status_label": "Not Mounted on Intel Mini",
                "status_color": "#facc15",
                "path": str(remote_data.get("path", mount_path)),
                "total": "unknown",
                "used": "unknown",
                "free": "unknown",
                "percent": "unknown",
            }
        percent_number = int(remote_data.get("percent_number", 0) or 0)
        if percent_number >= 90:
            status, label, color = (
                "critical",
                "Mounted — Storage Critical",
                "#ef4444",
            )
        elif percent_number >= 80:
            status, label, color = (
                "warning",
                "Mounted — Storage Warning",
                "#facc15",
            )
        else:
            status, label, color = (
                "healthy",
                "Mounted on Intel Mini",
                "#22c55e",
            )
        return {
            "mounted": True,
            "writable": None,
            "status": status,
            "status_label": label,
            "status_color": color,
            "path": str(remote_data.get("path", mount_path)),
            "total": str(remote_data.get("total", "unknown")),
            "used": str(remote_data.get("used", "unknown")),
            "free": str(remote_data.get("free", "unknown")),
            "percent": f"{percent_number}%",
        }

    try:
        mounted_result = subprocess.run(
            ["mountpoint", "-q", str(mount_path)],
            timeout=10,
            check=False,
        )
        mounted = mounted_result.returncode == 0
    except Exception:
        mounted = False

    if not mounted:
        return {
            "mounted": False,
            "writable": False,
            "status": "critical",
            "status_label": "Not Mounted",
            "status_color": "#ef4444",
            "path": str(mount_path),
            "total": "unknown",
            "used": "unknown",
            "free": "unknown",
            "percent": "unknown",
        }

    writable = False
    test_file = mount_path / (
        f".openclaw-dashboard-write-test-{int(time.time())}"
    )

    try:
        test_file.write_text("OpenClaw QNAP dashboard write test\n")
        test_file.unlink()
        writable = True
    except Exception:
        try:
            if test_file.exists():
                test_file.unlink()
        except Exception:
            pass

    try:
        usage = shutil.disk_usage(mount_path)
        total = int(usage.total)
        used = int(usage.used)
        free = int(usage.free)
        percent_number = round((used / total) * 100) if total else 0
        percent = f"{percent_number}%"

        if not writable:
            status = "critical"
            label = "Mounted — Not Writable"
            color = "#ef4444"
        elif percent_number >= 90:
            status = "critical"
            label = "Mounted — Storage Critical"
            color = "#ef4444"
        elif percent_number >= 80:
            status = "warning"
            label = "Mounted — Storage Warning"
            color = "#facc15"
        else:
            status = "healthy"
            label = "Mounted & Writable"
            color = "#22c55e"

        return {
            "mounted": True,
            "writable": writable,
            "status": status,
            "status_label": label,
            "status_color": color,
            "path": str(mount_path),
            "total": backup_center_human_size(total),
            "used": backup_center_human_size(used),
            "free": backup_center_human_size(free),
            "percent": percent,
        }

    except Exception:
        return {
            "mounted": True,
            "writable": writable,
            "status": "warning" if writable else "critical",
            "status_label": (
                "Mounted & Writable — Storage Unknown"
                if writable
                else "Mounted — Storage Unknown"
            ),
            "status_color": "#facc15" if writable else "#ef4444",
            "path": str(mount_path),
            "total": "unknown",
            "used": "unknown",
            "free": "unknown",
            "percent": "unknown",
        }



def backup_center_verification():
    report_path = REMOTE_BACKUP_REPORT_PATH

    if not report_path.exists():
        return {
            "status": "warning",
            "status_label": "Report Missing",
            "status_color": "#facc15",
            "checked_at": "unknown",
            "host": "unknown",
            "verified_count": 0,
            "warning_count": 1,
            "failed_count": 0,
            "backups": [],
            "report_file": str(report_path),
            "message": "The backup verification report was not found.",
        }

    try:
        data = json.loads(report_path.read_text())

        overall = str(
            data.get("overall_status", "warning")
        ).strip().lower()

        verified_count = int(data.get("verified_count", 0) or 0)
        warning_count = int(data.get("warning_count", 0) or 0)
        failed_count = int(data.get("failed_count", 0) or 0)

        backups = data.get("backups", [])
        if not isinstance(backups, list):
            backups = []

        if failed_count > 0 or overall == "critical":
            status = "critical"
            status_label = "Verification Failed"
            status_color = "#ef4444"
        elif warning_count > 0 or overall != "healthy":
            status = "warning"
            status_label = "Verification Warning"
            status_color = "#facc15"
        else:
            status = "healthy"
            status_label = "Verified"
            status_color = "#22c55e"

        return {
            "status": status,
            "status_label": status_label,
            "status_color": status_color,
            "checked_at": str(
                data.get("checked_at", "unknown")
            ).strip(),
            "host": str(data.get("host", "unknown")).strip(),
            "verified_count": verified_count,
            "warning_count": warning_count,
            "failed_count": failed_count,
            "backups": backups,
            "report_file": str(report_path),
            "message": "Latest verification report loaded.",
        }

    except Exception as exc:
        return {
            "status": "critical",
            "status_label": "Report Error",
            "status_color": "#ef4444",
            "checked_at": "unknown",
            "host": "unknown",
            "verified_count": 0,
            "warning_count": 0,
            "failed_count": 1,
            "backups": [],
            "report_file": str(report_path),
            "message": f"Could not read verification report: {exc}",
        }


def backup_center_history(remote_history=None):
    if remote_history is not None:
        return [
            {
                "type": str(entry.get("type", "Unknown")),
                "filename": str(entry.get("filename", "unknown")),
                "timestamp_epoch": float(entry.get("timestamp_epoch", 0)),
                "timestamp": str(entry.get("timestamp", "unknown")),
                "size": str(entry.get("size", "unknown")),
                "location": str(entry.get("location", "unknown")),
            }
            for entry in remote_history[:30]
            if isinstance(entry, dict)
        ]

    sources = [
        (
            "Production",
            BACKUP_ROOT,
            "openclaw-checkpoint-*.tar.gz",
        ),
        (
            "Development",
            BACKUP_ROOT / "dev",
            "openclaw-dev-backup-*.tar.gz",
        ),
        (
            "Dashboard / PropertyManager",
            BACKUP_ROOT / "dashboard-property-backups",
            "dashboard-property-backup-*.tar.gz",
        ),
    ]

    history = []

    for backup_type, directory, pattern in sources:
        directory = Path(directory)

        if not directory.exists():
            continue

        try:
            for item in directory.glob(pattern):
                if not item.is_file() or item.name.startswith("."):
                    continue

                stat = item.stat()

                history.append({
                    "type": backup_type,
                    "filename": item.name,
                    "timestamp_epoch": stat.st_mtime,
                    "timestamp": datetime.fromtimestamp(
                        stat.st_mtime
                    ).strftime("%Y-%m-%d %I:%M %p"),
                    "size": backup_center_human_size(stat.st_size),
                    "location": str(item.parent),
                })
        except Exception:
            continue

    history.sort(
        key=lambda entry: entry["timestamp_epoch"],
        reverse=True,
    )

    return history[:30]


def backup_center_status_card(title, icon, data, action_html=""):
    age = (
        f"{data['age_days']} day(s)"
        if data.get("age_days") is not None
        else "unknown"
    )

    return f"""
<div style="
    background:#0f172a;
    border:1px solid #334155;
    border-left:6px solid {data['status_color']};
    border-radius:12px;
    padding:18px;
">
    <div style="
        display:flex;
        justify-content:space-between;
        align-items:flex-start;
        gap:15px;
        flex-wrap:wrap;
    ">
        <div>
            <h2 style="margin:0 0 8px 0;">{icon} {html_module.escape(title)}</h2>
            <span style="
                display:inline-block;
                background:{data['status_color']};
                color:#07111f;
                border-radius:7px;
                padding:5px 9px;
                font-weight:bold;
            ">
                {html_module.escape(data['status_label'])}
            </span>
        </div>
        <div>{action_html}</div>
    </div>

    <div style="
        display:grid;
        grid-template-columns:repeat(auto-fit,minmax(190px,1fr));
        gap:12px;
        margin-top:18px;
    ">
        <div>
            <b>Latest backup</b><br>
            <span style="color:#cbd5e1;">
                {html_module.escape(data['timestamp'])}
            </span>
        </div>
        <div>
            <b>Age</b><br>
            <span style="color:#cbd5e1;">
                {html_module.escape(age)}
            </span>
        </div>
        <div>
            <b>Size</b><br>
            <span style="color:#cbd5e1;">
                {html_module.escape(data['size'])}
            </span>
        </div>
    </div>

    <div style="margin-top:14px;color:#e2e8f0;">
        {html_module.escape(data['message'])}
    </div>

    <details style="margin-top:14px;">
        <summary style="cursor:pointer;font-weight:bold;">
            File and storage details
        </summary>
        <div style="
            margin-top:10px;
            background:#020617;
            padding:12px;
            border-radius:8px;
            overflow-wrap:anywhere;
        ">
            <b>File:</b>
            {html_module.escape(data['filename'])}<br><br>
            <b>Directory:</b>
            {html_module.escape(data['directory'])}
        </div>
    </details>
</div>
"""


def backup_center_page_shell(body):
    return f"""
<!doctype html>
<html>
<head>
<title>Backup &amp; Recovery Center</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body {{
    background:#1e293b;
    color:white;
    font-family:Arial,sans-serif;
    padding:20px;
    margin:0;
}}
a {{
    color:#93c5fd;
}}
.nav {{
    display:flex;
    gap:10px;
    flex-wrap:wrap;
    margin-bottom:20px;
}}
.nav a {{
    background:#334155;
    color:white;
    text-decoration:none;
    padding:10px 14px;
    border-radius:7px;
    font-weight:bold;
}}
.panel {{
    background:#273549;
    padding:20px;
    margin-bottom:20px;
    border-radius:12px;
}}
button {{
    background:#60a5fa;
    color:#07111f;
    border:none;
    padding:10px 15px;
    border-radius:6px;
    font-weight:bold;
    cursor:pointer;
}}
button:hover {{
    background:#93c5fd;
}}
table {{
    width:100%;
    min-width:720px;
    border-collapse:collapse;
    table-layout:fixed;
}}
th, td {{
    border-bottom:1px solid #475569;
    padding:11px 12px;
    text-align:left;
    vertical-align:top;
    overflow-wrap:anywhere;
}}
th {{
    color:#e2e8f0;
    background:#334155;
    border-bottom:2px solid #64748b;
}}
tbody tr:hover td {{
    background:#2f4057;
}}
code {{
    white-space:normal;
    overflow-wrap:anywhere;
}}
.notice {{
    padding:14px;
    border-radius:9px;
    margin-bottom:18px;
    font-weight:bold;
}}
</style>
</head>
<body>
<h1>🛡️ Backup &amp; Recovery Center</h1>

{openclaw_shared_navigation()}

{body}

</body>
</html>
"""


@app.route("/backup-recovery")
def backup_recovery_center():
    remote_error = ""
    try:
        remote_snapshot = backup_center_remote_probe()
        remote_entries = {
            str(item.get("key")): item
            for item in remote_snapshot["backups"]
            if isinstance(item, dict)
        }
        production = backup_center_remote_latest(
            remote_entries.get("production", {}),
            BACKUP_WARNING_DAYS["production"],
        )
        development = backup_center_remote_latest(
            remote_entries.get("development", {}),
            BACKUP_WARNING_DAYS["development"],
        )
        dashboard = backup_center_remote_latest(
            remote_entries.get("dashboard", {}),
            BACKUP_WARNING_DAYS["dashboard"],
        )
        qnap = backup_center_qnap(remote_snapshot.get("qnap", {}))
        history = backup_center_history(remote_snapshot.get("history", []))
    except Exception as exc:
        remote_snapshot = {}
        remote_error = f"Intel Mini backup probe unavailable: {exc}"
        unavailable = {
            "directory": "/mnt/ai-storage/openclaw-backups",
            "filename": "Remote status unavailable",
            "size": "unknown",
            "status": "missing",
            "message": remote_error,
        }
        production = backup_center_remote_latest(
            unavailable,
            BACKUP_WARNING_DAYS["production"],
        )
        development = backup_center_remote_latest(
            {
                **unavailable,
                "directory": "/mnt/ai-storage/openclaw-backups/dev",
            },
            BACKUP_WARNING_DAYS["development"],
        )
        dashboard = backup_center_remote_latest(
            {
                **unavailable,
                "directory": (
                    "/mnt/ai-storage/openclaw-backups/"
                    "dashboard-property-backups"
                ),
            },
            BACKUP_WARNING_DAYS["dashboard"],
        )
        qnap = {
            "mounted": False,
            "writable": None,
            "status": "warning",
            "status_label": "Remote Status Unavailable",
            "status_color": "#facc15",
            "path": "/mnt/qnap-backup on Intel Mini",
            "total": "unknown",
            "used": "unknown",
            "free": "unknown",
            "percent": "unknown",
        }
        history = []

    time_machine = backup_center_m4_time_machine()
    report_fallback = backup_center_read_report([
        REPORT_DIR / "system_manager/m4_timemachine_status.json",
        REPORT_DIR / "system_manager/m4_timemachine_watchdog_report.txt",
        REPORT_DIR / "system_manager/m4_time_machine_watchdog_report.txt",
        REPORT_DIR / "system_manager/time_machine_watchdog_report.txt",
        REPORT_DIR / "system_manager/timemachine_watchdog_report.txt",
    ])
    if not time_machine["found"] and report_fallback["found"]:
        time_machine = report_fallback

    verification = backup_center_verification()

    component_statuses = [
        production["status"],
        development["status"],
        dashboard["status"],
        time_machine["status"],
        qnap["status"],
        verification["status"],
    ]

    if "critical" in component_statuses:
        overall_label = "Action Required"
        overall_color = "#ef4444"
        overall_icon = "🔴"
    elif "warning" in component_statuses:
        overall_label = "Warning"
        overall_color = "#facc15"
        overall_icon = "🟡"
    else:
        overall_label = "Healthy"
        overall_color = "#22c55e"
        overall_icon = "🟢"

    action_result = request.args.get("result", "")
    action_message = request.args.get("message", "")

    notice_html = ""

    if action_result:
        notice_color = (
            "#166534"
            if action_result == "success"
            else "#991b1b"
        )

        notice_html = f"""
<div class="notice" style="background:{notice_color};">
    {html_module.escape(action_message)}
</div>
"""

    production_action = """
<div style="color:#cbd5e1;max-width:300px;">
Production backups cannot be started from the development dashboard.
Run them on the Intel Mini only after explicit production approval.
</div>
"""

    development_action = """
<form method="POST"
      action="/backup-recovery/run/development"
      onsubmit="
        if (!window.confirm(
          'Create a development backup on the Intel Mini external drive?'
        )) return false;
        this.querySelector('button').disabled=true;
        this.querySelector('button').innerText='Backup running...';
      ">
    <button type="submit">Run Development Backup Now</button>
</form>
"""

    dashboard_action = """
<div style="color:#cbd5e1;max-width:300px;">
Dashboard production backups cannot be started from development.
</div>
"""

    cards_html = backup_center_status_card(
        "OpenClaw Production",
        "🖥️",
        production,
        production_action,
    )

    cards_html += backup_center_status_card(
        "OpenClaw Development",
        "🧪",
        development,
        development_action,
    )

    cards_html += backup_center_status_card(
        "Dashboard & PropertyManager",
        "📊",
        dashboard,
        dashboard_action,
    )

    tm_details = html_module.escape(time_machine["content"])

    time_machine_html = f"""
<div style="
    background:#0f172a;
    border:1px solid #334155;
    border-left:6px solid {time_machine['status_color']};
    border-radius:12px;
    padding:18px;
">
    <h2 style="margin-top:0;">🍎 M4 Time Machine</h2>

    <span style="
        display:inline-block;
        background:{time_machine['status_color']};
        color:#07111f;
        border-radius:7px;
        padding:5px 9px;
        font-weight:bold;
    ">
        {html_module.escape(time_machine['status_label'])}
    </span>

    <p>
        <b>Report:</b>
        {html_module.escape(time_machine['file'])}
    </p>

    <details>
        <summary style="cursor:pointer;font-weight:bold;">
            View watchdog report
        </summary>
        <pre style="
            background:#020617;
            padding:12px;
            border-radius:8px;
            white-space:pre-wrap;
            overflow-wrap:anywhere;
        ">{tm_details}</pre>
    </details>
</div>
"""

    qnap_html = f"""
<div style="
    background:#0f172a;
    border:1px solid #334155;
    border-left:6px solid {qnap['status_color']};
    border-radius:12px;
    padding:18px;
">
    <h2 style="margin-top:0;">🗄️ QNAP NAS</h2>

    <span style="
        display:inline-block;
        background:{qnap['status_color']};
        color:#07111f;
        border-radius:7px;
        padding:5px 9px;
        font-weight:bold;
    ">
        {html_module.escape(qnap['status_label'])}
    </span>

    <div style="
        display:grid;
        grid-template-columns:repeat(auto-fit,minmax(160px,1fr));
        gap:12px;
        margin-top:18px;
    ">
        <div><b>Used</b><br>{html_module.escape(qnap['used'])}</div>
        <div><b>Free</b><br>{html_module.escape(qnap['free'])}</div>
        <div><b>Total</b><br>{html_module.escape(qnap['total'])}</div>
        <div><b>Percent used</b><br>{html_module.escape(qnap['percent'])}</div>
    </div>

    <p>
        <b>Mount path:</b>
        {html_module.escape(qnap['path'])}
    </p>
</div>
"""

    verification_rows = ""

    for item in verification["backups"]:
        archive_status = str(
            item.get("status", "unknown")
        ).strip().lower()

        checksum_status = str(
            item.get("checksum_status", "not_available")
        ).strip().lower()

        if archive_status == "verified":
            archive_label = "Verified"
            archive_color = "#22c55e"
        elif archive_status == "failed":
            archive_label = "Failed"
            archive_color = "#ef4444"
        else:
            archive_label = archive_status.title() or "Unknown"
            archive_color = "#facc15"

        if checksum_status == "verified":
            checksum_label = "SHA-256 Verified"
            checksum_color = "#22c55e"
        elif checksum_status == "failed":
            checksum_label = "SHA-256 Failed"
            checksum_color = "#ef4444"
        else:
            checksum_label = "Not Available"
            checksum_color = "#94a3b8"

        verification_rows += f"""
<tr>
    <td>
        {html_module.escape(str(item.get('label', 'Unknown')))}
    </td>
    <td style="overflow-wrap:anywhere;">
        {html_module.escape(str(item.get('filename', 'unknown')))}
    </td>
    <td>
        {html_module.escape(str(item.get('size', 'unknown')))}
    </td>
    <td>
        <span style="
            display:inline-block;
            background:{archive_color};
            color:#07111f;
            padding:4px 8px;
            border-radius:6px;
            font-weight:bold;
            white-space:nowrap;
        ">
            {html_module.escape(archive_label)}
        </span>
    </td>
    <td>
        <span style="
            display:inline-block;
            background:{checksum_color};
            color:#07111f;
            padding:4px 8px;
            border-radius:6px;
            font-weight:bold;
            white-space:nowrap;
        ">
            {html_module.escape(checksum_label)}
        </span>
    </td>
    <td>
        {html_module.escape(str(item.get('modified', 'unknown')))}
    </td>
</tr>
"""

    if not verification_rows:
        verification_rows = """
<tr>
    <td colspan="6">
        No individual verification entries were found.
    </td>
</tr>
"""

    verification_html = f"""
<div class="panel" style="
    border-left:7px solid {verification['status_color']};
">
    <div style="
        display:flex;
        justify-content:space-between;
        align-items:flex-start;
        gap:20px;
        flex-wrap:wrap;
    ">
        <div>
            <h2 style="margin-bottom:8px;">
                🔍 Backup Verification
            </h2>

            <span style="
                display:inline-block;
                background:{verification['status_color']};
                color:#07111f;
                border-radius:7px;
                padding:5px 9px;
                font-weight:bold;
            ">
                {html_module.escape(verification['status_label'])}
            </span>
        </div>

        <form method="POST"
              action="/backup-recovery/verify"
              onsubmit="
                this.querySelector('button').disabled=true;
                this.querySelector('button').innerText='Verification running...';
              ">
            <button type="submit">
                Run Verification Now
            </button>
        </form>
    </div>

    <div style="
        display:grid;
        grid-template-columns:repeat(auto-fit,minmax(150px,1fr));
        gap:12px;
        margin-top:18px;
        margin-bottom:18px;
    ">
        <div>
            <b>Last checked</b><br>
            {html_module.escape(verification['checked_at'])}
        </div>

        <div>
            <b>Verified</b><br>
            {verification['verified_count']}
        </div>

        <div>
            <b>Warnings</b><br>
            {verification['warning_count']}
        </div>

        <div>
            <b>Failures</b><br>
            {verification['failed_count']}
        </div>

        <div>
            <b>Host</b><br>
            {html_module.escape(verification['host'])}
        </div>
    </div>

    <div style="overflow-x:auto;">
        <table>
            <thead>
                <tr>
                    <th>Backup</th>
                    <th>Archive</th>
                    <th>Size</th>
                    <th>Archive test</th>
                    <th>Checksum</th>
                    <th>Backup modified</th>
                </tr>
            </thead>

            <tbody>
                {verification_rows}
            </tbody>
        </table>
    </div>

    <details style="margin-top:14px;">
        <summary style="cursor:pointer;font-weight:bold;">
            Verification report details
        </summary>

        <p>
            <b>Report:</b>
            {html_module.escape(verification['report_file'])}
        </p>

        <p>
            {html_module.escape(verification['message'])}
        </p>
    </details>
</div>
"""

    history_rows = ""

    for entry in history:
        history_rows += f"""
<tr>
    <td>{html_module.escape(entry['timestamp'])}</td>
    <td>{html_module.escape(entry['type'])}</td>
    <td>{html_module.escape(entry['size'])}</td>
    <td style="overflow-wrap:anywhere;">
        {html_module.escape(entry['filename'])}
    </td>
</tr>
"""

    if not history_rows:
        history_rows = """
<tr>
    <td colspan="4">No backup history was found.</td>
</tr>
"""

    remote_notice = (
        f"""
<div class="notice" style="background:#92400e;">
    {html_module.escape(remote_error)}
</div>
"""
        if remote_error
        else """
<div class="notice" style="background:#1e3a5f;">
    Backup inventory and QNAP capacity are read-only live results from the
    Intel Mini. Production write actions remain disabled in development.
</div>
"""
    )

    body = f"""
{notice_html}
{remote_notice}

<div class="panel" style="border-left:7px solid {overall_color};">
    <div style="
        display:flex;
        justify-content:space-between;
        align-items:center;
        gap:20px;
        flex-wrap:wrap;
    ">
        <div>
            <h2 style="margin-bottom:8px;">Overall Backup Health</h2>
            <div style="font-size:26px;font-weight:bold;">
                {overall_icon} {overall_label}
            </div>
        </div>
        <div style="color:#cbd5e1;">
            Updated:
            {datetime.now().strftime("%A, %B %d, %Y %I:%M:%S %p")}
        </div>
    </div>
</div>

<div style="
    display:grid;
    grid-template-columns:repeat(auto-fit,minmax(360px,1fr));
    gap:18px;
    margin-bottom:20px;
">
    {cards_html}
</div>

<div style="
    display:grid;
    grid-template-columns:repeat(auto-fit,minmax(360px,1fr));
    gap:18px;
    margin-bottom:20px;
">
    {time_machine_html}
    {qnap_html}
</div>

{verification_html}

<div class="panel">
    <h2>📜 Recent Backup History</h2>
    <div style="overflow-x:auto;">
        <table>
            <thead>
                <tr>
                    <th>Date and time</th>
                    <th>Backup type</th>
                    <th>Size</th>
                    <th>Filename</th>
                </tr>
            </thead>
            <tbody>
                {history_rows}
            </tbody>
        </table>
    </div>
</div>

<div class="panel">
    <h2>🧭 Recovery</h2>

    <p>
        Backup discovery and manual backup creation are active.
        Automated restore actions are intentionally disabled in Phase 1.
    </p>

    <p style="color:#facc15;font-weight:bold;">
        A restore can replace active files and databases. Phase 2 will add
        backup validation, confirmation screens, pre-restore safety
        snapshots, and documented rollback steps before restore buttons
        are enabled.
    </p>
</div>
"""

    return backup_center_page_shell(body)



@app.route("/backup-recovery/verify", methods=["POST"])
def backup_recovery_verify():
    from urllib.parse import quote_plus

    try:
        snapshot = backup_center_remote_probe(verify=True)
        backups = snapshot.get("backups", [])
        failed_count = sum(
            1 for item in backups if item.get("status") == "failed"
        )
        verified_count = sum(
            1 for item in backups if item.get("status") == "verified"
        )
        warning_count = sum(
            1
            for item in backups
            if item.get("status") not in {"verified", "failed"}
            or item.get("checksum_status") == "not_available"
        )
        overall_status = (
            "critical"
            if failed_count
            else "warning"
            if warning_count
            else "healthy"
        )
        report = {
            "checked_at": snapshot.get("checked_at", "unknown"),
            "host": snapshot.get("host", "unknown"),
            "overall_status": overall_status,
            "verified_count": verified_count,
            "warning_count": warning_count,
            "failed_count": failed_count,
            "backups": backups,
        }
        REMOTE_BACKUP_REPORT_PATH.parent.mkdir(
            parents=True,
            exist_ok=True,
        )
        temporary_report = REMOTE_BACKUP_REPORT_PATH.with_suffix(".tmp")
        temporary_report.write_text(
            json.dumps(report, indent=2) + "\n"
        )
        temporary_report.replace(REMOTE_BACKUP_REPORT_PATH)
        if failed_count:
            message = (
                f"Remote verification completed with {failed_count} "
                "failed archive(s)."
            )
            action_result = "error"
        else:
            message = (
                "Remote verification completed without archive failures."
            )
            action_result = "success"
    except subprocess.TimeoutExpired:
        message = "Remote backup verification timed out."
        action_result = "error"

    except Exception as exc:
        message = f"Remote backup verification could not run: {exc}"
        action_result = "error"

    return redirect(
        "/backup-recovery?result="
        + action_result
        + "&message="
        + quote_plus(message)
    )


@app.route("/backup-recovery/run/<backup_type>", methods=["POST"])
def backup_recovery_run(backup_type):
    managers = {
        "development": (
            DEVELOPMENT_BACKUP_MANAGER,
            "Development OpenClaw backup completed successfully.",
        ),
    }

    if backup_type not in managers:
        return redirect(
            "/backup-recovery?result=error&message="
            "Production+backup+actions+are+disabled+in+development."
        )

    manager, success_message = managers[backup_type]

    if not manager.exists() or not manager.is_file():
        return redirect(
            "/backup-recovery?result=error&message="
            + html_module.escape(
                f"Backup manager was not found: {manager}"
            )
        )

    try:
        result = subprocess.run(
            [str(manager), "now"],
            capture_output=True,
            text=True,
            timeout=7200,
            check=False,
        )

        output = (result.stdout + "\n" + result.stderr).strip()

        if result.returncode == 0:
            message = success_message
            action_result = "success"
        else:
            last_line = output.splitlines()[-1] if output else "Unknown error"
            message = (
                f"Backup failed with exit code {result.returncode}: "
                f"{last_line}"
            )
            action_result = "error"

    except subprocess.TimeoutExpired:
        message = "Backup timed out before completion."
        action_result = "error"
    except Exception as exc:
        message = f"Backup could not be started: {exc}"
        action_result = "error"

    from urllib.parse import quote_plus

    return redirect(
        "/backup-recovery?result="
        + action_result
        + "&message="
        + quote_plus(message)
    )



@app.route("/")
def home():
    backup_success = request.args.get("backup")
    drift = check_ai_drift()

    services = build_system_health()

    html = """
<html>
<head>
<title>OpenClaw AI Dashboard</title>
<style>
body { background-color:#1e293b; color:white; font-family:Arial; padding:20px; }
.panel { background-color:#273549; padding:20px; margin-bottom:20px; border-radius:10px; }
.output { background-color:#020d24; padding:15px; border-radius:6px; white-space:pre-wrap; overflow-x:auto; }
button { background-color:#60a5fa; color:black; border:none; padding:10px 15px; border-radius:5px; font-weight:bold; }
.warning-box { padding:15px; border-radius:8px; margin-bottom:15px; color:white; font-weight:bold; }
.chart { background:white; padding:10px; border-radius:8px; margin-bottom:18px; width:900px; max-width:100%; }
h1, h2 { margin-top:0; }
</style>
</head>
<body>
<h1>OpenClaw AI Dashboard</h1>

__OPENCLAW_SHARED_NAVIGATION__
"""

    html = html.replace(
        "__OPENCLAW_SHARED_NAVIGATION__",
        openclaw_shared_navigation(),
        1,
    )

    html += "<div class='panel'><h2>System Connectivity Check</h2>"

    if drift and drift.get("warnings", []):
        warning_info = classify_warning(drift["warnings"][0])
        html += f"""
<div class="warning-box" style="background-color:{warning_info['color']};">
{warning_info['title']}<br><br>{warning_info['details']}
</div>
<div class="output">System Check
Latest summary: {drift['file']}

Status:
"""
        for w in drift["warnings"]:
            html += f"- {w}\n"
        html += "</div>"
    else:
        html += """
<div class="warning-box" style="background-color:green;">
All monitored OpenClaw services are connected.
</div>
"""

    html += "</div>"

    # -------------------------------------------------------
    # M4 OLLAMA CONNECTIVITY PANEL
    # -------------------------------------------------------
    m4 = get_m4_ollama_status()

    if m4["connected"]:
        html += f"""
        <div class='panel'>
            <h2>🧠 Intel Mini → M4 Model Server</h2>
            <div class='status-box'>
                <b>Status:</b> <span style='color:#7CFC00;'>Connected</span><br><br>
                <b>Endpoint:</b> {m4["endpoint"]}<br><br>
                <b>Models Returned:</b> {m4["display_count"]}<br><br>
                <b>Primary Model:</b> {m4["primary"]}<br><br>
                <b>Detected Models:</b> {m4["detected_models"]}
            </div>
        </div>
        """
    else:
        html += f"""
        <div class='panel'>
            <h2>🧠 Intel Mini → M4 Model Server</h2>
            <div class='warning-box'>
                <b>Status:</b> Offline<br><br>
                <b>Endpoint:</b> {m4["endpoint"]}<br><br>
                <b>Error:</b> {m4["error"]}
            </div>
        </div>
        """

    html += m4_ai_health_panel_html(m4)
    html += ai_routing_telemetry_panel_html()

    html += model_status_panel_html(
        m4,
        run_live_checks=request.args.get("run_model_checks") == "1",
    )

    trend_refresh_msg = ""
    if request.args.get("refresh_trends") == "1":
        collect_result = collect_trend_sample()
        if collect_result["success"]:
            trend_refresh_msg = "Fresh trend sample collected and charts refreshed."
        else:
            trend_refresh_msg = "Chart refresh ran, but trend sample collection had a warning: " + collect_result["message"]

    chart_files = generate_trend_charts()

    html += f"""
    <div class='panel'>
        <h2>Trend Charts</h2>
        <form method='get' action='/' onsubmit="
document.getElementById('refreshMsg').innerHTML='Collecting fresh sample and refreshing charts...';
document.getElementById('refreshBtn').disabled=true;
document.getElementById('refreshBtn').innerText='Refreshing...';
">
            <input type='hidden' name='refresh_trends' value='1'>
            <button id='refreshBtn' type='submit'>Collect Fresh Sample + Refresh Charts</button>
        </form>

<div id='refreshMsg'
style='margin-top:10px;color:#7CFC00;font-weight:bold;'>{trend_refresh_msg}</div>
        <br>
    """

    if chart_files:
        for chart in chart_files:
            html += f'<img class="chart" src="/graphs/{chart}?t={datetime.now().timestamp()}">'
    else:
        html += f"""
<div class="output">
No trend charts available.

Trend file checked:
{TREND_FILE}
</div>
"""

    html += "</div>"

    html += storage_panel_html()

    html += """
<div class='panel'>
<h2>Manual Backup</h2>
<form method='POST' action='/backup' onsubmit="document.getElementById('backupStatusMsg').innerHTML='Backup in progress...'; document.getElementById('backupBtn').disabled=true; document.getElementById('backupBtn').innerText='Working...';">
<button id='backupBtn' type='submit'>Backup Now</button>
</form>
<div id='backupStatusMsg' style='margin-top:10px;color:#7CFC00;font-weight:bold;'></div>
"""

    if backup_success == "success":
        html += """
<div class='status-box' style='margin-top:10px;'>
<b>Dashboard Backup Completed Successfully</b>
</div>
"""

    html += latest_backup_html()

    html += """
</div>
"""

    cpu = run_command("top -bn1 | grep 'Cpu(s)' | awk '{print $2}'")
    ram = run_command("free -h | awk '/Mem:/ {print $3 \" / \" $2}'")
    disk = run_command("df -h / | awk 'NR==2 {print $3 \" / \" $2 \" (\" $5 \")\"}'")
    docker = run_command("docker ps -q | wc -l")

    html += f"""
<div class="panel">
<h2>Live Resource Monitor</h2>
<div class="output">CPU Usage:
{cpu}% used

RAM Usage:
{ram}

Disk Usage:
{disk}

Running Docker Containers:
{docker}</div>
</div>
"""
    html += """
</body>
</html>
"""


    # -------------------------------------------------------



    # Remove duplicate top System Status summary box from final rendered HTML
    start_marker = '<div class="warning-box" style="background-color:#555555;">'
    end_marker = '</div>'
    title_marker = 'System Status<br><br>'

    pos = html.find(title_marker)

    if pos != -1:
        start = html.rfind(start_marker, 0, pos)
        end = html.find(end_marker, pos)

        if start != -1 and end != -1:
            html = html[:start] + html[end + len(end_marker):]


    return html




@app.route("/backup", methods=["POST"])
def backup():
    backup_dir = Path.home() / "openclaw-dashboard-backups"
    backup_dir.mkdir(parents=True, exist_ok=True)

    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_file = backup_dir / f"openclaw-dashboard-backup-{timestamp}.tar.gz"

    with tarfile.open(backup_file, "w:gz") as tar:
        app_file = Path.home() / "ai/projects/openclaw/tools/dashboard/app.py"
        svc_file = Path.home() / ".config/systemd/user/openclaw-dashboard.service"

        if app_file.exists():
            tar.add(app_file, arcname="dashboard/app.py")

        if svc_file.exists():
            tar.add(svc_file, arcname="systemd/openclaw-dashboard.service")

    return redirect("/?backup=success")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5051)
