import type { ChannelReplayClaimHandle } from "openclaw/plugin-sdk/persistent-dedupe";
import type { ClawdbotConfig } from "./bot-runtime-api.js";
import type { FeishuIngressLifecycle } from "./feishu-ingress.js";

export function createFeishuBroadcastIngressSettlement(params: {
  lifecycle?: FeishuIngressLifecycle;
  replayClaim?: ChannelReplayClaimHandle;
  onReplayCommitError?: (error: unknown) => void;
  onAdopted?: () => void;
}): {
  createLane: (replayClaim?: ChannelReplayClaimHandle) => {
    lifecycle: FeishuIngressLifecycle;
    onDispatchComplete: (dispatched: boolean) => Promise<void>;
    onDispatchFailed: (error: unknown) => Promise<void>;
  };
  onLanePending: () => void;
  onDispatchComplete: () => Promise<void>;
  onDispatchFailed: (error: unknown) => Promise<void>;
} {
  type LaneState = {
    replayClaim?: ChannelReplayClaimHandle;
    status: "pending" | "deferred" | "adopted" | "completed" | "failed" | "abandoned";
  };

  const lanes = new Set<LaneState>();
  const failures: unknown[] = [];
  const fallbackAbortSignal = new AbortController().signal;
  let fanoutSettled = false;
  let terminal: "adopted" | "abandoned" | undefined;
  let adoption: Promise<void> | undefined;
  let abandonment: Promise<void> | undefined;
  let finalizing = false;
  let deferred = false;
  let replayReleased = false;

  const beginFinalizing = () => {
    if (finalizing) {
      return;
    }
    finalizing = true;
    params.lifecycle?.onAdoptionFinalizing();
  };
  const defer = () => {
    if (deferred) {
      return;
    }
    deferred = true;
    params.lifecycle?.onDeferred();
  };
  const reportReplayCommitError = (error: unknown) => {
    try {
      params.onReplayCommitError?.(error);
    } catch {
      // Reporting cannot undo an already adopted durable turn.
    }
  };
  const releaseReplayClaim = (error: unknown) => {
    if (replayReleased || terminal === "adopted") {
      return;
    }
    replayReleased = true;
    params.replayClaim?.release({ error });
  };
  const runAbandonment = async (error: unknown) => {
    if (terminal) {
      return;
    }
    releaseReplayClaim(error);
    try {
      await params.lifecycle?.onAbandoned();
    } finally {
      terminal = "abandoned";
    }
  };
  const abandon = async (error: unknown) => {
    if (terminal) {
      return;
    }
    if (adoption) {
      await adoption.catch(() => undefined);
      if (terminal) {
        return;
      }
    }
    const activeAbandonment = abandonment ?? runAbandonment(error);
    abandonment = activeAbandonment;
    await activeAbandonment;
  };
  const runAdoption = async () => {
    beginFinalizing();
    try {
      await params.lifecycle?.onAdopted();
      terminal = "adopted";
      try {
        params.onAdopted?.();
      } catch {
        // Local cleanup cannot reopen an already adopted durable turn.
      }
      try {
        await params.replayClaim?.commit();
      } catch (error) {
        reportReplayCommitError(error);
      }
    } catch (error) {
      await runAbandonment(error).catch(() => undefined);
      throw error;
    }
  };
  const adopt = async () => {
    if (terminal) {
      return;
    }
    if (abandonment) {
      await abandonment.catch(() => undefined);
      if (terminal) {
        return;
      }
    }
    const activeAdoption = adoption ?? runAdoption();
    adoption = activeAdoption;
    await activeAdoption;
  };
  const maybeSettle = async () => {
    if (!fanoutSettled || terminal) {
      return;
    }
    if (
      failures.length > 0 ||
      [...lanes].some((lane) => lane.status === "failed" || lane.status === "abandoned")
    ) {
      await abandon(
        failures.length === 1
          ? failures[0]
          : new AggregateError(failures, "Feishu broadcast dispatch failed"),
      );
      return;
    }
    if (
      [...lanes].some(
        (lane) =>
          lane.status === "pending" || lane.status === "deferred" || lane.status === "adopted",
      )
    ) {
      return;
    }
    await adopt();
  };

  return {
    createLane: (replayClaim) => {
      const lane: LaneState = { replayClaim, status: "pending" };
      lanes.add(lane);
      const releaseLane = (error: unknown) => {
        lane.replayClaim?.release({ error });
      };
      return {
        lifecycle: {
          abortSignal: params.lifecycle?.abortSignal ?? fallbackAbortSignal,
          onAdopted: async () => {
            if (
              lane.status === "adopted" ||
              lane.status === "completed" ||
              lane.status === "failed" ||
              lane.status === "abandoned"
            ) {
              return;
            }
            lane.status = "adopted";
            beginFinalizing();
            try {
              await lane.replayClaim?.commit();
            } catch (error) {
              reportReplayCommitError(error);
            }
            lane.status = "completed";
            await maybeSettle();
          },
          onDeferred: () => {
            if (lane.status !== "pending") {
              return;
            }
            lane.status = "deferred";
            defer();
          },
          onAdoptionFinalizing: beginFinalizing,
          onAbandoned: async () => {
            if (
              lane.status === "completed" ||
              lane.status === "failed" ||
              lane.status === "abandoned"
            ) {
              return;
            }
            lane.status = "abandoned";
            releaseLane(new Error("feishu-broadcast-turn-abandoned"));
            await maybeSettle();
          },
        },
        onDispatchComplete: async (dispatched) => {
          if (!dispatched && lane.status === "pending") {
            const error = new Error("feishu broadcast lane was not dispatched");
            lane.status = "failed";
            failures.push(error);
            releaseLane(error);
            return;
          }
          if (lane.status !== "pending") {
            return;
          }
          const error = new Error("feishu broadcast dispatch returned before turn adoption");
          lane.status = "failed";
          failures.push(error);
          releaseLane(error);
        },
        onDispatchFailed: async (error) => {
          failures.push(error);
          if (lane.status !== "completed") {
            lane.status = "failed";
            releaseLane(error);
          }
          await maybeSettle();
        },
      };
    },
    onLanePending: defer,
    onDispatchComplete: async () => {
      fanoutSettled = true;
      await maybeSettle();
    },
    onDispatchFailed: async (error) => {
      failures.push(error);
      fanoutSettled = true;
      await maybeSettle();
    },
  };
}

export function resolveBroadcastAgents(cfg: ClawdbotConfig, peerId: string): string[] | null {
  const broadcast = (cfg as Record<string, unknown>).broadcast;
  if (!broadcast || typeof broadcast !== "object") {
    return null;
  }
  const agents = (broadcast as Record<string, unknown>)[peerId];
  return Array.isArray(agents) && agents.length > 0 ? (agents as string[]) : null;
}

export function buildBroadcastSessionKey(
  baseSessionKey: string,
  originalAgentId: string,
  targetAgentId: string,
): string {
  const prefix = `agent:${originalAgentId}:`;
  return baseSessionKey.startsWith(prefix)
    ? `agent:${targetAgentId}:${baseSessionKey.slice(prefix.length)}`
    : baseSessionKey;
}
