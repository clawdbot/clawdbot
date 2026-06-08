---
title: "Media understanding and media generation - Media Understanding Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Media understanding and media generation - Media Understanding Maturity Note

## Summary

Image understanding has a real product path across inbound attachments, `openclaw infer image`, active vision-model routing, and `media://inbound` references. It is not stable because archived issues still show route-selection, auth-mode, dependency, and provider-capability regressions around the same user path.

## Category Scope

Included in this category:

- Audio attachment selection: Covers Audio attachment selection across batch audio/STT media understanding, local CLI fallbacks, provider transcription, voice-note preflight before mention gates, and related audio transcription and voice note understanding behavior.
- Batch STT provider and CLI fallback: Covers Batch STT provider and CLI fallback across batch audio/STT media understanding, local CLI fallbacks, provider transcription, voice-note preflight before mention gates, and related audio transcription and voice note understanding behavior.
- Voice-note mention preflight: Covers Voice-note mention preflight across batch audio/STT media understanding, local CLI fallbacks, provider transcription, voice-note preflight before mention gates, and related audio transcription and voice note understanding behavior.
- Transcript insertion and echo: Covers Transcript insertion and echo across batch audio/STT media understanding, local CLI fallbacks, provider transcription, voice-note preflight before mention gates, and related audio transcription and voice note understanding behavior.
- Audio proxy and limit handling: Covers Audio proxy and limit handling across batch audio/STT media understanding, local CLI fallbacks, provider transcription, voice-note preflight before mention gates, and related audio transcription and voice note understanding behavior.
- Inbound image summarization: Covers Inbound image summarization across image summarization before reply routing, active-model vision skip behavior, text-only model offload through `MediaPaths`/`media://inbound`, image-model fallback resolution, and related image understanding and vision routing behavior.
- Active vision model bypass: Covers Active vision model bypass across image summarization before reply routing, active-model vision skip behavior, text-only model offload through `MediaPaths`/`media://inbound`, image-model fallback resolution, and related image understanding and vision routing behavior.
- Text-only model media offload: Covers Text-only model media offload across image summarization before reply routing, active-model vision skip behavior, text-only model offload through `MediaPaths`/`media://inbound`, image-model fallback resolution, and related image understanding and vision routing behavior.
- Vision provider fallback: Covers Vision provider fallback across image summarization before reply routing, active-model vision skip behavior, text-only model offload through `MediaPaths`/`media://inbound`, image-model fallback resolution, and related image understanding and vision routing behavior.
- Image and PDF input routing: Covers Image and PDF input routing across image summarization before reply routing, active-model vision skip behavior, text-only model offload through `MediaPaths`/`media://inbound`, image-model fallback resolution, and related image understanding and vision routing behavior.
- Video Understanding: Covers Video Understanding across video summarization before reply routing, provider/CLI video media entries, size and timeout controls, proxy support, video request construction, and direct video analysis paths. It does not score video generation.
- Direct Video Analysis: Covers Direct Video Analysis across video summarization before reply routing, provider/CLI video media entries, size and timeout controls, proxy support, video request construction, and direct video analysis paths. It does not score video generation.

## Features

