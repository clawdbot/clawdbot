/**
 * Registry for native agent harness implementations and lifecycle cleanup.
 */
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { AgentHarness, AgentHarnessResetParams, RegisteredAgentHarness } from "./types.js";

/**
 * Process-wide registry for agent harnesses contributed by core and runtime plugins.
 *
 * The registry is global-symbol backed so repeated imports, test module resets, and plugin lazy
 * loads share one harness table inside a running gateway process.
 */
const AGENT_HARNESS_REGISTRY_STATE = Symbol.for("openclaw.agentHarnessRegistryState");
const log = createSubsystemLogger("agents/harness");

type AgentHarnessRegistryState = {
  harnesses: Map<string, RegisteredAgentHarness>;
};

function getAgentHarnessRegistryState(): AgentHarnessRegistryState {
  const globalState = globalThis as typeof globalThis & {
    [AGENT_HARNESS_REGISTRY_STATE]?: AgentHarnessRegistryState;
  };
  globalState[AGENT_HARNESS_REGISTRY_STATE] ??= {
    harnesses: new Map<string, RegisteredAgentHarness>(),
  };
  return globalState[AGENT_HARNESS_REGISTRY_STATE];
}

/** Registers or replaces an agent harness under its trimmed id. */
export function registerAgentHarness(
  harness: AgentHarness,
  options?: { ownerPluginId?: string },
): void {
  const id = harness.id.trim();
  getAgentHarnessRegistryState().harnesses.set(id, {
    harness: {
      ...harness,
      id,
      pluginId: harness.pluginId ?? options?.ownerPluginId,
    },
    ownerPluginId: options?.ownerPluginId,
  });
}

/** Returns the harness plus plugin ownership metadata for registry diagnostics. */
export function getRegisteredAgentHarness(id: string): RegisteredAgentHarness | undefined {
  return getAgentHarnessRegistryState().harnesses.get(id.trim());
}

/** Lists registered harness records for selection and lifecycle fan-out. */
export function listRegisteredAgentHarnesses(): RegisteredAgentHarness[] {
  return Array.from(getAgentHarnessRegistryState().harnesses.values());
}

/** Clears all harnesses; intended for tests and controlled registry reloads. */
export function clearAgentHarnesses(): void {
  getAgentHarnessRegistryState().harnesses.clear();
}

/** Restores a prior harness snapshot after tests temporarily replace the registry. */
export function restoreRegisteredAgentHarnesses(entries: RegisteredAgentHarness[]): void {
  const map = getAgentHarnessRegistryState().harnesses;
  map.clear();
  for (const entry of entries) {
    map.set(entry.harness.id, entry);
  }
}

/** Calls each registered harness session-reset hook without letting one failure stop the fan-out. */
export async function resetRegisteredAgentHarnessSessions(
  params: AgentHarnessResetParams,
): Promise<void> {
  await Promise.all(
    listRegisteredAgentHarnesses().map(async (entry) => {
      if (!entry.harness.reset) {
        return;
      }
      try {
        await entry.harness.reset(params);
      } catch (error) {
        log.warn(`${entry.harness.label} session reset hook failed`, {
          harnessId: entry.harness.id,
          error,
        });
      }
    }),
  );
}

/** Calls each registered harness dispose hook during registry shutdown or reload. */
export async function disposeRegisteredAgentHarnesses(): Promise<void> {
  await Promise.all(
    listRegisteredAgentHarnesses().map(async (entry) => {
      if (!entry.harness.dispose) {
        return;
      }
      try {
        await entry.harness.dispose();
      } catch (error) {
        log.warn(`${entry.harness.label} dispose hook failed`, {
          harnessId: entry.harness.id,
          error,
        });
      }
    }),
  );
}
