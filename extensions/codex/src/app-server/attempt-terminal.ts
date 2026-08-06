import {
  agentHarnessAttemptTerminal,
  type AgentHarnessAttemptResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";

export type EmbeddedRunAttemptResult = Extract<AgentHarnessAttemptResult, { terminal: unknown }>;
export type AttemptFailureSource = Extract<
  EmbeddedRunAttemptResult["terminal"],
  { kind: "failed" }
>["source"];
export const attemptTerminal = agentHarnessAttemptTerminal;
