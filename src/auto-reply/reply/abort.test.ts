// Tests abort request handling, cutoff persistence, and active run cleanup.
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentRunRecord } from "../../agents/subagent-registry.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
  type SessionAbortTargetResult,
} from "../../config/sessions/session-accessor.js";
import { createSuiteTempRootTracker } from "../../test-helpers/temp-dir.js";
import { resolveAbortCutoffFromContext, shouldSkipMessageByAbortCutoff } from "./abort-cutoff.js";
import { getAbortMemory } from "./abort-primitives.js";
import {
  testing as abortTesting,
  formatAbortReplyText,
  isAbortRequestText,
  isAbortTrigger,
  setAbortMemory,
  stopSubagentsForRequester,
  tryFastAbortFromMessage,
} from "./abort.js";
import { testing as acpResetTargetTesting } from "./acp-reset-target.js";
import { enqueueFollowupRun, getFollowupQueueDepth, type FollowupRun } from "./queue.js";
import { testing as queueCleanupTesting } from "./queue/cleanup.js";
import {
  createReplyOperation,
  replyRunRegistry,
  testing as replyRunRegistryTesting,
} from "./reply-run-registry.js";
import { buildTestCtx } from "./test-ctx.js";

vi.mock("../../agents/embedded-agent.js", () => ({
  abortEmbeddedAgentRun: vi.fn().mockReturnValue(true),
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

const runtimeAbortMocks = vi.hoisted(() => ({
  abortEmbeddedAgentRun: vi.fn(() => true),
  resolveActiveEmbeddedRunSessionId: vi.fn(() => undefined as string | undefined),
}));

vi.mock("../../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    resolveSession: acpManagerMocks.resolveSession,
    cancelSession: acpManagerMocks.cancelSession,
  }),
}));

const suiteTempDirs = createSuiteTempRootTracker({ prefix: "openclaw-abort-" });

