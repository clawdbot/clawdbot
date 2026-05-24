import { getPluginRegistryState } from "../plugins/runtime-state.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { formatControlPlaneActor, resolveControlPlaneActor } from "./control-plane-audit.js";
import { consumeControlPlaneWriteBudget } from "./control-plane-rate-limit.js";
import { ADMIN_SCOPE, authorizeOperatorScopesForMethod } from "./method-scopes.js";
import {
  createCoreGatewayMethodDescriptors,
  createGatewayMethodDescriptorsFromHandlers,
  createGatewayMethodRegistry,
  createPluginGatewayMethodDescriptors,
  isCoreGatewayMethodClassified,
  type GatewayMethodRegistry,
} from "./methods/registry.js";
import { ErrorCodes, errorShape } from "./protocol/index.js";
import {
  gatewayStartupUnavailableDetails,
  GATEWAY_STARTUP_RETRY_AFTER_MS,
} from "./protocol/startup-unavailable.js";
import { isRoleAuthorizedForMethod, parseGatewayRole } from "./role-policy.js";
import type {
  GatewayRequestHandler,
  GatewayRequestHandlerOptions,
  GatewayRequestHandlers,
  GatewayRequestOptions,
} from "./server-methods/types.js";

function lazyHandlerModule<T>(
  loadModule: () => Promise<T>,
  selectHandlers: (module: T) => GatewayRequestHandlers,
): () => Promise<GatewayRequestHandlers> {
  let handlersPromise: Promise<GatewayRequestHandlers> | null = null;
  return () => (handlersPromise ??= loadModule().then(selectHandlers));
}

function createLazyCoreHandlers(params: {
  methods: readonly string[];
  loadHandlers: () => Promise<GatewayRequestHandlers>;
}): GatewayRequestHandlers {
  return Object.fromEntries(
    params.methods.map((method) => [
      method,
      async (opts: GatewayRequestHandlerOptions) => {
        const handlers = await params.loadHandlers();
        const handler = handlers[method];
        if (!handler) {
          throw new Error(`lazy gateway handler not found: ${method}`);
        }
        await handler(opts);
      },
    ]),
  );
}

