import json
import redis
import subprocess
from datetime import datetime

r = redis.Redis(host="127.0.0.1", port=6379, decode_responses=True)

def run_cmd(cmd):
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    return result.stdout.strip() or result.stderr.strip()

def publish(agent, event_type, message):
    event = {
        "timestamp": datetime.now().isoformat(),
        "agent": agent,
        "type": event_type,
        "message": message,
    }
    r.lpush("openclaw:events", json.dumps(event))
    print(json.dumps(event, indent=2))

def check_docker():
    output = run_cmd("docker ps --format '{{.Names}} {{.Status}}'")
    publish("WatchdogAgent", "docker_status", output)

def check_disk():
    output = run_cmd("df -h / | tail -1")
    publish("WatchdogAgent", "disk_status", output)

def check_memory():
    output = run_cmd("free -h | grep Mem")
    publish("WatchdogAgent", "memory_status", output)

def check_services():
    required = ["postgres", "redis", "portainer", "homeassistant", "scrypted"]
    running = run_cmd("docker ps --format '{{.Names}}'").splitlines()

    missing = [name for name in required if name not in running]

    if missing:
        publish("WatchdogAgent", "service_alert", f"Missing containers: {', '.join(missing)}")
    else:
        publish("WatchdogAgent", "service_ok", "All required containers are running.")

if __name__ == "__main__":
    check_services()
    check_docker()
    check_disk()
    check_memory()
