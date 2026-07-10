import { describe, expect, it } from "vitest";
import { buildDraftSessionCreateParams } from "./new-session-dialog.ts";

describe("buildDraftSessionCreateParams", () => {
  it("keeps plain chats minimal", () => {
    expect(
      buildDraftSessionCreateParams({
        agentId: "Main",
        message: "hello",
        worktree: false,
        baseRef: "main",
        worktreeName: "ignored",
        cwd: "/workspace",
        workspace: "/workspace",
      }),
    ).toEqual({ agentId: "main", message: "hello" });
  });

  it("maps worktree selections onto additive create params", () => {
    expect(
      buildDraftSessionCreateParams({
        agentId: "main",
        message: "fix the bug",
        worktree: true,
        baseRef: "origin/main",
        worktreeName: "bug-fix",
        cwd: "/workspace",
        workspace: "/workspace",
      }),
    ).toEqual({
      agentId: "main",
      message: "fix the bug",
      worktree: true,
      worktreeBaseRef: "origin/main",
      worktreeName: "bug-fix",
    });
  });

  it("sends cwd only for non-workspace folders and execNode when picked", () => {
    expect(
      buildDraftSessionCreateParams({
        agentId: "main",
        message: "remote work",
        worktree: true,
        cwd: "/other/repo",
        workspace: "/workspace",
        execNode: "macbook",
      }),
    ).toEqual({
      agentId: "main",
      message: "remote work",
      worktree: true,
      cwd: "/other/repo",
      execNode: "macbook",
    });
  });
});
