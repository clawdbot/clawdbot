import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentRunRecord } from "../../agents/subagent-registry.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  __testing as abortTesting,
  getAbortMemory,
  getAbortMemorySizeForTest,
  isAbortRequestText,
  isAbortTrigger,
  resetAbortMemoryForTest,
  resolveAbortCutoffFromContext,
  resolveSessionEntryForKey,
  setAbortMemory,
  stopSubagentsForRequester,
  shouldSkipMessageByAbortCutoff,
  tryFastAbortFromMessage,
} from "./abort.js";
import { enqueueFollowupRun, getFollowupQueueDepth, type FollowupRun } from "./queue.js";
import { __testing as queueCleanupTesting } from "./queue/cleanup.js";
import { buildTestCtx } from "./test-ctx.js";

vi.mock("../../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(true),
  resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
}));

const commandQueueMocks = vi.hoisted(() => ({
  clearCommandLane: vi.fn(() => 1),
}));

vi.mock("../../process/command-queue.js", () => commandQueueMocks);

const subagentRegistryMocks = vi.hoisted(() => ({
  listSubagentRunsForRequester: vi.fn<(requesterSessionKey: string) => SubagentRunRecord[]>(
    () => [],
  ),
  getLatestSubagentRunByChildSessionKey: vi.fn<
    (childSessionKey: string) => SubagentRunRecord | null
  >(() => null),
  markSubagentRunTerminated: vi.fn(() => 1),
}));

vi.mock("../../agents/subagent-registry.js", () => ({
  getLatestSubagentRunByChildSessionKey:
    subagentRegistryMocks.getLatestSubagentRunByChildSessionKey,
  listSubagentRunsForRequester: subagentRegistryMocks.listSubagentRunsForRequester,
  listSubagentRunsForController: subagentRegistryMocks.listSubagentRunsForRequester,
  markSubagentRunTerminated: subagentRegistryMocks.markSubagentRunTerminated,
}));

const acpManagerMocks = vi.hoisted(() => ({
  resolveSession: vi.fn<
    () =>
      | { kind: "none" }
      | {
          kind: "ready";
          sessionKey: string;
          meta: unknown;
        }
  >(() => ({ kind: "none" })),
  cancelSession: vi.fn(async () => {}),
}));

vi.mock("../../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    resolveSession: acpManagerMocks.resolveSession,
    cancelSession: acpManagerMocks.cancelSession,
  }),
}));

