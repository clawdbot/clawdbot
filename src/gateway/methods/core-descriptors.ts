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

export const CORE_GATEWAY_METHOD_SPECS: readonly CoreGatewayMethodSpec[] = [
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
  { name: "plugin.approval.list", scope: "operator.approvals" },
  { name: "plugin.approval.request", scope: "operator.approvals" },
  { name: "plugin.approval.waitDecision", scope: "operator.approvals" },
  { name: "plugin.approval.resolve", scope: "operator.approvals" },
  { name: "plugins.uiDescriptors", scope: "operator.read" },
  { name: "plugins.sessionAction", scope: "dynamic" },
  { name: "wizard.start", scope: "operator.admin" },
  { name: "wizard.next", scope: "operator.admin" },
  { name: "wizard.cancel", scope: "operator.admin" },
  { name: "wizard.status", scope: "operator.admin" },
  { name: "talk.catalog", scope: "operator.read" },
  { name: "talk.config", scope: "operator.read" },
  { name: "talk.client.create", scope: "operator.write" },
  { name: "talk.client.toolCall", scope: "operator.write" },
  { name: "talk.session.create", scope: "operator.write" },
  { name: "talk.session.join", scope: "operator.write" },
  { name: "talk.session.appendAudio", scope: "operator.write" },
  { name: "talk.session.startTurn", scope: "operator.write" },
  { name: "talk.session.endTurn", scope: "operator.write" },
  { name: "talk.session.cancelTurn", scope: "operator.write" },
  { name: "talk.session.cancelOutput", scope: "operator.write" },
  { name: "talk.session.submitToolResult", scope: "operator.write" },
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
  { name: "tasks.list", scope: "operator.read" },
  { name: "tasks.get", scope: "operator.read" },
  { name: "tasks.cancel", scope: "operator.write" },
  { name: "environments.list", scope: "operator.read" },
  { name: "environments.status", scope: "operator.read" },
  { name: "agents.list", scope: "operator.read" },
  { name: "agents.create", scope: "operator.admin" },
  { name: "agents.update", scope: "operator.admin" },
  { name: "agents.delete", scope: "operator.admin" },
  { name: "agents.files.list", scope: "operator.read" },
  { name: "agents.files.get", scope: "operator.read" },
  { name: "agents.files.set", scope: "operator.admin" },
  { name: "artifacts.list", scope: "operator.read" },
  { name: "artifacts.get", scope: "operator.read" },
  { name: "artifacts.download", scope: "operator.read" },
  { name: "skills.status", scope: "operator.read" },
  { name: "skills.search", scope: "operator.read" },
  { name: "skills.detail", scope: "operator.read" },
  { name: "skills.bins", scope: "node" },
  { name: "skills.upload.begin", scope: "operator.admin" },
  { name: "skills.upload.chunk", scope: "operator.admin" },
  { name: "skills.upload.commit", scope: "operator.admin" },
  { name: "skills.install", scope: "operator.admin" },
  { name: "skills.update", scope: "operator.admin" },
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
  { name: "sessions.create", scope: "operator.write", startup: true },
  { name: "sessions.send", scope: "operator.write", startup: true },
  { name: "sessions.abort", scope: "operator.write", startup: true },
  { name: "sessions.patch", scope: "operator.admin" },
  { name: "sessions.pluginPatch", scope: "operator.admin" },
  { name: "sessions.cleanup", scope: "operator.admin" },
  { name: "sessions.reset", scope: "operator.admin" },
  { name: "sessions.delete", scope: "operator.admin" },
  { name: "sessions.compact", scope: "operator.admin" },
  { name: "last-heartbeat", scope: "operator.read" },
  { name: "set-heartbeats", scope: "operator.admin" },
  { name: "wake", scope: "operator.write" },
  { name: "node.pair.request", scope: "operator.pairing" },
  { name: "node.pair.list", scope: "operator.pairing" },
  { name: "node.pair.approve", scope: "operator.pairing" },
  { name: "node.pair.reject", scope: "operator.pairing" },
  { name: "node.pair.remove", scope: "operator.pairing" },
  { name: "node.pair.verify", scope: "operator.pairing" },
  { name: "device.pair.list", scope: "operator.pairing" },
  { name: "device.pair.approve", scope: "operator.pairing" },
  { name: "device.pair.reject", scope: "operator.pairing" },
  { name: "device.pair.remove", scope: "operator.pairing" },
  { name: "device.token.rotate", scope: "operator.pairing" },
  { name: "device.token.revoke", scope: "operator.pairing" },
  { name: "node.rename", scope: "operator.pairing" },
  { name: "node.list", scope: "operator.read" },
  { name: "node.describe", scope: "operator.read" },
  { name: "node.pluginSurface.refresh", scope: "node" },
  { name: "node.pending.drain", scope: "node" },
  { name: "node.pending.enqueue", scope: "operator.write" },
  { name: "node.invoke", scope: "operator.write" },
  { name: "node.pending.pull", scope: "node" },
  { name: "node.pending.ack", scope: "node" },
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
  { name: "send", scope: "operator.write" },
  { name: "agent", scope: "operator.write" },
  { name: "agent.identity.get", scope: "operator.read" },
  { name: "agent.wait", scope: "operator.write", startup: true },
  { name: "chat.history", scope: "operator.read", startup: true },
  { name: "chat.abort", scope: "operator.write" },
  { name: "chat.send", scope: "operator.write" },
  { name: "assistant.media.get", scope: "operator.read", advertise: false },
  { name: "sessions.get", scope: "operator.read", advertise: false },
  { name: "sessions.resolve", scope: "operator.read", advertise: false },
  { name: "sessions.usage", scope: "operator.read", advertise: false },
  { name: "sessions.usage.timeseries", scope: "operator.read", advertise: false },
  { name: "sessions.usage.logs", scope: "operator.read", advertise: false },
  { name: "poll", scope: "operator.write", advertise: false },
  { name: "sessions.steer", scope: "operator.write", advertise: false },
  { name: "push.test", scope: "operator.write", advertise: false },
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
] as const;

