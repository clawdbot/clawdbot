export const EMBEDDED_AGENT_EXECUTION_PHASES = [
  "runner_entered",
  "workspace",
  "runtime_plugins",
  "model_resolution",
  "auth",
  "context_engine",
  "attempt_dispatch",
  "context_assembled",
  "turn_accepted",
  "process_spawned",
  "tool_execution_started",
  "assistant_output_started",
  "model_call_started",
] as const;

export type EmbeddedAgentExecutionPhase = (typeof EMBEDDED_AGENT_EXECUTION_PHASES)[number];

export const EMBEDDED_AGENT_EXECUTION_PHASE_LABELS = {
  runner_entered: "runner-entered",
  workspace: "workspace",
  runtime_plugins: "runtime-plugins",
  model_resolution: "model-resolution",
  auth: "auth",
  context_engine: "context-engine",
  attempt_dispatch: "attempt-dispatch",
  context_assembled: "context-assembled",
  turn_accepted: "turn-accepted",
  process_spawned: "process-spawned",
  tool_execution_started: "tool-execution-started",
  assistant_output_started: "assistant-output-started",
  model_call_started: "model-call-started",
} as const satisfies Record<EmbeddedAgentExecutionPhase, string>;

export function formatEmbeddedAgentExecutionPhase(
  phase?: EmbeddedAgentExecutionPhase,
): string | undefined {
  return phase ? EMBEDDED_AGENT_EXECUTION_PHASE_LABELS[phase] : undefined;
}
