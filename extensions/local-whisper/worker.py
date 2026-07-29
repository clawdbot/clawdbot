#!/usr/bin/env python3
"""Resident faster-whisper worker for 16 kHz mono PCM16.

stdin is raw PCM16. The exact newline commands {"cmd":"reset"} and
{"cmd":"shutdown"} may be interleaved between Node writes. stdout is JSONL.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass
from typing import Any

SAMPLE_RATE = 16_000
FRAME_MS = 30
FRAME_BYTES = SAMPLE_RATE * FRAME_MS // 1000 * 2
RESET = b'{"cmd":"reset"}\n'
SHUTDOWN = b'{"cmd":"shutdown"}\n'


def emit(event: str, **fields: Any) -> None:
    print(json.dumps({"event": event, **fields}, ensure_ascii=False), flush=True)


@dataclass
class VadState:
    active: bool = False
    silence_ms: int = 0
    pending: bytes = b""
    speech: bytearray | None = None

    def __post_init__(self) -> None:
        self.speech = bytearray()

    def reset(self) -> None:
        self.active = False
        self.silence_ms = 0
        self.pending = b""
        assert self.speech is not None
        self.speech.clear()


class Worker:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.state = VadState()
        self.running = True
        self.model: Any = None
        self.vad: Any = None

    def load(self) -> bool:
        try:
            from faster_whisper import WhisperModel
            import webrtcvad

            self.model = WhisperModel(
                self.args.model,
                device=self.args.device,
                compute_type=self.args.compute_type,
            )
            self.vad = webrtcvad.Vad(self.args.vad_aggressiveness)
            emit("ready", pid=os.getpid(), model=self.args.model)
            return True
        except Exception as exc:
            emit("error", message=f"worker initialization failed: {exc}")
            return False

    def feed(self, data: bytes) -> None:
        self.state.pending += data
        while len(self.state.pending) >= FRAME_BYTES:
            frame = self.state.pending[:FRAME_BYTES]
            self.state.pending = self.state.pending[FRAME_BYTES:]
            try:
                voiced = bool(self.vad.is_speech(frame, SAMPLE_RATE))
            except Exception as exc:
                emit("error", message=f"VAD failed: {exc}")
                continue

            speech = self.state.speech
            assert speech is not None
            if voiced:
                if not self.state.active:
                    self.state.active = True
                    emit("speech_start")
                self.state.silence_ms = 0
                speech.extend(frame)
                continue
            if not self.state.active:
                continue

            speech.extend(frame)
            self.state.silence_ms += FRAME_MS
            if self.state.silence_ms >= self.args.silence_ms:
                audio = bytes(speech)
                self.state.reset()
                emit("speech_end")
                self.transcribe(audio)

    def transcribe(self, pcm: bytes) -> None:
        if not pcm:
            return
        try:
            import numpy as np

            audio = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
            result, _info = self.model.transcribe(
                audio,
                language=self.args.language,
                vad_filter=False,
            )
            segments = [
                {"start": segment.start, "end": segment.end, "text": segment.text.strip()}
                for segment in result
            ]
            text = " ".join(segment["text"] for segment in segments if segment["text"]).strip()
            if text:
                emit("transcript", text=text, segments=segments)
        except Exception as exc:
            emit("error", message=f"transcription failed: {exc}")

    def run(self) -> None:
        # Scan for the two exact control tokens while retaining enough trailing
        # bytes to recognize a command split across OS pipe reads.
        buffered = b""
        longest_command = max(len(RESET), len(SHUTDOWN))
        while self.running:
            try:
                chunk = os.read(sys.stdin.fileno(), 4096)
            except Exception as exc:
                emit("error", message=f"stdin read failed: {exc}")
                continue
            if not chunk:
                return
            buffered += chunk
            while True:
                positions = [
                    (buffered.find(command), command)
                    for command in (RESET, SHUTDOWN)
                    if buffered.find(command) >= 0
                ]
                if not positions:
                    keep = min(len(buffered), longest_command - 1)
                    if len(buffered) > keep:
                        self.feed(buffered[:-keep] if keep else buffered)
                        buffered = buffered[-keep:] if keep else b""
                    break
                position, command = min(positions, key=lambda item: item[0])
                self.feed(buffered[:position])
                buffered = buffered[position + len(command):]
                if command == RESET:
                    self.state.reset()
                else:
                    self.running = False
                    return


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="small")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--language", default="no")
    parser.add_argument("--vad-aggressiveness", type=int, choices=range(4), default=2)
    parser.add_argument("--silence-ms", type=int, default=700)
    return parser.parse_args()


def main() -> int:
    try:
        worker = Worker(parse_args())
        if worker.load():
            worker.run()
    except Exception as exc:
        emit("error", message=f"unexpected worker error: {exc}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
