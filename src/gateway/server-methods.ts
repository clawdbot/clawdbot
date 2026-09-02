import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  ErrorCodes,
  errorShape,
  missingScopeErrorShape,
  type ErrorShape,
} from "../../packages/gateway-protocol/src/index.js";
import {
  GATEWAY_RESTART_UNAVAILABLE_REASON,
  GATEWAY_SUSPEND_UNAVAILABLE_REASON,
} from "../../packages/gateway-protocol/src/restart-unavailable.js";
import {
  gatewayStartupUnavailableDetails,
  GATEWAY_STARTUP_RETRY_AFTER_MS,
} from "../../packages/gateway-protocol/src/startup-unavailable.js";
import { getActivePluginHttpRouteRegistry, getActivePluginRegistry } from "../plugins/runtime.js";
import {
  getPluginRuntimeGatewayRequestScope,
  getPluginRuntimeGatewayNodeAuthorities,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import {
  getGatewaySuspendAdmissionPhase,
  isGatewayRestartDraining,
  tryBeginGatewayPreparedRestartRootWorkAdmission,
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
  listCoreGatewayHandlerMethodNames,
  type CoreGatewayHandlerFamily,
} from "./methods/core-descriptors.js";
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
import { authenticatedProfileUnavailableError } from "./server-methods/gateway-client-identity.js";
import { createLazyCoreHandlers, lazyHandlerModule } from "./server-methods/lazy-core-handlers.js";
import { isTargetedNonSafeGatewayRestartRequest } from "./server-methods/restart-request.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandler,
  GatewayRequestHandlers,
  GatewayRequestOptions,
  SessionMutationAuthorization,
} from "./server-methods/types.js";
import {
  resolveDirectIncognitoTargets,
  sessionMutationTargetFields,
} from "./session-sharing-target-input.js";
import {
  resolveSessionMutationAuthorization,
  SessionMutationAuthorizationChangedError,
} from "./session-sharing.js";
import { classifyGatewayStaleInstall } from "./stale-install.js";

type CoreGatewayHandlerModuleLoader = () => Promise<GatewayRequestHandlers>;

