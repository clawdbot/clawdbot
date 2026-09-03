import path from "node:path";
import type { PreparedProviderAuth } from "./agent-auth-credential-modes.js";

// Published owners record their secret-free provider-auth facts here so runtime-policy
// decisions on request paths read the prepared generation instead of re-probing provider
// plugins. Without it every harness decision reloads plugin discovery modules.
const factsByAgentDir = new Map<string, PreparedProviderAuth>();

export function publishPreparedProviderAuthFacts(agentDir: string, facts: PreparedProviderAuth) {
  factsByAgentDir.set(path.resolve(agentDir), facts);
}

/** Retires only the generation that is still current; a replacement owner already replaced it. */
export function retirePreparedProviderAuthFacts(agentDir: string, facts: PreparedProviderAuth) {
  const key = path.resolve(agentDir);
  if (factsByAgentDir.get(key) === facts) {
    factsByAgentDir.delete(key);
  }
}

export function readPreparedProviderAuthFacts(agentDir: string): PreparedProviderAuth | undefined {
  return factsByAgentDir.get(path.resolve(agentDir));
}

export function resetPreparedProviderAuthFactsForTest(): void {
  factsByAgentDir.clear();
}