- Audio attachment selection: Covers Audio attachment selection across batch audio/STT media understanding, local CLI fallbacks, provider transcription, voice-note preflight before mention gates, and related audio transcription and voice note understanding behavior.
- Batch STT provider and CLI fallback: Covers Batch STT provider and CLI fallback across batch audio/STT media understanding, local CLI fallbacks, provider transcription, voice-note preflight before mention gates, and related audio transcription and voice note understanding behavior.
- Voice-note mention preflight: Covers Voice-note mention preflight across batch audio/STT media understanding, local CLI fallbacks, provider transcription, voice-note preflight before mention gates, and related audio transcription and voice note understanding behavior.
- Transcript insertion and echo: Covers Transcript insertion and echo across batch audio/STT media understanding, local CLI fallbacks, provider transcription, voice-note preflight before mention gates, and related audio transcription and voice note understanding behavior.
- Audio proxy and limit handling: Covers Audio proxy and limit handling across batch audio/STT media understanding, local CLI fallbacks, provider transcription, voice-note preflight before mention gates, and related audio transcription and voice note understanding behavior.
- Inbound image summarization: Covers Inbound image summarization across image summarization before reply routing, active-model vision skip behavior, text-only model offload through `MediaPaths`/`media://inbound`, image-model fallback resolution, and related image understanding and vision routing behavior.
- Active vision model bypass: Covers Active vision model bypass across image summarization before reply routing, active-model vision skip behavior, text-only model offload through `MediaPaths`/`media://inbound`, image-model fallback resolution, and related image understanding and vision routing behavior.
- Text-only model media offload: Covers Text-only model media offload across image summarization before reply routing, active-model vision skip behavior, text-only model offload through `MediaPaths`/`media://inbound`, image-model fallback resolution, and related image understanding and vision routing behavior.
- Vision provider fallback: Covers Vision provider fallback across image summarization before reply routing, active-model vision skip behavior, text-only model offload through `MediaPaths`/`media://inbound`, image-model fallback resolution, and related image understanding and vision routing behavior.
- Image and PDF input routing: Covers Image and PDF input routing across image summarization before reply routing, active-model vision skip behavior, text-only model offload through `MediaPaths`/`media://inbound`, image-model fallback resolution, and related image understanding and vision routing behavior.
- Video Understanding: Covers Video Understanding across video summarization before reply routing, provider/CLI video media entries, size and timeout controls, proxy support, video request construction, and direct video analysis paths. It does not score video generation.
- Direct Video Analysis: Covers Direct Video Analysis across video summarization before reply routing, provider/CLI video media entries, size and timeout controls, proxy support, video request construction, and direct video analysis paths. It does not score video generation.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (78%)`
- Positive signals: Public docs describe image understanding, active vision-model bypass, text-only offload, image model defaults, Ollama/custom provider routing, and CLI image description. Source has focused image runtime, provider registry, attachment selection, prompt ordering, and `media://inbound` hydration paths.
- Negative signals: The main user path spans Gateway/WebChat, auto-reply, media store, model selection, and provider plugins; live proof is thinner than source/unit coverage for provider-specific combinations.
- Integration gaps: Cross-client parity for WebChat image uploads, PDF/image tool fallback, and providerless `agents.defaults.imageModel` remains mostly covered by targeted regressions and archive review rather than recurring scenario sweeps.

## Quality Score

