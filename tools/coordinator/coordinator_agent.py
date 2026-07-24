import json
import redis
from datetime import datetime

r = redis.Redis(
    host="127.0.0.1",
    port=6379,
    decode_responses=True
)

def publish(agent, event_type, message):

    event = {
        "timestamp": datetime.now().isoformat(),
        "agent": agent,
        "type": event_type,
        "message": message,
    }

    r.lpush(
        "openclaw:events",
        json.dumps(event)
    )

    print()
    print("Published:")
    print(json.dumps(event, indent=2))

def process_event(event):

    agent = event.get("agent")
    event_type = event.get("type")
    message = event.get("message")

    print()
    print(f"Processing event from {agent}: {event_type}")

    if event_type == "service_alert":

        publish(
            "CoordinatorAgent",
            "incident_detected",
            f"Detected infrastructure issue from {agent}: {message}"
        )

    elif event_type == "gmail_summary_sent":

        publish(
            "CoordinatorAgent",
            "briefing_update",
            "MailManager completed summary generation. BriefingManager should include latest Gmail context."
        )

    elif event_type == "docker_status":

        publish(
            "CoordinatorAgent",
            "infrastructure_review",
            "WatchdogAgent reported Docker container status update."
        )

    else:

        publish(
            "CoordinatorAgent",
            "event_observed",
            f"Observed event from {agent}: {event_type}"
        )

def run():

    print("=" * 60)
    print("COORDINATOR AGENT")
    print("=" * 60)

    raw_events = r.lrange(
        "openclaw:events",
        0,
        5
    )

    if not raw_events:
        print("No events found.")
        return

    latest = json.loads(raw_events[0])

    process_event(latest)

if __name__ == "__main__":
    run()
