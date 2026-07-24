/** Shared Vitest module mocks for isolated-agent cron tests. */
// Isolated turns lazily consume this process-stable runtime after agent execution. Load it during
// suite setup so first-test timings cover cron behavior rather than module initialization.
import "../utils/usage-format.js";
import { vi } from "vitest";

const loadPreparedModelCatalog = vi.hoisted(() => vi.fn());

vi.mock("../agents/embedded-agent.js", () => ({
  abortEmbeddedAgentRun: vi.fn().mockReturnValue(false),
  runEmbeddedAgent: vi.fn(),
  resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
}));

vi.mock("../agents/prepared-model-catalog.js", async () => {
  const { resolveAgentDir, resolveAgentWorkspaceDir, resolveDefaultAgentId } =
    await vi.importActual<typeof import("../agents/agent-scope.js")>("../agents/agent-scope.js");
  return {
    loadPreparedModelCatalog,
    loadPublishedPreparedModelCatalog: loadPreparedModelCatalog,
    loadPublishedPreparedModelCatalogOwnerSnapshot: vi.fn(
      async (params: {
        agentId?: string;
        agentDir?: string;
        config?: object;
        workspaceDir?: string;
      }) => {
        const config = params.config ?? {};
        const agentId = params.agentId ?? resolveDefaultAgentId(config);
        return {
          agentId,
          agentDir: params.agentDir ?? resolveAgentDir(config, agentId),
          workspaceDir: params.workspaceDir ?? resolveAgentWorkspaceDir(config, agentId),
          config,
          modelCatalog: {
            entries: (await loadPreparedModelCatalog(params)) ?? [],
            routeVariants: [],
          },
        };
      },
    ),
  };
});

vi.mock("../agents/model-selection.js", async () => {
  const actual = await vi.importActual<typeof import("../agents/model-selection.js")>(
    "../agents/model-selection.js",
  );
  return {
    ...actual,
    isCliProvider: vi.fn(() => false),
  };
});

vi.mock("../agents/subagent-announce.js", () => ({
  runSubagentAnnounceFlow: vi.fn(),
}));

vi.mock("../plugins/runtime-plugins.runtime.js", () => ({
  ensureRuntimePluginsLoaded: vi.fn(),
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(),
}));
