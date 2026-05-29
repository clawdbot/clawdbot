# Copilot SDK capability inventory (`@github/copilot-sdk@1.0.0-beta.4`)

> Public preview audit for the `1.0.0-beta.4` pin. Per task contract, treat this as the current `latest` dist-tag snapshot and re-generate this document whenever the pinned SDK version changes.

This inventory documents the shipped TypeScript surface that the bundled `copilot` plugin pins against, instead of guessing. Every claim below is tied to the installed SDK's `.d.ts` files and bundled docs; where the inventory is silent, this document says so explicitly.

## 1. Package metadata

- Package name: `@github/copilot-sdk`.
- Version: `1.0.0-beta.4`.
- Export map:
  - `.` -> ESM `./dist/index.js`, CJS `./dist/cjs/index.js`, types `./dist/index.d.ts`.
  - `./extension` -> ESM `./dist/extension.js`, CJS `./dist/cjs/extension.js`, types `./dist/extension.d.ts`.
- Primary type barrel `dist/index.d.ts` re-exports `CopilotClient`, `CopilotSession`, `AssistantMessageEvent`, helpers like `defineTool`/`approveAll`, and the full public type surface from `dist/types.d.ts`.
- Declared runtime deps:
  - `@github/copilot` `^1.0.46` (bundled CLI/runtime dependency)
  - `vscode-jsonrpc` `^8.2.1`
  - `zod` `^4.3.6`

Sources: `package.json` (on-disk install): 2-32, 58-62; `dist/index.d.ts` (sdk-inventory.txt:1033-1042).

## 2. Lifecycle methods on `CopilotClient`

Public methods/getters visible in `dist/client.d.ts`:

| Member                   | Signature                                                                                                     | Return shape                                                    | What it does                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `rpc`                    | `get rpc(): ReturnType<typeof createServerRpc>`                                                               | typed server RPC facade                                         | Low-level server-scoped RPC surface; throws if not connected.                                               |
| `start`                  | `start(): Promise<void>`                                                                                      | `void`                                                          | Starts/spawns the CLI server and connects.                                                                  |
| `stop`                   | `stop(): Promise<Error[]>`                                                                                    | cleanup errors array                                            | Graceful shutdown: closes sessions, JSON-RPC connection, then spawned CLI; preserves on-disk session state. |
| `forceStop`              | `forceStop(): Promise<void>`                                                                                  | `void`                                                          | Force-kills client state/process without graceful cleanup.                                                  |
| `createSession`          | `createSession(config: SessionConfig): Promise<CopilotSession>`                                               | `CopilotSession`                                                | Creates a new conversation session; auto-starts when enabled.                                               |
| `resumeSession`          | `resumeSession(sessionId: string, config: ResumeSessionConfig): Promise<CopilotSession>`                      | `CopilotSession`                                                | Re-attaches to a persisted session; returns `workspacePath` when infinite sessions were enabled.            |
| `getState`               | `getState(): ConnectionState`                                                                                 | `"disconnected" \| "connecting" \| "connected" \| "error"`      | Returns client connection state.                                                                            |
| `ping`                   | `ping(message?: string): Promise<{ message: string; timestamp: number; protocolVersion?: number; }>`          | echo payload                                                    | Connectivity/protocol sanity check.                                                                         |
| `getStatus`              | `getStatus(): Promise<GetStatusResponse>`                                                                     | `{ version: string; protocolVersion: number }`                  | Returns CLI package version and negotiated protocol version.                                                |
| `getAuthStatus`          | `getAuthStatus(): Promise<GetAuthStatusResponse>`                                                             | `{ isAuthenticated, authType?, host?, login?, statusMessage? }` | Returns current auth mode/status.                                                                           |
| `listModels`             | `listModels(): Promise<ModelInfo[]>`                                                                          | model metadata array                                            | Lists models; caches first successful result unless overridden by `onListModels`.                           |
| `getLastSessionId`       | `getLastSessionId(): Promise<string                                                                           | undefined>`                                                     | optional session id                                                                                         | Returns most recently updated session id.            |
| `deleteSession`          | `deleteSession(sessionId: string): Promise<void>`                                                             | `void`                                                          | Irreversibly deletes persisted session data from disk.                                                      |
| `listSessions`           | `listSessions(filter?: SessionListFilter): Promise<SessionMetadata[]>`                                        | session metadata array                                          | Lists persisted sessions, optionally filtered by cwd/git context.                                           |
| `getSessionMetadata`     | `getSessionMetadata(sessionId: string): Promise<SessionMetadata                                               | undefined>`                                                     | optional metadata                                                                                           | O(1)-style lookup for one session's metadata.        |
| `getForegroundSessionId` | `getForegroundSessionId(): Promise<string                                                                     | undefined>`                                                     | optional session id                                                                                         | TUI+server-only: returns current foreground session. |
| `setForegroundSessionId` | `setForegroundSessionId(sessionId: string): Promise<void>`                                                    | `void`                                                          | TUI+server-only: asks the TUI to foreground a session.                                                      |
| `on` (typed)             | `on<K extends SessionLifecycleEventType>(eventType: K, handler: TypedSessionLifecycleHandler<K>): () => void` | unsubscribe fn                                                  | Subscribes to one lifecycle event type.                                                                     |
| `on` (catch-all)         | `on(handler: SessionLifecycleHandler): () => void`                                                            | unsubscribe fn                                                  | Subscribes to all lifecycle events.                                                                         |