const loadAgentHandlers = lazyHandlerModule(
  () => import("./server-methods/agent.js"),
  (module) => module.agentHandlers,
);
const loadAgentsHandlers = lazyHandlerModule(
  () => import("./server-methods/agents.js"),
  (module) => module.agentsHandlers,
);
const loadArtifactsHandlers = lazyHandlerModule(
  () => import("./server-methods/artifacts.js"),
  (module) => module.artifactsHandlers,
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
const loadConnectHandlers = lazyHandlerModule(
  () => import("./server-methods/connect.js"),
  (module) => module.connectHandlers,
);
const loadCronHandlers = lazyHandlerModule(
  () => import("./server-methods/cron.js"),
  (module) => module.cronHandlers,
);
const loadDeviceHandlers = lazyHandlerModule(
  () => import("./server-methods/devices.js"),
  (module) => module.deviceHandlers,
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
const loadExecApprovalsHandlers = lazyHandlerModule(
  () => import("./server-methods/exec-approvals.js"),
  (module) => module.execApprovalsHandlers,
);
const loadHealthHandlers = lazyHandlerModule(
  () => import("./server-methods/health.js"),
  (module) => module.healthHandlers,
);
const loadLogsHandlers = lazyHandlerModule(
  () => import("./server-methods/logs.js"),
  (module) => module.logsHandlers,
);
const loadModelsAuthStatusHandlers = lazyHandlerModule(
  () => import("./server-methods/models-auth-status.js"),
  (module) => module.modelsAuthStatusHandlers,
);
const loadModelsHandlers = lazyHandlerModule(
  () => import("./server-methods/models.js"),
  (module) => module.modelsHandlers,
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
const loadPushHandlers = lazyHandlerModule(
  () => import("./server-methods/push.js"),
  (module) => module.pushHandlers,
);
const loadRestartHandlers = lazyHandlerModule(
  () => import("./server-methods/restart.js"),
  (module) => module.restartHandlers,
);
const loadSendHandlers = lazyHandlerModule(
  () => import("./server-methods/send.js"),
  (module) => module.sendHandlers,
);
const loadSessionsHandlers = lazyHandlerModule(
  () => import("./server-methods/sessions.js"),
  (module) => module.sessionsHandlers,
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
const loadWizardHandlers = lazyHandlerModule(
  () => import("./server-methods/wizard.js"),
  (module) => module.wizardHandlers,
);

function authorizeGatewayMethod(
  method: string,
  client: GatewayRequestOptions["client"],
  params: unknown,
) {
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
  const scopeAuth = authorizeOperatorScopesForMethod(method, scopes, params);
  if (!scopeAuth.allowed) {
    return errorShape(ErrorCodes.INVALID_REQUEST, `missing scope: ${scopeAuth.missingScope}`);
  }
  return null;
}

export const coreGatewayHandlers: GatewayRequestHandlers = {
  ...createLazyCoreHandlers({
    methods: ["connect"],
    loadHandlers: loadConnectHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: ["logs.tail"],
    loadHandlers: loadLogsHandlers,
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
    methods: ["chat.history", "chat.abort", "chat.send", "chat.inject"],
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
      "device.token.rotate",
      "device.token.revoke",
    ],
    loadHandlers: loadDeviceHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: ["diagnostics.stability"],
    loadHandlers: loadDiagnosticsHandlers,
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
    methods: ["environments.list", "environments.status"],
    loadHandlers: loadEnvironmentsHandlers,
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
    methods: ["web.login.start", "web.login.wait"],
    loadHandlers: loadWebHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: ["models.list"],
    loadHandlers: loadModelsHandlers,
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
      "talk.session.create",
      "talk.session.join",
      "talk.session.appendAudio",
      "talk.session.startTurn",
      "talk.session.endTurn",
      "talk.session.cancelTurn",
      "talk.session.cancelOutput",
      "talk.session.submitToolResult",
      "talk.session.steer",
      "talk.session.close",
      "talk.client.create",
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
    methods: ["tasks.list", "tasks.get", "tasks.cancel"],
    loadHandlers: loadTasksHandlers,
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
      "tts.status",
      "tts.enable",
      "tts.disable",
      "tts.convert",
      "tts.setProvider",
      "tts.personas",
      "tts.setPersona",
      "tts.providers",
    ],
    loadHandlers: loadTtsHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: [
      "skills.upload.begin",
      "skills.upload.chunk",
      "skills.upload.commit",
      "skills.status",
      "skills.bins",
      "skills.search",
      "skills.detail",
      "skills.install",
      "skills.update",
    ],
    loadHandlers: loadSkillsHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: [
      "sessions.list",
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
      "sessions.send",
      "sessions.steer",
      "sessions.abort",
      "sessions.patch",
      "sessions.pluginPatch",
      "sessions.reset",
      "sessions.delete",
      "sessions.get",
      "sessions.compact",
    ],
    loadHandlers: loadSessionsHandlers,
  }),
  ...createLazyCoreHandlers({
    methods: [
      "gateway.identity.get",
      "last-heartbeat",
      "set-heartbeats",
      "system-presence",
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
      "node.pair.request",
      "node.pair.list",
      "node.pair.approve",
      "node.pair.reject",
      "node.pair.remove",
      "node.pair.verify",
      "node.rename",
      "node.list",
      "node.describe",
      "node.pluginSurface.refresh",
      "node.pending.pull",
      "node.pending.ack",
      "node.invoke",
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
    methods: ["message.action", "send", "poll"],
    loadHandlers: loadSendHandlers,
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
    methods: ["artifacts.list", "artifacts.get", "artifacts.download"],
    loadHandlers: loadArtifactsHandlers,
  }),
};

function createRequestGatewayMethodRegistry(
  extraHandlers?: GatewayRequestHandlers,
): GatewayMethodRegistry {
  const activePluginRegistry = getPluginRegistryState()?.activeRegistry;
  const activePluginHandlers = activePluginRegistry?.gatewayHandlers ?? {};
  const extraHandlerEntries = Object.entries(extraHandlers ?? {});
  const pluginMethodNames = new Set(Object.keys(activePluginHandlers));
  const coreDescriptorHandlers = { ...coreGatewayHandlers };
  for (const [method, extraHandler] of extraHandlerEntries) {
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

export async function handleGatewayRequest(
  opts: GatewayRequestOptions & { extraHandlers?: GatewayRequestHandlers },
): Promise<void> {
  const { req, respond, client, isWebchatConnect, context } = opts;
  const methodRegistry =
    opts.methodRegistry ?? createRequestGatewayMethodRegistry(opts.extraHandlers);
  const authError = authorizeGatewayMethod(req.method, client, req.params);
  if (authError) {
    respond(false, undefined, authError);
    return;
  }
  if (context.unavailableGatewayMethods?.has(req.method)) {
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
  if (methodRegistry.isControlPlaneWrite(req.method)) {
    const budget = consumeControlPlaneWriteBudget({ client });
    if (!budget.allowed) {
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
              limit: "3 per 60s",
            },
          },
        ),
      );
      return;
    }
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
  await withPluginRuntimeGatewayRequestScope({ context, client, isWebchatConnect }, invokeHandler);
}
