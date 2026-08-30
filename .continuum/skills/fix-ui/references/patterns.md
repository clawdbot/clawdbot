# Patterns

## Do

- Use delegated title tooltips via installTitleTooltips(document) + native title attribute on the trigger button instead of wrapping <wa-dropdown> in <openclaw-tooltip> so the wa-tooltip anchor stays the button (fixes detached positioning) — see chat-pane-header.ts:488 and chat-sidebar-editor-menu.ts:15
- Guard e2e Playwright predicates with optional chaining app?.runtime?.router.getState() when querying <openclaw-app> to handle native popup navigation racing ahead of element parse — ui/src/test-helpers/control-ui-e2e.ts:126
- Browser positioning test pattern: render with lit render(), set fixed container geometry, hover via page.elementLocator(trigger).hover(), poll shadowRoot '[part="body"]' rect vs trigger.getBoundingClientRect() for horizontal overlap and <24px vertical gap — ui/src/pages/chat/components/chat-pane-header.browser.test.ts:66
- Preserve diagnostic fidelity on waitForControlUiRoute failure: catch error, re-evaluate router state as app?.runtime?.router.getState() ?? null and rethrow with cause and JSON string containing "router":null — ui/src/test-helpers/control-ui-e2e.ts:166
- Centralize prefix sanitization in ui/src/components/error-presentation.ts with ERROR_ICON_PREFIX_RE / ERROR_ICON_PREFIX_TOKEN_RE and reuse via formatWebUiIconErrorText in both session-attention-presentation.ts and chat-view-notices.ts instead of per-call regex
- Presentational-only stripping: ui/src/pages/chat/chat-gateway.ts preserves raw errorMessage in state.chatRunError and chat-view-notices.ts passes raw error to renderCopyButton while display uses formatWebUiIconErrorText — separation of display vs storage/clipboard/transcript/toast
- Anchored leading-run regex /^[ \t]*(?:⚠️?|⛔|❌|🛠️?|✉️?)(?:[ \t]*(?:⚠️?|⛔|❌|🛠️?|✉️?))*/u with /gu token regex preserves body emoji (🧭) and interior spacing; test uses diagnostic '⚠️ ✉️ Message failed: ... near 🧭' expecting rendered 'Message failed: ... near 🧭'
- Explicit no-open details assertion in error alerts: chat-run-lifecycle.e2e.test.ts and chat-view.test.ts verify alert.locator('details').count()==0 / hasAttribute('open')==false to prevent duplicate disclosure
- Behavioral parity test for error ownership: chat-view.test.ts iterates ['run','request'] sources confirming both strip only decorative prefix and keep dismiss/copy semantics
- Use waitForSettledFormControls(page, [{locator, value}]) from ui/src/e2e/settle.test-support.ts to synchronize on hydrated draft value after route navigation before fill/clear
- Use expect.poll(() => new URL(page.url()).pathname) with controlUiSessionPath and waitForControlUiRoute({routeId: "chat"}) to avoid racing on SPA navigation
- Isolate long-running draft+activity scenario into dedicated suite file via createSessionManagementE2eSuite() and installMockGateway with sessions.list/sessionsRow mocks
- Verify UI indicator layout with boundingBox() x+width comparison between 'Active run' and 'Unsent draft' icons
- Capture visual proof points with captureUiProof(page, "draft-indicator-*.png") before/after draft creation
- Bind host callbacks via closure to admitted run's operational `runId`/`lifecycleGeneration`/`sessionKey` and fence with `assertActive()` covering close, `closeAdmittedRunDelegatedAuthority`, and `rotateAgentRunRegistryLifecycleGeneration` — src/agents/harness/host-capability.ts:183-355
- Deduplicate native provider notifications by `responseId` Set before counting (CodexResponseCompletionProjection.record) — extensions/codex/src/app-server/event-projector-usage.ts:122-131
- Report per-response deltas and accumulate host-side lifecycle total; retries share same total, cleanup releases it — docs/plugins/sdk-agent-harness.md:383, src/infra/agent-events.ts:382
- Sequence-guard usage map (`payload.seq <= current.seq` skip) and LRU-bound `RUN_USAGE_LIMIT=50` with delete+re-set to keep most-recent order — ui/src/pages/chat/tool-stream.ts:726-740
- Treat single usage event as non-evictable current state in progress snapshot, merging `previousUsage.data` with context updates — src/gateway/server-chat-progress-snapshot.ts:96-226
- Separate live cumulative counter from last-response context snapshot and persisted billing summaries — docs token-use.md + removal of outputTokens from readCodexThreadContextSnapshot
- Deliver `onAgentEvent` usage via `runBestEffortCallback` with logger so harness exceptions don't break counting — src/agents/harness/host-capability.ts:352
- Show exact locale-formatted output tokens and keep them visible through approval/waiting states instead of whimsical phrases — ui/src/pages/chat/components/chat-working-indicator.ts:41-95

