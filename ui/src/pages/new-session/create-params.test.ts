// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildDraftSessionCreateParams } from "./create-params.ts";

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

  it("includes initial-message attachments", () => {
    const attachments = [
      { type: "image", mimeType: "image/png", fileName: "pixel.png", content: "aGVsbG8=" },
    ];
    expect(
      buildDraftSessionCreateParams({
        agentId: "main",
        message: "",
        attachments,
        worktree: false,
      }),
    ).toEqual({ agentId: "main", message: "", attachments });
  });

  it("includes selected model and thinking overrides for a plain session", () => {
    expect(
      buildDraftSessionCreateParams({
        agentId: "main",
        message: "use the selected model",
        model: "anthropic/claude-sonnet-4-6",
        thinkingLevel: "high",
        worktree: false,
      }),
    ).toEqual({
      agentId: "main",
      message: "use the selected model",
      model: "anthropic/claude-sonnet-4-6",
      thinkingLevel: "high",
    });
  });

  it("does not combine a catalog target with a draft model override", () => {
    expect(
      buildDraftSessionCreateParams({
        agentId: "main",
        message: "start coding",
        model: "openai/gpt-5.5",
        thinkingLevel: "medium",
        worktree: false,
        catalogId: "claude",
      }),
    ).toEqual({
      agentId: "main",
      message: "start coding",
      catalogId: "claude",
    });
  });

  it("submits the catalog target for server-side resolution", () => {
    expect(
      buildDraftSessionCreateParams({
        agentId: "main",
        message: "start coding",
        worktree: false,
        catalogId: "claude",
      }),
    ).toEqual({
      agentId: "main",
      message: "start coding",
      catalogId: "claude",
    });
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

  it("sends a custom Gateway folder without requiring a worktree", () => {
    expect(
      buildDraftSessionCreateParams({
        agentId: "main",
        message: "bootstrap here",
        worktree: false,
        cwd: "/home",
        workspace: "/workspace",
      }),
    ).toEqual({
      agentId: "main",
      message: "bootstrap here",
      cwd: "/home",
    });
  });

  it("sends a custom Gateway checkout with an explicit worktree", () => {
    expect(
      buildDraftSessionCreateParams({
        agentId: "main",
        message: "isolated work",
        worktree: true,
        cwd: "/other/repo",
        workspace: "/workspace",
        baseRef: "main",
      }),
    ).toEqual({
      agentId: "main",
      message: "isolated work",
      cwd: "/other/repo",
      worktree: true,
      worktreeBaseRef: "main",
    });
  });

  it("sends the selected folder and execNode for node sessions", () => {
    expect(
      buildDraftSessionCreateParams({
        agentId: "main",
        message: "remote work",
        worktree: false,
        cwd: "/other/repo",
        workspace: "/workspace",
        execNode: "macbook",
      }),
    ).toEqual({
      agentId: "main",
      message: "remote work",
      cwd: "/other/repo",
      execNode: "macbook",
    });
  });

  it("sends the selected node cwd even when it matches the Gateway workspace path", () => {
    expect(
      buildDraftSessionCreateParams({
        agentId: "main",
        message: "remote work",
        worktree: false,
        cwd: "/workspace",
        workspace: "/workspace",
        execNode: "macbook",
      }),
    ).toEqual({
      agentId: "main",
      message: "remote work",
      cwd: "/workspace",
      execNode: "macbook",
    });
  });
});
