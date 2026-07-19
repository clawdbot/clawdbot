// Core gateway method descriptors keep handler names, auth scopes, startup availability, and write policy in one table.
import type { OperatorScope } from "../operator-scopes.js";
import {
  DYNAMIC_GATEWAY_METHOD_SCOPE,
  NODE_GATEWAY_METHOD_SCOPE,
  type GatewayMethodDescriptorInput,
  type GatewayMethodHandler,
  type GatewayMethodScope,
} from "./descriptor.js";

type CoreGatewayMethodSpec = {
  name: string;
  scope: GatewayMethodScope;
  advertise?: false;
  startup?: true;
  controlPlaneWrite?: true;
};

// This is the canonical core method policy table: every core handler must appear here so
// listing, authorization, startup availability, and write throttling stay in sync.
const CORE_GATEWAY_METHOD_SPECS: readonly CoreGatewayMethodSpec[] = [
  { name: "health", scope: "operator.read" },
  { name: "diagnostics.stability", scope: "operator.read" },
  { name: "doctor.memory.status", scope: "operator.read" },
  { name: "doctor.memory.dreamDiary", scope: "operator.read" },
  { name: "doctor.memory.backfillDreamDiary", scope: "operator.write" },
  { name: "doctor.memory.resetDreamDiary", scope: "operator.write" },
  { name: "doctor.memory.resetGroundedShortTerm", scope: "operator.write" },
  { name: "doctor.memory.repairDreamingArtifacts", scope: "operator.write" },
  { name: "doctor.memory.dedupeDreamDiary", scope: "operator.write" },
  { name: "doctor.memory.remHarness", scope: "operator.read" },
  { name: "logs.tail", scope: "operator.read" },
  { name: "channels.status", scope: "operator.read" },
  { name: "channels.start", scope: "operator.admin" },
  { name: "channels.stop", scope: "operator.admin" },
  { name: "channels.logout", scope: "operator.admin" },
  { name: "status", scope: "operator.read" },
  { name: "usage.status", scope: "operator.read" },
  { name: "usage.cost", scope: "operator.read" },
  { name: "tts.status", scope: "operator.read" },
  { name: "tts.providers", scope: "operator.read" },
  { name: "tts.personas", scope: "operator.read" },
  { name: "tts.enable", scope: "operator.write" },
  { name: "tts.disable", scope: "operator.write" },
  { name: "tts.convert", scope: "operator.write" },
  { name: "tts.setProvider", scope: "operator.write" },
  { name: "tts.setPersona", scope: "operator.write" },
  { name: "config.get", scope: "operator.read" },
  { name: "config.set", scope: "operator.admin" },
  { name: "config.apply", scope: "operator.admin", controlPlaneWrite: true },
  { name: "config.patch", scope: "operator.admin", controlPlaneWrite: true },
  { name: "config.schema", scope: "operator.admin" },
  { name: "config.schema.lookup", scope: "operator.read" },
  { name: "exec.approvals.get", scope: "operator.admin" },
  { name: "exec.approvals.set", scope: "operator.admin" },
  { name: "exec.approvals.node.get", scope: "operator.admin" },
  { name: "exec.approvals.node.set", scope: "operator.admin" },
  { name: "exec.approval.get", scope: "operator.approvals" },
  { name: "exec.approval.list", scope: "operator.approvals" },
  { name: "exec.approval.request", scope: "operator.approvals" },
  { name: "exec.approval.waitDecision", scope: "operator.approvals" },
  { name: "exec.approval.resolve", scope: "operator.approvals" },
  { name: "question.request", scope: "operator.questions" },
  { name: "question.waitAnswer", scope: "operator.questions" },
  { name: "question.resolve", scope: "operator.questions" },
  { name: "question.get", scope: "operator.questions" },
  { name: "question.list", scope: "operator.questions" },
  { name: "plugin.approval.list", scope: "operator.approvals" },
  { name: "plugin.approval.request", scope: "operator.approvals" },
  { name: "plugin.approval.waitDecision", scope: "operator.approvals" },
  { name: "plugin.approval.resolve", scope: "operator.approvals" },
  { name: "plugins.uiDescriptors", scope: "operator.read" },
  { name: "plugins.sessionAction", scope: "dynamic" },
  { name: "openclaw.chat", scope: "operator.admin" },
  { name: "openclaw.approval.list", scope: "operator.approvals" },
  { name: "openclaw.setup.detect", scope: "operator.admin" },
  // Failed activation candidates are non-mutating probes. Keep this admin-only
  // without the shared three-write budget so the automatic ladder can finish.
  { name: "openclaw.setup.activate", scope: "operator.admin" },
  { name: "openclaw.setup.auth.start", scope: "operator.admin" },
  { name: "openclaw.setup.prepare.start", scope: "operator.admin" },
  { name: "wizard.start", scope: "operator.admin" },
  { name: "wizard.next", scope: "operator.admin" },
  { name: "wizard.cancel", scope: "operator.admin" },
  { name: "wizard.status", scope: "operator.admin" },
  { name: "talk.catalog", scope: "operator.read" },
  // Params-aware: reading redacted config needs read; includeSecrets also needs talk secrets.
  { name: "talk.config", scope: "dynamic" },
  { name: "talk.client.create", scope: "operator.write" },
  { name: "talk.client.toolCall", scope: "operator.write" },
  { name: "talk.client.steer", scope: "operator.write" },
  { name: "talk.session.create", scope: "operator.write" },
  { name: "talk.session.join", scope: "operator.write" },
  { name: "talk.session.appendAudio", scope: "operator.write" },
  { name: "talk.session.startTurn", scope: "operator.write" },
  { name: "talk.session.endTurn", scope: "operator.write" },
  { name: "talk.session.cancelTurn", scope: "operator.write" },
  { name: "talk.session.cancelOutput", scope: "operator.write" },
  { name: "talk.session.acknowledgeMark", scope: "operator.write" },
  { name: "talk.session.submitToolResult", scope: "operator.write" },
  { name: "talk.session.steer", scope: "operator.write" },
  { name: "talk.session.close", scope: "operator.write" },
  { name: "talk.speak", scope: "operator.write" },
  { name: "talk.mode", scope: "operator.write" },
  { name: "commands.list", scope: "operator.read" },
  { name: "models.list", scope: "operator.read", startup: true },
  { name: "models.authStatus", scope: "operator.read" },
  { name: "models.authLogout", scope: "operator.admin", controlPlaneWrite: true },
  { name: "tools.catalog", scope: "operator.read" },
  { name: "tools.effective", scope: "operator.read", startup: true },
  { name: "tools.invoke", scope: "operator.write" },
  { name: "mcp.app.view", scope: "operator.read" },
  { name: "mcp.app.listTools", scope: "operator.read" },
  { name: "mcp.app.listResources", scope: "operator.read" },
  { name: "mcp.app.listResourceTemplates", scope: "operator.read" },
  { name: "mcp.app.readResource", scope: "operator.read" },
  { name: "mcp.app.callTool", scope: "operator.write" },
  { name: "audit.list", scope: "operator.read" },
  { name: "audit.activity.list", scope: "operator.read" },
  { name: "tasks.list", scope: "operator.read" },
  { name: "tasks.get", scope: "operator.read" },
  { name: "tasks.cancel", scope: "operator.write" },
  { name: "taskSuggestions.list", scope: "operator.read" },
  { name: "taskSuggestions.create", scope: "operator.write" },
  { name: "taskSuggestions.accept", scope: "operator.admin" },
  { name: "taskSuggestions.dismiss", scope: "operator.write" },
  { name: "environments.list", scope: "operator.read" },
  { name: "environments.status", scope: "operator.read" },
  { name: "worktrees.list", scope: "operator.read" },
  // Read-only git probe, but it accepts arbitrary host paths; keep it at the
  // same bar as starting worktree sessions instead of plain read scope.
  { name: "worktrees.branches", scope: "operator.write" },
  // Arbitrary host-path directory listing backs the new-session folder picker;
  // same trust bar as sessions.create with an explicit cwd.
  { name: "fs.listDir", scope: "operator.admin" },
  { name: "worktrees.create", scope: "operator.admin", controlPlaneWrite: true },
  { name: "worktrees.remove", scope: "operator.admin", controlPlaneWrite: true },
  { name: "worktrees.restore", scope: "operator.admin", controlPlaneWrite: true },
  { name: "worktrees.gc", scope: "operator.admin", controlPlaneWrite: true },
  { name: "agents.list", scope: "operator.read" },
  { name: "agents.create", scope: "operator.admin" },
  { name: "agents.update", scope: "operator.admin" },
  { name: "agents.delete", scope: "operator.admin" },
  { name: "agents.files.list", scope: "operator.read" },
  { name: "agents.files.get", scope: "operator.read" },
  { name: "agents.files.set", scope: "operator.admin" },
  { name: "sessions.files.list", scope: "operator.read" },
  { name: "sessions.files.get", scope: "operator.read" },
  // Workspace file writes require the same admin scope as agents.files.set.
  { name: "sessions.files.set", scope: "operator.admin" },
  { name: "sessions.files.reveal", scope: "operator.admin" },
  { name: "artifacts.list", scope: "operator.read" },
  { name: "artifacts.get", scope: "operator.read" },
  { name: "artifacts.download", scope: "operator.read" },
  { name: "skills.status", scope: "operator.read" },
  { name: "skills.search", scope: "operator.read" },
  { name: "skills.detail", scope: "operator.read" },
  { name: "skills.securityVerdicts", scope: "operator.read" },
  { name: "skills.skillCard", scope: "operator.read" },
  { name: "skills.bins", scope: "node" },
  { name: "skills.upload.begin", scope: "operator.admin" },
  { name: "skills.upload.chunk", scope: "operator.admin" },
  { name: "skills.upload.commit", scope: "operator.admin" },
  { name: "skills.install", scope: "operator.admin" },
  { name: "skills.update", scope: "operator.admin" },
  { name: "skills.curator.status", scope: "operator.read" },
  { name: "skills.curator.pin", scope: "operator.admin" },
  { name: "skills.curator.unpin", scope: "operator.admin" },
  { name: "skills.curator.restore", scope: "operator.admin" },
  { name: "skills.proposals.list", scope: "operator.read" },
  { name: "skills.proposals.inspect", scope: "operator.read" },
  { name: "skills.proposals.historyStatus", scope: "operator.read" },
  { name: "skills.proposals.historyScan", scope: "operator.admin" },
  { name: "skills.proposals.create", scope: "operator.admin" },
  { name: "skills.proposals.update", scope: "operator.admin" },
  { name: "skills.proposals.revise", scope: "operator.admin" },
  { name: "skills.proposals.requestRevision", scope: "operator.admin" },
  { name: "skills.proposals.apply", scope: "operator.admin" },
  { name: "skills.proposals.reject", scope: "operator.admin" },
  { name: "skills.proposals.quarantine", scope: "operator.admin" },
  { name: "update.status", scope: "operator.admin" },
  { name: "update.run", scope: "operator.admin", controlPlaneWrite: true },
  { name: "voicewake.get", scope: "operator.read" },
  { name: "voicewake.set", scope: "operator.write" },
  { name: "secrets.reload", scope: "operator.admin" },
  { name: "secrets.resolve", scope: "operator.admin" },
  { name: "voicewake.routing.get", scope: "operator.read" },
  { name: "voicewake.routing.set", scope: "operator.write" },
  { name: "sessions.list", scope: "operator.read", startup: true },
  { name: "sessions.subscribe", scope: "operator.read" },
  { name: "sessions.unsubscribe", scope: "operator.read" },
  { name: "sessions.messages.subscribe", scope: "operator.read" },
  { name: "sessions.messages.unsubscribe", scope: "operator.read" },
  { name: "sessions.preview", scope: "operator.read" },
  { name: "sessions.describe", scope: "operator.read" },
  { name: "sessions.compaction.list", scope: "operator.read" },
  { name: "sessions.compaction.get", scope: "operator.read" },
  { name: "sessions.compaction.branch", scope: "operator.write" },
  { name: "sessions.compaction.restore", scope: "operator.admin" },
  { name: "sessions.branches.list", scope: "operator.read" },
  { name: "sessions.branches.switch", scope: "operator.admin" },
  { name: "sessions.rewind", scope: "operator.admin" },
  { name: "sessions.fork", scope: "operator.write" },
  // Params-aware: explicit cwd can point at any host checkout and requires admin.
  { name: "sessions.create", scope: "dynamic", startup: true },
  { name: "sessions.send", scope: "operator.write", startup: true },
  { name: "sessions.abort", scope: "operator.write", startup: true },
  // Params-aware: write scope may mutate chat-organization fields
  // (label/category/icon/pinned/archived/unread); every other patch field stays
  // admin-only. Policy lives in method-scopes.ts.
  { name: "sessions.patch", scope: "dynamic" },
  { name: "sessions.pluginPatch", scope: "operator.admin" },
  { name: "sessions.cleanup", scope: "operator.admin" },
  { name: "sessions.reset", scope: "operator.admin" },
  // State-aware: write scope may delete already-archived sessions
  // (archive-then-delete); the handler enforces the archived requirement and
  // admin keeps unrestricted delete. Policy in method-scopes.ts + handler.
  { name: "sessions.delete", scope: "dynamic" },
  { name: "sessions.compact", scope: "operator.admin" },
  { name: "sessions.groups.list", scope: "operator.read" },
  { name: "sessions.groups.put", scope: "operator.write" },
  { name: "sessions.groups.rename", scope: "operator.write" },
  { name: "sessions.groups.delete", scope: "operator.write" },
  { name: "last-heartbeat", scope: "operator.read" },
  { name: "set-heartbeats", scope: "operator.admin" },
  { name: "wake", scope: "operator.write" },
  { name: "node.pair.list", scope: "operator.pairing" },
  { name: "node.pair.approve", scope: "operator.pairing" },
  { name: "node.pair.reject", scope: "operator.pairing" },
  { name: "node.pair.remove", scope: "operator.pairing" },
  { name: "device.pair.list", scope: "operator.pairing" },
  { name: "device.pair.approve", scope: "operator.pairing" },
  { name: "device.pair.reject", scope: "operator.pairing" },
  { name: "device.pair.remove", scope: "operator.pairing" },
  { name: "device.pair.rename", scope: "operator.pairing" },
  { name: "device.token.rotate", scope: "operator.pairing" },
  { name: "device.token.revoke", scope: "operator.pairing" },
  { name: "device.pair.setupCode", scope: "operator.admin", advertise: false },
  { name: "node.rename", scope: "operator.pairing" },
  { name: "node.list", scope: "operator.read" },
  { name: "node.describe", scope: "operator.read" },
  { name: "node.pluginSurface.refresh", scope: "node" },
  { name: "node.pluginTools.update", scope: "node" },
  { name: "node.skills.update", scope: "node" },
  { name: "node.pending.drain", scope: "node" },
  { name: "node.pending.enqueue", scope: "operator.write" },
  // Params-aware: host-sensitive commands raise direct invocation from write to admin.
  { name: "node.invoke", scope: "dynamic" },
  { name: "node.pending.pull", scope: "node" },
  { name: "node.pending.ack", scope: "node" },
  { name: "node.invoke.progress", scope: "node" },
  { name: "node.invoke.result", scope: "node" },
  { name: "node.event", scope: "node" },
  { name: "cron.get", scope: "operator.read" },
  { name: "cron.list", scope: "operator.read" },
  { name: "cron.status", scope: "operator.read" },
  { name: "cron.add", scope: "operator.admin" },
  { name: "cron.update", scope: "operator.admin" },
  { name: "cron.remove", scope: "operator.admin" },
  { name: "cron.run", scope: "operator.admin" },
  { name: "cron.runs", scope: "operator.read" },
  { name: "gateway.identity.get", scope: "operator.read" },
  { name: "gateway.restart.preflight", scope: "operator.read" },
  { name: "gateway.restart.request", scope: "operator.admin", controlPlaneWrite: true },
  { name: "system-presence", scope: "operator.read" },
  { name: "system-event", scope: "operator.admin" },
  { name: "message.action", scope: "operator.write" },
  { name: "conversations.send", scope: "operator.admin" },
  { name: "conversations.turn", scope: "operator.admin" },
  { name: "conversations.turn.cancel", scope: "operator.admin" },
  { name: "send", scope: "operator.write" },
  // Params-aware: ordinary turns need write; /new and /reset mutate lifecycle state as admin.
  { name: "agent", scope: "dynamic" },
  { name: "agent.identity.get", scope: "operator.read" },
  { name: "agent.wait", scope: "operator.write", startup: true },
  { name: "chat.history", scope: "operator.read", startup: true },
  { name: "chat.startup", scope: "operator.read", startup: true },
  { name: "chat.metadata", scope: "operator.read", startup: true },
  { name: "chat.message.get", scope: "operator.read", startup: true },
  { name: "chat.abort", scope: "operator.write" },
  { name: "chat.send", scope: "operator.write" },
  // Operator terminal: admin-only PTY surface. Appended to the advertised block
  // so existing advertised method indices stay stable for older clients.
  { name: "terminal.open", scope: "operator.admin" },
  { name: "terminal.input", scope: "operator.admin" },
  { name: "terminal.resize", scope: "operator.admin" },
  { name: "terminal.close", scope: "operator.admin" },
  { name: "assistant.media.get", scope: "operator.read", advertise: false },
  { name: "sessions.get", scope: "operator.read", advertise: false },
  { name: "sessions.resolve", scope: "operator.read", advertise: false },
  { name: "sessions.usage", scope: "operator.read", advertise: false },
  { name: "sessions.usage.timeseries", scope: "operator.read", advertise: false },
  { name: "sessions.usage.logs", scope: "operator.read", advertise: false },
  { name: "poll", scope: "operator.write", advertise: false },
  { name: "sessions.steer", scope: "operator.write", advertise: false },
  { name: "push.test", scope: "operator.write", advertise: false },
  { name: "attach.grant", scope: "operator.admin", controlPlaneWrite: true },
  { name: "attach.revoke", scope: "operator.admin" },
  { name: "push.web.vapidPublicKey", scope: "operator.write", advertise: false },
  { name: "push.web.subscribe", scope: "operator.write", advertise: false },
  { name: "push.web.unsubscribe", scope: "operator.write", advertise: false },
  { name: "push.web.test", scope: "operator.write", advertise: false },
  { name: "config.openFile", scope: "operator.admin", advertise: false },
  { name: "connect", scope: "operator.admin", advertise: false },
  { name: "chat.inject", scope: "operator.admin", advertise: false },
  { name: "nativeHook.invoke", scope: "operator.admin", advertise: false },
  { name: "web.login.start", scope: "operator.admin", advertise: false },
  { name: "web.login.wait", scope: "operator.admin", advertise: false },
  // Terminal detach/reattach surface. Kept together near the end so previously
  // advertised method indices stay stable for older clients; new methods append.
  { name: "terminal.attach", scope: "operator.admin" },
  { name: "terminal.list", scope: "operator.admin" },
  { name: "terminal.text", scope: "operator.admin" },
  { name: "controlUi.githubPreview", scope: "operator.read" },
  // Additive discovery methods append here so older clients keep stable indices.
  { name: "system.info", scope: "operator.read" },
  // Workspace contents stay in the documented trusted operator domain, like session and log
  // reads. Strong user/tenant isolation requires separate Gateways; see operator-scopes.md.
  { name: "agents.workspace.list", scope: "operator.read" },
  { name: "agents.workspace.get", scope: "operator.read" },
  { name: "tts.speak", scope: "operator.write" },
  { name: "plugins.list", scope: "operator.read" },
  { name: "plugins.search", scope: "operator.read" },
  { name: "plugins.install", scope: "operator.admin", controlPlaneWrite: true },
  { name: "plugins.setEnabled", scope: "operator.admin", controlPlaneWrite: true },
  { name: "plugins.uninstall", scope: "operator.admin", controlPlaneWrite: true },
  { name: "plugins.refresh", scope: "operator.admin", controlPlaneWrite: true },
  // Session PR chips read the session's own checkout metadata, matching the
  // sessions.files.* trusted-operator read domain.
  { name: "controlUi.sessionPullRequests", scope: "operator.read" },
  {
    name: "gateway.suspend.prepare",
    scope: "operator.admin",
    startup: true,
    controlPlaneWrite: true,
  },
  { name: "gateway.suspend.status", scope: "operator.read" },
  // Resume is the safety escape hatch and must not sit behind write-rate limiting.
  { name: "gateway.suspend.resume", scope: "operator.admin" },
  // Spends utility-model tokens on cache misses when the opt-in is enabled, so
  // it needs write scope despite being a read-shaped lookup.
  { name: "chat.toolTitles", scope: "operator.write" },
  // Session checkout diff reads the session's own git worktree, matching the
  // sessions.files.* trusted-operator read domain.
  { name: "sessions.diff", scope: "operator.read" },
  // Additive protocol methods append here to preserve existing advertised indices.
  { name: "openclaw.setup.verify", scope: "operator.admin" },
  // Cloud-worker mutations depend on the loaded provider registry and owned
  // reconciler, so advertise them early but gate dispatch until sidecars are ready.
  {
    name: "environments.create",
    scope: "operator.admin",
    startup: true,
    controlPlaneWrite: true,
  },
  {
    name: "environments.destroy",
    scope: "operator.admin",
    startup: true,
    controlPlaneWrite: true,
  },
  { name: "sessions.catalog.list", scope: "operator.read" },
  { name: "sessions.catalog.read", scope: "operator.read" },
  { name: "terminal.upload", scope: "operator.admin" },
  { name: "sessions.catalog.continue", scope: "operator.write" },
  { name: "sessions.catalog.archive", scope: "operator.write" },
  { name: "approval.get", scope: "operator.approvals" },
  { name: "approval.resolve", scope: "operator.approvals" },
  { name: "sessions.search", scope: "operator.read" },
  {
    name: "sessions.dispatch",
    scope: "operator.admin",
    startup: true,
    controlPlaneWrite: true,
  },
  {
    name: "sessions.reclaim",
    scope: "operator.admin",
    startup: true,
    controlPlaneWrite: true,
  },
  { name: "models.probe", scope: "operator.admin" },
  // Memory migration reads host assistant state and writes agent workspaces.
  { name: "migrations.memory.plan", scope: "operator.admin" },
  { name: "migrations.memory.apply", scope: "operator.admin", controlPlaneWrite: true },
  { name: "ui.command", scope: "operator.write" },
  { name: "approval.history", scope: "operator.approvals" },
  { name: "plugin.surface.refresh", scope: "operator.read" },
  { name: "conversations.list", scope: "operator.admin" },
] as const;

