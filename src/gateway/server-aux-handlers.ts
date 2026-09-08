// Gateway auxiliary method handlers.
// Wires reload, secrets, exec approval, and plugin approval RPC handlers.
import { randomUUID } from "node:crypto";
import { resolveProjectedMcpCodexToolApprovalMode } from "../agents/mcp-codex-tool-approval.js";
import { getRuntimeConfig } from "../config/io.js";
import {
  type AgentRunDelegatedAuthority,
  registerAgentRunDelegatedAuthorityClosedHandler,
} from "../infra/agent-run-registry.js";
import type { ChannelApprovalKind } from "../infra/approval-types.js";
import { createExecApprovalForwarder } from "../infra/exec-approval-forwarder.js";
import {
  type ExecApprovalDecision,
  resolveExecApprovalRequestAllowedDecisions,
  type ExecApprovalRequestPayload,
} from "../infra/exec-approvals.js";
import { resolveCanonicalPluginApprovalRequestAllowedDecisions } from "../infra/plugin-approval-canonical-decisions.js";
import type { PluginApprovalRequestPayload } from "../infra/plugin-approvals.js";
import {
  SYSTEM_AGENT_APPROVAL_DECISIONS,
  type SystemAgentApprovalRequestPayload,
} from "../infra/system-agent-approvals.js";
import { runWithRetainedGatewayRootWork } from "../process/gateway-work-admission.js";
import { resolveCommandSecretsFromActiveRuntimeSnapshot } from "../secrets/runtime-command-secrets.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createLazyPromise } from "../shared/lazy-runtime.js";
import type { AgentRuntimeDelegatedAuthority } from "./agent-runtime-identity-token.js";
import { resolveApprovalSessionAudienceWithFallback } from "./approval-session-audience.js";
import { createApprovalWebPushDelivery } from "./approval-web-push.js";
import type { ChatAbortControllerEntry } from "./chat-abort.js";
import {
  createExecApprovalIosPushDelivery,
  createPluginApprovalIosPushDelivery,
} from "./exec-approval-ios-push.js";
import {
  ExecApprovalManager,
  type OperatorApprovalLifecycleEvent,
  type OperatorStandingGrantMintSpec,
} from "./exec-approval-manager.js";
import { createLazyHandler } from "./lazy-handler.js";
import {
  createPlacementStandingGrantRuntime,
  type PlacementStandingGrantRuntime,
} from "./operator-approval-placement-grants.js";
import {
  closeOrphanedOperatorApprovals,
  pruneTerminalOperatorApprovals,
} from "./operator-approval-store.js";
import { QuestionManager } from "./question-manager.js";
import { publishAppliedApprovalResolution } from "./server-methods/approval-publication.js";
import {
  cancelAgentRuntimeBoundApprovals,
  cancelUnboundRunApprovals,
  cancelWorkerTurnClaimBoundApprovals,
} from "./server-methods/approval-run-cancellation.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import {
  createGatewaySecretsReloader,
  type GatewaySecretsReloaderParams,
} from "./server-secrets-reload.js";
import type { WorkerSessionTurnClaim } from "./worker-environments/placement-record.js";

type ApprovalPayload =
  | ExecApprovalRequestPayload
  | PluginApprovalRequestPayload
  | SystemAgentApprovalRequestPayload;

type GatewayAuxHandlerLogger = {
  warn?: (message: string) => void;
  error?: (message: string) => void;
  debug?: (message: string) => void;
};

