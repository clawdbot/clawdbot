/**
 * Registry for native agent harness implementations and lifecycle cleanup.
 */
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  assertDirectPluginRegistrationReplacement,
  requireActivePluginRegistry,
  resolveDirectPluginRegistrationOwner,
} from "../../plugins/runtime.js";
import type { AgentHarness, AgentHarnessResetParams, RegisteredAgentHarness } from "./types.js";

const log = createSubsystemLogger("agents/harness");

function getAgentHarnesses() {
  return requireActivePluginRegistry().agentHarnesses;
}

/** Registers or replaces an agent harness under its trimmed id. */
export function registerAgentHarness(
  harness: AgentHarness,
  options?: { ownerPluginId?: string },
): void {
  const id = harness.id.trim();
  const harnesses = getAgentHarnesses();
  const pluginId = resolveDirectPluginRegistrationOwner(options?.ownerPluginId) ?? "core";
  if (id === "openclaw") {
    throw new Error('agent harness id "openclaw" is reserved for the built-in runtime');
  }
  const entry = {
    pluginId,
    source: "runtime",
    harness: {
      ...harness,
      id,
      pluginId: harness.pluginId ?? (pluginId === "core" ? undefined : pluginId),
    },
  };
  const existingIndex = harnesses.findIndex((registration) => registration.harness.id === id);
  if (existingIndex !== -1) {
    assertDirectPluginRegistrationReplacement(
      harnesses[existingIndex]?.pluginId,
      `agent harness ${id}`,
    );
  }
  if (existingIndex === -1) {
    harnesses.push(entry);
  } else {
    harnesses.splice(existingIndex, 1, entry);
  }
}

/** Returns the harness plus plugin ownership metadata for registry diagnostics. */
export function getRegisteredAgentHarness(id: string): RegisteredAgentHarness | undefined {
  const registration = getAgentHarnesses().find((entry) => entry.harness.id === id.trim());
  return registration
    ? {
        harness: registration.harness,
        ownerPluginId: registration.pluginId === "core" ? undefined : registration.pluginId,
      }
    : undefined;
}

/** Resolves the registry-owned approval identity for the exact registered harness object. */
export function resolveAgentHarnessOwnerPluginId(harness: AgentHarness): string {
  const registration = getRegisteredAgentHarness(harness.id);
  if (registration?.harness !== harness) {
    throw new Error(`Agent harness ${harness.id} changed during owner resolution.`);
  }
  return registration.ownerPluginId ?? "core";
}

/** Lists registered harness records for selection and lifecycle fan-out. */
export function listRegisteredAgentHarnesses(): RegisteredAgentHarness[] {
  return getAgentHarnesses().map((entry) => ({
    harness: entry.harness,
    ownerPluginId: entry.pluginId === "core" ? undefined : entry.pluginId,
  }));
}

/** Clears all harnesses; intended for tests and controlled registry reloads. */
export function clearAgentHarnesses(): void {
  getAgentHarnesses().length = 0;
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
