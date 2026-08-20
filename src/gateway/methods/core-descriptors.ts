// Core gateway method descriptors keep handler names, auth scopes, startup availability, and write policy in one table.
import type { OperatorScope } from "../operator-scopes.js";
import { isSessionProfileDependentMethod } from "../session-sharing-target-input.js";
import {
  DYNAMIC_GATEWAY_METHOD_SCOPE,
  NODE_GATEWAY_METHOD_SCOPE,
  type GatewayMethodDescriptorInput,
  type GatewayMethodHandler,
  type GatewayMethodScope,
} from "./descriptor.js";

type CoreGatewayMethodSpec = {
  name: string;
  family?: string;
  scope: GatewayMethodScope;
  since?: string;
  advertise?: false;
  startup?: true;
  controlPlaneWrite?: true;
  compatibilityRestored?: true;
  description?: string;
};

type CoreGatewayMethodMetadata = Pick<CoreGatewayMethodSpec, "name" | "scope" | "since">;
type CoreGatewayMethodPolicy = Pick<
  CoreGatewayMethodSpec,
  "advertise" | "startup" | "controlPlaneWrite" | "compatibilityRestored" | "description"
>;
type CoreGatewayMethodSpecRow = readonly [
  name: string,
  family: string | null,
  scope: GatewayMethodScope,
  since: string,
  policy?: CoreGatewayMethodPolicy,
];

const PROFILE_DEPENDENT_CORE_METHODS = new Set([
  "agent.wait",
  "ui.command",
  "users.linkEmail",
  "users.setAvatar",
  "users.setDisplayName",
]);
const PROFILE_DEPENDENT_CORE_PREFIXES = [
  "artifacts.",
  "chat.",
  "conversations.",
  "controlUi.session",
  "mcp.app.",
  "openclaw.approval.",
  "openclaw.chat",
  "progressCard.",
  "projects.",
  "secrets.",
  "session.",
  "sessions.",
  "taskSuggestions.",
  "tasks.",
  "terminal.",
  "users.prefs.",
] as const;

/** Classifies core methods whose behavior reads or mutates durable user/session ownership. */
function isCoreGatewayMethodProfileDependent(method: string): boolean {
  return (
    isSessionProfileDependentMethod(method) ||
    PROFILE_DEPENDENT_CORE_METHODS.has(method) ||
    PROFILE_DEPENDENT_CORE_PREFIXES.some((prefix) => method.startsWith(prefix))
  );
}

