from flask import Flask, redirect, request, send_from_directory, abort
from pathlib import Path
from datetime import datetime
import subprocess
import shutil
import tarfile
import requests
import csv
import re
import json
import time
import psycopg2
import html as html_module

import matplotlib
import html
import markdown
from urllib.parse import quote
from werkzeug.utils import secure_filename
from pypdf import PdfReader
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.dates as mdates

app = Flask(__name__)

OLLAMA_HOST = "http://127.0.0.1:11434"

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

OPENCLAW_ROOT = Path(__file__).resolve().parents[2]
AI_REPORT_DIR = OPENCLAW_ROOT / "reports/ai_intelligence"
AI_EVALUATION_PATH = AI_REPORT_DIR / "evaluation_lab/evaluation-lab-latest.json"
AI_APPROVAL_PATH = AI_REPORT_DIR / "evaluation_approvals/evaluation-approval-latest.json"
AI_CANDIDATES_PATH = (
    AI_REPORT_DIR
    / "evaluation_approvals/approved-scorecard-candidates-latest.json"
)
AI_PROMOTION_DIR = AI_REPORT_DIR / "scorecard_promotions"
AI_SCORECARD_PATH = OPENCLAW_ROOT / "config/ai_intelligence/scorecard.json"
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
    try:
        out = subprocess.check_output(
            f"df -P -h {path} | awk 'NR==2 {{print $2 \"|\" $3 \"|\" $4 \"|\" $5}}'",
            shell=True,
            text=True,
            timeout=10
        ).strip()

        total, used, free, pct = out.split("|")
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
        }
    except Exception as e:
        return {
            "label": label,
            "path": path,
            "total": "unknown",
            "used": "unknown",
            "free": "unknown",
            "pct": "0%",
            "pct_num": 0,
            "color": "#ef4444",
            "status": f"Error: {e}",
        }


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


