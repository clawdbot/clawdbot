---
title: "Media understanding and media generation - Media Configuration Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Media understanding and media generation - Media Configuration Maturity Note

## Summary

OpenClaw has a mature orchestration layer for media understanding and generation: `tools.media` config is typed and schema-validated, provider capability discovery is manifest-backed, image/audio/video understanding use shared ordered model resolution, async image generation has session-scoped task status, and generated media is integrated into the reply pipeline through trusted media handling and message-tool delivery. The biggest remaining risk is not the local mechanics, but operator-facing route clarity: archived issues and Discord threads show recurring confusion or regressions around active vision models bypassing media-understanding, Codex/OpenAI image auth, completion-delivery failures, and the chosen media model not being visible enough.

## Category Scope

Included in this category:

- Media capability configuration: tools.media image/audio/video config, shared and per-capability media model entries, provider/CLI entry resolution, auth-backed capability selection, fallback ordering, scope rules, concurrency, active-model skip behavior, offloaded image routing, image generation tool factory availability, image generation task status/list/duplicate guard, and generated-media delivery into the reply pipeline

## Features

- Media capability configuration: tools.media image/audio/video config, shared and per-capability media model entries, provider/CLI entry resolution, auth-backed capability selection, fallback ordering, scope rules, concurrency, active-model skip behavior, offloaded image routing, image generation tool factory availability, image generation task status/list/duplicate guard, and generated-media delivery into the reply pipeline

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (82%)`
- Positive signals:
  - QA scenarios cover image-understanding attachment delivery, native `image_generate` availability/artifact creation, and generated-image roundtrip back through the vision path.
  - Integration/unit layers exercise `tools.media` schema/config, shared and per-capability model resolution, active-model fallback/skip behavior, CLI provider entries, scope rules, concurrency, image generation task status, duplicate guards, and trusted media reply handling.
  - Live image-generation provider sweep tests exist for configured auth-backed providers.
- Negative signals:
  - The strongest end-to-end coverage is concentrated on image generation and image attachment flows; `tools.media` audio/video provider fallback, scope, and concurrency are mostly covered below full channel/runtime level.
  - Active-model image offload behavior has explicit unit coverage and QA scenarios nearby, but archived regressions show this path is subtle enough that broader WebChat/channel integration coverage is still warranted.
- Integration gaps:
  - Add cross-channel runtime scenarios that assert `tools.media` scope/concurrency and provider fallback order from inbound media through final reply.
  - Add an operator-visible status/config scenario that proves chosen media-understanding provider/model reporting for both skipped-active-vision and offloaded media paths.

## Quality Score

- Score: `Beta (77%)`
- Gitcrawl reports:
  - `gitcrawl search openclaw/openclaw --query "media understanding" --json` returned active routing and robustness signals including #87168 (`image` media-understanding can bypass configured Codex image route), #87185 (route Codex-only media understanding through bounded Codex), #62924 (expose actual chosen model), #81525 (declared vision model capability validation), #77760 (bundle can miss `sharp`), #74644 (no-auth/local STT providers), and #72031 (Bedrock AWS SDK auth mode).
  - `gitcrawl search openclaw/openclaw --query "image_generate" --json` returned active generation orchestration/auth signals including #86034 (generation succeeds but completion delivery looks like failure), #86279 (keep media generation success on delivery failure), #85797 (OpenAI Codex OAuth image path), #75683 (generated outputs accessible from sandbox workspace), #86075 (subagent image generation breakage), #83857 (xAI infer vs REPL mismatch), and #84627 (SSRF/private-network behavior).
  - `gitcrawl search openclaw/openclaw --query "tools.media" --json` returned related issues/PRs on generated media assistant delivery (#74041), completion wake routing (#74402), local media trust (#47523), hardcoded sandbox media max bytes (#40880), and image preprocessing failures (#73424).
  - More specific searches (`"tools.media image audio provider fallback concurrency scope"`, `"image_generate background task status message tool fallback generated media"`, and `"image understanding active model supports vision skip offload media://inbound"`) returned no gitcrawl hits, so the broad feature queries above are the useful archive evidence.
- Discrawl reports:
  - `/Users/kevinlin/.local/bin/discrawl search "media understanding" --limit 5` initially hit the sandbox lock and was rerun with escalation. Top relevant result summarized #82524/#85501: a WebChat image upload regression moved text-only active sessions with `agents.defaults.imageModel` away from staged `MediaPaths` / media-understanding into inline-image overrides, breaking providers that expected the media-understanding request shape; #85501 restored offloaded media routing and moved providerless imageModel resolution back to media-understanding.
  - The same query also surfaced release testing notes with a standing "Media understanding timeout: no provider request captured" signal and a user report that `media-understanding-core` plugin alias fallback was missing in v5.12-beta.1 source.
  - `/Users/kevinlin/.local/bin/discrawl search "image_generate" --limit 5` initially hit the sandbox lock and was rerun with escalation. Top relevant results included MiniMax Token Plan subagent breakage around `image_generate`, OpenAI image-generation auth confusion where chat worked but the tool got `HTTP 401 Unauthorized`, a local-only user confused by OpenRouter auth errors, and maintainer notes on image-generation timeout/default behavior.
  - `/Users/kevinlin/.local/bin/discrawl search "tools.media" --limit 5` initially hit the sandbox lock and was rerun with escalation. Top relevant results included agent-sent media/tts pipeline complexity touching Codex and embedded-subscribe handlers, a maintainer question about `media-generate-background-shared` completion wake failure, and notes that async media completion should remain agent-mediated.
  - More specific discrawl searches (`"tools.media image audio provider fallback concurrency scope"`, `"image_generate background task status message tool fallback generated media"`, and `"image understanding active model supports vision skip offload media://inbound"`) were rerun after the sandbox lock failure and produced no printed results.
- Good qualities:
  - The config model is explicit and typed: `tools.media.models`, per-capability `image`/`audio`/`video` configs, timeout, prompt, max bytes/chars, attachment policy, scope, language, and concurrency are first-class fields.
  - Provider resolution is layered and predictable: per-capability entries override shared entries, shared entries are filtered by capabilities, `agents.defaults.imageModel` can define image-understanding primary/fallbacks, active model fallback is capability-checked, and auth-backed/default provider discovery exists.
  - The active-model skip path avoids duplicate image understanding when the active reply model already supports vision, while offloaded images are parsed, sanitized, and merged back into prompt image order.
  - Async generation has operator-facing status/list/duplicate-guard text and a session-scoped task ledger, which helps prevent repeated `image_generate` calls while a task is running.
  - The reply pipeline has a strong security posture for generated local media: local `MEDIA:` paths are accepted only from trusted core or exact run-local tool names, MCP-provenance and case-variant collisions are blocked, and orphaned media is flushed before lifecycle end.
- Bad qualities:
  - The boundary between inline active-model vision, offloaded media-understanding, and explicit `agents.defaults.imageModel` remains easy to break and hard for operators to reason about.
  - Model/provider reporting is still not sufficiently visible in the user-facing inbound body, based on archived requests to expose the actual chosen media-understanding model.
  - Auth and runtime labels remain confusing for image generation, especially OpenAI/Codex OAuth versus direct API-key paths and subagent/background tool inheritance.
  - Completion-delivery failures can still be perceived as generation failures, even though recent code tries to separate generation success from delivery failure.
- Excluded from quality:
  - Unit, integration, e2e, live, and QA coverage depth are not used as Quality scoring inputs.

## Completeness Score

- Score: `Stable (82%)`
- Surface instructions: evaluated against `references/completeness/media-understanding-and-media-generation.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Media capability configuration.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a concise docs page or status surface that explains when inbound image media is handled by active-model vision versus `tools.media.image` versus `agents.defaults.imageModel`.
- Surface the chosen media-understanding provider/model in operator-visible status or inbound context to reduce guessed model reporting.
- Keep closing the archive-backed auth/routing issues around Codex/OpenAI image generation, local/no-auth media providers, and provider-specific auth modes.
- Broaden runtime proof for audio/video `tools.media` scope/concurrency/fallback behavior across real channel paths.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/tools/media-overview.md:11` describes OpenClaw media as generated images/videos/music, inbound media understanding, and TTS; lines 43-45 link media understanding to inbound images/audio/video with vision-capable providers and dedicated plugins; lines 81-85 clarify that active multimodal reply models can understand inbound media too.
- `/Users/kevinlin/code/openclaw/docs/tools/media-overview.md:97` documents async media generation task tracking and completion wake behavior, including message-tool delivery and idempotent direct fallback for missing media.
- `/Users/kevinlin/code/openclaw/docs/tools/image-generation.md:11` documents chat image generation as asynchronous background task creation; lines 20-24 describe tool availability based on provider/auth config; lines 211-224 define selection order and fallback behavior; lines 247-249 document runtime provider inspection through `action:"list"`.
- `/Users/kevinlin/code/openclaw/docs/plugins/manifest.md:183` documents plugin capability ownership snapshots, including media-understanding and image-generation contracts; lines 699-704 define media-understanding metadata for default models, auto-auth fallback priority, and native document support.
- `/Users/kevinlin/code/openclaw/docs/plugins/codex-harness.md:229` documents `agents.defaults.imageModel` prefix semantics for image understanding, including bounded Codex app-server routing; lines 543-553 document dynamic tool timeout order for `image_generate` and media-understanding `image`.

### Source

- `/Users/kevinlin/code/openclaw/src/config/types.tools.ts:82` defines `MediaUnderstandingConfig` with `enabled`, `scope`, limits, prompt, timeout, language, attachments, model list, and transcript echo controls; lines 141-145 define shared `tools.media.models` and `tools.media.concurrency`.
- `/Users/kevinlin/code/openclaw/src/config/zod-schema.core.ts:964` validates `tools.media` with strict per-capability schema and line 982 validates positive integer concurrency.
- `/Users/kevinlin/code/openclaw/src/media-understanding/resolve.ts:80` resolves per-capability entries before shared entries and filters shared entries by provider capabilities; lines 119-125 apply configured concurrency with a default; lines 127-145 use active-model fallback only when enabled and no models are configured.
- `/Users/kevinlin/code/openclaw/src/media-understanding/runner.ts:648` resolves `agents.defaults.imageModel` primary/fallbacks into provider/model entries; lines 713-753 define auto entry order through imageModel, active model, auth-backed providers, local audio, and Antigravity CLI; lines 1018-1061 skip image understanding when the primary active model natively supports vision; lines 1065-1091 fall back to explicit/auto entries or record skipped decisions.
- `/Users/kevinlin/code/openclaw/src/media-understanding/apply.ts:522` normalizes inbound attachments, builds provider registry/cache, runs image/audio/video capabilities under configured concurrency, records decisions, formats body/transcript outputs, and falls through to file extraction.
- `/Users/kevinlin/code/openclaw/src/agents/openclaw-tools.media-factory-plan.ts:102` exposes image/PDF tool factories when an agent dir exists and either the active model has vision, explicit image/PDF config exists, or auth-backed media-understanding capability exists; lines 167-258 apply global and per-run tool policy before enabling generation/PDF factories.
- `/Users/kevinlin/code/openclaw/src/agents/tools/image-generate-tool.actions.ts:65` implements `image_generate action:"list"` and lines 86-132 implement status/duplicate-guard actions.
- `/Users/kevinlin/code/openclaw/src/agents/media-generation-task-status-shared.ts:302` lists active session-scoped media tasks; lines 387-461 format status, duplicate-guard, and active-task prompt context.
- `/Users/kevinlin/code/openclaw/src/agents/embedded-agent-runner/run/images.ts:55` parses `media://inbound` claim-check refs defensively; lines 116-162 preserve inline/offloaded image order; lines 553-560 skip image loading for models without image input; lines 623-644 sanitize and return prompt images.
- `/Users/kevinlin/code/openclaw/src/agents/embedded-agent-subscribe.tools.ts:275` restricts trusted local media tool names; lines 340-407 reject external/MCP provenance and raw-name collisions for local media while allowing remote URLs.