describe("abort detection", () => {
  const trackedAbortMemoryKeys = new Set<string>();

  function setTrackedAbortMemory(key: string, value: boolean): void {
    trackedAbortMemoryKeys.add(key);
    setAbortMemory(key, value);
  }

  beforeAll(async () => {
    await suiteTempDirs.setup();
  });

  afterAll(async () => {
    await suiteTempDirs.cleanup();
  });

  async function writeSessionStore(
    storePath: string,
    sessionIdsByKey: Record<string, string>,
    nowMs = Date.now(),
  ) {
    await Promise.all(
      Object.entries(sessionIdsByKey).map(([sessionKey, sessionId]) =>
        replaceSessionEntry({ storePath, sessionKey }, { sessionId, updatedAt: nowMs }),
      ),
    );
  }

  function readAbortSessionEntry(storePath: string, sessionKey: string) {
    return loadSessionEntry({ storePath, sessionKey });
  }

  async function createAbortConfig(params?: {
    commandsTextEnabled?: boolean;
    sessionIdsByKey?: Record<string, string>;
    nowMs?: number;
  }) {
    const root = await suiteTempDirs.make("case");
    const storePath = path.join(root, "sessions.json");
    const cfg = {
      session: { store: storePath },
      ...(typeof params?.commandsTextEnabled === "boolean"
        ? { commands: { text: params.commandsTextEnabled } }
        : {}),
    } as OpenClawConfig;
    if (params?.sessionIdsByKey) {
      for (const sessionKey of Object.keys(params.sessionIdsByKey)) {
        trackedAbortMemoryKeys.add(sessionKey);
      }
      await writeSessionStore(storePath, params.sessionIdsByKey, params.nowMs);
    }
    return { root, storePath, cfg };
  }

  async function runStopCommand(params: {
    cfg: OpenClawConfig;
    sessionKey?: string;
    parentSessionKey?: string;
    from: string;
    to: string;
    senderId?: string;
    commandSource?: "native" | "text";
    targetSessionKey?: string;
    messageSid?: string;
    timestamp?: number;
  }) {
    for (const key of [
      params.sessionKey,
      params.parentSessionKey,
      params.targetSessionKey,
      params.from,
      params.to,
    ]) {
      if (key) {
        trackedAbortMemoryKeys.add(key);
      }
    }
    return tryFastAbortFromMessage({
      ctx: buildTestCtx({
        CommandBody: "/stop",
        RawBody: "/stop",
        CommandAuthorized: true,
        Provider: "telegram",
        Surface: "telegram",
        From: params.from,
        To: params.to,
        ...(params.sessionKey ? { SessionKey: params.sessionKey } : {}),
        ...(params.parentSessionKey ? { ParentSessionKey: params.parentSessionKey } : {}),
        ...(params.senderId ? { SenderId: params.senderId } : {}),
        ...(params.commandSource ? { CommandSource: params.commandSource } : {}),
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
    trackedAbortMemoryKeys.add(params.sessionKey);
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
      abortEmbeddedAgentRun: runtimeAbortMocks.abortEmbeddedAgentRun,
      resolveActiveEmbeddedRunSessionId: runtimeAbortMocks.resolveActiveEmbeddedRunSessionId,
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
    for (const key of trackedAbortMemoryKeys) {
      setAbortMemory(key, false);
    }
    trackedAbortMemoryKeys.clear();
    abortTesting.resetDepsForTests();
    acpResetTargetTesting.setDepsForTest();
    queueCleanupTesting.resetDepsForTests();
    replyRunRegistryTesting.resetReplyRunRegistry();
    commandQueueMocks.clearCommandLane.mockClear().mockReturnValue(1);
    acpManagerMocks.resolveSession.mockReset().mockReturnValue({ kind: "none" });
    acpManagerMocks.cancelSession.mockReset().mockResolvedValue(undefined);
    runtimeAbortMocks.abortEmbeddedAgentRun.mockReset().mockReturnValue(true);
    runtimeAbortMocks.resolveActiveEmbeddedRunSessionId.mockReset().mockReturnValue(undefined);
    subagentRegistryMocks.getLatestSubagentRunByChildSessionKey.mockReset().mockReturnValue(null);
  });

  it("isAbortTrigger matches standalone abort trigger phrases", () => {
    const positives = [
      "stop",
      "esc",
      "abort",
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
      "停下来",
      "暂停",
      "停下来！",
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
    expect(isAbortTrigger("wait")).toBe(false);
    expect(isAbortTrigger("please wait")).toBe(false);
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
    expect(isAbortRequestText("停下来")).toBe(true);
    expect(isAbortRequestText("暂停")).toBe(true);
    expect(isAbortRequestText("やめて")).toBe(true);
    expect(isAbortRequestText("остановись")).toBe(true);
    expect(isAbortRequestText("halt")).toBe(true);
    expect(isAbortRequestText("stopp")).toBe(true);
    expect(isAbortRequestText("pare")).toBe(true);
    expect(isAbortRequestText(" توقف ")).toBe(true);
    expect(isAbortRequestText("/stop@openclaw_bot", { botUsername: "openclaw_bot" })).toBe(true);
    expect(isAbortRequestText("/Stop@openclaw_bot", { botUsername: "openclaw_bot" })).toBe(true);

    expect(isAbortRequestText("/status")).toBe(false);
    expect(isAbortRequestText("wait")).toBe(false);
    expect(isAbortRequestText("please wait")).toBe(false);
    expect(isAbortRequestText("do not do that")).toBe(true);
    expect(isAbortRequestText("please do not do that")).toBe(false);
    expect(isAbortRequestText("/abort")).toBe(false);
  });

  it("removes abort memory entry when flag is reset", () => {
    setTrackedAbortMemory("session-1", true);
    expect(getAbortMemory("session-1")).toBe(true);

    setTrackedAbortMemory("session-1", false);
    expect(getAbortMemory("session-1")).toBeUndefined();
  });

  it("caps abort memory tracking to a bounded max size", () => {
    for (let i = 0; i < 2105; i += 1) {
      setTrackedAbortMemory(`bounded-memory-session-${i}`, true);
    }
    expect(getAbortMemory("bounded-memory-session-0")).toBeUndefined();
    expect(getAbortMemory("bounded-memory-session-2104")).toBe(true);
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

  it("fast-aborts authorized text slash stop commands before they queue", async () => {
    const sessionKey = "telegram:123";
    const sessionId = "session-123";
    const activeSessionId = "session-active";
    const { root, cfg } = await createAbortConfig({
      sessionIdsByKey: { [sessionKey]: sessionId },
    });
    cfg.commands = {
      ...cfg.commands,
      ownerAllowFrom: ["telegram:123"],
    };
    runtimeAbortMocks.resolveActiveEmbeddedRunSessionId.mockReturnValue(activeSessionId);
    enqueueQueuedFollowupRun({ root, cfg, sessionId, sessionKey });
    expect(getFollowupQueueDepth(sessionKey)).toBe(1);

    const result = await runStopCommand({
      cfg,
      sessionKey,
      from: "telegram:123",
      to: "telegram:123",
      senderId: "123",
      commandSource: "text",
    });

    expect(result.handled).toBe(true);
    expect(runtimeAbortMocks.resolveActiveEmbeddedRunSessionId).toHaveBeenCalledWith(sessionKey);
    expect(runtimeAbortMocks.abortEmbeddedAgentRun).toHaveBeenCalledWith(activeSessionId);
    expect(getFollowupQueueDepth(sessionKey)).toBe(0);
    expectSessionLaneCleared(sessionKey);
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

  it("fast-abort resolves canonical stored session identity before metadata persistence", async () => {
    const storeKey = "agent:main:telegram:group:-1001234567890:topic:99";
    const lookupKey = "Agent:Main:Telegram:Group:-1001234567890:Topic:99";
    const sessionId = "agent-topic-99";
    const { root, cfg } = await createAbortConfig({
      sessionIdsByKey: { [storeKey]: sessionId },
    });
    enqueueQueuedFollowupRun({ root, cfg, sessionId, sessionKey: storeKey });

    const result = await runStopCommand({
      cfg,
      sessionKey: lookupKey,
      from: "telegram:123",
      to: "telegram:123",
    });

    expect(result.handled).toBe(true);
    expect(runtimeAbortMocks.abortEmbeddedAgentRun).toHaveBeenCalledWith(sessionId);
    expect(getFollowupQueueDepth(storeKey)).toBe(0);
    expectSessionLaneCleared(storeKey);
  });

  it("fast-abort still stops active runs when abort metadata persistence fails", async () => {
    const sessionKey = "telegram:persistence-failure";
    const sessionId = "session-persistence-failure";
    const activeSessionId = "active-persistence-failure";
    const { root, cfg } = await createAbortConfig({
      sessionIdsByKey: { [sessionKey]: sessionId },
    });
    runtimeAbortMocks.resolveActiveEmbeddedRunSessionId.mockReturnValue(activeSessionId);
    abortTesting.setDepsForTests({
      getAcpSessionManager: (() =>
        ({
          resolveSession: acpManagerMocks.resolveSession,
          cancelSession: acpManagerMocks.cancelSession,
        }) as never) as never,
      abortEmbeddedAgentRun: runtimeAbortMocks.abortEmbeddedAgentRun,
      resolveActiveEmbeddedRunSessionId: runtimeAbortMocks.resolveActiveEmbeddedRunSessionId,
      markSessionAbortTarget: vi.fn(async () => {
        throw new Error("simulated persistence failure");
      }),
      getLatestSubagentRunByChildSessionKey:
        subagentRegistryMocks.getLatestSubagentRunByChildSessionKey,
      listSubagentRunsForController: subagentRegistryMocks.listSubagentRunsForRequester,
      markSubagentRunTerminated: subagentRegistryMocks.markSubagentRunTerminated,
    });
    enqueueQueuedFollowupRun({ root, cfg, sessionId, sessionKey });

    const result = await runStopCommand({
      cfg,
      sessionKey,
      from: "telegram:123",
      to: "telegram:123",
    });

    expect(result.handled).toBe(true);
    expect(runtimeAbortMocks.abortEmbeddedAgentRun).toHaveBeenCalledWith(activeSessionId);
    expect(getFollowupQueueDepth(sessionKey)).toBe(0);
    expectSessionLaneCleared(sessionKey);
    expect(getAbortMemory(sessionKey)).toBeUndefined();
  });

  it("fast-abort uses resolved target identity when abort metadata save fails", async () => {
    const requestedKey = "Agent:Main:Telegram:Group:-1001234567890:Topic:99";
    const canonicalKey = "agent:main:telegram:group:-1001234567890:topic:99";
    const sessionId = "resolved-persistence-failure";
    const { root, cfg } = await createAbortConfig();
    abortTesting.setDepsForTests({
      getAcpSessionManager: (() =>
        ({
          resolveSession: acpManagerMocks.resolveSession,
          cancelSession: acpManagerMocks.cancelSession,
        }) as never) as never,
      abortEmbeddedAgentRun: runtimeAbortMocks.abortEmbeddedAgentRun,
      resolveActiveEmbeddedRunSessionId: runtimeAbortMocks.resolveActiveEmbeddedRunSessionId,
      markSessionAbortTarget: vi.fn(async () => ({
        entry: {
          sessionId,
          updatedAt: 10,
        },
        persisted: false,
        persistenceError: "simulated persistence failure",
        sessionId,
        sessionKey: canonicalKey,
      })),
      resolveSessionAbortTarget: vi.fn(() => ({
        entry: {
          sessionId,
          updatedAt: 10,
        },
        sessionId,
        sessionKey: canonicalKey,
      })),
      getLatestSubagentRunByChildSessionKey:
        subagentRegistryMocks.getLatestSubagentRunByChildSessionKey,
      listSubagentRunsForController: subagentRegistryMocks.listSubagentRunsForRequester,
      markSubagentRunTerminated: subagentRegistryMocks.markSubagentRunTerminated,
    });
    enqueueQueuedFollowupRun({ root, cfg, sessionId, sessionKey: canonicalKey });

    const result = await runStopCommand({
      cfg,
      sessionKey: requestedKey,
      from: "telegram:123",
      to: "telegram:123",
    });

    expect(result.handled).toBe(true);
    expect(runtimeAbortMocks.abortEmbeddedAgentRun).toHaveBeenCalledWith(sessionId);
    expect(getFollowupQueueDepth(canonicalKey)).toBe(0);
    expectSessionLaneCleared(canonicalKey);
    expect(getAbortMemory(canonicalKey)).toBeUndefined();
  });

  it("fast-abort uses abort memory when no persisted target entry exists", async () => {
    const sessionKey = "telegram:missing-persistence-target";
    const { cfg } = await createAbortConfig();
    abortTesting.setDepsForTests({
      getAcpSessionManager: (() =>
        ({
          resolveSession: acpManagerMocks.resolveSession,
          cancelSession: acpManagerMocks.cancelSession,
        }) as never) as never,
      abortEmbeddedAgentRun: runtimeAbortMocks.abortEmbeddedAgentRun,
      resolveActiveEmbeddedRunSessionId: runtimeAbortMocks.resolveActiveEmbeddedRunSessionId,
      markSessionAbortTarget: vi.fn(async () => null),
      resolveSessionAbortTarget: vi.fn(() => null),
      getLatestSubagentRunByChildSessionKey:
        subagentRegistryMocks.getLatestSubagentRunByChildSessionKey,
      listSubagentRunsForController: subagentRegistryMocks.listSubagentRunsForRequester,
      markSubagentRunTerminated: subagentRegistryMocks.markSubagentRunTerminated,
    });

    const result = await runStopCommand({
      cfg,
      sessionKey,
      from: "telegram:123",
      to: "telegram:123",
    });

    expect(result.handled).toBe(true);
    expect(getAbortMemory(sessionKey)).toBe(true);
  });

  it("fast-abort does not wait for abort metadata persistence before stopping runs", async () => {
    const sessionKey = "telegram:slow-persistence";
    const childKey = "agent:main:subagent:slow-persistence-child";
    const sessionId = "session-slow-persistence";
    const childSessionId = "session-slow-persistence-child";
    const { root, cfg } = await createAbortConfig({
      sessionIdsByKey: {
        [childKey]: childSessionId,
        [sessionKey]: sessionId,
      },
    });
    let finishPersistence: (() => void) | undefined;
    const persistenceStarted = new Promise<void>((resolveStarted) => {
      abortTesting.setDepsForTests({
        getAcpSessionManager: (() =>
          ({
            resolveSession: acpManagerMocks.resolveSession,
            cancelSession: acpManagerMocks.cancelSession,
          }) as never) as never,
        abortEmbeddedAgentRun: runtimeAbortMocks.abortEmbeddedAgentRun,
        resolveActiveEmbeddedRunSessionId: runtimeAbortMocks.resolveActiveEmbeddedRunSessionId,
        markSessionAbortTarget: vi.fn(
          () =>
            new Promise<SessionAbortTargetResult | null>((resolvePersistence) => {
              resolveStarted();
              finishPersistence = () => {
                resolvePersistence({
                  entry: {
                    sessionId,
                    updatedAt: 10,
                  },
                  persisted: true,
                  sessionId,
                  sessionKey,
                });
              };
            }),
        ),
        resolveSessionAbortTarget: vi.fn(() => ({
          entry: {
            sessionId,
            updatedAt: 10,
          },
          sessionId,
          sessionKey,
        })),
        getLatestSubagentRunByChildSessionKey:
          subagentRegistryMocks.getLatestSubagentRunByChildSessionKey,
        listSubagentRunsForController: subagentRegistryMocks.listSubagentRunsForRequester,
        markSubagentRunTerminated: subagentRegistryMocks.markSubagentRunTerminated,
      });
    });
    enqueueQueuedFollowupRun({ root, cfg, sessionId, sessionKey });
    subagentRegistryMocks.listSubagentRunsForRequester.mockReturnValueOnce([
      {
        runId: "slow-child-run",
        childSessionKey: childKey,
        requesterSessionKey: sessionKey,
        requesterDisplayKey: sessionKey,
        task: "slow child",
        cleanup: "keep",
        createdAt: Date.now(),
      },
    ]);

    const resultPromise = runStopCommand({
      cfg,
      sessionKey,
      from: "telegram:123",
      to: "telegram:123",
    });
    await persistenceStarted;

    expect(runtimeAbortMocks.abortEmbeddedAgentRun).toHaveBeenCalledWith(sessionId);
    expect(runtimeAbortMocks.abortEmbeddedAgentRun).toHaveBeenCalledWith(childSessionId);
    expect(subagentRegistryMocks.markSubagentRunTerminated).toHaveBeenCalledWith({
      childSessionKey: childKey,
      reason: "killed",
      runId: "slow-child-run",
      suppressTaskDelivery: true,
    });
    expect(getFollowupQueueDepth(sessionKey)).toBe(0);
    expectSessionLaneCleared(sessionKey);

    finishPersistence?.();
    await expect(resultPromise).resolves.toMatchObject({
      aborted: true,
      handled: true,
    });
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

  it("fast-abort of an ACP target also aborts the bound source dispatch lane", async () => {
    const sourceSessionKey = "agent:main:discord:channel:C1";
    const acpSessionKey = "agent:codex:acp:bound-session";
    const { root, cfg } = await createAbortConfig({
      sessionIdsByKey: {
        [sourceSessionKey]: "source-store-session",
        [acpSessionKey]: "acp-store-session",
      },
    });
    const sourceOperation = createReplyOperation({
      sessionKey: sourceSessionKey,
      sessionId: "source-active-session",
      resetTriggered: false,
    });
    enqueueQueuedFollowupRun({
      root,
      cfg,
      sessionId: "source-active-session",
      sessionKey: sourceSessionKey,
    });
    enqueueQueuedFollowupRun({
      root,
      cfg,
      sessionId: "acp-store-session",
      sessionKey: acpSessionKey,
    });
    acpResetTargetTesting.setDepsForTest({
      getSessionBindingService: () =>
        ({
          resolveByConversation: () => ({
            targetKind: "session",
            targetSessionKey: acpSessionKey,
          }),
        }) as never,
      listAcpBindings: () => [],
      resolveConfiguredBindingRecord: () => null,
    });
    acpManagerMocks.resolveSession.mockReturnValue({
      kind: "ready",
      sessionKey: acpSessionKey,
      meta: {} as never,
    });

    const result = await runStopCommand({
      cfg,
      sessionKey: sourceSessionKey,
      from: "discord:C1",
      to: "discord:C1",
      targetSessionKey: acpSessionKey,
      commandSource: "native",
    });

    expect(result.handled).toBe(true);
    expect(sourceOperation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
    expect(replyRunRegistry.isActive(sourceSessionKey)).toBe(false);
    expect(getFollowupQueueDepth(sourceSessionKey)).toBe(0);
    expect(getFollowupQueueDepth(acpSessionKey)).toBe(0);
    expectSessionLaneCleared(sourceSessionKey);
    expectSessionLaneCleared(acpSessionKey);
    expect(acpManagerMocks.cancelSession).toHaveBeenCalledWith({
      cfg,
      sessionKey: acpSessionKey,
      reason: "fast-abort",
    });
  });

  it("does not report /stop success after the active backend freezes its outcome", async () => {
    const sessionKey = "agent:main:telegram:direct:finalizing";
    const sessionId = "session-finalizing";
    const { cfg } = await createAbortConfig({
      sessionIdsByKey: { [sessionKey]: sessionId },
    });
    const cancel = vi.fn();
    const operation = createReplyOperation({
      sessionKey,
      sessionId,
      resetTriggered: false,
    });
    operation.attachBackend({
      kind: "embedded",
      cancel,
      isStreaming: () => false,
      isAbortable: () => false,
    });
    operation.setPhase("running");
    runtimeAbortMocks.abortEmbeddedAgentRun.mockReturnValue(false);
    runtimeAbortMocks.resolveActiveEmbeddedRunSessionId.mockReturnValue(sessionId);
    const markSessionAbortTarget = vi.fn();
    abortTesting.setDepsForTests({ markSessionAbortTarget });

    const result = await runStopCommand({
      cfg,
      sessionKey,
      from: "telegram:finalizing",
      to: "telegram:finalizing",
    });

    expect(result).toMatchObject({
      handled: true,
      aborted: false,
      rejectionReason: "finalizing",
    });
    expect(operation.result).toBeNull();
    expect(replyRunRegistry.isActive(sessionKey)).toBe(true);
    expect(cancel).not.toHaveBeenCalled();
    expect(markSessionAbortTarget).not.toHaveBeenCalled();
    expect(getAbortMemory(sessionKey)).toBeUndefined();
    expect(formatAbortReplyText(undefined, result.rejectionReason)).toBe(
      "Agent reply is already finalizing and can no longer be aborted.",
    );
    operation.complete();
  });

  it("fast-abort of an ACP target aborts the source stored session when no source reply operation is registered", async () => {
    const sourceSessionKey = "agent:main:discord:channel:C2";
    const acpSessionKey = "agent:codex:acp:bound-session-stored-source";
    const { root, cfg } = await createAbortConfig({
      sessionIdsByKey: {
        [sourceSessionKey]: "source-store-session",
        [acpSessionKey]: "acp-store-session",
      },
    });
    enqueueQueuedFollowupRun({
      root,
      cfg,
      sessionId: "source-store-session",
      sessionKey: sourceSessionKey,
    });
    enqueueQueuedFollowupRun({
      root,
      cfg,
      sessionId: "acp-store-session",
      sessionKey: acpSessionKey,
    });
    acpResetTargetTesting.setDepsForTest({
      getSessionBindingService: () =>
        ({
          resolveByConversation: () => ({
            targetKind: "session",
            targetSessionKey: acpSessionKey,
          }),
        }) as never,
      listAcpBindings: () => [],
      resolveConfiguredBindingRecord: () => null,
    });
    acpManagerMocks.resolveSession.mockReturnValue({
      kind: "ready",
      sessionKey: acpSessionKey,
      meta: {} as never,
    });

    const result = await runStopCommand({
      cfg,
      sessionKey: sourceSessionKey,
      from: "discord:C2",
      to: "discord:C2",
      targetSessionKey: acpSessionKey,
      commandSource: "native",
    });

    expect(result.handled).toBe(true);
    expect(runtimeAbortMocks.abortEmbeddedAgentRun).toHaveBeenCalledWith("source-store-session");
    expect(getFollowupQueueDepth(sourceSessionKey)).toBe(0);
    expect(getFollowupQueueDepth(acpSessionKey)).toBe(0);
    expectSessionLaneCleared(sourceSessionKey);
    expectSessionLaneCleared(acpSessionKey);
  });

  it("does not abort the caller source lane for an unbound explicit ACP target", async () => {
    const sourceSessionKey = "agent:main:discord:channel:C3";
    const acpSessionKey = "agent:codex:acp:unbound-explicit-target";
    const { cfg } = await createAbortConfig({
      sessionIdsByKey: {
        [sourceSessionKey]: "source-store-session",
        [acpSessionKey]: "acp-store-session",
      },
    });
    const sourceOperation = createReplyOperation({
      sessionKey: sourceSessionKey,
      sessionId: "source-active-session",
      resetTriggered: false,
    });
    acpManagerMocks.resolveSession.mockReturnValue({
      kind: "ready",
      sessionKey: acpSessionKey,
      meta: {} as never,
    });

    const result = await runStopCommand({
      cfg,
      sessionKey: sourceSessionKey,
      from: "discord:C3",
      to: "discord:C3",
      targetSessionKey: acpSessionKey,
      commandSource: "native",
    });

    expect(result.handled).toBe(true);
    expect(sourceOperation.result).toBeNull();
    expect(replyRunRegistry.isActive(sourceSessionKey)).toBe(true);
    expect(acpManagerMocks.cancelSession).toHaveBeenCalledWith({
      cfg,
      sessionKey: acpSessionKey,
      reason: "fast-abort",
    });
    sourceOperation.complete();
  });

  it("uses ParentSessionKey as the source lane for a bound explicit ACP target", async () => {
    const sourceSessionKey = "agent:main:discord:channel:C4";
    const acpSessionKey = "agent:codex:acp:bound-parent-source";
    const { cfg } = await createAbortConfig({
      sessionIdsByKey: {
        [sourceSessionKey]: "source-store-session",
        [acpSessionKey]: "acp-store-session",
      },
    });
    const sourceOperation = createReplyOperation({
      sessionKey: sourceSessionKey,
      sessionId: "source-active-session",
      resetTriggered: false,
    });
    acpResetTargetTesting.setDepsForTest({
      getSessionBindingService: () =>
        ({
          resolveByConversation: () => ({
            targetKind: "session",
            targetSessionKey: acpSessionKey,
          }),
        }) as never,
      listAcpBindings: () => [],
      resolveConfiguredBindingRecord: () => null,
    });
    acpManagerMocks.resolveSession.mockReturnValue({
      kind: "ready",
      sessionKey: acpSessionKey,
      meta: {} as never,
    });

    const result = await runStopCommand({
      cfg,
      parentSessionKey: sourceSessionKey,
      from: "discord:C4",
      to: "discord:C4",
      targetSessionKey: acpSessionKey,
      commandSource: "native",
    });

    expect(result.handled).toBe(true);
    expect(sourceOperation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
    expect(replyRunRegistry.isActive(sourceSessionKey)).toBe(false);
  });

  it("fast-abort from an ACP-bound source conversation aborts source and bound ACP lanes", async () => {
    const sourceSessionKey = "agent:main:telegram:direct:source-1";
    const acpSessionKey = "agent:codex:acp:bound-source-stop";
    const { root, storePath, cfg } = await createAbortConfig({
      sessionIdsByKey: {
        [sourceSessionKey]: "source-store-session",
        [acpSessionKey]: "acp-store-session",
      },
    });
    const sourceOperation = createReplyOperation({
      sessionKey: sourceSessionKey,
      sessionId: "source-active-session",
      resetTriggered: false,
    });
    const acpOperation = createReplyOperation({
      sessionKey: acpSessionKey,
      sessionId: "acp-active-session",
      resetTriggered: false,
    });
    enqueueQueuedFollowupRun({
      root,
      cfg,
      sessionId: "source-active-session",
      sessionKey: sourceSessionKey,
    });
    enqueueQueuedFollowupRun({
      root,
      cfg,
      sessionId: "acp-active-session",
      sessionKey: acpSessionKey,
    });
    acpResetTargetTesting.setDepsForTest({
      getSessionBindingService: () =>
        ({
          resolveByConversation: () => ({
            targetKind: "session",
            targetSessionKey: acpSessionKey,
          }),
        }) as never,
      listAcpBindings: () => [],
      resolveConfiguredBindingRecord: () => null,
    });
    acpManagerMocks.resolveSession.mockReturnValue({
      kind: "ready",
      sessionKey: acpSessionKey,
      meta: {} as never,
    });

    const result = await runStopCommand({
      cfg,
      sessionKey: sourceSessionKey,
      from: "telegram:source-1",
      to: "telegram:source-1",
      messageSid: "77",
      timestamp: 1234567890000,
    });

    expect(result.handled).toBe(true);
    expect(sourceOperation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
    expect(acpOperation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
    expect(replyRunRegistry.isActive(sourceSessionKey)).toBe(false);
    expect(replyRunRegistry.isActive(acpSessionKey)).toBe(false);
    expect(getFollowupQueueDepth(sourceSessionKey)).toBe(0);
    expect(getFollowupQueueDepth(acpSessionKey)).toBe(0);
    expectSessionLaneCleared(sourceSessionKey);
    expectSessionLaneCleared(acpSessionKey);
    expect(acpManagerMocks.cancelSession).toHaveBeenCalledWith({
      cfg,
      sessionKey: acpSessionKey,
      reason: "fast-abort",
    });
    const sourceEntry = readAbortSessionEntry(storePath, sourceSessionKey);
    const acpEntry = readAbortSessionEntry(storePath, acpSessionKey);
    expect(sourceEntry?.abortCutoffMessageSid).toBe("77");
    expect(sourceEntry?.abortCutoffTimestamp).toBe(1234567890000);
    expect(acpEntry?.abortCutoffMessageSid).toBeUndefined();
    expect(acpEntry?.abortCutoffTimestamp).toBeUndefined();
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
    const entry = readAbortSessionEntry(storePath, sessionKey);
    expect(entry?.abortedLastRun).toBe(true);
    expect(entry?.abortCutoffMessageSid).toBe("55");
    expect(entry?.abortCutoffTimestamp).toBe(1234567890000);
  });

  it("persists abort cutoff metadata when only ParentSessionKey identifies the command session", async () => {
    const sessionKey = "telegram:parent-only";
    const sessionId = "session-parent-only";
    const { storePath, cfg } = await createAbortConfig({
      sessionIdsByKey: { [sessionKey]: sessionId },
    });

    const result = await runStopCommand({
      cfg,
      parentSessionKey: sessionKey,
      from: "telegram:parent-only",
      to: "telegram:parent-only",
      messageSid: "56",
      timestamp: 1234567890001,
    });

    expect(result.handled).toBe(true);
    const entry = readAbortSessionEntry(storePath, sessionKey);
    expect(entry?.abortedLastRun).toBe(true);
    expect(entry?.abortCutoffMessageSid).toBe("56");
    expect(entry?.abortCutoffTimestamp).toBe(1234567890001);
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
    const entry = readAbortSessionEntry(storePath, targetSessionKey);
    expect(entry?.abortedLastRun).toBe(true);
    expect(entry?.abortCutoffMessageSid).toBeUndefined();
    expect(entry?.abortCutoffTimestamp).toBeUndefined();
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

  it("continues stopping siblings when one termination persistence write fails", () => {
    subagentRegistryMocks.markSubagentRunTerminated.mockClear();
    const sessionKey = "telegram:persistence-failure-parent";
    const firstChildKey = "agent:main:subagent:persistence-failure-first";
    const secondChildKey = "agent:main:subagent:persistence-failure-second";
    const run = (runId: string, childSessionKey: string): SubagentRunRecord => ({
      runId,
      childSessionKey,
      requesterSessionKey: sessionKey,
      requesterDisplayKey: sessionKey,
      task: "stop despite persistence failure",
      cleanup: "keep",
      createdAt: Date.now(),
    });
    subagentRegistryMocks.listSubagentRunsForRequester
      .mockReturnValueOnce([
        run("run-persistence-failure-first", firstChildKey),
        run("run-persistence-failure-second", secondChildKey),
      ])
      .mockReturnValue([]);
    subagentRegistryMocks.markSubagentRunTerminated
      .mockImplementationOnce(() => {
        throw new Error("sqlite busy");
      })
      .mockReturnValue(1);

    expect(
      stopSubagentsForRequester({
        cfg: {} as OpenClawConfig,
        requesterSessionKey: sessionKey,
      }),
    ).toEqual({ stopped: 2 });
    expect(subagentRegistryMocks.markSubagentRunTerminated).toHaveBeenCalledTimes(2);
    expectSessionLaneCleared(firstChildKey);
    expectSessionLaneCleared(secondChildKey);
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

  it("stops a subagent that is paused after yielding", () => {
    subagentRegistryMocks.listSubagentRunsForRequester.mockClear();
    subagentRegistryMocks.markSubagentRunTerminated.mockClear();
    const sessionKey = "telegram:yield-parent";
    const childKey = "agent:main:subagent:yield-child";
    const now = Date.now();
    subagentRegistryMocks.listSubagentRunsForRequester
      .mockReturnValueOnce([
        {
          runId: "run-yield-child",
          childSessionKey: childKey,
          requesterSessionKey: sessionKey,
          requesterDisplayKey: sessionKey,
          task: "paused worker",
          cleanup: "keep",
          createdAt: now - 1_000,
          endedAt: now - 500,
          pauseReason: "sessions_yield",
        },
      ])
      .mockReturnValueOnce([]);

    const result = stopSubagentsForRequester({
      cfg: {} as OpenClawConfig,
      requesterSessionKey: sessionKey,
    });

    expect(result).toEqual({ stopped: 1 });
    expectSessionLaneCleared(childKey);
    expect(subagentRegistryMocks.markSubagentRunTerminated).toHaveBeenCalledWith({
      runId: "run-yield-child",
      childSessionKey: childKey,
      reason: "killed",
      suppressTaskDelivery: true,
    });
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
    expect(subagentRegistryMocks.markSubagentRunTerminated).toHaveBeenCalledTimes(1);
    const [terminatedRun] = expectDefined(
      (
        subagentRegistryMocks.markSubagentRunTerminated.mock.calls as unknown as Array<
          [{ runId?: string; childSessionKey?: string }]
        >
      )[0],
      "(subagentRegistryMocks.markSubagentRunTerminated.mock.calls as unknown as Array<\n        [{ runId?: string; childSessionKey?: string }]\n      >)[0] test invariant",
    );
    expect(terminatedRun.runId).toBe("run-2");
    expect(terminatedRun.childSessionKey).toBe(depth2Key);
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
    expect(subagentRegistryMocks.markSubagentRunTerminated).toHaveBeenCalledTimes(1);
    const [terminatedRun] = expectDefined(
      (
        subagentRegistryMocks.markSubagentRunTerminated.mock.calls as unknown as Array<
          [{ runId?: string; childSessionKey?: string }]
        >
      )[0],
      "(subagentRegistryMocks.markSubagentRunTerminated.mock.calls as unknown as Array<\n        [{ runId?: string; childSessionKey?: string }]\n      >)[0] test invariant",
    );
    expect(terminatedRun.runId).toBe("run-active-child");
    expect(terminatedRun.childSessionKey).toBe(depth2Key);
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
