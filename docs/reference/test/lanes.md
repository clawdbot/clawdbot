---
summary: "Control UI, TUI, extension, Gateway, and live lane commands and fixture rules"
title: "Control UI, TUI, and E2E lanes"
read_when:
  - You are running or writing a Control UI, TUI, or extension test
  - You need the Gateway or live E2E lane commands
---

## Control UI, TUI, and extension lanes

- **Control UI E2E:** `pnpm test:ui:e2e` runs the Vitest + Playwright lane, usually against a mocked Gateway WebSocket. Four resource groups retain two execution phases: `ui-e2e-bundled` and `ui-e2e-standalone` run first with at most two workers total; `ui-e2e-serial` and `ui-e2e-serial-standalone` then share one worker. The two bundle consumers lazily share one temporary UI bundle/preview until the invocation closes. Standalone projects own their fixture, source, or custom-build servers; selecting only standalone suites avoids the shared bundle build. Every selected project receives Chromium metadata, and new E2E files default to parallel bundled ownership. The root config retains the full discovery inventory: `ui/src/**/*.e2e.test.ts` plus the QA Lab media-transcript and OpenClaw-delegation real-Gateway suites. Shared mocks/controls live in `ui/src/test-helpers/control-ui-e2e.ts`. Some suites start isolated real Gateways; `OPENCLAW_UI_E2E_SKIP_REAL_GATEWAY=1` excludes them. `pnpm test:e2e` includes this lane, with no additional CI jobs for resource groups. Use Testbox/Crabbox only when clean Linux/browser parity is part of the proof. In a linked worktree, `node scripts/run-vitest.mjs run --config test/vitest/vitest.ui-e2e.config.ts --configLoader runner ui/src/e2e/chat-flow.messaging.e2e.test.ts` avoids pnpm dependency reconciliation for a targeted local run.
- **Control UI real-Gateway approval proof:** Check default and explicit Full Access delegation against an isolated Gateway with a mock provider. Build the runtime before running the targeted proof:

  ```bash
  pnpm build qaRuntime
  node scripts/run-vitest.mjs run --config test/vitest/vitest.ui-e2e.config.ts \
    --configLoader runner extensions/qa-lab/src/control-ui-openclaw-delegation.real-gateway.e2e.test.ts
  ```