Lifecycle event types for `client.on(...)`: `session.created`, `session.deleted`, `session.updated`, `session.foreground`, `session.background`.

Sources: `dist/client.d.ts` (sdk-inventory.txt:1081-1518), especially 1112-1477; `dist/types.d.ts` (sdk-inventory.txt:3421-3528); README API docs (sdk-inventory.txt:96-199).

## 3. Lifecycle methods on `CopilotSession`

Public properties/getters/methods visible in `dist/session.d.ts`:

| Member                  | Signature                                                                                                                                 | Return shape                         | Notes                                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `rpc`                   | `get rpc(): ReturnType<typeof createSessionRpc>`                                                                                          | typed session RPC facade             | Low-level session RPC surface.                                                                |
| `workspacePath`         | `get workspacePath(): string                                                                                                              | undefined`                           | optional path                                                                                 | Present only when infinite sessions are enabled; workspace contains `checkpoints/`, `plan.md`, `files/`. |
| `capabilities`          | `get capabilities(): SessionCapabilities`                                                                                                 | `{ ui?: { elicitation?: boolean } }` | Host capability snapshot; auto-updated on capability change events.                           |
| `ui`                    | `get ui(): SessionUiApi`                                                                                                                  | convenience UI API                   | Exposes `elicitation`, `confirm`, `select`, `input`; requires `capabilities.ui?.elicitation`. |
| `send`                  | `send(options: MessageOptions): Promise<string>`                                                                                          | message id                           | Queues a user prompt and returns immediately.                                                 |
| `sendAndWait`           | `sendAndWait(options: MessageOptions, timeout?: number): Promise<AssistantMessageEvent                                                    | undefined>`                          | final assistant message or `undefined`                                                        | Waits for `session.idle`; timeout defaults to 60000ms and does **not** abort in-flight work.             |
| `on` (typed)            | `on<K extends SessionEventType>(eventType: K, handler: TypedSessionEventHandler<K>): () => void`                                          | unsubscribe fn                       | Subscribes to one event type.                                                                 |
| `on` (catch-all)        | `on(handler: SessionEventHandler): () => void`                                                                                            | unsubscribe fn                       | Subscribes to all session events.                                                             |
| `getMessages`           | `getMessages(): Promise<SessionEvent[]>`                                                                                                  | complete event history               | Returns the full persisted conversation/event stream.                                         |
| `disconnect`            | `disconnect(): Promise<void>`                                                                                                             | `void`                               | Releases in-memory resources but preserves on-disk session state for resume.                  |
| `destroy`               | `destroy(): Promise<void>`                                                                                                                | `void`                               | Deprecated alias for `disconnect()`.                                                          |
| `[Symbol.asyncDispose]` | `[Symbol.asyncDispose](): Promise<void>`                                                                                                  | `void`                               | Enables `await using`.                                                                        |
| `abort`                 | `abort(): Promise<void>`                                                                                                                  | `void`                               | Cancels the currently processing message without invalidating the session.                    |
| `setModel`              | `setModel(model: string, options?: { reasoningEffort?: ReasoningEffort; modelCapabilities?: ModelCapabilitiesOverride; }): Promise<void>` | `void`                               | Switches model for future turns while preserving history.                                     |
| `log`                   | `log(message: string, options?: { level?: "info" \| "warning" \| "error"; ephemeral?: boolean; }): Promise<void>`                         | `void`                               | Writes timeline messages; docs explicitly say to use this instead of `console.log()`.         |

`MessageOptions` supports `prompt`, `attachments`, optional `mode` (`enqueue` or `immediate`), and per-turn `requestHeaders`.

Sources: `dist/session.d.ts` (sdk-inventory.txt:1520-2003); `dist/types.d.ts` (sdk-inventory.txt:3292-3339); docs/examples.md (sdk-inventory.txt:3829-3894).

## 4. Event types

### 4.1 Harness-relevant event types with inspected payloads

#### Streaming deltas / assistant turn

