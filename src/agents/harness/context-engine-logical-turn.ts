import { sanitizeForLog } from "../../../packages/terminal-core/src/ansi.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  evaluateContextEngineHostSupport,
  supportsContextEngineDurableTurnAdvancement,
  type ContextEngineHostSupport,
} from "../../context-engine/host-compat.js";
import { ensureContextEnginesInitialized } from "../../context-engine/init.js";
import { resolveLogicalTurnContextEngines } from "../../context-engine/registry.js";
import type { ContextEngine, ContextEngineOperation } from "../../context-engine/types.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.types.js";
import { runAgentCleanupStep } from "../run-cleanup-timeout.js";

type LogicalTurnSelectionState = "unselected" | "selected" | "started" | "disposed";

type EffectiveContextEngineRef = Readonly<{
  engine: ContextEngine;
  registeredId: string;
  ownerPluginId?: string;
  mode: "configured" | "legacy-degraded";
  reason?: string;
}>;

export type ContextEngineLogicalTurnLease = {
  /** Compatibility getter for internal callers while the single context object is threaded. */
  readonly engine: ContextEngine;
  readonly effectiveEngine: ContextEngine;
  readonly effectiveEngineId: string;
  readonly effectiveEnginePluginId?: string;
  readonly degraded: boolean;
  readonly degradedReason?: string;
  selectForHost: (params: {
    host: ContextEngineHostSupport;
    operation: ContextEngineOperation;
    requiresDurableCommit: boolean;
  }) => EffectiveContextEngineRef;
  degradeBeforeStart: (reason: string) => EffectiveContextEngineRef;
  begin: () => EffectiveContextEngineRef;
  deferDisposalUntil: (promise: Promise<unknown>) => void;
  dispose: () => Promise<void>;
};

export function selectContextEngineForTranscriptHost(params: {
  lease: ContextEngineLogicalTurnLease;
  host: ContextEngineHostSupport;
  operation: ContextEngineOperation;
  recorder: Pick<UserTurnTranscriptRecorder, "getAdmissionReceipt" | "hasPersisted"> | undefined;
}): EffectiveContextEngineRef {
  const admission = params.recorder?.getAdmissionReceipt();
  // Selection runs during turn preparation, before the user turn is written, so an admitted
  // receipt does not exist yet on the paths that persist during the run. A receipt is only
  // owed once the turn has actually been persisted: until then there is no admitted entry for
  // the fence to anchor to, so there is nothing to degrade over.
  if (params.recorder && !admission && params.recorder.hasPersisted()) {
    return params.lease.degradeBeforeStart(
      "current-turn transcript admission receipt is unavailable",
    );
  }
  return params.lease.selectForHost({
    host: params.host,
    operation: params.operation,
    requiresDurableCommit: params.recorder !== undefined,
  });
}

