import "./agent-step.js";

type TranscriptAgentStepRunner = (params: {
  sessionKey: string;
  message: string;
  transcriptMessage: string;
}) => Promise<string | undefined>;

type AgentStepTestApi = {
  setTranscriptRunnerForTest(runner?: TranscriptAgentStepRunner): void;
};

function getTestApi(): AgentStepTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.agentStepTestApi")
  ] as AgentStepTestApi;
}

export const testing = {
  setDepsForTest(overrides?: { runTranscriptAgentStep?: TranscriptAgentStepRunner }): void {
    getTestApi().setTranscriptRunnerForTest(overrides?.runTranscriptAgentStep);
  },
};
