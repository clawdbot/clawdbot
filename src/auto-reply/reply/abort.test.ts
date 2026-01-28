import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { MoltbotConfig } from "../../config/config.js";
import { isAbortTrigger, tryFastAbortFromMessage } from "./abort.js";
import { enqueueFollowupRun, getFollowupQueueDepth, type FollowupRun } from "./queue.js";
import { initSessionState } from "./session.js";
import { buildTestCtx } from "./test-ctx.js";

vi.mock("../../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(true),
  resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
}));

const commandQueueMocks = vi.hoisted(() => ({
  clearCommandLane: vi.fn(),
}));

vi.mock("../../process/command-queue.js", () => commandQueueMocks);

const subagentRegistryMocks = vi.hoisted(() => ({
  listSubagentRunsForRequester: vi.fn(() => []),
}));

vi.mock("../../agents/subagent-registry.js", () => ({
  listSubagentRunsForRequester: subagentRegistryMocks.listSubagentRunsForRequester,
}));

describe("abort detection", () => {
  it("triggerBodyNormalized extracts /stop from RawBody for abort detection", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-abort-"));
    const storePath = path.join(root, "sessions.json");
    const cfg = { session: { store: storePath } } as MoltbotConfig;

    const groupMessageCtx = {
      Body: `[Context]\nJake: /stop\n[from: Jake]`,
      RawBody: "/stop",
      ChatType: "group",
      SessionKey: "agent:main:whatsapp:group:g1",
    };

    const result = await initSessionState({
      ctx: groupMessageCtx,
      cfg,
      commandAuthorized: true,
    });

    // /stop is detected via exact match in handleAbort, not isAbortTrigger
    expect(result.triggerBodyNormalized).toBe("/stop");
  });

  it("isAbortTrigger matches bare word triggers (without slash)", () => {
    expect(isAbortTrigger("stop")).toBe(true);
    expect(isAbortTrigger("esc")).toBe(true);
    expect(isAbortTrigger("abort")).toBe(true);
    expect(isAbortTrigger("wait")).toBe(true);
    expect(isAbortTrigger("exit")).toBe(true);
    expect(isAbortTrigger("interrupt")).toBe(true);
    expect(isAbortTrigger("hello")).toBe(false);
    // /stop is NOT matched by isAbortTrigger - it's handled separately
    expect(isAbortTrigger("/stop")).toBe(false);
  });

  it("fast-aborts even when text commands are disabled", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-abort-"));
    const storePath = path.join(root, "sessions.json");
    const cfg = { session: { store: storePath }, commands: { text: false } } as MoltbotConfig;

    const result = await tryFastAbortFromMessage({
      ctx: buildTestCtx({
        CommandBody: "/stop",
        RawBody: "/stop",
        CommandAuthorized: true,
        SessionKey: "telegram:123",
        Provider: "telegram",
        Surface: "telegram",
        From: "telegram:123",
        To: "telegram:123",
      }),
      cfg,
    });

    expect(result.handled).toBe(true);
  });

  it("fast-abort clears queued followups and session lane", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-abort-"));
    const storePath = path.join(root, "sessions.json");
    const cfg = { session: { store: storePath } } as MoltbotConfig;
    const sessionKey = "telegram:123";
    const sessionId = "session-123";
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          [sessionKey]: {
            sessionId,
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
    );
    const followupRun: FollowupRun = {
      prompt: "queued",
      enqueuedAt: Date.now(),
      run: {
        agentId: "main",
        agentDir: path.join(root, "agent"),
        sessionId,
        sessionKey,
        messageProvider: "telegram",
        agentAccountId: "acct",
        sessionFile: path.join(root, "session.jsonl"),
        workspaceDir: path.join(root, "workspace"),
        config: cfg,
        provider: "anthropic",
        model: "claude-opus-4-5",
        timeoutMs: 1000,
        blockReplyBreak: "text_end",
      },
    };
    enqueueFollowupRun(
      sessionKey,
      followupRun,
      { mode: "collect", debounceMs: 0, cap: 20, dropPolicy: "summarize" },
      "none",
    );
    expect(getFollowupQueueDepth(sessionKey)).toBe(1);

    const result = await tryFastAbortFromMessage({
      ctx: buildTestCtx({
        CommandBody: "/stop",
        RawBody: "/stop",
        CommandAuthorized: true,
        SessionKey: sessionKey,
        Provider: "telegram",
        Surface: "telegram",
        From: "telegram:123",
        To: "telegram:123",
      }),
      cfg,
    });

    expect(result.handled).toBe(true);
    expect(getFollowupQueueDepth(sessionKey)).toBe(0);
    expect(commandQueueMocks.clearCommandLane).toHaveBeenCalledWith(`session:${sessionKey}`);
  });

  it("fast-abort stops active subagent runs for requester session", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-abort-"));
    const storePath = path.join(root, "sessions.json");
    const cfg = { session: { store: storePath } } as MoltbotConfig;
    const sessionKey = "telegram:parent";
    const childKey = "agent:main:subagent:child-1";
    const sessionId = "session-parent";
    const childSessionId = "session-child";
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          [sessionKey]: {
            sessionId,
            updatedAt: Date.now(),
          },
          [childKey]: {
            sessionId: childSessionId,
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
    );

    subagentRegistryMocks.listSubagentRunsForRequester.mockReturnValueOnce([
      {
        runId: "run-1",
        childSessionKey: childKey,
        requesterSessionKey: sessionKey,
        requesterDisplayKey: "telegram:parent",
        task: "do work",
        cleanup: "keep",
        createdAt: Date.now(),
      },
    ]);

    const result = await tryFastAbortFromMessage({
      ctx: buildTestCtx({
        CommandBody: "/stop",
        RawBody: "/stop",
        CommandAuthorized: true,
        SessionKey: sessionKey,
        Provider: "telegram",
        Surface: "telegram",
        From: "telegram:parent",
        To: "telegram:parent",
      }),
      cfg,
    });

    expect(result.stoppedSubagents).toBe(1);
    expect(commandQueueMocks.clearCommandLane).toHaveBeenCalledWith(`session:${childKey}`);
  });
});
