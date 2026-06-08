---
title: "Browser automation and exec/sandbox tools - Browser Automation Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Browser automation and exec/sandbox tools - Browser Automation Maturity Note

## Summary

Browser actions, snapshots, and artifacts is Stable on Coverage and exactly
Stable at the 80% Quality boundary. The implementation covers rich Playwright
actions, AI/role/ARIA snapshots, downloads, uploads, screenshots, PDFs, network
artifacts, dialogs, and output-path safety. Quality is held at the lower Stable
edge because file upload, stale refs, and existing-session artifact limits remain
visible in current archive signals.

## Category Scope

Included in this category:

- Browser Actions: Covers Browser Actions across browser tool action schemas, navigate/act/snapshot/screenshot operations, AI/role/ARIA snapshot formats, action ref storage, and related browser actions, snapshots, and artifacts behavior.
- Snapshots: Covers Snapshots across browser tool action schemas, navigate/act/snapshot/screenshot operations, AI/role/ARIA snapshot formats, action ref storage, and related browser actions, snapshots, and artifacts behavior.
- Artifacts: Covers Artifacts across browser tool action schemas, navigate/act/snapshot/screenshot operations, AI/role/ARIA snapshot formats, action ref storage, and related browser actions, snapshots, and artifacts behavior.
- Browser Plugin Service: Covers Browser Plugin Service across bundled browser plugin activation, browser CLI registration, `browser.request` Gateway routing, control-service startup, and related browser plugin service and profiles behavior.
- Profiles: Covers Profiles across bundled browser plugin activation, browser CLI registration, `browser.request` Gateway routing, control-service startup, and related browser plugin service and profiles behavior.
- Browser Security: Covers Browser Security across browser-control auth, navigation URL validation, delayed navigation guards, strict private-network SSRF policy, and related browser security, ssrf, and remote control behavior.
- SSRF: Covers SSRF across browser-control auth, navigation URL validation, delayed navigation guards, strict private-network SSRF policy, and related browser security, ssrf, and remote control behavior.
- Remote Control: Covers Remote Control across browser-control auth, navigation URL validation, delayed navigation guards, strict private-network SSRF policy, and related browser security, ssrf, and remote control behavior.

## Features