// This is the canonical core method policy table: every core handler must appear here so
// listing, authorization, startup availability, and write throttling stay in sync.
const CORE_GATEWAY_METHOD_SPECS = [
  ["health", "health", "operator.read", "<=2026.7"],
  ["diagnostics.stability", "diagnostics", "operator.read", "<=2026.7"],
  ["doctor.memory.status", "doctor", "operator.read", "<=2026.7"],
  ["doctor.memory.dreamDiary", "doctor", "operator.read", "<=2026.7"],
  ["doctor.memory.backfillDreamDiary", "doctor", "operator.write", "<=2026.7"],
  ["doctor.memory.resetDreamDiary", "doctor", "operator.write", "<=2026.7"],
  ["doctor.memory.resetGroundedShortTerm", "doctor", "operator.write", "<=2026.7"],
  ["doctor.memory.repairDreamingArtifacts", "doctor", "operator.write", "<=2026.7"],
  ["doctor.memory.dedupeDreamDiary", "doctor", "operator.write", "<=2026.7"],
  ["logs.tail", "logs", "operator.read", "<=2026.7"],
  ["channels.status", "channels", "operator.read", "<=2026.7"],
  ["channels.start", "channels", "operator.admin", "<=2026.7"],
  ["channels.stop", "channels", "operator.admin", "<=2026.7"],
  ["channels.logout", "channels", "operator.admin", "<=2026.7"],
  ["status", "health", "operator.read", "<=2026.7"],
  ["usage.status", "usage", "operator.read", "<=2026.7"],
  ["usage.cost", "usage", "operator.read", "<=2026.7"],
  ["tts.status", "tts", "operator.read", "<=2026.7"],
  ["tts.providers", "tts", "operator.read", "<=2026.7"],
  ["tts.personas", "tts", "operator.read", "<=2026.7"],
  ["tts.enable", "tts", "operator.write", "<=2026.7"],
  ["tts.disable", "tts", "operator.write", "<=2026.7"],
  ["tts.convert", "tts", "operator.write", "<=2026.7"],
  ["tts.setProvider", "tts", "operator.write", "<=2026.7"],
  ["tts.setPersona", "tts", "operator.write", "<=2026.7"],
  ["config.get", "config", "operator.read", "<=2026.7"],
  ["config.set", "config", "operator.admin", "<=2026.7"],
  ["config.apply", "config", "operator.admin", "<=2026.7", { controlPlaneWrite: true }],
  ["config.patch", "config", "operator.admin", "<=2026.7", { controlPlaneWrite: true }],
  ["config.schema", "config", "operator.read", "<=2026.7"],
  ["config.schema.lookup", "config", "operator.read", "<=2026.7"],
  ["exec.approvals.get", "exec-approvals", "operator.admin", "<=2026.7"],
  ["exec.approvals.set", "exec-approvals", "operator.admin", "<=2026.7"],
  ["exec.approvals.node.get", "exec-approvals", "operator.admin", "<=2026.7"],
  ["exec.approvals.node.set", "exec-approvals", "operator.admin", "<=2026.7"],
  ["exec.approval.get", null, "operator.approvals", "<=2026.7"],
  ["exec.approval.list", null, "operator.approvals", "<=2026.7"],
  ["exec.approval.request", null, "operator.approvals", "<=2026.7"],
  ["exec.approval.waitDecision", null, "operator.approvals", "<=2026.7"],
  ["exec.approval.resolve", null, "operator.approvals", "<=2026.7"],
  ["question.request", null, "operator.questions", "2026.7"],
  ["question.waitAnswer", null, "operator.questions", "2026.7"],
  ["question.resolve", null, "operator.questions", "2026.7"],
  ["question.get", null, "operator.questions", "2026.7"],
  ["question.list", null, "operator.questions", "2026.7"],
  ["plugin.approval.list", null, "operator.approvals", "<=2026.7"],
  ["plugin.approval.request", null, "operator.approvals", "<=2026.7"],
  ["plugin.approval.waitDecision", null, "operator.approvals", "<=2026.7"],
  ["plugin.approval.resolve", null, "operator.approvals", "<=2026.7"],
  ["plugins.uiDescriptors", "plugin-host-hooks", "operator.read", "<=2026.7"],
  ["plugins.sessionAction", "plugin-host-hooks", "dynamic", "<=2026.7"],
  ["openclaw.chat", "system-agent", "operator.admin", "<=2026.7"],
  ["openclaw.chat.history", "system-agent", "operator.admin", "2026.7"],
  ["openclaw.changes.list", "system-changes", "operator.admin", "<=2026.7"],
  ["openclaw.approval.list", "system-agent", "operator.approvals", "<=2026.7"],
  ["openclaw.setup.detect", "system-agent", "operator.admin", "<=2026.7"],
  // Failed activation candidates are non-mutating probes. Keep this admin-only
  // without the shared three-write budget so the automatic ladder can finish.
  ["openclaw.setup.activate", "system-agent", "operator.admin", "<=2026.7"],
  ["openclaw.setup.auth.start", "system-agent", "operator.admin", "<=2026.7"],
  ["openclaw.setup.prepare.start", "system-agent", "operator.admin", "<=2026.7"],
  ["wizard.start", "wizard", "operator.admin", "<=2026.7"],
  ["wizard.next", "wizard", "operator.admin", "<=2026.7"],
  ["wizard.cancel", "wizard", "operator.admin", "<=2026.7"],
  ["wizard.status", "wizard", "operator.admin", "<=2026.7"],
  ["talk.catalog", "talk", "operator.read", "<=2026.7"],
  // Params-aware: reading redacted config needs read; includeSecrets also needs talk secrets.
  ["talk.config", "talk", "dynamic", "<=2026.7"],
  ["talk.client.create", "talk", "operator.talk", "<=2026.7"],
  ["talk.client.transcript", "talk", "operator.talk", "<=2026.7"],
  ["talk.client.close", "talk", "operator.talk", "<=2026.7"],
  ["talk.client.toolCall", "talk", "operator.talk", "<=2026.7"],
  ["talk.client.steer", "talk", "operator.talk", "<=2026.7"],
  ["talk.session.create", "talk", "operator.talk", "<=2026.7"],
  ["talk.session.appendAudio", "talk", "operator.talk", "<=2026.7"],
  ["talk.session.cancelOutput", "talk", "operator.talk", "<=2026.7"],
  ["talk.session.acknowledgeMark", "talk", "operator.talk", "<=2026.7"],
  ["talk.session.submitToolResult", "talk", "operator.talk", "<=2026.7"],
  ["talk.session.steer", "talk", "operator.talk", "<=2026.7"],
  ["talk.session.close", "talk", "operator.talk", "<=2026.7"],
  ["talk.speak", "talk", "operator.talk", "<=2026.7"],
  ["talk.mode", "talk", "operator.talk", "<=2026.7"],
  ["commands.list", "commands", "operator.read", "<=2026.7"],
  ["models.list", "models", "operator.read", "<=2026.7", { startup: true }],
  ["models.authStatus", "models-auth-status", "operator.read", "<=2026.7"],
  [
    "models.authLogout",
    "models-auth-status",
    "operator.admin",
    "<=2026.7",
    { controlPlaneWrite: true },
  ],
  ["tools.catalog", "tools-catalog", "operator.read", "<=2026.7"],
  ["tools.effective", "tools-effective", "operator.read", "<=2026.7", { startup: true }],
  ["tools.invoke", "tools-invoke", "operator.write", "<=2026.7"],
  ["mcp.app.view", "mcp-app", "operator.read", "<=2026.7"],
  ["mcp.app.listTools", "mcp-app", "operator.read", "<=2026.7"],
  ["mcp.app.listResources", "mcp-app", "operator.read", "<=2026.7"],
  ["mcp.app.listResourceTemplates", "mcp-app", "operator.read", "<=2026.7"],
  ["mcp.app.readResource", "mcp-app", "operator.read", "<=2026.7"],
  ["mcp.app.callTool", "mcp-app", "operator.write", "<=2026.7"],
  ["mcp.app.updateModelContext", "mcp-app", "operator.write", "<=2026.7"],
  ["board.get", "board", "operator.read", "<=2026.7"],
  ["board.update", "board", "operator.write", "<=2026.7"],
  ["board.widget.put", "board", "operator.write", "<=2026.7"],
  ["board.widget.grant", "board", "operator.approvals", "<=2026.7"],
  ["board.widget.appView", "board", "operator.read", "2026.7"],
  ["board.event", "board", "operator.write", "<=2026.7"],
  ["audit.list", "audit", "operator.read", "2026.7"],
  ["audit.activity.list", "audit", "operator.read", "2026.7"],
  ["users.list", "users", "operator.read", "<=2026.7"],
  ["users.self", "users", "operator.write", "<=2026.7"],
  ["users.linkEmail", "users", "operator.admin", "<=2026.7"],
  ["users.setDisplayName", "users", "operator.write", "<=2026.7"],
  ["users.setAvatar", "users", "operator.write", "<=2026.7"],
  ["tasks.list", "tasks", "operator.read", "<=2026.7"],
  ["tasks.get", "tasks", "operator.read", "<=2026.7"],
  ["tasks.cancel", "tasks", "operator.write", "<=2026.7"],
  ["taskSuggestions.list", "task-suggestions", "operator.read", "<=2026.7"],
  ["taskSuggestions.create", "task-suggestions", "operator.write", "<=2026.7"],
  ["taskSuggestions.accept", "task-suggestions", "operator.admin", "<=2026.7"],
  ["taskSuggestions.dismiss", "task-suggestions", "operator.write", "<=2026.7"],
  ["environments.list", "environments", "operator.read", "2026.7"],
  ["environments.status", "environments", "operator.read", "2026.7"],
  ["worktrees.list", "worktrees", "operator.read", "2026.7"],
  // Read-only git probe, but it accepts arbitrary host paths; keep it at the
  // same bar as starting worktree sessions instead of plain read scope.
  ["worktrees.branches", "worktrees", "operator.write", "2026.7"],
  // Params-aware: Gateway paths start at write scope and are containment-checked
  // by the handler; node browsing remains admin-only.
  ["fs.listDir", "fs", "dynamic", "<=2026.7"],
  ["worktrees.create", "worktrees", "operator.write", "2026.7", { controlPlaneWrite: true }],
  ["worktrees.remove", "worktrees", "operator.admin", "2026.7", { controlPlaneWrite: true }],
  ["worktrees.restore", "worktrees", "operator.admin", "2026.7", { controlPlaneWrite: true }],
  ["worktrees.gc", "worktrees", "operator.admin", "2026.7", { controlPlaneWrite: true }],
  ["agents.list", "agents", "operator.read", "<=2026.7"],
  ["agents.create", "agents", "operator.admin", "<=2026.7"],
  ["agents.update", "agents", "operator.admin", "<=2026.7"],
  ["agents.delete", "agents", "operator.admin", "<=2026.7"],
  ["agents.files.list", "agents", "operator.read", "<=2026.7"],
  ["agents.files.get", "agents", "operator.read", "<=2026.7"],
  ["agents.files.set", "agents", "operator.admin", "<=2026.7"],
  ["sessions.files.list", "sessions-files", "operator.read", "<=2026.7"],
  ["sessions.files.get", "sessions-files", "operator.read", "<=2026.7"],
  // Workspace file writes require the same admin scope as agents.files.set.
  ["sessions.files.set", "sessions-files", "operator.admin", "<=2026.7"],
  ["sessions.files.reveal", "sessions-files", "operator.admin", "<=2026.7"],
  ["artifacts.list", "artifacts", "operator.read", "<=2026.7"],
  ["artifacts.get", "artifacts", "operator.read", "<=2026.7"],
  ["artifacts.download", "artifacts", "operator.read", "<=2026.7"],
  ["skills.status", "skills", "operator.read", "<=2026.7"],
  ["skills.search", "skills", "operator.read", "<=2026.7"],
  ["skills.detail", "skills", "operator.read", "<=2026.7"],
  ["skills.securityVerdicts", "skills", "operator.read", "<=2026.7"],
  ["skills.skillCard", "skills", "operator.read", "<=2026.7"],
  ["skills.bins", "skills", "node", "<=2026.7"],
  ["skills.upload.begin", "skills", "operator.admin", "<=2026.7"],
  ["skills.upload.chunk", "skills", "operator.admin", "<=2026.7"],
  ["skills.upload.commit", "skills", "operator.admin", "<=2026.7"],
  ["skills.install", "skills", "operator.admin", "<=2026.7"],
  ["skills.update", "skills", "operator.admin", "<=2026.7"],
  ["skills.curator.status", "skills", "operator.read", "<=2026.7"],
  ["skills.curator.pin", "skills", "operator.admin", "<=2026.7"],
  ["skills.curator.unpin", "skills", "operator.admin", "<=2026.7"],
  ["skills.curator.restore", "skills", "operator.admin", "<=2026.7"],
  ["skills.proposals.list", "skills", "operator.read", "<=2026.7"],
  ["skills.proposals.inspect", "skills", "operator.read", "<=2026.7"],
  ["skills.proposals.historyStatus", "skills", "operator.read", "<=2026.7"],
  ["skills.proposals.historyScan", "skills", "operator.admin", "<=2026.7"],
  ["skills.proposals.create", "skills", "operator.admin", "<=2026.7"],
  ["skills.proposals.update", "skills", "operator.admin", "<=2026.7"],
  ["skills.proposals.revise", "skills", "operator.admin", "<=2026.7"],
  ["skills.proposals.requestRevision", "skills", "operator.admin", "<=2026.7"],
  ["skills.proposals.apply", "skills", "operator.admin", "<=2026.7"],
  ["skills.proposals.reject", "skills", "operator.admin", "<=2026.7"],
  ["skills.proposals.quarantine", "skills", "operator.admin", "<=2026.7"],
  ["update.status", "update", "operator.admin", "<=2026.7"],
  ["update.run", "update", "operator.admin", "<=2026.7", { controlPlaneWrite: true }],
  ["voicewake.get", "voicewake", "operator.read", "<=2026.7"],
  ["voicewake.set", "voicewake", "operator.write", "<=2026.7"],
  ["secrets.reload", null, "operator.admin", "<=2026.7"],
  ["secrets.resolve", null, "operator.admin", "<=2026.7"],
  ["voicewake.routing.get", "voicewake-routing", "operator.read", "<=2026.7"],
  ["sessions.list", "sessions-read", "operator.read", "<=2026.7", { startup: true }],
  ["sessions.subscribe", "sessions-subscriptions", "operator.read", "<=2026.7"],
  ["sessions.messages.subscribe", "sessions-subscriptions", "operator.read", "<=2026.7"],
  ["sessions.messages.unsubscribe", "sessions-subscriptions", "operator.read", "<=2026.7"],
  ["sessions.viewers.set", "sessions-subscriptions", "operator.read", "2026.7"],
  ["sessions.preview", "sessions-read", "operator.read", "<=2026.7"],
  ["sessions.describe", "sessions-read", "operator.read", "<=2026.7"],
  ["sessions.compaction.list", "sessions-compaction-queries", "operator.read", "<=2026.7"],
  ["sessions.compaction.branch", "sessions-compaction-checkpoints", "operator.write", "<=2026.7"],
  ["sessions.compaction.restore", "sessions-compaction-checkpoints", "operator.admin", "<=2026.7"],
  ["sessions.branches.list", "sessions-rewind", "operator.read", "<=2026.7"],
  ["sessions.branches.switch", "sessions-rewind", "operator.admin", "<=2026.7"],
  ["sessions.rewind", "sessions-rewind", "operator.admin", "<=2026.7"],
  ["sessions.fork", "sessions-rewind", "operator.write", "<=2026.7"],
  // Params-aware plus state-aware: the handler permits write-scoped cwd only
  // inside configured agent workspaces; execNode and other privileged modes stay admin.
  ["sessions.create", "sessions-create", "dynamic", "<=2026.7", { startup: true }],
  ["sessions.recover", "sessions-recover", "operator.write", "2026.8", { startup: true }],
  ["sessions.send", "sessions-messaging", "operator.write", "<=2026.7", { startup: true }],
  ["sessions.abort", "sessions-abort", "operator.write", "<=2026.7", { startup: true }],
  // Dynamic mutation scope policy, including write-scoped model overrides, lives
  // in shared/session-method-scopes.ts. The admin-only sticky configured-default
  // persistence guard lives in server-methods/sessions-mutations.ts.
  ["sessions.patch", "sessions-mutations", "dynamic", "<=2026.7"],
  ["sessions.pluginPatch", "sessions-mutations", "operator.admin", "<=2026.7"],
  ["sessions.cleanup", "sessions-read", "operator.admin", "<=2026.7"],
  ["sessions.reset", "sessions-mutations", "operator.admin", "<=2026.7"],
  // State-aware: write scope may delete already-archived sessions
  // (archive-then-delete); the handler enforces the archived requirement and
  // admin keeps unrestricted delete. Shared policy plus the handler own both checks.
  ["sessions.delete", "sessions-delete", "dynamic", "<=2026.7"],
  ["sessions.compact", "sessions-compact", "operator.admin", "<=2026.7"],
  ["sessions.groups.list", "sessions-groups", "operator.read", "<=2026.7"],
  ["sessions.groups.defaults", "sessions-groups", "operator.write", "2026.8"],
  ["sessions.groups.put", "sessions-groups", "operator.write", "<=2026.7"],
  ["sessions.groups.rename", "sessions-groups", "operator.write", "<=2026.7"],
  ["sessions.groups.update", "sessions-groups", "operator.write", "2026.8"],
  ["sessions.groups.delete", "sessions-groups", "operator.write", "<=2026.7"],
  ["last-heartbeat", "system", "operator.read", "<=2026.7"],
  ["set-heartbeats", "system", "operator.admin", "<=2026.7"],
  ["wake", "cron", "operator.write", "<=2026.7"],
  ["node.pair.list", "nodes", "operator.pairing", "<=2026.7"],
  ["node.pair.approve", "nodes", "operator.pairing", "<=2026.7"],
  ["node.pair.reject", "nodes", "operator.pairing", "<=2026.7"],
  ["node.pair.remove", "nodes", "operator.pairing", "<=2026.7"],
  ["device.pair.list", "devices", "operator.pairing", "<=2026.7"],
  ["device.pair.approve", "devices", "operator.pairing", "<=2026.7"],
  ["device.pair.reject", "devices", "operator.pairing", "<=2026.7"],
  ["device.pair.remove", "devices", "operator.pairing", "<=2026.7"],
  ["device.pair.rename", "devices", "operator.pairing", "2026.7"],
  ["device.token.rotate", "devices", "operator.pairing", "<=2026.7"],
  ["device.token.revoke", "devices", "operator.pairing", "<=2026.7"],
  [
    "device.pair.setupCode",
    "device-pair-setup",
    "operator.admin",
    "<=2026.7",
    { advertise: false },
  ],
  [
    "device.pair.setupStatus",
    "device-pair-setup",
    "operator.admin",
    "2026.8",
    { advertise: false },
  ],
  ["node.rename", "nodes", "operator.pairing", "<=2026.7"],
  ["node.list", "nodes", "operator.read", "<=2026.7"],
  ["node.describe", "nodes", "operator.read", "<=2026.7"],
  ["node.pluginSurface.refresh", "nodes", "node", "<=2026.7"],
  ["node.pluginTools.update", "nodes", "node", "<=2026.7"],
  ["node.skills.update", "nodes", "node", "<=2026.7"],
  ["node.runnerInventory.update", "nodes", "node", "2026.8", { advertise: false }],
  ["node.pending.drain", "nodes-pending", "node", "<=2026.7"],
  ["node.pending.enqueue", "nodes-pending", "operator.write", "<=2026.7"],
  // Params-aware: host-sensitive commands raise direct invocation from write to admin.
  ["node.invoke", "nodes", "dynamic", "<=2026.7"],
  ["node.pending.pull", "nodes", "node", "<=2026.7"],
  ["node.pending.ack", "nodes", "node", "<=2026.7"],
  ["node.invoke.progress", "nodes", "node", "<=2026.7"],
  ["node.invoke.result", "nodes", "node", "<=2026.7"],
  ["node.event", "nodes", "node", "<=2026.7"],
  ["cron.get", "cron", "operator.read", "<=2026.7"],
  ["cron.list", "cron", "operator.read", "<=2026.7"],
  ["cron.status", "cron", "operator.read", "<=2026.7"],
  ["cron.scratch.get", "cron", "operator.admin", "2026.7"],
  ["cron.scratch.set", "cron", "operator.admin", "2026.7"],
  ["cron.add", "cron", "operator.admin", "<=2026.7"],
  ["cron.update", "cron", "operator.admin", "<=2026.7"],
  ["cron.remove", "cron", "operator.admin", "<=2026.7"],
  ["cron.run", "cron", "operator.admin", "<=2026.7"],
  ["cron.runs", "cron", "operator.read", "<=2026.7"],
  ["gateway.identity.get", "system", "operator.read", "<=2026.7"],
  // Deprecated read-only compatibility preview; new restart flows request the
  // restart directly, while atomic host suspension uses gateway.suspend.prepare.
  [
    "gateway.restart.preflight",
    "restart",
    "operator.read",
    "<=2026.7",
    { compatibilityRestored: true },
  ],
  ["gateway.restart.request", "restart", "operator.admin", "<=2026.7", { controlPlaneWrite: true }],
  ["system-presence", "system", "operator.read", "<=2026.7"],
  ["system-event", "system", "operator.admin", "<=2026.7"],
  ["message.action", "send", "operator.write", "<=2026.7"],
  ["conversations.send", "conversations", "operator.admin", "<=2026.7"],
  ["conversations.turn", "conversations", "operator.admin", "<=2026.7"],
  ["conversations.turn.cancel", "conversations", "operator.admin", "<=2026.7"],
  ["send", "send", "operator.write", "<=2026.7"],
  // Params-aware: ordinary turns need write; /new and /reset mutate lifecycle state as admin.
  ["agent", "agent", "dynamic", "<=2026.7", { startup: true }],
  ["agent.identity.get", "agent-identity", "operator.read", "<=2026.7"],
  ["agent.wait", "agent", "operator.write", "<=2026.7", { startup: true }],
  ["chat.history", "chat", "operator.read", "<=2026.7", { startup: true }],
  ["chat.startup", "chat", "operator.read", "<=2026.7", { startup: true }],
  ["chat.metadata", "chat", "operator.read", "<=2026.7", { startup: true }],
  ["chat.message.get", "chat", "operator.read", "<=2026.7", { startup: true }],
  ["chat.abort", "chat", "operator.write", "<=2026.7"],
  ["chat.send", "chat", "operator.write", "<=2026.7", { startup: true }],
  // Operator terminal: admin-only PTY surface. Appended to the advertised block
  // so existing advertised method indices stay stable for older clients.
  ["terminal.open", "terminal", "operator.admin", "2026.7"],
  ["terminal.input", "terminal", "operator.admin", "2026.7"],
  ["terminal.resize", "terminal", "operator.admin", "2026.7"],
  ["terminal.close", "terminal", "operator.admin", "2026.7"],
  // DM pairing is additive to the advertised method list. Keep it appended so
  // older clients retain every pre-existing advertised method index.
  ["channels.pairing.list", "channel-pairing", "operator.pairing", "2026.7"],
  ["channels.pairing.approve", "channel-pairing", "dynamic", "2026.7"],
  ["channels.pairing.dismiss", "channel-pairing", "operator.pairing", "2026.7"],
  ["assistant.media.get", null, "operator.read", "<=2026.7", { advertise: false }],
  ["sessions.get", "sessions-read", "operator.read", "<=2026.7", { advertise: false }],
  ["sessions.resolve", "sessions-read", "operator.read", "<=2026.7", { advertise: false }],
  ["sessions.usage", "usage", "operator.read", "<=2026.7", { advertise: false }],
  ["sessions.usage.timeseries", "usage", "operator.read", "<=2026.7", { advertise: false }],
  ["sessions.usage.logs", "usage", "operator.read", "<=2026.7", { advertise: false }],
  ["poll", "send", "operator.write", "<=2026.7", { advertise: false }],
  [
    "sessions.steer",
    "sessions-messaging",
    "operator.write",
    "<=2026.7",
    {
      advertise: false,
      description:
        "Deprecated alias for chat.send queueMode interrupt; removal per protocol deprecation policy.",
    },
  ],
  ["push.test", "push", "operator.write", "<=2026.7", { advertise: false }],
  ["attach.grant", "attach", "operator.admin", "<=2026.7", { controlPlaneWrite: true }],
  ["attach.revoke", "attach", "operator.admin", "<=2026.7"],
  ["push.web.vapidPublicKey", "push", "operator.write", "<=2026.7", { advertise: false }],
  ["push.web.subscribe", "push", "operator.write", "<=2026.7", { advertise: false }],
  ["push.web.unsubscribe", "push", "operator.write", "<=2026.7", { advertise: false }],
  ["push.web.test", "push", "operator.write", "<=2026.7", { advertise: false }],
  ["config.openFile", "config", "operator.admin", "<=2026.7", { advertise: false }],
  ["connect", "connect", "operator.admin", "<=2026.7", { advertise: false }],
  ["chat.inject", "chat", "operator.admin", "<=2026.7", { advertise: false }],
  ["nativeHook.invoke", "native-hook-relay", "operator.admin", "<=2026.7", { advertise: false }],
  ["web.login.start", "web", "operator.admin", "<=2026.7", { advertise: false }],
  ["web.login.wait", "web", "operator.admin", "<=2026.7", { advertise: false }],
  // Terminal detach/reattach surface. Kept together near the end so previously
  // advertised method indices stay stable for older clients; new methods append.
  ["terminal.attach", "terminal", "operator.admin", "2026.7"],
  ["terminal.list", "terminal", "operator.admin", "2026.7"],
  ["controlUi.githubPreview", "control-ui", "operator.read", "<=2026.7"],
  // Additive discovery methods append here so older clients keep stable indices.
  ["system.info", "system", "operator.read", "<=2026.7"],
  // Workspace contents stay in the documented trusted operator domain, like session and log
  // reads. Strong user/tenant isolation requires separate Gateways; see operator-scopes.md.
  ["agents.workspace.list", "agents-workspace", "operator.read", "2026.7"],
  ["agents.workspace.get", "agents-workspace", "operator.read", "2026.7"],
  ["tts.speak", "tts", "operator.write", "2026.7"],
  ["plugins.list", "plugins", "operator.read", "<=2026.7"],
  ["plugins.search", "plugins", "operator.read", "<=2026.7"],
  ["plugins.install", "plugins", "operator.admin", "<=2026.7", { controlPlaneWrite: true }],
  ["plugins.setEnabled", "plugins", "operator.admin", "<=2026.7", { controlPlaneWrite: true }],
  ["plugins.uninstall", "plugins", "operator.admin", "<=2026.7", { controlPlaneWrite: true }],
  ["plugins.refresh", "plugins", "operator.admin", "<=2026.7", { controlPlaneWrite: true }],
  // Session PR chips read the session's own checkout metadata, matching the
  // sessions.files.* trusted-operator read domain.
  ["controlUi.sessionPullRequests.subscribe", "control-ui", "operator.read", "2026.7"],
  ["controlUi.sessionPreview", "control-ui", "operator.read", "2026.8"],
  [
    "gateway.suspend.prepare",
    "suspend",
    "operator.admin",
    "2026.7",
    { startup: true, controlPlaneWrite: true },
  ],
  ["gateway.suspend.status", "suspend", "operator.read", "2026.7"],
  // Resume is the safety escape hatch and must not sit behind write-rate limiting.
  ["gateway.suspend.resume", "suspend", "operator.admin", "2026.7"],
  // Spends utility-model tokens on cache misses when the opt-in is enabled, so
  // it needs write scope despite being a read-shaped lookup.
  ["chat.toolTitles", "chat", "operator.write", "<=2026.7"],
  // Session checkout diff reads the session's own git worktree, matching the
  // sessions.files.* trusted-operator read domain.
  ["sessions.diff", "sessions-diff", "operator.read", "<=2026.7"],
  // Additive protocol methods append here to preserve existing advertised indices.
  ["openclaw.setup.verify", "system-agent", "operator.admin", "<=2026.7"],
  // Cloud-worker mutations depend on the loaded provider registry and owned
  // reconciler, so advertise them early but gate dispatch until sidecars are ready.
  [
    "environments.create",
    "environments",
    "operator.admin",
    "2026.7",
    { startup: true, controlPlaneWrite: true },
  ],
  [
    "environments.destroy",
    "environments",
    "operator.admin",
    "2026.7",
    { startup: true, controlPlaneWrite: true },
  ],
  ["sessions.catalog.list", "session-catalog", "operator.read", "2026.7"],
  ["sessions.catalog.read", "session-catalog", "operator.read", "2026.7"],
  ["terminal.upload", "terminal", "operator.admin", "2026.7"],
  ["sessions.catalog.continue", "session-catalog", "operator.write", "2026.7"],
  ["sessions.catalog.archive", "session-catalog", "operator.write", "2026.7"],
  ["approval.get", null, "operator.approvals", "2026.7"],
  ["approval.resolve", null, "operator.approvals", "2026.7"],
  ["sessions.search", "sessions-read", "operator.read", "<=2026.7"],
  [
    "sessions.dispatch",
    "sessions-dispatch",
    "dynamic",
    "2026.7",
    { startup: true, controlPlaneWrite: true },
  ],
  [
    "sessions.reclaim",
    "sessions-dispatch",
    "operator.write",
    "2026.7",
    { startup: true, controlPlaneWrite: true },
  ],
  ["models.probe", "models-probe", "operator.admin", "<=2026.7"],
  // Memory migration reads host assistant state and writes agent workspaces.
  ["migrations.memory.plan", "migrations", "operator.admin", "2026.7"],
  [
    "migrations.memory.apply",
    "migrations",
    "operator.admin",
    "2026.7",
    { controlPlaneWrite: true },
  ],
  ["ui.command", "ui-command", "operator.write", "2026.7"],
  ["approval.history", null, "operator.approvals", "2026.7"],
  ["plugin.surface.refresh", "nodes", "operator.read", "<=2026.7"],
  ["conversations.list", "conversations", "operator.admin", "<=2026.7"],
  ["session.discussion.info", "session-discussion", "operator.read", "2026.7"],
  ["session.discussion.open", "session-discussion", "operator.write", "2026.7"],
  ["board.prompt.authorize", "board", "operator.read", "2026.7"],
  ["board.data.read", "board", "operator.read", "2026.7"],
  ["board.action", "board", "operator.write", "2026.7"],
  ["sessions.observer.visibility", "session-observer-rpc", "operator.read", "2026.7"],
  // Additive phase-2 collaboration methods append so older advertised indices stay stable.
  ["session.visibility.set", "sessions-sharing", "operator.write", "2026.7"],
  ["session.members.list", "sessions-sharing", "operator.read", "2026.7"],
  ["session.members.add", "sessions-sharing", "operator.write", "2026.7"],
  ["session.members.remove", "sessions-sharing", "operator.write", "2026.7"],
  ["session.suggestions.add", "sessions-suggestions", "operator.write", "2026.7"],
  ["session.suggestions.list", "sessions-suggestions", "operator.read", "2026.7"],
  ["session.suggestions.resolve", "sessions-suggestions", "operator.write", "2026.7"],
  ["session.typing", "sessions-suggestions", "operator.write", "2026.7"],
  // Companion state is process-local and its runner is hard-restricted to
  // read-only workspace and exact-session tools.
  ["sessions.companion.ask", "session-companion-rpc", "operator.read", "2026.7"],
  ["sessions.companion.state", "session-companion-rpc", "operator.read", "2026.7"],
  [
    "sessions.companion.reset",
    "session-companion-rpc",
    "operator.write",
    "2026.7",
    { controlPlaneWrite: true },
  ],
  ["memory.search", "memory-search", "operator.read", "2026.7"],
  // Additive Skill Workshop methods append so older advertised indices stay stable.
  ["skills.proposals.events.list", "skills", "operator.read", "2026.7"],
  ["skills.proposals.evaluate", "skills", "operator.admin", "2026.7", { controlPlaneWrite: true }],
  // Additive hook status RPC appends so older advertised method indices stay stable.
  ["hooks.status", "hooks-status", "operator.read", "2026.7"],
  // Additive task recovery RPCs append so older advertised method indices stay stable.
  ["tasks.retry", "tasks", "operator.write", "2026.7"],
  ["tasks.dismiss", "tasks", "operator.write", "2026.7"],
  // Additive audit inspection appends so older advertised method indices stay stable.
  ["audit.run.inspect", "audit", "operator.read", "2026.7"],
  ["sessions.patchMany", "sessions-mutations", "dynamic", "2026.8"],
  // Update campaign mutations share update.run's admin and control-plane write policy.
  ["update.hold", "update", "operator.admin", "2026.8", { controlPlaneWrite: true }],
  // Additive catalog terminal start appends so older advertised indices stay stable.
  ["sessions.catalog.startTerminal", "session-catalog", "operator.admin", "2026.8"],
  ["worker.desktop.observe", "environments", "operator.admin", "2026.8", { startup: true }],
  // First-class project RPCs append so every older advertised index remains stable.
  ["projects.list", "projects", "operator.read", "2026.8"],
  ["projects.register", "projects", "operator.admin", "2026.8"],
  ["projects.remove", "projects", "operator.admin", "2026.8"],
  ["worker.desktop.launch", "environments", "operator.admin", "2026.8", { startup: true }],
  // Store CRUD shares the auxiliary secrets runtime owner and appends for stable indices.
  ["secrets.store.list", null, "operator.admin", "2026.8"],
  ["secrets.store.set", null, "operator.admin", "2026.8", { controlPlaneWrite: true }],
  ["secrets.store.delete", null, "operator.admin", "2026.8", { controlPlaneWrite: true }],
  // Self-scoped preferences append so every older advertised index remains stable.
  ["users.prefs.get", "users", "operator.read", "2026.8"],
  ["users.prefs.set", "users", "operator.write", "2026.8"],
  ["projects.add", "projects", "operator.write", "2026.8", { controlPlaneWrite: true }],
  [
    "projects.searchRemote",
    "projects",
    "operator.read",
    "2026.8",
    { description: "Search GitHub repositories that can be cloned as managed projects." },
  ],
  ["desktop.observe", "environments", "operator.admin", "2026.8", { startup: true }],
  ["desktop.launch", "environments", "operator.admin", "2026.8", { startup: true }],
  // Live device scope upgrades are additive so every older advertised index stays stable.
  ["device.scopes.requestUpgrade", "devices", "operator.read", "2026.8"],
  ["device.scopes.waitUpgrade", "devices", "operator.read", "2026.8"],
  ["portal.list", "portals", "operator.read", "2026.8"],
  ["portal.open", "portals", "operator.write", "2026.8", { controlPlaneWrite: true }],
  ["portal.close", "portals", "operator.write", "2026.8", { controlPlaneWrite: true }],
  [
    "sessions.move",
    "sessions-dispatch",
    "dynamic",
    "2026.8",
    { startup: true, controlPlaneWrite: true },
  ],
  ["sessions.assignOwner", "sessions-mutations", "operator.write", "2026.8"],
  ["progressCard.get", "progress-card", "operator.read", "2026.8"],
  ["progressCard.put", "progress-card", "operator.write", "2026.8"],
  ["tools.github.status", "tools-github", "operator.read", "2026.8"],
  [
    "tools.github.configure",
    "tools-github",
    "operator.admin",
    "2026.8",
    { controlPlaneWrite: true },
  ],
  [
    "tools.github.authorize.start",
    "tools-github",
    "operator.admin",
    "2026.8",
    { controlPlaneWrite: true },
  ],
  [
    "tools.github.authorize.poll",
    "tools-github",
    "operator.admin",
    "2026.8",
    { controlPlaneWrite: true },
  ],
  [
    "tools.github.authorize.cancel",
    "tools-github",
    "operator.admin",
    "2026.8",
    { controlPlaneWrite: true },
  ],
  [
    "sessions.github.publish",
    "sessions-github",
    "operator.write",
    "2026.8",
    { controlPlaneWrite: true },
  ],
  ["diagnostics.lanes", "diagnostics", "operator.read", "2026.8"],
] as const satisfies readonly CoreGatewayMethodSpecRow[];

