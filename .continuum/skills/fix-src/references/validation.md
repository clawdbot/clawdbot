# Validation

- manual: create state with newer schema version then run `gateway stop` and confirm exit 0
- typecheck tsc --noEmit
- vitest run extensions/a2a/src/task-store.test.ts
- vitest run src/agents/workspace.bootstrap-read-diagnostics.test.ts
- vitest run src/cli/command-startup-policy.test.ts
- vitest run src/gateway/worker-environments/node-enrollment.test.ts
- vitest src/auto-reply/reply/commands-subagents.test.ts src/status/status-text.test.ts
- vitest src/auto-reply/reply/queue.pending-inputs.test.ts – verifies durable input consumption through queue drain/collect
- vitest src/config/sessions/session-accessor.pending-inputs.test.ts – verifies commit of one collected message, retention of exact source receipts across rewrite/restart, duplicate idempotency, and rejection of conflicting input
- vitest src/gateway/server-methods/chat-history-handler.test.ts – verifies chat.history/chat.startup return only requested current-session receipts and empty deltas
- vitest src/gateway/server-methods/chat-send-pending-inputs.test.ts – verifies ordinary browser admission, approval hook not repeated, and restart-safe abort tombstone vs interruption
- vitest src/infra/outbound/current-conversation-bindings.test.ts src/infra/outbound/account-scoped-conversation-bindings.test.ts extensions/discord/src/monitor/thread-bindings.lifecycle.test.ts extensions/feishu/src/thread-bindings.test.ts extensions/telegram/src/thread-bindings.test.ts
- vitest src/state/openclaw-agent-pending-inputs-schema.test.ts – verifies additive column added via open/doctor/first-use without changing user_version or accepted bytes
- vitest ui/src/pages/chat/chat-pending-inputs.test.ts + chat-gateway.test.ts – verifies bounded consumption lookup per pane and loadChatHistory coalescing with inputRunIds
