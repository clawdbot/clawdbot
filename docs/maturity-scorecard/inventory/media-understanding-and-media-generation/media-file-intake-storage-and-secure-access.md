---
title: "Media understanding and media generation - Media Intake and Access Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Media understanding and media generation - Media Intake and Access Maturity Note

## Summary

OpenClaw has a substantial shared media intake layer covering URL/base64 intake, MIME sniffing, size caps, guarded fetch, local root policy, inbound media storage, PDF extraction dispatch, and channel media handoff. The core safety posture is stronger than the user-facing maturity score suggests: remote fetches use SSRF-guarded DNS pinning and redirect controls, local reads are root-gated, the media store uses scoped IDs and bounded writes, and PDF/document extraction is routed through plugin extractors with page/pixel limits.

The component is not stable yet because runtime proof is uneven across the whole intake surface. QA scenarios prove image attachments and generated-image roundtrip through a real gateway-style flow, and channel tests cover important Telegram, WhatsApp, Slack, Teams, and agent-runner paths, but there is no single end-to-end suite that exercises all significant intake classes together: remote URL fetch, local path roots, `media://inbound` hydration, PDFs/documents, QR/image/audio/video helpers, and sandbox staging. The archive record also shows repeated operator and user confusion around local media path delivery, `media://inbound` resolution, channel document placeholders, and browser/tool access to managed inbound media.

## Category Scope

Included in this category:

- Local and remote media references: Covers Local and remote media references across Included: Local and remote media references, including plain paths, `file://`, HTTP(S), and related media file intake, storage, and secure access behavior.
- MIME and type detection: Covers MIME and type detection across Included: Local and remote media references, including plain paths, `file://`, HTTP(S), and related media file intake, storage, and secure access behavior.
- Size caps and bounded reads: Covers Size caps and bounded reads across Included: Local and remote media references, including plain paths, `file://`, HTTP(S), and related media file intake, storage, and secure access behavior.
- Safe remote fetch: Covers Safe remote fetch across Included: Local and remote media references, including plain paths, `file://`, HTTP(S), and related media file intake, storage, and secure access behavior.
- Local root policy: Covers Local root policy across Included: Local and remote media references, including plain paths, `file://`, HTTP(S), and related media file intake, storage, and secure access behavior.
- Inbound media store: Covers Inbound media store across Included: Local and remote media references, including plain paths, `file://`, HTTP(S), and related media file intake, storage, and secure access behavior.
- PDF/document extraction dispatch: Covers PDF/document extraction dispatch across Included: Local and remote media references, including plain paths, `file://`, HTTP(S), and related media file intake, storage, and secure access behavior.
- QR and media helper classification: Covers QR and media helper classification across Included: Local and remote media references, including plain paths, `file://`, HTTP(S), and related media file intake, storage, and secure access behavior.

## Features

- Local and remote media references: Covers Local and remote media references across Included: Local and remote media references, including plain paths, `file://`, HTTP(S), and related media file intake, storage, and secure access behavior.
- MIME and type detection: Covers MIME and type detection across Included: Local and remote media references, including plain paths, `file://`, HTTP(S), and related media file intake, storage, and secure access behavior.
- Size caps and bounded reads: Covers Size caps and bounded reads across Included: Local and remote media references, including plain paths, `file://`, HTTP(S), and related media file intake, storage, and secure access behavior.
- Safe remote fetch: Covers Safe remote fetch across Included: Local and remote media references, including plain paths, `file://`, HTTP(S), and related media file intake, storage, and secure access behavior.
- Local root policy: Covers Local root policy across Included: Local and remote media references, including plain paths, `file://`, HTTP(S), and related media file intake, storage, and secure access behavior.
- Inbound media store: Covers Inbound media store across Included: Local and remote media references, including plain paths, `file://`, HTTP(S), and related media file intake, storage, and secure access behavior.
- PDF/document extraction dispatch: Covers PDF/document extraction dispatch across Included: Local and remote media references, including plain paths, `file://`, HTTP(S), and related media file intake, storage, and secure access behavior.
- QR and media helper classification: Covers QR and media helper classification across Included: Local and remote media references, including plain paths, `file://`, HTTP(S), and related media file intake, storage, and secure access behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (74%)`
- Positive signals:
  - QA scenarios cover real agent/runtime media flows for image attachment delivery, native image generation artifact creation, and generated-image reattachment through the vision path.
  - Channel and agent-runner runtime/e2e tests cover key media-intake behaviors: Telegram media downloads and media groups, WhatsApp inbound saves and `mediaMaxMb`, Teams attachment fallback routing, Slack protected-file handling, inbound `media://` hydration, sandbox staging, and final `MEDIA:` path normalization.
  - Unit tests are broad across remote fetch limits, store path safety, MIME sniffing, local root policy, inbound path patterns, PDF extractor dispatch, and response read limits.
