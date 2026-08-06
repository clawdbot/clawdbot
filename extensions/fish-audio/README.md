# Fish Audio speech plugin

Official OpenClaw speech provider for Fish Audio's hosted S2.1 API.

Install it with:

```bash
openclaw plugins install @openclaw/fish-audio-speech
```

The plugin id is `fish-audio-speech`; the speech provider and TTS config id
remain `fish-audio`. Configure `tts.provider: "fish-audio"` and set
`FISH_API_KEY`. The provider supports buffered audio, HTTP-streamed playback,
native Opus voice notes, 8 kHz PCM telephony, and Fish Audio voice discovery.

See [Fish Audio](https://docs.openclaw.ai/providers/fish-audio) for setup,
models, voice selection, expressive tags, and local macOS MLX usage.
