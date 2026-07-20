import {
  ErrorCodes,
  errorShape,
  missingScopeErrorShape,
} from "../../packages/gateway-protocol/src/index.js";
import {
  gatewayStartupUnavailableDetails,
  GATEWAY_STARTUP_RETRY_AFTER_MS,
} from "../../packages/gateway-protocol/src/startup-unavailable.js";
import { getPluginRegistryState } from "../plugins/runtime-state.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  getGatewaySuspendAdmissionPhase,
  isGatewayRestartDraining,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { formatControlPlaneActor, resolveControlPlaneActor } from "./control-plane-audit.js";
import {
  consumeControlPlaneWriteBudget,
  CONTROL_PLANE_RATE_LIMIT_MAX_REQUESTS,
  CONTROL_PLANE_RATE_LIMIT_WINDOW_MS,
} from "./control-plane-rate-limit.js";
import {
  ADMIN_SCOPE,
  authorizeOperatorScopesForMethod,
  authorizeOperatorScopesForRequiredScope,
  resolveLeastPrivilegeOperatorScopesForMethod,
} from "./method-scopes.js";
import {
  createCoreGatewayMethodDescriptors,
  createGatewayMethodDescriptorsFromHandlers,
  createGatewayMethodRegistry,
  createPluginGatewayMethodDescriptors,
  isCoreGatewayMethodClassified,
  type GatewayMethodRegistry,
} from "./methods/registry.js";
import { isOperatorScope } from "./operator-scopes.js";
import { isRoleAuthorizedForMethod, parseGatewayRole } from "./role-policy.js";
import { NODE_PAIR_GATEWAY_METHODS } from "./server-methods-node-methods.js";
import { createLazyCoreHandlers, lazyHandlerModule } from "./server-methods/lazy-core-handlers.js";
import { SKILLS_GATEWAY_METHOD_NAMES } from "./server-methods/skills-method-names.js";
import type {
  GatewayRequestHandler,
  GatewayRequestHandlers,
  GatewayRequestOptions,
} from "./server-methods/types.js";

