// Placeholder text for config fields whose unset state resolves to a runtime
// fallback the zod schema does not declare.
//
// The Control UI form edits the authored config (before runtime defaults), so an
// absent key has no value to display. Booleans fell back to an unchecked toggle,
// which reads as OFF even where the runtime treats absent as ON
// (`cfg.x?.enabled !== false`, `?? true`). A `placeholder` hint makes the form
// render a Default/On/Off select for booleans, names the default in the unset
// option of enum selects, and fills the empty state of text and number inputs.
//
// Every entry was verified against its runtime read site on `main` when it was
// added. Keep wording as "Default: <effective value>", with a qualifier only when
// the fallback is conditional. Do not "fix" these with `.default()` in the zod
// schema: `resolved`/`sourceConfig` are deliberately pre-default so `config set`
// never persists defaults into the user's file (src/config/types.openclaw.ts).

const DEFAULT_ON = "Default: On";

/** Booleans the runtime reads as enabled when the key is absent. */
const DEFAULT_ON_BOOLEAN_PATHS = [
  // src/gateway/server-cron.ts, src/cron/local-service.ts, src/cron/service/failure-alerts.ts
  "cron.enabled",
  "cron.triggers.enabled",
  "cron.failureAlert.enabled",
  // src/gateway/server-http.ts, session-observer.ts, control-ui.ts, terminal/enabled.ts,
  // auth-rate-limit.ts, node-registry.ts, server/ws-connection/handshake-auth-helpers.ts,
  // src/infra/tls/gateway.ts
  "gateway.controlUi.enabled",
  "gateway.controlUi.sessionObserver",
  "gateway.controlUi.communityInvite",
  "gateway.controlUi.automaticallyFetchFavicons",
  "gateway.cliAgents.enabled",
  "gateway.terminal.enabled",
  "gateway.auth.rateLimit.exemptLoopback",
  "gateway.nodes.allowSkills",
  "gateway.nodes.pluginTools.enabled",
  "gateway.nodes.pairing.autoApproveLocal",
  "gateway.tls.autoGenerate",
  // src/plugins/config-normalization-shared.ts, hook-policy-decisions.ts
  "plugins.enabled",
  "plugins.entries.*.hooks.allowPromptInjection",
  // src/hooks/loader.ts, configured.ts, gmail.ts, src/gateway/hooks.ts
  "hooks.internal.enabled",
  "hooks.internal.entries.*.enabled",
  "hooks.mappings.*.deliver",
  "hooks.gmail.includeBody",
  // src/audit/audit-config.ts, src/infra/diagnostic-events.ts,
  // extensions/diagnostics-otel/src/service.ts, src/infra/update-startup.ts,
  // src/gateway/node-command-policy.ts
  "logging.audit.enabled",
  "diagnostics.enabled",
  "diagnostics.otel.traces",
  "diagnostics.otel.metrics",
  "update.checkOnStart",
  "wizard.appRecommendations",
  // src/acp/policy.ts, src/auto-reply/reply/acp-stream-settings.ts
  "acp.enabled",
  "acp.dispatch.enabled",
  "acp.stream.repeatSuppression",
  // src/agents/tools-effective-inventory.ts, extensions/browser/*, src/node-host/runtime.ts
  "browser.enabled",
  "browser.allowSystemProfileImport",
  "browser.evaluateEnabled",
  "browser.extensionRelay.allowLegacyAuth",
  "nodeHost.browserProxy.enabled",
  "nodeHost.skills.enabled",
  // src/skills/runtime/refresh.ts, loading/config.ts, runtime/env-overrides.ts,
  // src/agents/bundle-mcp-config.ts, src/model-catalog/remote-config.ts,
  // extensions/ollama/src/stream-compat.ts
  "skills.load.watch",
  "skills.install.preferBrew",
  "skills.entries.*.enabled",
  "mcp.servers.*.enabled",
  "models.catalogRefresh.enabled",
  "models.providers.*.injectNumCtxForOpenAICompat",
  // src/web-search/runtime.ts, src/web-fetch/runtime.ts, src/agents/agent-tools.ts,
  // bash-tools.exec-run.ts, src/auto-reply/reply/reply-elevated.ts, src/infra/outbound/*,
  // src/plugin-sdk/session-visibility.ts, src/agents/subagents/swarm/swarm-config.ts,
  // src/agents/openclaw-tools.registration.ts, src/media-understanding/runtime.ts.
  // Not tools.loopDetection.enabled: detection itself is opt-in (`=== true`);
  // only the post-compaction guard reads `!== false`.
  "tools.web.search.enabled",
  "tools.web.fetch.enabled",
  "tools.exec.applyPatch.enabled",
  "tools.exec.applyPatch.workspaceOnly",
  "tools.exec.notifyOnExit",
  "tools.elevated.enabled",
  "agents.entries.*.tools.elevated.enabled",
  "tools.message.crossContext.allowWithinProvider",
  "tools.message.broadcast.enabled",
  "tools.agentToAgent.enabled",
  "tools.swarm.enabled",
  "tools.updatePlan",
  "tools.media.image.enabled",
  "tools.media.audio.enabled",
  "tools.media.video.enabled",
  // src/agents/command/post-run.ts, embedded-agent-runner/extensions.ts,
  // embedded-agent-runner/tool-result-truncation.ts, src/auto-reply/reply/startup-context.ts,
  // src/agents/memory-search.ts, src/agents/sandbox/config.ts
  "agents.defaults.compaction.enabled",
  "agents.defaults.compaction.qualityGuard.enabled",
  "agents.defaults.contextPruning.hardClear.enabled",
  "agents.defaults.startupContext.enabled",
  "memory.search.enabled",
  "agents.defaults.sandbox.docker.readOnlyRoot",
  "agents.defaults.sandbox.browser.noVncEnabled",
  "agents.defaults.sandbox.browser.autoStart",
  "agents.defaults.sandbox.ssh.strictHostKeyChecking",
  "agents.defaults.sandbox.ssh.updateHostKeys",
  "agents.entries.*.sandbox.docker.readOnlyRoot",
  "agents.entries.*.sandbox.browser.noVncEnabled",
  "agents.entries.*.sandbox.browser.autoStart",
  "agents.entries.*.sandbox.ssh.strictHostKeyChecking",
  "agents.entries.*.sandbox.ssh.updateHostKeys",
  // src/channels/thread-bindings-policy.ts, src/gateway/session-sharing-policy.ts,
  // src/auto-reply/commands-text-routing.ts
  "session.threadBindings.enabled",
  "session.threadBindings.spawnSessions",
  "session.sharing.readOnly",
  "session.sharing.suggest",
  "session.sharing.drafts",
  "commands.text",
  // src/channels/mention-gating.ts, src/infra/heartbeat-visibility.ts
  "channels.defaults.implicitMentions.replyToBot",
  "channels.defaults.implicitMentions.quotedBot",
  "channels.defaults.implicitMentions.threadParticipation",
  "channels.defaults.heartbeatVisibility.showAlerts",
  "channels.defaults.heartbeatVisibility.useIndicator",
  // src/tts/tts-config.ts, src/transcripts/config.ts
  "tts.modelOverrides.enabled",
  "transcripts.enabled",
] as const;

