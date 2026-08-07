import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

const AGENT_RUN_EXECUTION_CONTEXT_KEY = Symbol.for("openclaw.agentRunExecutionContext");

type AgentRunExecutionContext = {
  lifecycleGeneration: string;
  contextLifecycleTokenByRun: Map<string, object>;
  onceByRun: Map<string, Promise<unknown>>;
};

function getAgentRunExecutionContext() {
  return resolveGlobalSingleton<AsyncLocalStorage<AgentRunExecutionContext>>(
    AGENT_RUN_EXECUTION_CONTEXT_KEY,
    () => new AsyncLocalStorage<AgentRunExecutionContext>(),
  );
}

export function getAgentRunExecutionLifecycleGeneration(): string | undefined {
  return getAgentRunExecutionContext().getStore()?.lifecycleGeneration;
}

export function captureAgentRunExecutionContextLifecycleToken(
  runId: string,
  lifecycleGeneration: string,
  contextLifecycleToken: object,
): void {
  const context = getAgentRunExecutionContext().getStore();
  if (
    context?.lifecycleGeneration === lifecycleGeneration &&
    !context.contextLifecycleTokenByRun.has(runId)
  ) {
    context.contextLifecycleTokenByRun.set(runId, contextLifecycleToken);
  }
}

export function getAgentRunExecutionContextLifecycleToken(runId: string): object | undefined {
  return getAgentRunExecutionContext().getStore()?.contextLifecycleTokenByRun.get(runId);
}

/** Runs one execution with immutable ownership inherited by every emitted event. */
export function withAgentRunLifecycleGeneration<T>(lifecycleGeneration: string, run: () => T): T {
  const storage = getAgentRunExecutionContext();
  const parent = storage.getStore();
  const sameLifecycle = parent?.lifecycleGeneration === lifecycleGeneration;
  const onceByRun = sameLifecycle ? parent.onceByRun : new Map();
  const contextLifecycleTokenByRun = sameLifecycle
    ? new Map(parent.contextLifecycleTokenByRun)
    : new Map<string, object>();
  return storage.run({ lifecycleGeneration, contextLifecycleTokenByRun, onceByRun }, run);
}

/** Shares one operation across fallback attempts that belong to the same admitted run. */
export function runOncePerAgentRun<T>(runId: string, operation: string, run: () => Promise<T>) {
  const context = getAgentRunExecutionContext().getStore();
  if (!context) {
    return run();
  }
  const key = `${operation}:${runId}`;
  const existing = context.onceByRun.get(key);
  if (existing) {
    return existing as Promise<T>;
  }
  const pending = Promise.resolve().then(run);
  context.onceByRun.set(key, pending);
  return pending;
}
