#!/usr/bin/env python3
"""Resident faster-whisper worker for 16 kHz mono PCM16.

stdin is raw PCM16 until EOF. stdout is JSONL.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass
from collections import deque
from typing import Any

SAMPLE_RATE = 16_000
FRAME_MS = 30
FRAME_BYTES = SAMPLE_RATE * FRAME_MS // 1000 * 2
PRE_ROLL_MS = 300
PRE_ROLL_FRAMES = PRE_ROLL_MS // FRAME_MS


def emit(event: str, **fields: Any) -> None:
    print(json.dumps({"event": event, **fields}, ensure_ascii=False), flush=True)


@dataclass
class VadState:
    active: bool = False
    silence_ms: int = 0
    pending: bytes = b""
    speech: bytearray | None = None
    pre_roll: deque[bytes] | None = None

    def __post_init__(self) -> None:
        self.speech = bytearray()
        self.pre_roll = deque(maxlen=PRE_ROLL_FRAMES)

    def reset(self) -> None:
        self.active = False
        self.silence_ms = 0
        self.pending = b""
        assert self.speech is not None
        self.speech.clear()
        assert self.pre_roll is not None
        self.pre_roll.clear()


class Worker:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.state = VadState()
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
            pre_roll = self.state.pre_roll
            assert speech is not None
            assert pre_roll is not None
            if voiced:
                if not self.state.active:
                    self.state.active = True
                    speech.extend(b"".join(pre_roll))
                    pre_roll.clear()
                    emit("speech_start")
                self.state.silence_ms = 0
                speech.extend(frame)
                if len(speech) >= self.args.max_utterance_ms * SAMPLE_RATE * 2 // 1000:
                    audio = bytes(speech)
                    self.state.reset()
                    emit("speech_end")
                    self.transcribe(audio)
                continue
            if not self.state.active:
                pre_roll.append(frame)
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
        while True:
            try:
                chunk = os.read(sys.stdin.fileno(), 4096)
            except Exception as exc:
                emit("error", message=f"stdin read failed: {exc}")
                continue
            if not chunk:
                speech = self.state.speech
                if self.state.active and speech:
                    audio = bytes(speech)
                    self.state.reset()
                    emit("speech_end")
                    self.transcribe(audio)
                return
            self.feed(chunk)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="small")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--language", default="no")
    parser.add_argument("--vad-aggressiveness", type=int, choices=range(4), default=2)
    parser.add_argument("--silence-ms", type=int, default=700)
    parser.add_argument(
        "--max-utterance-ms",
        type=int,
        default=int(os.environ.get("MAX_UTTERANCE_MS", "30000")),
    )
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