const CORE_GATEWAY_METHOD_SPEC_BY_NAME: ReadonlyMap<string, CoreGatewayMethodSpec> = new Map(
  CORE_GATEWAY_METHOD_SPECS.map((spec) => [spec.name, spec]),
);

/** Core methods that are listed early but return retryable unavailable until sidecars are ready. */
export const STARTUP_UNAVAILABLE_GATEWAY_METHODS = CORE_GATEWAY_METHOD_SPECS.filter(
  (spec) => spec.startup === true,
).map((spec) => spec.name);

/** Returns the core methods that should be advertised to external gateway clients. */
export function listCoreAdvertisedGatewayMethodNames(): string[] {
  return CORE_GATEWAY_METHOD_SPECS.filter((spec) => spec.advertise !== false).map(
    (spec) => spec.name,
  );
}

/** Returns all registered core method names, including hidden/internal compatibility methods. */
export function listCoreGatewayMethodNames(): string[] {
  return CORE_GATEWAY_METHOD_SPECS.map((spec) => spec.name);
}

/** Looks up the raw core method scope, including node and dynamic sentinel scopes. */
function resolveCoreGatewayMethodScope(method: string): GatewayMethodScope | undefined {
  return CORE_GATEWAY_METHOD_SPEC_BY_NAME.get(method)?.scope;
}

