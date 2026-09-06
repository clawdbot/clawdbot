/** Per-registry command execution admission and retirement drain. */
import { AsyncLocalStorage } from "node:async_hooks";
import { isPluginRegistryRetired } from "./registry-lifecycle.js";
import type { PluginRegistry } from "./registry-types.js";

type PluginCommandExecutionState = {
  count: number;
  waiters: Array<() => void>;
};

type PluginCommandExecutionToken = {
  registry: PluginRegistry;
  active: boolean;
};

const executionStates = new WeakMap<PluginRegistry, PluginCommandExecutionState>();
const executionContext = new AsyncLocalStorage<ReadonlySet<PluginCommandExecutionToken>>();

function getExecutionState(registry: PluginRegistry): PluginCommandExecutionState {
  const existing = executionStates.get(registry);
  if (existing) {
    return existing;
  }
  const created = { count: 0, waiters: [] };
  executionStates.set(registry, created);
  return created;
}

export function getPluginCommandExecutionCount(registry: PluginRegistry): number {
  return executionStates.get(registry)?.count ?? 0;
}

function beginPluginCommandExecution(registry: PluginRegistry): boolean {
  if (isPluginRegistryRetired(registry)) {
    return false;
  }
  getExecutionState(registry).count += 1;
  return true;
}

function endPluginCommandExecution(registry: PluginRegistry): void {
  const state = getExecutionState(registry);
  if (state.count <= 0) {
    throw new Error("Plugin command execution lock is unbalanced.");
  }
  state.count -= 1;
  if (state.count !== 0) {
    return;
  }
  const waiters = state.waiters.splice(0);
  for (const resolve of waiters) {
    resolve();
  }
}

export function isPluginCommandExecutionActiveHere(registry: PluginRegistry): boolean {
  return [...(executionContext.getStore() ?? [])].some(
    (token) => token.registry === registry && token.active,
  );
}

export async function withPluginCommandExecution<T>(
  registry: PluginRegistry,
  run: () => T | Promise<T>,
): Promise<{ admitted: true; value: T } | { admitted: false }> {
  if (!beginPluginCommandExecution(registry)) {
    return { admitted: false };
  }
  const token: PluginCommandExecutionToken = { registry, active: true };
  const active = new Set(
    [...(executionContext.getStore() ?? [])].filter((inherited) => inherited.registry !== registry),
  );
  active.add(token);
  try {
    return { admitted: true, value: await executionContext.run(active, run) };
  } finally {
    token.active = false;
    endPluginCommandExecution(registry);
  }
}

export async function waitForPluginCommandExecutions(registry: PluginRegistry): Promise<void> {
  const state = getExecutionState(registry);
  if (state.count === 0) {
    return;
  }
  await new Promise<void>((resolve) => {
    state.waiters.push(resolve);
  });
}
