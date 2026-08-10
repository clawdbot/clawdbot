import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { CodeModeActivityOwner } from "../../code-mode-activity.js";
import type { CodeModeStats } from "../../code-mode-stats.js";
import type { StreamFn } from "../../runtime/index.js";
import type {
  AgentSubmissionHandle,
  AgentSubmissionObserver,
  ModelCallObserver,
} from "../../sessions/agent-session-accounting.js";
import type { NormalizedUsage } from "../../usage.js";
import type { ToolSummaryTrace } from "../types.js";

export type EmbeddedRunAccountingObservation = {
  provider: string;
  model: string;
  config?: OpenClawConfig;
  agentDir?: string;
  usage?: NormalizedUsage;
  assistantTurns?: number;
  assistantTurnsObserved: boolean;
  /** Exact subset of assistantTurns whose provider usage payload was observed. */
  assistantTurnsWithUsage?: number;
  toolSummary?: ToolSummaryTrace;
  toolsObserved: boolean;
  codeModeEngaged?: boolean;
  codeModeStats?: CodeModeStats;
  codeModeLifecycleObserved: boolean;
};

export type EmbeddedRunOpaqueWorkReason =
  | "acp_runtime"
  | "settled_finalization_failed"
  | "session_core_compaction"
  | "session_extension_compaction"
  | "native_harness_compaction"
  | "deferred_context_engine_maintenance"
  | "post_turn_compaction";

type EmbeddedRunAccountingObservers = {
  readonly codeModeActivityOwner?: CodeModeActivityOwner;
  onAgentSubmission?: AgentSubmissionObserver;
  onModelCall?: ModelCallObserver;
  onModelCallInstrumentationInstalled?: () => void;
  onAttemptObserved?: (observation: EmbeddedRunAccountingObservation) => void;
  onRuntimeSelected?: (runtime: "embedded" | "native") => void;
  onOpaqueWork?: (reason: EmbeddedRunOpaqueWorkReason) => void;
};

const observers = new WeakMap<object, EmbeddedRunAccountingObservers>();

export function bindEmbeddedRunAccountingObservers<T extends object>(
  target: T,
  value: EmbeddedRunAccountingObservers | undefined,
): T {
  if (
    value?.codeModeActivityOwner ||
    value?.onAgentSubmission ||
    value?.onModelCall ||
    value?.onModelCallInstrumentationInstalled ||
    value?.onAttemptObserved ||
    value?.onRuntimeSelected ||
    value?.onOpaqueWork
  ) {
    observers.set(target, value);
  }
  return target;
}

export function copyEmbeddedRunAccountingObservers<T extends object>(source: object, target: T): T {
  return bindEmbeddedRunAccountingObservers(target, observers.get(source));
}

export function copyEmbeddedRunCallAccountingObservers<T extends object>(
  source: object,
  target: T,
): T {
  const sourceObservers = observers.get(source);
  const onAgentSubmission = sourceObservers?.onAgentSubmission;
  const onModelCall = sourceObservers?.onModelCall;
  const onModelCallInstrumentationInstalled = sourceObservers?.onModelCallInstrumentationInstalled;
  return bindEmbeddedRunAccountingObservers(
    target,
    onAgentSubmission || onModelCall || onModelCallInstrumentationInstalled
      ? { onAgentSubmission, onModelCall, onModelCallInstrumentationInstalled }
      : undefined,
  );
}

export function resolveEmbeddedRunAccountingObservers(
  target: object,
): EmbeddedRunAccountingObservers | undefined {
  return observers.get(target);
}

function settleModelCallFromResult(
  handle: AgentSubmissionHandle,
  result: { stopReason?: unknown },
): void {
  handle.settle(
    result.stopReason === "error" || result.stopReason === "aborted" ? "failed" : "completed",
  );
}

function makeOneShotModelCallHandle(handle: AgentSubmissionHandle): AgentSubmissionHandle {
  let settled = false;
  return {
    settle(outcome) {
      if (settled) {
        return;
      }
      settled = true;
      handle.settle(outcome);
    },
  };
}

function observeModelCallResult<
  T extends AsyncIterable<unknown> & { result: () => Promise<{ stopReason?: unknown }> },
>(stream: T, handle: AgentSubmissionHandle): T {
  const result = stream.result.bind(stream);
  const iterate = stream[Symbol.asyncIterator].bind(stream);
  return new Proxy(stream, {
    get(target, property, receiver) {
      if (property === Symbol.asyncIterator) {
        return async function* () {
          try {
            yield* { [Symbol.asyncIterator]: iterate };
          } catch (error) {
            handle.settle("failed");
            throw error;
          }
        };
      }
      if (property === "result") {
        return async () => {
          try {
            const resolved = await result();
            settleModelCallFromResult(handle, resolved);
            return resolved;
          } catch (error) {
            handle.settle("failed");
            throw error;
          }
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * Counts one admitted agent-loop model call. Provider-internal retries remain
 * transport attempts and are deliberately outside this logical call counter.
 */
export function wrapStreamFnWithModelCallAccounting(
  streamFn: StreamFn,
  observer: ModelCallObserver | undefined,
): StreamFn {
  if (!observer) {
    return streamFn;
  }
  return async (...args) => {
    const handle = makeOneShotModelCallHandle(observer());
    try {
      const stream = await streamFn(...args);
      return observeModelCallResult(stream, handle);
    } catch (error) {
      handle.settle("failed");
      throw error;
    }
  };
}