const loadAgentHandlers = lazyHandlerModule(
  () => import("./server-methods/agent.js"),
  (module) => module.agentHandlers,
);
const loadAgentsHandlers = lazyHandlerModule(
  () => import("./server-methods/agents.js"),
  (module) => module.agentsHandlers,
);
const loadAgentsWorkspaceHandlers = lazyHandlerModule(
  () => import("./server-methods/agents-workspace.js"),
  (module) => module.agentsWorkspaceHandlers,
);
const loadArtifactsHandlers = lazyHandlerModule(
  () => import("./server-methods/artifacts.js"),
  (module) => module.artifactsHandlers,
);
const loadBoardHandlers = lazyHandlerModule(
  () => import("./server-methods/board.js"),
  (module) => module.boardHandlers,
);
const loadAuditHandlers = lazyHandlerModule(
  () => import("./server-methods/audit.js"),
  (module) => module.auditHandlers,
);
const loadUsersHandlers = lazyHandlerModule(
  () => import("./server-methods/users.js"),
  (module) => module.usersHandlers,
);
const loadAttachHandlers = lazyHandlerModule(
  () => import("./server-methods/attach.js"),
  (module) => module.attachHandlers,
);
const loadChannelsHandlers = lazyHandlerModule(
  () => import("./server-methods/channels.js"),
  (module) => module.channelsHandlers,
);
const loadChatHandlers = lazyHandlerModule(
  () => import("./server-methods/chat.js"),
  (module) => module.chatHandlers,
);
const loadCommandsHandlers = lazyHandlerModule(
  () => import("./server-methods/commands.js"),
  (module) => module.commandsHandlers,
);
const loadConfigHandlers = lazyHandlerModule(
  () => import("./server-methods/config.js"),
  (module) => module.configHandlers,
);
const loadConversationHandlers = lazyHandlerModule(
  () => import("./server-methods/conversations.js"),
  (module) => module.conversationHandlers,
);
const loadConnectHandlers = lazyHandlerModule(
  () => import("./server-methods/connect.js"),
  (module) => module.connectHandlers,
);
const loadControlUiHandlers = lazyHandlerModule(
  () => import("./server-methods/control-ui.js"),
  (module) => module.controlUiHandlers,
);
const loadCronHandlers = lazyHandlerModule(
  () => import("./server-methods/cron.js"),
  (module) => module.cronHandlers,
);
const loadDeviceHandlers = lazyHandlerModule(
  () => import("./server-methods/devices.js"),
  (module) => module.deviceHandlers,
);
const loadDevicePairSetupHandlers = lazyHandlerModule(
  () => import("./server-methods/device-pair-setup.js"),
  (module) => module.devicePairSetupHandlers,
);
const loadDiagnosticsHandlers = lazyHandlerModule(
  () => import("./server-methods/diagnostics.js"),
  (module) => module.diagnosticsHandlers,
);
const loadDoctorHandlers = lazyHandlerModule(
  () => import("./server-methods/doctor.js"),
  (module) => module.doctorHandlers,
);
const loadEnvironmentsHandlers = lazyHandlerModule(
  () => import("./server-methods/environments.js"),
  (module) => module.environmentsHandlers,
);
const loadWorktreesHandlers = lazyHandlerModule(
  () => import("./server-methods/worktrees.js"),
  (module) => module.worktreesHandlers,
);
const loadExecApprovalsHandlers = lazyHandlerModule(
  () => import("./server-methods/exec-approvals.js"),
  (module) => module.execApprovalsHandlers,
);
const loadFsHandlers = lazyHandlerModule(
  () => import("./server-methods/fs.js"),
  (module) => module.fsHandlers,
);
const loadHealthHandlers = lazyHandlerModule(
  () => import("./server-methods/health.js"),
  (module) => module.healthHandlers,
);
const loadLogsHandlers = lazyHandlerModule(
  () => import("./server-methods/logs.js"),
  (module) => module.logsHandlers,
);
const loadTerminalHandlers = lazyHandlerModule(
  () => import("./server-methods/terminal.js"),
  (module) => module.terminalHandlers,
);
const loadUiCommandHandlers = lazyHandlerModule(
  () => import("./server-methods/ui-command.js"),
  (module) => module.uiCommandHandlers,
);
const loadModelsAuthStatusHandlers = lazyHandlerModule(
  () => import("./server-methods/models-auth-status.js"),
  (module) => module.modelsAuthStatusHandlers,
);
const loadModelsHandlers = lazyHandlerModule(
  () => import("./server-methods/models.js"),
  (module) => module.modelsHandlers,
);
const loadModelsProbeHandlers = lazyHandlerModule(
  () => import("./server-methods/models-probe.js"),
  (module) => module.modelsProbeHandlers,
);
const loadNativeHookRelayHandlers = lazyHandlerModule(
  () => import("./server-methods/native-hook-relay.js"),
  (module) => module.nativeHookRelayHandlers,
);
const loadNodePendingHandlers = lazyHandlerModule(
  () => import("./server-methods/nodes-pending.js"),
  (module) => module.nodePendingHandlers,
);
const loadNodeHandlers = lazyHandlerModule(
  () => import("./server-methods/nodes.js"),
  (module) => module.nodeHandlers,
);
const loadPluginHostHookHandlers = lazyHandlerModule(
  () => import("./server-methods/plugin-host-hooks.js"),
  (module) => module.pluginHostHookHandlers,
);
const loadPluginsHandlers = lazyHandlerModule(
  () => import("./server-methods/plugins.js"),
  (module) => module.pluginsHandlers,
);
const loadMigrationsHandlers = lazyHandlerModule(
  () => import("./server-methods/migrations.js"),
  (module) => module.migrationsHandlers,
);
const loadPushHandlers = lazyHandlerModule(
  () => import("./server-methods/push.js"),
  (module) => module.pushHandlers,
);
const loadRestartHandlers = lazyHandlerModule(
  () => import("./server-methods/restart.js"),
  (module) => module.restartHandlers,
);
const loadSuspendHandlers = lazyHandlerModule(
  () => import("./server-methods/suspend.js"),
  (module) => module.suspendHandlers,
);
const loadSendHandlers = lazyHandlerModule(
  () => import("./server-methods/send.js"),
  (module) => module.sendHandlers,
);
const loadSessionsFilesHandlers = lazyHandlerModule(
  () => import("./server-methods/sessions-files.js"),
  (module) => module.sessionsFilesHandlers,
);
const loadSessionsDiffHandlers = lazyHandlerModule(
  () => import("./server-methods/sessions-diff.js"),
  (module) => module.sessionsDiffHandlers,
);
const loadSessionsHandlers = lazyHandlerModule(
  () => import("./server-methods/sessions.js"),
  (module) => module.sessionsHandlers,
);
const loadSessionCatalogHandlers = lazyHandlerModule(
  () => import("./server-methods/session-catalog.js"),
  (module) => module.sessionCatalogHandlers,
);
const loadSessionDiscussionHandlers = lazyHandlerModule(
  () => import("./server-methods/session-discussion.js"),
  (module) => module.sessionDiscussionHandlers,
);
const loadSkillsHandlers = lazyHandlerModule(
  () => import("./server-methods/skills.js"),
  (module) => module.skillsHandlers,
);
const loadSystemHandlers = lazyHandlerModule(
  () => import("./server-methods/system.js"),
  (module) => module.systemHandlers,
);
const loadTalkHandlers = lazyHandlerModule(
  () => import("./server-methods/talk.js"),
  (module) => module.talkHandlers,
);
const loadTasksHandlers = lazyHandlerModule(
  () => import("./server-methods/tasks.js"),
  (module) => module.tasksHandlers,
);
const loadTaskSuggestionsHandlers = lazyHandlerModule(
  () => import("./server-methods/task-suggestions.js"),
  (module) => module.taskSuggestionsHandlers,
);
const loadToolsCatalogHandlers = lazyHandlerModule(
  () => import("./server-methods/tools-catalog.js"),
  (module) => module.toolsCatalogHandlers,
);
const loadToolsEffectiveHandlers = lazyHandlerModule(
  () => import("./server-methods/tools-effective.js"),
  (module) => module.toolsEffectiveHandlers,
);
const loadToolsInvokeHandlers = lazyHandlerModule(
  () => import("./server-methods/tools-invoke.js"),
  (module) => module.toolsInvokeHandlers,
);
const loadMcpAppHandlers = lazyHandlerModule(
  () => import("./server-methods/mcp-app.js"),
  (module) => module.mcpAppHandlers,
);
const loadTtsHandlers = lazyHandlerModule(
  () => import("./server-methods/tts.js"),
  (module) => module.ttsHandlers,
);
const loadUpdateHandlers = lazyHandlerModule(
  () => import("./server-methods/update.js"),
  (module) => module.updateHandlers,
);
const loadUsageHandlers = lazyHandlerModule(
  () => import("./server-methods/usage.js"),
  (module) => module.usageHandlers,
);
const loadVoicewakeRoutingHandlers = lazyHandlerModule(
  () => import("./server-methods/voicewake-routing.js"),
  (module) => module.voicewakeRoutingHandlers,
);
const loadVoicewakeHandlers = lazyHandlerModule(
  () => import("./server-methods/voicewake.js"),
  (module) => module.voicewakeHandlers,
);
const loadWebHandlers = lazyHandlerModule(
  () => import("./server-methods/web.js"),
  (module) => module.webHandlers,
);
const loadSystemAgentHandlers = lazyHandlerModule(
  () => import("./server-methods/system-agent.js"),
  (module) => module.systemAgentHandlers,
);
const loadSystemChangesHandlers = lazyHandlerModule(
  () => import("./server-methods/system-changes.js"),
  (module) => module.systemChangesHandlers,
);
const loadWizardHandlers = lazyHandlerModule(
  () => import("./server-methods/wizard.js"),
  (module) => module.wizardHandlers,
);

