# Image/video/music generation tools Completeness

Use this rubric when assigning category Completeness scores for the
`image-video-music-generation-tools` surface.

## Category Scope

- Media Routing and Discovery: default media model config, per-call model refs and fallbacks, auth-backed tool discovery, action=list provider inspection
- Task Lifecycle and Delivery: background task creation, task status/list/show/cancel, duplicate guards, progress keepalive, completion/failure wake, no-session inline fallback, local media persistence, MIME/filename inference, Hosted URL fallback, message-tool handoff, idempotent missing-media fallback, channel attachment proof
- Image Generation: text-to-image, reference-image editing, output hints, action=status, provider attempt metadata, OpenAI/Codex OAuth, API-key OpenAI, OpenRouter/xAI/fal/LiteLLM/DeepInfra/Google/MiniMax/ComfyUI auth, provider error diagnostics
- Video Generation: text-to-video, image-to-video, video-to-video, reference role validation, audio refs, typed providerOptions, queue-backed jobs, polling/timeout handling, Hosted URL download, provider skip explanations, returned asset metadata
- Music Generation: prompt and lyrics input, instrumental mode, duration/format controls, image-reference edit lanes, generated audio outputs, provider fallback
