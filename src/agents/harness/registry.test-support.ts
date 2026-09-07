import { clearAgentHarnesses, registerAgentHarness } from "./registry.js";
import type { RegisteredAgentHarness } from "./types.js";

export function restoreRegisteredAgentHarnesses(entries: RegisteredAgentHarness[]): void {
  clearAgentHarnesses();
  for (const entry of entries) {
    registerAgentHarness(entry.harness, { ownerPluginId: entry.ownerPluginId });
  }
}