function authorizeGatewayMethod(
  method: string,
  client: GatewayRequestOptions["client"],
  params: unknown,
  methodRegistry: GatewayMethodRegistry,
) {
  // Pre-connect and health requests are allowed through; role/scope checks require the
  // authenticated connect metadata established by the gateway handshake.
  if (!client?.connect) {
    return null;
  }
  if (method === "health") {
    return null;
  }
  const roleRaw = client.connect.role ?? "operator";
  const role = parseGatewayRole(roleRaw);
  if (!role) {
    return errorShape(ErrorCodes.INVALID_REQUEST, `unauthorized role: ${roleRaw}`);
  }
  const scopes = client.connect.scopes ?? [];
  if (!isRoleAuthorizedForMethod(role, method)) {
    return errorShape(ErrorCodes.INVALID_REQUEST, `unauthorized role: ${role}`);
  }
  if (role === "node") {
    return null;
  }
  if (scopes.includes(ADMIN_SCOPE)) {
    return null;
  }
  const registeredScope = methodRegistry.getScope(method);
  const scopeAuth = isOperatorScope(registeredScope)
    ? authorizeOperatorScopesForRequiredScope(registeredScope, scopes)
    : authorizeOperatorScopesForMethod(method, scopes, params);
  if (!scopeAuth.allowed) {
    const resolvedRequiredScopes = isOperatorScope(registeredScope)
      ? [registeredScope]
      : resolveLeastPrivilegeOperatorScopesForMethod(method, params);
    return missingScopeErrorShape({
      missingScope: scopeAuth.missingScope,
      requiredScopes:
        resolvedRequiredScopes.length > 0 ? resolvedRequiredScopes : [scopeAuth.missingScope],
    });
  }
  return null;
}