- Negative signals:
  - Coverage is fragmented by subsystem. There is no single integration lane proving local path, URL fetch, media store, sandbox staging, document/PDF extraction, image/audio/video classification, and provider handoff together.
  - PDF/document intake has mostly unit-level extractor dispatch and channel-specific tests, not a clear end-to-end scenario equivalent to the image-understanding and image-generation roundtrip flows.
  - Safe fetch and local root policy are well unit-tested, but fewer tests exercise those exact policies through user-visible gateway/channel paths.
- Integration gaps:
  - Add an end-to-end media intake matrix scenario that submits local, remote, `media://inbound`, PDF, image, audio, and video references through the same runtime entrypoint and asserts storage, MIME, size cap, root policy, and provider handoff outcomes.
  - Add explicit real-runtime proof for PDF/document extraction from inbound channel media and OpenAI-compatible `input_file` paths.
  - Add regression scenarios for the archive-recurring failure modes: `media://inbound` access from browser/tools, Telegram document/sticker hydration, and channel final replies that render `MEDIA:` directives as text.

## Quality Score

- Score: `Beta (76%)`
- Gitcrawl reports:
  - Multiple relevant open reports indicate lived instability around media reference resolution and channel handoff: `#87203` (`media://inbound` path resolution fails for custom workspace), `#83544` (browser upload cannot access managed inbound media), `#83065` (Signal inbound media not resolvable by built-in tools), `#83748` (Telegram stickers not hydrated), `#55917` (Telegram documents become placeholders), `#85401` (WhatsApp PDF/document `MEDIA:` line rendered as text), `#67915` (local assistant attachments outside allowed folders), and `#67031` (hardcoded image size limits not configurable across sanitize layers).
  - Relevant PRs show active hardening but also churn: `#83660` browser upload inbound media boundary, `#87219` inbound media read refs, `#74231` local-root error hints, `#79268` media directive trust boundaries, `#77279` inbound media-note dedupe, and host-local media allowlist fixes.
- Discrawl reports:
  - Maintainer Discord results mention PR `#83660` still needing a decision on the inbound-media `browser.upload` boundary, Feishu inbound media cap work in `#81044`, release notes calling out iMessage local attachment roots and WhatsApp media behavior, and user reports that TTS/media files were generated locally but not delivered through Discord.
  - Discord also surfaced prior comments about WebChat text-only model attachments being offloaded as `media://inbound/*`, stale image rehydration cleanup, and host-read MIME allowlist restoration.
- Good qualities:
  - Security posture is deliberate: remote fetches go through `fetchWithSsrFGuard`, blocked private/internal hosts are logged, DNS answers are pinned and checked, redirects are bounded, cross-origin sensitive headers are stripped, and Slack file URLs are constrained to Slack-controlled HTTPS hostnames.
  - Size and stream controls are consistently present: content-length checks, streaming byte limits, idle timeouts, default media caps, channel `mediaMaxMb`, PDF page/pixel limits, and bounded text snippets.
  - Local access is root-scoped rather than ad hoc: managed inbound media is treated specially, filesystem roots reject broad or invalid roots, workspace-only mode stops opportunistic widening, and sandbox staging copies only allowed inbound paths into a bounded media directory.
  - MIME handling is robust against common spoofing: byte sniffing beats suspicious declared image types, generic ZIP containers do not become fake images, Office formats are resolved from OOXML structure or trusted extensions, and CAF/audio fallbacks cover channel voice-note reality.
  - The media store has clear scoping and cleanup primitives: sanitized filenames, safe subdirs, root-relative IDs, atomic writes via temp siblings, regular-file checks, bounded reads, and delete support for aborted parse cleanup.