| Event                       | Payload shape                                                                                                                                                                                                                        | Sources                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| `assistant.turn_start`      | `{ interactionId?, turnId }`                                                                                                                                                                                                         | `dist/generated/session-events.d.ts`: 1633-1668 |
| `assistant.intent`          | `{ intent: string }`                                                                                                                                                                                                                 | `dist/generated/session-events.d.ts`: 1670-1699 |
| `assistant.reasoning`       | `{ content: string, reasoningId: string }`                                                                                                                                                                                           | `dist/generated/session-events.d.ts`: 1700-1735 |
| `assistant.reasoning_delta` | `{ deltaContent: string, reasoningId: string }`                                                                                                                                                                                      | `dist/generated/session-events.d.ts`: 1737-1770 |
| `assistant.streaming_delta` | `{ totalResponseSizeBytes: number }`                                                                                                                                                                                                 | `dist/generated/session-events.d.ts`: 1771-1800 |
| `assistant.message_start`   | `{ messageId: string, phase?: string }`                                                                                                                                                                                              | `dist/generated/session-events.d.ts`: 1927-1960 |
| `assistant.message_delta`   | `{ deltaContent: string, messageId: string, parentToolCallId? }`                                                                                                                                                                     | `dist/generated/session-events.d.ts`: 1961-1999 |
| `assistant.message`         | `{ content, messageId, model?, outputTokens?, toolRequests?, reasoningText?, reasoningOpaque?, encryptedContent?, interactionId?, requestId?, phase?, turnId?, anthropicAdvisorBlocks?, anthropicAdvisorModel?, parentToolCallId? }` | `dist/generated/session-events.d.ts`: 1801-1926 |
| `assistant.turn_end`        | `{ turnId: string }`                                                                                                                                                                                                                 | `dist/generated/session-events.d.ts`: 2000-2032 |
| `assistant.usage`           | usage metrics including `{ model, inputTokens?, outputTokens?, reasoningTokens?, reasoningEffort?, duration?, cost?, cacheReadTokens?, cacheWriteTokens?, ttftMs?, interTokenLatencyMs?, quotaSnapshots?, copilotUsage? }`           | `dist/generated/session-events.d.ts`: 2033-2215 |

#### Tool execution

| Event                           | Payload shape                                                                                                                                                                                                                              | Sources                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| `tool.execution_start`          | `{ toolCallId, toolName, arguments?, mcpServerName?, mcpToolName?, parentToolCallId?, turnId? }`                                                                                                                                           | `dist/generated/session-events.d.ts`: 2323-2382 |
| `tool.execution_partial_result` | `{ partialOutput: string, toolCallId: string }`                                                                                                                                                                                            | `dist/generated/session-events.d.ts`: 2383-2416 |
| `tool.execution_progress`       | `{ progressMessage: string, toolCallId: string }`                                                                                                                                                                                          | `dist/generated/session-events.d.ts`: 2417-2450 |
| `tool.execution_complete`       | `{ success: boolean, toolCallId: string, result?, error?, model?, interactionId?, isUserRequested?, toolTelemetry?, turnId?, parentToolCallId? }`; `result` is `{ content, contents?, detailedContent? }`; `error` is `{ code?, message }` | `dist/generated/session-events.d.ts`: 2451-2665 |

#### Interactivity / permissions / user prompts

| Event                   | Payload shape                                                                                                                                                                                                                                                                                                                                               | Sources                                         |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `permission.requested`  | `{ requestId: string, permissionRequest, promptRequest?, resolvedByHook? }`; `permissionRequest` is a rich union, not just a bare kind                                                                                                                                                                                                                      | `dist/generated/session-events.d.ts`: 3293-3628 |
| `permission.completed`  | `{ requestId: string, result: PermissionResult, toolCallId? }` where result kinds include `approved`, `approved-for-session`, `approved-for-location`, `cancelled`, `denied-by-rules`, `denied-no-approval-rule-and-could-not-request-from-user`, `denied-interactively-by-user`, `denied-by-content-exclusion-policy`, `denied-by-permission-request-hook` | `dist/generated/session-events.d.ts`: 3909-4120 |
| `user_input.requested`  | `{ question: string, choices?, allowFreeform?, requestId: string, toolCallId? }`                                                                                                                                                                                                                                                                            | `dist/generated/session-events.d.ts`: 4121-4166 |
| `user_input.completed`  | `{ answer?, requestId: string, wasFreeform? }`                                                                                                                                                                                                                                                                                                              | `dist/generated/session-events.d.ts`: 4167-4204 |
| `elicitation.requested` | `{ message: string, requestId: string, elicitationSource?, mode?, requestedSchema?, toolCallId?, url? }`                                                                                                                                                                                                                                                    | `dist/generated/session-events.d.ts`: 4205-4257 |
| `elicitation.completed` | `{ requestId: string, action?, content? }`                                                                                                                                                                                                                                                                                                                  | `dist/generated/session-events.d.ts`: 4273-4308 |
| `command.execute`       | `{ commandName, command, args, requestId }`                                                                                                                                                                                                                                                                                                                 | `dist/generated/session-events.d.ts`: 4588-4629 |
| `commands.changed`      | `{ commands: Array<{ name: string, description?: string }> }`                                                                                                                                                                                                                                                                                               | `dist/generated/session-events.d.ts`: 4732-4765 |
| `capabilities.changed`  | `{ ui?: { elicitation?: boolean } }`                                                                                                                                                                                                                                                                                                                        | `dist/generated/session-events.d.ts`: 4766-4801 |

