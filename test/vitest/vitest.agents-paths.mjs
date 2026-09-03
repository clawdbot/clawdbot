// Canonical agent project ownership for focused runs, full suites, and CI.
const agentsRoot = "src/agents";
const embeddedRoot = `${agentsRoot}/embedded-agent-runner`;

// These suites mock shared runtime, network, or plugin modules and cannot
// share the non-isolated core worker without leaking module state.
const coreIsolatedFiles = [
  "src/agents/failover/classify.legacy-provider-predicates.test.ts",
  "src/agents/failover/failover-classification.corpus.test.ts",
  "src/agents/failover/provider-structured-signals.test.ts",
  "src/agents/media-generation-task-status-shared.test.ts",
  "src/agents/media-generation-task-status.test.ts",
  "src/agents/mcp-http-fetch.test.ts",
  "src/agents/mcp-transport.test.ts",
  "src/agents/model-catalog-visibility.test.ts",
  "src/agents/model-auth-env.provider-aliases.test.ts",
  "src/agents/model-selection.plugin-runtime.test.ts",
  "src/agents/models-config.runtime-source-snapshot.test.ts",
  "src/agents/openai-transport-stream.streaming.test.ts",
  "src/agents/subagents/registry/subagent-registry.announce-loop-guard.test.ts",
  "src/agents/subagents/registry/subagent-registry-restart-recovery.test.ts",
];
const incompleteTurnFiles = [
  `${embeddedRoot}/run.incomplete-turn.classification.test.ts`,
  `${embeddedRoot}/run.incomplete-turn.delivery-resolution.test.ts`,
  `${embeddedRoot}/run.incomplete-turn.error-recovery.test.ts`,
  `${embeddedRoot}/run.incomplete-turn.payload-resolution.test.ts`,
];
const overflowCompactionFiles = [
  `${embeddedRoot}/run.overflow-compaction.test.ts`,
  `${embeddedRoot}/run.prepared-harness-source-delivery.integration.test.ts`,
];

export const agentVitestProjectOwners = {
  all: {
    kind: "agent",
    name: "agents",
    config: "test/vitest/vitest.agents.config.ts",
    root: agentsRoot,
    dir: agentsRoot,
    include: [`${agentsRoot}/**/*.test.ts`],
    exclude: [],
  },
  coreIsolated: {
    kind: "agentsCoreIsolated",
    name: "agents-core-isolated",
    config: "test/vitest/vitest.agents-core-isolated.config.ts",
    root: agentsRoot,
    dir: agentsRoot,
    include: coreIsolatedFiles,
    exclude: [],
  },
  core: {
    kind: "agentCore",
    name: "agents-core",
    config: "test/vitest/vitest.agents-core.config.ts",
    root: agentsRoot,
    dir: agentsRoot,
    include: [`${agentsRoot}/*.test.ts`],
    exclude: coreIsolatedFiles,
  },
  embedded: {
    kind: "agentEmbedded",
    name: "agents-embedded-agent",
    config: "test/vitest/vitest.agents-embedded-agent.config.ts",
    root: embeddedRoot,
    dir: agentsRoot,
    include: [`${embeddedRoot}/*.test.ts`],
    exclude: [...incompleteTurnFiles, ...overflowCompactionFiles],
  },
  embeddedIncompleteTurn: {
    kind: "agentEmbeddedIncompleteTurn",
    name: "agents-embedded-agent-incomplete-turn",
    config: "test/vitest/vitest.agents-embedded-agent-incomplete-turn.config.ts",
    root: embeddedRoot,
    dir: embeddedRoot,
    include: incompleteTurnFiles,
    exclude: [],
  },
  embeddedOverflowCompaction: {
    kind: "agentEmbeddedOverflowCompaction",
    name: "agents-embedded-agent-overflow-compaction",
    config: "test/vitest/vitest.agents-embedded-agent-overflow-compaction.config.ts",
    root: embeddedRoot,
    dir: embeddedRoot,
    include: overflowCompactionFiles,
    exclude: [],
  },
  embeddedRun: {
    kind: "agentEmbeddedRun",
    name: "agents-embedded-agent-run",
    config: "test/vitest/vitest.agents-embedded-agent-run.config.ts",
    root: `${embeddedRoot}/run`,
    dir: `${embeddedRoot}/run`,
    include: [`${embeddedRoot}/run/**/*.test.ts`],
    exclude: [],
  },
  support: {
    kind: "agentSupport",
    name: "agents-support",
    config: "test/vitest/vitest.agents-support.config.ts",
    root: agentsRoot,
    dir: agentsRoot,
    include: [`${agentsRoot}/*/**/*.test.ts`],
    exclude: [...coreIsolatedFiles, `${embeddedRoot}/**`, `${agentsRoot}/tools/**`],
  },
  tools: {
    kind: "agentTools",
    name: "agents-tools",
    config: "test/vitest/vitest.agents-tools.config.ts",
    root: `${agentsRoot}/tools`,
    dir: agentsRoot,
    include: [`${agentsRoot}/tools/**/*.test.ts`],
    exclude: [],
  },
};

export const agentVitestProjectConfigs = [
  agentVitestProjectOwners.coreIsolated.config,
  agentVitestProjectOwners.core.config,
  agentVitestProjectOwners.embedded.config,
  agentVitestProjectOwners.embeddedIncompleteTurn.config,
  agentVitestProjectOwners.embeddedOverflowCompaction.config,
  agentVitestProjectOwners.embeddedRun.config,
  agentVitestProjectOwners.support.config,
  agentVitestProjectOwners.tools.config,
];

export const embeddedAgentVitestProjectOwners = [
  agentVitestProjectOwners.embedded,
  agentVitestProjectOwners.embeddedIncompleteTurn,
  agentVitestProjectOwners.embeddedOverflowCompaction,
  agentVitestProjectOwners.embeddedRun,
];

const coreIsolatedFileSet = new Set(coreIsolatedFiles);

export function isAgentsCoreIsolatedTestFile(value) {
  return coreIsolatedFileSet.has(value.replaceAll("\\", "/"));
}
