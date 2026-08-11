# Mechanical session ownership sweep

Temporary review artifact for PR #114388 round 27. Drop this file before landing.

Scope command: `git diff origin/main...HEAD --name-only -- 'src/**/*.ts' | grep -v test`

Files enumerated: 246. The scan mechanically records owner-ladder calls, session-store target/key resolvers, session-reference/session-id probes, agent/key parsers, and direct bare-key normalization/sentinel expressions. Every scoped file has at least one row; deleted branch paths are read from origin/main and marked explicitly.

| file:line | expression | disposition |
| --- | --- | --- |
| src/acp/runtime/session-meta-store.ts:34 | `const normalized = params.sessionKey.trim();` | not-owner-relevant |
| src/acp/runtime/session-meta-store.ts:71 | `const parsed = parseAgentSessionKey(params.sessionKey);` | not-owner-relevant |
| src/acp/runtime/session-meta-store.ts:79 | `const persistedStoreOwner = resolvePersistedSessionStoreOwnerForKey(cfg, params.sessionKey);` | ladder-ok |
| src/acp/runtime/session-meta-store.ts:103 | `tryResolveLegacyCompatibilityAgentId(cfg);` | ladder-ok |
| src/acp/runtime/session-meta.ts:181 | `const sessionKey = params.sessionKey.trim();` | not-owner-relevant |
| src/acp/runtime/session-meta.ts:217 | `const sessionKey = params.sessionKey.trim();` | not-owner-relevant |
| src/acp/runtime/session-meta.ts:248 | `const sessionKey = item.sessionKey.trim();` | not-owner-relevant |
| src/acp/runtime/session-meta.ts:319 | `const sessionKey = params.sessionKey.trim();` | not-owner-relevant |
| src/acp/runtime/session-meta.ts:346 | `const sessionKey = params.sessionKey.trim();` | not-owner-relevant |
| src/acp/runtime/session-meta.ts:447 | `const sessionKey = params.sessionKey.trim();` | not-owner-relevant |
| src/acp/runtime/session-meta.ts:557 | `Array.from(params.sessionKeys, (sessionKey) => sessionKey?.trim()).filter(` | not-owner-relevant |
| src/acp/runtime/session-meta.ts:600 | `const sessionKey = params.sessionKey.trim();` | not-owner-relevant |
| src/agents/acp-spawn-heartbeat.ts:19 | `if (!params.sessionKey?.trim()) {` | not-owner-relevant |
| src/agents/acp-spawn-heartbeat.ts:22 | `const requesterAgentId = resolveSessionAgentIds({` | ladder-ok |
| src/agents/acp-spawn-heartbeat.ts:91 | `const parentEntry = loadSessionEntryReadOnly({` | not-owner-relevant |
| src/agents/acp-spawn.ts:246 | `ctx.requesterAgentIdOverride ?? parseAgentSessionKey(requesterInternalKey)?.agentId,` | not-owner-relevant |
| src/agents/acp-spawn.ts:457 | `? resolveAgentIdFromSessionKey(parentSessionKey, requesterAgentId)` | not-owner-relevant |
| src/agents/acp-spawn.ts:464 | `loadSessionEntryReadOnly({` | not-owner-relevant |
| src/agents/agent-create.ts:1 | `none` | not-owner-relevant |
| src/agents/agent-scope-config.ts:212 | `export function tryResolveLegacyCompatibilityAgentId(cfg: OpenClawConfig): string \| undefined {` | not-owner-relevant |
| src/agents/agent-scope-config.ts:328 | `return tryResolveLegacyCompatibilityAgentId(cfg);` | not-owner-relevant |
| src/agents/agent-scope-config.ts:393 | `tryResolveLegacyCompatibilityAgentId(cfg) ?? resolveDefaultAgentId(cfg),` | not-owner-relevant |
| src/agents/agent-scope.ts:308 | `export function resolveSessionAgentIds(params: {` | ladder-ok |
| src/agents/agent-scope.ts:321 | `const sessionKey = params.sessionKey?.trim();` | not-owner-relevant |
| src/agents/agent-scope.ts:322 | `const normalizedSessionKey = sessionKey ? normalizeLowercaseStringOrEmpty(sessionKey) : undefined;` | not-owner-relevant |
| src/agents/agent-scope.ts:323 | `const parsed = normalizedSessionKey ? parseAgentSessionKey(normalizedSessionKey) : null;` | not-owner-relevant |
| src/agents/agent-scope.ts:326 | `const persistedStoreOwner = resolvePersistedSessionStoreOwnerForKey(cfg, sessionKey);` | ladder-ok |
| src/agents/agent-scope.ts:351 | `const compatibilityAgentId = tryResolveLegacyCompatibilityAgentId(cfg);` | ladder-ok |
| src/agents/agent-scope.ts:365 | `export function resolveSessionAgentId(params: {` | ladder-ok |
| src/agents/agent-scope.ts:371 | `return resolveSessionAgentIds(params).sessionAgentId;` | ladder-ok |
| src/agents/agent-scope.ts:561 | `? resolveSessionAgentIds({` | ladder-ok |
| src/agents/agent-tools.policy.ts:222 | `const raw = (sessionKey ?? "").trim();` | not-owner-relevant |
| src/agents/agent-tools.policy.ts:381 | `? resolveSessionAgentIds({` | ladder-ok |
| src/agents/agent-tools.policy.ts:386 | `: (explicitAgentId ?? parseAgentSessionKey(params.sessionKey)?.agentId);` | not-owner-relevant |
| src/agents/bash-tools.exec-approval-followup.ts:132 | `const sessionKey = normalizeOptionalString(params.sessionKey);` | not-owner-relevant |
| src/agents/bash-tools.exec-approval-followup.ts:139 | `agentId: params.agentId ?? resolveAgentIdFromSessionKey(sessionKey),` | not-owner-relevant |
| src/agents/bash-tools.exec-approval-followup.ts:142 | `loadSessionEntryReadOnly({` | not-owner-relevant |
| src/agents/bash-tools.exec-approval-followup.ts:426 | `const sessionKey = params.sessionKey?.trim();` | not-owner-relevant |
| src/agents/bash-tools.exec-host-gateway.ts:1 | `none` | not-owner-relevant |
| src/agents/bash-tools.exec-host-node.ts:1 | `none` | not-owner-relevant |
| src/agents/bash-tools.exec-host-shared.ts:1 | `none` | not-owner-relevant |
| src/agents/cli-runner.ts:1090 | `const sessionKey = params.sessionKey?.trim() \|\| params.sessionId;` | not-owner-relevant |
| src/agents/cli-runner.ts:1093 | `const targetStoreOwner = resolvePersistedSessionStoreOwnerForTarget({` | ladder-ok |
| src/agents/cli-runner.ts:1101 | `!parseAgentSessionKey(sessionKey)?.agentId &&` | not-owner-relevant |
| src/agents/cli-runner.ts:1107 | `resolveSessionAgentId({` | ladder-ok |
| src/agents/cli-runner/claude-live-session.ts:995 | `? resolveSessionAgentIds({` | ladder-ok |
| src/agents/cli-runner/claude-live-session.ts:1001 | `resolveAgentIdFromSessionKey(context.params.sessionKey, LEGACY_IMPLICIT_AGENT_ID));` | not-owner-relevant |
| src/agents/command/prepare.ts:104 | `isUnscopedSessionKeySentinel(params.rawExplicitSessionKey) &&` | not-owner-relevant |
| src/agents/command/prepare.ts:111 | `classifySessionKeyShape(params.rawExplicitSessionKey) === "legacy_or_alias" &&` | not-owner-relevant |
| src/agents/command/prepare.ts:113 | `? resolveSessionAgentIds({` | ladder-ok |
| src/agents/command/prepare.ts:119 | `return scopeLegacySessionKeyToAgent({` | not-owner-relevant |
| src/agents/command/prepare.ts:132 | `const rawExplicitSessionKey = opts.sessionKey?.trim();` | not-owner-relevant |
| src/agents/command/prepare.ts:136 | `!rawExplicitSessionKey && !requestedSessionId && classifySessionKeyShape(rawTo) === "agent"` | not-owner-relevant |
| src/agents/command/prepare.ts:182 | `classifySessionKeyShape(rawExplicitSessionKey) === "legacy_or_alias" &&` | not-owner-relevant |
| src/agents/command/prepare.ts:183 | `!isUnscopedSessionKeySentinel(rawExplicitSessionKey),` | not-owner-relevant |
| src/agents/command/prepare.ts:193 | `if (explicitSessionKey && classifySessionKeyShape(explicitSessionKey) === "malformed_agent") {` | not-owner-relevant |
| src/agents/command/prepare.ts:201 | `classifySessionKeyShape(explicitSessionKey) === "agent"` | not-owner-relevant |
| src/agents/command/prepare.ts:203 | `const sessionAgentId = resolveAgentIdFromSessionKey(explicitSessionKey);` | not-owner-relevant |
| src/agents/command/prepare.ts:299 | `resolveSessionAgentId({ sessionKey: sessionKey ?? explicitSessionKey, config: cfg });` | ladder-ok |
| src/agents/command/session.ts:186 | `const compatibilityAgentId = tryResolveLegacyCompatibilityAgentId(opts.cfg);` | ladder-ok |
| src/agents/command/session.ts:187 | `const persistedStoreOwner = resolvePersistedSessionStoreOwner(opts.cfg);` | ladder-ok |
| src/agents/command/session.ts:218 | `const parsedAgentId = parseAgentSessionKey(candidateKey)?.agentId;` | not-owner-relevant |
| src/agents/command/session.ts:223 | `const isLegacyUnscopedKey = classifySessionKeyShape(candidateKey) === "legacy_or_alias";` | not-owner-relevant |
| src/agents/command/session.ts:303 | `const persistedStoreOwner = resolvePersistedSessionStoreOwner(opts.cfg);` | ladder-ok |
| src/agents/command/session.ts:307 | `tryResolveLegacyCompatibilityAgentId(opts.cfg) ??` | ladder-ok |
| src/agents/command/session.ts:324 | `const scopedAgentId = parseAgentSessionKey(sessionKey)?.agentId;` | not-owner-relevant |
| src/agents/command/session.ts:328 | `const persistedRowOwner = resolvePersistedSessionStoreOwnerForKey(opts.cfg, sessionKey);` | ladder-ok |
| src/agents/command/session.ts:333 | `: (requestedAgentId ?? tryResolveLegacyCompatibilityAgentId(opts.cfg));` | ladder-ok |
| src/agents/command/session.ts:355 | `const persistedRowOwner = resolvePersistedSessionStoreOwnerForKey(opts.cfg, sessionKey);` | ladder-ok |
| src/agents/command/session.ts:394 | `const requestedSessionKey = opts.sessionKey?.trim() \|\| undefined;` | not-owner-relevant |
| src/agents/command/session.ts:396 | `!requestedSessionKey && !requestedSessionId && classifySessionKeyShape(opts.to) === "agent"` | not-owner-relevant |
| src/agents/command/session.ts:408 | `const scopedSessionAgentId = parseAgentSessionKey(explicitSessionKey)?.agentId;` | not-owner-relevant |
| src/agents/command/session.ts:409 | `const explicitKeyStoreOwner = resolvePersistedSessionStoreOwnerForKey(` | ladder-ok |
| src/agents/command/session.ts:433 | `tryResolveLegacyCompatibilityAgentId(opts.cfg);` | ladder-ok |
| src/agents/command/session.ts:437 | `classifySessionKeyShape(explicitSessionKey) === "legacy_or_alias" &&` | not-owner-relevant |
| src/agents/command/session.ts:458 | `: isUnscopedSessionKeySentinel(explicitSessionKey)` | not-owner-relevant |
| src/agents/command/session.ts:460 | `: resolveAgentIdFromSessionKey(explicitSessionKey, defaultAgentId)` | not-owner-relevant |
| src/agents/command/session.ts:532 | `tryResolveLegacyCompatibilityAgentId(opts.cfg) ??` | ladder-ok |
| src/agents/command/session.ts:553 | `export function resolveExistingSessionKeyForRequest(opts: {` | fixed-now |
| src/agents/command/session.ts:563 | `export function resolveSessionKeyForRequest(opts: {` | fixed-now |
| src/agents/command/session.ts:589 | `} = resolveSessionKeyForRequest({` | not-owner-relevant |
| src/agents/command/session.ts:603 | `parseAgentSessionKey(sessionKey)?.agentId ??` | not-owner-relevant |
| src/agents/command/session.ts:604 | `tryResolveLegacyCompatibilityAgentId(opts.cfg) ??` | ladder-ok |
| src/agents/embedded-agent-runner/model.ts:1 | `none` | not-owner-relevant |
| src/agents/embedded-agent-runner/run/attempt-history-prepare.ts:1 | `none` | not-owner-relevant |
| src/agents/embedded-agent-runner/run/attempt-transcript-helpers.ts:107 | `const entry = loadSessionEntry({` | not-owner-relevant |
| src/agents/embedded-agent-runner/run/session-bootstrap.ts:54 | `const candidateKeyAgentId = parseAgentSessionKey(candidateSessionKey)?.agentId;` | not-owner-relevant |
| src/agents/embedded-agent-runner/run/session-bootstrap.ts:57 | `? loadSessionEntry({` | not-owner-relevant |
| src/agents/embedded-agent-runner/run/session-bootstrap.ts:100 | `const targetStoreOwner = resolvePersistedSessionStoreOwnerForTarget({` | ladder-ok |
| src/agents/embedded-agent-runner/run/session-bootstrap.ts:108 | `!parseAgentSessionKey(sessionKey)?.agentId &&` | not-owner-relevant |
| src/agents/embedded-agent-runner/run/session-bootstrap.ts:114 | `resolveSessionAgentId({` | ladder-ok |
| src/agents/embedded-agent-runner/run/session-bootstrap.ts:154 | `const agentId = resolveSessionAgentId({` | ladder-ok |
| src/agents/embedded-agent-runner/run/session-bootstrap.ts:212 | `: resolveSessionKeyForRequest({` | not-owner-relevant |
| src/agents/embedded-agent-runner/run/session-bootstrap.ts:236 | `const sessionKey = normalizeOptionalString(params.sessionKey);` | not-owner-relevant |
| src/agents/embedded-agent-runner/run/session-bootstrap.ts:242 | `const targetStoreOwner = resolvePersistedSessionStoreOwnerForTarget({` | ladder-ok |
| src/agents/embedded-agent-runner/run/session-bootstrap.ts:250 | `!parseAgentSessionKey(sessionKey)?.agentId &&` | not-owner-relevant |
| src/agents/embedded-agent-runner/run/session-bootstrap.ts:255 | `: resolveSessionAgentId({` | ladder-ok |
| src/agents/embedded-agent-runner/run/session-bootstrap.ts:263 | `const durableEntry = loadSessionEntry({` | not-owner-relevant |
| src/agents/embedded-agent-runner/runs.ts:138 | `const normalizedSessionKey = sessionKey?.trim();` | not-owner-relevant |
| src/agents/embedded-agent-runner/runs.ts:146 | `const normalizedSessionKey = sessionKey?.trim();` | not-owner-relevant |
| src/agents/embedded-agent-runner/runs.ts:198 | `const normalizedSessionKey = abandonedRun.sessionKey?.trim();` | not-owner-relevant |
| src/agents/embedded-agent-runner/runs.ts:215 | `const normalizedSessionKey = sessionKey?.trim();` | not-owner-relevant |
| src/agents/embedded-agent-runner/runs.ts:270 | `...(params.sessionKey?.trim() ? { sessionKey: params.sessionKey.trim() } : {}),` | not-owner-relevant |
| src/agents/embedded-agent-runner/runs.ts:306 | `const normalizedSessionKey = params.sessionKey?.trim();` | not-owner-relevant |
| src/agents/embedded-agent-runner/runs.ts:740 | `const normalizedSessionKey = sessionKey.trim();` | not-owner-relevant |
| src/agents/embedded-agent-runner/runs.ts:981 | `const agentId = resolveSessionAgentId({ config: cfg, sessionKey });` | ladder-ok |
| src/agents/embedded-agent-runner/runs.ts:983 | `const entry = loadSessionEntry({ agentId, sessionKey, storePath });` | not-owner-relevant |
| src/agents/harness/compaction.ts:85 | `const agentIds = resolveSessionAgentIds({` | ladder-ok |
| src/agents/harness/compaction.ts:189 | `agentId: parseAgentSessionKey(params.sessionKey) ? undefined : params.agentId,` | not-owner-relevant |
| src/agents/harness/compaction.ts:394 | `params.sandboxSessionKey && parseAgentSessionKey(params.sandboxSessionKey)` | not-owner-relevant |
| src/agents/harness/context-engine-lifecycle.ts:217 | `agentId: params.agentId ?? resolveAgentIdFromSessionKey(params.sessionKey),` | not-owner-relevant |
| src/agents/harness/support.ts:98 | `params.config && (params.agentId?.trim() \|\| params.sessionKey?.trim())` | not-owner-relevant |
| src/agents/harness/support.ts:99 | `? resolveSessionAgentIds({` | ladder-ok |
| src/agents/heartbeat-system-prompt.ts:30 | `tryResolveLegacyCompatibilityAgentId(config ?? {})` | not-owner-relevant |
| src/agents/identity-avatar.ts:46 | `if (normalizedAgentId === tryResolveLegacyCompatibilityAgentId(cfg) && fromUiConfig) {` | not-owner-relevant |
| src/agents/legacy-inherited-auth-dir.ts:12 | `tryResolveLegacyCompatibilityAgentId(config) ??` | not-owner-relevant |
| src/agents/local-model-lean.ts:68 | `return resolveSessionAgentIds({` | ladder-ok |
| src/agents/local-model-lean.ts:74 | `const parsedSessionAgentId = parseAgentSessionKey(params.sessionKey)?.agentId;` | not-owner-relevant |
| src/agents/main-session-restart-dispatch.ts:1 | `none` | not-owner-relevant |
| src/agents/main-session-restart-recovery-failure.ts:104 | `const current = loadSessionEntry({` | not-owner-relevant |
| src/agents/main-session-restart-recovery-notice.ts:1 | `none` | not-owner-relevant |
| src/agents/main-session-restart-recovery-store.ts:79 | `const parsed = parseAgentSessionKey(params.sessionKey);` | not-owner-relevant |
| src/agents/main-session-restart-recovery-store.ts:83 | `const target = resolveGatewaySessionStoreTarget({` | ladder-ok |
| src/agents/model-runtime-policy.ts:156 | `const hasSessionScope = Boolean(params.agentId?.trim() \|\| params.sessionKey?.trim());` | not-owner-relevant |
| src/agents/model-runtime-policy.ts:158 | `? resolveSessionAgentIds({` | ladder-ok |
| src/agents/model-runtime-policy.ts:163 | `: tryResolveLegacyCompatibilityAgentId(params.config);` | not-owner-relevant |
| src/agents/openai-routing.ts:54 | `params.config && (params.agentId?.trim() \|\| params.sessionKey?.trim())` | not-owner-relevant |
| src/agents/openai-routing.ts:55 | `? resolveSessionAgentIds({` | ladder-ok |
| src/agents/openclaw-tools.ts:236 | `const { sessionAgentId } = resolveSessionAgentIds({` | ladder-ok |
| src/agents/prepared-model-catalog.ts:88 | `? (tryResolveLegacyCompatibilityAgentId(config) ?? resolveDefaultAgentId(config))` | not-owner-relevant |
| src/agents/prepared-model-registry.ts:126 | `tryResolveLegacyCompatibilityAgentId(config) ??` | not-owner-relevant |
| src/agents/prepared-model-runtime.owner.ts:352 | `const compatibilityAgentId = tryResolveLegacyCompatibilityAgentId(config);` | not-owner-relevant |
| src/agents/run-session-target.ts:135 | `const preliminaryCompatibilityKeyAgentId = parseAgentSessionKey(compatibilitySessionKey)?.agentId;` | not-owner-relevant |
| src/agents/run-session-target.ts:146 | `const targetStoreOwner = resolvePersistedSessionStoreOwnerForTarget({` | ladder-ok |
| src/agents/run-session-target.ts:154 | `!parseAgentSessionKey(preliminarySessionKey)?.agentId &&` | not-owner-relevant |
| src/agents/run-session-target.ts:169 | `: resolveExistingSessionKeyForRequest({ cfg: config, sessionId, clone: false })` | fixed-now |
| src/agents/run-session-target.ts:175 | `resolveSessionAgentId({` | ladder-ok |
| src/agents/run-session-target.ts:199 | `? toAgentStoreSessionKey({ agentId: lookupAgentId, requestKey: sessionId })` | not-owner-relevant |
| src/agents/run-session-target.ts:210 | `const suppliedKeyAgentId = parseAgentSessionKey(suppliedSessionKey)?.agentId;` | not-owner-relevant |
| src/agents/run-session-target.ts:211 | `const targetKeyAgentId = parseAgentSessionKey(targetSessionKey)?.agentId;` | not-owner-relevant |
| src/agents/run-session-target.ts:212 | `const compatibilityKeyAgentId = parseAgentSessionKey(compatibilitySessionKey)?.agentId;` | not-owner-relevant |
| src/agents/run-session-target.ts:254 | `resolveSessionAgentId({` | ladder-ok |
| src/agents/run-session-target.ts:309 | `sessionKey: normalizeOptionalString(target.sessionKey) ?? params.sessionKey,` | not-owner-relevant |
| src/agents/run-wait.ts:1 | `none` | not-owner-relevant |
| src/agents/sandbox/context.ts:146 | `const rawSessionKey = params.sessionKey?.trim();` | not-owner-relevant |
| src/agents/sandbox/shared.ts:67 | `const trimmed = sessionKey.trim() \|\| "main";` | not-owner-relevant |
| src/agents/sandbox/shared.ts:79 | `: resolveAgentIdFromSessionKey(trimmed);` | not-owner-relevant |
| src/agents/sandbox/shared.ts:93 | `return resolveAgentIdFromSessionKey(trimmed);` | not-owner-relevant |
| src/agents/session-agent-binding.ts:21 | `return resolveSessionAgentId({` | ladder-ok |
| src/agents/subagent-announce-delivery.ts:99 | `const parsedAgentId = parseAgentSessionKey(requesterSessionKey)?.agentId;` | not-owner-relevant |
| src/agents/subagent-announce-delivery.ts:103 | `const persistedStoreOwner = resolvePersistedSessionStoreOwnerForKey(cfg, requesterSessionKey);` | ladder-ok |
| src/agents/subagent-announce-delivery.ts:120 | `tryResolveLegacyCompatibilityAgentId(cfg)` | ladder-ok |
| src/agents/subagent-announce-delivery.ts:158 | `const activeSessionId = parseAgentSessionKey(requesterSessionKey)` | not-owner-relevant |
| src/agents/subagent-announce-delivery.ts:633 | `const entry = subagentAnnounceDeliveryDeps.loadSessionEntry({` | not-owner-relevant |
| src/agents/subagent-announce-delivery.ts:649 | `return subagentAnnounceDeliveryDeps.loadSessionEntry({` | not-owner-relevant |
| src/agents/subagent-depth.ts:51 | `if (rawKey === "unknown") {` | not-owner-relevant |
| src/agents/subagent-depth.ts:54 | `if (parseAgentSessionKey(rawKey)) {` | not-owner-relevant |
| src/agents/subagent-depth.ts:57 | `const agentId = resolveSessionAgentId({ sessionKey: rawKey, config: cfg });` | ladder-ok |
| src/agents/subagent-depth.ts:106 | `const agentId = parseAgentSessionKey(key)?.agentId;` | not-owner-relevant |
| src/agents/subagent-depth.ts:138 | `const raw = (sessionKey ?? "").trim();` | not-owner-relevant |
| src/agents/subagent-requester-store-key.ts:23 | `const agentId = resolveSessionAgentId({ sessionKey: raw, config: cfg });` | ladder-ok |
| src/agents/tools/agent-step.ts:1 | `none` | not-owner-relevant |
| src/agents/tools/agents-list-tool.ts:103 | `const requesterAgentId = resolveSessionAgentIds({` | ladder-ok |
| src/agents/tools/embedded-gateway-stub.ts:261 | `? rt.resolveStoredSessionKeyForAgentStore({ cfg, agentId: requestedAgentId, sessionKey })` | ladder-ok |
| src/agents/tools/embedded-gateway-stub.ts:262 | `: rt.resolveSessionStoreKey({ cfg, sessionKey }),` | ladder-ok |
| src/agents/tools/embedded-gateway-stub.ts:266 | `rt.resolveSessionAgentId({` | ladder-ok |
| src/agents/tools/embedded-gateway-stub.ts:281 | `const result = rt.searchSessionTranscripts({` | not-owner-relevant |
| src/agents/tools/embedded-gateway-stub.ts:310 | `const parsedAgentId = parseAgentSessionKey(sessionKey)?.agentId;` | not-owner-relevant |
| src/agents/tools/embedded-gateway-stub.ts:316 | `const { cfg, storePath, entry } = rt.loadSessionEntry(sessionKey, sessionLoadOptions);` | not-owner-relevant |
| src/agents/tools/embedded-gateway-stub.ts:318 | `const sessionAgentId = rt.resolveSessionAgentId({` | ladder-ok |
| src/agents/tools/scoped-session-access.ts:17 | `const persistedOwner = resolvePersistedSessionStoreOwnerForKey(` | ladder-ok |
| src/agents/tools/scoped-session-access.ts:23 | `!parseAgentSessionKey(params.targetSessionKey)?.agentId &&` | not-owner-relevant |
| src/agents/tools/scoped-session-access.ts:26 | `return resolveSessionAgentIds({` | ladder-ok |
| src/agents/tools/scoped-session-access.ts:45 | `const { sessionAgentId: agentId } = resolveSessionAgentIds({` | ladder-ok |
| src/agents/tools/session-status-tool.ts:326 | `const parsed = parseAgentSessionKey(sessionKey);` | not-owner-relevant |
| src/agents/tools/session-status-tool.ts:583 | `const requesterAgentId = resolveSessionAgentIds({` | ladder-ok |
| src/agents/tools/session-status-tool.ts:592 | `const trimmed = sessionKey.trim();` | not-owner-relevant |
| src/agents/tools/session-status-tool.ts:596 | `const requesterParsed = parseAgentSessionKey(visibilityRequesterKey);` | not-owner-relevant |
| src/agents/tools/session-status-tool.ts:598 | `resolveAgentIdFromSessionKey(visibilityRequesterKey, configuredDefaultAgentId) ===` | not-owner-relevant |
| src/agents/tools/session-status-tool.ts:610 | `const trimmed = sessionKey.trim();` | not-owner-relevant |
| src/agents/tools/session-status-tool.ts:615 | `const parsed = parseAgentSessionKey(trimmed);` | not-owner-relevant |
| src/agents/tools/session-status-tool.ts:641 | `requestedKeyParam === undefined && Boolean(opts?.runSessionKey?.trim());` | not-owner-relevant |
| src/agents/tools/session-status-tool.ts:648 | `let requestedKeyInput = requestedKeyRaw?.trim() ?? "";` | not-owner-relevant |
| src/agents/tools/session-status-tool.ts:653 | `requestedKeyInput === "current" \|\|` | not-owner-relevant |
| src/agents/tools/session-status-tool.ts:665 | `if (requestedKeyInput === "current" && (opts?.runSessionKey \|\| opts?.sandboxed === true)) {` | not-owner-relevant |
| src/agents/tools/session-status-tool.ts:667 | `requestedKeyInput = requestedKeyRaw?.trim() ?? "";` | not-owner-relevant |
| src/agents/tools/session-status-tool.ts:676 | `requestedKeyInput = requestedKeyRaw?.trim() ?? "";` | not-owner-relevant |
| src/agents/tools/session-status-tool.ts:701 | `const requestedAgentId = resolveAgentIdFromSessionKey(` | not-owner-relevant |
| src/agents/tools/session-status-tool.ts:715 | `!isSemanticCurrentRequest && shouldResolveSessionIdInput(requestedKeyInput);` | not-owner-relevant |
| src/agents/tools/session-status-tool.ts:746 | `(requestedKeyInput === "current" \|\| shouldResolveSessionIdInput(requestedKeyInput))` | not-owner-relevant |
| src/agents/tools/session-status-tool.ts:748 | `const resolvedSession = await resolveSessionReference({` | not-owner-relevant |
| src/agents/tools/session-status-tool.ts:750 | `...(requestedKeyInput === "current" ? { agentId: requesterAgentId } : {}),` | not-owner-relevant |
| src/agents/tools/session-status-tool.ts:757 | `const visibleSession = await resolveVisibleSessionReference({` | not-owner-relevant |
| src/agents/tools/session-status-tool.ts:779 | `requestedKeyInput = requestedKeyRaw.trim();` | not-owner-relevant |
| src/agents/tools/session-status-tool.ts:800 | `if (!resolved && requestedKeyInput === "current" && effectiveRequesterLookupKey) {` | not-owner-relevant |
| src/agents/tools/session-status-tool.ts:812 | `if (!resolved && requestedKeyInput === "current") {` | not-owner-relevant |
| src/agents/tools/session-status-tool.ts:865 | `const kind = shouldResolveSessionIdInput(requestedKeyInput) ? "sessionId" : "sessionKey";` | not-owner-relevant |
| src/agents/tools/session-status-tool.ts:874 | `(requestedKeyInput === "current" \|\| resolved.key === requestedKeyInput));` | not-owner-relevant |
| src/agents/tools/sessions-history-tool.ts:413 | `const requesterAgentId = resolveSessionAgentIds({` | ladder-ok |
| src/agents/tools/sessions-history-tool.ts:418 | `const normalizedInputKey = sessionKeyParam.trim();` | not-owner-relevant |
| src/agents/tools/sessions-history-tool.ts:426 | `shouldResolveSessionIdInput(sessionKeyParam) && !isConfiguredMainAlias` | not-owner-relevant |
| src/agents/tools/sessions-history-tool.ts:428 | `: resolvePersistedSessionStoreOwnerForKey(cfg, sessionKeyParam);` | ladder-ok |
| src/agents/tools/sessions-history-tool.ts:429 | `const resolvedSession = await resolveSessionReference({` | not-owner-relevant |
| src/agents/tools/sessions-history-tool.ts:444 | `const visibleSession = await resolveVisibleSessionReference({` | not-owner-relevant |
| src/agents/tools/sessions-history-tool.ts:481 | `targetAgentId !== requesterAgentId && !parseAgentSessionKey(resolvedKey)` | not-owner-relevant |
| src/agents/tools/sessions-list-tool.ts:165 | `const requesterAgentId = resolveSessionAgentIds({` | ladder-ok |
| src/agents/tools/sessions-resolution.ts:152 | `export function shouldResolveSessionIdInput(value: string): boolean {` | not-owner-relevant |
| src/agents/tools/sessions-resolution.ts:154 | `return looksLikeSessionId(value) \|\| !looksLikeSessionKey(value);` | not-owner-relevant |
| src/agents/tools/sessions-resolution.ts:387 | `if (!(params.forceSessionIdLookup \|\| shouldResolveSessionIdInput(params.raw))) {` | not-owner-relevant |
| src/agents/tools/sessions-resolution.ts:412 | `export async function resolveSessionReference(params: {` | not-owner-relevant |
| src/agents/tools/sessions-resolution.ts:424 | `}) ?? params.sessionKey.trim();` | not-owner-relevant |
| src/agents/tools/sessions-resolution.ts:444 | `if (shouldResolveSessionIdInput(raw)) {` | not-owner-relevant |
| src/agents/tools/sessions-resolution.ts:473 | `export async function resolveVisibleSessionReference(params: {` | not-owner-relevant |
| src/agents/tools/sessions-send-tool.a2a.ts:1 | `none` | not-owner-relevant |
| src/agents/tools/sessions-send-tool.ts:182 | `return toAgentStoreSessionKey({` | not-owner-relevant |
| src/agents/tools/sessions-send-tool.ts:195 | `if (isUnscopedSessionKeySentinel(params.sessionKey)) {` | not-owner-relevant |
| src/agents/tools/sessions-send-tool.ts:199 | `params.agentId ?? resolveSessionAgentId({ config: params.cfg, sessionKey: params.sessionKey });` | ladder-ok |
| src/agents/tools/sessions-send-tool.ts:231 | `params.agentId ?? resolveSessionAgentId({ config: params.cfg, sessionKey: params.sessionKey });` | ladder-ok |
| src/agents/tools/sessions-send-tool.ts:305 | `const parsed = parseAgentSessionKey(normalizeOptionalString(sessionKey));` | not-owner-relevant |
| src/agents/tools/sessions-send-tool.ts:314 | `const parsed = parseAgentSessionKey(normalizedSessionKey);` | not-owner-relevant |
| src/agents/tools/sessions-send-tool.ts:471 | `requesterAgentId = resolveSessionAgentId({` | ladder-ok |
| src/agents/tools/sessions-send-tool.ts:596 | `const resolvedSession = await resolveSessionReference({` | not-owner-relevant |
| src/agents/tools/sessions-send-tool.ts:610 | `const visibleSession = await resolveVisibleSessionReference({` | not-owner-relevant |
| src/agents/tools/sessions-send-tool.ts:629 | `const resolvedKeyAgentId = parseAgentSessionKey(resolvedKey)?.agentId;` | not-owner-relevant |
| src/agents/tools/sessions-send-tool.ts:633 | `isLiteralLegacyKeyInput && classifySessionKeyShape(resolvedKey) === "legacy_or_alias";` | not-owner-relevant |
| src/agents/tools/sessions-send-tool.ts:635 | `? resolvePersistedSessionStoreOwnerForKey(cfg, resolvedKey)` | ladder-ok |
| src/agents/tools/sessions-send-tool.ts:639 | `? tryResolveLegacyCompatibilityAgentId(cfg)` | ladder-ok |
| src/agents/tools/sessions-send-tool.ts:643 | `(isUnscopedSessionKeySentinel(sessionKeyParam.trim()) \|\|` | not-owner-relevant |
| src/agents/tools/sessions-send-tool.ts:644 | `sessionKeyParam.trim().toLowerCase() === mainKey);` | not-owner-relevant |
| src/agents/tools/sessions-send-tool.ts:681 | `(!isUnscopedSessionKeySentinel(resolvedKey) \|\| resolvedSession.resolvedViaSessionId)` | not-owner-relevant |
| src/agents/tools/sessions-send-tool.ts:692 | `const parsedRequesterSessionKey = parseAgentSessionKey(rawRequesterSessionKey);` | not-owner-relevant |
| src/agents/tools/sessions-send-tool.ts:821 | `: targetAgentId && !parseAgentSessionKey(resolvedKey)` | not-owner-relevant |
| src/agents/tools/sessions-tool.ts:208 | `const requesterAgentId = resolveSessionAgentIds({` | ladder-ok |
| src/agents/tools/sessions-tool.ts:213 | `const normalizedRawKey = rawKey.trim();` | not-owner-relevant |
| src/agents/tools/sessions-tool.ts:222 | `: shouldResolveSessionIdInput(rawKey) && !isConfiguredMainAlias` | not-owner-relevant |
| src/agents/tools/sessions-tool.ts:229 | `const resolved = await resolveSessionReference({` | not-owner-relevant |
| src/agents/tools/sessions-tool.ts:264 | `agentId !== requesterAgentId && !parseAgentSessionKey(resolved.key)` | not-owner-relevant |
| src/agents/tools/sessions-tool.ts:304 | `const agentScope = parseAgentSessionKey(key) ? {} : { agentId };` | not-owner-relevant |
| src/agents/tools/sessions-tool.ts:412 | `const agentScope = parseAgentSessionKey(key) ? {} : { agentId };` | not-owner-relevant |
| src/agents/tools/sessions-tool.ts:417 | `const currentEntry = loadSessionEntry({ agentId, sessionKey: key, storePath });` | not-owner-relevant |
| src/agents/tools/sessions-tool.ts:455 | `const latestEntry = loadSessionEntry({ agentId, sessionKey: key, storePath });` | not-owner-relevant |
| src/agents/workspace-dirs.ts:1 | `none` | not-owner-relevant |
| src/agents/workspace-run.ts:65 | `const rawSessionKey = params.sessionKey?.trim() ?? "";` | not-owner-relevant |
| src/agents/workspace-run.ts:66 | `const shape = classifySessionKeyShape(rawSessionKey);` | not-owner-relevant |
| src/agents/workspace-run.ts:75 | `const parsed = parseAgentSessionKey(rawSessionKey);` | not-owner-relevant |
| src/agents/workspace-run.ts:76 | `const agentId = resolveSessionAgentId({` | ladder-ok |
| src/agents/workspace-run.ts:100 | `const rawSessionKey = params.sessionKey?.trim() ?? "";` | not-owner-relevant |
| src/agents/workspace-run.ts:101 | `if (classifySessionKeyShape(rawSessionKey) === "malformed_agent") {` | not-owner-relevant |
| src/auto-reply/reply/bash-command.ts:209 | `resolveSessionAgentId({` | ladder-ok |
| src/auto-reply/reply/commands-learn.ts:1 | `none` | not-owner-relevant |
| src/auto-reply/reply/commands-system-prompt.ts:165 | `const { sessionAgentId } = resolveSessionAgentIds({` | ladder-ok |
| src/auto-reply/reply/directive-handling.impl.ts:113 | `const activeAgentId = resolveSessionAgentId({` | ladder-ok |
| src/auto-reply/reply/get-reply-directives.ts:1 | `none` | not-owner-relevant |
| src/auto-reply/reply/get-reply-run-context.ts:342 | `? loadSessionEntry({ storePath, sessionKey, readConsistency: "latest" })` | not-owner-relevant |
| src/auto-reply/reply/runtime-policy-session-key.ts:100 | `const sessionKey = normalizeOptionalString(` | not-owner-relevant |
| src/auto-reply/reply/runtime-policy-session-key.ts:108 | `? resolveSessionAgentId({` | ladder-ok |
| src/auto-reply/reply/runtime-policy-session-key.ts:113 | `: (parseAgentSessionKey(sessionKey)?.agentId ?? normalizeOptionalString(params.ctx?.AgentId));` | not-owner-relevant |
| src/auto-reply/reply/session.ts:307 | `const agentId = resolveSessionAgentId({` | ladder-ok |
| src/channels/plugins/acp-configured-binding-consumer.ts:1 | `none` | not-owner-relevant |
| src/channels/plugins/read-only.ts:1 | `none` | not-owner-relevant |
| src/cli/config-model-validation.ts:155 | `? tryResolveLegacyCompatibilityAgentId(params.previousConfig)` | not-owner-relevant |
| src/cli/config-model-validation.ts:309 | `const defaultAgentId = tryResolveLegacyCompatibilityAgentId(config);` | not-owner-relevant |
| src/cli/config-model-validation.ts:401 | `agentScope.tryResolveLegacyCompatibilityAgentId(config) ??` | not-owner-relevant |
| src/commands/agent-via-gateway.ts:161 | `: tryResolveLegacyCompatibilityAgentId(selectionCfg);` | ladder-ok |
| src/commands/agent-via-gateway.ts:549 | `const sessionKey = opts.sessionKey?.trim();` | not-owner-relevant |
| src/commands/agent-via-gateway.ts:554 | `if (classifySessionKeyShape(sessionKey) === "malformed_agent") {` | not-owner-relevant |
| src/commands/agent-via-gateway.ts:561 | `if (!agentIdRaw \|\| classifySessionKeyShape(sessionKey) !== "agent") {` | not-owner-relevant |
| src/commands/agent-via-gateway.ts:565 | `const sessionAgentId = resolveAgentIdFromSessionKey(sessionKey);` | not-owner-relevant |
| src/commands/agent-via-gateway.ts:577 | `const rawSessionKey = opts.sessionKey?.trim();` | not-owner-relevant |
| src/commands/agent-via-gateway.ts:579 | `if (!rawSessionKey && !opts.sessionId?.trim() && classifySessionKeyShape(rawTo) === "agent") {` | not-owner-relevant |
| src/commands/agent-via-gateway.ts:583 | `rawSessionKey && classifySessionKeyShape(rawSessionKey) === "legacy_or_alias";` | not-owner-relevant |
| src/commands/agent-via-gateway.ts:588 | `[rawSessionKey, rawTo].some((value) => classifySessionKeyShape(value) === "agent");` | not-owner-relevant |
| src/commands/agent-via-gateway.ts:617 | `: resolvePersistedSessionStoreOwnerForKey(cfg, effectiveOwnerSessionKey);` | fixed-now |
| src/commands/agent-via-gateway.ts:648 | `const unscopedSession = isUnscopedSessionKeySentinel(rawSessionKey) \|\| implicitGlobalSession;` | not-owner-relevant |
| src/commands/agent-via-gateway.ts:677 | `isLegacySessionKey && !agentIdRaw && !isUnscopedSessionKeySentinel(rawSessionKey);` | not-owner-relevant |
| src/commands/agent-via-gateway.ts:684 | `const sessionKey = scopeLegacySessionKeyToAgent({` | not-owner-relevant |
| src/commands/agent-via-gateway.ts:717 | `sessionKey: typeof sessionKey === "string" && sessionKey.trim() ? sessionKey.trim() : undefined,` | not-owner-relevant |
| src/commands/agent-via-gateway.ts:969 | `const explicitSessionKey = opts.sessionKey?.trim();` | not-owner-relevant |
| src/commands/agent-via-gateway.ts:1021 | `classifySessionKeyShape(opts.to) !== "agent",` | not-owner-relevant |
| src/commands/agent-via-gateway.ts:1027 | `remoteGateway && explicitSessionKey && classifySessionKeyShape(explicitSessionKey) !== "agent",` | not-owner-relevant |
| src/commands/agent-via-gateway.ts:1035 | `(isUnscopedSessionKeySentinel(explicitSessionKey) \|\| hasImplicitGlobalTarget);` | not-owner-relevant |
| src/commands/agent-via-gateway.ts:1042 | `: classifySessionKeyShape(explicitSessionKey) === "agent"` | not-owner-relevant |
| src/commands/agent-via-gateway.ts:1044 | `: (await loadAgentSessionModule()).resolveSessionKeyForRequest({` | not-owner-relevant |
| src/commands/agent-via-gateway.ts:1054 | `? (await loadAgentSessionModule()).resolveSessionKeyForRequest({ cfg, agentId }).sessionKey` | not-owner-relevant |
| src/commands/agents.commands.delete.ts:1 | `none` | not-owner-relevant |
| src/commands/agents.config.ts:74 | `const defaultAgentId = tryResolveLegacyCompatibilityAgentId(cfg);` | not-owner-relevant |
| src/commands/daemon-install-helpers.ts:1 | `none` | not-owner-relevant |
| src/commands/doctor-auth-flat-profiles.ts:1 | `none` | not-owner-relevant |
| src/commands/doctor-auth-oauth-sidecar.ts:1 | `none` | not-owner-relevant |
| src/commands/doctor-config-flow.ts:1 | `none` | not-owner-relevant |
| src/commands/doctor/cron/legacy-repair.ts:1 | `none` | not-owner-relevant |
| src/commands/doctor/repair-sequencing.ts:1 | `none` | not-owner-relevant |
| src/commands/doctor/shared/config-mutation-state.ts:1 | `none` | not-owner-relevant |
| src/commands/doctor/shared/default-agent-role-materialization.ts | `deleted on branch; no live expression` | not-owner-relevant |
| src/commands/doctor/shared/plugin-metadata-snapshot-scope.ts:1 | `none` | not-owner-relevant |
| src/commands/health.ts:1 | `none` | not-owner-relevant |
| src/commands/onboard-agent.ts:69 | `tryResolveLegacyCompatibilityAgentId(params.config) ?? resolveDefaultAgentId(params.config),` | not-owner-relevant |
| src/commands/onboard-agent.ts:86 | `agentId: tryResolveLegacyCompatibilityAgentId(effective) ?? resolveDefaultAgentId(effective),` | not-owner-relevant |
| src/commands/onboard-inference.ts:203 | `? options.agentId?.trim() \|\| tryResolveLegacyCompatibilityAgentId(options.config)` | not-owner-relevant |
| src/commands/sandbox-explain.ts:84 | `const parsed = parseAgentSessionKey(params.sessionKey);` | not-owner-relevant |
| src/commands/sandbox-explain.ts:153 | `? normalizeAgentId(resolveAgentIdFromSessionKey(requestedSession))` | not-owner-relevant |
| src/commands/sandbox-explain.ts:181 | `const sessionEntry = loadSessionEntryReadOnly({` | not-owner-relevant |
| src/commands/sandbox-explain.ts:204 | `sessionKey === "global"` | not-owner-relevant |
| src/commands/sessions.ts:112 | `const agentId = parseAgentSessionKey(sessionKey)?.agentId ?? "acp";` | not-owner-relevant |
| src/commands/sessions.ts:390 | `const agentId = parseAgentSessionKey(row.key)?.agentId ?? target.agentId;` | not-owner-relevant |
| src/commands/sessions.ts:391 | `const acpSessionKey = resolveStoredSessionKeyForAgentStore({` | ladder-ok |
| src/config/agent-roster-provenance.ts:1 | `none` | not-owner-relevant |
| src/config/agent-workspace-roster-transition.ts:1 | `none` | not-owner-relevant |
| src/config/io.auth-inheritance-owner.ts:1 | `none` | not-owner-relevant |
| src/config/io.context.ts:1 | `none` | not-owner-relevant |
| src/config/io.cron-owner-refusal.ts:23 | `parseAgentSessionKey(normalizeOptionalString(record.sessionKey))?.agentId,` | not-owner-relevant |
| src/config/io.load.ts:1 | `none` | not-owner-relevant |
| src/config/io.ownership-write-guard.ts:1 | `none` | not-owner-relevant |
| src/config/io.plugin-metadata.ts:1 | `none` | not-owner-relevant |
| src/config/io.session-store-owner.ts:1 | `none` | not-owner-relevant |
| src/config/io.snapshot-shared.ts:1 | `none` | not-owner-relevant |
| src/config/io.snapshot.ts:1 | `none` | not-owner-relevant |
| src/config/io.write-prepare.ts:1 | `none` | not-owner-relevant |
| src/config/io.write.ts:1 | `none` | not-owner-relevant |
| src/config/legacy.default-agent-owner-state.ts:1 | `none` | not-owner-relevant |
| src/config/legacy.default-agent-owner.ts:29 | `export function resolveSessionStoreCompatibilityAgentId(config: OpenClawConfig): string {` | not-owner-relevant |
| src/config/legacy.default-agent-owner.ts:33 | `: (tryResolveLegacyCompatibilityAgentId(config) ?? "main");` | not-owner-relevant |
| src/config/legacy.default-agent-roles.ts:1 | `none` | not-owner-relevant |
| src/config/legacy.roster.ts:1 | `none` | not-owner-relevant |
| src/config/materialize.ts:1 | `none` | not-owner-relevant |
| src/config/runtime-overrides.ts:1 | `none` | not-owner-relevant |
| src/config/runtime-schema.ts:1 | `none` | not-owner-relevant |
| src/config/schema.help.core.ts:1 | `none` | not-owner-relevant |
| src/config/schema.labels.ts:1 | `none` | not-owner-relevant |
| src/config/schema.tiers.ts:1 | `none` | not-owner-relevant |
| src/config/sessions/cleanup-service.ts:214 | `const parsed = parseAgentSessionKey(params.key);` | not-owner-relevant |
| src/config/sessions/cleanup-service.ts:296 | `parseAgentSessionKey(key) &&` | not-owner-relevant |
| src/config/sessions/cleanup-service.ts:304 | `if (parseAgentSessionKey(key)) {` | not-owner-relevant |
| src/config/sessions/cleanup-service.ts:711 | `? resolveSessionStoreCompatibilityAgentId(cfg)` | not-owner-relevant |
| src/config/sessions/combined-store-gateway.ts:110 | `sessionKey ? resolveSessionStoreKey({ cfg, sessionKey, storeAgentId: agentId }) : undefined;` | ladder-ok |
| src/config/sessions/combined-store-gateway.ts:165 | `const defaultAgentId = normalizeAgentId(resolveSessionStoreCompatibilityAgentId(cfg));` | not-owner-relevant |
| src/config/sessions/combined-store-gateway.ts:275 | `const canonicalKey = resolveStoredSessionKeyForAgentStore({` | ladder-ok |
| src/config/sessions/combined-store-gateway.ts:286 | `parseAgentSessionKey(canonicalKey)?.agentId ?? agentId,` | not-owner-relevant |
| src/config/sessions/combined-store-gateway.ts:323 | `const canonicalKey = resolveStoredSessionKeyForAgentStore({` | ladder-ok |
| src/config/sessions/combined-store-gateway.ts:334 | `parseAgentSessionKey(canonicalKey)?.agentId ?? agentId,` | not-owner-relevant |
| src/config/sessions/main-session.ts:27 | `tryResolveLegacyCompatibilityAgentId(cfg) ??` | ladder-ok |
| src/config/sessions/main-session.ts:43 | `? resolvePersistedSessionStoreOwnerForKey(cfg, "global")` | ladder-ok |
| src/config/sessions/main-session.ts:50 | `: (tryResolveLegacyCompatibilityAgentId(cfg) ??` | ladder-ok |
| src/config/sessions/main-session.ts:83 | `const raw = params.sessionKey.trim();` | not-owner-relevant |
| src/config/sessions/session-accessor.transcript-turn.ts:46 | `const keyShape = classifySessionKeyShape(params.sessionKey);` | not-owner-relevant |
| src/config/sessions/session-accessor.transcript-turn.ts:53 | `const parsedAgentId = parseAgentSessionKey(params.sessionKey)?.agentId;` | not-owner-relevant |
| src/config/sessions/session-accessor.transcript-turn.ts:63 | `: resolvePersistedSessionStoreOwnerForTarget({` | ladder-ok |
| src/config/sessions/session-accessor.transcript-turn.ts:89 | `tryResolveLegacyCompatibilityAgentId(params.config);` | ladder-ok |
| src/config/sessions/session-accessor.transcript-turn.ts:274 | `const sessionKey = scope.sessionKey?.trim();` | not-owner-relevant |
| src/config/sessions/session-accessor.transcript-turn.ts:371 | `const sessionKey = scope.sessionKey?.trim();` | not-owner-relevant |
| src/config/sessions/session-accessor.transcript-turn.ts:404 | `? loadSessionEntryReadOnly({ ...scope, agentId, sessionKey, storePath })` | not-owner-relevant |
| src/config/sessions/session-store-config.ts:1 | `none` | not-owner-relevant |
| src/config/sessions/session-store-owner.ts:16 | `export function resolvePersistedSessionStoreOwner(` | ladder-ok |
| src/config/sessions/session-store-owner.ts:35 | `export function resolvePersistedSessionStoreOwnerForKey(` | ladder-ok |
| src/config/sessions/session-store-owner.ts:39 | `return classifySessionKeyShape(sessionKey) === "legacy_or_alias"` | not-owner-relevant |
| src/config/sessions/session-store-owner.ts:40 | `? resolvePersistedSessionStoreOwner(config)` | ladder-ok |
| src/config/sessions/session-store-owner.ts:45 | `export function resolvePersistedSessionStoreOwnerForTarget(params: {` | ladder-ok |
| src/config/sessions/session-store-owner.ts:51 | `const owner = resolvePersistedSessionStoreOwnerForKey(params.config, params.sessionKey);` | ladder-ok |
| src/config/sessions/targets-read-availability.ts:37 | `const persistedOwner = resolvePersistedSessionStoreOwner(cfg);` | ladder-ok |
| src/config/sessions/targets-read-availability.ts:65 | `const parsed = parseAgentSessionKey(sessionKey);` | not-owner-relevant |
| src/config/sessions/targets.ts:139 | `const defaultAgentId = resolveSessionStoreCompatibilityAgentId(cfg);` | not-owner-relevant |
| src/config/sessions/targets.ts:167 | `const parsed = parseAgentSessionKey(sessionKey);` | not-owner-relevant |
| src/config/sessions/targets.ts:413 | `{ defaultAgentId: resolveSessionStoreCompatibilityAgentId(cfg), env },` | not-owner-relevant |
| src/config/sessions/targets.ts:426 | `const defaultAgentId = resolveSessionStoreCompatibilityAgentId(cfg);` | not-owner-relevant |
| src/config/sessions/targets.ts:462 | `const parsed = parseAgentSessionKey(sessionKey);` | not-owner-relevant |
| src/config/sessions/targets.ts:575 | `{ defaultAgentId: resolveSessionStoreCompatibilityAgentId(cfg), env },` | not-owner-relevant |
| src/config/sessions/targets.ts:681 | `const persistedStoreOwner = resolvePersistedSessionStoreOwnerForTarget({` | ladder-ok |
| src/config/sessions/targets.ts:703 | `tryResolveLegacyCompatibilityAgentId(cfg) ??` | ladder-ok |
| src/config/sessions/targets.ts:721 | `const defaultAgentId = resolveSessionStoreCompatibilityAgentId(cfg);` | not-owner-relevant |
| src/config/sessions/targets.ts:751 | `const persistedStoreOwner = resolvePersistedSessionStoreOwner(cfg);` | ladder-ok |
| src/config/sessions/targets.ts:757 | `tryResolveLegacyCompatibilityAgentId(cfg) ??` | ladder-ok |
| src/config/types.agent-defaults.ts:1 | `none` | not-owner-relevant |
| src/config/types.agents.ts:1 | `none` | not-owner-relevant |
| src/config/types.openclaw.ts:1 | `none` | not-owner-relevant |
| src/config/validation-core.ts:183 | `entry.id ?? tryResolveLegacyCompatibilityAgentId(config) ?? resolveDefaultAgentId(config),` | not-owner-relevant |
| src/config/validation.ts:1 | `none` | not-owner-relevant |
| src/config/zod-schema.agent-defaults.ts:1 | `none` | not-owner-relevant |
| src/config/zod-schema.agent-runtime.ts:1 | `none` | not-owner-relevant |
| src/config/zod-schema.agents.ts:1 | `none` | not-owner-relevant |
| src/cron/legacy-default-agent-owner-migration.ts:1 | `none` | not-owner-relevant |
| src/cron/service/ops-lifecycle.ts:1 | `none` | not-owner-relevant |
| src/cron/service/ops-mutations.ts:320 | `parseAgentSessionKey(normalizeOptionalString(normalizedInput.sessionKey))?.agentId;` | not-owner-relevant |
| src/cron/service/state.ts:1 | `none` | not-owner-relevant |
| src/cron/store/row-codec.ts:401 | `const jsonSessionAgentId = parseAgentSessionKey(` | not-owner-relevant |
| src/cron/store/row-codec.ts:407 | `parseAgentSessionKey(row.session_key)?.agentId \|\|` | not-owner-relevant |
| src/cron/store/scalar-codec.ts:1 | `none` | not-owner-relevant |
| src/cron/store/schema.ts:1 | `none` | not-owner-relevant |
| src/gateway/agent-list.ts:57 | `const legacyAgentId = tryResolveLegacyCompatibilityAgentId(cfg);` | not-owner-relevant |
| src/gateway/assistant-identity.ts:106 | `const compatibilityAgentId = tryResolveLegacyCompatibilityAgentId(params.cfg);` | not-owner-relevant |
| src/gateway/chat-abort.ts:511 | `sessionKey === "global" && !explicitAgentId` | not-owner-relevant |
| src/gateway/chat-abort.ts:515 | `sessionKey === "global" ? (explicitAgentId ?? defaultGlobalAgentId) : explicitAgentId;` | not-owner-relevant |
| src/gateway/chat-abort.ts:544 | `const resolved = resolveRequestedSessionAgentId(cfg, "global");` | ladder-ok |
| src/gateway/chat-abort.ts:698 | `entry.agentId ?? parseAgentSessionKey(entry.sessionKey)?.agentId ?? defaultAgentId,` | not-owner-relevant |
| src/gateway/chat-queued-turns.ts:57 | `const sessionKey = normalizeOptionalString(params.sessionKey);` | not-owner-relevant |
| src/gateway/chat-queued-turns.ts:152 | `const sessionKey = normalizeOptionalString(params.sessionKey);` | not-owner-relevant |
| src/gateway/chat-queued-turns.ts:189 | `Array.from(params.sessionKeys, (k) => normalizeOptionalString(k)).filter((k): k is string =>` | not-owner-relevant |
| src/gateway/chat-run-owner.ts:9 | `parseAgentSessionKey(params.sessionKey)?.agentId ??` | not-owner-relevant |
| src/gateway/health/collector.ts:81 | `const defaultAgentId = tryResolveLegacyCompatibilityAgentId(cfg);` | not-owner-relevant |
| src/gateway/health/types.ts:1 | `none` | not-owner-relevant |
| src/gateway/hooks.ts:76 | `const defaultAgentId = tryResolveLegacyCompatibilityAgentId(cfg);` | ladder-ok |
| src/gateway/hooks.ts:81 | `? resolvePersistedSessionStoreOwnerForKey(cfg, "global")` | ladder-ok |
| src/gateway/hooks.ts:551 | `const parsed = parseAgentSessionKey(trimmed);` | not-owner-relevant |
| src/gateway/hooks.ts:574 | `const sessionKey = normalizeOptionalString(sessionKeyRaw);` | not-owner-relevant |
| src/gateway/local-request-context.ts:83 | `defaultAgentId: tryResolveLegacyCompatibilityAgentId(cfg),` | not-owner-relevant |
| src/gateway/local-request-context.ts:86 | `tryResolveLegacyCompatibilityAgentId(params.getRuntimeConfig()),` | not-owner-relevant |
| src/gateway/server-core-runtime.ts:1 | `none` | not-owner-relevant |
| src/gateway/server-cron.ts:304 | `const defaultAgentId = tryResolveLegacyCompatibilityAgentId(runtimeConfig);` | not-owner-relevant |
| src/gateway/server-cron.ts:334 | `const candidate = toAgentStoreSessionKey({` | not-owner-relevant |
| src/gateway/server-cron.ts:345 | `const sessionAgentId = resolveAgentIdFromSessionKey(canonical);` | not-owner-relevant |
| src/gateway/server-cron.ts:372 | `typeof opts?.sessionKey === "string" && opts.sessionKey.trim() ? opts.sessionKey : undefined;` | not-owner-relevant |
| src/gateway/server-cron.ts:380 | `requestedSessionKey && parseAgentSessionKey(requestedSessionKey)` | not-owner-relevant |
| src/gateway/server-cron.ts:381 | `? resolveAgentIdFromSessionKey(requestedSessionKey)` | not-owner-relevant |
| src/gateway/server-cron.ts:427 | `const defaultAgentId = tryResolveLegacyCompatibilityAgentId(params.cfg);` | not-owner-relevant |
| src/gateway/server-cron.ts:431 | `agentId: agentId ?? resolveSessionStoreCompatibilityAgentId(getRuntimeConfig()),` | not-owner-relevant |
| src/gateway/server-cron.ts:608 | `const sessionRow = loadGatewaySessionRow(sessionKey);` | not-owner-relevant |
| src/gateway/server-cron.ts:648 | `resolveDefaultAgentId: () => tryResolveLegacyCompatibilityAgentId(getRuntimeConfig()),` | not-owner-relevant |
| src/gateway/server-methods/agent-id-shared.ts:28 | `tryResolveLegacyCompatibilityAgentId(params.cfg) \|\|` | not-owner-relevant |
| src/gateway/server-methods/agent-request-preflight.ts:80 | `const requestSessionKey = request.sessionKey?.trim();` | not-owner-relevant |
| src/gateway/server-methods/agent-request-preflight.ts:82 | `? parseAgentSessionKey(requestSessionKey)` | not-owner-relevant |
| src/gateway/server-methods/agent-request-preflight.ts:86 | `? resolveRequestedSessionAgentId(cfg, requestSessionKey, request.agentId)` | ladder-ok |
| src/gateway/server-methods/agent-request-preflight.ts:96 | `tryResolveLegacyCompatibilityAgentId(cfg))` | not-owner-relevant |
| src/gateway/server-methods/agent-request-preflight.ts:97 | `: (normalizeOptionalString(request.agentId) ?? tryResolveLegacyCompatibilityAgentId(cfg));` | not-owner-relevant |
| src/gateway/server-methods/agent-request-preflight.ts:104 | `? loadSessionEntry({` | not-owner-relevant |
| src/gateway/server-methods/agent-request-preflight.ts:147 | `? (parseAgentSessionKey(swarmRequesterSessionKey)?.agentId ?? selectedAgentId)` | not-owner-relevant |
| src/gateway/server-methods/agent-request-preflight.ts:296 | `typeof cached.payload.sessionKey === "string" && cached.payload.sessionKey.trim()` | not-owner-relevant |
| src/gateway/server-methods/agent-request-preflight.ts:297 | `? cached.payload.sessionKey.trim()` | not-owner-relevant |
| src/gateway/server-methods/agent-request-routing.ts:84 | `classifySessionKeyShape(requestedToRaw) === "agent"` | not-owner-relevant |
| src/gateway/server-methods/agent-request-routing.ts:90 | `classifySessionKeyShape(requestedSessionKeyRaw) === "malformed_agent"` | not-owner-relevant |
| src/gateway/server-methods/agent-request-routing.ts:103 | `const requestedSessionAgent = resolveRequestedSessionAgentId(` | ladder-ok |
| src/gateway/server-methods/agent-request-routing.ts:194 | `resolveSessionStoreKey({` | ladder-ok |
| src/gateway/server-methods/agent-request-routing.ts:205 | `? loadSessionEntry(requestedSessionKey, {` | not-owner-relevant |
| src/gateway/server-methods/agent-request-routing.ts:250 | `loadSessionEntry(params.requestedSessionKeyRaw).entry?.sessionId,` | not-owner-relevant |
| src/gateway/server-methods/agent-run-handler.ts:1 | `none` | not-owner-relevant |
| src/gateway/server-methods/agent-session-prepare.ts:77 | `const requestedSessionAgent = resolveRequestedSessionAgentId(` | ladder-ok |
| src/gateway/server-methods/agent-session-prepare.ts:87 | `const { cfg, storePath, entry, canonicalKey, legacyKey, storeKeys } = loadSessionEntry(` | not-owner-relevant |
| src/gateway/server-methods/agent-session-prepare.ts:208 | `canonicalKey === "global" ? requestedAgentId : resolveAgentIdFromSessionKey(canonicalKey);` | not-owner-relevant |
| src/gateway/server-methods/agents.ts:1 | `none` | not-owner-relevant |
| src/gateway/server-methods/artifacts.ts:81 | `const owner = resolveRequestedSessionAgentId(cfg, sessionKey, query.agentId);` | ladder-ok |
| src/gateway/server-methods/artifacts.ts:106 | `const parsed = parseAgentSessionKey(key);` | not-owner-relevant |
| src/gateway/server-methods/artifacts.ts:111 | `const canonicalKey = resolveSessionStoreKey({ cfg, sessionKey: key });` | ladder-ok |
| src/gateway/server-methods/artifacts.ts:112 | `return resolveSessionStoreAgentId(cfg, canonicalKey);` | ladder-ok |
| src/gateway/server-methods/artifacts.ts:117 | `return resolveAgentIdFromSessionKey(key);` | not-owner-relevant |
| src/gateway/server-methods/artifacts.ts:134 | `const parsed = parseAgentSessionKey(key);` | not-owner-relevant |
| src/gateway/server-methods/artifacts.ts:139 | `const scopedKey = resolveStoredSessionKeyForAgentStore({` | ladder-ok |
| src/gateway/server-methods/artifacts.ts:147 | `resolveSessionStoreAgentId(cfg, scopedKey) !== normalizeAgentId(scopedAgentId)` | ladder-ok |
| src/gateway/server-methods/artifacts.ts:156 | `return toAgentStoreSessionKey({ agentId: scopedAgentId, requestKey: key });` | not-owner-relevant |
| src/gateway/server-methods/artifacts.ts:489 | `const agentId = query.agentId ?? resolveSessionAgentId({ config: cfg });` | ladder-ok |
| src/gateway/server-methods/artifacts.ts:497 | `const ownerAgentId = parseAgentSessionKey(task?.ownerKey)?.agentId;` | not-owner-relevant |
| src/gateway/server-methods/artifacts.ts:499 | `? resolvePersistedSessionStoreOwnerForKey(cfg ?? {}, requesterSessionKey)` | ladder-ok |
| src/gateway/server-methods/artifacts.ts:521 | `requesterAgentId ?? taskAgentId ?? resolveSessionAgentId({ config: cfg });` | ladder-ok |
| src/gateway/server-methods/artifacts.ts:531 | `const agentId = query.agentId ?? taskAgentId ?? resolveSessionAgentId({ config: cfg });` | ladder-ok |
| src/gateway/server-methods/artifacts.ts:551 | `const unscopedAgentId = parseAgentSessionKey(sessionKey) ? undefined : resolved.agentId;` | not-owner-relevant |
| src/gateway/server-methods/artifacts.ts:553 | `? loadSessionEntryReadOnly(sessionKey, { agentId: unscopedAgentId })` | not-owner-relevant |
| src/gateway/server-methods/artifacts.ts:554 | `: loadSessionEntryReadOnly(sessionKey);` | not-owner-relevant |
| src/gateway/server-methods/artifacts.ts:562 | `agentId: resolved.agentId ?? resolveAgentIdFromSessionKey(sessionKey),` | not-owner-relevant |
| src/gateway/server-methods/chat-abort-authorization.ts:1 | `none` | not-owner-relevant |
| src/gateway/server-methods/chat-abort-handler.ts:67 | `const parsedAbortSessionKey = parseAgentSessionKey(rawSessionKey);` | not-owner-relevant |
| src/gateway/server-methods/chat-abort-handler.ts:68 | `const compatibilityDefaultAgentId = tryResolveLegacyCompatibilityAgentId(abortCfg);` | not-owner-relevant |
| src/gateway/server-methods/chat-abort-handler.ts:74 | `? resolveRequestedSessionAgentId(abortCfg, rawSessionKey, agentIdOverride)` | ladder-ok |
| src/gateway/server-methods/chat-abort-handler.ts:111 | `const canonicalAbortSessionKey = resolveSessionStoreKey({` | ladder-ok |
| src/gateway/server-methods/chat-abort-handler.ts:120 | `const { entry: abortSessionEntry } = loadSessionEntry(` | not-owner-relevant |
| src/gateway/server-methods/chat-abort-runtime.ts:70 | `params.sessionKey === "global" && snapshot.agentId` | not-owner-relevant |
| src/gateway/server-methods/chat-abort-runtime.ts:73 | `const { cfg, storePath, entry } = loadSessionEntry(params.sessionKey, sessionLoadOptions);` | not-owner-relevant |
| src/gateway/server-methods/chat-broadcast.ts:41 | `const compatibilityAgentId = tryResolveLegacyCompatibilityAgentId(params.cfg);` | ladder-ok |
| src/gateway/server-methods/chat-broadcast.ts:42 | `const persistedOwner = resolvePersistedSessionStoreOwnerForKey(params.cfg, params.sessionKey);` | ladder-ok |
| src/gateway/server-methods/chat-broadcast.ts:84 | `const payloadAgentId = params.sessionKey === "global" ? params.agentId : undefined;` | not-owner-relevant |
| src/gateway/server-methods/chat-broadcast.ts:128 | `params.payload.sessionKey === "global" ? params.payload.agentId : undefined;` | not-owner-relevant |
| src/gateway/server-methods/chat-broadcast.ts:158 | `const payloadAgentId = params.sessionKey === "global" ? params.agentId : undefined;` | not-owner-relevant |
| src/gateway/server-methods/chat-history-handler.ts:86 | `: (tryResolveLegacyCompatibilityAgentId(cfg) ?? resolveDefaultAgentId(cfg));` | not-owner-relevant |
| src/gateway/server-methods/chat-history-handler.ts:212 | `loadSessionEntryReadOnly(sessionKey, {` | not-owner-relevant |
| src/gateway/server-methods/chat-history-handler.ts:230 | `const sessionAgentId = resolveSessionAgentId({` | ladder-ok |
| src/gateway/server-methods/chat-history-handler.ts:243 | `scopeLegacySessionKeyToAgent({` | not-owner-relevant |
| src/gateway/server-methods/chat-history-handler.ts:246 | `}) !== scopeLegacySessionKeyToAgent({ sessionKey: canonicalKey, agentId: sessionAgentId })` | not-owner-relevant |
| src/gateway/server-methods/chat-history-handler.ts:491 | `canonicalSessionKey: resolveSessionStoreKey({ cfg, sessionKey }),` | ladder-ok |
| src/gateway/server-methods/chat-message-get-handler.ts:82 | `const { cfg, storePath, entry } = loadSessionEntryReadOnly(sessionKey, sessionLoadOptions);` | not-owner-relevant |
| src/gateway/server-methods/chat-message-get-handler.ts:98 | `const sessionAgentId = resolveSessionAgentId({` | ladder-ok |
| src/gateway/server-methods/chat-metadata-runtime.ts:1 | `none` | not-owner-relevant |
| src/gateway/server-methods/chat-origin-routing.ts:117 | `const parsed = parseAgentSessionKey(requestedSessionKey);` | not-owner-relevant |
| src/gateway/server-methods/chat-origin-routing.ts:127 | `if (resolveSessionStoreKey({ cfg: params.cfg, sessionKey: requestedSessionKey }) === "global") {` | ladder-ok |
| src/gateway/server-methods/chat-origin-routing.ts:148 | `const resolved = resolveRequestedSessionAgentId(` | ladder-ok |
| src/gateway/server-methods/chat-origin-routing.ts:168 | `scopeLegacySessionKeyToAgent({` | not-owner-relevant |
| src/gateway/server-methods/chat-origin-routing.ts:212 | `const parsedSessionKey = parseAgentSessionKey(params.sessionKey);` | not-owner-relevant |
| src/gateway/server-methods/chat-send-dispatch-errors.ts:302 | `...(sessionKey === "global" && agentId ? { agentId } : {}),` | not-owner-relevant |
| src/gateway/server-methods/chat-send-dispatch-errors.ts:304 | `(sessionKey === "global" ? agentId : undefined) ??` | fixed-now |
| src/gateway/server-methods/chat-send-dispatch-errors.ts:305 | `tryResolveLegacyCompatibilityAgentId(cfg),` | fixed-now |
| src/gateway/server-methods/chat-send-dispatch-errors.ts:313 | `...(sessionKey === "global" && agentId ? { agentId } : {}),` | not-owner-relevant |
| src/gateway/server-methods/chat-send-handler.ts:528 | `sessionKey === "global"` | not-owner-relevant |
| src/gateway/server-methods/chat-send-handler.ts:529 | `? (selectedAgent.agentId ?? tryResolveLegacyCompatibilityAgentId(cfg))` | fixed-now |
| src/gateway/server-methods/chat-send-handler.ts:532 | `sessionKey === "global" ? globalFallbackAgentId : undefined;` | fixed-now |
| src/gateway/server-methods/chat-send-handler.ts:535 | `active.sessionKey === "global"` | not-owner-relevant |
| src/gateway/server-methods/chat-send-handler.ts:539 | `sessionKey === "global" &&` | not-owner-relevant |
| src/gateway/server-methods/chat-send-pre-admission.ts:107 | `(sessionKey === "global" ? selectedAgent.agentId : undefined) ??` | fixed-now |
| src/gateway/server-methods/chat-send-pre-admission.ts:108 | `tryResolveLegacyCompatibilityAgentId(cfg);` | fixed-now |
| src/gateway/server-methods/chat-send-pre-admission.ts:110 | `sessionKey === "global"` | not-owner-relevant |
| src/gateway/server-methods/chat-send-pre-admission.ts:111 | `? (selectedAgent.agentId ?? tryResolveLegacyCompatibilityAgentId(cfg))` | not-owner-relevant |
| src/gateway/server-methods/chat-send-pre-admission.ts:180 | `reloadEntry: () => loadSessionEntry(sessionLoadKey, sessionLoadOptions).entry,` | not-owner-relevant |
| src/gateway/server-methods/chat-send-session.ts:66 | `() => loadSessionEntry(sessionLoadKey, sessionLoadOptions),` | not-owner-relevant |
| src/gateway/server-methods/chat-send-session.ts:151 | `const agentId = resolveSessionAgentId({` | ladder-ok |
| src/gateway/server-methods/chat-send-setup.ts:1 | `none` | not-owner-relevant |
| src/gateway/server-methods/chat-startup-projection-contract.ts:1 | `none` | not-owner-relevant |
| src/gateway/server-methods/chat.ts:83 | `const sessionAgentId = resolveSessionAgentId({` | ladder-ok |
| src/gateway/server-methods/chat.ts:91 | `const { cfg: sessionCfg, entry } = loadSessionEntryReadOnly(` | not-owner-relevant |
| src/gateway/server-methods/chat.ts:139 | `} = loadSessionEntry(rawSessionKey, sessionLoadOptions);` | not-owner-relevant |
| src/gateway/server-methods/chat.ts:154 | `const agentId = resolveSessionAgentId({` | ladder-ok |
| src/gateway/server-methods/chat.ts:166 | `const latestEntry = loadSessionEntry(rawSessionKey, sessionLoadOptions).entry;` | not-owner-relevant |
| src/gateway/server-methods/chat.ts:219 | `...(sessionKey === "global" && agentId ? { agentId } : {}),` | not-owner-relevant |
| src/gateway/server-methods/chat.ts:225 | `sessionKeys: sessionKey === "global" && agentId ? ['agent:${agentId}:global'] : [sessionKey],` | not-owner-relevant |
| src/gateway/server-methods/models-auth-status-usage-cache.ts:1 | `none` | not-owner-relevant |
| src/gateway/server-methods/send.ts:252 | `const sessionAgentId = parseAgentSessionKey(requestSessionKey)?.agentId;` | not-owner-relevant |
| src/gateway/server-methods/send.ts:257 | `const sourceReplySessionAgentId = parseAgentSessionKey(sourceReplySessionKey)?.agentId;` | not-owner-relevant |
| src/gateway/server-methods/send.ts:868 | `return mirror.sessionKey?.trim() \|\| "__global__";` | not-owner-relevant |
| src/gateway/server-methods/send.ts:957 | `const sessionKey = normalizeOptionalString(request.sessionKey) ?? undefined;` | not-owner-relevant |
| src/gateway/server-methods/send.ts:961 | `? resolveRequestedSessionAgentId(cfg, sessionKey, requestedAgentId)` | ladder-ok |
| src/gateway/server-methods/send.ts:969 | `? resolveRequestedSessionAgentId(cfg, sourceReplySessionKey, agentId)` | ladder-ok |
| src/gateway/server-methods/send.ts:1203 | `? resolveRequestedSessionAgentId(cfg, providedSessionKey, explicitAgentId)` | ladder-ok |
| src/gateway/server-methods/send.ts:1210 | `explicitAgentId ?? sessionAgentId ?? resolveSessionAgentId({ config: cfg });` | ladder-ok |
| src/gateway/server-methods/send.ts:1284 | `const { canonicalKey, entry } = loadSessionEntry(outboundSessionKey);` | not-owner-relevant |
| src/gateway/server-methods/session-active-runs.ts:27 | `const sessionKey = active.sessionKey?.trim();` | not-owner-relevant |
| src/gateway/server-methods/session-active-runs.ts:101 | `if (active.sessionKey?.trim() !== params.sessionKey) {` | not-owner-relevant |
| src/gateway/server-methods/session-change-event.ts:57 | `? loadGatewaySessionRow(` | not-owner-relevant |
| src/gateway/server-methods/session-change-event.ts:59 | `payload.sessionKey === "global" && payload.agentId` | not-owner-relevant |
| src/gateway/server-methods/session-change-event.ts:65 | `const compatibilityAgentId = tryResolveLegacyCompatibilityAgentId(cfg);` | ladder-ok |
| src/gateway/server-methods/session-change-event.ts:66 | `const persistedStoreOwner = resolvePersistedSessionStoreOwnerForKey(cfg, sessionRow?.key);` | ladder-ok |
| src/gateway/server-methods/session-change-event.ts:72 | `rowAgentId = resolveAgentIdFromSessionKey(` | not-owner-relevant |
| src/gateway/server-methods/session-discussion.ts:117 | `const requestedAgent = resolveRequestedSessionAgentId(` | ladder-ok |
| src/gateway/server-methods/session-discussion.ts:169 | `const requestedAgent = resolveRequestedSessionAgentId(` | ladder-ok |
| src/gateway/server-methods/sessions-archive-lifecycle.ts:1 | `none` | not-owner-relevant |
| src/gateway/server-methods/sessions-compact.ts:54 | `const key = requireSessionKey(p.key, respond);` | not-owner-relevant |
| src/gateway/server-methods/sessions-compact.ts:64 | `const requestedAgent = resolveRequestedGlobalAgentId(cfg, key, p.agentId);` | ladder-ok |
| src/gateway/server-methods/sessions-compact.ts:71 | `requestedAgentId ?? tryResolveLegacyCompatibilityAgentId(cfg);` | fixed-now |
| src/gateway/server-methods/sessions-compact.ts:72 | `const { target, storePath } = resolveGatewaySessionTargetFromKey(key, cfg, {` | ladder-ok |
| src/gateway/server-methods/sessions-create.ts:100 | `explicitlyRequestedKey && !parseAgentSessionKey(explicitlyRequestedKey)` | not-owner-relevant |
| src/gateway/server-methods/sessions-create.ts:101 | `? resolveRequestedGlobalAgentId(cfg, explicitlyRequestedKey, p.agentId, {` | ladder-ok |
| src/gateway/server-methods/sessions-create.ts:113 | `parseAgentSessionKey(catalogRequestedKey)?.agentId ??` | not-owner-relevant |
| src/gateway/server-methods/sessions-create.ts:192 | `parseAgentSessionKey(explicitlyRequestedKey)?.agentId;` | not-owner-relevant |
| src/gateway/server-methods/sessions-create.ts:202 | `parseAgentSessionKey(sessionKey ?? "")?.agentId ??` | not-owner-relevant |
| src/gateway/server-methods/sessions-create.ts:237 | `parseAgentSessionKey(explicitKey)?.agentId ??` | not-owner-relevant |
| src/gateway/server-methods/sessions-create.ts:250 | `const parentRequestedAgent = resolveRequestedGlobalAgentId(cfg, parentSessionKey);` | ladder-ok |
| src/gateway/server-methods/sessions-create.ts:255 | `const parent = loadSessionEntryReadOnly(parentSessionKey, {` | not-owner-relevant |
| src/gateway/server-methods/sessions-create.ts:259 | `parentRequestedAgent.agentId ?? resolveSessionStoreAgentId(cfg, parent.canonicalKey),` | ladder-ok |
| src/gateway/server-methods/sessions-create.ts:270 | `const target = resolveGatewaySessionStoreTarget({ cfg, key: targetKey, agentId });` | ladder-ok |
| src/gateway/server-methods/sessions-create.ts:437 | `parseAgentSessionKey(sessionKey ?? "")?.agentId ??` | not-owner-relevant |
| src/gateway/server-methods/sessions-create.ts:582 | `storePath: resolveGatewaySessionStoreTarget({` | ladder-ok |
| src/gateway/server-methods/sessions-delete.ts:65 | `const key = requireSessionKey(p.key, respond);` | not-owner-relevant |
| src/gateway/server-methods/sessions-delete.ts:70 | `const requestedAgent = resolveRequestedGlobalAgentId(cfg, key, p.agentId);` | ladder-ok |
| src/gateway/server-methods/sessions-delete.ts:76 | `const { target, storePath } = resolveGatewaySessionTargetFromKey(key, cfg, {` | ladder-ok |
| src/gateway/server-methods/sessions-delete.ts:79 | `const compatibilityDefaultAgentId = tryResolveLegacyCompatibilityAgentId(cfg);` | ladder-ok |
| src/gateway/server-methods/sessions-delete.ts:80 | `const persistedStoreOwner = resolvePersistedSessionStoreOwnerForKey(cfg, key);` | ladder-ok |
| src/gateway/server-methods/sessions-delete.ts:86 | `normalizeOptionalString(p.agentId) ?? parseAgentSessionKey(key)?.agentId;` | not-owner-relevant |
| src/gateway/server-methods/sessions-delete.ts:112 | `const initialDeleteEntry = loadSessionEntry(key, {` | not-owner-relevant |
| src/gateway/server-methods/sessions-delete.ts:234 | `const { entry: preparedEntry, canonicalKey: preparedCanonicalKey } = loadSessionEntry(key, {` | not-owner-relevant |
| src/gateway/server-methods/sessions-delete.ts:308 | `const { entry, legacyKey, canonicalKey } = loadSessionEntry(key, {` | not-owner-relevant |
| src/gateway/server-methods/sessions-delete.ts:479 | `requestedAgentId ?? resolveSessionStoreAgentId(cfg, target.canonicalKey ?? key),` | ladder-ok |
| src/gateway/server-methods/sessions-diff.ts:35 | `} = loadSessionEntryReadOnly(params.sessionKey, { agentId: params.agentId });` | not-owner-relevant |
| src/gateway/server-methods/sessions-diff.ts:43 | `parseAgentSessionKey(canonicalKey)?.agentId ??` | not-owner-relevant |
| src/gateway/server-methods/sessions-diff.ts:45 | `parseAgentSessionKey(params.sessionKey)?.agentId,` | not-owner-relevant |
| src/gateway/server-methods/sessions-diff.ts:68 | `const requestedAgent = resolveRequestedSessionAgentId(` | ladder-ok |
| src/gateway/server-methods/sessions-files.ts:531 | `const loaded = loadSessionEntryReadOnly(params.sessionKey, { agentId: params.agentId });` | not-owner-relevant |
| src/gateway/server-methods/sessions-files.ts:537 | `parseAgentSessionKey(loaded.canonicalKey)?.agentId ??` | not-owner-relevant |
| src/gateway/server-methods/sessions-files.ts:539 | `parseAgentSessionKey(params.sessionKey)?.agentId,` | not-owner-relevant |
| src/gateway/server-methods/sessions-files.ts:864 | `const requestedAgent = resolveRequestedSessionAgentId(` | ladder-ok |
| src/gateway/server-methods/sessions-patch-archive.ts:107 | `const freshResolved = resolveGatewaySessionStoreTargetWithStore({` | ladder-ok |
| src/gateway/server-methods/sessions-patch-archive.ts:217 | `defaultAgentId: freshResolved.agentId ?? tryResolveLegacyCompatibilityAgentId(cfg),` | fixed-now |
| src/gateway/server-methods/sessions-read.ts:115 | `resolvePersistedSessionStoreOwnerForKey(cfg, sessionKey).kind === "none"` | ladder-ok |
| src/gateway/server-methods/sessions-read.ts:117 | `: resolveRequestedGlobalAgentId(cfg, sessionKey, requestedAgentId);` | ladder-ok |
| src/gateway/server-methods/sessions-read.ts:124 | `? resolveStoredSessionKeyForAgentStore({` | ladder-ok |
| src/gateway/server-methods/sessions-read.ts:129 | `: resolveSessionStoreKey({ cfg, sessionKey }),` | ladder-ok |
| src/gateway/server-methods/sessions-read.ts:136 | `resolved.agentId ? resolved.agentId : resolveSessionStoreAgentId(cfg, resolved.sessionKey),` | fixed-now |
| src/gateway/server-methods/sessions-read.ts:165 | `requestedAgentId && (sessionKey === "global" \|\| sessionKey === "unknown")` | not-owner-relevant |
| src/gateway/server-methods/sessions-read.ts:167 | `: resolveSessionStoreAgentId(cfg, sessionKey);` | ladder-ok |
| src/gateway/server-methods/sessions-read.ts:204 | `const parsed = parseAgentSessionKey(sessionKey);` | not-owner-relevant |
| src/gateway/server-methods/sessions-read.ts:212 | `searchSessionTranscripts({` | not-owner-relevant |
| src/gateway/server-methods/sessions-read.ts:593 | `const requestedAgent = resolveRequestedGlobalAgentId(cfg, key);` | ladder-ok |
| src/gateway/server-methods/sessions-read.ts:599 | `const cachedStoreTarget = resolveGatewaySessionStoreTargetWithStore({` | ladder-ok |
| src/gateway/server-methods/sessions-read.ts:609 | `const target = resolveGatewaySessionStoreTarget({` | ladder-ok |
| src/gateway/server-methods/sessions-read.ts:647 | `const key = requireSessionKey(params.key, respond);` | not-owner-relevant |
| src/gateway/server-methods/sessions-read.ts:652 | `const requestedAgent = resolveRequestedGlobalAgentId(cfg, key);` | ladder-ok |
| src/gateway/server-methods/sessions-read.ts:716 | `const key = requireSessionKey(p.key ?? p.sessionKey, respond);` | not-owner-relevant |
| src/gateway/server-methods/sessions-read.ts:726 | `const requestedAgent = resolveRequestedGlobalAgentId(` | ladder-ok |
| src/gateway/server-methods/sessions-sharing.ts:67 | `const requestedAgent = resolveRequestedSessionAgentId(` | ladder-ok |
| src/gateway/server-methods/sessions-subscriptions.ts:58 | `const trimmed = rawKey.trim();` | not-owner-relevant |
| src/gateway/server-methods/sessions-subscriptions.ts:67 | `canonicalKeys.push(resolveSessionStoreKey({ cfg, sessionKey: trimmed }));` | ladder-ok |
| src/gateway/server-methods/sessions-subscriptions.ts:85 | `const key = requireSessionKey(p.key, respond);` | not-owner-relevant |
| src/gateway/server-methods/sessions-subscriptions.ts:101 | `const requestedAgent = resolveRequestedGlobalAgentId(cfg, key, p.agentId);` | ladder-ok |
| src/gateway/server-methods/sessions-subscriptions.ts:107 | `const canonicalKey = resolveSessionStoreKey({` | ladder-ok |
| src/gateway/server-methods/sessions-subscriptions.ts:114 | `requestedAgentId ?? resolveSessionStoreAgentId(cfg, canonicalKey),` | ladder-ok |
| src/gateway/server-methods/sessions-subscriptions.ts:181 | `const key = requireSessionKey(p.key, respond);` | not-owner-relevant |
| src/gateway/server-methods/sessions-subscriptions.ts:186 | `const requestedAgent = resolveRequestedGlobalAgentId(cfg, key, p.agentId);` | ladder-ok |
| src/gateway/server-methods/sessions-subscriptions.ts:192 | `const canonicalKey = resolveSessionStoreKey({` | ladder-ok |
| src/gateway/server-methods/sessions-subscriptions.ts:199 | `requestedAgentId ?? resolveSessionStoreAgentId(cfg, canonicalKey),` | ladder-ok |
| src/gateway/server-methods/sessions-suggestions.ts:81 | `const requestedAgent = resolveRequestedSessionAgentId(cfg, params.sessionKey, params.agentId);` | ladder-ok |
| src/gateway/server-methods/system.ts:68 | `const soleAgentId = tryResolveLegacyCompatibilityAgentId(config);` | not-owner-relevant |
| src/gateway/server-methods/system.ts:168 | `? resolveRequestedSessionAgentId(cfg, requestedSessionKey)` | ladder-ok |
| src/gateway/server-methods/system.ts:187 | `requestedOwner?.agentId ?? resolveAgentIdFromSessionKey(requestedSessionKey),` | not-owner-relevant |
| src/gateway/server-methods/system.ts:200 | `const targetSession = loadGatewaySessionRow(requestedSessionKey, { agentId: targetAgentId });` | not-owner-relevant |
| src/gateway/server-methods/talk-session.ts:216 | `? resolveRequestedSessionAgentId(context.getRuntimeConfig(), requestedSessionKey)` | ladder-ok |
| src/gateway/server-methods/talk-session.ts:294 | `? resolveRequestedSessionAgentId(runtimeConfig, requestedSessionKey)` | ladder-ok |
| src/gateway/server-methods/talk-session.ts:661 | `sessionKey: normalizeOptionalString(params.sessionKey),` | not-owner-relevant |
| src/gateway/server-methods/task-suggestions.ts:91 | `loadSessionEntryReadOnly(params.key, { agentId: params.agentId }).entry` | not-owner-relevant |
| src/gateway/server-methods/task-suggestions.ts:152 | `const sourceOwner = resolveRequestedSessionAgentId(` | ladder-ok |
| src/gateway/server-methods/task-suggestions.ts:256 | `? resolveRequestedSessionAgentId(` | ladder-ok |
| src/gateway/server-methods/task-suggestions.ts:303 | `const sourceOwner = resolveRequestedSessionAgentId(` | ladder-ok |
| src/gateway/server-methods/tasks.ts:83 | `const sessionOwner = resolveRequestedSessionAgentId(` | ladder-ok |
| src/gateway/server-methods/tools-effective.ts:535 | `const loaded = loadSessionEntryReadOnly(` | not-owner-relevant |
| src/gateway/server-methods/tools-effective.ts:556 | `const sessionAgentId = resolveSessionAgentId({` | ladder-ok |
| src/gateway/server-methods/tools-effective.ts:643 | `const sessionOwner = resolveRequestedSessionAgentId(` | ladder-ok |
| src/gateway/server-methods/usage.ts:136 | `const { canonicalKey, entry, storePath } = loadSessionEntryReadOnly(` | not-owner-relevant |
| src/gateway/server-methods/usage.ts:140 | `const parsed = parseAgentSessionKey(key);` | not-owner-relevant |
| src/gateway/server-methods/usage.ts:142 | `parsed?.agentId ?? agentIdHint ?? resolveSessionAgentId({ config, sessionKey: key });` | ladder-ok |
| src/gateway/server-methods/usage.ts:299 | `const sessionOwner = resolveRequestedSessionAgentId(config, key);` | ladder-ok |
| src/gateway/server-methods/usage.ts:749 | `if (resolveSessionStoreAgentId(params.config, key) === scopedAgentId) {` | ladder-ok |
| src/gateway/server-methods/usage.ts:1036 | `: normalizeAgentId(params.agentId ?? resolveSessionAgentId({ config: params.config }));` | ladder-ok |
| src/gateway/server-methods/usage.ts:1212 | `? resolveRequestedSessionAgentId(config, specificKey, requestedAgentId)` | ladder-ok |
| src/gateway/server-methods/usage.ts:1221 | `specificSessionOwner?.agentId ?? requestedAgentId ?? resolveSessionAgentId({ config }),` | ladder-ok |
| src/gateway/server-methods/usage.ts:1256 | `const scopedSpecificKey = resolveStoredSessionKeyForAgentStore({` | ladder-ok |
| src/gateway/server-methods/usage.ts:1258 | `agentId: effectiveAgentId ?? resolveSessionAgentId({ config }),` | ladder-ok |
| src/gateway/server-methods/usage.ts:1261 | `const scopedParsed = parseAgentSessionKey(scopedSpecificKey);` | not-owner-relevant |
| src/gateway/server-methods/usage.ts:1263 | `scopedParsed?.agentId ?? effectiveAgentId ?? resolveSessionAgentId({ config });` | ladder-ok |
| src/gateway/server-plugin-bootstrap.ts:1 | `none` | not-owner-relevant |
| src/gateway/server-plugins.ts:1 | `none` | not-owner-relevant |
| src/gateway/server-session-events.ts:46 | `return tryResolveLegacyCompatibilityAgentId(getRuntimeConfig());` | ladder-ok |
| src/gateway/server-session-events.ts:91 | `: loadSessionEntryReadOnly(sessionKey, agentId ? { agentId } : undefined)?.entry;` | not-owner-relevant |
| src/gateway/server-session-events.ts:103 | `if (sessionKey === "global") {` | not-owner-relevant |
| src/gateway/server-session-events.ts:105 | `const persistedOwner = resolvePersistedSessionStoreOwnerForKey(config, sessionKey);` | fixed-now |
| src/gateway/server-session-events.ts:109 | `: tryResolveLegacyCompatibilityAgentId(config);` | fixed-now |
| src/gateway/server-session-events.ts:210 | `const targetKeyAgentId = parseAgentSessionKey(candidateSessionKey)?.agentId;` | not-owner-relevant |
| src/gateway/server-session-events.ts:265 | `const persistedOwner = resolvePersistedSessionStoreOwnerForKey(getRuntimeConfig(), sessionKey);` | fixed-now |
| src/gateway/server-session-events.ts:267 | `sessionKey === "global" && !effectiveAgentId` | fixed-now |
| src/gateway/server-session-events.ts:305 | `: loadSessionEntryReadOnly(sessionKey, { agentId: routingAgentId });` | not-owner-relevant |
| src/gateway/server-session-events.ts:337 | `const sessionRow = loadGatewaySessionRow(sessionKey, {` | not-owner-relevant |
| src/gateway/server-session-events.ts:441 | `normalizeOptionalString(event.agentId) ?? parseAgentSessionKey(event.sessionKey)?.agentId;` | not-owner-relevant |
| src/gateway/server-session-events.ts:442 | `const persistedOwner = resolvePersistedSessionStoreOwnerForKey(` | fixed-now |
| src/gateway/server-session-events.ts:451 | `? loadGatewaySessionRow(event.sessionKey, { agentId: rowAgentId })` | not-owner-relevant |
| src/gateway/server-startup-bootstrap.ts:1 | `none` | not-owner-relevant |
| src/gateway/server-startup-config-helpers.ts:1 | `none` | not-owner-relevant |
| src/gateway/server-startup-config.ts:1 | `none` | not-owner-relevant |
| src/gateway/server-startup-finish.ts:1 | `none` | not-owner-relevant |
| src/gateway/server-startup-log.ts:162 | `const soleAgentId = tryResolveLegacyCompatibilityAgentId(params.cfg);` | not-owner-relevant |
| src/gateway/server-startup-plugins.ts:1 | `none` | not-owner-relevant |
| src/gateway/server/health-state.ts:1 | `none` | not-owner-relevant |
| src/gateway/server/hooks-request-handler.ts:1 | `none` | not-owner-relevant |
| src/gateway/server/hooks.ts:80 | `sessionKey: toAgentStoreSessionKey({` | not-owner-relevant |
| src/gateway/server/hooks.ts:274 | `isUnscopedSessionKeySentinel(sessionKey)` | not-owner-relevant |
| src/gateway/server/hooks.ts:344 | `const isGlobalEvent = isUnscopedSessionKeySentinel(eventSessionKey);` | not-owner-relevant |
| src/gateway/server/hooks.ts:529 | `const isGlobalEvent = isUnscopedSessionKeySentinel(eventSessionKey);` | not-owner-relevant |
| src/gateway/session-create-service.ts:285 | `const requestedKey = normalizeOptionalString(params.key);` | not-owner-relevant |
| src/gateway/session-create-service.ts:289 | `const explicitKeyAgentId = parseAgentSessionKey(requestedKey)?.agentId;` | not-owner-relevant |
| src/gateway/session-create-service.ts:304 | `? resolveRequestedSessionAgentId(params.cfg, requestedKey, explicitAgentId, {` | ladder-ok |
| src/gateway/session-create-service.ts:314 | `tryResolveLegacyCompatibilityAgentId(params.cfg) ??` | not-owner-relevant |
| src/gateway/session-create-service.ts:353 | `: toAgentStoreSessionKey({` | not-owner-relevant |
| src/gateway/session-create-service.ts:359 | `const explicitTargetParts = parseAgentSessionKey(explicitTargetKey);` | not-owner-relevant |
| src/gateway/session-create-service.ts:386 | `if (durableEntryExists \|\| loadSessionEntryReadOnly(explicitTargetKey).entry) {` | not-owner-relevant |
| src/gateway/session-create-service.ts:478 | `const parentRequestedAgent = resolveRequestedSessionAgentId(` | ladder-ok |
| src/gateway/session-create-service.ts:481 | `!parseAgentSessionKey(parentSessionKey) &&` | not-owner-relevant |
| src/gateway/session-create-service.ts:490 | `const parent = loadSessionEntryReadOnly(parentSessionKey, { agentId: parentSelectedAgentId });` | not-owner-relevant |
| src/gateway/session-create-service.ts:517 | `parentSessionTarget = resolveGatewaySessionStoreTarget({` | ladder-ok |
| src/gateway/session-create-service.ts:560 | `resolveGatewaySessionStoreTarget({ cfg: params.cfg, key: explicitTargetKey, agentId })` | ladder-ok |
| src/gateway/session-create-service.ts:573 | `const creationTarget = resolveGatewaySessionStoreTarget({` | ladder-ok |
| src/gateway/session-create-service.ts:622 | `parentSelectedAgentId ?? resolveAgentIdFromSessionKey(canonicalParentSessionKey) ?? agentId,` | not-owner-relevant |
| src/gateway/session-create-service.ts:695 | `const currentParent = loadSessionEntryReadOnly(` | not-owner-relevant |
| src/gateway/session-create-service.ts:752 | `parentSelectedAgentId ?? resolveAgentIdFromSessionKey(canonicalParentSessionKey) ?? agentId,` | not-owner-relevant |
| src/gateway/session-observer-audience.ts:22 | `const persistedOwner = resolvePersistedSessionStoreOwnerForKey(config, sessionKey);` | fixed-now |
| src/gateway/session-observer-audience.ts:26 | `: tryResolveLegacyCompatibilityAgentId(config);` | fixed-now |
| src/gateway/session-observer-audience.ts:28 | `sessionKey === "global" &&` | not-owner-relevant |
| src/gateway/session-observer.ts:77 | `const agentId = resolveSessionAgentId({ sessionKey, config: cfg });` | ladder-ok |
| src/gateway/session-observer.ts:560 | `const eventSessionKey = event.sessionKey?.trim();` | not-owner-relevant |
| src/gateway/session-request-agent.ts:21 | `export function resolveRequestedSessionAgentId(` | ladder-ok |
| src/gateway/session-request-agent.ts:27 | `const parsed = parseAgentSessionKey(key.trim());` | not-owner-relevant |
| src/gateway/session-request-agent.ts:70 | `const persistedStoreOwner = resolvePersistedSessionStoreOwnerForKey(cfg, key);` | ladder-ok |
| src/gateway/session-request-agent.ts:98 | `: tryResolveLegacyCompatibilityAgentId(cfg);` | ladder-ok |
| src/gateway/session-reset-service.ts:116 | `agentId ?? tryResolveLegacyCompatibilityAgentId(cfg) ?? resolveDefaultAgentId(cfg),` | not-owner-relevant |
| src/gateway/session-reset-service.ts:1061 | `const parsedKey = parseAgentSessionKey(params.key);` | not-owner-relevant |
| src/gateway/session-reset-service.ts:1065 | `resolveSessionStoreKey({ cfg, sessionKey: params.key }) === "global"` | ladder-ok |
| src/gateway/session-reset-service.ts:1085 | `const target = resolveGatewaySessionStoreTarget({` | ladder-ok |
| src/gateway/session-reset-service.ts:1095 | `const initialResetEntry = loadSessionEntry(` | not-owner-relevant |
| src/gateway/session-reset-service.ts:1175 | `const { entry: currentEntry, canonicalKey: currentCanonicalKey } = loadSessionEntry(` | not-owner-relevant |
| src/gateway/session-reset-service.ts:1255 | `const { entry, legacyKey, canonicalKey } = loadSessionEntry(` | not-owner-relevant |
| src/gateway/session-reset-service.ts:1481 | `const boundaryEntry = loadSessionEntry(` | not-owner-relevant |
| src/gateway/session-store-key.ts:24 | `export function canonicalizeSessionKeyForAgent(agentId: string, key: string): string {` | not-owner-relevant |
| src/gateway/session-store-key.ts:39 | `const persistedOwner = resolvePersistedSessionStoreOwnerForKey(cfg, sessionKey);` | ladder-ok |
| src/gateway/session-store-key.ts:49 | `const compatibilityAgentId = tryResolveLegacyCompatibilityAgentId(cfg);` | ladder-ok |
| src/gateway/session-store-key.ts:98 | `export function resolveSessionStoreKey(params: {` | ladder-ok |
| src/gateway/session-store-key.ts:112 | `const parsed = parseAgentSessionKey(raw);` | not-owner-relevant |
| src/gateway/session-store-key.ts:141 | `return canonicalizeSessionKeyForAgent(agentId, raw);` | not-owner-relevant |
| src/gateway/session-store-key.ts:145 | `export function resolveSessionStoreAgentId(cfg: OpenClawConfig, canonicalKey: string): string {` | ladder-ok |
| src/gateway/session-store-key.ts:149 | `const parsed = parseAgentSessionKey(canonicalKey);` | not-owner-relevant |
| src/gateway/session-store-key.ts:157 | `export function resolveStoredSessionKeyForAgentStore(params: {` | ladder-ok |
| src/gateway/session-store-key.ts:170 | `const key = parseAgentSessionKey(raw) ? raw : canonicalizeSessionKeyForAgent(params.agentId, raw);` | not-owner-relevant |
| src/gateway/session-store-key.ts:171 | `return resolveSessionStoreKey({` | ladder-ok |
| src/gateway/session-store-key.ts:184 | `const canonicalKey = resolveStoredSessionKeyForAgentStore(params);` | ladder-ok |
| src/gateway/session-store-key.ts:188 | `return resolveSessionStoreAgentId(params.cfg, canonicalKey);` | ladder-ok |
| src/gateway/session-utils-list.ts:142 | `const parsed = parseAgentSessionKey(key);` | not-owner-relevant |
| src/gateway/session-utils-list.ts:146 | `: (parsed?.agentId ?? resolveSessionStoreAgentId(params.cfg, key)),` | ladder-ok |
| src/gateway/session-utils-list.ts:149 | `sessionKey: resolveStoredSessionKeyForAgentStore({` | ladder-ok |
| src/gateway/session-utils-list.ts:230 | `const parsed = parseAgentSessionKey(key);` | not-owner-relevant |
| src/gateway/session-utils-list.ts:325 | `const parsed = parseAgentSessionKey(key);` | not-owner-relevant |
| src/gateway/session-utils-list.ts:533 | `const parsed = parseAgentSessionKey(key);` | not-owner-relevant |
| src/gateway/session-utils-list.ts:539 | `: resolveSessionStoreAgentId(cfg, key);` | ladder-ok |
| src/gateway/session-utils-model.ts:251 | `options?.agentId ?? tryResolveLegacyCompatibilityAgentId(cfg) ?? LEGACY_IMPLICIT_AGENT_ID,` | not-owner-relevant |
| src/gateway/session-utils-model.ts:549 | `const agentId = resolveSessionAgentId({` | ladder-ok |
| src/gateway/session-utils-projection.ts:171 | `const parsed = parseAgentSessionKey(params.key);` | not-owner-relevant |
| src/gateway/session-utils-projection.ts:174 | `: normalizeAgentId(params.agentId ?? resolveSessionStoreAgentId(params.cfg, params.key));` | ladder-ok |
| src/gateway/session-utils-row.ts:138 | `const parsedAgent = parseAgentSessionKey(key);` | not-owner-relevant |
| src/gateway/session-utils-row.ts:163 | `parsedAgent?.agentId ?? params.agentId ?? resolveSessionStoreAgentId(cfg, key),` | ladder-ok |
| src/gateway/session-utils-row.ts:325 | `const acpSessionKey = resolveStoredSessionKeyForAgentStore({` | ladder-ok |
| src/gateway/session-utils-search.ts:109 | `const parsedAgent = parseAgentSessionKey(params.key);` | not-owner-relevant |
| src/gateway/session-utils-search.ts:111 | `parsedAgent?.agentId ?? resolveSessionStoreAgentId(params.cfg, params.key),` | ladder-ok |
| src/gateway/session-utils-search.ts:169 | `const { cfg, storePath, store, entry, canonicalKey } = loadSessionEntryReadOnly(sessionKey, {` | not-owner-relevant |
| src/gateway/session-utils-search.ts:202 | `export function loadGatewaySessionRow(` | not-owner-relevant |
| src/gateway/session-utils-store.ts:57 | `const parsed = parseAgentSessionKey(sessionKey);` | not-owner-relevant |
| src/gateway/session-utils-store.ts:132 | `const target = resolveGatewaySessionStoreTargetWithStore({` | ladder-ok |
| src/gateway/session-utils-store.ts:165 | `export function loadSessionEntry(sessionKey: string, opts?: { agentId?: string; clone?: boolean }) {` | not-owner-relevant |
| src/gateway/session-utils-store.ts:169 | `export function loadSessionEntryReadOnly(` | not-owner-relevant |
| src/gateway/session-utils-store.ts:216 | `const target = resolveGatewaySessionStoreTarget({` | ladder-ok |
| src/gateway/session-utils-store.ts:230 | `const agentParsed = parseAgentSessionKey(key);` | not-owner-relevant |
| src/gateway/sessions-resolve.ts:141 | `const uuid = parseAgentSessionKey(key)?.rest.match(SESSION_UUID_SUFFIX_RE)?.[1];` | not-owner-relevant |
| src/gateway/sessions-resolve.ts:205 | `const requestedAgent = resolveRequestedSessionAgentId(cfg, key, p.agentId);` | ladder-ok |
| src/gateway/sessions-resolve.ts:209 | `const target = resolveGatewaySessionStoreTargetWithStore({` | ladder-ok |
| src/infra/exec-approvals-effective.ts:308 | `const defaultAgentId = tryResolveLegacyCompatibilityAgentId(params.cfg);` | not-owner-relevant |
| src/infra/heartbeat-agent-resolution.ts:10 | `tryResolveLegacyCompatibilityAgentId(cfg) ??` | not-owner-relevant |
| src/infra/heartbeat-runner-config.ts:1 | `none` | not-owner-relevant |
| src/infra/heartbeat-runner-execution.ts:126 | `const parsed = parseAgentSessionKey(sessionKey);` | not-owner-relevant |
| src/infra/heartbeat-runner-execution.ts:135 | `const normalizedSessionKey = sessionKey.trim();` | not-owner-relevant |
| src/infra/heartbeat-runner-execution.ts:161 | `explicitAgentId.length > 0 ? undefined : parseAgentSessionKey(opts.sessionKey)?.agentId;` | not-owner-relevant |
| src/infra/heartbeat-runner-session.ts:36 | `const mainEntry = loadSessionEntry({ storePath, sessionKey: mainSessionKey, env });` | not-owner-relevant |
| src/infra/heartbeat-runner-session.ts:59 | `const forcedCandidate = toAgentStoreSessionKey({` | not-owner-relevant |
| src/infra/heartbeat-runner-session.ts:71 | `const sessionAgentId = resolveAgentIdFromSessionKey(forcedCanonical);` | not-owner-relevant |
| src/infra/heartbeat-runner-session.ts:82 | `entry: loadSessionEntry({ storePath, sessionKey: routedSessionKey, env }),` | not-owner-relevant |
| src/infra/heartbeat-runner-session.ts:110 | `const candidate = toAgentStoreSessionKey({` | not-owner-relevant |
| src/infra/heartbeat-runner-session.ts:129 | `const sessionAgentId = resolveAgentIdFromSessionKey(canonical);` | not-owner-relevant |
| src/infra/heartbeat-runner-session.ts:134 | `entry: loadSessionEntry({ storePath, sessionKey: canonical, env }),` | not-owner-relevant |
| src/infra/heartbeat-runner-session.ts:158 | `const isolatedSessionKey = toAgentStoreSessionKey({` | not-owner-relevant |
| src/infra/heartbeat-runner-session.ts:164 | `params.sessionKey === "global" \|\|` | not-owner-relevant |
| src/infra/heartbeat-runner-session.ts:237 | `const entry = loadSessionEntry({ storePath, sessionKey });` | not-owner-relevant |
| src/infra/heartbeat-summary.ts:47 | `: (tryResolveLegacyCompatibilityAgentId(cfg) ?? tryResolveDefaultAgentId(cfg));` | not-owner-relevant |
| src/infra/path-case.ts:1 | `none` | not-owner-relevant |
| src/infra/state-migrations.doctor.ts:277 | `const agentId = tryResolveLegacyCompatibilityAgentId(cfg);` | sidecar-only-migration |
| src/infra/state-migrations.doctor.ts:285 | `? resolveSessionStoreCompatibilityAgentId(cfg)` | sidecar-only-migration |
| src/infra/state-migrations.doctor.ts:1278 | `* of the configured default agent; reads always use resolveSessionStoreKey()` | ladder-ok |
| src/infra/state-migrations.doctor.ts:1345 | `: resolveSessionStoreCompatibilityAgentId(params.cfg),` | sidecar-only-migration |
| src/infra/state-migrations.onboarding-recommendations.ts:34 | `const migrationAgentId = tryResolveLegacyCompatibilityAgentId(params.cfg);` | sidecar-only-migration |
| src/infra/state-migrations.workspace-setup-sandbox.ts:60 | `const sessionAgentId = parseAgentSessionKey(sessionKey)?.agentId;` | not-owner-relevant |
| src/plugins/channel-presence-policy.ts:1 | `none` | not-owner-relevant |
| src/plugins/gateway-startup-plugin-config.ts:1 | `none` | not-owner-relevant |
| src/plugins/gateway-startup-plugin-metadata.ts:1 | `none` | not-owner-relevant |
| src/plugins/gateway-startup-plugin-plan.ts:1 | `none` | not-owner-relevant |
| src/plugins/plugin-metadata-snapshot.ts:1 | `none` | not-owner-relevant |
| src/plugins/runtime/load-context.ts:1 | `none` | not-owner-relevant |
| src/plugins/runtime/runtime-agent.ts:111 | `return loadSessionEntryReadOnly(toSessionAccessScope(params));` | not-owner-relevant |
| src/plugins/runtime/runtime-agent.ts:188 | `const target = resolveGatewaySessionStoreTarget({` | ladder-ok |
| src/routing/bindings.ts:43 | `const soleAgentId = tryResolveLegacyCompatibilityAgentId(cfg);` | not-owner-relevant |
| src/routing/channel-route-targets.ts:1 | `none` | not-owner-relevant |
| src/routing/resolve-route.ts:142 | `fallbackSoleAgentId: tryResolveLegacyCompatibilityAgentId(cfg),` | not-owner-relevant |
| src/routing/resolve-route.ts:789 | `tryResolveLegacyCompatibilityAgentId(input.cfg) ??` | not-owner-relevant |
| src/secrets/channel-contract-api.ts:1 | `none` | not-owner-relevant |
| src/secrets/runtime-config-collectors-plugins.ts:1 | `none` | not-owner-relevant |
| src/secrets/runtime-fast-path.ts:1 | `none` | not-owner-relevant |
| src/secrets/runtime-manifest.runtime.ts:1 | `none` | not-owner-relevant |
| src/secrets/runtime.ts:1 | `none` | not-owner-relevant |
| src/sessions/session-lifecycle-events.ts:1 | `none` | not-owner-relevant |
| src/state/openclaw-state-db-contract.ts:1 | `none` | not-owner-relevant |
| src/state/openclaw-state-db.generated.d.ts:1 | `none` | not-owner-relevant |
| src/system-agent/inference-route.ts:46 | `tryResolveLegacyCompatibilityAgentId(config) ??` | not-owner-relevant |
| src/talk/agent-consult-runtime.ts:68 | `const candidateAgentId = parseAgentSessionKey(sessionKey)?.agentId ?? fallbackAgentId;` | not-owner-relevant |
| src/talk/agent-consult-runtime.ts:83 | `const requesterAgentId = parseAgentSessionKey(requesterSessionKey)?.agentId ?? params.agentId;` | not-owner-relevant |
| src/talk/agent-consult-runtime.ts:108 | `const trimmed = sessionKey.trim();` | not-owner-relevant |
| src/talk/agent-consult-runtime.ts:183 | `const requesterAgentId = parseAgentSessionKey(requesterSessionKey)?.agentId;` | not-owner-relevant |
| src/talk/agent-consult-runtime.ts:292 | `resolveSessionAgentId({` | fixed-now |
| src/talk/agent-target.ts:15 | `tryResolveLegacyCompatibilityAgentId(config) ??` | ladder-ok |
| src/talk/agent-target.ts:29 | `const persistedOwner = resolvePersistedSessionStoreOwnerForKey(config, normalizedSessionKey);` | fixed-now |
| src/talk/agent-target.ts:31 | `? resolveAgentIdFromSessionKey(normalizedSessionKey, resolveTalkTargetAgentId(config))` | fixed-now |
| src/talk/agent-target.ts:32 | `: resolveSessionAgentId({ config, sessionKey: normalizedSessionKey });` | fixed-now |
| src/tui/tui.ts:184 | `const parsed = parseAgentSessionKey(trimmed);` | not-owner-relevant |
| src/tui/tui.ts:193 | `return toAgentStoreSessionKey({` | not-owner-relevant |
| src/tui/tui.ts:206 | `const initialSessionInput = (params.initialSessionInput ?? "").trim();` | not-owner-relevant |
| src/tui/tui.ts:207 | `const parsed = parseAgentSessionKey(initialSessionInput);` | not-owner-relevant |
| src/tui/tui.ts:217 | `return resolveSessionAgentId({` | ladder-ok |
| src/tui/tui.ts:232 | `tryResolveLegacyCompatibilityAgentId(params.cfg) ??` | not-owner-relevant |
| src/tui/tui.ts:623 | `const initialSessionInput = (opts.session ?? "").trim();` | not-owner-relevant |
| src/tui/tui.ts:885 | `const parsed = parseAgentSessionKey(key);` | not-owner-relevant |
| src/tui/tui.ts:906 | `const parsed = parseAgentSessionKey(sessionKey);` | not-owner-relevant |
| src/tui/tui.ts:915 | `const trimmed = sessionKey.trim();` | not-owner-relevant |
| src/tui/tui.ts:944 | `const rememberedAgent = parseAgentSessionKey(rememberedKey)?.agentId;` | not-owner-relevant |
| src/tui/tui.ts:1282 | `const parsed = parseAgentSessionKey(initialSessionInput);` | not-owner-relevant |
| src/utils/usage-format.ts:1 | `none` | not-owner-relevant |

Rows: 785 across 246 files.