const CORE_GATEWAY_METHOD_SPEC_BY_NAME: ReadonlyMap<string, CoreGatewayMethodSpec> = new Map(
  CORE_GATEWAY_METHOD_SPECS.map((spec) => [spec.name, spec]),
);

export const STARTUP_UNAVAILABLE_GATEWAY_METHODS = CORE_GATEWAY_METHOD_SPECS.filter(
  (spec) => spec.startup === true,
).map((spec) => spec.name);

export function listCoreAdvertisedGatewayMethodNames(): string[] {
  return CORE_GATEWAY_METHOD_SPECS.filter((spec) => spec.advertise !== false).map(
    (spec) => spec.name,
  );
}

export function listCoreGatewayMethodNames(): string[] {
  return CORE_GATEWAY_METHOD_SPECS.map((spec) => spec.name);
}

export function resolveCoreGatewayMethodScope(method: string): GatewayMethodScope | undefined {
  return CORE_GATEWAY_METHOD_SPEC_BY_NAME.get(method)?.scope;
}

export function resolveCoreOperatorGatewayMethodScope(method: string): OperatorScope | undefined {
  const scope = resolveCoreGatewayMethodScope(method);
  return scope === NODE_GATEWAY_METHOD_SCOPE || scope === DYNAMIC_GATEWAY_METHOD_SCOPE
    ? undefined
    : scope;
}

export function isCoreNodeGatewayMethod(method: string): boolean {
  return resolveCoreGatewayMethodScope(method) === NODE_GATEWAY_METHOD_SCOPE;
}

export function isDynamicOperatorGatewayMethod(method: string): boolean {
  return resolveCoreGatewayMethodScope(method) === DYNAMIC_GATEWAY_METHOD_SCOPE;
}

export function isCoreGatewayMethodClassified(method: string): boolean {
  return CORE_GATEWAY_METHOD_SPEC_BY_NAME.has(method);
}

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
      throw new Error(`gateway method handler is missing a descriptor: ${name}`);
    }
  }
  return descriptors;
}
