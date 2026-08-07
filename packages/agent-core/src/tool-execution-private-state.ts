import { AsyncLocalStorage } from "node:async_hooks";

declare const privateStateBrand: unique symbol;
export type AgentToolExecutionPrivateState = { readonly [privateStateBrand]: true };

const activePrivateState = new AsyncLocalStorage<AgentToolExecutionPrivateState>();
const targetSessionKeys = new WeakMap<AgentToolExecutionPrivateState, string>();

export const createAgentToolExecutionPrivateState = (): AgentToolExecutionPrivateState =>
  Object.freeze({}) as AgentToolExecutionPrivateState;

export const runWithAgentToolExecutionPrivateState = <T>(
  state: AgentToolExecutionPrivateState,
  run: () => T,
): T => activePrivateState.run(state, run);

export function snapshotAgentToolExecutionPrivateState(
  state: AgentToolExecutionPrivateState,
): AgentToolExecutionPrivateState | undefined {
  const targetSessionKey = targetSessionKeys.get(state);
  targetSessionKeys.delete(state);
  if (!targetSessionKey) {
    return undefined;
  }
  const snapshot = Object.freeze({}) as AgentToolExecutionPrivateState;
  targetSessionKeys.set(snapshot, targetSessionKey);
  return snapshot;
}

export function recordAgentToolTargetSessionKey(sessionKey: string): void {
  const state = activePrivateState.getStore();
  const normalized = sessionKey.trim();
  if (state && normalized) {
    targetSessionKeys.set(state, normalized);
  }
}

export function consumeAgentToolTargetSessionKey(
  state: AgentToolExecutionPrivateState | undefined,
): string | undefined {
  const targetSessionKey = state ? targetSessionKeys.get(state) : undefined;
  if (state) {
    targetSessionKeys.delete(state);
  }
  return targetSessionKey;
}
