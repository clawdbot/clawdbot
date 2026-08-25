// Gateway auxiliary method handlers.
// Wires reload, secrets, exec approval, and plugin approval RPC handlers.
import { randomUUID } from "node:crypto";
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
import {
  resolveCommandSecretsFromActiveRuntimeSnapshot,
  type CommandSecretAssignment,
} from "../secrets/runtime-command-secrets.js";
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
} from "./exec-approval-manager.js";
import { createLazyHandler } from "./lazy-handler.js";
import type { CronStandingGrantMintSpec } from "./operator-approval-standing-grants.js";
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
  // Both approval kinds share one durable first-answer-wins registry and
  // Gateway-lifetime epoch while retaining separate in-process waiter maps.
  // A newly constructed Gateway cannot resume the prior lifetime's waiters.
  const approvalPersistence = { runtimeEpoch: randomUUID() };
  const approvalStartupNowMs = Date.now();
  closeOrphanedOperatorApprovals({
    runtimeEpoch: approvalPersistence.runtimeEpoch,
    nowMs: approvalStartupNowMs,
  });
  pruneTerminalOperatorApprovals({ nowMs: approvalStartupNowMs });
  const createApprovalManager = <TPayload>(
    approvalKind: "exec" | "plugin" | "system-agent",
    resolveAllowedDecisions: (request: TPayload) => readonly ExecApprovalDecision[],
    resolveStandingGrantMint?: (request: TPayload) => CronStandingGrantMintSpec | null,
  ) =>
    new ExecApprovalManager<TPayload>({
      approvalKind,
      persistence: approvalPersistence,
      resolveAudienceSessionKeys: resolveApprovalSessionAudienceWithFallback,
      resolveAllowedDecisions,
      ...(resolveStandingGrantMint ? { resolveStandingGrantMint } : {}),
      ...(params.resolveGrantDefaultExpiresAtMs
        ? { resolveStandingGrantExpiresAtMs: params.resolveGrantDefaultExpiresAtMs }
        : {}),
      onLifecycle: params.onApprovalLifecycle,
      // Timeout expiry is gateway-clock truth: publish the terminal like a
      // resolve so reviewer surfaces need not infer it from their own clocks.
      // system-agent approvals have no forwarder/push route to notify.
      onExpired: (record, liveRecord) => {
        if (approvalKind === "system-agent") {
          return;
        }
        const publication = { kind: approvalKind, record, liveRecord };
        publishAuthorityClosure(publication as PendingAuthorityPublication);
      },
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
  // Startup already terminalized prior-runtime approvals above. Replay any
  // durable request targets so their actionable browser prompts are replaced.
  void approvalWebPushDelivery.recoverTerminalDeliveries().catch((error: unknown) => {
    params.log.error?.(`approval Web Push restart recovery failed: ${String(error)}`);
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
  );
  const pluginApprovalIosPushDelivery = createPluginApprovalIosPushDelivery({ log: params.log });
  type PendingAuthorityPublication = {
    kind: ChannelApprovalKind;
    record: Parameters<typeof publishAppliedApprovalResolution>[0]["record"];
    liveRecord: Parameters<typeof publishAppliedApprovalResolution>[0]["liveRecord"];
  };
  let approvalPublicationContext: GatewayRequestContext | undefined;
  const pendingAuthorityPublications: PendingAuthorityPublication[] = [];
  const publishAuthorityClosure = (publication: PendingAuthorityPublication) => {
    const context = approvalPublicationContext;
    if (!context) {
      pendingAuthorityPublications.push(publication);
      return;
    }
    void publishAppliedApprovalResolution({
      record: publication.record,
      liveRecord: publication.liveRecord,
      context,
      forwarder: execApprovalForwarder,
      ...(publication.kind === "exec"
        ? { iosPushDelivery: execApprovalIosPushDelivery }
        : { pluginIosPushDelivery: pluginApprovalIosPushDelivery }),
    }).catch((error: unknown) => {
      context.logGateway?.error?.(
        `${publication.kind} approvals: authority-close publication failed: ${String(error)}`,
      );
    });
  };
  const bindApprovalPublicationContext = (context: GatewayRequestContext) => {
    approvalPublicationContext = context;
    for (const publication of pendingAuthorityPublications.splice(0)) {
      publishAuthorityClosure(publication);
    }
  };
  const unregisterApprovalAuthorityClosedObserver = registerAgentRunDelegatedAuthorityClosedHandler(
    (authority) => {
      try {
        cancelAgentRuntimeBoundApprovals({
          authority,
          manager: execApprovalManager,
          publish: (record, liveRecord) =>
            publishAuthorityClosure({ kind: "exec", record, liveRecord }),
        });
      } catch (error) {
        params.log.error?.(`exec approvals: authority-close settlement failed: ${String(error)}`);
      }
      try {
        cancelAgentRuntimeBoundApprovals({
          authority,
          manager: pluginApprovalManager,
          publish: (record, liveRecord) =>
            publishAuthorityClosure({ kind: "plugin", record, liveRecord }),
        });
      } catch (error) {
        params.log.error?.(`plugin approvals: authority-close settlement failed: ${String(error)}`);
      }
      params.onAgentRunAuthorityClosed?.(authority);
    },
  );
  const unregisterWorkerTurnClaimClosedObserver = params.registerWorkerTurnClaimClosedHandler?.(
    (claim) => {
      try {
        cancelWorkerTurnClaimBoundApprovals({
          claim,
          manager: execApprovalManager,
          publish: (record, liveRecord) =>
            publishAuthorityClosure({ kind: "exec", record, liveRecord }),
        });
      } catch (error) {
        params.log.error?.(`exec approvals: worker-claim settlement failed: ${String(error)}`);
      }
      try {
        cancelWorkerTurnClaimBoundApprovals({
          claim,
          manager: pluginApprovalManager,
          publish: (record, liveRecord) =>
            publishAuthorityClosure({ kind: "plugin", record, liveRecord }),
        });
      } catch (error) {
        params.log.error?.(`plugin approvals: worker-claim settlement failed: ${String(error)}`);
      }
    },
  );
  const unregisterApprovalAuthorityObserver = () => {
    unregisterWorkerTurnClaimClosedObserver?.();
    unregisterApprovalAuthorityClosedObserver();
  };
  const cancelRunBoundApprovals = (runId: string, context: GatewayRequestContext): number => {
    const publish = (
      kind: ChannelApprovalKind,
      record: Parameters<typeof publishAppliedApprovalResolution>[0]["record"],
      liveRecord: Parameters<typeof publishAppliedApprovalResolution>[0]["liveRecord"],
    ) => {
      void publishAppliedApprovalResolution({
        record,
        liveRecord,
        context,
        forwarder: execApprovalForwarder,
        ...(kind === "exec"
          ? { iosPushDelivery: execApprovalIosPushDelivery }
          : { pluginIosPushDelivery: pluginApprovalIosPushDelivery }),
      }).catch((error: unknown) => {
        context.logGateway?.error?.(
          `${kind} approvals: run-abort publication failed: ${String(error)}`,
        );
      });
    };
    return cancelUnboundRunApprovals({
      runId,
      manager: execApprovalManager,
      publish: (record, liveRecord) => publish("exec", record, liveRecord),
    });
  };
  const systemAgentApprovalManager = createApprovalManager<SystemAgentApprovalRequestPayload>(
    "system-agent",
    () => SYSTEM_AGENT_APPROVAL_DECISIONS,
  );
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
          if (assignments.length === 0) {
            return {
              assignments: [] as CommandSecretAssignment[],
              diagnostics,
              inactiveRefPaths,
            };
          }
          return { assignments, diagnostics, inactiveRefPaths };
        },
      });
    },
    { cacheRejections: true },
  );

  return {
    execApprovalManager,
    cancelRunBoundApprovals,
    forwardPluginApprovalRequest: execApprovalForwarder.handlePluginApprovalRequested,
    approvalWebPushDelivery,
    pluginApprovalIosPushDelivery,
    pluginApprovalManager,
    systemAgentApprovalManager,
    bindApprovalPublicationContext,
    unregisterApprovalAuthorityObserver,
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
