#!/usr/bin/env python3
import subprocess
from pathlib import Path

out = Path("voice_test.wav")

cmd = [
    "arecord",
    "-D", "default",
    "-f", "S16_LE",
    "-r", "48000",
    "-c", "1",
    "-d", "5",
    str(out),
]

print("Recording 5 seconds. Speak now...")
subprocess.run(cmd, check=True)
print("Saved:", out)