export type CoreGatewayHandlerFamily = Exclude<(typeof CORE_GATEWAY_METHOD_SPECS)[number][1], null>;

const CORE_GATEWAY_METHOD_SPEC_LIST: readonly CoreGatewayMethodSpec[] =
  CORE_GATEWAY_METHOD_SPECS.map(([name, family, scope, since, policy]) => {
    const spec: CoreGatewayMethodSpec = { name, scope, since };
    const normalizedPolicy: CoreGatewayMethodPolicy | undefined = policy;
    if (family) {
      spec.family = family;
    }
    if (normalizedPolicy?.advertise === false) {
      spec.advertise = false;
    }
    if (normalizedPolicy?.startup === true) {
      spec.startup = true;
    }
    if (normalizedPolicy?.controlPlaneWrite === true) {
      spec.controlPlaneWrite = true;
    }
    if (normalizedPolicy?.compatibilityRestored === true) {
      spec.compatibilityRestored = true;
    }
    if (normalizedPolicy?.description) {
      spec.description = normalizedPolicy.description;
    }
    return spec;
  });

const CORE_GATEWAY_METHOD_SPEC_BY_NAME: ReadonlyMap<string, CoreGatewayMethodSpec> = new Map(
  CORE_GATEWAY_METHOD_SPEC_LIST.map((spec) => [spec.name, spec]),
);