export async function createContextEngineLogicalTurnLease(params: {
  identity: { runId: string; sessionId: string };
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  warn?: (message: string) => void;
}): Promise<ContextEngineLogicalTurnLease> {
  const { runId, sessionId } = params.identity;
  ensureContextEnginesInitialized();
  const resolution = await resolveLogicalTurnContextEngines(params.config, {
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
  });
  let state: LogicalTurnSelectionState = "unselected";
  let effective = resolution.configured;
  let degradedReason = resolution.configuredFailure;
  let warned = false;
  const disposalHolds = new Set<Promise<unknown>>();
  const isBaselineEngineSelection =
    resolution.configuredFailure === undefined &&
    resolution.configured.registeredId === resolution.fallback.registeredId;

  const asEffective = (): EffectiveContextEngineRef =>
    Object.freeze({
      ...effective,
      mode: degradedReason ? "legacy-degraded" : "configured",
      ...(degradedReason ? { reason: degradedReason } : {}),
    });

  const warnOnce = (reason: string) => {
    if (warned) {
      return;
    }
    warned = true;
    (params.warn ?? console.warn)(
      `[context-engine] Context engine "${sanitizeForLog(resolution.configuredId)}" degraded to "${sanitizeForLog(resolution.fallback.registeredId)}" for this logical turn: ${sanitizeForLog(reason)}. ` +
        `The "${sanitizeForLog(resolution.fallback.registeredId)}" engine will handle only this turn; configuration is unchanged, and "${sanitizeForLog(resolution.configuredId)}" will be retried next turn.`,
    );
  };

  const degradeBeforeStart = (reason: string): EffectiveContextEngineRef => {
    if (state === "disposed") {
      throw new Error("context-engine logical turn selection is already pinned");
    }
    if (isBaselineEngineSelection) {
      if (state === "unselected") {
        state = "selected";
      }
      return asEffective();
    }
    if (state === "started") {
      throw new Error("context-engine logical turn selection is already pinned");
    }
    degradedReason ??= reason;
    effective = resolution.fallback;
    state = "selected";
    warnOnce(degradedReason);
    return asEffective();
  };

  const resolveSelectionIssue = (selection: {
    host: ContextEngineHostSupport;
    operation: ContextEngineOperation;
    requiresDurableCommit: boolean;
  }): string | undefined => {
    const support = evaluateContextEngineHostSupport({
      contextEngineInfo: effective.engine.info,
      operation: selection.operation,
      host: selection.host,
    });
    if (!support.ok) {
      return `host "${selection.host.id}" is missing ${support.missingCapabilities.join(", ")}`;
    }
    if (isBaselineEngineSelection) {
      // Legacy delegates durable transcript ownership to SessionManager, so only its
      // actual host requirements apply to repeated logical-turn selection.
      return undefined;
    }
    if (
      // A recorder-backed turn will be admitted during the run, so the declaration is required
      // whether or not the receipt exists yet at selection time. Gating this on the receipt alone
      // would let an engine that declares durable advancement but omits current-turn fencing run
      // on fresh turns, which the documented contract sends to legacy.
      selection.requiresDurableCommit &&
      effective.engine.info.transcriptSemantics?.currentTurnFence !== "before-current-turn-entry-v1"
    ) {
      return "current-turn transcript fencing is not declared";
    }
    if (
      selection.requiresDurableCommit &&
      !supportsContextEngineDurableTurnAdvancement(effective.engine)
    ) {
      return "atomic idempotent turn advancement is not declared";
    }
    return undefined;
  };

  if (resolution.configuredFailure) {
    degradeBeforeStart(resolution.configuredFailure);
  }

  const lease: ContextEngineLogicalTurnLease = {
    get engine() {
      return effective.engine;
    },
    get effectiveEngine() {
      return effective.engine;
    },
    get effectiveEngineId() {
      return effective.registeredId;
    },
    get effectiveEnginePluginId() {
      return effective.ownerPluginId;
    },
    get degraded() {
      return degradedReason !== undefined;
    },
    get degradedReason() {
      return degradedReason;
    },
    selectForHost(selection) {
      if (state === "disposed") {
        throw new Error("context-engine logical turn lease is already disposed");
      }
      if (degradedReason) {
        return asEffective();
      }
      const issue = resolveSelectionIssue(selection);
      if (issue) {
        if (state === "started") {
          throw new Error(
            `context-engine logical turn cannot change to incompatible ${selection.host.label}: ${issue}`,
          );
        }
        return degradeBeforeStart(issue);
      }
      if (state === "unselected") {
        state = "selected";
      }
      return asEffective();
    },
    degradeBeforeStart,
    begin() {
      if (state === "disposed") {
        throw new Error("context-engine logical turn lease is already disposed");
      }
      state = "started";
      return asEffective();
    },
    deferDisposalUntil(promise) {
      if (state === "disposed") {
        throw new Error("context-engine logical turn lease is already disposed");
      }
      disposalHolds.add(promise);
      void promise.finally(() => disposalHolds.delete(promise)).catch(() => {});
    },
    async dispose() {
      if (state === "disposed") {
        return;
      }
      state = "disposed";
      const engines = new Set<ContextEngine>([
        resolution.configured.engine,
        resolution.fallback.engine,
      ]);
      // Dispose instances in parallel so their deadlines do not stack. The
      // shared helper records each failure before one-shot cleanup checks ownership.
      const disposeEngines = async () => {
        await Promise.allSettled(
          [...engines].map((engine) =>
            runAgentCleanupStep({
              runId,
              sessionId,
              step: "context-engine-dispose",
              log: { warn: params.warn ?? console.warn },
              cleanup: async () => {
                await engine.dispose?.();
              },
            }),
          ),
        );
      };
      if (disposalHolds.size > 0) {
        void Promise.allSettled(disposalHolds).then(disposeEngines);
        return;
      }
      await disposeEngines();
    },
  };
  return lease;
}
