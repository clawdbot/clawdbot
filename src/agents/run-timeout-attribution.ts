export const AGENT_RUN_TIMEOUT_PHASES = [
  "queue",
  "preflight",
  "provider",
  "post_turn",
  "gateway_draining",
] as const;

export type AgentRunTimeoutPhase = (typeof AGENT_RUN_TIMEOUT_PHASES)[number];

const AGENT_RUN_TIMEOUT_PHASE_SET = new Set<string>(AGENT_RUN_TIMEOUT_PHASES);

export function normalizeAgentRunTimeoutPhase(value: unknown): AgentRunTimeoutPhase | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return AGENT_RUN_TIMEOUT_PHASE_SET.has(normalized)
    ? (normalized as AgentRunTimeoutPhase)
    : undefined;
}

export { asBoolean as normalizeProviderStarted } from "../utils/boolean.js";
