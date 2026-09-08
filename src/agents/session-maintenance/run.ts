import type { FollowupRun } from "../../auto-reply/reply/queue.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { fenceScheduledGatewayContextResolver } from "../../gateway/scheduled-run-gateway-context.js";
import {
  createAbortError,
  isAbortError,
  racePromiseWithAbortSignal,
} from "../../infra/abort-signal.js";
import { assertAgentRunLifecycleGenerationCurrent } from "../../infra/agent-events.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getPluginRegistryForContext } from "../../plugins/runtime.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../../process/gateway-work-admission.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { createCommandBudget } from "../command/maintenance-budget.js";
import {
  loadAgentRunnerMemoryRuntime,
  loadSessionStoreRuntime,
} from "../command/runtime-loaders.js";
import type { CompactionRequestBudget } from "../sessions/compaction/request-budget.js";
import { createSessionMaintenanceOwner } from "./coordinator.js";

const log = createSubsystemLogger("agents/session-maintenance");
export type SessionMaintenanceRequest = {
  prepared: {
    cfg: OpenClawConfig;
    sessionKey?: string;
    storePath: string;
    timeoutMs: number;
    runtimePolicySessionKey?: string;
  };
  followupRun: FollowupRun;
  sessionId: string;
  lifecycleRevision: SessionEntry["lifecycleRevision"];
  lifecycleGeneration: string;
  startedAt: number;
  oneShotCliRun?: boolean;
  agentHarnessId?: string;
  compactionRequestBudget?: CompactionRequestBudget;
};

/** Copy data only: turn callbacks, tool grants, delivery context and writer custody stay behind. */
export function createSessionMaintenanceFollowup(params: {
  run: Pick<
    FollowupRun["run"],
    | "agentId"
    | "agentDir"
    | "workspaceDir"
    | "cwd"
    | "messageProvider"
    | "agentAccountId"
    | "chatType"
    | "conversationRoutePeerId"
    | "conversationToolPolicy"
    | "groupId"
    | "groupChannel"
    | "groupSpace"
    | "skillsSnapshot"
    | "thinkingCatalog"
    | "skipProviderRuntimeHints"
    | "thinkLevel"
    | "verboseLevel"
    | "timeoutMs"
  >;
  sessionEntry: SessionEntry;
  cfg: OpenClawConfig;
  sessionKey?: string;
  runtimePolicySessionKey?: string;
  provider: string;
  model: string;
  auth: Pick<FollowupRun["run"], "authProfileId" | "authProfileIdSource">;
}): FollowupRun {
  const { run, sessionEntry } = params;
  return {
    prompt: "",
    enqueuedAt: Date.now(),
    run: {
      agentId: run.agentId,
      agentDir: run.agentDir,
      sessionId: sessionEntry.sessionId,
      sessionKey: params.sessionKey,
      sessionFile: params.sessionKey ?? sessionEntry.sessionId,
      workspaceDir: run.workspaceDir,
      cwd: run.cwd ?? run.workspaceDir,
      runtimePolicySessionKey: params.runtimePolicySessionKey ?? params.sessionKey,
      config: params.cfg,
      messageProvider: run.messageProvider,
      agentAccountId: run.agentAccountId,
      chatType: run.chatType,
      conversationRoutePeerId: run.conversationRoutePeerId,
      conversationToolPolicy: run.conversationToolPolicy,
      groupId: run.groupId,
      groupChannel: run.groupChannel,
      groupSpace: run.groupSpace,
      provider: params.provider,
      model: params.model,
      authProfileId: params.auth.authProfileId,
      authProfileIdSource: params.auth.authProfileIdSource,
      blockReplyBreak: "message_end",
      skillsSnapshot: run.skillsSnapshot,
      thinkingCatalog: run.thinkingCatalog,
      skipProviderRuntimeHints: run.skipProviderRuntimeHints,
      thinkLevel: run.thinkLevel,
      verboseLevel: run.verboseLevel ?? "off",
      timeoutMs: run.timeoutMs,
      senderIsOwner: false,
    },
  };
}

