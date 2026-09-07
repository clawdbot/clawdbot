// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildDraftSessionCreateParams, canStartSessionAsDraft } from "./create-params.ts";

describe("create-as-draft availability", () => {
  it("requires both draft policy and multiple creator identities", () => {
    expect(
      canStartSessionAsDraft({
        allowedVisibilities: ["shared", "draft"],
        hasMultipleIdentities: true,
      }),
    ).toBe(true);
    expect(
      canStartSessionAsDraft({
        allowedVisibilities: ["shared"],
        hasMultipleIdentities: true,
      }),
    ).toBe(false);
    expect(canStartSessionAsDraft({ hasMultipleIdentities: true })).toBe(false);
  });

  it("stays dormant when the gateway has fewer than two identities", () => {
    for (const hasMultipleIdentities of [undefined, false]) {
      expect(
        canStartSessionAsDraft({
          allowedVisibilities: ["shared", "draft"],
          hasMultipleIdentities,
        }),
      ).toBe(false);
    }
  });
});

describe("buildDraftSessionCreateParams", () => {
  it("retains a cloud repository through the empty create without sending local checkout options", () => {
    expect(
      buildDraftSessionCreateParams({
        agentId: "main",
        message: "",
        repository: { url: "https://github.com/openclaw/openclaw.git", ref: "release" },
        projectId: "old-clone",
        worktree: true,
        baseRef: "ignored-local-ref",
        worktreeName: "ignored-local-name",
        cwd: "/local/clone",
        workspace: "/workspace",
      }),
    ).toEqual({
      agentId: "main",
      message: "",
      repository: { url: "https://github.com/openclaw/openclaw.git", ref: "release" },
    });
  });
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

  it("adds incognito only when that visibility is selected", () => {
    expect(
      buildDraftSessionCreateParams({
        agentId: "main",
        message: "private task",
        visibility: "incognito",
        worktree: false,
      }),
    ).toEqual({ agentId: "main", message: "private task", incognito: true });
  });

  it("adds draft visibility only when selected", () => {
    expect(
      buildDraftSessionCreateParams({
        agentId: "main",
        message: "private work in progress",
        worktree: false,
        visibility: "draft",
      }),
    ).toEqual({
      agentId: "main",
      message: "private work in progress",
      visibility: "draft",
    });
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

  it("includes selected model, context-window, thinking, and fast overrides for a plain session", () => {
    expect(
      buildDraftSessionCreateParams({
        agentId: "main",
        message: "use the selected model",
        model: "anthropic/claude-sonnet-4-6",
        contextWindow: "200k",
        thinkingLevel: "high",
        fastMode: true,
        worktree: false,
      }),
    ).toEqual({
      agentId: "main",
      message: "use the selected model",
      model: "anthropic/claude-sonnet-4-6",
      contextWindow: "200k",
      thinkingLevel: "high",
      fastMode: true,
    });
  });

  it("includes selected capability overrides in the atomic create request", () => {
    const toolOverrides = {
      mcpServers: { github: false },
      skills: { release: false },
      webSearch: false,
    };
    expect(
      buildDraftSessionCreateParams({
        agentId: "main",
        message: "use these capabilities",
        toolOverrides,
        worktree: false,
      }),
    ).toEqual({
      agentId: "main",
      message: "use these capabilities",
      toolOverrides,
    });
  });

  it("does not combine a catalog target with a draft model override", () => {
    expect(
      buildDraftSessionCreateParams({
        agentId: "main",
        message: "start coding",
        model: "openai/gpt-5.5",
        contextWindow: "200k",
        thinkingLevel: "medium",
        fastMode: true,
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

  it("assigns a session created from a custom group", () => {
    expect(
      buildDraftSessionCreateParams({
        agentId: "main",
        message: "start grouped work",
        worktree: true,
        cwd: "/repos/client",
        workspace: "/workspace",
        category: " Client work ",
      }),
    ).toEqual({
      agentId: "main",
      message: "start grouped work",
      category: "Client work",
      cwd: "/repos/client",
      worktree: true,
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

  it("submits a selected project by id without leaking its host path", () => {
    expect(
      buildDraftSessionCreateParams({
        agentId: "main",
        message: "work in the recorded repo",
        projectId: "openclaw",
        worktree: true,
        cwd: "/recorded/openclaw",
        workspace: "/workspace",
      }),
    ).toEqual({
      agentId: "main",
      message: "work in the recorded repo",
      projectId: "openclaw",
      worktree: true,
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
});
