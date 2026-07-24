import json
import sys
from datetime import datetime
import redis

r = redis.Redis(host="127.0.0.1", port=6379, decode_responses=True)

agent = sys.argv[1]
event_type = sys.argv[2]
message = sys.argv[3]

event = {
    "timestamp": datetime.now().isoformat(),
    "agent": agent,
    "type": event_type,
    "message": message,
}

r.lpush("openclaw:events", json.dumps(event))

print("Event published:")
print(json.dumps(event, indent=2))