- Score: `Alpha (66%)`
- Gitcrawl reports: Relevant open issues/PRs include route bypass through direct OpenAI auto-selection (#87168), media-understanding-core missing `sharp` after global install (#77760), Bedrock/aws-sdk auth failures (#72031), silent routing to undeclared vision models (#81525), and tight deadline loops (#80771).
- Discrawl reports: Maintainer archive explicitly records WebChat image handling regression: #82524 bypassed staged `MediaPaths`/media-understanding for text-only sessions, broke Moonshot/Kimi/opencode-go request shapes, and #85501 restored media-understanding routing.
- Good qualities: The route intentionally preserves original attachments, avoids redundant summary blocks when the primary model supports images, resolves `imageModel` in the media-understanding layer, and exposes provider/model failure reasons.
- Bad qualities: User-visible behavior is sensitive to auth profile selection, runtime dependency staging, model capability metadata, and whether the active route is Gateway/WebChat, CLI, plugin, or ACP.
- Excluded from quality: Unit, integration, e2e, live, and runtime-flow test presence or absence.

## Completeness Score

- Score: `Beta (78%)`
- Surface instructions: evaluated against `references/completeness/media-understanding-and-media-generation.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Audio attachment selection, Batch STT provider and CLI fallback, Voice-note mention preflight, Transcript insertion and echo, Audio proxy and limit handling, Inbound image summarization, Active vision model bypass, Text-only model media offload, Vision provider fallback, Image and PDF input routing, Video Understanding, Direct Video Analysis.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Recurring archive records show that small routing changes can bypass the intended media path and produce provider-specific failures.
- Dependency staging for the media-understanding core image path has caused install/runtime failures.
- Direct video/PDF/image upload parity is adjacent and still not fully regularized across every client surface.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/nodes/media-understanding.md` documents image media collection, `tools.media.image`, active model vision skip, `media://inbound` preservation for text-only Gateway/WebChat models, `agents.defaults.imageModel`, provider fallback order, and capability matrices.
- `/Users/kevinlin/code/openclaw/docs/nodes/images.md` documents image/media handling rules, command templating, media understanding insertion, and default size caps.
- `/Users/kevinlin/code/openclaw/docs/cli/infer.md` documents `image describe`/`describe-many`, prompt overrides, local Ollama vision models, and timeouts.
- `/Users/kevinlin/code/openclaw/docs/tools/pdf.md` documents inbound `media://inbound/<id>` refs and image/PDF vision fallback behavior.

### Source

- `/Users/kevinlin/code/openclaw/src/media-understanding/runner.ts` selects attachments, resolves `agents.defaults.imageModel`, skips image understanding when the active model supports vision, and applies media decisions into reply context.
- `/Users/kevinlin/code/openclaw/src/media-understanding/image.ts` and `/Users/kevinlin/code/openclaw/src/media-understanding/image-runtime.ts` implement image provider execution.
- `/Users/kevinlin/code/openclaw/src/media-understanding/provider-capability-registry.ts`, `/Users/kevinlin/code/openclaw/src/media-understanding/provider-registry.ts`, and `/Users/kevinlin/code/openclaw/src/media-understanding/provider-supports.ts` define capability/provider registration.
- `/Users/kevinlin/code/openclaw/src/media/prompt-image-order.ts`, `/Users/kevinlin/code/openclaw/src/media/media-reference.ts`, and `/Users/kevinlin/code/openclaw/src/media/store.ts` support image ordering and managed inbound references.
- `/Users/kevinlin/code/openclaw/src/agents/tools/image-tool.ts` hydrates image tool inputs, including `media://inbound` refs.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/gateway/control-ui-assistant-media.e2e.test.ts` exercises Control UI assistant media paths.
- `/Users/kevinlin/code/openclaw/src/cli/program.nodes-media.e2e.test.ts` covers CLI media node behavior.
- `/Users/kevinlin/code/openclaw/src/auto-reply/reply/get-reply-run.media-only.test.ts` covers current-turn `MediaPaths` hydration and image understanding interaction with agent turns.
- `/Users/kevinlin/code/openclaw/src/auto-reply/reply/dispatch-acp.test.ts` covers ACP media-understanding dispatch paths.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/media-understanding/image.test.ts`
- `/Users/kevinlin/code/openclaw/src/media-understanding/runtime.test.ts`
- `/Users/kevinlin/code/openclaw/src/media-understanding/runner.vision-skip.test.ts`
- `/Users/kevinlin/code/openclaw/src/media-understanding/provider-capability-registry.test.ts`
- `/Users/kevinlin/code/openclaw/src/media-understanding/media-understanding-url-fallback.test.ts`
- `/Users/kevinlin/code/openclaw/src/agents/tools/image-tool.test.ts`

### Gitcrawl queries

Query:

```bash
gitcrawl search openclaw/openclaw --query "image media understanding" --json
```

Results:

- Returned relevant open threads including #57259 for GitHub Copilot image-provider support, #77760 for missing `sharp` in `media-understanding-core`, #87185 for bounded Codex image/PDF media understanding, #72031 for aws-sdk auth failure, #81525 for unvalidated declared image capabilities, #80771 for image deadline collapse, and #79626 for image MIME detection.

Query:

```bash
gitcrawl search openclaw/openclaw --query "media understanding" --json
```

Results:

- Returned broader registry/routing and model-selection issues, including broken provider-module isolation (#77843), chosen-model reporting (#62924), and text-only image route bypass cases.

### Discrawl queries

Query:

```bash
/Users/kevinlin/.local/bin/discrawl search "image media understanding" --limit 5
```

Results:

- Maintainers archive result on 2026-05-23 describes #82524 changing text-only WebChat image uploads from staged `MediaPaths`/media-understanding to inline image model override, breaking Moonshot/Kimi and opencode-go request shapes; #85501 restored media-understanding routing.
- Clawtributors result on 2026-04-29 describes a `media-understanding-core` `sharp` dependency regression after runtime-dependency staging moved.
- A 2026-04-29 maintainer digest calls out media-understanding timeouts and plugin runtime-dependency churn as active gateway/perf fires.
