import {
  AGENT_RUN_TERMINAL_RETRY_GRACE_MS,
  isDefinitiveRunLifecycle,
} from "../agents/agent-run-terminal-outcome.js";
import type { AgentEventRuntimePayload } from "../infra/agent-events.js";
import { createAgentRunStaleLifecycleError } from "../infra/agent-lifecycle-error.js";
import { getAgentRunContextOwnerStatus } from "../infra/agent-run-registry.js";
import { persistGatewaySessionLifecycleEvent } from "./session-lifecycle-state.js";

type LifecyclePersistenceParams = Parameters<typeof persistGatewaySessionLifecycleEvent>[0];
type TerminalPersistenceAuthority = {
  claimId: string;
  lifecycleGeneration: string;
  runId: string;
};
type ObservedTerminalPersistenceParams = Omit<
  LifecyclePersistenceParams,
  "assertCommitAllowed" | "event"
> & {
  authority?: TerminalPersistenceAuthority;
  clientRunId?: string;
  event: AgentEventRuntimePayload;
};
type PreparedPersistence = {
  expired: boolean;
  promise: Promise<void>;
  settled: boolean;
  timer: ReturnType<typeof setTimeout>;
};

function assertTerminalAuthority(authority: TerminalPersistenceAuthority): void {
  if (
    getAgentRunContextOwnerStatus(
      authority.runId,
      authority.claimId,
      authority.lifecycleGeneration,
    ) !== "active"
  ) {
    throw createAgentRunStaleLifecycleError();
  }
}

function terminalEventAuthority(
  event: LifecyclePersistenceParams["event"],
): TerminalPersistenceAuthority | undefined {
  return event.contextClaimId && event.lifecycleGeneration && event.runId
    ? {
        claimId: event.contextClaimId,
        lifecycleGeneration: event.lifecycleGeneration,
        runId: event.runId,
      }
    : undefined;
}

function terminalEventKey(event: {
  contextClaimId?: string;
  lifecycleGeneration?: string;
  runId?: string;
  seq?: number;
}): string | undefined {
  if (!event.runId || event.seq === undefined) {
    return undefined;
  }
  return `${event.contextClaimId ?? ""}\0${event.lifecycleGeneration ?? ""}\0${event.runId}\0${event.seq}`;
}

/** Owns each definitive lifecycle write before optional chat presentation code runs. */
export function createSessionLifecyclePersistenceOwner() {
  const prepared = new Map<string, PreparedPersistence>();
  const inFlight = new Set<Promise<void>>();

  const observe = (params: ObservedTerminalPersistenceParams) => {
    const key = terminalEventKey(params.event);
    const existing = key ? prepared.get(key)?.promise : undefined;
    if (existing) {
      return existing;
    }
    const authority = params.authority;
    const promise = persistGatewaySessionLifecycleEvent({
      sessionKey: params.sessionKey,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      event: {
        ...params.event,
        ...(params.event.lifecycleGeneration
          ? { lifecycleGeneration: params.event.lifecycleGeneration }
          : {}),
        ...(params.event.mainSessionRestartRecovery === true
          ? { mainSessionRestartRecovery: true as const }
          : {}),
        ...(params.clientRunId ? { clientRunId: params.clientRunId } : {}),
      },
      ...(authority
        ? {
            assertCommitAllowed: () => assertTerminalAuthority(authority),
          }
        : {}),
    });
    inFlight.add(promise);
    let entry: PreparedPersistence | undefined;
    const settle = () => {
      inFlight.delete(promise);
      if (!entry) {
        return;
      }
      entry.settled = true;
      if (entry.expired && key && prepared.get(key) === entry) {
        prepared.delete(key);
      }
    };
    void promise.then(settle, settle);
    if (key) {
      // Expiry bounds settled promises only. A queued write stays reachable so
      // delayed handler cleanup cannot revoke its claim before commit.
      const preparedEntry: PreparedPersistence = {
        expired: false,
        promise,
        settled: false,
        timer: setTimeout(() => {
          if (prepared.get(key) !== preparedEntry) {
            return;
          }
          preparedEntry.expired = true;
          if (preparedEntry.settled) {
            prepared.delete(key);
          }
        }, AGENT_RUN_TERMINAL_RETRY_GRACE_MS),
      };
      entry = preparedEntry;
      preparedEntry.timer.unref?.();
      prepared.set(key, preparedEntry);
    }
    return promise;
  };

  const take = (event: LifecyclePersistenceParams["event"]) => {
    const key = terminalEventKey(event);
    if (!key) {
      return undefined;
    }
    const entry = prepared.get(key);
    if (!entry) {
      return undefined;
    }
    clearTimeout(entry.timer);
    prepared.delete(key);
    return entry.promise;
  };

  return {
    observe,
    persist: (params: LifecyclePersistenceParams) => {
      const preparedPersistence = take(params.event);
      if (preparedPersistence) {
        return preparedPersistence;
      }
      if (
        isDefinitiveRunLifecycle({ phase: params.event.data?.phase, data: params.event.data }) &&
        terminalEventKey(params.event)
      ) {
        // Every definitive lifecycle is prepared by observe(). A missing promise
        // means its exact owner expired or shutdown retired it.
        return Promise.reject(createAgentRunStaleLifecycleError());
      }
      const authority = terminalEventAuthority(params.event);
      return persistGatewaySessionLifecycleEvent({
        ...params,
        ...(authority ? { assertCommitAllowed: () => assertTerminalAuthority(authority) } : {}),
      });
    },
    async drain(): Promise<void> {
      await Promise.allSettled(inFlight);
      for (const entry of prepared.values()) {
        clearTimeout(entry.timer);
      }
      prepared.clear();
    },
  };
}
