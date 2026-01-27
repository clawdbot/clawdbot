---
name: sherpa-onnx-tts
description: Local text-to-speech via sherpa-onnx (offline, no cloud)
metadata: {"moltbot":{"emoji":"🗣️","os":["darwin","linux","win32"],"requires":{"env":["SHERPA_ONNX_RUNTIME_DIR","SHERPA_ONNX_MODEL_DIR"]},"install":[{"id":"download-runtime-macos","kind":"download","os":["darwin"],"url":"https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.12.23/sherpa-onnx-v1.12.23-osx-universal2-shared.tar.bz2","archive":"tar.bz2","extract":true,"stripComponents":1,"targetDir":"~/.clawdbot/tools/sherpa-onnx-tts/runtime","label":"Download sherpa-onnx runtime (macOS)"},{"id":"download-runtime-linux-x64","kind":"download","os":["linux"],"url":"https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.12.23/sherpa-onnx-v1.12.23-linux-x64-shared.tar.bz2","archive":"tar.bz2","extract":true,"stripComponents":1,"targetDir":"~/.clawdbot/tools/sherpa-onnx-tts/runtime","label":"Download sherpa-onnx runtime (Linux x64)"},{"id":"download-runtime-win-x64","kind":"download","os":["win32"],"url":"https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.12.23/sherpa-onnx-v1.12.23-win-x64-shared.tar.bz2","archive":"tar.bz2","extract":true,"stripComponents":1,"targetDir":"~/.clawdbot/tools/sherpa-onnx-tts/runtime","label":"Download sherpa-onnx runtime (Windows x64)"},{"id":"download-model-lessac","kind":"download","url":"https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-lessac-high.tar.bz2","archive":"tar.bz2","extract":true,"targetDir":"~/.clawdbot/tools/sherpa-onnx-tts/models","label":"Download Piper en_US lessac (high)"}]}}
---

# sherpa-onnx-tts

Local TTS using the sherpa-onnx offline CLI.

## Install

1) Download the runtime for your OS (extracts into `~/.clawdbot/tools/sherpa-onnx-tts/runtime`)
2) Download a voice model (extracts into `~/.clawdbot/tools/sherpa-onnx-tts/models`)

Update `~/.clawdbot/moltbot.json`:

```json5
{
  skills: {
    entries: {
      "sherpa-onnx-tts": {
        env: {
          SHERPA_ONNX_RUNTIME_DIR: "~/.clawdbot/tools/sherpa-onnx-tts/runtime",
          SHERPA_ONNX_MODEL_DIR: "~/.clawdbot/tools/sherpa-onnx-tts/models/vits-piper-en_US-lessac-high"
        }
      }
    }
  }
}
```

The wrapper lives in this skill folder. Run it directly, or add the wrapper to PATH:

```bash
export PATH="{baseDir}/bin:$PATH"
```

## Usage

```bash
{baseDir}/bin/sherpa-onnx-tts -o ./tts.wav "Hello from local TTS."
```

Notes:
- Pick a different model from the sherpa-onnx `tts-models` release if you want another voice.
- If the model dir has multiple `.onnx` files, set `SHERPA_ONNX_MODEL_FILE` or pass `--model-file`.
- You can also pass `--tokens-file` or `--data-dir` to override the defaults.
- Windows: run `node {baseDir}\\bin\\sherpa-onnx-tts -o tts.wav "Hello from local TTS."`
