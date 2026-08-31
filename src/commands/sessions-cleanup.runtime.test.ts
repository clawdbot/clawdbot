import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionCleanupSummary } from "../config/sessions.js";
import type { RuntimeEnv } from "../runtime.js";
import { runLocalSessionsCleanup } from "./sessions-cleanup.runtime.js";

const runSessionsCleanup = vi.hoisted(() => vi.fn());

vi.mock("../config/sessions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/sessions.js")>()),
  runSessionsCleanup,
}));
vi.mock("../plugins/loader.js", () => ({
  loadPluginRegistryHandle: vi.fn(() => ({})),
}));
vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: vi.fn(() => ({
    plugins: [],
    manifestRegistry: {},
    discovery: {},
    index: {},
  })),
}));
vi.mock("../plugins/installed-plugin-index-install-records.js", () => ({
  extractPluginInstallRecordsFromInstalledPluginIndex: vi.fn(() => []),
}));
vi.mock("../plugins/activation-planner.js", () => ({
  resolveManifestActivationPluginIds: vi.fn(() => []),
}));
vi.mock("../plugins/activation-context.js", () => ({
  withActivatedPluginIds: vi.fn((args: { config: unknown }) => args.config),
}));
vi.mock("../plugins/runtime/gateway-request-scope.js", () => ({
  withPluginRuntimeRegistryScope: vi.fn((_registry: unknown, run: () => unknown) => run()),
}));
vi.mock("../agents/agent-scope-config.js", () => ({
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/openclaw-test-workspace"),
}));

const runtime: RuntimeEnv = {
  log: () => {},
  error: () => {},
  exit: () => {},
};

function summary(agentId: string): SessionCleanupSummary {
  return {
    agentId,
    storePath: `/tmp/${agentId}/sessions.json`,
    mode: "enforce",
    dryRun: false,
    beforeCount: 1,
    afterCount: 0,
    missing: 1,
    dmScopeRetired: 0,
    modelRunPruned: 0,
    pruned: 0,
    capped: 0,
    unreferencedArtifacts: { scannedFiles: 0, removedFiles: 0, freedBytes: 0, olderThanMs: 0 },
    diskBudget: null,
    wouldMutate: true,
    applied: true,
    appliedCount: 0,
  };
}

describe("runLocalSessionsCleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps prior store summaries when a later target returns a failure", async () => {
    const mainSummary = summary("main");
    runSessionsCleanup
      .mockResolvedValueOnce({
        mode: "enforce",
        previewResults: [],
        appliedSummaries: [mainSummary],
      })
      .mockRejectedValueOnce(new Error("injected later-store failure"));

    const result = await runLocalSessionsCleanup(
      {
        cfg: {},
        opts: { enforce: true },
        targets: [
          { agentId: "main", storePath: "/tmp/main/sessions.json" },
          { agentId: "work", storePath: "/tmp/work/sessions.json" },
        ],
      },
      runtime,
    );

    expect(result.appliedSummaries).toEqual([mainSummary]);
    expect(result.failure).toMatchObject({
      target: { agentId: "work", storePath: "/tmp/work/sessions.json" },
      lifecycleCommitted: false,
    });
  });
});
