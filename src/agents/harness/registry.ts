import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { AgentHarness, AgentHarnessResetParams, RegisteredAgentHarness } from "./types.js";

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

export function getAgentHarness(id: string): AgentHarness | undefined {
  return getRegisteredAgentHarness(id)?.harness;
}

export function getRegisteredAgentHarness(id: string): RegisteredAgentHarness | undefined {
  return getAgentHarnessRegistryState().harnesses.get(id.trim());
}

export function listAgentHarnessIds(): string[] {
  return [...getAgentHarnessRegistryState().harnesses.keys()];
}

export function listRegisteredAgentHarnesses(): RegisteredAgentHarness[] {
  return Array.from(getAgentHarnessRegistryState().harnesses.values());
}

export function clearAgentHarnesses(): void {
  getAgentHarnessRegistryState().harnesses.clear();
}

export function restoreRegisteredAgentHarnesses(entries: RegisteredAgentHarness[]): void {
  const map = getAgentHarnessRegistryState().harnesses;
  map.clear();
  for (const entry of entries) {
    map.set(entry.harness.id, entry);
  }
}

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