#### Lifecycle / error / compaction

| Event                         | Payload shape                                                                                                                                                                                | Sources                                         |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `session.start`               | session bootstrap metadata including `{ sessionId, startTime, copilotVersion, producer, selectedModel?, reasoningEffort?, remoteSteerable?, context? }`                                      | `dist/generated/session-events.d.ts`: 135-238   |
| `session.resume`              | `{ eventCount, resumeTime, selectedModel?, reasoningEffort?, continuePendingWork?, sessionWasActive?, context? }`                                                                            | `dist/generated/session-events.d.ts`: 239-300   |
| `session.error`               | `{ errorType: string, message: string, errorCode?, eligibleForAutoSwitch?, providerCallId?, stack?, statusCode?, url? }`                                                                     | `dist/generated/session-events.d.ts`: 334-394   |
| `session.idle`                | `{ aborted?: boolean }`                                                                                                                                                                      | `dist/generated/session-events.d.ts`: 395-424   |
| `session.usage_info`          | `{ currentTokens, tokenLimit, messagesLength, conversationTokens?, systemTokens?, toolDefinitionsTokens?, isInitial? }`                                                                      | `dist/generated/session-events.d.ts`: 1116-1169 |
| `session.compaction_start`    | `{ conversationTokens?, systemTokens?, toolDefinitionsTokens? }`                                                                                                                             | `dist/generated/session-events.d.ts`: 1170-1210 |
| `session.compaction_complete` | `{ success, checkpointNumber?, checkpointPath?, summaryContent?, messagesRemoved?, preCompactionTokens?, postCompactionTokens?, tokensRemoved?, compactionTokensUsed?, error?, requestId? }` | `dist/generated/session-events.d.ts`: 1211-1308 |
| `model.call_failure`          | `{ source, model?, statusCode?, durationMs?, apiCallId?, providerCallId?, errorMessage?, initiator? }`                                                                                       | `dist/generated/session-events.d.ts`: 2195-2249 |
| `abort`                       | `{ reason: "user_initiated" \| "remote_command" \| "user_abort" }`                                                                                                                           | `dist/generated/session-events.d.ts`: 2250-2279 |

### 4.2 Full `SessionEvent` union members

The generated `SessionEvent` union is authoritative and currently includes all of these members:

- `StartEvent`, `ResumeEvent`, `RemoteSteerableChangedEvent`, `ErrorEvent`, `IdleEvent`, `TitleChangedEvent`, `ScheduleCreatedEvent`, `ScheduleCancelledEvent`, `InfoEvent`, `WarningEvent`, `ModelChangeEvent`, `ModeChangedEvent`, `PlanChangedEvent`, `WorkspaceFileChangedEvent`, `HandoffEvent`, `TruncationEvent`, `SnapshotRewindEvent`, `ShutdownEvent`, `ContextChangedEvent`, `UsageInfoEvent`, `CompactionStartEvent`, `CompactionCompleteEvent`, `TaskCompleteEvent`, `UserMessageEvent`, `PendingMessagesModifiedEvent`, `AssistantTurnStartEvent`, `AssistantIntentEvent`, `AssistantReasoningEvent`, `AssistantReasoningDeltaEvent`, `AssistantStreamingDeltaEvent`, `AssistantMessageEvent`, `AssistantMessageStartEvent`, `AssistantMessageDeltaEvent`, `AssistantTurnEndEvent`, `AssistantUsageEvent`, `ModelCallFailureEvent`, `AbortEvent`, `ToolUserRequestedEvent`, `ToolExecutionStartEvent`, `ToolExecutionPartialResultEvent`, `ToolExecutionProgressEvent`, `ToolExecutionCompleteEvent`, `SkillInvokedEvent`, `SubagentStartedEvent`, `SubagentCompletedEvent`, `SubagentFailedEvent`, `SubagentSelectedEvent`, `SubagentDeselectedEvent`, `HookStartEvent`, `HookEndEvent`, `SystemMessageEvent`, `SystemNotificationEvent`, `PermissionRequestedEvent`, `PermissionCompletedEvent`, `UserInputRequestedEvent`, `UserInputCompletedEvent`, `ElicitationRequestedEvent`, `ElicitationCompletedEvent`, `SamplingRequestedEvent`, `SamplingCompletedEvent`, `McpOauthRequiredEvent`, `McpOauthCompletedEvent`, `ExternalToolRequestedEvent`, `ExternalToolCompletedEvent`, `CommandQueuedEvent`, `CommandExecuteEvent`, `CommandCompletedEvent`, `AutoModeSwitchRequestedEvent`, `AutoModeSwitchCompletedEvent`, `CommandsChangedEvent`, `CapabilitiesChangedEvent`, `ExitPlanModeRequestedEvent`, `ExitPlanModeCompletedEvent`, `ToolsUpdatedEvent`, `BackgroundTasksChangedEvent`, `SkillsLoadedEvent`, `CustomAgentsUpdatedEvent`, `McpServersLoadedEvent`, `McpServerStatusChangedEvent`, `ExtensionsLoadedEvent`.