- Bad qualities:
  - Operator clarity remains uneven. Local media root errors, managed inbound media accessibility, and channel-specific media placeholders have generated repeated bug reports and PRs, which means the implementation contract is stronger than the operator-facing explanation.
  - The intake surface has many parallel entrypoints with slightly different defaults: OpenAI-compatible `input_image`/`input_file`, channel inbound downloads, outbound/local media loads, browser upload, agent prompt refs, sandbox staging, and media-generation tool artifacts. This increases drift risk.
  - Some expected behavior is still channel-dependent: Telegram documents/stickers, Signal `media://` references, WhatsApp PDF/document replies, Slack protected URLs, Teams Graph/Bot Framework downloads, and browser-managed inbound uploads each need bespoke fixes or documented exceptions.
  - Archive history shows trust-boundary repairs after the fact, including raw textual `MEDIA:` directive hardening and stale media reference rehydration cleanup.
- Excluded from quality:
  - Unit, integration, e2e, live, and real-runtime verification depth were not used to raise or lower this Quality score.

## Completeness Score

- Score: `Beta (74%)`
- Surface instructions: evaluated against `references/completeness/media-understanding-and-media-generation.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Local and remote media references, MIME and type detection, Size caps and bounded reads, Safe remote fetch, Local root policy, Inbound media store, PDF/document extraction dispatch, QR and media helper classification.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- No unified end-to-end component harness covers all significant intake modes and policy layers together.
- PDF/document extraction is present but not proven through a broad user-visible flow across channel, gateway, media store, extractor, and model handoff.
- Managed inbound media remains a recurring integration boundary for browser/tools/custom workspaces.
- Local media path delivery and error messaging still create operator confusion despite root-policy improvements.
- Channel media hydration remains uneven for documents, stickers, forwarded/multi-image messages, and document-like final replies.
- Size-limit controls exist in several places, but archive reports indicate the caps and configurability are hard to reason about across sanitize layers and channel defaults.

## Evidence

### Docs

- `docs/kevinslin/maturity-scorecard/maturity-scorecard.md` rates the broader surface `Media understanding and media generation` as `M2 Alpha` with noted provider variance, file limits, and node/app parity risk.
- `docs/gateway/security/secure-file-operations.md` documents OpenClaw's fs-safe posture: root-bounded operations, atomic replacement, byte limits, symlink/hardlink rejection where required, and plugin guidance to avoid raw `fs` for untrusted paths.
- `docs/tools/image-generation.md` documents generated media delivery through `image_generate`, generated-image handoff through the message tool, local/private endpoint SSRF cautions, and reference image paths/URLs for edit mode.
- `docs/cli/qr.md` documents QR generation as a setup-code media helper and notes token/password handling and remote URL safety.
- `docs/channels/line.md` documents inbound media saved under `~/.openclaw/media/inbound/`, a default `channels.line.mediaMaxMb` cap, public HTTPS outbound media requirements, and rejection of loopback/link-local/private-network targets.
- `docs/channels/whatsapp.md`, `docs/channels/signal.md`, `docs/channels/telegram.md`, `docs/channels/slack.md`, `docs/channels/msteams.md`, `docs/channels/googlechat.md`, and adjacent channel docs document channel-specific media caps, inbound attachment handling, and remote media caveats.
- `src/config/schema.help.ts` documents OpenAI-compatible image URL controls (`allowUrl`, `urlAllowlist`, `allowedMimes`, `maxBytes`, redirects, timeout), top-level `media.preserveFilenames` / `media.ttlHours`, media-understanding image/video caps, and PDF model/max size/page defaults.

### Source

- `src/media/input-files.ts` implements `input_image` and `input_file` base64/URL sources, default MIME allowlists, byte/char/redirect/timeout/PDF limits, guarded URL fetch, spoofed image rejection, HEIC normalization, text clamping, and PDF extraction dispatch.
- `src/media/fetch.ts` implements shared remote media fetch/save with SSRF-guarded fetch, retry policy, content-length and streaming caps, idle timeout, redacted error detail, redirect-aware filenames, and saved media handoff.
- `src/infra/net/fetch-guard.ts` and `src/infra/net/ssrf.ts` implement HTTP(S)-only guarded fetch, timeout aborts, redirect loop/count checks, cross-origin header stripping, pinned DNS, hostname allowlists, blocked localhost/internal/private/special-use addresses, and trusted proxy modes.
- `src/media/store.ts` implements the media store under the configured media directory, safe subdir/ID validation, sanitized original filename handling, atomic writes, bounded stream and buffer writes, MIME-derived extensions, safe remote/local source saving, `resolveMediaBufferPath`, `readMediaBuffer`, and `deleteMediaBuffer`.
- `src/media/media-reference.ts` implements `MEDIA:` normalization, `media://inbound/<id>` parsing, sandbox path rewriting, inbound media path containment, and conversion from inbound references to physical paths.
- `src/media/local-roots.ts`, `src/media/local-media-access.ts`, and `src/media/inbound-path-policy.ts` implement default media roots, agent-scoped roots, optional root expansion from concrete local sources, workspace-only constraints, managed inbound exceptions, Windows network path rejection, and wildcard inbound root patterns.
- `src/media/mime.ts`, `src/media/sniff-mime-from-base64.ts`, and `src/media/constants.ts` implement MIME normalization, file-type sniffing with bounded prefixes, extension mappings for image/audio/video/PDF/Office/archive/text types, CAF fallback, generic-container handling, kind classification, and max bytes by kind.
- `src/media/pdf-extract.ts` and `src/media/document-extractors.runtime.ts` route PDF extraction through registered document extractors with page/pixel/text limits and clear disabled errors.
- `src/media/web-media.ts` loads local, remote, hosted-plugin, and inbound media references, applies local root gates, optional host-read capability restrictions, media kind detection, image optimization/compression, and document/media MIME allowlists.
- `src/channels/inbound-event/media.ts` normalizes channel media facts and legacy `MediaPath` / `MediaUrl` / `MediaType` arrays while preserving mixed path/URL alignment.
- `src/auto-reply/reply/stage-sandbox-media.ts` stages allowed inbound media into sandbox or remote-cache roots using fs-safe copy-in, maximum byte limits, inbound root checks, and path rewriting.
- `extensions/whatsapp/src/inbound/media.ts`, `extensions/slack/src/monitor/media.ts`, `extensions/telegram/src/telegram-media.runtime.ts`, `extensions/msteams/src/monitor-handler/inbound-media.ts`, and related channel files adapt provider-specific attachment downloads into the shared media store and runtime path model.