const CORE_GATEWAY_HANDLER_MODULES = {
  agent: () => import("./server-methods/agent.js").then((module) => module.agentHandlers),
  "agent-identity": () =>
    import("./server-methods/agent-identity.js").then((module) => module.agentIdentityHandlers),
  agents: () => import("./server-methods/agents.js").then((module) => module.agentsHandlers),
  "agents-workspace": () =>
    import("./server-methods/agents-workspace.js").then((module) => module.agentsWorkspaceHandlers),
  artifacts: () =>
    import("./server-methods/artifacts.js").then((module) => module.artifactsHandlers),
  board: () => import("./server-methods/board.js").then((module) => module.boardHandlers),
  audit: () => import("./server-methods/audit.js").then((module) => module.auditHandlers),
  users: () => import("./server-methods/users.js").then((module) => module.usersHandlers),
  attach: () => import("./server-methods/attach.js").then((module) => module.attachHandlers),
  channels: () => import("./server-methods/channels.js").then((module) => module.channelsHandlers),
  "channel-pairing": () =>
    import("./server-methods/channel-pairing.js").then((module) => module.channelPairingHandlers),
  chat: () => import("./server-methods/chat.js").then((module) => module.chatHandlers),
  // Cancellation must not wait for unrelated chat history and send workflows to load.
  "chat-abort": () =>
    import("./server-methods/chat-abort-handler.js").then((module) => ({
      "chat.abort": module.handleChatAbortRequest,
    })),
  commands: () => import("./server-methods/commands.js").then((module) => module.commandsHandlers),
  config: () => import("./server-methods/config.js").then((module) => module.configHandlers),
  conversations: () =>
    import("./server-methods/conversations.js").then((module) => module.conversationHandlers),
  connect: () => import("./server-methods/connect.js").then((module) => module.connectHandlers),
  "control-ui": () =>
    import("./server-methods/control-ui.js").then((module) => module.controlUiHandlers),
  cron: () => import("./server-methods/cron.js").then((module) => module.cronHandlers),
  devices: () => import("./server-methods/devices.js").then((module) => module.deviceHandlers),
  "device-pair-setup": () =>
    import("./server-methods/device-pair-setup.js").then(
      (module) => module.devicePairSetupHandlers,
    ),
  diagnostics: () =>
    import("./server-methods/diagnostics.js").then((module) => module.diagnosticsHandlers),
  doctor: () =>
    import("./server-methods/doctor.js").then((module) => module.createDoctorHandlers()),
  environments: () =>
    import("./server-methods/environments.js").then((module) => module.environmentsHandlers),
  worktrees: () =>
    import("./server-methods/worktrees.js").then((module) => module.worktreesHandlers),
  "exec-approvals": () =>
    import("./server-methods/exec-approvals.js").then((module) => module.execApprovalsHandlers),
  fs: () => import("./server-methods/fs.js").then((module) => module.fsHandlers),
  health: () => import("./server-methods/health.js").then((module) => module.healthHandlers),
  logs: () => import("./server-methods/logs.js").then((module) => module.logsHandlers),
  "memory-search": () =>
    import("./server-methods/memory-search.js").then((module) => module.memorySearchHandlers),
  terminal: () => import("./server-methods/terminal.js").then((module) => module.terminalHandlers),
  "ui-command": () =>
    import("./server-methods/ui-command.js").then((module) => module.uiCommandHandlers),
  "models-auth-status": () =>
    import("./server-methods/models-auth-status.js").then(
      (module) => module.modelsAuthStatusHandlers,
    ),
  models: () => import("./server-methods/models.js").then((module) => module.modelsHandlers),
  "models-probe": () =>
    import("./server-methods/models-probe.js").then((module) => module.modelsProbeHandlers),
  "native-hook-relay": () =>
    import("./server-methods/native-hook-relay.js").then(
      (module) => module.nativeHookRelayHandlers,
    ),
  "nodes-pending": () =>
    import("./server-methods/nodes.pending-work.js").then(
      (module) => module.nodePendingWorkHandlers,
    ),
  nodes: () => import("./server-methods/nodes.js").then((module) => module.nodeHandlers),
  "plugin-host-hooks": () =>
    import("./server-methods/plugin-host-hooks.js").then((module) => module.pluginHostHookHandlers),
  plugins: () => import("./server-methods/plugins.js").then((module) => module.pluginsHandlers),
  projects: () => import("./server-methods/projects.js").then((module) => module.projectsHandlers),
  portals: () => import("./server-methods/portals.js").then((module) => module.portalHandlers),
  "progress-card": () =>
    import("./server-methods/progress-card.js").then((module) => module.progressCardHandlers),
  migrations: () =>
    import("./server-methods/migrations.js").then((module) => module.migrationsHandlers),
  push: () => import("./server-methods/push.js").then((module) => module.pushHandlers),
  restart: () => import("./server-methods/restart.js").then((module) => module.restartHandlers),
  suspend: () => import("./server-methods/suspend.js").then((module) => module.suspendHandlers),
  send: () => import("./server-methods/send.js").then((module) => module.sendHandlers),
  "sessions-files": () =>
    import("./server-methods/sessions-files.js").then((module) => module.sessionsFilesHandlers),
  "sessions-github": () =>
    import("./server-methods/sessions-github.js").then((module) => module.sessionsGitHubHandlers),
  "sessions-diff": () =>
    import("./server-methods/sessions-diff.js").then((module) => module.sessionsDiffHandlers),
  "sessions-abort": () =>
    import("./server-methods/sessions-abort.js").then((module) => module.sessionAbortHandlers),
  "sessions-compact": () =>
    import("./server-methods/sessions-compact.js").then((module) => module.sessionCompactHandlers),
  "sessions-compaction-checkpoints": () =>
    import("./server-methods/sessions-compaction-checkpoints.js").then(
      (module) => module.sessionCheckpointHandlers,
    ),
  "sessions-compaction-queries": () =>
    import("./server-methods/sessions-compaction-queries.js").then(
      (module) => module.sessionCheckpointQueryHandlers,
    ),
  "sessions-create": () =>
    import("./server-methods/sessions-create.js").then((module) => module.sessionCreateHandlers),
  "sessions-title": () =>
    import("./server-methods/sessions-title.js").then((module) => module.sessionTitleHandlers),
  "sessions-recover": () =>
    import("./server-methods/sessions-recover.js").then((module) => module.sessionRecoverHandlers),
  "sessions-delete": () =>
    import("./server-methods/sessions-delete.js").then((module) => module.sessionDeleteHandlers),
  "sessions-dispatch": () =>
    import("./server-methods/sessions-dispatch.js").then(
      (module) => module.sessionDispatchHandlers,
    ),
  "sessions-groups": () =>
    import("./server-methods/sessions-groups.js").then((module) => module.sessionGroupHandlers),
  "sessions-goal": () =>
    import("./server-methods/sessions-goal.js").then((module) => module.sessionGoalHandlers),
  "sessions-messaging": () =>
    import("./server-methods/sessions-messaging.js").then(
      (module) => module.sessionMessagingHandlers,
    ),
  "sessions-mutations": () =>
    import("./server-methods/sessions-mutations.js").then(
      (module) => module.sessionMutationHandlers,
    ),
  "sessions-read": () =>
    import("./server-methods/sessions-read.js").then((module) => module.sessionReadHandlers),
  "sessions-rewind": () =>
    import("./server-methods/sessions-rewind.js").then((module) => module.sessionRewindHandlers),
  "sessions-sharing": () =>
    import("./server-methods/sessions-sharing.js").then((module) => module.sessionSharingHandlers),
  "sessions-subscriptions": () =>
    import("./server-methods/sessions-subscriptions.js").then(
      (module) => module.sessionSubscriptionHandlers,
    ),
  "sessions-suggestions": () =>
    import("./server-methods/sessions-suggestions.js").then(
      (module) => module.sessionSuggestionHandlers,
    ),
  "session-catalog": () =>
    import("./server-methods/session-catalog.js").then((module) => module.sessionCatalogHandlers),
  "session-discussion": () =>
    import("./server-methods/session-discussion.js").then(
      (module) => module.sessionDiscussionHandlers,
    ),
  "session-observer-rpc": () =>
    import("./session-observer-rpc.js").then((module) => module.sessionObserverHandlers),
  "session-companion-rpc": () =>
    import("./session-companion-rpc.js").then((module) => module.sessionCompanionHandlers),
  "hooks-status": () =>
    import("./server-methods/hooks-status.js").then((module) => module.hooksStatusHandlers),
  skills: () => import("./server-methods/skills.js").then((module) => module.skillsHandlers),
  system: () => import("./server-methods/system.js").then((module) => module.systemHandlers),
  talk: () => import("./server-methods/talk.js").then((module) => module.talkHandlers),
  tasks: () => import("./server-methods/tasks.js").then((module) => module.tasksHandlers),
  "task-suggestions": () =>
    import("./server-methods/task-suggestions.js").then((module) => module.taskSuggestionsHandlers),
  "tools-catalog": () =>
    import("./server-methods/tools-catalog.js").then((module) => module.toolsCatalogHandlers),
  "tools-github": () =>
    import("./server-methods/tools-github.js").then((module) => module.toolsGitHubHandlers),
  "tools-effective": () =>
    import("./server-methods/tools-effective.js").then((module) => module.toolsEffectiveHandlers),
  "tools-invoke": () =>
    import("./server-methods/tools-invoke.js").then((module) => module.toolsInvokeHandlers),
  "mcp-app": () => import("./server-methods/mcp-app.js").then((module) => module.mcpAppHandlers),
  tts: () => import("./server-methods/tts.js").then((module) => module.ttsHandlers),
  update: () => import("./server-methods/update.js").then((module) => module.updateHandlers),
  usage: () => import("./server-methods/usage.js").then((module) => module.usageHandlers),
  "voicewake-routing": () =>
    import("./server-methods/voicewake-routing.js").then(
      (module) => module.voicewakeRoutingHandlers,
    ),
  voicewake: () =>
    import("./server-methods/voicewake.js").then((module) => module.voicewakeHandlers),
  web: () => import("./server-methods/web.js").then((module) => module.webHandlers),
  "system-agent": () =>
    import("./server-methods/system-agent.js").then((module) => module.systemAgentHandlers),
  "system-changes": () =>
    import("./server-methods/system-changes.js").then((module) => module.systemChangesHandlers),
  wizard: () => import("./server-methods/wizard.js").then((module) => module.wizardHandlers),
} satisfies Record<CoreGatewayHandlerFamily, CoreGatewayHandlerModuleLoader>;

