import { beforeEach, describe, expect, it, vi } from "vitest";
import { runGit, type GitResult } from "../agents/worktrees/git.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveSessionDiffEmptyTree } from "./session-diff-revisions.js";

vi.mock("../agents/worktrees/git.js", () => ({ runGit: vi.fn() }));

function gitResult(stdout: string, code = 0): GitResult {
  return {
    stdout,
    code,
    stderr: "",
    signal: null,
    killed: false,
    termination: "exit",
    timeoutMs: 120_000,
  };
}

describe("empty-tree preparation", () => {
  beforeEach(() => {
    vi.mocked(runGit).mockReset();
  });

  it("shares concurrent Git work per repository without retaining settled results", async () => {
    const first = createDeferredCore<GitResult>();
    const other = createDeferredCore<GitResult>();
    vi.mocked(runGit).mockImplementation((root) =>
      root === "first" ? first.promise : other.promise,
    );

    const pending = Array.from({ length: 32 }, () => resolveSessionDiffEmptyTree("first"));
    const otherPending = resolveSessionDiffEmptyTree("other");
    first.resolve(gitResult("first-tree\n"));
    other.resolve(gitResult("other-tree\n"));

    expect(await Promise.all(pending)).toEqual(
      Array.from({ length: 32 }, () => ({ base: "first-tree" })),
    );
    await expect(otherPending).resolves.toEqual({ base: "other-tree" });
    expect(runGit).toHaveBeenCalledTimes(2);

    vi.mocked(runGit).mockResolvedValue(gitResult("replacement-tree\n"));
    await expect(resolveSessionDiffEmptyTree("first")).resolves.toEqual({
      base: "replacement-tree",
    });
    expect(runGit).toHaveBeenCalledTimes(3);
  });

  it.each(["exit", "reject"])(
    "releases shared %s failures before a later request",
    async (failure) => {
      const command = createDeferredCore<GitResult>();
      vi.mocked(runGit).mockReturnValue(command.promise);
      const pending = Array.from({ length: 8 }, () => resolveSessionDiffEmptyTree("failed"));
      if (failure === "reject") {
        command.reject(new Error("Git unavailable"));
      } else {
        command.resolve(gitResult("", 128));
      }
      expect(await Promise.all(pending)).toEqual(Array.from({ length: 8 }, () => null));
      expect(runGit).toHaveBeenCalledOnce();

      vi.mocked(runGit).mockResolvedValue(gitResult("recovered-tree\n"));
      await expect(resolveSessionDiffEmptyTree("failed")).resolves.toEqual({
        base: "recovered-tree",
      });
      expect(runGit).toHaveBeenCalledTimes(2);
    },
  );
});