### Integration tests

- `/Users/kevinlin/code/openclaw/qa/scenarios/media/image-understanding-attachment.md:12` verifies an attached image reaches the agent model and is described; lines 72-92 assert the mock provider saw at least one image input for the scenario prompt.
- `/Users/kevinlin/code/openclaw/qa/scenarios/media/native-image-generation.md:12` verifies `image_generate` appears when configured and returns a saved media artifact; lines 44-51 assert tool inventory and lines 72-88 assert planned tool call and generated path.
- `/Users/kevinlin/code/openclaw/qa/scenarios/media/image-generation-roundtrip.md:12` verifies generated media is reattached on a follow-up turn and described through the vision path; lines 93-99 assert both `image_generate` call and subsequent image input.
- `/Users/kevinlin/code/openclaw/test/image-generation.runtime.live.test.ts:196` runs a live provider sweep for configured image-generation variants with usable auth and reports attempted/skipped/failure provider cases.
- `/Users/kevinlin/code/openclaw/extensions/qa-lab/src/suite-runtime-agent-media.test.ts:106` verifies QA image generation config preserves required transport plugins and waits for gateway/transport readiness.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/media-understanding/resolve.test.ts:11` covers shared/per-capability model entry resolution and active-model fallback behavior.
- `/Users/kevinlin/code/openclaw/src/media-understanding/runner.vision-skip.test.ts:266` verifies `agents.defaults.imageModel` wins over active model for auto image resolution; lines 286-369 verify providerless primary/fallback model refs and failed-primary-to-fallback behavior; lines 374-427 verify MiniMax active model fallback to provider image default.
- `/Users/kevinlin/code/openclaw/src/media-understanding/apply.test.ts:420` covers scoped audio transcription in direct chat; lines 464-488 cover channel-specific scope rules; lines 988-1027 cover CLI image understanding and Antigravity fallback execution.
- `/Users/kevinlin/code/openclaw/src/agents/openclaw-tools.media-factory-plan.test.ts:174` covers skipping unavailable factories; lines 250-273 cover explicit model config enabling; lines 345-400 cover allow/deny policy; lines 460-496 cover auth-backed provider factory availability.
- `/Users/kevinlin/code/openclaw/src/agents/image-generation-task-status.test.ts:53` covers active session-backed image-generation task detection; lines 216-227 cover recent-success duplicate guard; lines 500-504 cover active-task prompt context.
- `/Users/kevinlin/code/openclaw/src/agents/embedded-agent-subscribe.handlers.tools.media.test.ts:208` covers queuing trusted media when verbose output is off; lines 246-295 cover rejecting untrusted/MCP local media while allowing remote URLs; lines 461-490 cover avoiding duplicate local media in plain verbose output.
- `/Users/kevinlin/code/openclaw/src/agents/embedded-agent-subscribe.handlers.lifecycle.test.ts:424` covers flushing orphaned tool media as a media-only block reply before lifecycle end.

### Gitcrawl queries

Query:

```bash
gitcrawl search openclaw/openclaw --query "tools.media image audio provider fallback concurrency scope" --json
```

Results:

- No hits.

Query:

```bash
gitcrawl search openclaw/openclaw --query "image_generate background task status message tool fallback generated media" --json
```

Results:

- No hits.

Query:

```bash
gitcrawl search openclaw/openclaw --query "image understanding active model supports vision skip offload media://inbound" --json
```

Results:

- No hits.

Query:

```bash
gitcrawl search openclaw/openclaw --query "media understanding" --json
```

Results:

- Returned active issues/PRs for media-understanding route/auth/packaging/visibility quality, including #87168, #87185, #62924, #81525, #77760, #74644, and #72031.

Query:

```bash
gitcrawl search openclaw/openclaw --query "image_generate" --json
```

Results:

- Returned active issues/PRs for async generation delivery, auth, sandbox accessibility, subagent behavior, provider registration, and private-network handling, including #86034, #86279, #85797, #75683, #86075, #86493, #83857, and #84627.

Query:

```bash
gitcrawl search openclaw/openclaw --query "tools.media" --json
```

Results:

- Returned generated-media delivery, media trust, timeout/config, preprocessing, and media-understanding routing evidence, including #74041, #86279, #87219, #40880, #82870, #74402, #47523, #73424, #73817, and #75683.

### Discrawl queries

Query:

```bash
/Users/kevinlin/.local/bin/discrawl search "tools.media image audio provider fallback concurrency scope" --limit 5
```

Results:

- Initial sandbox run failed with `open sync lock: open /Users/kevinlin/Library/Application Support/discrawl/.discrawl-sync.lock: operation not permitted`.
- Reran the exact command with escalation; no printed results.

Query:

```bash
/Users/kevinlin/.local/bin/discrawl search "image_generate background task status message tool fallback generated media" --limit 5
```

Results:

- Initial sandbox run failed with `open sync lock: open /Users/kevinlin/Library/Application Support/discrawl/.discrawl-sync.lock: operation not permitted`.
- Reran the exact command with escalation; no printed results.

Query:

```bash
/Users/kevinlin/.local/bin/discrawl search "image understanding active model supports vision skip offload media://inbound" --limit 5
```

Results:

- Initial sandbox run failed with `open sync lock: open /Users/kevinlin/Library/Application Support/discrawl/.discrawl-sync.lock: operation not permitted`.
- Reran the exact command with escalation; no printed results.

Query:

```bash
/Users/kevinlin/.local/bin/discrawl search "media understanding" --limit 5
```

Results:

- Initial sandbox run failed with `open sync lock: open /Users/kevinlin/Library/Application Support/discrawl/.discrawl-sync.lock: operation not permitted`.
- Reran the exact command with escalation. Top relevant result summarized #82524/#85501 and described a WebChat upload regression where `agents.defaults.imageModel` moved text-only image uploads away from staged media-understanding into inline model override routing; #85501 restored `routeImageOffloadsAsMediaPaths` and moved providerless imageModel resolution into media-understanding.
- Other relevant results mentioned release testing with a standing "Media understanding timeout: no provider request captured" signal and missing plugin alias fallback for `media-understanding-core`.

Query:

```bash
/Users/kevinlin/.local/bin/discrawl search "image_generate" --limit 5
```

Results:

- Initial sandbox run failed with `open sync lock: open /Users/kevinlin/Library/Application Support/discrawl/.discrawl-sync.lock: operation not permitted`.
- Reran the exact command with escalation. Top relevant results included #86075 MiniMax Token Plan subagent image-generation breakage, OpenAI image-generation auth confusion where the chat model worked but `image_generate` got `HTTP 401 Unauthorized`, a local-only user hitting an OpenRouter auth error, and maintainer notes that non-OpenAI image-generation timeout defaults had been too low.

Query:

```bash
/Users/kevinlin/.local/bin/discrawl search "tools.media" --limit 5
```

Results:

- Initial sandbox run failed with `open sync lock: open /Users/kevinlin/Library/Application Support/discrawl/.discrawl-sync.lock: operation not permitted`.
- Reran the exact command with escalation. Top relevant results included agent-sent TTS/media pipeline complexity across Codex and embedded-subscribe handlers, a maintainer question about `media-generate-background-shared` completion wake failure, and maintainer notes that async media completions should remain agent-mediated.
