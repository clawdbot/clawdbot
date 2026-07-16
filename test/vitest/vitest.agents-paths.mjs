// Test routing globs for agent core, embedded-agent, tool, and support suites.
export const agentsAllTestPatterns = ["src/agents/**/*.test.ts"];

// These suites install mocks for shared runtime, network, or plugin modules.
// Keep their module graphs separate from the shared agents-core worker.
export const agentsCoreIsolatedTestFiles = [
  "src/agents/image-generation-task-status.test.ts",
  "src/agents/media-generation-task-status-shared.test.ts",
  "src/agents/mcp-http-fetch.test.ts",
  "src/agents/mcp-transport.test.ts",
  "src/agents/model-auth-env.provider-aliases.test.ts",
  "src/agents/model-selection.plugin-runtime.test.ts",
  "src/agents/models-config.runtime-source-snapshot.test.ts",
  "src/agents/video-generation-task-status.test.ts",
];

const agentsCoreIsolatedTestFileSet = new Set(agentsCoreIsolatedTestFiles);

export function isAgentsCoreIsolatedTestFile(value) {
  return agentsCoreIsolatedTestFileSet.has(value.replaceAll("\\", "/"));
}

export const agentsCoreTestPatterns = ["src/agents/*.test.ts"];

export const agentsEmbeddedTestPatterns = ["src/agents/embedded-agent-runner/**/*.test.ts"];

export const agentsToolsTestPatterns = ["src/agents/tools/**/*.test.ts"];

export const agentsSupportTestPatterns = ["src/agents/*/**/*.test.ts"];

export const agentsSupportExcludePatterns = [
  "src/agents/embedded-agent-runner/**",
  "src/agents/tools/**",
];
