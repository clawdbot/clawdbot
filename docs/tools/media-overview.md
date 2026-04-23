---
summary: "Unified landing page for media generation, understanding, and speech capabilities"
read_when:
  - Looking for an overview of media capabilities
  - Deciding which media provider to configure
  - Understanding how async media generation works
title: "Media overview"
---

# Media Generation and Understanding

OpenClaw generates images, videos, and music, understands inbound media (images, audio, video), and speaks replies aloud with text-to-speech. All media capabilities are tool-driven: the agent decides when to use them based on the conversation, and each tool only appears when at least one backing provider is configured.

## Capabilities at a glance

| Capability           | Tool             | Providers                                                                                    | What it does                                            |
| -------------------- | ---------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Image generation     | `image_generate` | ComfyUI, fal, Google, MiniMax, OpenAI, Vydra, xAI                                            | Creates or edits images from text prompts or references |
| Video generation     | `video_generate` | Alibaba, BytePlus, ComfyUI, fal, Google, MiniMax, OpenAI, Qwen, Runway, Together, Vydra, xAI | Creates videos from text, images, or existing videos    |
| Music generation     | `music_generate` | ComfyUI, Google, MiniMax                                                                     | Creates music or audio tracks from text prompts         |
| Text-to-speech (TTS) | `tts`            | ElevenLabs, Microsoft, MiniMax, OpenAI, xAI                                                  | Converts outbound replies to spoken audio               |
| Media understanding  | (automatic)      | Any vision/audio-capable model provider, plus CLI fallbacks                                  | Summarizes inbound images, audio, and video             |

## Provider capability matrix

This table shows which providers support which media capabilities across the platform.

| Provider   | Image | Video | Music | TTS | STT / Transcription | Media Understanding |
| ---------- | ----- | ----- | ----- | --- | ------------------- | ------------------- |
| Alibaba    |       | Yes   |       |     |                     |                     |
| BytePlus   |       | Yes   |       |     |                     |                     |
| ComfyUI    | Yes   | Yes   | Yes   |     |                     |                     |
| Deepgram   |       |       |       |     | Yes                 |                     |
| ElevenLabs |       |       |       | Yes | Yes                 |                     |
| fal        | Yes   | Yes   |       |     |                     |                     |
| Google     | Yes   | Yes   | Yes   |     |                     | Yes                 |
| Microsoft  |       |       |       | Yes |                     |                     |
| MiniMax    | Yes   | Yes   | Yes   | Yes |                     |                     |
| Mistral    |       |       |       |     | Yes                 |                     |
| OpenAI     | Yes   | Yes   |       | Yes | Yes                 | Yes                 |
| Qwen       |       | Yes   |       |     |                     |                     |
| Runway     |       | Yes   |       |     |                     |                     |
| Together   |       | Yes   |       |     |                     |                     |
| Vydra      | Yes   | Yes   |       |     |                     |                     |
| xAI        | Yes   | Yes   |       | Yes | Yes                 | Yes                 |

<Note>
Media understanding uses any vision-capable or audio-capable model registered in your provider config. The table above highlights providers with dedicated media-understanding support; most LLM providers with multimodal models (Anthropic, Google, OpenAI, etc.) can also understand inbound media when configured as the active reply model.
</Note>

## How async generation works

Video and music generation run as background tasks because provider processing typically takes 30 seconds to several minutes. When the agent calls `video_generate` or `music_generate`, OpenClaw submits the request to the provider, returns a task ID immediately, and tracks the job in the task ledger. The agent continues responding to other messages while the job runs. When the provider finishes, OpenClaw wakes the agent so it can post the finished media back into the original channel. Image generation and TTS are synchronous and complete inline with the reply.

Deepgram, ElevenLabs, Mistral, OpenAI, and xAI can all transcribe inbound
audio through the batch `tools.media.audio` path when configured. Deepgram,
ElevenLabs, Mistral, OpenAI, and xAI also register Voice Call streaming STT
providers, so live phone audio can be forwarded to the selected vendor
without waiting for a completed recording.

OpenAI maps to OpenClaw's image, video, batch TTS, batch STT, Voice Call
streaming STT, realtime voice, and memory embedding surfaces. xAI currently
maps to OpenClaw's image, video, search, code-execution, batch TTS, batch STT,
and Voice Call streaming STT surfaces. xAI Realtime voice is an upstream
capability, but it is not registered in OpenClaw until the shared realtime
voice contract can represent it.

## Quick links

- [Image Generation](/tools/image-generation) -- generating and editing images
- [Video Generation](/tools/video-generation) -- text-to-video, image-to-video, and video-to-video
- [Music Generation](/tools/music-generation) -- creating music and audio tracks
- [Text-to-Speech](/tools/tts) -- converting replies to spoken audio
- [Media Understanding](/nodes/media-understanding) -- understanding inbound images, audio, and video
