// Test routing globs for agent core, embedded-agent, tool, and support suites.
export const agentsAllTestPatterns = ["src/agents/**/*.test.ts"];

export const agentsCoreTestPatterns = ["src/agents/*.test.ts"];

export const agentsEmbeddedTestPatterns = ["src/agents/embedded-agent-runner/**/*.test.ts"];

export const agentsToolsTestPatterns = ["src/agents/tools/**/*.test.ts"];

export const agentsSupportTestPatterns = ["src/agents/*/**/*.test.ts"];

export const agentsSupportExcludePatterns = [
  "src/agents/embedded-agent-runner/**",
  "src/agents/tools/**",
];
