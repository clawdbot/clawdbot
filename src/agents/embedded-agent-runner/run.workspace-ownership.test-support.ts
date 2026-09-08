import { expect, vi } from "vitest";
import { isPathInside } from "../../infra/path-guards.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";

/** Guard the real consumers before discovery can touch an unowned workspace. */
export async function guardRunWorkspaceOwnership(
  state: Pick<OpenClawTestState, "root" | "home" | "stateDir">,
) {
  // Import after the harness reset so the spies intercept the runner's graph.
  const metadata = await import("../../plugins/plugin-metadata-snapshot.js");
  const repository = await import("../system-prompt-params.js");
  const requests: string[] = [];
  const forbidden: string[] = [];
  const check = (workspaceDir: string | undefined) => {
    if (workspaceDir === undefined) {
      return;
    }
    requests.push(workspaceDir);
    expect(process.env.HOME, "fixture home survives runner reset/warmup").toBe(state.home);
    expect(process.env.OPENCLAW_STATE_DIR, "fixture state survives runner reset/warmup").toBe(
      state.stateDir,
    );
    if (!isPathInside(state.root, workspaceDir)) {
      // Discovery can swallow filesystem errors; retain independent evidence.
      forbidden.push(workspaceDir);
      throw new Error("embedded-run fixture requested an unowned workspace");
    }
  };
  const loadMetadata = metadata.loadPluginMetadataSnapshot;
  const resolveRepository = repository.resolveSystemPromptRepoRoot;
  const metadataSpy = vi
    .spyOn(metadata, "loadPluginMetadataSnapshot")
    .mockImplementation((params) => {
      check(params?.workspaceDir);
      return loadMetadata(params);
    });
  const repositorySpy = vi
    .spyOn(repository, "resolveSystemPromptRepoRoot")
    .mockImplementation((params) => {
      check(params.workspaceDir);
      check(params.cwd);
      check(params.config?.agents?.defaults?.repoRoot);
      return resolveRepository(params);
    });
  return {
    verifyAndRestore() {
      const metadataCalls = metadataSpy.mock.calls.length;
      const repositoryCalls = repositorySpy.mock.calls.length;
      metadataSpy.mockRestore();
      repositorySpy.mockRestore();
      expect(requests.length, "real workspace consumer was exercised").toBeGreaterThan(0);
      expect(forbidden, "unowned workspace requests blocked before filesystem access").toEqual([]);
      expect(metadataCalls, "real metadata consumer was exercised").toBeGreaterThan(0);
      expect(repositoryCalls, "real repository consumer was exercised").toBeGreaterThan(0);
    },
  };
}