## Avoid

- Wrapping a wa-dropdown (slot="trigger" button) inside <openclaw-tooltip> — anchor becomes the wrapper element, causing the hint to render away from the button and to persist over the menu; replaced by title on the button itself
- Assuming document.querySelector('openclaw-app') is non-null in control-UI helpers (app.runtime?. without app?. check) — throws before the app upgrades when a new tab/popup fires early, now avoided with app?.runtime? and typed querySelector<HTMLElement & {runtime?}>
- Hardcoding tooltip visibility via component prop instead of relying on the shared openclaw-tooltip / wa-tooltip implementation that installTitleTooltips centralizes
- Mutating persisted gateway error state with generic prefix strip (stripChatErrorMarker in ui/src/pages/chat/chat-gateway.ts) rather than formatting at view layer — replaced by verbatim return and centralized display helper
- Single-token hardcoding /^⚠️\s*/u for error decoration when taxonomy includes ⛔/❌/🛠️/✉️ variants — widened to anchored union covering all category glyphs
- Rendering leading decoration glyphs inside icon-backed error cards/rows causing duplicate ⚠️/✉️/🛠️ icons alongside the card's own icon
- Collapsing or trimming raw diagnostics for equality checks (Error: prefix, whitespace normalization) in a way that loses fidelity needed for copy/transcript — narrowed to comparison-only normalization
- Clearing composer with fill("") immediately after navigation without waiting for restored value — replaced with explicit waitForSettledFormControls for "Keep this unsent"
- Asserting draft indicator disappearance via immediate draft.count() check without waiting for form controls to settle to ""
- Overloading ui/src/e2e/session-management.sidebar.e2e.test.ts with unrelated draft-indicator scenario instead of dedicated draft-indicator file
- Inferring turn identity from session row `endedAt`/`runtimeMs` baseline timestamps without runId — removed `baselineEndedAt/baselineOutputTokens/absorbedTerminal` TurnRecapWatch in ui/src/pages/chat/chat-progress.ts:262
- Storing live cumulative `outputTokens` in Codex thread context snapshot (`last.outputTokens`) — removed from readCodexThreadContextSnapshot in extensions/codex/src/app-server/event-projector-usage.ts:24
- Emitting or overwriting usage on every streamed text fragment instead of once per completed model response — replaced with `rawResponse/completed` + reportOutputTokens docs/plugins/sdk-agent-harness.md:385
- Comparing usage values (`outputTokens <= current`) to suppress updates, allowing stale recovery snapshots to overwrite — replaced with seq comparison in ui/src/pages/chat/tool-stream.ts:726
- Deleting `chatRunUsageById` entry on `lifecycle` start/end before recap render, losing recoverable count — removed deletion in ui/src/pages/chat/tool-stream.ts:1084 and src/gateway recovery tests
- Using compact formatting (2.4k) for live usage hiding small increments — replaced with `toLocaleString` exact '2,400 output tokens' in ui/src/pages/chat/components/chat-working-indicator.ts:41 and i18n en.ts:5787