/** Create auxiliary gateway handlers that are not part of the core descriptor set. */
export function createGatewayAuxHandlers(
  params: GatewaySecretsReloaderParams & {
    log: GatewayAuxHandlerLogger;
    onApprovalLifecycle?: (event: OperatorApprovalLifecycleEvent) => void;
    onAgentRunAuthorityClosed?: (authority: AgentRunDelegatedAuthority) => void;
    validateAgentRuntimeDelegatedAuthority?: (authority: AgentRuntimeDelegatedAuthority) => boolean;
    /** Abort-wins guard: a tombstoned run must not mint standing authority. */
    hasRunAbortMarker?: (runId: string) => boolean;
    /** Config-driven default expiry stamp for freshly minted standing grants. */
    resolveGrantDefaultExpiresAtMs?: (nowMs: number) => number | null;
    chatAbortControllers?: Map<string, ChatAbortControllerEntry>;
    registerWorkerTurnClaimClosedHandler?: (
      handler: (claim: WorkerSessionTurnClaim) => void,
    ) => () => void;
  },
) {
  // Approval kinds share one durable first-answer-wins registry and
  // Gateway-lifetime epoch while retaining separate in-process waiter maps.
  // A newly constructed Gateway cannot resume the prior lifetime's waiters.
  const approvalPersistence = { runtimeEpoch: randomUUID() };
  const placementStandingGrants = createPlacementStandingGrantRuntime({
    runtimeEpoch: approvalPersistence.runtimeEpoch,
  });
  const approvalStartupNowMs = Date.now();
  closeOrphanedOperatorApprovals({
    runtimeEpoch: approvalPersistence.runtimeEpoch,
    nowMs: approvalStartupNowMs,
  });
  pruneTerminalOperatorApprovals({ nowMs: approvalStartupNowMs });
  const presentationWork = new AsyncWorkScope();
  const trackPresentationWork = (run: () => Promise<void>): Promise<void> =>
    presentationWork.track(() => runWithRetainedGatewayRootWork(run));
  const createApprovalManager = <TPayload extends ApprovalPayload>(
    approvalKind: "exec" | "plugin" | "system-agent",
    resolveAllowedDecisions: (request: TPayload) => readonly ExecApprovalDecision[],
    resolveStandingGrantMint?: (request: TPayload) => OperatorStandingGrantMintSpec | null,
    retainPlacementStandingGrant?: PlacementStandingGrantRuntime["retain"],
  ) =>
    new ExecApprovalManager<TPayload>({
      approvalKind,
      persistence: approvalPersistence,
      resolveAudienceSessionKeys: resolveApprovalSessionAudienceWithFallback,
      resolveAllowedDecisions,
      ...(resolveStandingGrantMint ? { resolveStandingGrantMint } : {}),
      ...(retainPlacementStandingGrant ? { retainPlacementStandingGrant } : {}),
      ...(params.resolveGrantDefaultExpiresAtMs
        ? { resolveStandingGrantExpiresAtMs: params.resolveGrantDefaultExpiresAtMs }
        : {}),
      onLifecycle: params.onApprovalLifecycle,
      // Timeout expiry is gateway-clock truth: publish the terminal like a
      // resolve so reviewer surfaces need not infer it from their own clocks.
      onExpired: (record, liveRecord) =>
        publishAuthorityClosure({ kind: approvalKind, record, liveRecord }),
      validateAgentRuntimeDelegatedAuthority: params.validateAgentRuntimeDelegatedAuthority,
      onError: (error, context) =>
        params.log.error?.(
          `${context.approvalKind} approval ${context.operation} failed for ${context.approvalId}: ${String(error)}`,
        ),
    });
  const execApprovalManager = createApprovalManager<ExecApprovalRequestPayload>(
    "exec",
    resolveExecApprovalRequestAllowedDecisions,
    (request) => {
      const source = request.cronExecutionSource;
      const operationBinding = request.cronOperationBinding?.trim();
      const agentId = request.agentId?.trim();
      if (!source || !operationBinding || !agentId) {
        return null;
      }
      // Abort-wins: the abort owner tombstones the run before sweeping its
      // approvals, so a raced allow-always must not mint standing authority.
      if (request.runId && params.hasRunAbortMarker?.(request.runId) === true) {
        return null;
      }
      return {
        kind: "cron",
        agentId,
        cronJobId: source.jobId,
        jobConfigRevision: source.jobConfigRevision,
        operationBinding,
      };
    },
  );
  const execApprovalForwarder = createExecApprovalForwarder();
  const approvalWebPushDelivery = createApprovalWebPushDelivery({
    getRuntimeConfig,
    log: params.log,
  });
  const execApprovalIosPushDelivery = createExecApprovalIosPushDelivery({ log: params.log });
  const loadExecApprovalHandlers = createLazyPromise(
    () =>
      import("./server-methods/exec-approval.js").then(({ createExecApprovalHandlers }) =>
        createExecApprovalHandlers(execApprovalManager, {
          forwarder: execApprovalForwarder,
          iosPushDelivery: execApprovalIosPushDelivery,
        }),
      ),
    { cacheRejections: true },
  );
  const reloadSecrets = createGatewaySecretsReloader(params);
  const loadSecretsModule = createLazyPromise(() => import("./server-methods/secrets.js"), {
    cacheRejections: true,
  });
  const loadSecretStoreWriteService = createLazyPromise(
    async () => {
      const { createSecretStoreWriteService } = await loadSecretsModule();
      return createSecretStoreWriteService({ reloadSecrets, log: params.log });
    },
    { cacheRejections: true },
  );
  const questionManager = new QuestionManager();
  const loadQuestionHandlers = createLazyPromise(
    async () => {
      const [{ createQuestionHandlers }, storeWriteService] = await Promise.all([
        import("./server-methods/question.js"),
        loadSecretStoreWriteService(),
      ]);
      return createQuestionHandlers(questionManager, storeWriteService);
    },
    { cacheRejections: true },
  );
  const pluginApprovalManager = createApprovalManager<PluginApprovalRequestPayload>(
    "plugin",
    resolveCanonicalPluginApprovalRequestAllowedDecisions,
    (request) => {
      // Abort-wins for plugin approvals matches the cron mint boundary.
      if (request.runId && params.hasRunAbortMarker?.(request.runId) === true) {
        return null;
      }
      if (request.mcpTool && request.agentId && request.agentId !== "*") {
        const servers = getRuntimeConfig().mcp?.servers;
        const server =
          servers && Object.hasOwn(servers, request.mcpTool.server)
            ? servers[request.mcpTool.server]
            : undefined;
        // Explicit prompt always asks, even after an earlier operator grant.
        const mode =
          server &&
          resolveProjectedMcpCodexToolApprovalMode(request.mcpTool.server, server, server);
        if (server && server.enabled !== false && (mode === undefined || mode === "auto")) {
          return { kind: "mcp-tool", agentId: request.agentId, ...request.mcpTool };
        }
      }
      if (!request.placementGrant) {
        return null;
      }
      return { kind: "placement", ...request.placementGrant };
    },
    placementStandingGrants.retain,
  );
  const systemAgentApprovalManager = createApprovalManager<SystemAgentApprovalRequestPayload>(
    "system-agent",
    () => SYSTEM_AGENT_APPROVAL_DECISIONS,
  );
  const approvalManagers = [execApprovalManager, pluginApprovalManager, systemAgentApprovalManager];
  const pluginApprovalIosPushDelivery = createPluginApprovalIosPushDelivery({ log: params.log });
  type PendingAuthorityPublication = {
    kind: ChannelApprovalKind;
    record: Parameters<typeof publishAppliedApprovalResolution>[0]["record"];
    liveRecord: Parameters<typeof publishAppliedApprovalResolution>[0]["liveRecord"];
  };
  let approvalPublicationContext: GatewayRequestContext | undefined;
  const pendingAuthorityPublications: PendingAuthorityPublication[] = [];
  const publishResolution = (
    { kind, record, liveRecord }: PendingAuthorityPublication,
    context: GatewayRequestContext,
    reason: "authority-close" | "run-abort",
  ) => {
    void trackPresentationWork(() =>
      publishAppliedApprovalResolution({
        record,
        liveRecord,
        context,
        forwarder: execApprovalForwarder,
        ...(kind === "exec"
          ? { iosPushDelivery: execApprovalIosPushDelivery }
          : kind === "plugin"
            ? { pluginIosPushDelivery: pluginApprovalIosPushDelivery }
            : {}),
      }).catch((error: unknown) => {
        context.logGateway?.error?.(
          `${kind} approvals: ${reason} publication failed: ${String(error)}`,
        );
      }),
    );
  };
  const publishAuthorityClosure = (publication: PendingAuthorityPublication) => {
    if (presentationWork.isClosing) {
      return;
    }
    if (approvalPublicationContext) {
      publishResolution(publication, approvalPublicationContext, "authority-close");
    } else {
      pendingAuthorityPublications.push(publication);
    }
  };
  const bindApprovalPublicationContext = (context: GatewayRequestContext) => {
    if (presentationWork.isClosing) {
      return;
    }
    approvalPublicationContext = context;
    for (const publication of pendingAuthorityPublications.splice(0)) {
      publishAuthorityClosure(publication);
    }
  };
  const unregisterApprovalAuthorityClosedObserver = registerAgentRunDelegatedAuthorityClosedHandler(
    (authority, approvalReason) => {
      for (const manager of approvalManagers) {
        const kind = manager.approvalKind;
        try {
          cancelAgentRuntimeBoundApprovals<ApprovalPayload>({
            authority,
            reason: approvalReason,
            manager,
            publish: (record, liveRecord) => publishAuthorityClosure({ kind, record, liveRecord }),
          });
        } catch (error) {
          params.log.error?.(
            `${kind} approvals: authority-close settlement failed: ${String(error)}`,
          );
        }
      }
      questionManager.cancelClosedAuthorities();
      if (!approvalReason) {
        params.onAgentRunAuthorityClosed?.(authority);
      }
    },
  );
  const unregisterWorkerTurnClaimClosedObserver = params.registerWorkerTurnClaimClosedHandler?.(
    (claim) => {
      for (const manager of approvalManagers) {
        const kind = manager.approvalKind;
        try {
          cancelWorkerTurnClaimBoundApprovals<ApprovalPayload>({
            claim,
            manager,
            publish: (record, liveRecord) => publishAuthorityClosure({ kind, record, liveRecord }),
          });
        } catch (error) {
          params.log.error?.(`${kind} approvals: worker-claim settlement failed: ${String(error)}`);
        }
      }
      questionManager.cancelClosedAuthorities();
    },
  );
  const unregisterApprovalAuthorityObserver = () => {
    unregisterWorkerTurnClaimClosedObserver?.();
    unregisterApprovalAuthorityClosedObserver();
  };
  const cancelRunBoundApprovals = (
    target: string | AgentRunDelegatedAuthority,
    context: GatewayRequestContext,
  ): number => {
    if (presentationWork.isClosing) {
      return 0;
    }
    let cancelled = 0;
    for (const manager of approvalManagers) {
      const kind = manager.approvalKind;
      const publish = (
        record: PendingAuthorityPublication["record"],
        liveRecord: PendingAuthorityPublication["liveRecord"],
      ) => publishResolution({ kind, record, liveRecord }, context, "run-abort");
      cancelled +=
        typeof target === "string"
          ? cancelUnboundRunApprovals<ApprovalPayload>({ runId: target, manager, publish })
          : cancelAgentRuntimeBoundApprovals<ApprovalPayload>({
              authority: target,
              reason: "permission-change",
              manager,
              publish,
            });
    }
    return cancelled;
  };
  const loadPluginApprovalHandlers = createLazyPromise(
    () =>
      import("./server-methods/plugin-approval.js").then(({ createPluginApprovalHandlers }) =>
        createPluginApprovalHandlers(pluginApprovalManager, {
          forwarder: execApprovalForwarder,
          iosPushDelivery: pluginApprovalIosPushDelivery,
        }),
      ),
    { cacheRejections: true },
  );
  const loadApprovalHandlers = createLazyPromise(
    () =>
      import("./server-methods/approval.js").then(({ createApprovalHandlers }) =>
        createApprovalHandlers({
          execApprovalManager,
          pluginApprovalManager,
          systemAgentApprovalManager,
          forwarder: execApprovalForwarder,
          iosPushDelivery: execApprovalIosPushDelivery,
          pluginIosPushDelivery: pluginApprovalIosPushDelivery,
        }),
      ),
    { cacheRejections: true },
  );
  const loadSecretsHandlers = createLazyPromise(
    async () => {
      const [{ createSecretsHandlers }, storeWriteService] = await Promise.all([
        loadSecretsModule(),
        loadSecretStoreWriteService(),
      ]);
      return createSecretsHandlers({
        reloadSecrets,
        storeWriteService,
        log: params.log,
        resolveSecrets: async ({
          allowedPaths,
          commandName,
          forcedActivePaths,
          optionalActivePaths,
          providerOverrides,
          targetIds,
        }) => {
          const { assignments, diagnostics, inactiveRefPaths } =
            await resolveCommandSecretsFromActiveRuntimeSnapshot({
              commandName,
              targetIds: new Set(targetIds),
              ...(allowedPaths ? { allowedPaths: new Set(allowedPaths) } : {}),
              ...(forcedActivePaths ? { forcedActivePaths: new Set(forcedActivePaths) } : {}),
              ...(optionalActivePaths ? { optionalActivePaths: new Set(optionalActivePaths) } : {}),
              ...(providerOverrides ? { providerOverrides } : {}),
            });
          return { assignments, diagnostics, inactiveRefPaths };
        },
      });
    },
    { cacheRejections: true },
  );

  const beginCloseApprovalObservers = () => {
    for (const manager of approvalManagers) {
      manager.beginClose();
    }
  };
  let stopPromise: Promise<void> | undefined;
  const stopOperatorInteractions = (): Promise<void> => {
    if (!stopPromise) {
      stopPromise = (async () => {
        // Preserve the existing authority-observer stop boundary. Retirement is
        // local only; pending durable approvals belong to next-start epoch recovery.
        unregisterApprovalAuthorityObserver();
        beginCloseApprovalObservers();
        for (const manager of approvalManagers) {
          manager.retire();
        }
        questionManager.close();
        await Promise.all(approvalManagers.map((manager) => manager.drain()));
        await presentationWork.drain();
        await execApprovalForwarder.stop();
        approvalPublicationContext = undefined;
        pendingAuthorityPublications.length = 0;
      })();
    }
    return stopPromise;
  };

  // Startup terminalized prior-runtime approvals above; retain their browser
  // publication until its real send/storage work finishes, including failure logging.
  void trackPresentationWork(() =>
    approvalWebPushDelivery.recoverTerminalDeliveries().catch((error: unknown) => {
      params.log.error?.(`approval Web Push restart recovery failed: ${String(error)}`);
    }),
  );

  return {
    execApprovalManager,
    cancelRunBoundApprovals,
    forwardPluginApprovalRequest: execApprovalForwarder.handlePluginApprovalRequested,
    approvalWebPushDelivery,
    pluginApprovalIosPushDelivery,
    pluginApprovalManager,
    placementStandingGrants,
    systemAgentApprovalManager,
    bindApprovalPublicationContext,
    beginCloseApprovalObservers,
    stopOperatorInteractions,
    questionManager,
    extraHandlers: {
      "exec.approval.get": createLazyHandler("exec.approval.get", loadExecApprovalHandlers),
      "exec.approval.list": createLazyHandler("exec.approval.list", loadExecApprovalHandlers),
      "exec.approval.request": createLazyHandler("exec.approval.request", loadExecApprovalHandlers),
      "exec.approval.waitDecision": createLazyHandler(
        "exec.approval.waitDecision",
        loadExecApprovalHandlers,
      ),
      "exec.approval.resolve": createLazyHandler("exec.approval.resolve", loadExecApprovalHandlers),
      "exec.approval.grants.list": createLazyHandler(
        "exec.approval.grants.list",
        loadExecApprovalHandlers,
      ),
      "exec.approval.grants.revoke": createLazyHandler(
        "exec.approval.grants.revoke",
        loadExecApprovalHandlers,
      ),
      "plugin.approval.list": createLazyHandler("plugin.approval.list", loadPluginApprovalHandlers),
      "plugin.approval.request": createLazyHandler(
        "plugin.approval.request",
        loadPluginApprovalHandlers,
      ),
      "plugin.approval.waitDecision": createLazyHandler(
        "plugin.approval.waitDecision",
        loadPluginApprovalHandlers,
      ),
      "plugin.approval.resolve": createLazyHandler(
        "plugin.approval.resolve",
        loadPluginApprovalHandlers,
      ),
      "approval.get": createLazyHandler("approval.get", loadApprovalHandlers),
      "approval.history": createLazyHandler("approval.history", loadApprovalHandlers),
      "approval.resolve": createLazyHandler("approval.resolve", loadApprovalHandlers),
      "question.request": createLazyHandler("question.request", loadQuestionHandlers),
      "question.waitAnswer": createLazyHandler("question.waitAnswer", loadQuestionHandlers),
      "question.resolve": createLazyHandler("question.resolve", loadQuestionHandlers),
      "question.get": createLazyHandler("question.get", loadQuestionHandlers),
      "question.list": createLazyHandler("question.list", loadQuestionHandlers),
      "secrets.reload": createLazyHandler("secrets.reload", loadSecretsHandlers),
      "secrets.resolve": createLazyHandler("secrets.resolve", loadSecretsHandlers),
      "secrets.store.list": createLazyHandler("secrets.store.list", loadSecretsHandlers),
      "secrets.store.set": createLazyHandler("secrets.store.set", loadSecretsHandlers),
      "secrets.store.delete": createLazyHandler("secrets.store.delete", loadSecretsHandlers),
    },
  };
}