/** Looks up an operator-only core method scope, excluding node and dynamic methods. */
export function resolveCoreOperatorGatewayMethodScope(method: string): OperatorScope | undefined {
  const scope = resolveCoreGatewayMethodScope(method);
  return scope === NODE_GATEWAY_METHOD_SCOPE || scope === DYNAMIC_GATEWAY_METHOD_SCOPE
    ? undefined
    : scope;
}

/** Returns true for core methods reserved for authenticated node clients. */
export function isCoreNodeGatewayMethod(method: string): boolean {
  return resolveCoreGatewayMethodScope(method) === NODE_GATEWAY_METHOD_SCOPE;
}

/** Returns true for core methods whose required operator scope is resolved by the handler. */
export function isDynamicOperatorGatewayMethod(method: string): boolean {
  return resolveCoreGatewayMethodScope(method) === DYNAMIC_GATEWAY_METHOD_SCOPE;
}

/** Returns true when a method name has an explicit core policy entry. */
export function isCoreGatewayMethodClassified(method: string): boolean {
  return CORE_GATEWAY_METHOD_SPEC_BY_NAME.has(method);
}

/** Creates dispatch descriptors for core handlers and fails if any handler lacks policy. */
export function createCoreGatewayMethodDescriptors(
  handlers: Record<string, GatewayMethodHandler>,
): GatewayMethodDescriptorInput[] {
  const descriptors: GatewayMethodDescriptorInput[] = [];
  const specNames = new Set<string>();
  for (const spec of CORE_GATEWAY_METHOD_SPECS) {
    specNames.add(spec.name);
    const handler = handlers[spec.name];
    if (!handler) {
      continue;
    }
    descriptors.push({
      name: spec.name,
      handler,
      owner: { kind: "core", area: "gateway" },
      scope: spec.scope,
      ...(spec.advertise === false ? { advertise: false } : {}),
      ...(spec.startup === true ? { startup: "unavailable-until-sidecars" } : {}),
      ...(spec.controlPlaneWrite === true ? { controlPlaneWrite: true } : {}),
    });
  }
  for (const name of Object.keys(handlers)) {
    if (!specNames.has(name)) {
      // Unclassified core handlers would bypass scope/startup/write metadata, so fail before the
      // dispatcher can expose a method with missing policy.
      throw new Error(`gateway method handler is missing a descriptor: ${name}`);
    }
  }
  return descriptors;
}