function authorizeGatewayMethod(
  method: string,
  client: GatewayRequestOptions["client"],
  params: unknown,
  methodRegistry: GatewayMethodRegistry,
) {
  // Pre-connect and health requests are allowed through; role/scope checks require the
  // authenticated connect metadata established by the gateway handshake.
  if (!client?.connect || method === "health") {
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
  if (method === "device.scopes.requestUpgrade" || method === "device.scopes.waitUpgrade") {
    // Scope recovery must remain reachable from a paired operator whose grant is empty;
    // the handlers bind both calls to the connection's exact device identity.
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

function runGatewayPendingWorkContinuation<T>(params: {
  method: string;
  client: GatewayRequestOptions["client"];
  requestParams: unknown;
  context: GatewayRequestContext;
  run: () => Promise<T>;
}): Promise<T> | null {
  if (!isRecord(params.requestParams)) {
    return null;
  }
  const request = params.requestParams;
  if (params.client?.connect.role === "node") {
    if (getGatewaySuspendAdmissionPhase() !== "draining" && !isGatewayRestartDraining()) {
      return null;
    }
    const invokeId =
      params.method === "node.invoke.progress"
        ? request.invokeId
        : params.method === "node.invoke.result"
          ? request.id
          : undefined;
    if (typeof invokeId !== "string" || typeof request.nodeId !== "string") {
      return null;
    }
    return params.context.nodeRegistry.runPendingInvokeContinuation({
      invokeId,
      nodeId: request.nodeId,
      connId: params.client.connId,
      run: params.run,
    });
  }
  if (
    getGatewaySuspendAdmissionPhase() !== "draining" ||
    params.client?.connect.role !== "operator" ||
    typeof request.id !== "string"
  ) {
    return null;
  }
  if (params.method === "question.resolve" || params.method === "question.get") {
    return params.context.questionManager?.runPendingContinuation(request.id, params.run) ?? null;
  }
  const manager =
    params.method === "exec.approval.resolve"
      ? params.context.execApprovalManager
      : params.method === "plugin.approval.resolve"
        ? params.context.pluginApprovalManager
        : params.method === "approval.resolve"
          ? request.kind === "exec"
            ? params.context.execApprovalManager
            : request.kind === "plugin"
              ? params.context.pluginApprovalManager
              : request.kind === "system-agent"
                ? params.context.systemAgentApprovalManager
                : undefined
          : undefined;
  return manager?.runPendingContinuation(request.id, params.run) ?? null;
}

async function authorizeAuthenticatedProfileForMethod(params: {
  client: GatewayRequestOptions["client"];
  method: string;
  requestParams: unknown;
  methodRegistry: GatewayMethodRegistry;
  context: GatewayRequestContext;
}): Promise<ErrorShape | null> {
  const sync = params.client?.authenticatedGitHubIdentitySync;
  if (!sync || params.client?.authenticatedUserProfile?.profileId.trim()) {
    return null;
  }
  const requiresProfile =
    params.methodRegistry.requiresAuthenticatedProfile(params.method) ||
    resolveDirectIncognitoTargets(params.method, params.requestParams).length > 0 ||
    (sessionMutationTargetFields(params.method).length > 0 &&
      params.context.getRuntimeConfig().gateway?.roles !== undefined);
  if (!requiresProfile) {
    return null;
  }
  try {
    await sync();
  } catch {
    return authenticatedProfileUnavailableError();
  }
  return params.client?.authenticatedUserProfile?.profileId.trim()
    ? null
    : authenticatedProfileUnavailableError();
}

const coreGatewayHandlerMethodNames = listCoreGatewayHandlerMethodNames();
const coreGatewayHandlerModules = Object.entries(CORE_GATEWAY_HANDLER_MODULES) as Array<
  [CoreGatewayHandlerFamily, CoreGatewayHandlerModuleLoader]
>;

export const coreGatewayHandlers: GatewayRequestHandlers = Object.fromEntries(
  coreGatewayHandlerModules.flatMap(([family, loadModule]) =>
    Object.entries(
      createLazyCoreHandlers({
        methods: coreGatewayHandlerMethodNames.get(family) ?? [],
        loadHandlers: lazyHandlerModule(loadModule, (handlers) => handlers),
      }),
    ),
  ),
);

/** Builds the per-request method registry from core, plugin, and explicit extra handlers. */
export function createRequestGatewayMethodRegistry(
  extraHandlers?: GatewayRequestHandlers,
): GatewayMethodRegistry {
  // Attached gateway methods must not be shadowed by agent-scoped registry loads.
  const gatewayPluginRegistry = getActivePluginHttpRouteRegistry();
  const gatewayPluginHandlers = gatewayPluginRegistry?.gatewayHandlers ?? {};
  const extraHandlerEntries = Object.entries(extraHandlers ?? {});
  const pluginMethodNames = new Set(Object.keys(gatewayPluginHandlers));
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
  return createGatewayMethodRegistry(
    [
      ...coreDescriptors,
      ...(gatewayPluginRegistry ? createPluginGatewayMethodDescriptors(gatewayPluginRegistry) : []),
      ...createGatewayMethodDescriptorsFromHandlers({
        handlers: auxHandlers,
        owner: { kind: "aux", area: "gateway-extra" },
        defaultScope: ADMIN_SCOPE,
      }),
    ],
    gatewayPluginRegistry ?? undefined,
  );
}

/** Applies the router-owned authorization fence before any transport or typed dispatch. */
export async function authorizeGatewayRequestPreDispatch(params: {
  method: string;
  requestParams: unknown;
  client: GatewayRequestOptions["client"];
  context: GatewayRequestContext;
  methodRegistry: GatewayMethodRegistry;
}): Promise<{
  error: ErrorShape | null;
  sessionMutationAuthorization?: SessionMutationAuthorization;
}> {
  const authError = authorizeGatewayMethod(
    params.method,
    params.client,
    params.requestParams,
    params.methodRegistry,
  );
  if (authError) {
    return { error: authError };
  }
  // GitHub-backed connections receive hello before remote account resolution. Profile-owned
  // methods must cross this single router fence before session authorization or handler work.
  const profileError = await authorizeAuthenticatedProfileForMethod(params);
  if (profileError) {
    return { error: profileError };
  }
  // Startup gating precedes session authorization: session stores are not loaded yet,
  // so an authorization read here would deny with a misleading non-retryable error.
  if (params.context.unavailableGatewayMethods?.has(params.method)) {
    return {
      error: errorShape(
        ErrorCodes.UNAVAILABLE,
        `${params.method} unavailable during gateway startup`,
        {
          retryable: true,
          retryAfterMs: GATEWAY_STARTUP_RETRY_AFTER_MS,
          details: { ...gatewayStartupUnavailableDetails(), method: params.method },
        },
      ),
    };
  }
  const sessionMutation = resolveSessionMutationAuthorization({
    client: params.client ?? null,
    method: params.method,
    requestParams: params.requestParams,
    context: params.context,
  });
  if (sessionMutation.error) {
    return { error: sessionMutation.error };
  }
  if (
    params.client?.connect.role === "node" &&
    (!params.client.connId ||
      !(await params.context.nodeRegistry.isConnectionCurrentPairingState(params.client.connId)))
  ) {
    return {
      error: errorShape(ErrorCodes.UNAVAILABLE, "node pairing changed before request dispatch", {
        retryable: true,
        details: { code: "PAIRING_CHANGED" },
      }),
    };
  }
  return {
    error: null,
    ...(sessionMutation.authorization
      ? { sessionMutationAuthorization: sessionMutation.authorization }
      : {}),
  };
}

type GatewayRequestEnvelopeOptions<T> = Pick<
  GatewayRequestOptions,
  "context" | "isWebchatConnect"
> & {
  methodRegistry: GatewayMethodRegistry;
  requestParams?: unknown;
  reject: (error: ReturnType<typeof errorShape>) => T | Promise<T>;
};

/** Runs admitted Gateway work inside the shared root and plugin request scopes. */
export async function runWithGatewayRequestEnvelope<T>(
  method: string,
  client: GatewayRequestOptions["client"],
  fn: () => T | Promise<T>,
  options: GatewayRequestEnvelopeOptions<T>,
): Promise<T> {
  const rejectRateLimitedControlPlaneWrite = (): ReturnType<typeof errorShape> | undefined => {
    if (!options.methodRegistry.isControlPlaneWrite(method)) {
      return undefined;
    }
    const budget = consumeControlPlaneWriteBudget({ client, method });
    if (budget.allowed) {
      return undefined;
    }
    const actor = resolveControlPlaneActor(client);
    options.context.logGateway.warn(
      `control-plane write rate-limited method=${method} ${formatControlPlaneActor(actor)} retryAfterMs=${budget.retryAfterMs} key=${budget.key}`,
    );
    return errorShape(
      ErrorCodes.UNAVAILABLE,
      `rate limit exceeded for ${method}; retry after ${Math.ceil(budget.retryAfterMs / 1000)}s`,
      {
        retryable: true,
        retryAfterMs: budget.retryAfterMs,
        details: {
          method,
          limit: `${CONTROL_PLANE_RATE_LIMIT_MAX_REQUESTS} per ${CONTROL_PLANE_RATE_LIMIT_WINDOW_MS / 1000}s`,
        },
      },
    );
  };
  const isSuspendPrepare = method === "gateway.suspend.prepare";
  const preAdmissionRateLimitError = isSuspendPrepare
    ? rejectRateLimitedControlPlaneWrite()
    : undefined;
  if (preAdmissionRateLimitError) {
    // Preparation must stay protected even before it owns the root admission that it closes.
    return await options.reject(preAdmissionRateLimitError);
  }
  const rootWorkAdmission =
    tryBeginGatewayRootWorkAdmission(`ws:${method}`) ??
    (method === "gateway.restart.request" &&
    isTargetedNonSafeGatewayRestartRequest(options.requestParams)
      ? tryBeginGatewayPreparedRestartRootWorkAdmission()
      : null);
  if (!rootWorkAdmission) {
    // Completion frames arrive on separate socket chains. Their exact pending owner
    // may settle them without admitting a new root, including rootless shutdown cleanup.
    const continuation = runGatewayPendingWorkContinuation({
      method,
      client,
      requestParams: options.requestParams,
      context: options.context,
      run: invokeWithRequestScope,
    });
    if (continuation) {
      return await continuation;
    }
  }
  if (isSuspendPrepare && rootWorkAdmission && !rootWorkAdmission.ownsRoot) {
    return await options.reject(
      errorShape(ErrorCodes.UNAVAILABLE, "gateway suspension cannot begin from a nested request", {
        retryable: true,
        retryAfterMs: 1_000,
        details: { method, reason: "nested-gateway-request" },
      }),
    );
  }
  if (!rootWorkAdmission && !SUSPEND_CONTROL_METHODS.has(method)) {
    const restartDraining = isGatewayRestartDraining();
    return await options.reject(
      errorShape(
        ErrorCodes.UNAVAILABLE,
        `${method} unavailable during gateway ${restartDraining ? "restart" : "suspension"}`,
        {
          retryable: true,
          retryAfterMs: 1_000,
          details: {
            method,
            reason: restartDraining
              ? GATEWAY_RESTART_UNAVAILABLE_REASON
              : GATEWAY_SUSPEND_UNAVAILABLE_REASON,
            phase: getGatewaySuspendAdmissionPhase(),
          },
        },
      ),
    );
  }
  async function invokeWithRequestScope() {
    const postAdmissionRateLimitError = isSuspendPrepare
      ? undefined
      : rejectRateLimitedControlPlaneWrite();
    // A closed admission must reject first so refused writes do not exhaust the controller's
    // budget and strand it behind rate limiting after suspension resumes.
    if (postAdmissionRateLimitError) {
      return await options.reject(postAdmissionRateLimitError);
    }
    try {
      const pluginRegistry =
        (options.methodRegistry.pluginRegistry as
          | NonNullable<ReturnType<typeof getActivePluginRegistry>>
          | undefined) ??
        getPluginRuntimeGatewayRequestScope()?.pluginRegistry ??
        getActivePluginRegistry() ??
        undefined;
      return await withPluginRuntimeGatewayRequestScope(
        {
          context: options.context,
          // Detached turn admission needs the live instance resolver, not a captured request context.
          resolveGatewayContext: options.context.resolveGatewayContext,
          client,
          isWebchatConnect: options.isWebchatConnect,
          // Only an owner-bound in-process stream may retain admitted Full authority.
          ...(client?.internal?.nodeInvokeStream ? getPluginRuntimeGatewayNodeAuthorities() : {}),
          ...(pluginRegistry ? { pluginRegistry } : {}),
        },
        fn,
      );
    } catch (error) {
      if (error instanceof SessionMutationAuthorizationChangedError) {
        return await options.reject(error.error);
      }
      const staleInstall = classifyGatewayStaleInstall(error);
      if (staleInstall) {
        return await options.reject(staleInstall.error);
      }
      throw error;
    }
  }
  if (!rootWorkAdmission) {
    return await invokeWithRequestScope();
  }
  try {
    return await rootWorkAdmission.run(invokeWithRequestScope);
  } finally {
    rootWorkAdmission.release();
  }
}

/** Authorizes and dispatches one gateway JSON-RPC-style request. */
export async function handleGatewayRequest(
  opts: GatewayRequestOptions & { extraHandlers?: GatewayRequestHandlers },
): Promise<void> {
  const { req, respond, client, isWebchatConnect, context, signal } = opts;
  // Prefer the caller-attached registry when it owns the requested method so plugin dispatch
  // metadata newer than global runtime state still authorizes and dispatches correctly. When the
  // attached snapshot does not own the method, rebuild from the process-root registry so late
  // methods remain reachable (#94127).
  const methodRegistry =
    opts.methodRegistry?.getHandler(req.method) !== undefined
      ? opts.methodRegistry
      : createRequestGatewayMethodRegistry(opts.extraHandlers);
  const authorization = await authorizeGatewayRequestPreDispatch({
    method: req.method,
    requestParams: req.params,
    client,
    context,
    methodRegistry,
  });
  if (authorization.error) {
    respond(false, undefined, authorization.error);
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
  const invokeHandler = () =>
    handler({
      req,
      params: (req.params ?? {}) as Record<string, unknown>,
      client,
      isWebchatConnect,
      respond,
      context,
      ...(signal ? { signal } : {}),
      ...(opts.sessionMutationCommitGuard
        ? { sessionMutationCommitGuard: opts.sessionMutationCommitGuard }
        : {}),
      ...(authorization.sessionMutationAuthorization
        ? { sessionMutationAuthorization: authorization.sessionMutationAuthorization }
        : {}),
    });
  await runWithGatewayRequestEnvelope(req.method, client, invokeHandler, {
    context,
    isWebchatConnect,
    methodRegistry,
    requestParams: req.params,
    reject: (error) => respond(false, undefined, error),
  });
}
