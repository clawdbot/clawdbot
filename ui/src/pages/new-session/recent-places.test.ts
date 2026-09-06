// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isKnownWorkspacePath } from "./path.ts";
import { recentPlaces } from "./recent-places.ts";

describe("recentPlaces", () => {
  it("deduplicates Gateway locations, caps newest-first, and ignores historical node folders", () => {
    expect(
      recentPlaces(
        [
          { execCwd: "/workspace" },
          { execCwd: "/node/repo", execNode: "macbook" },
          { execCwd: "/node/repo", execNode: "macbook" },
          { execCwd: "/gateway/repo" },
          { execCwd: "/gone/repo", execNode: "retired" },
          {
            execCwd: "/preferred/selected",
            worktree: { repoRoot: "/ignored/worktree" },
          },
          { worktree: { repoRoot: "/worktree/one" } },
          { execCwd: "  /cwd/two  " },
          { worktree: { repoRoot: "/capped/out" } },
        ],
        {
          workspace: "/workspace",
          allowGatewayFolder: () => true,
        },
      ),
    ).toEqual([
      { folder: "/gateway/repo" },
      { folder: "/preferred/selected" },
      { folder: "/worktree/one" },
      { folder: "/cwd/two" },
    ]);
  });

  it("filters Gateway recents through the viewer's folder boundary", () => {
    expect(
      recentPlaces(
        [
          { execCwd: "/workspace/packages/app" },
          { execCwd: "/workspace-other/private" },
          { execCwd: "/node/repo", execNode: "macbook" },
        ],
        {
          workspace: "/workspace",
          allowGatewayFolder: (folder) => isKnownWorkspacePath(["/workspace"], folder),
        },
      ),
    ).toEqual([{ folder: "/workspace/packages/app" }]);
  });
});
