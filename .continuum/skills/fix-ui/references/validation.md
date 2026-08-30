# Validation

- e2e chat-flow.streaming.e2e.test.ts / stream-reconciliation.e2e.test.ts — '2,400 output tokens' assertions
- expect.poll for route draft count and presented ChatPaneElement sessionKey
- playwright e2e ui/src/e2e/chat-run-lifecycle.e2e.test.ts — waitFor sessions.list/chat.startup, alert .chat-error__content has renderedDiagnostic and details count 0
- vitest e2e run with Playwright browser context
- vitest extensions/codex/src/app-server/event-projector.usage.test.ts — dedup, cross-turn cumulative, retry sharing
- vitest run ui/src/pages/chat/components/chat-pane-header.browser.test.ts --browser (requires HTMLElement.prototype.checkVisibility, skips otherwise)
- vitest run ui/src/test-helpers/control-ui-e2e.test.ts
- vitest src/agents/harness/host-capability.test.ts — rejects after host closure/authority release/gateway restart, forged run ignored
- vitest src/gateway/server-chat-state.test.ts — retains latest usage through eviction with byte limit
- vitest src/gateway/server-chat.agent-events.test.ts — replayed usage uses clientRunId identity
- vitest src/infra/agent-events.test.ts — cumulative 12->20, seq ordering, generation rotation
- vitest ui/src/components/session-row-subtitle.test.ts — expects 'Run failed:   Message failed...' after stripping '⚠️ ✉️'
- vitest ui/src/pages/chat/chat-gateway.test.ts — keeps error emoji in live run state
- vitest ui/src/pages/chat/chat-send.test.ts — hidden-terminal outbox preserves raw, toast shows raw
- vitest ui/src/pages/chat/chat-view.test.ts — checks .chat-error <pre> equals renderedDiagnostic, no [⚠🛠], XSS <img> not rendered, copy writes raw
- vitest ui/src/pages/chat/components/chat-transcript-render.test.ts — working indicator through final batching and later corrections
- vitest ui/src/pages/chat/tool-stream.usage.node.test.ts — bounds to 50, seq-ordered, retains through lifecycle end
- waitForSettledFormControls settling correctly