### Integration tests

- `qa/scenarios/media/image-understanding-attachment.md` runs a flow where an attached PNG reaches the provider vision path and is asserted via `imageInputCount`.
- `qa/scenarios/media/native-image-generation.md` verifies `image_generate` appears when configured, runs, and produces a saved media artifact path.
- `qa/scenarios/media/image-generation-roundtrip.md` verifies a generated image is saved as media, read from disk, reattached on the next turn, and received by the vision path.
- `extensions/telegram/src/bot.media.downloads-media-file-path-no-file-download.e2e.test.ts` covers Telegram inbound media downloads, media groups, proxy fetch preference, file path handling, and related channel media behavior.
- `extensions/telegram/src/bot.media.stickers-and-fragments.e2e.test.ts` covers Telegram sticker and fragment media handling.
- `extensions/whatsapp/src/inbound.media.test.ts` covers inbound image/document saves, quoted media, extension preservation, and `mediaMaxMb` propagation.
- `extensions/msteams/src/monitor-handler/inbound-media.test.ts` covers Teams Graph/Bot Framework attachment fallback routing and diagnostic logging.
- `src/auto-reply/reply/agent-runner.media-paths.test.ts` covers final `MEDIA:` reply normalization, shared media cache behavior, current inbound media passed as native images, and fallback behavior for partial media.
- `src/agents/embedded-agent-runner/run/images.test.ts` covers managed inbound `media://` hydration, sandbox-staged inbound media, workspace-only blocking, attachment ordering, and stale/local reference handling in the agent runner.
- `src/gateway/control-ui-assistant-media.e2e.test.ts`, `src/cli/program.nodes-media.e2e.test.ts`, `test/image-generation.runtime.live.test.ts`, and `test/image-generation.infer-cli.live.test.ts` provide additional runtime/live proof for adjacent media delivery and generation paths.