- Browser Actions: Covers Browser Actions across browser tool action schemas, navigate/act/snapshot/screenshot operations, AI/role/ARIA snapshot formats, action ref storage, and related browser actions, snapshots, and artifacts behavior.
- Snapshots: Covers Snapshots across browser tool action schemas, navigate/act/snapshot/screenshot operations, AI/role/ARIA snapshot formats, action ref storage, and related browser actions, snapshots, and artifacts behavior.
- Artifacts: Covers Artifacts across browser tool action schemas, navigate/act/snapshot/screenshot operations, AI/role/ARIA snapshot formats, action ref storage, and related browser actions, snapshots, and artifacts behavior.
- Browser Plugin Service: Covers Browser Plugin Service across bundled browser plugin activation, browser CLI registration, `browser.request` Gateway routing, control-service startup, and related browser plugin service and profiles behavior.
- Profiles: Covers Profiles across bundled browser plugin activation, browser CLI registration, `browser.request` Gateway routing, control-service startup, and related browser plugin service and profiles behavior.
- Browser Security: Covers Browser Security across browser-control auth, navigation URL validation, delayed navigation guards, strict private-network SSRF policy, and related browser security, ssrf, and remote control behavior.
- SSRF: Covers SSRF across browser-control auth, navigation URL validation, delayed navigation guards, strict private-network SSRF policy, and related browser security, ssrf, and remote control behavior.
- Remote Control: Covers Remote Control across browser-control auth, navigation URL validation, delayed navigation guards, strict private-network SSRF policy, and related browser security, ssrf, and remote control behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (84%)`
- Positive signals:
  - Docs enumerate the browser control API and CLI actions, including snapshots,
    screenshots, console, errors, requests, PDF, response body, downloads,
    dialogs, uploads, and trace.
  - Source has dedicated Playwright action, snapshot, download, route, and output
    directory modules with navigation guards and output-root constraints.
  - Tests cover snapshot storage, timeout forwarding, delayed navigation guards,
    upload path revalidation, download finalization, response body, and CLI
    action inputs.
  - Docker browser CDP snapshot smoke proves live CDP/browser interaction, not
    only schema-level behavior.
- Negative signals:
  - Archive issues and PRs still mention upload hooks, stale-click failures,
    snapshot scroll behavior, and CDP timeout/slow attach behavior.
  - Existing-session profiles still lack some advanced artifact capabilities.
- Integration gaps:
  - Add a live action matrix covering uploads, downloads, PDFs, response bodies,
    dialogs, screenshots, AI snapshots, and role snapshots against the same
    fixture.
  - Add a browser upload regression lane that validates inbound media directory
    upload and large/permission-sensitive file handling.

## Quality Score

- Score: `Stable (80%)`
- Gitcrawl reports:
  - `browser request upload` returned open PR #74352 for upload-hook timeout,
    open PR #83660 for inbound media upload, issue #38844 for flaky file chooser
    and stale-click misreporting, and issue #51395 for a non-standard upload
    fallback.
  - `browser cdp snapshot` returned issue #72653 for browser tool timeout despite
    CDP working, issue #64929 for slow Brave mode, issue #53390 for snapshot
    content before scroll, and docs contradiction #80587.
- Discrawl reports:
  - `browser snapshot upload` returned user-facing automation guidance about
    taking fresh snapshots, avoiding stale refs, and arming browser upload before
    clicking file inputs.
- Good qualities:
  - Action implementation separates interaction, snapshot, download, route, and
    output concerns.
  - Upload paths are revalidated at use time and resolved through constrained
    upload/output directories.
  - Download completion uses atomic finalization and sanitizes suggested names to
    prevent traversal escapes.
  - Navigation checks run after actions that can alter current page or open tabs.
- Bad qualities:
  - Artifact support depends heavily on profile type; existing-session profiles
    cannot do every raw CDP/managed-browser artifact path.
  - Snapshot refs are inherently volatile, and stale-ref misuse remains a common
    operator and agent-workflow failure mode.
  - Upload flows remain sensitive to file chooser timing, non-standard inputs,
    and inbound media path routing.
- Excluded from quality:
  - Unit, integration, e2e, live, and runtime-flow test evidence affected
    Coverage only.

## Completeness Score

- Score: `Stable (84%)`
- Surface instructions: evaluated against `references/completeness/browser-automation-and-exec-sandbox-tools.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Browser Actions, Snapshots, Artifacts, Browser Plugin Service, Profiles, Browser Security, SSRF, Remote Control.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Browser upload needs stronger user-facing diagnostics when stale refs or
  unsupported file inputs are the real failure.