def storage_chart_html():
    chart_file = GRAPH_DIR / "storage_usage.png"

    internal_now = get_disk_used_percent("/")
    external_now = get_disk_used_percent("/mnt/ai-storage")

    labels = []
    internal_values = []
    external_values = []

    if TREND_FILE.exists():
        try:
            with TREND_FILE.open() as f:
                rows = list(csv.DictReader(f))

            time_col = find_column(rows, ["timestamp", "time", "datetime", "date"])
            disk_col = find_column(rows, ["disk_used_percent", "disk_used_pct", "disk_pct", "disk"])

            for row in rows[-24:]:
                raw_time = row.get(time_col, "") if time_col else ""

                try:
                    dt = datetime.strptime(raw_time, "%Y-%m-%d %H:%M:%S")
                    label = dt.strftime("%m/%d %H:%M")
                except Exception:
                    label = raw_time or datetime.now().strftime("%m/%d %H:%M")

                disk_pct = parse_number(row.get(disk_col)) if disk_col else None

                labels.append(label)
                internal_values.append(disk_pct if disk_pct is not None else (internal_now or 0))
                external_values.append(external_now if external_now is not None else 0)
        except Exception:
            labels = []
            internal_values = []
            external_values = []

    if not labels:
        labels = [datetime.now().strftime("%m/%d %H:%M")]
        internal_values = [internal_now if internal_now is not None else 0]
        external_values = [external_now if external_now is not None else 0]

    GRAPH_DIR.mkdir(parents=True, exist_ok=True)

    plt.figure(figsize=(12, 4.8), facecolor="#0f172a")
    ax = plt.gca()
    ax.set_facecolor("#0f172a")

    ax.plot(labels, internal_values, marker="o", linewidth=2, label="Internal Ubuntu Disk (/)")
    ax.plot(labels, external_values, marker="o", linewidth=2, label="External AI Storage (/mnt/ai-storage)")

    ax.set_title("Internal and External Disk Space Used", color="white", pad=15)
    ax.set_xlabel("Date/Time (MM/DD HH:MM)", color="white")
    ax.set_ylabel("Disk Used (%)", color="white")
    ax.set_ylim(0, 100)

    ax.grid(True, linestyle="--", alpha=0.35)
    ax.tick_params(axis="x", colors="white", rotation=45)
    ax.tick_params(axis="y", colors="white")

    for spine in ax.spines.values():
        spine.set_color("#94a3b8")

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
    disks = [
        get_disk_info("/", "Internal Ubuntu Disk"),
        get_disk_info("/mnt/ai-storage", "External AI Storage"),
    ]

    html = """
<div class="panel">
<h2>Storage Health</h2>
<h3>Disk Usage Over Time</h3>
"""

    html += storage_chart_html()

    html += """
<h3 style="margin-top:20px;">Current Disk Status</h3>
"""

    for d in disks:
        pct = d["pct_num"]

        html += f"""
<div style="background:#0f172a;border:1px solid #334155;border-radius:10px;padding:15px;margin-top:12px;">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:15px;">
        <div style="font-size:18px;font-weight:bold;">
            {d['label']} <span style="color:#cbd5e1;">({d['path']})</span>
            <span style="background:{d['color']};color:black;border-radius:6px;padding:3px 8px;font-size:13px;margin-left:8px;">
                {d['status']}
            </span>
        </div>
        <div style="color:#cbd5e1;font-weight:bold;">{d['pct']} used</div>
    </div>

    <div style="background:#1e293b;border:1px solid #334155;border-radius:10px;overflow:hidden;height:26px;margin-top:12px;">
        <div style="width:{pct}%;background:{d['color']};height:26px;text-align:center;color:black;font-weight:bold;line-height:26px;">
            {d['pct']}
        </div>
    </div>

    <div style="display:flex;justify-content:space-between;color:#e5e7eb;margin-top:10px;font-size:15px;">
        <div><b>Used:</b> {d['used']}</div>
        <div><b>Free:</b> {d['free']}</div>
        <div><b>Total:</b> {d['total']}</div>
    </div>
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
    try:
        response = requests.post(
            f"{OLLAMA_HOST}/api/generate",
            json={
                "model": model_name,
                "prompt": "Reply with exactly: Ollama is working correctly on the Apple Mac mini.",
                "stream": False
            },
            timeout=30
        )

        data = response.json()
        text = data.get("response", "").strip().split("\n")[0]

        if len(text) > 120:
            text = text[:120]

        return {
            "success": True,
            "response": text
        }

    except Exception as e:
        return {
            "success": False,
            "response": str(e)
        }


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

    status = str(summary.get("status", "unknown"))
    configured = summary.get("configured_versus_observed", {})
    color = {
        "healthy": "#7CFC00",
        "failover-active": "#fbbf24",
        "attention": "#f97316",
    }.get(status, "#ef4444")
    preview = ""
    if text_path.exists():
        preview = html.escape(
            "\n".join(text_path.read_text(encoding="utf-8").splitlines()[:12])
        )

    return f"""
    <div class='panel'>
        <h2>AI Routing Telemetry</h2>
        <div class='status-box'>
            <b>Status:</b> <span style='color:{color};'>{html.escape(status)}</span><br><br>
            <b>Matched:</b> {html.escape(str(configured.get('matched', 0)))}<br>
            <b>Drift:</b> {html.escape(str(configured.get('drift', 0)))}<br>
            <b>Not observed:</b> {html.escape(str(configured.get('not_observed', 0)))}<br>
            <b>Recent failovers:</b> {html.escape(str(summary.get('recent_failover_count', 0)))}<br>
            <b>Recent failures:</b> {html.escape(str(summary.get('recent_failure_count', 0)))}
        </div>
        <div class='output'>{preview or 'No text summary available.'}</div>
    </div>
    """


def m4_ai_health_panel_html():
    m4_tail_ip = "100.104.100.96"
    m4_user = "andrewgraves"
    ssh_key = str(Path.home() / ".ssh/id_ed25519_openclaw_m4")

    ollama_status = "Offline"
    ollama_color = "#ef4444"
    response_ms = "unknown"
    model_count = "unknown"
    model_names = "unknown"

    start = time.time()
    try:
        r = requests.get(f"{OLLAMA_HOST}/api/tags", timeout=5)
        response_ms = int((time.time() - start) * 1000)
        if r.ok:
            data = r.json()
            models = data.get("models", [])
            model_count = len(models)
            names = [m.get("name", "") for m in models if m.get("name")]
            model_names = ", ".join(names[:8]) if names else "none"
            ollama_status = "Online"
            ollama_color = "#22c55e"
        else:
            ollama_status = f"HTTP {r.status_code}"
    except Exception as e:
        response_ms = "failed"
        model_names = str(e)[:120]

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
                "-i", ssh_key,
                "-o", "BatchMode=yes",
                "-o", "ConnectTimeout=5",
                f"{m4_user}@{m4_tail_ip}",
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

    ssh_status = "Reachable" if m4["reachable"] else "Not reachable"
    ssh_color = "#22c55e" if m4["reachable"] else "#ef4444"

    html = f"""
