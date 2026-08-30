import { normalizeAgentId } from "../routing/session-key.js";

/** Runtime owner for one agent's configured memory embedding provider. */
export function runtimeMemorySecretOwnerId(agentId: string): string {
  return `memory-provider:${normalizeAgentId(agentId)}`;
}