- **TUI PTY tests:** `node scripts/run-vitest.mjs run --config test/vitest/vitest.tui-pty.config.ts` runs the fast fake-backend PTY lane. `OPENCLAW_TUI_PTY_INCLUDE_LOCAL=1` or `pnpm tui:pty:test:watch --mode local` runs the slower `tui --local` smoke, which mocks only the external model endpoint. CI also sets `OPENCLAW_TUI_PTY_USE_BUILT_CLI=1` after building `dist/`; use that flag only when exact-head built artifacts already exist. Assert stable visible text or fixture calls, not raw ANSI snapshots.
- `pnpm test:extensions` and `pnpm test extensions` run all extension/plugin shards. Heavy channel plugins, the browser plugin, and OpenAI run as dedicated shards; other plugin groups stay batched. `pnpm test extensions/<id>` runs one bundled plugin lane.
- **Browser native host:** `node scripts/run-vitest.mjs extensions/browser/src/browser/extension-install.native-host.e2e.test.ts` runs the real native messaging launcher on macOS or Linux against built dist with synthetic installation state; it does not launch Chrome or a Gateway. Windows skips this POSIX process proof because [native bootstrap uses manual pairing there](/tools/chrome-extension#requirements). The E2E owner prepares artifacts before workers. With an already-built candidate, prefix the command with `OPENCLAW_E2E_USE_PREBUILT_DIST=1` to reuse it; missing artifacts fail the test. This case belongs to `pnpm test:e2e`, not the browser source shard or untargeted `pnpm test` unit suite. Linux CI runs it explicitly in `build-artifacts` and validates a JSON report proving the exact named test passed. The workflow skips only frozen historical checkouts missing this test file; that skip is unavailable proof, not a pass or coverage.
- Source files with sibling tests map to that sibling before falling back to wider directory globs. Helper edits under `src/channels/plugins/contracts/test-helpers`, `src/plugin-sdk/test-helpers`, and `src/plugins/contracts` use a local import graph to run importing tests instead of broad-running every shard when the dependency path is precise.
- Contract directory targets fan out to their contract lanes: `pnpm test src/channels/plugins/contracts` runs the four channel contract configs and `pnpm test src/plugins/contracts` runs the plugin contracts config, since the generic `channels`/`plugins` projects exclude `contracts/**`.
- `auto-reply` splits into three dedicated configs (`core`, `top-level`, `reply`) so the reply harness does not dominate the lighter top-level status/token/helper tests.
- Selected `plugin-sdk` and `commands` test files route through dedicated light lanes that keep only `test/setup.ts`, leaving runtime-heavy cases on their existing lanes.
- Base Vitest config defaults to `pool: "threads"` and `isolate: false`, with the shared non-isolated runner enabled across repo configs.
- `pnpm test:channels` runs `vitest.channels.config.ts`.

### Real-Gateway Control UI fixture lifetimes

Use `createControlUiE2eSuite` from
`ui/src/e2e/control-ui-e2e-suite.test-support.ts` for real-Gateway browser fixtures.
`suite.define(...)` owns the native hooks. Each native `it` passes its test context
to `suite.runScenario(context, ...)`, which owns acquisition, the test body, and
finalization before another case starts. Acquire and close browser contexts through
`suite.newBrowserContext` and `suite.closeBrowserContext` so late acquisitions and
pending closes remain owned.

Retain test state immediately after `createOpenClawTestState` resolves, including
when later config writes, imports, or startup fail. Hold original startup promises,
not just their timeout wrappers. Close required producers before releasing state.
For producers shared across cases, as in the MCP and auth suites, use the suite's
`resources.run`, `resources.close`, and `resources.release` callbacks instead of
independent `beforeAll`/`afterAll` cleanup. Resource acquisition follows shared
server/browser acquisition; teardown joins cases and browser cleanup, closes
required producers and servers, and releases state only after those closes succeed.

Failed or unjoined cleanup retains selectors and state, blocks later cases using
this suite owner, and leaves native Vitest to terminate and join the isolated fork. Do not
swallow close failures or restore the environment beneath unfinished work. The
lifetime owner preserves existing hook, test, and action budgets.

Gateway close joins received WebSocket work and asynchronous connection cleanup,
including cooperating background refreshes registered at their producer with
`trackAsyncWork`. Connection-dependent worker sidecars must stop successfully
before supervisor transports or other dependencies close; failure retains those
dependencies and rejects shutdown. Register the actual operation, not just its
response or timeout wrapper; cache eviction does not end its lifetime. `withOpenClawTestState` likewise
joins registered callback descendants before releasing state. MCP requests observe
both caller cancellation and their closing work owner, so shutdown cancels pending
requests before joining handlers and disposing transports. These scopes do not
automatically track arbitrary detached work or replace native test-timeout ownership.
Other Gateway subsystems can retain documented bounded shutdown behavior, so close
is not a guarantee of universal subsystem or descendant-process quiescence.

<a id="retained-mocked-control-ui-proof" />

### Retained Control UI proof

For startup ownership changes, exercise authenticated hello before browser recovery migration finishes. Project and environment discovery can start from hello; migration completion must not refetch those catalogs or invalidate an admitted start. Keep changed-owner, process-restart, and late-result fences covered separately. Count storage reads by key around rerenders, typing, and streaming without recording credential values. Compare route payload bytes and loaded module closures separately from timings; CSS ownership changes also need retained screenshots and computed-style or geometry checks across New session and Chat.

Migrated mocked and real-Gateway browser proof uses fresh retained directories.
Scenario captures using `suite.artifactDir`, including Logs and Usage, allocate
lazily per test attempt; standalone captures allocate per invocation. MCP
conformance and auth transports each allocate one suite-owned directory after the
browser-availability check, even when media capture is disabled. Auth transport
screenshots wait for meaningful content and the presentation owner's finite
entrance or resize animations, while perpetual descendant activity continues.
The shared agent-file capture helper allocates once per module evaluation when
capture is enabled, sharing that directory across the module's scenarios. The Node-only
`createControlUiE2eArtifactDir(scope, parentDir?)` helper in
`ui/src/test-helpers/control-ui-e2e-artifacts.ts` prints the actual allocated path.
An explicit parent wins; otherwise it uses the trimmed existing
`OPENCLAW_UI_E2E_ARTIFACT_DIR`, then the repository's `.artifacts/control-ui-e2e`
parent. Existing feature-specific directory controls and script output arguments
select parents, with unique children beneath them. Explicit screenshot filename
controls preserve the basename and print the relocated path.

Keep capture gates independent from allocation: `OPENCLAW_CAPTURE_UI_PROOF`,
`OPENCLAW_UI_E2E_RECORD`, and output-presence gates retain their existing meanings.
For per-attempt captures, allocate during scenario execution or `beforeEach`.
Pass the same owner to shared capture helpers so screenshots, reports, and video
stay together. Distinguish stage names within an attempt. Close the browser context
before finalizing video.

Successful and failed evidence is retained. Cleanup is manual: remove only exact
directories that you own and have finished reviewing. Never recursively delete
the shared parent before a replay. Disposable build/media fixtures and temporary
raw video have their own cleanup. New captures cannot recover overwritten evidence;
do not describe a replay as recovery of lost files.

Timeout diagnostics allocate fresh children beneath the existing
`OPENCLAW_UI_E2E_DIAGNOSTIC_DIR` or default timeout directory, keeping each PNG and
JSON report together. Their `ci.shardIndex` and `ci.vitestShardCount` fields record
`VITEST_SHARD_INDEX` and `VITEST_SHARD_COUNT`, respectively, as supplied by normal
CI. Missing values remain `null`; manual and separate release E2E invocations do
not infer this metadata from Vitest's `--shard` argument.

Mantis allocates an invocation directory for setup logs,
capture attempts, and its report; the builder preserves each attempt's relative
paths and refuses to overwrite an existing report.

Separate output owners remain, including `chat-attachment-read-lifecycle`.
Do not assume unmigrated owners share this retention guarantee.

### Screenshots during Chromium recordings

The session-host command-state real-Gateway proof uses `page.screenshot({ path })`
without `clip` or `fullPage: true`, keeping its existing viewport, recording size,
waits, and animation options. This path was verified on Linux with Playwright
1.62.1 and full Chrome for Testing 151.0.7922.34.

Other recording owners have not been migrated or certified by this proof; some
still use locator or full-page screenshots. This is not a suite-wide capture
policy. Verify each owner's screenshot content and finalized video before
changing its capture mode. When using the verified viewport path, crop any
element-only PNG outside the browser. Cropping cannot recover missing content
from an already-corrupted recording.

In a macOS arm64 reproduction with Playwright 1.62.1 and its bundled full Chrome
for Testing 151.0.7922.34, `locator.screenshot()` and
`page.screenshot({ clip })` caused small screencast frames. The element appears at
the video origin with gray elsewhere, even though the PNG, DOM geometry, and
functional assertions are correct. `fullPage: true` is not a general workaround:
a document larger than the viewport can instead produce a shrunken page with
gray padding. Unclipped viewport captures preserved the recording in the same
synthetic reproduction; other browser versions and platforms require their own
verification.

This is an upstream capture limitation, not a Gateway or context-cleanup failure.
[Chromium's screenshot handler](https://chromium.googlesource.com/chromium/src/+/151.0.7922.34/content/browser/devtools/protocol/page_handler.cc#1492)
temporarily changes the shared view size and restores it after capture; its
screencast producer can observe the intermediate surface.
[Playwright's recorder](https://github.com/microsoft/playwright/blob/v1.62.1/packages/playwright-core/src/server/videoRecorder.ts#L166)
pads undersized frames with gray. Closing the context finalizes the video but
does not repair those frames. Do not filter out bad frames or change UI behavior
to conceal this limitation.

Verify finalized video content around every capture, not just its dimensions or
the success of locator assertions. For a dependency upgrade, reproduce with a
synthetic page containing an offset small element, compare element, clipped,
viewport, and oversized full-page screenshots, and inspect every decoded frame.
Keep real host/profile footage local; inspect public proof for synthetic-only
content before sharing. Correct PNGs remain useful still-image proof, but a
corrupted video is not continuous-flow proof.

## Gateway and E2E

- Gateway tests are included in the untargeted `pnpm test` full suite; run them alone with `pnpm test:gateway`.
- `pnpm test:e2e`: repo E2E aggregate = `pnpm test:e2e:gateway && pnpm test:e2e:agent-plugin-gateway && pnpm test:ui:e2e`.
- `pnpm test:e2e:gateway`: gateway end-to-end smoke tests (multi-instance WS/HTTP/node pairing). Defaults to `threads` + `isolate: false` with one worker in `vitest.e2e.config.ts`; opt into parallelism with `OPENCLAW_E2E_WORKERS=<n>` (capped at 16), and enable verbose logs with `OPENCLAW_E2E_VERBOSE=1`.
  Broad runs prepare the shared runtime once, then use four sequential Vitest shards in fresh processes to bound worker memory. The worker limit applies within each process; ordinary test failures are retained while remaining shards finish. Explicit filters, watch mode, caller-supplied shards, coverage, and report-output options keep one direct invocation.
- `pnpm test:live`: provider live tests (Claude/Minimax/DeepSeek/z.ai/etc, gated by `*.live.test.ts`). Requires API keys and `LIVE=1` (or `OPENCLAW_LIVE_TEST=1`) to unskip; verbose output with `OPENCLAW_LIVE_TEST_QUIET=0`.