For OpenClaw harness work, the inspected payloads above are the important ones; the remaining union members exist in the shipped schema but are not otherwise documented in the README.

Source: `dist/generated/session-events.d.ts`: 5.

## 5. Tool contract

- Public tool shape:
  - `name: string`
  - `description?: string`
  - `parameters?: ZodSchema<TArgs> | Record<string, unknown>`
  - `handler: ToolHandler<TArgs>`
  - `overridesBuiltInTool?: boolean`
  - `skipPermission?: boolean`
- `ToolHandler<TArgs>` signature: `(args: TArgs, invocation: ToolInvocation) => Promise<unknown> | unknown`.
- `ToolInvocation` carries `{ sessionId, toolCallId, toolName, arguments, traceparent?, tracestate? }`.
- Return values:
  - A plain `string`
  - A `ToolResultObject` with `{ textResultForLlm, binaryResultsForLlm?, resultType, error?, sessionLog?, toolTelemetry? }`
  - README/examples also state any JSON-serializable handler return is accepted and auto-wrapped; extension docs add that `undefined` becomes an empty success and throwing becomes a failure/error message.
- `ToolResultType` is `"success" | "failure" | "rejected" | "denied" | "timeout"`.
- Built-in tool override semantics: using a built-in tool name without `overridesBuiltInTool: true` throws.
- Permission bypass semantics: `skipPermission: true` suppresses permission prompts for that custom tool.
- Helper: `defineTool(name, config)` exists purely to preserve type inference from Zod schemas.

Sources: `dist/types.d.ts` (sdk-inventory.txt:2203-2304); README tools section (sdk-inventory.txt:430-485); docs/agent-author.md (sdk-inventory.txt:3708-3745, 3905).

## 6. Permission contract (`onPermissionRequest`)

- Session config requires `onPermissionRequest: PermissionHandler` for both `createSession` and `resumeSession`.
- Declared handler type in `dist/types.d.ts`:
  - `type PermissionHandler = (request: PermissionRequest, invocation: { sessionId: string }) => Promise<PermissionRequestResult> | PermissionRequestResult`
  - `PermissionRequest` is typed only as `{ kind: "shell" | "write" | "mcp" | "read" | "url" | "custom-tool" | "memory" | "hook"; toolCallId?: string }`
  - `PermissionRequestResult` is `PermissionDecisionRequest["result"] | { kind: "no-result" }`
- README claims the runtime supplies richer fields such as `toolName`, `fileName`, and `fullCommandText` to custom handlers; the generated `permission.requested` event schema confirms a richer union exists with per-kind payloads:
  - `shell`: `fullCommandText`, `commands[]`, `possiblePaths[]`, `possibleUrls[]`, `hasWriteFileRedirection`, `intention`, `warning`, `canOfferSessionApproval`
  - `write`: `fileName`, `diff`, `newFileContents?`, `intention`, `canOfferSessionApproval`
  - `read`: `path`, `intention`
  - `mcp`: `serverName`, `toolName`, `toolTitle`, `args?`, `readOnly`
  - `url`: `url`, `intention`
  - `memory`: `action?`, `fact`, `subject?`, `citations?`, `direction?`, `reason?`
  - `custom-tool`: `toolName`, `toolDescription`, `args?`
  - `hook`: `toolName`, `toolArgs?`, `hookMessage?`
  - plus extension-specific `extension-management` and `extension-permission-access` variants in the event schema.
- Result kinds explicitly documented in README: `approved`, `denied-interactively-by-user`, `denied-no-approval-rule-and-could-not-request-from-user`, `denied-by-rules`, `denied-by-content-exclusion-policy`, `no-result`.
- Protocol-v2 caveat: `NO_RESULT_PERMISSION_V2_ERROR = "Permission handlers cannot return 'no-result' when connected to a protocol v2 server."`
- Timeout behavior: not documented in the public types/docs inspected.

Sources: `dist/types.d.ts` (sdk-inventory.txt:2608-2619); README permission handling (sdk-inventory.txt:804-879); `dist/session.d.ts` (sdk-inventory.txt:1529, 1813-1822, 1866-1873); `dist/generated/session-events.d.ts`: 3293-3628, 3909-4120.

## 7. User-input contract (`onUserInputRequest`)

- Session config field: `onUserInputRequest?: UserInputHandler`.
- Declared handler type: `(request: UserInputRequest, invocation: { sessionId: string }) => Promise<UserInputResponse> | UserInputResponse`.
- `UserInputRequest` fields:
  - `question: string`
  - `choices?: string[]`
  - `allowFreeform?: boolean` (default `true`)
- `UserInputResponse` fields:
  - `answer: string`
  - `wasFreeform: boolean`
