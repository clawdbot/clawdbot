/** Exact local implementation owned by one plugin agent harness process. */
export type AgentHarnessRuntimeArtifactBinding = Readonly<{
  id: string;
  fingerprint: string;
}>;

/** Runtime artifact a verified continuation must keep using. */
export type ExpectedAgentHarnessRuntimeArtifact = Readonly<{
  harnessId: string;
  artifact: AgentHarnessRuntimeArtifactBinding;
}>;