const SUSPEND_CONTROL_METHODS = new Set([
  "gateway.suspend.prepare",
  "gateway.suspend.status",
  "gateway.suspend.resume",
]);

function isGatewayMethodAllowedDuringSuspension(method: string): boolean {
  return SUSPEND_CONTROL_METHODS.has(method);
}

export const coreGatewayHandlers: GatewayRequestHandlers = {
  ...createLazyCoreHandlers({
    methods: ["connect"],
    loadHandlers: loadConnectHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: ["attach.grant", "attach.revoke"],
    loadHandlers: loadAttachHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: ["logs.tail"],
    loadHandlers: loadLogsHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: ["openclaw.changes.list"],
    loadHandlers: loadSystemChangesHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: [
      "terminal.open",
      "terminal.input",
      "terminal.resize",
      "terminal.close",
      "terminal.attach",
      "terminal.list",
      "terminal.text",
      "terminal.upload",
    ],
    loadHandlers: loadTerminalHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: ["ui.command"],
    loadHandlers: loadUiCommandHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: [
      "board.get",
      "board.update",
      "board.widget.put",
      "board.widget.grant",
      "board.widget.appView",
      "board.event",
    ],
    loadHandlers: loadBoardHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: ["voicewake.get", "voicewake.set"],
    loadHandlers: loadVoicewakeHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: ["voicewake.routing.get", "voicewake.routing.set"],
    loadHandlers: loadVoicewakeRoutingHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: ["health", "status"],
    loadHandlers: loadHealthHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: ["channels.status", "channels.start", "channels.stop", "channels.logout"],
    loadHandlers: loadChannelsHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: [
      "chat.history",
      "chat.startup",
      "chat.metadata",
      "chat.message.get",
      "chat.toolTitles",
      "chat.abort",
      "chat.send",
      "chat.inject",
    ],
    loadHandlers: loadChatHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: ["commands.list"],
    loadHandlers: loadCommandsHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: [
      "wake",
      "cron.list",
      "cron.status",
      "cron.get",
      "cron.add",
      "cron.update",
      "cron.remove",
      "cron.run",
      "cron.runs",
    ],
    loadHandlers: loadCronHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: [
      "device.pair.list",
      "device.pair.approve",
      "device.pair.reject",
      "device.pair.remove",
      "device.pair.rename",
      "device.token.rotate",
      "device.token.revoke",
    ],
    loadHandlers: loadDeviceHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: ["device.pair.setupCode"],
    loadHandlers: loadDevicePairSetupHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: ["diagnostics.stability"],
    loadHandlers: loadDiagnosticsHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: ["controlUi.githubPreview", "controlUi.sessionPullRequests"],
    loadHandlers: loadControlUiHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: [
      "doctor.memory.status",
      "doctor.memory.dreamDiary",
      "doctor.memory.backfillDreamDiary",
      "doctor.memory.resetDreamDiary",
      "doctor.memory.resetGroundedShortTerm",
      "doctor.memory.repairDreamingArtifacts",
      "doctor.memory.dedupeDreamDiary",
      "doctor.memory.remHarness",
    ],
    loadHandlers: loadDoctorHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: [
      "environments.list",
      "environments.status",
      "environments.create",
      "environments.destroy",
    ],
    loadHandlers: loadEnvironmentsHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: [
      "worktrees.list",
      "worktrees.branches",
      "worktrees.create",
      "worktrees.remove",
      "worktrees.restore",
      "worktrees.gc",
    ],
    loadHandlers: loadWorktreesHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: [
      "exec.approvals.get",
      "exec.approvals.set",
      "exec.approvals.node.get",
      "exec.approvals.node.set",
    ],
    loadHandlers: loadExecApprovalsHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: ["fs.listDir"],
    loadHandlers: loadFsHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: ["web.login.start", "web.login.wait"],
    loadHandlers: loadWebHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: ["models.list"],
    loadHandlers: loadModelsHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: ["models.probe"],
    loadHandlers: loadModelsProbeHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: ["models.authLogout", "models.authStatus"],
    loadHandlers: loadModelsAuthStatusHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: ["nativeHook.invoke"],
    loadHandlers: loadNativeHookRelayHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: ["plugins.uiDescriptors", "plugins.sessionAction"],
    loadHandlers: loadPluginHostHookHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: [
      "plugins.list",
      "plugins.search",
      "plugins.install",
      "plugins.setEnabled",
      "plugins.uninstall",
      "plugins.refresh",
    ],
    loadHandlers: loadPluginsHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: [
      "config.get",
      "config.schema",
      "config.schema.lookup",
      "config.set",
      "config.patch",
      "config.apply",
      "config.openFile",
    ],
    loadHandlers: loadConfigHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: ["wizard.start", "wizard.next", "wizard.cancel", "wizard.status"],
    loadHandlers: loadWizardHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: [
      "openclaw.chat",
      "openclaw.chat.history",
      "openclaw.approval.list",
      "openclaw.setup.detect",
      "openclaw.setup.verify",
      "openclaw.setup.activate",
      "openclaw.setup.auth.start",
      "openclaw.setup.prepare.start",
    ],
    loadHandlers: loadSystemAgentHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: [
      "talk.session.create",
      "talk.session.join",
      "talk.session.appendAudio",
      "talk.session.startTurn",
      "talk.session.endTurn",
      "talk.session.cancelTurn",
      "talk.session.cancelOutput",
      "talk.session.acknowledgeMark",
      "talk.session.submitToolResult",
      "talk.session.steer",
      "talk.session.close",
      "talk.client.create",
      "talk.client.transcript",
      "talk.client.close",
      "talk.client.toolCall",
      "talk.client.steer",
      "talk.catalog",
      "talk.config",
      "talk.speak",
      "talk.mode",
    ],
    loadHandlers: loadTalkHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: ["audit.list", "audit.activity.list"],
    loadHandlers: loadAuditHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: [
      "users.list",
      "users.self",
      "users.linkEmail",
      "users.setDisplayName",
      "users.setAvatar",
    ],
    loadHandlers: loadUsersHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: ["tasks.list", "tasks.get", "tasks.cancel"],
    loadHandlers: loadTasksHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: [
      "taskSuggestions.list",
      "taskSuggestions.create",
      "taskSuggestions.accept",
      "taskSuggestions.dismiss",
    ],
    loadHandlers: loadTaskSuggestionsHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: ["tools.catalog"],
    loadHandlers: loadToolsCatalogHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: ["tools.effective"],
    loadHandlers: loadToolsEffectiveHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: ["tools.invoke"],
    loadHandlers: loadToolsInvokeHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: [
      "mcp.app.view",
      "mcp.app.callTool",
      "mcp.app.listTools",
      "mcp.app.listResources",
      "mcp.app.listResourceTemplates",
      "mcp.app.readResource",
      "mcp.app.updateModelContext",
    ],
    loadHandlers: loadMcpAppHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: [
      "tts.status",
      "tts.enable",
      "tts.disable",
      "tts.convert",
      "tts.speak",
      "tts.setProvider",
      "tts.personas",
      "tts.setPersona",
      "tts.providers",
    ],
    loadHandlers: loadTtsHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: SKILLS_GATEWAY_METHOD_NAMES,
    loadHandlers: loadSkillsHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: [
      "sessions.catalog.list",
      "sessions.catalog.read",
      "sessions.catalog.continue",
      "sessions.catalog.archive",
    ],
    loadHandlers: loadSessionCatalogHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: ["session.discussion.info", "session.discussion.open"],
    loadHandlers: loadSessionDiscussionHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: [
      "sessions.list",
      "sessions.search",
      "sessions.cleanup",
      "sessions.subscribe",
      "sessions.unsubscribe",
      "sessions.messages.subscribe",
      "sessions.messages.unsubscribe",
      "sessions.preview",
      "sessions.describe",
      "sessions.resolve",
      "sessions.compaction.list",
      "sessions.compaction.get",
      "sessions.create",
      "sessions.compaction.branch",
      "sessions.compaction.restore",
      "sessions.branches.list",
      "sessions.branches.switch",
      "sessions.rewind",
      "sessions.fork",
      "sessions.send",
      "sessions.steer",
      "sessions.abort",
      "sessions.patch",
      "sessions.pluginPatch",
      "sessions.reset",
      "sessions.delete",
      "sessions.get",
      "sessions.compact",
      "sessions.groups.list",
      "sessions.groups.put",
      "sessions.groups.rename",
      "sessions.groups.delete",
      "sessions.dispatch",
      "sessions.reclaim",
    ],
    loadHandlers: loadSessionsHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: [
      "gateway.identity.get",
      "last-heartbeat",
      "set-heartbeats",
      "system-presence",
      "system.info",
      "system-event",
    ],
    loadHandlers: loadSystemHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: ["update.status", "update.run"],
    loadHandlers: loadUpdateHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: [
      ...NODE_PAIR_GATEWAY_METHODS,
      "node.pair.remove",
      "node.rename",
      "node.list",
      "node.describe",
      "plugin.surface.refresh",
      "node.pluginSurface.refresh",
      "node.pluginTools.update",
      "node.skills.update",
      "node.pending.pull",
      "node.pending.ack",
      "node.invoke",
      "node.invoke.progress",
      "node.invoke.result",
      "node.event",
    ],
    loadHandlers: loadNodeHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: ["node.pending.drain", "node.pending.enqueue"],
    loadHandlers: loadNodePendingHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: [
      "push.test",
      "push.web.vapidPublicKey",
      "push.web.subscribe",
      "push.web.unsubscribe",
      "push.web.test",
    ],
    loadHandlers: loadPushHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: ["gateway.restart.request", "gateway.restart.preflight"],
    loadHandlers: loadRestartHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: ["gateway.suspend.prepare", "gateway.suspend.status", "gateway.suspend.resume"],
    loadHandlers: loadSuspendHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: ["message.action", "send", "poll"],
    loadHandlers: loadSendHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: [
      "conversations.list",
      "conversations.send",
      "conversations.turn",
      "conversations.turn.cancel",
    ],
    loadHandlers: loadConversationHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: [
      "usage.status",
      "usage.cost",
      "sessions.usage",
      "sessions.usage.timeseries",
      "sessions.usage.logs",
    ],
    loadHandlers: loadUsageHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: ["agent", "agent.identity.get", "agent.wait"],
    loadHandlers: loadAgentHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: [
      "agents.list",
      "agents.create",
      "agents.update",
      "agents.delete",
      "agents.files.list",
      "agents.files.get",
      "agents.files.set",
    ],
    loadHandlers: loadAgentsHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: ["agents.workspace.list", "agents.workspace.get"],
    loadHandlers: loadAgentsWorkspaceHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: ["artifacts.list", "artifacts.get", "artifacts.download"],
    loadHandlers: loadArtifactsHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: [
      "sessions.files.list",
      "sessions.files.get",
      "sessions.files.set",
      "sessions.files.reveal",
    ],
    loadHandlers: loadSessionsFilesHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: ["sessions.diff"],
    loadHandlers: loadSessionsDiffHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: ["migrations.memory.plan", "migrations.memory.apply"],
    loadHandlers: loadMigrationsHandlers,
  }),
};

