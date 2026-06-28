import { normalizeAgentId } from "../routing/session-key.js";
import { assertSecretOwnerAvailable } from "./runtime-degraded-state.js";

/** Runtime owner for one agent's sandbox credentials. */
export function runtimeSandboxSecretOwnerId(agentId: string): string {
  return `agent-sandbox:${normalizeAgentId(agentId)}`;
}

/** Rejects one agent's sandbox when its runtime credentials are cold. */
export function assertRuntimeSandboxSecretOwnerAvailable(agentId: string): void {
  assertSecretOwnerAvailable("capability", runtimeSandboxSecretOwnerId(agentId));
}