- Artifact support matrix should be clearer for managed, remote CDP, attach-only,
  and existing-session profiles.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/tools/browser-control.md:154`: CLI exposes screenshot, snapshot, console, errors, requests, PDF, and response body.
- `/Users/kevinlin/code/openclaw/docs/tools/browser-control.md:178`: CLI actions include navigate, click, type, drag, upload, wait, evaluate, and trace.
- `/Users/kevinlin/code/openclaw/docs/tools/browser-control.md:231`: upload/dialog arming, action refs, temp path constraints, stable tab ids, and snapshot flags are documented.
- `/Users/kevinlin/code/openclaw/docs/tools/browser-control.md:252`: AI, role, and ARIA refs plus Docker proof are documented.
- `/Users/kevinlin/code/openclaw/docs/help/testing.md:783`: docs identify the browser CDP snapshot Docker smoke as a browser doctor and snapshot verification lane.

### Source

- `/Users/kevinlin/code/openclaw/extensions/browser/src/browser-tool.schema.ts:4`: browser act kinds are defined in schema.
- `/Users/kevinlin/code/openclaw/extensions/browser/src/browser-tool.schema.ts:19`: browser tool actions and sandbox/host/node targets are defined.
- `/Users/kevinlin/code/openclaw/extensions/browser/src/browser-tool.actions.ts:44`: action timeouts and existing-session behavior are configured.
- `/Users/kevinlin/code/openclaw/extensions/browser/src/browser/pw-tools-core.interactions.ts:84`: interaction code detects cross-document and hash-only navigation.
- `/Users/kevinlin/code/openclaw/extensions/browser/src/browser/pw-tools-core.interactions.ts:169`: delayed interaction navigation guard is applied.
- `/Users/kevinlin/code/openclaw/extensions/browser/src/browser/pw-tools-core.snapshot.ts:37`: snapshot code collects and appends snapshot URLs.
- `/Users/kevinlin/code/openclaw/extensions/browser/src/browser/pw-tools-core.snapshot.ts:109`: ARIA refs are stored via Playwright.
- `/Users/kevinlin/code/openclaw/extensions/browser/src/browser/pw-tools-core.downloads.ts:92`: downloads are saved inside output root.
- `/Users/kevinlin/code/openclaw/extensions/browser/src/browser/pw-tools-core.downloads.ts:130`: file upload arming validates existing paths under the upload dir.
- `/Users/kevinlin/code/openclaw/extensions/browser/src/browser/routes/agent.snapshot.ts:195`: screenshot response is normalized and saved.

### Integration tests

- `/Users/kevinlin/code/openclaw/scripts/e2e/browser-cdp-snapshot-docker.sh:84`: Docker E2E runs browser doctor, opens a fixture, snapshots, and asserts output.
- `/Users/kevinlin/code/openclaw/scripts/e2e/lib/browser-cdp-snapshot/assert-snapshot.mjs:6`: snapshot assertion checks page text, URL, link refs, and iframe evidence.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/browser/src/browser/pw-tools-core.snapshot.test.ts:54`: verifies resolved pages are reused when storing ARIA refs.
- `/Users/kevinlin/code/openclaw/extensions/browser/src/browser/pw-tools-core.snapshot.test.ts:95`: verifies snapshot timeout behavior.
- `/Users/kevinlin/code/openclaw/extensions/browser/src/browser/pw-tools-core.interactions.set-input-files.test.ts:71`: verifies upload paths are revalidated and canonicalized.
- `/Users/kevinlin/code/openclaw/extensions/browser/src/browser/pw-tools-core.waits-next-download-saves-it.test.ts:170`: verifies explicit download paths are finalized.
- `/Users/kevinlin/code/openclaw/extensions/browser/src/browser/pw-tools-core.waits-next-download-saves-it.test.ts:402`: verifies suggested download filename sanitization.
- `/Users/kevinlin/code/openclaw/extensions/browser/src/cli/browser-cli-actions-input/register.element.test.ts:1`: CLI action input coverage exists for browser element actions.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "browser request upload" --json`

Results:

- Open PR #74352: `fix(browser): give upload hooks enough client timeout`.
- Open PR #83660: `fix(browser): allow upload from inbound media directory`.
- Open issue #38844: browser upload/file chooser flow can be flaky and misreport stale-click failures.
- Open issue #51395: browser upload fallback for non-standard file inputs.

Query:

`gitcrawl search openclaw/openclaw --query "browser cdp snapshot" --json`

Results:

- Open issue #72653: browser tool times out despite CDP connection working.
- Open issue #64929: local managed Brave mode is slow due to CDP attach/discovery overhead.
- Open issue #53390: snapshot returns page content before scroll.
- Open issue #80587: docs contradiction on `browser wait --load networkidle`.

### Discrawl queries

Query:

`discrawl search --mode fts --limit 5 "browser snapshot upload"`

Results:

- User-support archive entries from 2026-03-20 describe recurring snapshot and upload rules: refresh snapshots before actions, avoid old refs, arm upload before clicking file inputs, and use compact interactive snapshots.
