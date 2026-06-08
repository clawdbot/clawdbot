---
title: "Gateway Web App - Hosted Media and Embed Safety Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Gateway Web App - Hosted Media and Embed Safety Maturity Note

## Summary

Control UI has explicit browser safety controls for hosted embeds, assistant media, authenticated avatar routes, CSP, media tickets, local-root checks, and image/media route auth. Coverage is Stable because server tests target CSP, assistant media, avatar auth, and HTTP route behavior. Quality is Beta because the design is defensive, but archive evidence shows avatar and image-rendering issues remain visible to users and CSP/framing behavior has had product tension.

## Category Scope

This category covers `[embed ...]` rendering policy, `gateway.controlUi.embedSandbox`, external embed URL gating, CSP and frame denial, assistant media metadata/ticket routes, authenticated avatar routes, remote avatar stripping, local-media root checks, and browser-native media rendering safety.

## Features

- Hosted embeds: Covers Hosted embeds across `[embed ...]` rendering policy, `gateway.controlUi.embedSandbox`, external embed URL gating, CSP and frame denial, and related hosted media and embed safety behavior.
- External embed gating: Covers External embed gating across `[embed ...]` rendering policy, `gateway.controlUi.embedSandbox`, external embed URL gating, CSP and frame denial, and related hosted media and embed safety behavior.
- Assistant media tickets: Covers Assistant media tickets across `[embed ...]` rendering policy, `gateway.controlUi.embedSandbox`, external embed URL gating, CSP and frame denial, and related hosted media and embed safety behavior.
- Authenticated avatars: Covers Authenticated avatars across `[embed ...]` rendering policy, `gateway.controlUi.embedSandbox`, external embed URL gating, CSP and frame denial, and related hosted media and embed safety behavior.
- CSP image policy: Covers CSP image policy across `[embed ...]` rendering policy, `gateway.controlUi.embedSandbox`, external embed URL gating, CSP and frame denial, and related hosted media and embed safety behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (80%)`
- Positive signals: Gateway tests cover assistant media e2e, CSP, control-ui HTTP behavior, avatar rendering/auth, and chat media projection; UI tests cover avatar display, markdown/media rendering, and embed sandbox helpers.
- Negative signals: Real browser proof is weaker for externally hosted embeds, same-origin sandbox modes, large media, authenticated media tickets inside native media elements, and cross-browser CSP differences.
- Integration gaps: Add browser smoke for same-origin embed sandbox modes, blocked external embed URLs, authenticated avatar fetch, assistant image/audio/video media tickets, and remote URL stripping.

## Quality Score

- Score: `Beta (72%)`
- Gitcrawl reports: Avatar query returned #85750, #41201, #38439, #42504, and #68248. CSP/embed query returned no rows, while broad Control UI query returned #78577 for CSP/X-Frame-Options same-origin framing opt-in and #50779 for tool-returned images not rendering inline.
- Discrawl reports: The exact embed/media/CSP query returned no rows; broad Control UI traffic included user-visible generated-image and embed screen-real-estate complaints.
- Good qualities: CSP is tight by default, frame ancestors are denied, remote image fetches are blocked/stripped, assistant media uses short-lived scoped tickets, and embed sandbox modes are explicit.
- Bad qualities: Media and identity visuals are highly visible product edges, and users experience route-auth or CSP regressions as broken chat rather than security hardening.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow proof affect Coverage only.

## Completeness Score

- Score: `Stable (80%)`
- Surface instructions: evaluated against `references/completeness/browser-control-ui-and-webchat.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Hosted embeds, External embed gating, Assistant media tickets, Authenticated avatars, CSP image policy.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Same-origin embed opt-in policy needs product clarity.
- Avatar and assistant-media routes need recurring proof under token auth, proxy auth, and browser media-element constraints.
- Tool-returned image rendering remains a known user-facing gap in archive issues.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/web/control-ui.md` documents hosted embeds, `embedSandbox`, `allowExternalEmbedUrls`, CSP image policy, avatar route auth, and assistant media ticket behavior.
- `/Users/kevinlin/code/openclaw/docs/web/webchat.md` documents media transcript supplements and display projection.
- `/Users/kevinlin/code/openclaw/docs/gateway/security/secure-file-operations.md` documents local media safety context that underpins media route handling.

### Source

- `/Users/kevinlin/code/openclaw/src/gateway/control-ui.ts` implements assistant media ticketing, avatar resolution, local media access checks, and authenticated Control UI media routes.
- `/Users/kevinlin/code/openclaw/src/gateway/control-ui-csp.ts` builds the Control UI CSP.
- `/Users/kevinlin/code/openclaw/ui/src/ui/embed-sandbox.ts` normalizes embed sandbox policy.
- `/Users/kevinlin/code/openclaw/ui/src/ui/chat/chat-avatar.ts` and `/Users/kevinlin/code/openclaw/ui/src/ui/app-render.assistant-avatar.test.ts` support chat avatars.
- `/Users/kevinlin/code/openclaw/src/gateway/server-methods/chat-webchat-media.ts` and `/Users/kevinlin/code/openclaw/src/gateway/server-methods/chat-reply-media.ts` normalize media for WebChat.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/gateway/control-ui-assistant-media.e2e.test.ts` covers assistant media route behavior.
- `/Users/kevinlin/code/openclaw/src/gateway/control-ui.http.test.ts` covers Control UI HTTP route and asset behavior.
- `/Users/kevinlin/code/openclaw/src/gateway/control-ui-csp.test.ts` covers CSP behavior.
- `/Users/kevinlin/code/openclaw/src/gateway/server-methods/chat-webchat-media.test.ts` covers WebChat media payloads.

### Unit tests

- `/Users/kevinlin/code/openclaw/ui/src/ui/app-render.assistant-avatar.test.ts` and `/Users/kevinlin/code/openclaw/ui/src/ui/chat/chat-avatar.test.ts` cover avatar UI behavior.
- `/Users/kevinlin/code/openclaw/ui/src/ui/markdown.test.ts` and `/Users/kevinlin/code/openclaw/ui/src/styles/markdown-preview.test.ts` cover message rendering helpers.
- `/Users/kevinlin/code/openclaw/src/gateway/chat-attachments.test.ts` and `/Users/kevinlin/code/openclaw/src/gateway/managed-image-attachments.test.ts` cover server-side media helpers.

### Gitcrawl queries

Query: `gitcrawl --json search issues -R openclaw/openclaw "avatar Control UI"`

Results:

- Returned open #85750, `Control UI avatar endpoint returns 401 Unauthorized for authenticated webchat sessions`.
- Returned open #41201, `Control UI Avatar not displaying`.
- Returned open #38439, WebChat avatar endpoint 404.
- Returned feature requests #42504 and #68248 for avatar upload/customization.

Query: `gitcrawl --json search prs -R openclaw/openclaw "avatar Control UI"`

Results:

- Returned open PR #83235, `fix(control-ui): avoid protected local avatar image URLs`.
- Returned PR #62727 for descriptive identity avatar parsing.

Query: `gitcrawl --json search issues -R openclaw/openclaw "Control UI avatar assistant media embed CSP"`

Results:

- Returned `[]`.

### Discrawl queries

Query: `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 10 "Control UI avatar assistant media embed CSP"`

Results:

- Returned no rows.

Query: `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 20 "Control UI"`

Results:

- Found a maintainer request to remove embeds from a report because they took too much screen real estate.
- Found a user report where generated image output in Control UI produced text but no visible image attachment.