- README says providing the handler enables the `ask_user` tool.
- The event stream adds request/response correlation fields not present in the handler type:
  - `user_input.requested` includes `requestId` and optional `toolCallId`
  - `user_input.completed` includes `requestId`, optional `answer`, optional `wasFreeform`
- Timeout behavior is not documented in the inspected public surface.

Sources: `dist/types.d.ts` (sdk-inventory.txt:2624-2657, 3091-3095); README user-input section (sdk-inventory.txt:881-905); `dist/generated/session-events.d.ts`: 4121-4204.

## 8. Infinite sessions

- `SessionConfig.infiniteSessions?: InfiniteSessionConfig` controls the feature.
- `InfiniteSessionConfig` fields:
  - `enabled?: boolean` (default `true`)
  - `backgroundCompactionThreshold?: number` (default `0.80`)
  - `bufferExhaustionThreshold?: number` (default `0.95`)
- README says infinite sessions are the default, automatically manage context limits, and persist state to a workspace directory.
- `CopilotSession.workspacePath` is populated only when infinite sessions are enabled.
- The workspace is explicitly documented as containing `checkpoints/`, `plan.md`, and `files/`.
- README example shows the default location as `~/.copilot/session-state/{sessionId}/`.
- Auto-compaction trigger semantics:
  - background compaction starts at the configured `backgroundCompactionThreshold`
  - the session blocks at `bufferExhaustionThreshold` until compaction finishes
  - events emitted: `session.compaction_start` and `session.compaction_complete`
- Compaction result payload includes checkpoint metadata (`checkpointNumber`, `checkpointPath`), summary text (`summaryContent`), before/after token counts, messages removed, tokens removed, and nested `compactionTokensUsed` usage breakdown.

Sources: README infinite sessions section (sdk-inventory.txt:627-660); `dist/session.d.ts` (sdk-inventory.txt:1594-1598); `dist/types.d.ts` (sdk-inventory.txt:2980-3006, 3168-3172); docs/examples.md (sdk-inventory.txt:4330-4346); `dist/generated/session-events.d.ts`: 1170-1308.

## 9. Reasoning effort

- Declared enum/type: `type ReasoningEffort = "low" | "medium" | "high" | "xhigh"`.
- Session config field: `reasoningEffort?: ReasoningEffort`.
- It is only valid when `ModelCapabilities.supports.reasoningEffort` is `true`.
- Discovery/model metadata surface:
  - `ModelInfo.supportedReasoningEfforts?: ReasoningEffort[]`
  - `ModelInfo.defaultReasoningEffort?: ReasoningEffort`
- The README repeatedly points callers to `listModels()` to discover support/defaults rather than assuming a global SDK default.
- Runtime/event reflection:
  - `session.start` / `session.resume` metadata may include `reasoningEffort?: string`
  - `assistant.usage` may also include `reasoningEffort?: string` plus `reasoningTokens?`

Sources: README API docs (sdk-inventory.txt:116-123, 118); `dist/types.d.ts` (sdk-inventory.txt:3003-3006, 3023-3027, 3445-3498); `dist/generated/session-events.d.ts`: 181-183, 281-283, 2115-2121.

## 10. Telemetry

- `TelemetryConfig` shape:
  - `otlpEndpoint?: string`
  - `filePath?: string`
  - `exporterType?: string` (`"otlp-http"` or `"file"` in README)
  - `sourceName?: string`
  - `captureContent?: boolean`
- `CopilotClientOptions.telemetry?: TelemetryConfig` configures CLI-process telemetry by setting environment variables on the spawned CLI.
- `TraceContextProvider` signature: `() => TraceContext | Promise<TraceContext>`.
- `TraceContext` shape: `{ traceparent?: string; tracestate?: string }`.
- `CopilotClientOptions.onGetTraceContext?: TraceContextProvider` is called before `session.create`, `session.resume`, and `session.send` RPCs to inject distributed trace headers.
- Tool handlers receive inbound trace context on `ToolInvocation.traceparent` and `ToolInvocation.tracestate`.
- `dist/telemetry.d.ts` exports `getTraceContext(provider?)` as a helper that returns `{}` when no provider is configured.

Sources: README telemetry section (sdk-inventory.txt:759-803); `dist/types.d.ts` (sdk-inventory.txt:2020-2049, 2137-2167, 2253-2262); `dist/telemetry.d.ts` (sdk-inventory.txt:3560-3574).

## 11. Auth modes

### Client-level auth/config

- `gitHubToken?: string`: explicit GitHub token; takes priority over other auth methods.
- `useLoggedInUser?: boolean`: default `true`, but defaults to `false` when `gitHubToken` is provided.
- `copilotHome?: string`: base directory for Copilot data; only used when the SDK spawns the CLI process.
- `cliUrl?: string`: connect to an existing server instead of spawning the CLI.
- `useLoggedInUser` cannot be used with `cliUrl`; `copilotHome` is ignored with `cliUrl`.
- `getAuthStatus()` returns `{ isAuthenticated, authType?, host?, login?, statusMessage? }`, where `authType` can be `user`, `env`, `gh-cli`, `hmac`, `api-key`, or `token`.