/** Builds the per-request method registry from core, plugin, and explicit extra handlers. */
function createRequestGatewayMethodRegistry(
  extraHandlers?: GatewayRequestHandlers,
): GatewayMethodRegistry {
  const activePluginRegistry = getPluginRegistryState()?.activeRegistry;
  const activePluginHandlers = activePluginRegistry?.gatewayHandlers ?? {};
  const extraHandlerEntries = Object.entries(extraHandlers ?? {});
  const pluginMethodNames = new Set(Object.keys(activePluginHandlers));
  const coreDescriptorHandlers = { ...coreGatewayHandlers };
  for (const [method, extraHandler] of extraHandlerEntries) {
    // Tests and local harnesses can override classified core methods, but plugin-provided
    // methods win so a loaded plugin cannot be shadowed by a caller-local extra handler.
    if (!pluginMethodNames.has(method) && isCoreGatewayMethodClassified(method)) {
      coreDescriptorHandlers[method] = extraHandler;
    }
  }
  const coreDescriptors = createCoreGatewayMethodDescriptors(coreDescriptorHandlers);
  for (const descriptor of coreDescriptors) {
    const extraHandler = extraHandlers?.[descriptor.name];
    if (extraHandler && !pluginMethodNames.has(descriptor.name)) {
      descriptor.handler = extraHandler;
    }
  }
  const coreMethodNames = new Set(coreDescriptors.map((descriptor) => descriptor.name));
  const auxHandlers = Object.fromEntries(
    extraHandlerEntries.filter(
      ([method]) => !pluginMethodNames.has(method) && !coreMethodNames.has(method),
    ),
  );
  return createGatewayMethodRegistry([
    ...coreDescriptors,
    ...(activePluginRegistry ? createPluginGatewayMethodDescriptors(activePluginRegistry) : []),
    ...createGatewayMethodDescriptorsFromHandlers({
      handlers: auxHandlers,
      owner: { kind: "aux", area: "gateway-extra" },
      defaultScope: ADMIN_SCOPE,
    }),
  ]);
}

