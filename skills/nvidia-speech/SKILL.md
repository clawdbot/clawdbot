---
name: nvidia-speech
description: NVIDIA Nemotron Speech NIM integration for Parakeet ASR and Magpie TTS over HTTP.
homepage: https://build.nvidia.com
metadata:
  {
    "openclaw":
      {
        "emoji": "🎙️",
        "requires": { "env": ["NVIDIA_API_KEY"] },
        "primaryEnv": "NVIDIA_API_KEY",
        "skillKey": "nvidia-speech",
      },
  }
---

<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: MIT
-->

# NVIDIA Nemotron Speech

Use NVIDIA build.nvidia.com HTTP endpoints for offline speech recognition and
speech synthesis. No local GPU, gRPC client, or protobuf definitions are
required.

## API key

Set NVIDIA_API_KEY using a key from https://build.nvidia.com:

    export NVIDIA_API_KEY=your_key_here

## ASR

Incoming WAV, OPUS, or FLAC audio uses Parakeet TDT 0.6b v2 by default. If its
HTTP endpoint is unavailable, OpenClaw retries the request with Parakeet CTC
1.1b. This integration intentionally performs complete-file transcription only;
it does not register a realtime transcription provider.

Configure per-request ASR options under tools.media.audio.providerOptions.nvidia.
Camel-case option names are converted to the NIM snake-case multipart fields.
boostedWords accepts a comma-separated string or a JSON array string and is sent
as repeated boosted_lm_words fields.

    {
      tools: {
        media: {
          audio: {
            providerOptions: {
              nvidia: {
                boostedWords: '["Nemotron","OpenClaw"]',
                boostedWordsScore: 1.5,
                wordTimeOffsets: true,
                customConfiguration: "key:value",
              },
            },
          },
        },
      },
    }

To select the CTC fallback directly, configure the audio model as
nvidia/parakeet-ctc-1.1b-asr.

## TTS

Magpie TTS Multilingual is the default speech model:

    openclaw capability tts convert \
      --text "Hello from NVIDIA" \
      --voice Magpie-Multilingual.EN-US.Aria \
      --output /tmp/out.wav

Magpie accepts SSML directly in text. Custom pronunciation dictionaries and
future model-specific request options can be configured as multipart fields:

    {
      messages: {
        tts: {
          provider: "nvidia",
          providers: {
            nvidia: {
              voice: "Magpie-Multilingual.EN-US.Aria",
              customDictionary: "Nemotron  pronunciation",
              customConfiguration: "key:value",
            },
          },
        },
      },
    }

Set NVIDIA as the Talk provider when enabling speech output:

    openclaw config set talk.provider nvidia

To override the hosted endpoints, set NVIDIA_TDT_ASR_BASE_URL,
NVIDIA_CTC_ASR_BASE_URL, or NVIDIA_TTS_BASE_URL.
