# OpenRouter provider path Completeness

Use this rubric when assigning category Completeness scores for the
`openrouter-provider-path` surface.

## Category Scope

- Provider Setup and Auth: First-run setup, Default model selection, Provider plugin registration, Model-ref examples, OPENROUTER_API_KEY, Auth profiles and auth order, Status/probe and removal, Provider-entry SecretRef/API-key resolution, Gateway env inheritance, Static catalog rows, Dynamic /models discovery, openrouter/auto and nested refs, Free-model scan/probe, Model list/picker cache
- Chat Runtime and Normalization: Chat completions route, Provider routing params, Per-model route overrides, Reasoning payload policy, Anthropic/Gemini/DeepSeek variants, Streamed content parsing, reasoning_details visible output, Tool-call delta preservation, Family-specific replay policy, Response-model and usage normalization, Attribution headers, Response-cache headers/TTL/clear, Anthropic cache-control markers, Cache usage mapping, Custom proxy exclusions
- Provider Recovery and Diagnostics: Timeout/retry classification, Auth/billing/key-limit classification, Context overflow, Model fallback notices, Guarded fetch/pricing warnings
- Media Generation and Speech: image_generate OpenRouter route, video_generate async jobs/polling/download, music_generate audio route, Text-to-speech, Speech-to-text transcription, Inbound media understanding, Generated artifact delivery