describe("abort detection", () => {
  async function writeSessionStore(
    storePath: string,
    sessionIdsByKey: Record<string, string>,
    nowMs = Date.now(),
  ) {
    const storeEntries = Object.fromEntries(
      Object.entries(sessionIdsByKey).map(([key, sessionId]) => [
        key,
        { sessionId, updatedAt: nowMs },
      ]),
    );
    await fs.writeFile(storePath, JSON.stringify(storeEntries, null, 2));
  }

  async function createAbortConfig(params?: {
    commandsTextEnabled?: boolean;
    sessionIdsByKey?: Record<string, string>;
    nowMs?: number;
  }) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-abort-"));
    const storePath = path.join(root, "sessions.json");
    const cfg = {
      session: { store: storePath },
      ...(typeof params?.commandsTextEnabled === "boolean"
        ? { commands: { text: params.commandsTextEnabled } }
        : {}),
    } as OpenClawConfig;
    if (params?.sessionIdsByKey) {
      await writeSessionStore(storePath, params.sessionIdsByKey, params.nowMs);
    }
    return { root, storePath, cfg };
  }

  async function runStopCommand(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    from: string;
    to: string;
    targetSessionKey?: string;
    messageSid?: string;
    timestamp?: number;
  }) {
    return tryFastAbortFromMessage({
      ctx: buildTestCtx({
        CommandBody: "/stop",
        RawBody: "/stop",
        CommandAuthorized: true,
        SessionKey: params.sessionKey,
        Provider: "telegram",
        Surface: "telegram",
        From: params.from,
        To: params.to,
        ...(params.targetSessionKey ? { CommandTargetSessionKey: params.targetSessionKey } : {}),
        ...(params.messageSid ? { MessageSid: params.messageSid } : {}),
        ...(typeof params.timestamp === "number" ? { Timestamp: params.timestamp } : {}),
      }),
      cfg: params.cfg,
    });
  }

  function enqueueQueuedFollowupRun(params: {
    root: string;
    cfg: OpenClawConfig;
    sessionId: string;
    sessionKey: string;
  }) {
    const followupRun: FollowupRun = {
      prompt: "queued",
      enqueuedAt: Date.now(),
      run: {
        agentId: "main",
        agentDir: path.join(params.root, "agent"),
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        messageProvider: "telegram",
        agentAccountId: "acct",
        sessionFile: path.join(params.root, "session.jsonl"),
        workspaceDir: path.join(params.root, "workspace"),
        config: params.cfg,
        provider: "anthropic",
        model: "claude-opus-4-6",
        timeoutMs: 1000,
        blockReplyBreak: "text_end",
      },
    };
    enqueueFollowupRun(
      params.sessionKey,
      followupRun,
      { mode: "collect", debounceMs: 0, cap: 20, dropPolicy: "summarize" },
      "none",
    );
  }

  function expectSessionLaneCleared(sessionKey: string) {
    expect(commandQueueMocks.clearCommandLane).toHaveBeenCalledWith(`session:${sessionKey}`);
  }

  beforeEach(() => {
    abortTesting.setDepsForTests({
      getAcpSessionManager: (() =>
        ({
          resolveSession: acpManagerMocks.resolveSession,
          cancelSession: acpManagerMocks.cancelSession,
        }) as never) as never,
      abortEmbeddedPiRun: () => true,
      getLatestSubagentRunByChildSessionKey:
        subagentRegistryMocks.getLatestSubagentRunByChildSessionKey,
      listSubagentRunsForController: subagentRegistryMocks.listSubagentRunsForRequester,
      markSubagentRunTerminated: subagentRegistryMocks.markSubagentRunTerminated,
    });
    queueCleanupTesting.setDepsForTests({
      resolveEmbeddedSessionLane: (key) => `session:${key.trim() || "main"}`,
      clearCommandLane: commandQueueMocks.clearCommandLane,
    });
    commandQueueMocks.clearCommandLane.mockClear().mockReturnValue(1);
  });

  afterEach(() => {
    resetAbortMemoryForTest();
    abortTesting.resetDepsForTests();
    queueCleanupTesting.resetDepsForTests();
    commandQueueMocks.clearCommandLane.mockClear().mockReturnValue(1);
    acpManagerMocks.resolveSession.mockReset().mockReturnValue({ kind: "none" });
    acpManagerMocks.cancelSession.mockReset().mockResolvedValue(undefined);
    subagentRegistryMocks.getLatestSubagentRunByChildSessionKey.mockReset().mockReturnValue(null);
  });

  it("isAbortTrigger matches standalone abort trigger phrases", () => {
    const positives = [
      "stop",
      "esc",
      "abort",
      "wait",
      "exit",
      "interrupt",
      "stop openclaw",
      "openclaw stop",
      "stop action",
      "stop current action",
      "stop run",
      "stop current run",
      "stop agent",
      "stop the agent",
      "stop don't do anything",
      "stop dont do anything",
      "stop do not do anything",
      "stop doing anything",
      "do not do that",
      "please stop",
      "stop please",
      "STOP OPENCLAW",
      "stop openclaw!!!",
      "stop don’t do anything",
      "detente",
      "detén",
      "arrête",
      "停止",
      "やめて",
      "止めて",
      "रुको",
      "توقف",
      "стоп",
      "остановись",
      "останови",
      "остановить",
      "прекрати",
      "halt",
      "anhalten",
      "aufhören",
      "hoer auf",
      "stopp",
      "pare",
    ];
    for (const candidate of positives) {
      expect(isAbortTrigger(candidate)).toBe(true);
    }

    expect(isAbortTrigger("hello")).toBe(false);
    expect(isAbortTrigger("please do not do that")).toBe(false);
    // /stop is NOT matched by isAbortTrigger - it's handled separately.
    expect(isAbortTrigger("/stop")).toBe(false);
  });

  it("isAbortRequestText aligns abort command semantics", () => {
    expect(isAbortRequestText("/stop")).toBe(true);
    expect(isAbortRequestText("/STOP")).toBe(true);
    expect(isAbortRequestText("/stop!!!")).toBe(true);
    expect(isAbortRequestText("/Stop!!!")).toBe(true);
    expect(isAbortRequestText("stop")).toBe(true);
    expect(isAbortRequestText("Stop")).toBe(true);
    expect(isAbortRequestText("STOP")).toBe(true);
    expect(isAbortRequestText("stop action")).toBe(true);
    expect(isAbortRequestText("stop openclaw!!!")).toBe(true);
    expect(isAbortRequestText("やめて")).toBe(true);
    expect(isAbortRequestText("остановись")).toBe(true);
    expect(isAbortRequestText("halt")).toBe(true);
    expect(isAbortRequestText("stopp")).toBe(true);
    expect(isAbortRequestText("pare")).toBe(true);
    expect(isAbortRequestText(" توقف ")).toBe(true);
    expect(isAbortRequestText("/stop@openclaw_bot", { botUsername: "openclaw_bot" })).toBe(true);
    expect(isAbortRequestText("/Stop@openclaw_bot", { botUsername: "openclaw_bot" })).toBe(true);

    expect(isAbortRequestText("/status")).toBe(false);
    expect(isAbortRequestText("do not do that")).toBe(true);
    expect(isAbortRequestText("please do not do that")).toBe(false);
    expect(isAbortRequestText("/abort")).toBe(false);
  });

  it("removes abort memory entry when flag is reset", () => {
    setAbortMemory("session-1", true);
    expect(getAbortMemory("session-1")).toBe(true);

    setAbortMemory("session-1", false);
    expect(getAbortMemory("session-1")).toBeUndefined();
    expect(getAbortMemorySizeForTest()).toBe(0);
  });

  it("caps abort memory tracking to a bounded max size", () => {
    for (let i = 0; i < 2105; i += 1) {
      setAbortMemory(`session-${i}`, true);
    }
    expect(getAbortMemorySizeForTest()).toBe(2000);
    expect(getAbortMemory("session-0")).toBeUndefined();
    expect(getAbortMemory("session-2104")).toBe(true);
  });

  it("extracts abort cutoff metadata from context", () => {
    expect(
      resolveAbortCutoffFromContext(
        buildTestCtx({
          MessageSid: "42",
          Timestamp: 123,
        }),
      ),
    ).toEqual({
      messageSid: "42",
      timestamp: 123,
    });
  });

  it("treats numeric message IDs at or before cutoff as stale", () => {
    expect(
      shouldSkipMessageByAbortCutoff({
        cutoffMessageSid: "200",
        messageSid: "199",
      }),
    ).toBe(true);
    expect(
      shouldSkipMessageByAbortCutoff({
        cutoffMessageSid: "200",
        messageSid: "200",
      }),
    ).toBe(true);
    expect(
      shouldSkipMessageByAbortCutoff({
        cutoffMessageSid: "200",
        messageSid: "201",
      }),
    ).toBe(false);
  });

  it("falls back to timestamp cutoff when message IDs are unavailable", () => {
    expect(
      shouldSkipMessageByAbortCutoff({
        cutoffTimestamp: 2000,
        timestamp: 1999,
      }),
    ).toBe(true);
    expect(
      shouldSkipMessageByAbortCutoff({
        cutoffTimestamp: 2000,
        timestamp: 2000,
      }),
    ).toBe(true);
    expect(
      shouldSkipMessageByAbortCutoff({
        cutoffTimestamp: 2000,
        timestamp: 2001,
      }),
    ).toBe(false);
  });

  it("resolves session entry when key exists in store", () => {
    const store = {
      "session-1": { sessionId: "abc", updatedAt: 0 },
    } as const;
    expect(resolveSessionEntryForKey(store, "session-1")).toEqual({
      entry: store["session-1"],
      key: "session-1",
    });
    expect(resolveSessionEntryForKey(store, "session-2")).toStrictEqual({});
    expect(resolveSessionEntryForKey(undefined, "session-1")).toStrictEqual({});
  });

  it("resolves Telegram forum topic session when lookup key has different casing than store", () => {
    // Store normalizes keys to lowercase; caller may pass mixed-case. /stop in topic must find entry.
    const storeKey = "agent:main:telegram:group:-1001234567890:topic:99";
    const lookupKey = "Agent:Main:Telegram:Group:-1001234567890:Topic:99";
    const store = {
      [storeKey]: { sessionId: "pi-topic-99", updatedAt: 0 },
    } as Record<string, { sessionId: string; updatedAt: number }>;
    // Direct lookup fails (store uses lowercase keys); normalization fallback must succeed.
    expect(store[lookupKey]).toBeUndefined();
    const result = resolveSessionEntryForKey(store, lookupKey);
    expect(result.entry?.sessionId).toBe("pi-topic-99");
    expect(result.key).toBe(storeKey);
  });

  it("fast-aborts even when text commands are disabled", async () => {
    const { cfg } = await createAbortConfig({ commandsTextEnabled: false });

    const result = await runStopCommand({
      cfg,
      sessionKey: "telegram:123",
      from: "telegram:123",
      to: "telegram:123",
    });

    expect(result.handled).toBe(true);
  });

  it("fast-abort clears queued followups and session lane", async () => {
    const sessionKey = "telegram:123";
    const sessionId = "session-123";
    const { root, cfg } = await createAbortConfig({
      sessionIdsByKey: { [sessionKey]: sessionId },
    });
    enqueueQueuedFollowupRun({ root, cfg, sessionId, sessionKey });
    expect(getFollowupQueueDepth(sessionKey)).toBe(1);

    const result = await runStopCommand({
      cfg,
      sessionKey,
      from: "telegram:123",
      to: "telegram:123",
    });

    expect(result.handled).toBe(true);
    expect(getFollowupQueueDepth(sessionKey)).toBe(0);
    expectSessionLaneCleared(sessionKey);
  });

  it("plain-language stop on ACP-bound session triggers ACP cancel", async () => {
    const sessionKey = "agent:codex:acp:test-1";
    const sessionId = "session-123";
    const { cfg } = await createAbortConfig({
      sessionIdsByKey: { [sessionKey]: sessionId },
    });
    acpManagerMocks.resolveSession.mockReturnValue({
      kind: "ready",
      sessionKey,
      meta: {} as never,
    });

    const result = await runStopCommand({
      cfg,
      sessionKey,
      from: "telegram:123",
      to: "telegram:123",
      targetSessionKey: sessionKey,
    });

    expect(result.handled).toBe(true);
    expect(acpManagerMocks.cancelSession).toHaveBeenCalledWith({
      cfg,
      sessionKey,
      reason: "fast-abort",
    });
  });

  it("ACP cancel failures do not skip queue and lane cleanup", async () => {
    const sessionKey = "agent:codex:acp:test-2";
    const sessionId = "session-456";
    const { root, cfg } = await createAbortConfig({
      sessionIdsByKey: { [sessionKey]: sessionId },
    });
    enqueueQueuedFollowupRun({ root, cfg, sessionId, sessionKey });
    acpManagerMocks.resolveSession.mockReturnValue({
      kind: "ready",
      sessionKey,
      meta: {} as never,
    });
    acpManagerMocks.cancelSession.mockRejectedValueOnce(new Error("cancel failed"));

    const result = await runStopCommand({
      cfg,
      sessionKey,
      from: "telegram:123",
      to: "telegram:123",
      targetSessionKey: sessionKey,
    });

    expect(result.handled).toBe(true);
    expect(getFollowupQueueDepth(sessionKey)).toBe(0);
    expectSessionLaneCleared(sessionKey);
  });

  it("persists abort cutoff metadata on /stop when command and target session match", async () => {
    const sessionKey = "telegram:123";
    const sessionId = "session-123";
    const { storePath, cfg } = await createAbortConfig({
      sessionIdsByKey: { [sessionKey]: sessionId },
    });

    const result = await runStopCommand({
      cfg,
      sessionKey,
      from: "telegram:123",
      to: "telegram:123",
      messageSid: "55",
      timestamp: 1234567890000,
    });

    expect(result.handled).toBe(true);
    const store = JSON.parse(await fs.readFile(storePath, "utf8")) as Record<string, unknown>;
    const entry = store[sessionKey] as {
      abortedLastRun?: boolean;
      abortCutoffMessageSid?: string;
      abortCutoffTimestamp?: number;
    };
    expect(entry.abortedLastRun).toBe(true);
    expect(entry.abortCutoffMessageSid).toBe("55");
    expect(entry.abortCutoffTimestamp).toBe(1234567890000);
  });

  it("does not persist cutoff metadata when native /stop targets a different session", async () => {
    const slashSessionKey = "telegram:slash:123";
    const targetSessionKey = "agent:main:telegram:group:123";
    const targetSessionId = "session-target";
    const { storePath, cfg } = await createAbortConfig({
      sessionIdsByKey: { [targetSessionKey]: targetSessionId },
    });

    const result = await runStopCommand({
      cfg,
      sessionKey: slashSessionKey,
      from: "telegram:123",
      to: "telegram:123",
      targetSessionKey,
      messageSid: "999",
      timestamp: 1234567890000,
    });

    expect(result.handled).toBe(true);
    const store = JSON.parse(await fs.readFile(storePath, "utf8")) as Record<string, unknown>;
    const entry = store[targetSessionKey] as {
      abortedLastRun?: boolean;
      abortCutoffMessageSid?: string;
      abortCutoffTimestamp?: number;
    };
    expect(entry.abortedLastRun).toBe(true);
    expect(entry.abortCutoffMessageSid).toBeUndefined();
    expect(entry.abortCutoffTimestamp).toBeUndefined();
  });

  it("fast-abort stops active subagent runs for requester session", async () => {
    const sessionKey = "telegram:parent";
    const childKey = "agent:main:subagent:child-1";
    const sessionId = "session-parent";
    const childSessionId = "session-child";
    const { cfg } = await createAbortConfig({
      sessionIdsByKey: {
        [sessionKey]: sessionId,
        [childKey]: childSessionId,
      },
    });

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

    const result = await runStopCommand({
      cfg,
      sessionKey,
      from: "telegram:parent",
      to: "telegram:parent",
    });

    expect(result.stoppedSubagents).toBe(1);
    expectSessionLaneCleared(childKey);
  });

  it("cascade stop kills depth-2 children when stopping depth-1 agent", async () => {
    const sessionKey = "telegram:parent";
    const depth1Key = "agent:main:subagent:child-1";
    const depth2Key = "agent:main:subagent:child-1:subagent:grandchild-1";
    const sessionId = "session-parent";
    const depth1SessionId = "session-child";
    const depth2SessionId = "session-grandchild";
    const { cfg } = await createAbortConfig({
      sessionIdsByKey: {
        [sessionKey]: sessionId,
        [depth1Key]: depth1SessionId,
        [depth2Key]: depth2SessionId,
      },
    });

    // First call: main session lists depth-1 children
    // Second call (cascade): depth-1 session lists depth-2 children
    // Third call (cascade from depth-2): no further children
    subagentRegistryMocks.listSubagentRunsForRequester
      .mockReturnValueOnce([
        {
          runId: "run-1",
          childSessionKey: depth1Key,
          requesterSessionKey: sessionKey,
          requesterDisplayKey: "telegram:parent",
          task: "orchestrator",
          cleanup: "keep",
          createdAt: Date.now(),
        },
      ])
      .mockReturnValueOnce([
        {
          runId: "run-2",
          childSessionKey: depth2Key,
          requesterSessionKey: depth1Key,
          requesterDisplayKey: depth1Key,
          task: "leaf worker",
          cleanup: "keep",
          createdAt: Date.now(),
        },
      ])
      .mockReturnValueOnce([]);

    const result = await runStopCommand({
      cfg,
      sessionKey,
      from: "telegram:parent",
      to: "telegram:parent",
    });

    // Should stop both depth-1 and depth-2 agents (cascade)
    expect(result.stoppedSubagents).toBe(2);
    expectSessionLaneCleared(depth1Key);
    expectSessionLaneCleared(depth2Key);
  });

  it("cascade stop traverses ended depth-1 parents to stop active depth-2 children", async () => {
    subagentRegistryMocks.listSubagentRunsForRequester.mockClear();
    subagentRegistryMocks.markSubagentRunTerminated.mockClear();
    const sessionKey = "telegram:parent";
    const depth1Key = "agent:main:subagent:child-ended";
    const depth2Key = "agent:main:subagent:child-ended:subagent:grandchild-active";
    const now = Date.now();
    const { cfg } = await createAbortConfig({
      nowMs: now,
      sessionIdsByKey: {
        [sessionKey]: "session-parent",
        [depth1Key]: "session-child-ended",
        [depth2Key]: "session-grandchild-active",
      },
    });

    // main -> ended depth-1 parent
    // depth-1 parent -> active depth-2 child
    // depth-2 child -> none
    subagentRegistryMocks.listSubagentRunsForRequester
      .mockReturnValueOnce([
        {
          runId: "run-1",
          childSessionKey: depth1Key,
          requesterSessionKey: sessionKey,
          requesterDisplayKey: "telegram:parent",
          task: "orchestrator",
          cleanup: "keep",
          createdAt: now - 1_000,
          endedAt: now - 500,
          outcome: { status: "ok" },
        },
      ])
      .mockReturnValueOnce([
        {
          runId: "run-2",
          childSessionKey: depth2Key,
          requesterSessionKey: depth1Key,
          requesterDisplayKey: depth1Key,
          task: "leaf worker",
          cleanup: "keep",
          createdAt: now - 500,
        },
      ])
      .mockReturnValueOnce([]);

    const result = await runStopCommand({
      cfg,
      sessionKey,
      from: "telegram:parent",
      to: "telegram:parent",
    });

    // Should skip killing the ended depth-1 run itself, but still kill depth-2.
    expect(result.stoppedSubagents).toBe(1);
    expectSessionLaneCleared(depth2Key);
    expect(subagentRegistryMocks.markSubagentRunTerminated).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-2", childSessionKey: depth2Key }),
    );
  });

  it("cascade stop still traverses an ended current parent when a stale older active row exists", async () => {
    subagentRegistryMocks.listSubagentRunsForRequester.mockClear();
    subagentRegistryMocks.markSubagentRunTerminated.mockClear();
    const sessionKey = "telegram:parent";
    const depth1Key = "agent:main:subagent:child-ended-stale";
    const depth2Key = "agent:main:subagent:child-ended-stale:subagent:grandchild-active";
    const now = Date.now();
    const { cfg } = await createAbortConfig({
      nowMs: now,
      sessionIdsByKey: {
        [sessionKey]: "session-parent",
        [depth1Key]: "session-child-ended-stale",
        [depth2Key]: "session-grandchild-active",
      },
    });

    subagentRegistryMocks.listSubagentRunsForRequester
      .mockReturnValueOnce([
        {
          runId: "run-stale-parent",
          childSessionKey: depth1Key,
          requesterSessionKey: sessionKey,
          requesterDisplayKey: "telegram:parent",
          task: "stale orchestrator",
          cleanup: "keep",
          createdAt: now - 2_000,
          startedAt: now - 1_900,
        },
        {
          runId: "run-current-parent",
          childSessionKey: depth1Key,
          requesterSessionKey: sessionKey,
          requesterDisplayKey: "telegram:parent",
          task: "current orchestrator",
          cleanup: "keep",
          createdAt: now - 1_000,
          startedAt: now - 900,
          endedAt: now - 500,
          outcome: { status: "ok" },
        },
      ])
      .mockReturnValueOnce([
        {
          runId: "run-active-child",
          childSessionKey: depth2Key,
          requesterSessionKey: depth1Key,
          requesterDisplayKey: depth1Key,
          task: "leaf worker",
          cleanup: "keep",
          createdAt: now - 400,
        },
      ])
      .mockReturnValueOnce([]);
    subagentRegistryMocks.getLatestSubagentRunByChildSessionKey.mockImplementation(
      (childSessionKey) => {
        if (childSessionKey === depth1Key) {
          return {
            runId: "run-current-parent",
            childSessionKey: depth1Key,
            requesterSessionKey: sessionKey,
            requesterDisplayKey: "telegram:parent",
            task: "current orchestrator",
            cleanup: "keep",
            createdAt: now - 1_000,
            startedAt: now - 900,
            endedAt: now - 500,
            outcome: { status: "ok" },
          } as SubagentRunRecord;
        }
        if (childSessionKey === depth2Key) {
          return {
            runId: "run-active-child",
            childSessionKey: depth2Key,
            requesterSessionKey: depth1Key,
            requesterDisplayKey: depth1Key,
            task: "leaf worker",
            cleanup: "keep",
            createdAt: now - 400,
          } as SubagentRunRecord;
        }
        return null;
      },
    );

    const result = await runStopCommand({
      cfg,
      sessionKey,
      from: "telegram:parent",
      to: "telegram:parent",
    });

    expect(result.stoppedSubagents).toBe(1);
    expectSessionLaneCleared(depth2Key);
    expect(subagentRegistryMocks.markSubagentRunTerminated).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-active-child", childSessionKey: depth2Key }),
    );
  });

  it("stopSubagentsForRequester does not traverse a child that moved to a newer parent", () => {
    subagentRegistryMocks.listSubagentRunsForRequester.mockClear();
    subagentRegistryMocks.markSubagentRunTerminated.mockClear();
    const oldParentKey = "agent:main:subagent:old-parent";
    const newParentKey = "agent:main:subagent:new-parent";
    const childKey = "agent:main:subagent:shared-child";
    const leafKey = `${childKey}:subagent:leaf`;
    const now = Date.now();

    subagentRegistryMocks.listSubagentRunsForRequester
      .mockReturnValueOnce([
        {
          runId: "run-shared-child-stale-parent",
          childSessionKey: childKey,
          requesterSessionKey: oldParentKey,
          controllerSessionKey: oldParentKey,
          requesterDisplayKey: oldParentKey,
          task: "shared child stale parent",
          cleanup: "keep",
          createdAt: now - 2_000,
          endedAt: now - 1_000,
          outcome: { status: "ok" },
        },
      ])
      .mockReturnValueOnce([
        {
          runId: "run-leaf-active",
          childSessionKey: leafKey,
          requesterSessionKey: childKey,
          controllerSessionKey: childKey,
          requesterDisplayKey: childKey,
          task: "leaf worker",
          cleanup: "keep",
          createdAt: now - 500,
        },
      ]);
    subagentRegistryMocks.getLatestSubagentRunByChildSessionKey.mockImplementation((sessionKey) => {
      if (sessionKey === childKey) {
        return {
          runId: "run-shared-child-current-parent",
          childSessionKey: childKey,
          requesterSessionKey: newParentKey,
          controllerSessionKey: newParentKey,
          requesterDisplayKey: newParentKey,
          task: "shared child current parent",
          cleanup: "keep",
          createdAt: now - 250,
        } as SubagentRunRecord;
      }
      if (sessionKey === leafKey) {
        return {
          runId: "run-leaf-active",
          childSessionKey: leafKey,
          requesterSessionKey: childKey,
          controllerSessionKey: childKey,
          requesterDisplayKey: childKey,
          task: "leaf worker",
          cleanup: "keep",
          createdAt: now - 500,
        } as SubagentRunRecord;
      }
      return null;
    });

    const result = stopSubagentsForRequester({
      cfg: {} as OpenClawConfig,
      requesterSessionKey: oldParentKey,
    });

    expect(result).toEqual({ stopped: 0 });
    expect(subagentRegistryMocks.markSubagentRunTerminated).not.toHaveBeenCalled();
  });
});
