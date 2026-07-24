import json
import redis

r = redis.Redis(host="127.0.0.1", port=6379, decode_responses=True)

events = r.lrange("openclaw:events", 0, 20)

if not events:
    print("No events found.")
else:
    print(f"Events found: {len(events)}")
    for raw in events:
        event = json.loads(raw)
        print("\n---")
        print("Time:", event["timestamp"])
        print("Agent:", event["agent"])
        print("Type:", event["type"])
        print("Message:", event["message"])