### Session-level auth/BYOK

- `SessionConfig.gitHubToken?: string` is separate from client auth. The docs say it is resolved into a full GitHub identity used for content exclusion, model routing, and quota checks, enabling multitenant sessions.
- `SessionConfig.provider?: ProviderConfig` switches the session to a custom API provider (`openai`, `azure`, or `anthropic`) with `baseUrl`, optional `apiKey`, optional `bearerToken` (takes precedence over `apiKey`), optional `wireApi`, optional `azure.apiVersion`, optional `headers`, `modelId`, `wireModel`, `maxInputTokens`, `maxOutputTokens`.
- README explicitly says `model` is required when using `provider`.
- `enableSessionTelemetry` is always disabled when a custom `provider` is configured.

### Legality / unresolved combinations

- Explicitly documented illegal/mutually exclusive combos:
  - `cliUrl` with `useLoggedInUser`
  - constructor rejects mutually exclusive options such as `cliUrl` with `useStdio` or `cliPath`
- The inspected inventory does **not** explicitly document whether `provider` may be combined with client-level/session-level GitHub auth, so treat that as an open probe.

Sources: README options/custom-provider docs (sdk-inventory.txt:83-94, 116-123, 696-757); `dist/client.d.ts` (sdk-inventory.txt:1121-1123, 1304-1308); `dist/types.d.ts` (sdk-inventory.txt:2051-2167, 3077-3085, 3174-3183, 3223-3288, 3430-3441).

## 12. `copilotHome`

What is explicit in the inventory:

- `copilotHome` is the base directory for Copilot data: "session state, config, etc."; it sets `COPILOT_HOME` on the spawned CLI process.
- If omitted, the CLI defaults to `~/.copilot`.
- `workspacePath` examples place per-session state under `~/.copilot/session-state/{sessionId}/`, with `checkpoints/`, `plan.md`, and `files/` inside that session directory.

What is **not** explicit in the inventory:

- Exact full directory tree under `copilotHome`
- File/lock semantics for multiple `CopilotClient` instances sharing the same `copilotHome`
- Whether same-process sharing is safe under concurrent session creation/resume/delete

OpenClaw implication: the docs are not strong enough to justify shared `copilotHome` pools. Q5's per-agent-pool decision should therefore keep isolated `copilotHome` directories until `spike-app` proves concurrency safety.

Sources: README options/infinite-session docs (sdk-inventory.txt:90-94, 627-660); `dist/types.d.ts` (sdk-inventory.txt:2067-2073); `dist/session.d.ts` (sdk-inventory.txt:1594-1598).

## 13. Replay / resume

- `resumeSession(sessionId, config)` re-attaches to a previous session and keeps conversation history.
- `disconnect()` preserves on-disk session state; `stop()` also preserves it; `deleteSession()` is the destructive operation.
- `getMessages()` returns the complete session event history (`SessionEvent[]`).
- `listSessions(filter?)` returns persisted session metadata including `sessionId`, `startTime`, `modifiedTime`, `summary?`, `isRemote`, `context?`.
- `getSessionMetadata(sessionId)` is a targeted metadata lookup.
- `getLastSessionId()` returns the most recently updated session id.
- Resume-specific semantics in `ResumeSessionConfig`:
  - `disableResume?: boolean` skips emitting `session.resume`
  - `continuePendingWork?: boolean` resumes in-flight permissions/tool work; otherwise pending work is treated as interrupted and permissions are re-emitted as `permission.requested`
- Resume event metadata distinguishes hot vs cold attach:
  - `sessionWasActive?: boolean` means the runtime already had the session in memory
  - `false`/missing means a cold resume reconstructed from persisted event log

Sources: README API docs (sdk-inventory.txt:128-170, 281-287, 867-875); `dist/client.d.ts` (sdk-inventory.txt:1246-1395); `dist/session.d.ts` (sdk-inventory.txt:1892-1944); `dist/types.d.ts` (sdk-inventory.txt:3200-3221, 3409-3417); `dist/generated/session-events.d.ts`: 266-299.

## 14. Models advertised

Explicit model ids mentioned in the inspected inventory:

- `gpt-5`
- `gpt-4`
- `gpt-4.1`
- `claude-sonnet-4.5`
- `claude-sonnet-4.6`
- example BYOK/Ollama model: `deepseek-coder-v2:16b`

Discovery API:

- `client.listModels(): Promise<ModelInfo[]>` is the authoritative discovery path.
- `ModelInfo` carries `id`, `name`, `capabilities`, optional `policy`, optional `billing`, optional `supportedReasoningEfforts`, optional `defaultReasoningEffort`.
- `CopilotClientOptions.onListModels` can override discovery entirely (useful for BYOK mode).

What is **not** in the inspected inventory:

- A static canonical built-in model catalog beyond the handful of examples above.

