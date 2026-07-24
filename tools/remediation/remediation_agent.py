import json
import redis
import subprocess
from datetime import datetime

r = redis.Redis(
    host="127.0.0.1",
    port=6379,
    decode_responses=True
)

def publish(event_type, message):
    event = {
        "timestamp": datetime.now().isoformat(),
        "agent": "AutoRemediationAgent",
        "type": event_type,
        "message": message,
    }

    r.lpush("openclaw:events", json.dumps(event))

    print()
    print(json.dumps(event, indent=2))

def cmd(command):
    try:
        return subprocess.check_output(
            command,
            shell=True,
            text=True
        ).strip()
    except subprocess.CalledProcessError as e:
        return str(e)

def restart_container(container):
    result = cmd(f"docker restart {container}")

    publish(
        "container_restart",
        f"Restart attempt for {container}: {result}"
    )

def inspect_latest_events():
    raw_events = r.lrange("openclaw:events", 0, 10)

    remediated = False

    for raw in raw_events:
        try:
            event = json.loads(raw)

            event_type = event.get("type", "")

            if event_type == "homeassistant_offline":
                publish(
                    "incident_response",
                    "Detected Home Assistant outage. Attempting remediation."
                )

                restart_container("homeassistant")
                remediated = True

            elif event_type == "scrypted_offline":
                publish(
                    "incident_response",
                    "Detected Scrypted outage. Attempting remediation."
                )

                restart_container("scrypted")
                remediated = True

        except Exception as e:
            publish("remediation_error", str(e))

    if not remediated:
        publish(
            "no_action_needed",
            "No remediation needed. Home Assistant and Scrypted appear healthy."
        )

if __name__ == "__main__":
    print("=" * 60)
    print("AUTO REMEDIATION AGENT")
    print("=" * 60)

    inspect_latest_events()
