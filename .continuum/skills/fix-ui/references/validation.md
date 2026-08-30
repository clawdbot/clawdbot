# Validation

- boundingBox x-order check for activity vs draft icons
- expect.poll for URL pathname and draft.count()
- playwright/ui e2e ui/src/e2e/chat-send-pending-handoff.e2e.test.ts
- vitest browser test with page.viewport(1200,800) and page.elementLocator hover/poll assertions
- vitest e2e with installMockGateway + sessionsListResponse/sessionRow + controlUiSessionUrl/controlUiSessionPath
- vitest packages/gateway-client/src/session-projection.test.ts
- vitest run ui/src/test-helpers/control-ui-e2e.test.ts for waitForControlUiRoute polling and failure-preservation cases
- vitest src/tui/tui-session-events.test.ts src/tui/components/chat-log-run-state.test.ts src/tui/tui-event-handlers.test.ts
- vitest ui/src/pages/chat/chat-thread.test.ts ui/src/pages/chat/history-merge.test.ts
- waitForControlUiRoute for chat route settlement
- waitForSettledFormControls for form value settlement