Sources: README/examples (sdk-inventory.txt:38, 65, 117-118, 633-665, 713-749); `dist/client.d.ts` (sdk-inventory.txt:1310-1320); `dist/types.d.ts` (sdk-inventory.txt:2130-2135, 3483-3498); `dist/session.d.ts` (sdk-inventory.txt:1975-1982).

## 15. Error surface

### Public methods

- Public methods generally document `@throws Error`; the SDK does **not** expose a rich public exception-class hierarchy in the inspected `.d.ts` files.
- `stop()` is unusual: instead of throwing cleanup failures, it resolves to `Error[]`.
- Constructor may throw on mutually exclusive options.
- `createSession()` can throw if auto-start is disabled and the client is disconnected.
- `resumeSession()` can throw if the session does not exist or the client is not connected.
- `sendAndWait()` throws on timeout or connection/disconnect failure.
- `Tool` registration can throw for built-in name collisions unless `overridesBuiltInTool: true` is set.
- README says missing `model` with custom `provider` throws.
- Protocol-v2 permission adapter throws the exported `NO_RESULT_PERMISSION_V2_ERROR` if a handler returns `no-result`.

### Event / telemetry error reporting

- `session.error` carries `{ errorType, message, errorCode?, statusCode?, providerCallId?, stack?, url?, eligibleForAutoSwitch? }`.
- `model.call_failure` carries failed model-call telemetry (`source`, `model?`, `statusCode?`, `durationMs?`, `providerCallId?`, `errorMessage?`).
- `tool.execution_complete.error` carries `{ code?, message }`.
- Hook APIs expose explicit recovery output: `onErrorOccurred` may return `errorHandling: "retry" | "skip" | "abort"` plus `retryCount?`.

### Retryability

- Explicitly retry-like signals in the inspected surface:
  - `session.error.eligibleForAutoSwitch` for rate-limit flows
  - `auto_mode_switch.requested` / `auto_mode_switch.completed` events
  - `onErrorOccurred` hook output `errorHandling: "retry"`
- The SDK does **not** publish a general retryable/non-retryable error enum for all thrown errors. Anything beyond the rate-limit/auto-switch path needs probing.

Sources: README/tool/provider/error docs (sdk-inventory.txt:459-480, 753-757, 1013-1021); `dist/client.d.ts` (sdk-inventory.txt:1119-1123, 1147-1214, 1222-1225, 1252-1255, 1284-1288, 1346-1355); `dist/session.d.ts` (sdk-inventory.txt:1529, 1645-1650, 1813-1822, 1866-1889); `dist/generated/session-events.d.ts`: 361-393, 2195-2279, 2478-2529; `dist/types.d.ts` (sdk-inventory.txt:2822-2871).

## 16. Open SDK questions

Concrete gaps to answer in `spike-app` before landing a real harness:

1. **Permission handler typing mismatch:** README says `onPermissionRequest` receives rich per-kind fields (`toolName`, `fileName`, `fullCommandText`), but `dist/types.d.ts` types `PermissionRequest` as just `{ kind, toolCallId? }`. What object shape does runtime actually deliver to JS/TS handlers?
2. **Permission timeouts:** what happens if `onPermissionRequest` never resolves? Is there a default timeout, cancellation, or session hang?
3. **User-input timeouts/cancellation:** same question for `onUserInputRequest`.
4. **`copilotHome` concurrency:** can multiple `CopilotClient` instances in one process safely share one `copilotHome`, or are there lock/race hazards around `session-state/` and config files?
5. **Exact `copilotHome` layout:** beyond `session-state/<id>/{checkpoints,plan.md,files}`, what other top-level files/directories are created, and which are session-global versus client-global?
6. **Provider/auth combination matrix:** what combinations of client-level `gitHubToken`, session-level `gitHubToken`, `useLoggedInUser`, and `provider` are accepted or rejected in practice?
7. **Resume behavior for encrypted reasoning fields:** `assistant.message` notes `encryptedContent`/`reasoningOpaque` are session-bound and stripped on resume. What survives after process restart versus live reconnect?
8. **Event coverage needed by OpenClaw:** do we need additional exact-string handling for non-core events like `ToolsUpdatedEvent`, `SkillsLoadedEvent`, `McpServersLoadedEvent`, `ExtensionsLoadedEvent`, or is the harness safe to ignore them?
9. **Cold-resume pending work:** with `continuePendingWork: true`, what concrete low-level RPCs are required to finish previously pending external tool calls in an SDK-only consumer?
10. **Model discovery under BYOK:** when `provider` is set without `onListModels`, what does `listModels()` return, if anything?

Sources: `dist/types.d.ts` (sdk-inventory.txt:2608-2619, 2624-2657, 3203-3221, 3174-3183, 3226-3288); README permission/user-input/provider docs (sdk-inventory.txt:823-845, 883-905, 696-757); `dist/generated/session-events.d.ts`: 266-299, 1828-1889, 3293-3628.