/** Authorizes and dispatches one gateway JSON-RPC-style request. */
export async function handleGatewayRequest(
  opts: GatewayRequestOptions & { extraHandlers?: GatewayRequestHandlers },
): Promise<void> {
  const { req, respond, client, isWebchatConnect, context } = opts;
  // Prefer the caller-attached registry when it owns the requested method so plugin dispatch
  // metadata newer than global runtime state still authorizes and dispatches correctly. When the
  // attached snapshot does not own the method, rebuild from the live plugin registry so plugin RPC
  // methods registered after the startup snapshot stay reachable (#94127).
  const methodRegistry =
    opts.methodRegistry?.getHandler(req.method) !== undefined
      ? opts.methodRegistry
      : createRequestGatewayMethodRegistry(opts.extraHandlers);
  const authError = authorizeGatewayMethod(req.method, client, req.params, methodRegistry);
  if (authError) {
    respond(false, undefined, authError);
    return;
  }
  if (context.unavailableGatewayMethods?.has(req.method)) {
    // During startup, methods can be listed before their runtime is ready. Return the protocol
    // retry shape so clients can back off without treating startup as a permanent unknown method.
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, `${req.method} unavailable during gateway startup`, {
        retryable: true,
        retryAfterMs: GATEWAY_STARTUP_RETRY_AFTER_MS,
        details: { ...gatewayStartupUnavailableDetails(), method: req.method },
      }),
    );
    return;
  }
  const rejectRateLimitedControlPlaneWrite = (): boolean => {
    if (!methodRegistry.isControlPlaneWrite(req.method)) {
      return false;
    }
    const budget = consumeControlPlaneWriteBudget({ client, method: req.method });
    if (budget.allowed) {
      return false;
    }
    const actor = resolveControlPlaneActor(client);
    context.logGateway.warn(
      `control-plane write rate-limited method=${req.method} ${formatControlPlaneActor(actor)} retryAfterMs=${budget.retryAfterMs} key=${budget.key}`,
    );
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.UNAVAILABLE,
        `rate limit exceeded for ${req.method}; retry after ${Math.ceil(budget.retryAfterMs / 1000)}s`,
        {
          retryable: true,
          retryAfterMs: budget.retryAfterMs,
          details: {
            method: req.method,
            limit: `${CONTROL_PLANE_RATE_LIMIT_MAX_REQUESTS} per ${CONTROL_PLANE_RATE_LIMIT_WINDOW_MS / 1000}s`,
          },
        },
      ),
    );
    return true;
  };
  const isSuspendPrepare = req.method === "gateway.suspend.prepare";
  if (isSuspendPrepare && rejectRateLimitedControlPlaneWrite()) {
    // Preparation must stay protected even before it owns the root admission that it closes.
    return;
  }
  const handler = methodRegistry.getHandler(req.method) as GatewayRequestHandler | undefined;
  if (!handler) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `unknown method: ${req.method}`),
    );
    return;
  }
  const rootWorkAdmission = tryBeginGatewayRootWorkAdmission();
  if (
    req.method === "gateway.suspend.prepare" &&
    rootWorkAdmission &&
    !rootWorkAdmission.ownsRoot
  ) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, "gateway suspension cannot begin from a nested request", {
        retryable: true,
        retryAfterMs: 1_000,
        details: { method: req.method, reason: "nested-gateway-request" },
      }),
    );
    return;
  }
  if (!rootWorkAdmission && !isGatewayMethodAllowedDuringSuspension(req.method)) {
    const restartDraining = isGatewayRestartDraining();
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.UNAVAILABLE,
        `${req.method} unavailable during gateway ${restartDraining ? "restart" : "suspension"}`,
        {
          retryable: true,
          retryAfterMs: 1_000,
          details: {
            method: req.method,
            reason: restartDraining ? "gateway-restarting" : "gateway-suspending",
            phase: getGatewaySuspendAdmissionPhase(),
          },
        },
      ),
    );
    return;
  }
  if (!isSuspendPrepare && rejectRateLimitedControlPlaneWrite()) {
    // A closed admission must reject first so refused writes do not exhaust the controller's
    // budget and strand it behind rate limiting after suspension resumes.
    rootWorkAdmission?.release();
    return;
  }
  const invokeHandler = () =>
    handler({
      req,
      params: (req.params ?? {}) as Record<string, unknown>,
      client,
      isWebchatConnect,
      respond,
      context,
    });
  // All handlers run inside a request scope so that plugin runtime
  // subagent methods (e.g. context engine tools spawning sub-agents
  // during tool execution) can dispatch back into the gateway.
  // The scope also carries caller identity into plugin-owned gateway methods.
  const invokeWithRequestScope = async () =>
    await withPluginRuntimeGatewayRequestScope(
      { context, client, isWebchatConnect },
      invokeHandler,
    );
  if (!rootWorkAdmission) {
    await invokeWithRequestScope();
    return;
  }
  try {
    await rootWorkAdmission.run(invokeWithRequestScope);
  } finally {
    rootWorkAdmission.release();
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