/** Fields whose unset state resolves to a specific value or a conditional rule. */
const RUNTIME_FALLBACK_PLACEHOLDERS: Record<string, string> = {
  // Conditional booleans. Name the rule instead of a bare On/Off.
  "gateway.auth.allowTailscale": "Default: On only with Tailscale serve", // src/gateway/auth-resolve.ts
  "plugins.entries.*.enabled": "Default: Auto", // src/plugins/channel-presence-policy.ts, slots.ts
  "plugins.entries.*.hooks.allowConversationAccess": "Default: On for bundled plugins", // src/plugins/hook-policy-decisions.ts
  "tools.links.enabled": "Default: On when tools.links is configured", // src/link-understanding/runner.ts
  "messages.statusReactions.enabled": "Default: On for Discord only", // extensions/discord, slack, whatsapp monitors
  "memory.search.rememberAcrossConversations": "Default: On unless DM scope is isolated", // src/agents/memory-search.ts
  // Enums and numbers with a runtime fallback the schema does not declare.
  "gateway.port": "Default: 18789", // src/config/paths.ts
  "gateway.bind": "Default: loopback", // src/config/validation-core.ts
  "gateway.auth.mode": "Default: token (password when only a password is set)", // src/gateway/auth-resolve.ts
  "gateway.tailscale.mode": "Default: off", // src/config/validation-core.ts
  "gateway.auth.rateLimit.maxAttempts": "Default: 10", // src/gateway/auth-rate-limit.ts
  "gateway.auth.rateLimit.windowMs": "Default: 60000",
  "gateway.auth.rateLimit.lockoutMs": "Default: 300000",
  "session.scope": "Default: per-sender", // src/config/sessions/main-session.ts
  "session.dmScope": "Default: main", // src/infra/outbound/base-session-key.ts
  "session.groupScope": "Default: per-group",
  "agents.defaults.sandbox.mode": "Default: off", // src/commands/doctor-sandbox.ts, src/status/status-message.ts
  "agents.defaults.sandbox.workspaceAccess": "Default: none", // src/agents/sandbox/config.ts
  "agents.defaults.sandbox.sessionToolsVisibility": "Default: spawned", // src/plugin-sdk/session-visibility.ts
  "agents.defaults.subagents.maxSpawnDepth": "Default: 5", // src/config/agent-limits.ts
  "agents.defaults.subagents.maxChildrenPerAgent": "Default: 5",
  "agents.defaults.timeoutSeconds": "Default: 172800 (48 hours)", // src/agents/timeout.ts
  "agents.defaults.thinkingDefault": "Default: off", // src/status/status-message.ts
  "agents.defaults.verboseDefault": "Default: off", // src/auto-reply/commands-registry.ts
  "agents.defaults.toolProgressDetail": "Default: explain", // src/agents/embedded-agent-subscribe.handlers.tools.start.ts
  // Not agents.defaults.modelSelectionScope: unset keeps legacy owner /model
  // behavior that differs from an explicit "session", so no single value is true.
  "logging.level": "Default: info", // src/logging/console.ts
  "logging.audit.messages": "Default: off", // src/audit/audit-config.ts
  "proxy.loopbackMode": "Default: gateway-only", // src/infra/net/proxy/proxy-lifecycle.ts
  "skills.install.nodeManager": "Default: npm", // src/commands/onboard-skills.ts
  "cron.failureAlert.after": "Default: 2", // src/cron/service/failure-alerts.ts
  "cron.failureAlert.cooldownMs": "Default: 3600000",
  "tools.exec.ask": "Default: off", // src/security/audit.ts
};

/** Placeholder hints keyed by config path for fields with undeclared runtime defaults. */
export const INHERITED_DEFAULT_PLACEHOLDERS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(DEFAULT_ON_BOOLEAN_PATHS.map((path) => [path, DEFAULT_ON])),
  ...RUNTIME_FALLBACK_PLACEHOLDERS,
};
