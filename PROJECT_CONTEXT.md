# Andy OpenClaw Project Context

This OpenClaw project runs on a 2018 Intel Mac mini named intelmini.

Current Intel mini services:

- Ubuntu Server
- Docker
- OpenClaw Gateway on port 18789
- Custom Flask dashboard on port 5050
- OpenClaw voice service
- Home Assistant container
- PostgreSQL / pgvector container
- Redis container
- Portainer container
- Scrypted container for Lorex camera integration

Current audio:

- Logitech USB camera microphone
- HDMI audio output
- PipeWire audio
- Working mic command:
  arecord -D plughw:1,0 -f S16_LE -r 16000 -c 1 -d 5 voice_test.wav

Current model architecture:

- Intel mini runs OpenClaw services
- M4 Mac mini runs Ollama and MLX experiments
- Ollama is the stable production model path
- MLX is for Apple Silicon experiments

Goal:
Build a local home AI assistant for Home Assistant, Lorex/Scrypted, voice, calendar/email later, and property/home automation.
