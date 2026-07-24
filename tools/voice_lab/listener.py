#!/usr/bin/env python3

import subprocess
import time
from pathlib import Path
import os

OUTFILE = Path("/tmp/openclaw_listener.wav")

MIC_DEVICE = os.environ.get("OPENCLAW_MIC_DEVICE", "default")

RECORD_SECONDS = 5
SAMPLE_RATE = "48000"
PAUSE_AFTER_SUCCESS = 6
PAUSE_AFTER_BUSY = 6

while True:
    print("")
    print(f"Listening on {MIC_DEVICE} for {RECORD_SECONDS} seconds at {SAMPLE_RATE} Hz...")

    cmd = [
        "arecord",
        "-D", MIC_DEVICE,
        "-f", "S16_LE",
        "-r", SAMPLE_RATE,
        "-c", "1",
        "-d", str(RECORD_SECONDS),
        str(OUTFILE),
    ]

    result = subprocess.run(cmd)

    if result.returncode == 0:
        print(f"Saved: {OUTFILE}")
        time.sleep(PAUSE_AFTER_SUCCESS)
    else:
        print("Recording failed. Mic may be busy. Retrying...")
        time.sleep(PAUSE_AFTER_BUSY)
