# Patterns

## Do

- Separate submission identity from execution identity via SessionMessageIdentity.sendId = persistedRunId ?? runId (persistedRunId from idempotencyKey prefix) while runId tracks actual execution; introduced in packages/gateway-client/src/session-projection-message-identity.ts:78-94
- Use sendId as stable UI key to prevent remount flicker: transcriptMessageSourceKey returns `send:${sendId}` before id/seq/sequence in ui/src/pages/chat/chat-thread-items.ts:340-343, and buildCachedChatItems preserves key across local-to-history replacement
- Gate pending adoption on sendId plus text equality in src/tui/components/chat-log.ts:addLiveUser (pendingUsers.get(sendId) && pending.text===text) and delete by sendId to avoid adopting unrelated optimistic prompt
- Prefer canonical persisted __openclaw metadata over Gateway envelope for authoritative identity in readSessionMessageIdentity and readTuiSessionUserMessage, with envelope fallback only when canonical absent (tested as 'prefers canonical persisted identity over conflicting envelope')
- Parametrize queued-execution divergence with it.each([undefined,"queued-execution"]) in session-projection.test.ts and chat-thread.test.ts to verify both same-run and queued-execution paths
- Use waitForSettledFormControls(page, [{locator, value}]) to synchronize on browser-local draft hydration before mutating or asserting composer state (ui/src/e2e/settle.test-support.ts)
- Use expect.poll with controlUiSessionPath and presentedPanes.evaluateAll((panes) => (pane as ChatPaneElement).sessionKey) to wait for Control UI route/pane settlement instead of single-shot expects
- Isolate browser-local draft indicator scenario into dedicated session-management.draft-indicator.e2e.test.ts via createSessionManagementE2eSuite instead of co-locating with sidebar inline management tests
- Mock gateway deterministically with installMockGateway({methodResponses: {'sessions.list': sessionsListResponse([...sessionRow...])}}) and block serviceWorkers for e2e isolation
- Verify visual coalescence with boundingBox x-order check (draftBox.x >= activityBox.x + activityBox.width) and captureUiProof for Home active-run + unsent-draft coexistence
- Use centralized installTitleTooltips + native title attribute on the trigger button instead of per-component <openclaw-tooltip> wrapper to guarantee tooltip anchoring/placement for wa-dropdown triggers (ui/src/pages/chat/components/chat-pane-header.ts:488, ui/src/pages/chat/components/chat-sidebar-editor-menu.ts:15)
- Gate browser-dependent tooltip positioning tests with describe.skipIf(typeof HTMLElement.prototype.checkVisibility !== "function") and fixed viewport (page.viewport(1200,800))
- Verify tooltip positioning geometrically via getBoundingClientRect horizontal overlap + vertical adjacency check rather than only textContent
- Use optional chaining on querySelector result app?.runtime?.router.getState() and typed querySelector<HTMLElement & {runtime?:...}> to handle app element absent during native popup events (ui/src/test-helpers/control-ui-e2e.ts:123)
- Poll async tooltip state with expect.poll(() => tooltip()?.textContent) and tooltip().shadowRoot.querySelector('[part="body"]') to stabilize hover-triggered UI tests

## Avoid

- Matching pending to authoritative by execution runId (pending.pendingRunId === authoritative.runId in session-projection.ts:entryMatches) - replaced with sendId ?? runId because queued execution reassigns runId
- Conflating send key with run ownership for causal boundaries: removed userTurnSendIdentity() that encoded `send:${runId}` for boundaries; now userTurnRunId() provides execution runId for streamCausalInterval/latestPersistedSteerBoundary while transcript keys use sendId
- TUI ChatLog lookup by runId (pendingUsers.get(runId) / addLiveUser({runId})) - changed to sendId lookup; prevents second bubble when persisted user has idempotencyKey local-send but runId shared-run
- Clearing composer with composer.fill('') without first waiting for restored draft to settle — replaced with explicit waitForSettledFormControls for 'Keep this unsent' before clearing and for '' after
- Asserting draft disappearance immediately after fill without form-control settlement — replaced with waitForSettledFormControls + expect.poll(() => draft.count()).toBe(0)
- Co-locating unrelated draft-pencil visibility test inside session-management.sidebar.e2e.test.ts — moved to dedicated draft-indicator suite
- Wrapping a wa-dropdown trigger button in a separate <openclaw-tooltip> element which decouples tooltip positioning from the button's rect
- Casting querySelector result with `as HTMLElement & {runtime...}` and accessing app.runtime without null-check, crashing when waitForControlUiRoute runs before <openclaw-app> is parsed (replaced with app?.runtime?.router.getState())