<div class='panel'>
<h2>🧠 M4 AI Server Health</h2>

<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:14px;">

<div style="background:#0f172a;border:1px solid #334155;border-radius:10px;padding:15px;">
<b>SSH / Tailscale</b><br><br>
<span style="color:{ssh_color};font-weight:bold;">{ssh_status}</span><br>
M4 IP: {m4_tail_ip}
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
    endpoint = "http://127.0.0.1:11434/api/tags"

    try:
        r = requests.get(endpoint, timeout=5)
        data = r.json()

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
            "detected_models": detected
        }

    except Exception as e:
        return {
            "connected": False,
            "endpoint": endpoint,
            "error": str(e),
            "model_count": 0,
            "display_count": 0,
            "primary": "Unavailable",
            "detected_models": ""
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


RANCHBRAIN_ENV_FILE = Path.home() / ".openclaw/credentials/chat-agent.env"
RANCHBRAIN_REVIEW_TOOL = Path.home() / "ai/projects/openclaw/tools/ranchbrain/ranchbrain-review.py"
OPENCLAW_PYTHON = Path.home() / "ai/projects/openclaw/.venv/bin/python"


def load_ranchbrain_env():
    values = {}

    if not RANCHBRAIN_ENV_FILE.is_file():
        return values

    for raw_line in RANCHBRAIN_ENV_FILE.read_text().splitlines():
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
        ("/ranchbrain/review", "Notes"),
        ("/ai-scorecard", "AI Model Scorecard"),
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


@app.route("/ranchbrain/review")
def ranchbrain_review():
    try:
        pending = get_ranchbrain_notes("ranchbrain_pending")

        body = """
<div class="panel">
  <h2>Pending Notes</h2>
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

        return ranchbrain_shell("RanchBrain Review", body)

    except Exception as exc:
        return ranchbrain_shell(
            "RanchBrain Review",
            f"<div class='panel'>Error: {html_module.escape(str(exc))}</div>",
        ), 500


def run_review_action(action, memory_id):
    result = subprocess.run(
        [
            str(OPENCLAW_PYTHON),
            str(RANCHBRAIN_REVIEW_TOOL),
            f"{action} {memory_id}",
        ],
        text=True,
        capture_output=True,
        timeout=180,
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


def scorecard_snapshot():
    evaluation = load_json_object(AI_EVALUATION_PATH)
    approval = load_json_object(AI_APPROVAL_PATH)
    candidates = load_json_object(AI_CANDIDATES_PATH)
    scorecard = load_json_object(AI_SCORECARD_PATH)

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
        "eligible": eligible,
        "audits": audits,
        "promotion_applied": bool(decision_id and decision_id in applied_decisions),
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
</tr>
"""
        if not eligible_rows:
            eligible_rows = "<tr><td colspan='3'>No promotion-eligible winners.</td></tr>"

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
                approval_forms = f"""
<form method="POST" action="/ai-scorecard/approve">
  <label>Type <code>APPROVE {html_module.escape(pipeline_id)}</code></label><br>
  <input name="confirmation" style="width:100%;margin:8px 0;padding:8px;">
  <input name="note" placeholder="Optional approval note"
         style="width:100%;margin:8px 0;padding:8px;">
  <button class="approve" type="submit">Approve Evaluation</button>
</form>
<form method="POST" action="/ai-scorecard/reject" style="margin-top:18px;">
  <label>Type <code>REJECT {html_module.escape(pipeline_id)}</code></label><br>
  <input name="confirmation" style="width:100%;margin:8px 0;padding:8px;">
  <input name="note" placeholder="Optional rejection note"
         style="width:100%;margin:8px 0;padding:8px;">
  <button class="reject" type="submit">Reject Evaluation</button>
</form>
"""
            elif decision == "approved" and decision_id and not snapshot["promotion_applied"]:
                approval_forms = f"""
<form method="POST" action="/ai-scorecard/promote">
  <label>Type <code>PROMOTE {html_module.escape(decision_id)}</code></label><br>
  <input name="confirmation" style="width:100%;margin:8px 0;padding:8px;">
  <button class="approve" type="submit">Promote Approved Scorecard</button>
</form>
"""
            else:
                approval_forms = (
                    "<p>No action is currently available for this pipeline.</p>"
                )
            actions = f"""
<div class="panel">
  <h2>Approval Actions — Local Connection</h2>
  <p>Every action requires the exact current pipeline or decision ID.</p>
  {approval_forms}
</div>
"""

        body = f"""
{notice}
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
  <table style="width:100%;border-collapse:collapse;">
    <tr><th>Benchmark</th><th>Model</th><th>Status</th></tr>
    {eligible_rows}
  </table>
</div>
{actions}
<div class="panel">
  <h2>Promotion Audit History</h2>
  <table style="width:100%;border-collapse:collapse;">
    <tr><th>Applied</th><th>Decision</th><th>Status</th><th>Changes</th></tr>
    {audit_rows}
  </table>
</div>
"""
        return ranchbrain_shell("AI Model Scorecard", body)
    except Exception as exc:
        return ranchbrain_shell(
            "AI Model Scorecard",
            f"<div class='panel'>Error: {html_module.escape(str(exc))}</div>",
        ), 500


def require_local_scorecard_action():
    if not scorecard_action_is_local():
        abort(403)


@app.route("/ai-scorecard/approve", methods=["POST"])
def ai_scorecard_approve():
    require_local_scorecard_action()
    evaluation = load_json_object(AI_EVALUATION_PATH) or {}
    pipeline_id = str(evaluation.get("pipeline_id", ""))
    if not pipeline_id or request.form.get("confirmation", "") != f"APPROVE {pipeline_id}":
        return scorecard_redirect("error", "Approval confirmation did not match.")
    note = str(request.form.get("note") or "").strip()[:500]
    arguments = ["--approve", pipeline_id]
    if note:
        arguments.extend(["--note", note])
    success, output = run_scorecard_action(AI_APPROVAL_TOOL, *arguments)
    return scorecard_redirect("success" if success else "error", output)


@app.route("/ai-scorecard/reject", methods=["POST"])
def ai_scorecard_reject():
    require_local_scorecard_action()
    evaluation = load_json_object(AI_EVALUATION_PATH) or {}
    pipeline_id = str(evaluation.get("pipeline_id", ""))
    if not pipeline_id or request.form.get("confirmation", "") != f"REJECT {pipeline_id}":
        return scorecard_redirect("error", "Rejection confirmation did not match.")
    note = str(request.form.get("note") or "").strip()[:500]
    arguments = ["--reject", pipeline_id]
    if note:
        arguments.extend(["--note", note])
    success, output = run_scorecard_action(AI_APPROVAL_TOOL, *arguments)
    return scorecard_redirect("success" if success else "error", output)


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

BACKUP_WARNING_DAYS = {
    "production": 10,
    "development": 8,
    "dashboard": 10,
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


def backup_center_qnap():
    """
    Check that the QNAP share is mounted and writable, and obtain storage
    data without parsing df output. This works even when the share name
    contains spaces.
    """
    mount_path = Path("/mnt/qnap-backup")

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
    report_path = (
        REPORT_DIR
        / "system_manager"
        / "openclaw_backup_verification_status.json"
    )

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


def backup_center_history():
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
    border-collapse:collapse;
}}
th, td {{
    border-bottom:1px solid #475569;
    padding:10px;
    text-align:left;
    vertical-align:top;
}}
th {{
    color:#cbd5e1;
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
    production = backup_center_latest(
        BACKUP_ROOT,
        "openclaw-checkpoint-*.tar.gz",
        BACKUP_WARNING_DAYS["production"],
    )

    development = backup_center_latest(
        BACKUP_ROOT / "dev",
        "openclaw-dev-backup-*.tar.gz",
        BACKUP_WARNING_DAYS["development"],
    )

    dashboard = backup_center_latest(
        BACKUP_ROOT / "dashboard-property-backups",
        "dashboard-property-backup-*.tar.gz",
        BACKUP_WARNING_DAYS["dashboard"],
    )

    time_machine = backup_center_read_report([
        REPORT_DIR / "system_manager/m4_timemachine_status.json",
        REPORT_DIR / "system_manager/m4_timemachine_watchdog_report.txt",
        REPORT_DIR / "system_manager/m4_time_machine_watchdog_report.txt",
        REPORT_DIR / "system_manager/time_machine_watchdog_report.txt",
        REPORT_DIR / "system_manager/timemachine_watchdog_report.txt",
    ])

    qnap = backup_center_qnap()
    verification = backup_center_verification()
    history = backup_center_history()

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
<form method="POST"
      action="/backup-recovery/run/production"
      onsubmit="
        this.querySelector('button').disabled=true;
        this.querySelector('button').innerText='Backup running...';
      ">
    <button type="submit">Run Production Backup Now</button>
</form>
"""

    dashboard_action = """
<form method="POST"
      action="/backup-recovery/run/dashboard"
      onsubmit="
        this.querySelector('button').disabled=true;
        this.querySelector('button').innerText='Backup running...';
      ">
    <button type="submit">Run Dashboard Backup Now</button>
</form>
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
        """
<div style="color:#cbd5e1;max-width:280px;">
DEV backups run from the DEV VM every Sunday at 3:00 AM Central.
</div>
""",
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

    body = f"""
{notice_html}

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

    verifier = (
        Path.home()
        / "ai"
        / "projects"
        / "openclaw"
        / "tools"
        / "system_manager"
        / "openclaw-backup-verify.sh"
    )

    if not verifier.exists() or not verifier.is_file():
        return redirect(
            "/backup-recovery?result=error&message="
            + quote_plus(
                f"Verification script was not found: {verifier}"
            )
        )

    try:
        result = subprocess.run(
            [str(verifier)],
            cwd=str(
                Path.home() / "ai" / "projects" / "openclaw"
            ),
            capture_output=True,
            text=True,
            timeout=1800,
            check=False,
        )

        output = (
            result.stdout + "\n" + result.stderr
        ).strip()

        if result.returncode == 0:
            message = "Backup verification completed successfully."
            action_result = "success"
        else:
            last_line = (
                output.splitlines()[-1]
                if output
                else "Unknown verification error"
            )

            message = (
                f"Backup verification failed with exit code "
                f"{result.returncode}: {last_line}"
            )
            action_result = "error"

    except subprocess.TimeoutExpired:
        message = "Backup verification timed out."
        action_result = "error"

    except Exception as exc:
        message = f"Backup verification could not run: {exc}"
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
        "production": (
            PRODUCTION_BACKUP_MANAGER,
            "Production OpenClaw backup completed successfully.",
        ),
        "dashboard": (
            DASHBOARD_BACKUP_MANAGER,
            "Dashboard and PropertyManager backup completed successfully.",
        ),
    }

    if backup_type not in managers:
        return redirect(
            "/backup-recovery?result=error&message=Unknown+backup+type."
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

    html += m4_ai_health_panel_html()
    html += ai_routing_telemetry_panel_html()

    html += "<div class='panel'><h2>Model Status</h2><div class='output'>"

    for model in MODELS:
        result = test_model(model)
        html += f"\nTesting {model}...\n"
        if result["success"]:
            html += f"SUCCESS: {result['response']}\n"
        else:
            html += f"FAILED: {result['response']}\n"

    html += "</div></div>"

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
