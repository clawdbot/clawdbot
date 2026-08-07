import { sanitizeForLog } from "../../../packages/terminal-core/src/ansi.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  evaluateContextEngineHostSupport,
  type ContextEngineHostSupport,
} from "../../context-engine/host-compat.js";
import { ensureContextEnginesInitialized } from "../../context-engine/init.js";
import { resolveLogicalTurnContextEngines } from "../../context-engine/registry.js";
import type { ContextEngine, ContextEngineOperation } from "../../context-engine/types.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.types.js";

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
    hasAdmissionFence: boolean;
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
  recorder: Pick<UserTurnTranscriptRecorder, "getAdmissionReceipt"> | undefined;
}): EffectiveContextEngineRef {
  const admission = params.recorder?.getAdmissionReceipt();
  if (params.recorder && !admission) {
    return params.lease.degradeBeforeStart(
      "current-turn transcript admission receipt is unavailable",
    );
  }
  return params.lease.selectForHost({
    host: params.host,
    operation: params.operation,
    requiresDurableCommit: params.recorder !== undefined,
    hasAdmissionFence: admission !== undefined,
  });
}

export async function createContextEngineLogicalTurnLease(params: {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  warn?: (message: string) => void;
}): Promise<ContextEngineLogicalTurnLease> {
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
      `[context-engine] Context engine "${sanitizeForLog(resolution.configuredId)}" degraded to "${sanitizeForLog(resolution.fallback.registeredId)}" for this logical turn: ${sanitizeForLog(reason)}`,
    );
  };

  const degradeBeforeStart = (reason: string): EffectiveContextEngineRef => {
    if (state === "started" || state === "disposed") {
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
    hasAdmissionFence: boolean;
  }): string | undefined => {
    const support = evaluateContextEngineHostSupport({
      contextEngineInfo: effective.engine.info,
      operation: selection.operation,
      host: selection.host,
    });
    if (!support.ok) {
      return `host "${selection.host.id}" is missing ${support.missingCapabilities.join(", ")}`;
    }
    if (
      selection.hasAdmissionFence &&
      effective.engine.info.transcriptSemantics?.currentTurnFence !== "before-current-turn-entry-v1"
    ) {
      return "current-turn transcript fencing is not declared";
    }
    if (
      selection.requiresDurableCommit &&
      (effective.engine.info.transcriptSemantics?.turnAdvancementIdempotency !==
        "atomic-idempotent-v1" ||
        typeof effective.engine.commitTurn !== "function")
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
      const disposeEngines = async () => {
        await Promise.allSettled([...engines].map(async (engine) => await engine.dispose?.()));
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