/** Optional work has a fresh root and writer admission after the foreground owner closes. */
export function scheduleSessionMaintenance(
  request: SessionMaintenanceRequest,
  afterOwnerSettles?: Promise<boolean>,
): void {
  const { prepared, followupRun } = request;
  const sessionKey = prepared.sessionKey;
  if (!sessionKey) {
    return;
  }
  if (request.oneShotCliRun) {
    log.debug("Optional session maintenance skipped: one-shot CLI owns no post-return runtime.");
    return;
  }
  const pluginRegistry = getPluginRegistryForContext();
  if (!pluginRegistry) {
    log.warn("Optional session maintenance skipped: no active plugin registry.");
    return;
  }
  const resolveGatewayContext = fenceScheduledGatewayContextResolver(
    getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext,
  );
  const budget = createCommandBudget(request.startedAt, prepared.timeoutMs);
  if (budget.remainingMs() === 0) {
    budget.dispose();
    return;
  }
  const interrupted = new AbortController();
  const owner = createSessionMaintenanceOwner({
    sessionKey,
    preemptible: true,
    abortSignal: AbortSignal.any([interrupted.signal, budget.signal]),
  });
  const assertCurrent = () => {
    owner.assertCurrent();
    assertAgentRunLifecycleGenerationCurrent(request.lifecycleGeneration);
    if (resolveGatewayContext && !resolveGatewayContext()) {
      throw createAbortError("Optional maintenance Gateway instance retired");
    }
  };
  const run = withPluginRuntimeGatewayRequestScope(
    {
      pluginRegistry,
      resolveGatewayContext,
      isWebchatConnect: () => false,
    },
    async () => {
      if (
        afterOwnerSettles &&
        !(await racePromiseWithAbortSignal(afterOwnerSettles, owner.signal))
      ) {
        log.debug(
          "Optional session maintenance skipped: foreground owner did not complete successfully.",
        );
        return;
      }
      return owner.run(() =>
        runWithGatewayIndependentRootWorkAdmission(
          async () => {
            assertCurrent();
            const { loadSessionEntryReadOnly } = await loadSessionStoreRuntime();
            let entry: SessionEntry | undefined;
            const admission = await beginSessionWorkAdmission({
              scope: prepared.storePath,
              identities: [sessionKey, request.sessionId],
              signal: owner.signal,
              onInterrupt: () =>
                interrupted.abort(
                  createAbortError("Session maintenance writer admission interrupted"),
                ),
              assertAllowed: () => {
                assertCurrent();
                entry = loadSessionEntryReadOnly({
                  storePath: prepared.storePath,
                  sessionKey,
                  readConsistency: "latest",
                });
                if (
                  !entry ||
                  entry.sessionId !== request.sessionId ||
                  entry.lifecycleRevision !== request.lifecycleRevision
                ) {
                  throw createAbortError("Session changed before optional maintenance admission");
                }
                if (entry.pendingFinalDelivery) {
                  throw createAbortError(
                    "Optional maintenance skipped while final delivery is pending",
                  );
                }
              },
            });
            try {
              await admission.run(async () => {
                assertCurrent();
                if (!entry) {
                  throw createAbortError("Session maintenance has no admitted session");
                }
                const sessionStore = { [sessionKey]: entry };
                const memory = await loadAgentRunnerMemoryRuntime();
                assertCurrent();
                followupRun.run.timeoutMs = budget.remainingMs();
                assertCurrent();
                const flushed = await memory.runMemoryFlushIfNeeded({
                  cfg: prepared.cfg,
                  followupRun,
                  promptForEstimate: "",
                  defaultModel: followupRun.run.model,
                  resolvedVerboseLevel: followupRun.run.verboseLevel ?? "off",
                  sessionEntry: entry,
                  sessionStore,
                  sessionKey,
                  runtimePolicySessionKey: prepared.runtimePolicySessionKey ?? sessionKey,
                  storePath: prepared.storePath,
                  isHeartbeat: false,
                  abortSignal: owner.signal,
                });
                // Flush reports aborted attempts as failed outcomes; cancellation still forbids compaction.
                assertCurrent();
                entry = flushed.sessionEntry ?? entry;
                followupRun.run.sessionId = entry.sessionId;
                followupRun.run.timeoutMs = budget.remainingMs();
                assertCurrent();
                await memory.runSessionCompactionIfNeeded({
                  cfg: prepared.cfg,
                  followupRun,
                  promptForEstimate: "",
                  // The completed user is canonical history; do not reserve its input twice.
                  compactionRequestBudget: request.compactionRequestBudget
                    ? { ...request.compactionRequestBudget, pendingTokens: 0 }
                    : undefined,
                  sessionEntry: entry,
                  sessionStore,
                  sessionKey,
                  runtimePolicySessionKey: prepared.runtimePolicySessionKey ?? sessionKey,
                  storePath: prepared.storePath,
                  defaultModel: followupRun.run.model,
                  isHeartbeat: false,
                  agentHarnessId: request.agentHarnessId,
                  abortSignal: owner.signal,
                  authorize: () => {
                    assertCurrent();
                    return true;
                  },
                });
              });
            } finally {
              admission.release();
            }
          },
          "session-maintenance",
          owner.signal,
        ),
      );
    },
  );
  void owner
    .track(run)
    .catch((error: unknown) => {
      if (owner.signal.aborted || isAbortError(error)) {
        log.debug(`Optional session maintenance cancelled: ${formatErrorMessage(error)}`);
      } else {
        log.warn(`Optional session maintenance failed: ${formatErrorMessage(error)}`);
      }
    })
    .finally(() => budget.dispose());
}
