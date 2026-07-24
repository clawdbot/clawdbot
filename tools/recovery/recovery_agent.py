import json
import socket
import subprocess
from datetime import datetime

import psycopg2
import redis
import requests

REDIS_HOST = "127.0.0.1"
POSTGRES_DB = {
    "host": "127.0.0.1",
    "port": 5432,
    "dbname": "openclaw",
    "user": "openclaw",
    "password": "Krgabg99$",
}

DASHBOARD_URL = "http://127.0.0.1:5050"
OLLAMA_URL = "http://192.168.50.117:11434"
VOICE_HEALTH_URL = "http://192.168.50.117:6060/health"
HOME_ASSISTANT_URL = "http://127.0.0.1:8123"
SCRYPTED_CONTAINER = "scrypted"

REQUIRED_CONTAINERS = [
    "postgres",
    "redis",
    "portainer",
    "homeassistant",
    "scrypted",
]

def run_cmd(command):
    try:
        return subprocess.check_output(
            command,
            shell=True,
            text=True,
            stderr=subprocess.STDOUT
        ).strip()
    except Exception as e:
        return str(e)

def publish(event_type, message):
    event = {
        "timestamp": datetime.now().isoformat(),
        "agent": "RecoveryAgent",
        "type": event_type,
        "message": message,
    }

    r = redis.Redis(
        host=REDIS_HOST,
        port=6379,
        decode_responses=True
    )

    r.lpush("openclaw:events", json.dumps(event))

    print(json.dumps(event, indent=2))

def check_redis():
    try:
        r = redis.Redis(
            host=REDIS_HOST,
            port=6379,
            decode_responses=True
        )
        return r.ping(), "Redis reachable"
    except Exception as e:
        return False, f"Redis failed: {e}"

def check_postgres():
    try:
        conn = psycopg2.connect(**POSTGRES_DB)
        cur = conn.cursor()
        cur.execute("SELECT 1;")
        cur.fetchone()
        cur.close()
        conn.close()
        return True, "PostgreSQL reachable"
    except Exception as e:
        return False, f"PostgreSQL failed: {e}"

def check_http(name, url):
    try:
        response = requests.get(url, timeout=10)
        if response.status_code < 500:
            return True, f"{name} reachable: HTTP {response.status_code}"
        return False, f"{name} unhealthy: HTTP {response.status_code}"
    except Exception as e:
        return False, f"{name} failed: {e}"

def check_ollama():
    try:
        response = requests.get(OLLAMA_URL, timeout=10)
        if "Ollama is running" in response.text:
            return True, "Ollama reachable on M4"
        return False, f"Ollama unexpected response: {response.text[:120]}"
    except Exception as e:
        return False, f"Ollama failed: {e}"

def check_voice():
    try:
        response = requests.get(VOICE_HEALTH_URL, timeout=10)
        data = response.json()
        if data.get("ok") is True:
            return True, f"Voice service healthy: {data.get('status')}"
        return False, f"Voice unhealthy: {data}"
    except Exception as e:
        return False, f"Voice service failed: {e}"

def check_containers():
    running = run_cmd("docker ps --format '{{.Names}}'").splitlines()
    missing = [
        name for name in REQUIRED_CONTAINERS
        if name not in running
    ]

    if missing:
        return False, f"Missing containers: {', '.join(missing)}"

    return True, "All required containers running"

def check_systemd_service(service_name):
    result = run_cmd(f"systemctl is-active {service_name}")
    if result == "active":
        return True, f"{service_name} active"
    return False, f"{service_name} not active: {result}"

def main():
    checks = [
        ("Redis", check_redis),
        ("PostgreSQL", check_postgres),
        ("Containers", check_containers),
        ("Dashboard", lambda: check_http("Dashboard", DASHBOARD_URL)),
        ("Ollama", check_ollama),
        ("Voice", check_voice),
        ("Home Assistant", lambda: check_http("Home Assistant", HOME_ASSISTANT_URL)),
        ("Dashboard Service", lambda: check_systemd_service("openclaw-dashboard")),
        ("Watchdog Timer", lambda: check_systemd_service("openclaw-watchdog.timer")),
        ("HomeManager Timer", lambda: check_systemd_service("openclaw-home-manager.timer")),
        ("Coordinator Timer", lambda: check_systemd_service("openclaw-coordinator.timer")),
        ("Remediation Timer", lambda: check_systemd_service("openclaw-remediation.timer")),
        ("AI Summary Timer", lambda: check_systemd_service("openclaw-ai-summary.timer")),
        ("Briefing Timer", lambda: check_systemd_service("openclaw-briefing.timer")),
    ]

    failures = []
    successes = []

    for name, check in checks:
        ok, message = check()
        if ok:
            successes.append(message)
        else:
            failures.append(message)

    if failures:
        summary = (
            "RECOVERY VALIDATION INCOMPLETE\n\n"
            "Failures:\n- "
            + "\n- ".join(failures)
            + "\n\nSuccessful checks:\n- "
            + "\n- ".join(successes)
        )

        publish("recovery_incomplete", summary)
    else:
        summary = (
            "FULL SYSTEM RECOVERY SUCCESSFUL\n\n"
            + "\n".join(f"- {item}" for item in successes)
        )

        publish("recovery_success", summary)

if __name__ == "__main__":
    main()