### Unit tests

- `src/media/fetch.test.ts` covers content-length and streaming maxBytes rejection, default stream limits, private IP blocking, redacted token errors, idle timeout, retry behavior, and save/read remote media behavior.
- `src/media/store.test.ts` and `src/media/store.redirect.test.ts` cover saved media extensions, original filename sanitization, safe source reads, no-space cleanup, redirect handling, cross-origin header stripping, same-origin header retention, and file modes.
- `src/media/local-media-access.test.ts`, `src/media/local-roots.test.ts`, and `src/media/inbound-path-policy.test.ts` cover managed inbound exceptions, nested inbound rejection, workspace sibling rejection, scoped roots, root expansion policy, pass-through remote scheme behavior, wildcard inbound roots, and root validation.
- `src/media/input-files.fetch-guard.test.ts` covers base64 and URL image/file intake, HEIC conversion, spoofed MIME rejection, URL disabled behavior, content-length/stream cancellation, allowed MIME enforcement, and URL guard parameters.
- `src/media/mime.test.ts` and `src/media/sniff-mime-from-base64.test.ts` cover Office/ZIP/generic-container handling, image header/extension spoofing, HTML/XML/CSS mappings, audio and CAF detection, extension mapping, and bounded sniff prefixes.
- `src/media/read-response-with-limit.test.ts` and `src/media/read-byte-stream-with-limit.test.ts` cover bounded streaming reads, overflow errors, text snippets, and idle timeout cancellation.
- `src/media/pdf-extract.test.ts` and `src/media/document-extractors.runtime.test.ts` cover document extractor dispatch, PDF passwords, disabled extractor errors, MIME matching, and extractor error aggregation.
- `src/media/web-media.test.ts` covers local/hosted media loading, local root enforcement, image optimization/compression policy, host-read MIME allowlist behavior, and unsafe local media rejection.
- `src/channels/inbound-event/media.test.ts` covers normalization of path/URL/content-type media facts and legacy media payload arrays.
- `src/auto-reply/reply/stage-sandbox-media.runtime.ts` and related tests cover sandbox media staging, inbound root checks, staged-path rewriting, and oversize behavior.
- Channel unit tests under `extensions/slack`, `extensions/whatsapp`, `extensions/msteams`, `extensions/telegram`, `extensions/qqbot`, and `extensions/line` cover channel-specific media caps, attachment downloads, MIME fallbacks, file consent/upload, outbound media source handling, and media helper behavior.

### Gitcrawl queries

Query:

```bash
gitcrawl search openclaw/openclaw --query "media file intake storage secure access" --json
```

Results:

- No hits.

Query:

```bash
gitcrawl search openclaw/openclaw --query "media attachment MIME sniff size cap SSRF local roots" --json
```

Results:

- No hits.

Query:

```bash
gitcrawl search openclaw/openclaw --query "media://inbound media store attachment file access" --json
```

Results:

- No hits.

Query:

```bash
gitcrawl search openclaw/openclaw --query "PDF document extraction media intake" --json
```

Results:

- No hits.

Query:

```bash
gitcrawl search openclaw/openclaw --query "local media path" --json
```

Results:

