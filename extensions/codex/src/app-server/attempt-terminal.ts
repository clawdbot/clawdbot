import {
  agentHarnessAttemptTerminal,
  type AgentHarnessAttemptResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { TranscriptEntryAnchor } from "openclaw/plugin-sdk/session-transcript-runtime";

export type EmbeddedRunAttemptResult = Extract<AgentHarnessAttemptResult, { terminal: unknown }> & {
  /** Host-private terminal identity returned to the harness selection boundary. */
  contextEngineTerminalAnchor?: TranscriptEntryAnchor;
};
export type AttemptFailureSource = Extract<
  EmbeddedRunAttemptResult["terminal"],
  { kind: "failed" }
>["source"];
export const attemptTerminal = agentHarnessAttemptTerminal;