/** Core methods that are listed early but return retryable unavailable until sidecars are ready. */
export const STARTUP_UNAVAILABLE_GATEWAY_METHODS = CORE_GATEWAY_METHOD_SPEC_LIST.filter(
  (spec) => spec.startup === true,
).map((spec) => spec.name);

/** Returns the core methods that should be advertised to external gateway clients. */
export function listCoreAdvertisedGatewayMethodNames(): string[] {
  return CORE_GATEWAY_METHOD_SPEC_LIST.filter((spec) => spec.advertise !== false).map(
    (spec) => spec.name,
  );
}

/** Returns all registered core method names, including hidden/internal compatibility methods. */
export function listCoreGatewayMethodNames(): string[] {
  return listCoreGatewayMethodMetadata().map((spec) => spec.name);
}

/** Returns the public metadata emitted for every core gateway method. */
export function listCoreGatewayMethodMetadata(): readonly CoreGatewayMethodMetadata[] {
  return CORE_GATEWAY_METHOD_SPEC_LIST.map(({ name, scope, since }) => ({ name, scope, since }));
}

/** Groups lazy-owned core methods by the module family that dispatches them. */
export function listCoreGatewayHandlerMethodNames(): ReadonlyMap<
  CoreGatewayHandlerFamily,
  readonly string[]
> {
  const methodsByFamily = new Map<CoreGatewayHandlerFamily, string[]>();
  for (const spec of CORE_GATEWAY_METHOD_SPEC_LIST) {
    if (!spec.family) {
      continue;
    }
    const family = spec.family as CoreGatewayHandlerFamily;
    const methods = methodsByFamily.get(family) ?? [];
    methods.push(spec.name);
    methodsByFamily.set(family, methods);
  }
  return methodsByFamily;
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
  for (const spec of CORE_GATEWAY_METHOD_SPEC_LIST) {
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
      profileAccess: isCoreGatewayMethodProfileDependent(spec.name) ? "required" : "independent",
      ...(spec.since ? { since: spec.since } : {}),
      ...(spec.advertise === false ? { advertise: false } : {}),
      ...(spec.startup === true ? { startup: "unavailable-until-sidecars" } : {}),
      ...(spec.controlPlaneWrite === true ? { controlPlaneWrite: true } : {}),
      ...(spec.description ? { description: spec.description } : {}),
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