- `#77702` open issue: Telegram `MEDIA:` directives with local image paths are sent as text instead of attachments.
- `#85401` open issue: WhatsApp final reply `MEDIA:` directive can render as plain text for PDF/document attachments.
- `#67915` open issue: local assistant attachments shown as unavailable/outside allowed folders despite server config.
- `#74231` open PR: adds configured roots to path-not-allowed error hints.
- `#79268` open PR: hardens media directive trust boundaries.

Query:

```bash
gitcrawl search openclaw/openclaw --query "input_image" --json
```

Results:

- `#86878` open issue: codex-app-server stdout leaks into `input_image` base64 and breaks subsequent API calls.
- `#67031` open issue: image size limits are hardcoded and not configurable across sanitize layers.
- `#80418` open PR: OpenAI SDK parity path mentions `input_image` and `input_file` test shape.
- `#75727` open PR: inline media rendering path includes `input_image` content block behavior.

Query:

```bash
gitcrawl search openclaw/openclaw --query "inbound media" --json
```

Results:

- `#83660` open PR: allows browser upload from inbound media directory.
- `#87219` open PR and `#87203` open issue: resolves inbound media read refs and fixes `media://inbound` path resolution failures for custom workspaces.
- `#83544` open issue: browser upload cannot access files from managed inbound media.
- `#83065` open issue: Signal inbound media surfaces as `media://` URIs not resolvable by built-in tools.
- `#83748` open issue: Telegram inbound stickers are not hydrated as agent-readable media.

Query:

```bash
gitcrawl search openclaw/openclaw --query "mediaMaxMb attachment" --json
```

Results:

- `#55917` open issue: Telegram documents sometimes arrive only as `<media:document>` instead of a real attachment.

### Discrawl queries

Query:

```bash
/Users/kevinlin/.local/bin/discrawl search "media file intake storage secure access" --limit 5
```

Results:

- No results.

Query:

```bash
/Users/kevinlin/.local/bin/discrawl search "local media path" --limit 5
```

Results:

- 2026-05-27 release notes mention iMessage local attachment roots, WhatsApp group/media behavior, and fetched file text wrapping as hardened or steadier.
- 2026-05-18 contributor report describes a Discord TTS case where a real local Opus file was produced but not handed to Discord as media, indicating delivery bridge confusion.
- 2026-05-26 maintainer report mentions messaging fixes across iMessage, WhatsApp, Mattermost, QQ Bot, and Telegram harness paths.

Query:

```bash
/Users/kevinlin/.local/bin/discrawl search "inbound media" --limit 5
```

Results:

- 2026-05-19 maintainer request for PR `#83660` asks for review of the inbound-media `browser.upload` boundary and whether it or `#83572` should be canonical.
- 2026-05-13 PR `#81521` note describes an inbound metadata trust-boundary fix for channel metadata flowing into visible prompts.
- 2026-05-12 PR `#81044` note says Feishu inbound media downloads were capped to close an oversized-file memory-risk gap.

Query:

```bash
/Users/kevinlin/.local/bin/discrawl search "media://inbound" --limit 5
```

Results:

- 2026-04-26 issue comment says text-only WebChat/Gateway attachment mitigation offloads images as `media://inbound/*` refs instead of discarding them.
- 2026-04-26 issue comments for stale image rehydration say old `[media attached: ...]`, `[Image: source: ...]`, and bare `media://inbound/...` references are scrubbed from pruned replay context.
- 2026-04-26 review comment says preserving attachments for text-only model paths by offloading to `media://inbound/*` is not the same as honoring explicit model input override semantics.

Query:

```bash
/Users/kevinlin/.local/bin/discrawl search "PDF document attachment media" --limit 5
```

Results:

- 2026-04-10 review comment says `src/media/web-media.ts` restored host-read MIME allowlist so host-local outbound sends are limited to image/audio/video plus PDF and Office document MIME types instead of arbitrary plaintext-like files.
- 2026-04-08 issue and PR notes describe WhatsApp PDF/document media sends that reported success while delivering text-only, and a fix routing media sends to `sendMedia` instead of `sendText`.
- 2026-03-27 PR note says Telegram document attachments were being misidentified by a generic placeholder, causing agents to respond as if no PDF was received.
