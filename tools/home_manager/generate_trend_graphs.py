#!/usr/bin/env python3

from pathlib import Path
import csv
from datetime import datetime
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

report_dir = Path.home() / "ai/projects/openclaw/reports"
trend_file = report_dir / "trends.csv"
graph_dir = report_dir / "graphs"
graph_dir.mkdir(parents=True, exist_ok=True)

rows = []
with trend_file.open() as f:
    reader = csv.DictReader(f)
    for row in reader:
        try:
            row["dt"] = datetime.strptime(row["timestamp"], "%Y-%m-%d %H:%M:%S")
            row["ollama_latency_ms"] = float(row["ollama_latency_ms"])
            row["mem_used_gib"] = float(row["mem_used_gib"])
            row["disk_used_pct"] = float(row["disk_used_pct"])
            rows.append(row)
        except Exception:
            pass

if not rows:
    print("No trend rows available.")
    raise SystemExit(0)

def graph(field, title, ylabel, filename):
    xs = [r["dt"] for r in rows]
    ys = [r[field] for r in rows]

    plt.figure(figsize=(10, 4))
    plt.plot(xs, ys, marker="o")
    plt.title(title)
    plt.xlabel("Time")
    plt.ylabel(ylabel)
    plt.xticks(rotation=30, ha="right")
    plt.tight_layout()

    out = graph_dir / filename
    plt.savefig(out)
    plt.close()
    print(out)

graph("ollama_latency_ms", "Ollama Latency Over Time", "Latency ms", "ollama_latency.png")
graph("mem_used_gib", "Memory Used Over Time", "GiB Used", "memory_used.png")
graph("disk_used_pct", "Disk Usage Over Time", "Disk Used %", "disk_used.png")
