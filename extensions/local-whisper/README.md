# Local Whisper realtime transcription

Offline realtime transcription for OpenClaw voice calls. Audio stays on the
host: 8 kHz G.711 µ-law is decoded and resampled to 16 kHz PCM16, then sent to
one resident `faster-whisper` Python worker.

## Runtime

The local environment used for this extension is:

`/home/o/.venvs/local-whisper`

Install dependencies without modifying the global Python environment:

```sh
python3 -m venv /home/o/.venvs/local-whisper
/home/o/.venvs/local-whisper/bin/pip install faster-whisper numpy webrtcvad-wheels
```

`webrtcvad-wheels` provides the `webrtcvad` import and avoids requiring local
Python development headers. Configure `pythonPath` as
`/home/o/.venvs/local-whisper/bin/python`.

```json
{
  "streaming": {
    "provider": "local-whisper",
    "providers": {
      "local-whisper": {
        "pythonPath": "/home/o/.venvs/local-whisper/bin/python",
        "model": "small",
        "language": "no",
        "device": "cpu",
        "computeType": "int8",
        "silenceMs": 700,
        "vadAggressiveness": 2
      }
    }
  }
}
```
