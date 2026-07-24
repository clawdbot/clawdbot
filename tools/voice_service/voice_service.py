#!/usr/bin/env python3
import time
from datetime import datetime

print("OpenClaw local voice service started.", flush=True)

while True:
    print(f"[{datetime.now().isoformat(timespec='seconds')}] voice service heartbeat", flush=True)
    time.sleep(30)
