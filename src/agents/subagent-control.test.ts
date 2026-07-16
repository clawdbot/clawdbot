// Subagent control tests cover sending, steering, killing, and admin cleanup of
// child runs recorded in the subagent registry and session store.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SessionAccessScope,
  SessionEntryPatchContext,
  SessionEntryPatchOptions,
} from "../config/sessions/session-accessor.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CallGatewayOptions } from "../gateway/call.js";
import { SUBAGENT_KILL_TASK_ERROR } from "../tasks/detached-task-runtime-contract.js";
import {
  testing,
  killAllControlledSubagentRuns,
  killControlledSubagentRun,
  killSubagentRunAdmin,
  listControlledSubagentRuns,
  sendControlledSubagentMessage,
  steerControlledSubagentRun,
} from "./subagent-control.test-support.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_KILLED,
} from "./subagent-lifecycle-events.js";
import {
  testing as subagentRegistryTesting,
  addSubagentRunForTests,
  getSubagentRunByChildSessionKey,
  resetSubagentRegistryForTests,
} from "./subagent-registry.test-helpers.js";

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(),
}));

const detachedTaskRuntimeMocks = vi.hoisted(() => ({
  findDetachedTaskRun: vi.fn(() => ({ lookup: "available" as const })),
  finalizeTaskRunByRunId: vi.fn<(_params: unknown) => unknown[]>(() => []),
}));

vi.mock("../tasks/detached-task-runtime.js", () => ({
  createQueuedTaskRun: vi.fn(() => null),
  createRunningTaskRun: vi.fn(() => null),
  startTaskRunByRunId: vi.fn(() => []),
  recordTaskRunProgressByRunId: vi.fn(() => []),
  finalizeTaskRunByRunId: detachedTaskRuntimeMocks.finalizeTaskRunByRunId,
  completeTaskRunByRunId: vi.fn(() => []),
  failTaskRunByRunId: vi.fn(() => []),
  setDetachedTaskDeliveryStatusByRunId: vi.fn(() => []),
  findDetachedTaskRun: detachedTaskRuntimeMocks.findDetachedTaskRun,
}));

vi.mock("./run-wait.js", () => {
  const readLatestAssistantReplySnapshot = async (params: {
    sessionKey: string;
    limit?: number;
    callGateway?: (request: CallGatewayOptions) => Promise<{ messages?: unknown[] }>;
  }) => {
    // The real helper snapshots assistant fingerprints so a steer command only
    // reports new replies, not the baseline text that existed before steering.
    const history = await params.callGateway?.({
      method: "chat.history",
      params: { sessionKey: params.sessionKey, limit: params.limit ?? 50 },
    });
    const messages = Array.isArray(history?.messages) ? history.messages : [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (!message || typeof message !== "object") {
        continue;
      }
      if ((message as { role?: unknown }).role !== "assistant") {
        continue;
      }
      const content = (message as { content?: unknown }).content;
      let text = "";
      if (Array.isArray(content)) {
        const textBlocks: string[] = [];
        for (const block of content) {
          if (
            block &&
            typeof block === "object" &&
            typeof (block as { text?: unknown }).text === "string"
          ) {
            textBlocks.push((block as { text: string }).text);
          }
        }
        text = textBlocks.join("\n");
      } else if (typeof content === "string") {
        text = content;
      }
      if (text.trim()) {
        return { text, fingerprint: JSON.stringify(message) };
      }
    }
    return {};
  };

  return {
    readLatestAssistantReplySnapshot,
    waitForAgentRunAndReadUpdatedAssistantReply: async (params: {
      runId: string;
      sessionKey: string;
      timeoutMs: number;
      limit?: number;
      baseline?: { fingerprint?: string };
      callGateway?: (request: CallGatewayOptions) => Promise<Record<string, unknown>>;
    }) => {
      const wait = await params.callGateway?.({
        method: "agent.wait",
        params: {
          runId: params.runId,
          timeoutMs: Math.max(1, Math.floor(params.timeoutMs)),
        },
        timeoutMs: Math.max(1, Math.floor(params.timeoutMs)) + 2000,
      });
      const status = wait?.status;
      if (status === "timeout" || status === "pending" || status === "error") {
        return { status, error: typeof wait?.error === "string" ? wait.error : undefined };
      }
      const latestReply = await readLatestAssistantReplySnapshot({
        sessionKey: params.sessionKey,
        limit: params.limit,
        callGateway: params.callGateway as
          | ((request: CallGatewayOptions) => Promise<{ messages?: unknown[] }>)
          | undefined,
      });
      return {
        status: "ok",
        replyText:
          latestReply.text &&
          (!params.baseline?.fingerprint || latestReply.fingerprint !== params.baseline.fingerprint)
            ? latestReply.text
            : undefined,
      };
    },
  };
});

function setSubagentControlDepsForTest(
  overrides: Parameters<typeof testing.setDepsForTest>[0] = {},
) {
  // Tests use real JSON store mutation to catch persisted cleanup/kill state,
  // while swapping process-owned queues and embedded-run aborts for fakes.
  testing.setDepsForTest({
    abortEmbeddedAgentRun: () => false,
    isEmbeddedAgentRunActive: () => false,
    clearSessionQueues: () => ({ followupCleared: 0, laneCleared: 0, keys: [] }),
    patchSessionEntry: async (
      scope: SessionAccessScope,
      patcher: (
        entry: SessionEntry,
        context: SessionEntryPatchContext,
      ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null,
      options: SessionEntryPatchOptions = {},
    ) => {
      if (!scope.storePath) {
        return null;
      }
      const store = JSON.parse(fs.readFileSync(scope.storePath, "utf-8")) as Record<
        string,
        SessionEntry
      >;
      const entry = store[scope.sessionKey];
      if (!entry) {
        return null;
      }
      const patch = await patcher(entry, { existingEntry: { ...entry } });
      if (!patch) {
        return entry;
      }
      const next = options.replaceEntry ? (patch as SessionEntry) : { ...entry, ...patch };
      store[scope.sessionKey] = next;
      fs.writeFileSync(scope.storePath, JSON.stringify(store, null, 2), "utf-8");
      return next;
    },
    ...overrides,
  });
}

let tempRoot = "";
let tempStoreIndex = 0;

beforeAll(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-subagent-control-"));
});

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function nextSessionStorePath(label: string) {
  tempStoreIndex += 1;
  return path.join(tempRoot, `${tempStoreIndex}-${label}.json`);
}

function cfgWithSessionStore(storePath = nextSessionStorePath("sessions")): OpenClawConfig {
  return {
    session: { store: storePath },
  } as OpenClawConfig;
}

async function writeSessionStoreFixture(label: string, store: Record<string, unknown>) {
  const storePath = nextSessionStorePath(label);
  for (const [sessionKey, entry] of Object.entries(store)) {
    const record = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    const sessionId =
      typeof record.sessionId === "string" && record.sessionId.trim()
        ? record.sessionId
        : `sess-${sessionKey.replaceAll(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")}`;
    await replaceSessionEntry({ storePath, sessionKey }, {
      ...record,
      sessionId,
    } as SessionEntry);
  }
  return storePath;
}

beforeEach(() => {
  detachedTaskRuntimeMocks.finalizeTaskRunByRunId.mockClear();
  setSubagentControlDepsForTest();
  subagentRegistryTesting.setDepsForTest({
    cleanupBrowserSessionsForLifecycleEnd: async () => {},
    ensureContextEnginesInitialized: () => {},
    ensureRuntimePluginsLoaded: () => {},
    getSubagentRunsSnapshotForRead: (runs) => new Map(runs),
    persistSubagentRunsToDisk: () => {},
    persistSubagentRunsToDiskOrThrow: () => {},
    restoreSubagentRunsFromDisk: () => 0,
    resolveContextEngine: async () => ({
      info: { id: "test", name: "Test" },
      assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
      compact: async () => ({ ok: true, compacted: false }),
      ingest: async () => ({ ingested: false }),
    }),
  });
});

afterEach(() => {
  subagentRegistryTesting.setDepsForTest();
});

describe("sendControlledSubagentMessage", () => {
  afterEach(() => {
    resetSubagentRegistryForTests({ persist: false });
    testing.setDepsForTest();
  });

  it("rejects runs controlled by another session", async () => {
    const result = await sendControlledSubagentMessage({
      cfg: {
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig,
      controller: {
        controllerSessionKey: "agent:main:subagent:leaf",
        callerSessionKey: "agent:main:subagent:leaf",
        callerIsSubagent: true,
        controlScope: "children",
      },
      entry: {
        runId: "run-foreign",
        childSessionKey: "agent:main:subagent:other",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        controllerSessionKey: "agent:main:subagent:other-parent",
        task: "foreign run",
        cleanup: "keep",
        createdAt: Date.now() - 5_000,
        startedAt: Date.now() - 4_000,
        endedAt: Date.now() - 1_000,
        outcome: { status: "ok" },
      },
      message: "continue",
    });

    expect(result).toEqual({
      status: "forbidden",
      error: "Subagents can only control runs spawned from their own session.",
    });
  });

  it("returns a structured error when the gateway send fails", async () => {
    addSubagentRunForTests({
      runId: "run-owned",
      childSessionKey: "agent:main:subagent:owned",
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "continue work",
      cleanup: "keep",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
    });

    setSubagentControlDepsForTest({
      callGateway: async <T = Record<string, unknown>>(request: CallGatewayOptions) => {
        if (request.method === "agent") {
          throw new Error("gateway unavailable");
        }
        return {} as T;
      },
    });

    const result = await sendControlledSubagentMessage({
      cfg: {
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig,
      controller: {
        controllerSessionKey: "agent:main:main",
        callerSessionKey: "agent:main:main",
        callerIsSubagent: false,
        controlScope: "children",
      },
      entry: {
        runId: "run-owned",
        childSessionKey: "agent:main:subagent:owned",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        controllerSessionKey: "agent:main:main",
        task: "continue work",
        cleanup: "keep",
        createdAt: Date.now() - 5_000,
        startedAt: Date.now() - 4_000,
      },
      message: "continue",
    });

    expect(result.status).toBe("error");
    expect(typeof result.runId).toBe("string");
    expect(result.error).toBe("gateway unavailable");
  });

  it("does not send to a newer live run when the caller passes a stale run entry", async () => {
    addSubagentRunForTests({
      runId: "run-current-send",
      childSessionKey: "agent:main:subagent:send-worker",
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "current task",
      cleanup: "keep",
      createdAt: Date.now() - 4_000,
      startedAt: Date.now() - 3_000,
    });

    const result = await sendControlledSubagentMessage({
      cfg: {
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig,
      controller: {
        controllerSessionKey: "agent:main:main",
        callerSessionKey: "agent:main:main",
        callerIsSubagent: false,
        controlScope: "children",
      },
      entry: {
        runId: "run-stale-send",
        childSessionKey: "agent:main:subagent:send-worker",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        controllerSessionKey: "agent:main:main",
        task: "stale task",
        cleanup: "keep",
        createdAt: Date.now() - 9_000,
        startedAt: Date.now() - 8_000,
      },
      message: "continue",
    });

    expect(result).toEqual({
      status: "done",
      runId: "run-stale-send",
      text: "stale task is already finished.",
    });
  });

  it("sends follow-up messages to the exact finished current run", async () => {
    addSubagentRunForTests({
      runId: "run-finished-send",
      childSessionKey: "agent:main:subagent:finished-worker",
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "finished task",
      cleanup: "keep",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
      endedAt: Date.now() - 1_000,
      outcome: { status: "ok" },
    });

    setSubagentControlDepsForTest({
      callGateway: async <T = Record<string, unknown>>(request: CallGatewayOptions) => {
        if (request.method === "chat.history") {
          return { messages: [] } as T;
        }
        if (request.method === "agent") {
          return { runId: "run-followup-send" } as T;
        }
        if (request.method === "agent.wait") {
          return { status: "done" } as T;
        }
        throw new Error(`unexpected method: ${request.method}`);
      },
    });

    const result = await sendControlledSubagentMessage({
      cfg: {
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig,
      controller: {
        controllerSessionKey: "agent:main:main",
        callerSessionKey: "agent:main:main",
        callerIsSubagent: false,
        controlScope: "children",
      },
      entry: {
        runId: "run-finished-send",
        childSessionKey: "agent:main:subagent:finished-worker",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        controllerSessionKey: "agent:main:main",
        task: "finished task",
        cleanup: "keep",
        createdAt: Date.now() - 5_000,
        startedAt: Date.now() - 4_000,
        endedAt: Date.now() - 1_000,
        outcome: { status: "ok" },
      },
      message: "continue",
    });

    expect(result).toEqual({
      status: "ok",
      runId: "run-followup-send",
      replyText: undefined,
    });
  });

  it("sends follow-up messages to the newest finished run when stale active rows still exist", async () => {
    const childSessionKey = "agent:main:subagent:finished-stale-worker";
    addSubagentRunForTests({
      runId: "run-stale-active-send",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "stale active task",
      cleanup: "keep",
      createdAt: Date.now() - 9_000,
      startedAt: Date.now() - 8_000,
    });
    addSubagentRunForTests({
      runId: "run-current-finished-send",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "finished task",
      cleanup: "keep",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
      endedAt: Date.now() - 1_000,
      outcome: { status: "ok" },
    });

    setSubagentControlDepsForTest({
      callGateway: async <T = Record<string, unknown>>(request: CallGatewayOptions) => {
        if (request.method === "chat.history") {
          return { messages: [] } as T;
        }
        if (request.method === "agent") {
          return { runId: "run-followup-stale-send" } as T;
        }
        if (request.method === "agent.wait") {
          return { status: "done" } as T;
        }
        throw new Error(`unexpected method: ${request.method}`);
      },
    });

    const result = await sendControlledSubagentMessage({
      cfg: {
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig,
      controller: {
        controllerSessionKey: "agent:main:main",
        callerSessionKey: "agent:main:main",
        callerIsSubagent: false,
        controlScope: "children",
      },
      entry: {
        runId: "run-current-finished-send",
        childSessionKey,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        controllerSessionKey: "agent:main:main",
        task: "finished task",
        cleanup: "keep",
        createdAt: Date.now() - 5_000,
        startedAt: Date.now() - 4_000,
        endedAt: Date.now() - 1_000,
        outcome: { status: "ok" },
      },
      message: "continue",
    });

    expect(result).toEqual({
      status: "ok",
      runId: "run-followup-stale-send",
      replyText: undefined,
    });
  });

  it("does not return the previous assistant reply when no new assistant message appears", async () => {
    addSubagentRunForTests({
      runId: "run-owned-stale-reply",
      childSessionKey: "agent:main:subagent:owned-stale-reply",
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "continue work",
      cleanup: "keep",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
      endedAt: Date.now() - 1_000,
      outcome: { status: "ok" },
    });

    let historyCalls = 0;
    const staleAssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "older reply from a previous run" }],
    };
    setSubagentControlDepsForTest({
      callGateway: async <T = Record<string, unknown>>(request: CallGatewayOptions) => {
        if (request.method === "chat.history") {
          historyCalls += 1;
          return { messages: [staleAssistantMessage] } as T;
        }
        if (request.method === "agent") {
          return { runId: "run-followup-stale-reply" } as T;
        }
        if (request.method === "agent.wait") {
          return { status: "done" } as T;
        }
        throw new Error(`unexpected method: ${request.method}`);
      },
    });

    const result = await sendControlledSubagentMessage({
      cfg: {
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig,
      controller: {
        controllerSessionKey: "agent:main:main",
        callerSessionKey: "agent:main:main",
        callerIsSubagent: false,
        controlScope: "children",
      },
      entry: {
        runId: "run-owned-stale-reply",
        childSessionKey: "agent:main:subagent:owned-stale-reply",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        controllerSessionKey: "agent:main:main",
        task: "continue work",
        cleanup: "keep",
        createdAt: Date.now() - 5_000,
        startedAt: Date.now() - 4_000,
        endedAt: Date.now() - 1_000,
        outcome: { status: "ok" },
      },
      message: "continue",
    });

    expect(historyCalls).toBe(2);
    expect(result).toEqual({
      status: "ok",
      runId: "run-followup-stale-reply",
      replyText: undefined,
    });
  });
});

describe("killSubagentRunAdmin", () => {
  afterEach(() => {
    resetSubagentRegistryForTests({ persist: false });
    testing.setDepsForTest();
  });

  it("kills a subagent by session key without requester ownership checks", async () => {
    const childSessionKey = "agent:main:subagent:worker";
    const storePath = await writeSessionStoreFixture("admin-kill", {
      [childSessionKey]: {
        sessionId: "sess-worker",
        updatedAt: Date.now(),
      },
    });

    addSubagentRunForTests({
      runId: "run-worker",
      childSessionKey,
      controllerSessionKey: "agent:main:other-controller",
      requesterSessionKey: "agent:main:other-requester",
      requesterDisplayKey: "other-requester",
      task: "do the work",
      cleanup: "keep",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
    });

    const cfg = cfgWithSessionStore(storePath);

    const result = await killSubagentRunAdmin({
      cfg,
      sessionKey: childSessionKey,
    });

    expect(result.found).toBe(true);
    expect(result.killed).toBe(true);
    if (!result.found) {
      throw new Error("expected tracked subagent run");
    }
    expect(result.runId).toBe("run-worker");
    expect(result.sessionKey).toBe(childSessionKey);
    expect(getSubagentRunByChildSessionKey(childSessionKey)?.endedAt).toBeTypeOf("number");
    expect(detachedTaskRuntimeMocks.finalizeTaskRunByRunId).toHaveBeenCalledTimes(1);
    expect(detachedTaskRuntimeMocks.finalizeTaskRunByRunId).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-worker",
        runtime: "subagent",
        sessionKey: childSessionKey,
        status: "cancelled",
      }),
    );
  });

  it("returns found=false when the session key is not tracked as a subagent run", async () => {
    const result = await killSubagentRunAdmin({
      cfg: cfgWithSessionStore(),
      sessionKey: "agent:main:subagent:missing",
    });

    expect(result).toEqual({ found: false, killed: false });
  });

  it("retries task reconciliation for an already-killed run", async () => {
    const childSessionKey = "agent:main:subagent:already-killed";
    const endedAt = Date.now() - 1_000;
    addSubagentRunForTests({
      runId: "run-already-killed",
      childSessionKey,
      controllerSessionKey: "agent:main:controller",
      requesterSessionKey: "agent:main:requester",
      requesterDisplayKey: "requester",
      task: "repair task projection",
      cleanup: "keep",
      createdAt: endedAt - 4_000,
      startedAt: endedAt - 3_000,
      endedAt,
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      outcome: { status: "error", error: "killed" },
      suppressAnnounceReason: "killed",
      killReconciliation: { killedAt: endedAt },
      cleanupCompletedAt: endedAt + 500,
    });

    const first = await killSubagentRunAdmin({ cfg: {}, sessionKey: childSessionKey });
    const second = await killSubagentRunAdmin({ cfg: {}, sessionKey: childSessionKey });

    for (const result of [first, second]) {
      expect(result).toMatchObject({
        found: true,
        killed: false,
        targetState: {
          state: "terminal",
          task: {
            status: "cancelled",
            endedAt,
            error: SUBAGENT_KILL_TASK_ERROR,
          },
        },
      });
    }
    expect(detachedTaskRuntimeMocks.finalizeTaskRunByRunId).toHaveBeenCalledTimes(2);
  });

  it("keeps a killed steer-restart run on its failed projection", async () => {
    const childSessionKey = "agent:main:subagent:steer-restart";
    const endedAt = Date.now() - 1_000;
    addSubagentRunForTests({
      runId: "run-steer-restart",
      childSessionKey,
      controllerSessionKey: "agent:main:controller",
      requesterSessionKey: "agent:main:requester",
      requesterDisplayKey: "requester",
      task: "replace active run",
      cleanup: "keep",
      createdAt: endedAt - 4_000,
      startedAt: endedAt - 3_000,
      endedAt,
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      suppressAnnounceReason: "steer-restart",
      outcome: { status: "error", error: "agent run aborted" },
      completion: { required: false, resultText: null, capturedAt: endedAt },
    });

    const result = await killSubagentRunAdmin({ cfg: {}, sessionKey: childSessionKey });

    expect(result).toMatchObject({
      found: true,
      killed: false,
      targetState: {
        state: "terminal",
        task: {
          status: "failed",
          endedAt,
          error: "agent run aborted",
        },
      },
    });
    expect(detachedTaskRuntimeMocks.finalizeTaskRunByRunId).not.toHaveBeenCalled();
  });

  it("restores the recoverable task marker when abort lifecycle wins the race", async () => {
    const childSessionKey = "agent:main:subagent:abort-lifecycle-race";
    const storePath = await writeSessionStoreFixture("admin-kill-abort-lifecycle-race", {
      [childSessionKey]: {
        sessionId: "sess-abort-lifecycle-race",
        updatedAt: Date.now(),
      },
    });
    const run = {
      runId: "run-abort-lifecycle-race",
      childSessionKey,
      controllerSessionKey: "agent:main:controller",
      requesterSessionKey: "agent:main:requester",
      requesterDisplayKey: "requester",
      task: "finish while aborting",
      cleanup: "keep" as const,
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
    };
    const abortedLastRunWrites: boolean[] = [];
    addSubagentRunForTests(run);
    setSubagentControlDepsForTest({
      isEmbeddedAgentRunActive: () => true,
      abortEmbeddedAgentRun: () => {
        const endedAt = Date.now();
        Object.assign(run, {
          endedAt,
          endedReason: SUBAGENT_ENDED_REASON_KILLED,
          outcome: { status: "error" as const, error: "agent run aborted" },
          suppressAnnounceReason: "killed" as const,
          killReconciliation: { killedAt: endedAt },
        });
        return true;
      },
      patchSessionEntry: async (_scope, patcher) => {
        const current = { sessionId: "sess-abort-lifecycle-race", updatedAt: Date.now() };
        const patch = await patcher(current, { existingEntry: { ...current } });
        abortedLastRunWrites.push(patch?.abortedLastRun === true);
        return patch ? { ...current, ...patch } : current;
      },
    });

    const result = await killSubagentRunAdmin({
      cfg: cfgWithSessionStore(storePath),
      sessionKey: childSessionKey,
    });

    expect(result).toMatchObject({ found: true, killed: true });
    expect(detachedTaskRuntimeMocks.finalizeTaskRunByRunId).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-abort-lifecycle-race",
        status: "cancelled",
        error: SUBAGENT_KILL_TASK_ERROR,
      }),
    );
    expect(abortedLastRunWrites).toEqual([true]);
  });

  it("reports when completion wins while the kill path awaits persistence", async () => {
    const childSessionKey = "agent:main:subagent:completion-race";
    const storePath = await writeSessionStoreFixture("admin-kill-completion-race", {
      [childSessionKey]: {
        sessionId: "sess-completion-race",
        updatedAt: Date.now(),
      },
    });
    const run = {
      runId: "run-completion-race",
      childSessionKey,
      controllerSessionKey: "agent:main:controller",
      requesterSessionKey: "agent:main:requester",
      requesterDisplayKey: "requester",
      task: "finish while cancellation starts",
      cleanup: "keep" as const,
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
    };
    const abortedLastRunWrites: boolean[] = [];
    addSubagentRunForTests({
      ...run,
      runId: "run-stale-completion-race",
      task: "stale older row",
      createdAt: Date.now() - 9_000,
      startedAt: Date.now() - 8_000,
    });
    addSubagentRunForTests(run);
    setSubagentControlDepsForTest({
      isEmbeddedAgentRunActive: () => true,
      abortEmbeddedAgentRun: () => true,
      patchSessionEntry: async (_scope, patcher) => {
        const current = { sessionId: "sess-completion-race", updatedAt: Date.now() };
        const patch = await patcher(current, { existingEntry: { ...current } });
        abortedLastRunWrites.push(patch?.abortedLastRun === true);
        if (abortedLastRunWrites.length === 1) {
          Object.assign(run, {
            endedAt: Date.now(),
            endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
            outcome: { status: "ok" as const },
            completion: {
              required: false,
              resultText: "done",
              capturedAt: Date.now(),
            },
          });
        }
        return patch ? { ...current, ...patch } : current;
      },
    });

    const result = await killSubagentRunAdmin({
      cfg: cfgWithSessionStore(storePath),
      sessionKey: childSessionKey,
    });

    expect(result).toMatchObject({
      found: true,
      killed: false,
      targetState: {
        state: "terminal",
        task: {
          status: "succeeded",
          endedAt: expect.any(Number),
          progressSummary: "done",
          terminalSummary: null,
        },
      },
      runId: "run-completion-race",
    });
    expect(abortedLastRunWrites).toEqual([true, false]);
    expect(run).toMatchObject({
      endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
      outcome: { status: "ok" },
    });
    expect(detachedTaskRuntimeMocks.finalizeTaskRunByRunId).not.toHaveBeenCalled();
  });

  it("refreshes target completion after descendant cancellation settles", async () => {
    const childSessionKey = "agent:main:subagent:cascade-completion-race";
    const descendantSessionKey = "agent:main:subagent:cascade-completion-child";
    const storePath = await writeSessionStoreFixture("admin-kill-cascade-completion-race", {
      [childSessionKey]: {
        sessionId: "sess-cascade-completion-race",
        updatedAt: Date.now(),
      },
      [descendantSessionKey]: {
        sessionId: "sess-cascade-completion-child",
        updatedAt: Date.now(),
      },
    });
    const run = {
      runId: "run-cascade-completion-race",
      childSessionKey,
      controllerSessionKey: "agent:main:controller",
      requesterSessionKey: "agent:main:requester",
      requesterDisplayKey: "requester",
      task: "finish while descendant cancellation settles",
      cleanup: "keep" as const,
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
    };
    const abortedLastRunWrites: boolean[] = [];
    addSubagentRunForTests(run);
    addSubagentRunForTests({
      runId: "run-cascade-completion-child",
      childSessionKey: descendantSessionKey,
      controllerSessionKey: childSessionKey,
      requesterSessionKey: childSessionKey,
      requesterDisplayKey: "parent",
      task: "descendant",
      cleanup: "keep",
      createdAt: Date.now() - 3_000,
      startedAt: Date.now() - 2_000,
    });
    setSubagentControlDepsForTest({
      isEmbeddedAgentRunActive: () => true,
      abortEmbeddedAgentRun: () => true,
      patchSessionEntry: async (scope, patcher) => {
        const current = { sessionId: `sess-${scope.sessionKey}`, updatedAt: Date.now() };
        const patch = await patcher(current, { existingEntry: { ...current } });
        if (scope.sessionKey === childSessionKey) {
          abortedLastRunWrites.push(patch?.abortedLastRun === true);
        }
        if (scope.sessionKey === descendantSessionKey) {
          const endedAt = Date.now();
          Object.assign(run, {
            endedAt,
            endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
            outcome: { status: "ok" as const },
            completion: { required: false, resultText: "done", capturedAt: endedAt },
          });
        }
        return patch ? { ...current, ...patch } : current;
      },
    });

    const result = await killSubagentRunAdmin({
      cfg: cfgWithSessionStore(storePath),
      sessionKey: childSessionKey,
    });

    expect(result).toMatchObject({
      found: true,
      killed: true,
      targetState: {
        state: "terminal",
        task: {
          status: "succeeded",
          progressSummary: "done",
        },
      },
    });
    expect(abortedLastRunWrites).toEqual([true, false]);
  });

  it("kills a run that yields while the kill path awaits persistence", async () => {
    const childSessionKey = "agent:main:subagent:yield-race";
    const storePath = await writeSessionStoreFixture("admin-kill-yield-race", {
      [childSessionKey]: {
        sessionId: "sess-yield-race",
        updatedAt: Date.now(),
      },
    });
    const run = {
      runId: "run-yield-race",
      childSessionKey,
      controllerSessionKey: "agent:main:controller",
      requesterSessionKey: "agent:main:requester",
      requesterDisplayKey: "requester",
      task: "yield while cancellation starts",
      cleanup: "keep" as const,
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
    };
    const yieldedAt = Date.now() - 1_000;
    addSubagentRunForTests(run);
    setSubagentControlDepsForTest({
      isEmbeddedAgentRunActive: () => true,
      abortEmbeddedAgentRun: () => true,
      patchSessionEntry: async () => {
        Object.assign(run, {
          endedAt: yieldedAt,
          pauseReason: "sessions_yield" as const,
        });
        return null;
      },
    });

    const result = await killSubagentRunAdmin({
      cfg: cfgWithSessionStore(storePath),
      sessionKey: childSessionKey,
    });

    expect(result).toMatchObject({
      found: true,
      killed: true,
      runId: "run-yield-race",
      targetState: {
        state: "terminal",
        task: { status: "cancelled", error: SUBAGENT_KILL_TASK_ERROR },
      },
    });
    expect(getSubagentRunByChildSessionKey(childSessionKey)).toMatchObject({
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      endedAt: yieldedAt,
      outcome: {
        status: "error",
        endedAt: yieldedAt,
        elapsedMs: yieldedAt - run.startedAt,
      },
    });
    expect(getSubagentRunByChildSessionKey(childSessionKey)?.pauseReason).toBeUndefined();
    expect(detachedTaskRuntimeMocks.finalizeTaskRunByRunId).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-yield-race", status: "cancelled" }),
    );
    const [finalizeArgs] = detachedTaskRuntimeMocks.finalizeTaskRunByRunId.mock.calls[0] ?? [];
    const killedAt = (finalizeArgs as { endedAt?: number } | undefined)?.endedAt;
    expect(killedAt).toBeGreaterThan(yieldedAt);

    const repeated = await killSubagentRunAdmin({
      cfg: cfgWithSessionStore(storePath),
      sessionKey: childSessionKey,
    });
    expect(repeated).toMatchObject({
      found: true,
      killed: false,
      targetState: {
        state: "terminal",
        task: { status: "cancelled", endedAt: killedAt },
      },
    });
    const [repeatedFinalizeArgs] =
      detachedTaskRuntimeMocks.finalizeTaskRunByRunId.mock.calls.at(-1) ?? [];
    expect((repeatedFinalizeArgs as { endedAt?: number } | undefined)?.endedAt).toBe(killedAt);
  });

  it("does not mark a finalizing run killed when its abort is rejected", async () => {
    const childSessionKey = "agent:main:subagent:worker-finalizing";
    const storePath = await writeSessionStoreFixture("admin-kill-finalizing", {
      [childSessionKey]: {
        sessionId: "sess-worker-finalizing",
        updatedAt: Date.now(),
      },
    });
    await replaceSessionEntry(
      { sessionKey: childSessionKey, storePath },
      {
        sessionId: "sess-worker-finalizing",
        updatedAt: Date.now(),
      },
    );

    addSubagentRunForTests({
      runId: "run-worker-finalizing",
      childSessionKey,
      controllerSessionKey: "agent:main:other-controller",
      requesterSessionKey: "agent:main:other-requester",
      requesterDisplayKey: "other-requester",
      task: "finish the reply",
      cleanup: "keep",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
    });
    setSubagentControlDepsForTest({
      isEmbeddedAgentRunActive: () => true,
      abortEmbeddedAgentRun: () => false,
    });

    const result = await killSubagentRunAdmin({
      cfg: cfgWithSessionStore(storePath),
      sessionKey: childSessionKey,
    });

    expect(result.found).toBe(true);
    expect(result.killed).toBe(false);
    expect(getSubagentRunByChildSessionKey(childSessionKey)?.endedAt).toBeUndefined();
    const persisted = loadSessionEntry({ storePath, sessionKey: childSessionKey });
    expect(persisted?.abortedLastRun).toBeUndefined();
  });

  it("does not kill a newest finalizing run when only a stale older row is still active", async () => {
    const childSessionKey = "agent:main:subagent:worker-stale-admin";

    addSubagentRunForTests({
      runId: "run-stale-admin",
      childSessionKey,
      controllerSessionKey: "agent:main:other-controller",
      requesterSessionKey: "agent:main:other-requester",
      requesterDisplayKey: "other-requester",
      task: "stale admin task",
      cleanup: "keep",
      createdAt: Date.now() - 9_000,
      startedAt: Date.now() - 8_000,
    });
    addSubagentRunForTests({
      runId: "run-current-admin",
      childSessionKey,
      controllerSessionKey: "agent:main:other-controller",
      requesterSessionKey: "agent:main:other-requester",
      requesterDisplayKey: "other-requester",
      task: "current admin task",
      cleanup: "keep",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
      endedAt: Date.now() - 1_000,
      outcome: { status: "ok" },
    });

    const result = await killSubagentRunAdmin({
      cfg: cfgWithSessionStore(),
      sessionKey: childSessionKey,
    });

    expect(result.found).toBe(true);
    expect(result.killed).toBe(false);
    if (!result.found) {
      throw new Error("expected finalizing subagent run");
    }
    expect(result.targetState).toEqual({ state: "finalizing" });
    expect(result.runId).toBe("run-current-admin");
    expect(result.sessionKey).toBe(childSessionKey);
  });

  it("still terminates the run when session store persistence fails during kill", async () => {
    const childSessionKey = "agent:main:subagent:worker-store-fail";
    const storePath = await writeSessionStoreFixture("admin-kill-store-fail", {
      [childSessionKey]: {
        sessionId: "sess-worker-store-fail",
        updatedAt: Date.now(),
      },
    });

    addSubagentRunForTests({
      runId: "run-worker-store-fail",
      childSessionKey,
      controllerSessionKey: "agent:main:other-controller",
      requesterSessionKey: "agent:main:other-requester",
      requesterDisplayKey: "other-requester",
      task: "do the work",
      cleanup: "keep",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
    });

    setSubagentControlDepsForTest({
      patchSessionEntry: async () => {
        throw new Error("session store unavailable");
      },
    });

    const result = await killSubagentRunAdmin({
      cfg: cfgWithSessionStore(storePath),
      sessionKey: childSessionKey,
    });

    expect(result.found).toBe(true);
    expect(result.killed).toBe(true);
    if (!result.found) {
      throw new Error("expected tracked subagent run");
    }
    expect(result.runId).toBe("run-worker-store-fail");
    expect(result.sessionKey).toBe(childSessionKey);
    expect(getSubagentRunByChildSessionKey(childSessionKey)?.endedAt).toBeTypeOf("number");
  });
});

describe("killControlledSubagentRun", () => {
  afterEach(() => {
    resetSubagentRegistryForTests({ persist: false });
    testing.setDepsForTest();
  });

  it("does not mutate the live session when the caller passes a stale run entry", async () => {
    const childSessionKey = "agent:main:subagent:stale-kill-worker";
    const storePath = await writeSessionStoreFixture("stale-kill", {
      [childSessionKey]: {
        updatedAt: Date.now(),
      },
    });

    addSubagentRunForTests({
      runId: "run-current",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "current task",
      cleanup: "keep",
      createdAt: Date.now() - 4_000,
      startedAt: Date.now() - 3_000,
    });

    const result = await killControlledSubagentRun({
      cfg: cfgWithSessionStore(storePath),
      controller: {
        controllerSessionKey: "agent:main:main",
        callerSessionKey: "agent:main:main",
        callerIsSubagent: false,
        controlScope: "children",
      },
      entry: {
        runId: "run-stale",
        childSessionKey,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        controllerSessionKey: "agent:main:main",
        task: "stale task",
        cleanup: "keep",
        createdAt: Date.now() - 9_000,
        startedAt: Date.now() - 8_000,
      },
    });

    expect(result).toEqual({
      status: "done",
      runId: "run-stale",
      sessionKey: childSessionKey,
      label: "stale task",
      text: "stale task is already finished.",
    });
    const persisted = loadSessionEntry({ storePath, sessionKey: childSessionKey });
    expect(persisted?.abortedLastRun).toBeUndefined();
    expect(getSubagentRunByChildSessionKey(childSessionKey)?.runId).toBe("run-current");
  });

  it("kills a yielded descendant without reviving a stale child row", async () => {
    const parentSessionKey = "agent:main:subagent:kill-parent";
    const childSessionKey = `${parentSessionKey}:subagent:child`;
    const leafSessionKey = `${childSessionKey}:subagent:leaf`;

    addSubagentRunForTests({
      runId: "run-parent-current",
      childSessionKey: parentSessionKey,
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "current parent task",
      cleanup: "keep",
      createdAt: Date.now() - 8_000,
      startedAt: Date.now() - 7_000,
      endedAt: Date.now() - 6_000,
      outcome: { status: "ok" },
    });
    addSubagentRunForTests({
      runId: "run-child-stale",
      childSessionKey,
      controllerSessionKey: parentSessionKey,
      requesterSessionKey: parentSessionKey,
      requesterDisplayKey: parentSessionKey,
      task: "stale child task",
      cleanup: "keep",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
    });
    addSubagentRunForTests({
      runId: "run-child-current",
      childSessionKey,
      controllerSessionKey: parentSessionKey,
      requesterSessionKey: parentSessionKey,
      requesterDisplayKey: parentSessionKey,
      task: "current child task",
      cleanup: "keep",
      createdAt: Date.now() - 3_000,
      startedAt: Date.now() - 2_000,
      endedAt: Date.now() - 1_500,
      outcome: { status: "ok" },
    });
    addSubagentRunForTests({
      runId: "run-leaf-active",
      childSessionKey: leafSessionKey,
      controllerSessionKey: childSessionKey,
      requesterSessionKey: childSessionKey,
      requesterDisplayKey: childSessionKey,
      task: "leaf task",
      cleanup: "keep",
      createdAt: Date.now() - 1_000,
      startedAt: Date.now() - 900,
      endedAt: Date.now() - 800,
      pauseReason: "sessions_yield",
    });

    const result = await killControlledSubagentRun({
      cfg: cfgWithSessionStore(),
      controller: {
        controllerSessionKey: "agent:main:main",
        callerSessionKey: "agent:main:main",
        callerIsSubagent: false,
        controlScope: "children",
      },
      entry: {
        runId: "run-parent-current",
        childSessionKey: parentSessionKey,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        controllerSessionKey: "agent:main:main",
        task: "current parent task",
        cleanup: "keep",
        createdAt: Date.now() - 8_000,
        startedAt: Date.now() - 7_000,
        endedAt: Date.now() - 6_000,
        outcome: { status: "ok" },
      },
    });

    expect(result).toEqual({
      status: "ok",
      runId: "run-parent-current",
      sessionKey: parentSessionKey,
      label: "current parent task",
      cascadeKilled: 1,
      cascadeLabels: ["leaf task"],
      text: "killed 1 descendant of current parent task.",
    });
    expect(getSubagentRunByChildSessionKey(leafSessionKey)?.endedAt).toBeTypeOf("number");
  });

  it("does not cascade through a child session that moved to a newer parent", async () => {
    const oldParentSessionKey = "agent:main:subagent:old-parent";
    const newParentSessionKey = "agent:main:subagent:new-parent";
    const childSessionKey = "agent:main:subagent:shared-child";
    const leafSessionKey = `${childSessionKey}:subagent:leaf`;

    addSubagentRunForTests({
      runId: "run-old-parent-current",
      childSessionKey: oldParentSessionKey,
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "old parent task",
      cleanup: "keep",
      createdAt: Date.now() - 8_000,
      startedAt: Date.now() - 7_000,
      endedAt: Date.now() - 6_000,
      outcome: { status: "ok" },
    });
    addSubagentRunForTests({
      runId: "run-new-parent-current",
      childSessionKey: newParentSessionKey,
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "new parent task",
      cleanup: "keep",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
    });
    addSubagentRunForTests({
      runId: "run-child-stale-old-parent",
      childSessionKey,
      controllerSessionKey: oldParentSessionKey,
      requesterSessionKey: oldParentSessionKey,
      requesterDisplayKey: oldParentSessionKey,
      task: "stale shared child task",
      cleanup: "keep",
      createdAt: Date.now() - 4_000,
      startedAt: Date.now() - 3_500,
      endedAt: Date.now() - 3_000,
      outcome: { status: "ok" },
    });
    addSubagentRunForTests({
      runId: "run-child-current-new-parent",
      childSessionKey,
      controllerSessionKey: newParentSessionKey,
      requesterSessionKey: newParentSessionKey,
      requesterDisplayKey: newParentSessionKey,
      task: "current shared child task",
      cleanup: "keep",
      createdAt: Date.now() - 2_000,
      startedAt: Date.now() - 1_500,
    });
    addSubagentRunForTests({
      runId: "run-leaf-active",
      childSessionKey: leafSessionKey,
      controllerSessionKey: childSessionKey,
      requesterSessionKey: childSessionKey,
      requesterDisplayKey: childSessionKey,
      task: "leaf task",
      cleanup: "keep",
      createdAt: Date.now() - 1_000,
      startedAt: Date.now() - 900,
    });

    const result = await killControlledSubagentRun({
      cfg: cfgWithSessionStore(),
      controller: {
        controllerSessionKey: "agent:main:main",
        callerSessionKey: "agent:main:main",
        callerIsSubagent: false,
        controlScope: "children",
      },
      entry: {
        runId: "run-old-parent-current",
        childSessionKey: oldParentSessionKey,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        controllerSessionKey: "agent:main:main",
        task: "old parent task",
        cleanup: "keep",
        createdAt: Date.now() - 8_000,
        startedAt: Date.now() - 7_000,
        endedAt: Date.now() - 6_000,
        outcome: { status: "ok" },
      },
    });

    expect(result).toEqual({
      status: "done",
      runId: "run-old-parent-current",
      sessionKey: oldParentSessionKey,
      label: "old parent task",
      text: "old parent task is already finished.",
    });
    expect(getSubagentRunByChildSessionKey(leafSessionKey)?.endedAt).toBeUndefined();
  });
});

describe("killAllControlledSubagentRuns", () => {
  afterEach(() => {
    resetSubagentRegistryForTests({ persist: false });
    testing.setDepsForTest();
  });

  it("continues bulk cancellation after one registry persistence failure", async () => {
    let persistenceAttempts = 0;
    subagentRegistryTesting.setDepsForTest({
      cleanupBrowserSessionsForLifecycleEnd: async () => {},
      ensureContextEnginesInitialized: () => {},
      ensureRuntimePluginsLoaded: () => {},
      getSubagentRunsSnapshotForRead: (runs) => new Map(runs),
      persistSubagentRunsToDisk: () => {},
      persistSubagentRunsToDiskOrThrow: () => {
        persistenceAttempts += 1;
        if (persistenceAttempts === 1) {
          throw new Error("sqlite busy");
        }
      },
      restoreSubagentRunsFromDisk: () => 0,
      resolveContextEngine: async () => ({
        info: { id: "test", name: "Test" },
        assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
        compact: async () => ({ ok: true, compacted: false }),
        ingest: async () => ({ ingested: false }),
      }),
    });
    const first = {
      runId: "run-bulk-persistence-failure-first",
      childSessionKey: "agent:main:subagent:bulk-persistence-failure-first",
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "first bulk task",
      cleanup: "keep" as const,
      createdAt: Date.now() - 2_000,
      startedAt: Date.now() - 1_900,
    };
    const second = {
      ...first,
      runId: "run-bulk-persistence-failure-second",
      childSessionKey: "agent:main:subagent:bulk-persistence-failure-second",
      task: "second bulk task",
      createdAt: Date.now() - 1_000,
      startedAt: Date.now() - 900,
    };
    addSubagentRunForTests(first);
    addSubagentRunForTests(second);

    const result = await killAllControlledSubagentRuns({
      cfg: cfgWithSessionStore(),
      controller: {
        controllerSessionKey: "agent:main:main",
        callerSessionKey: "agent:main:main",
        callerIsSubagent: false,
        controlScope: "children",
      },
      runs: [first, second],
    });

    expect(result).toEqual({ status: "ok", killed: 1, labels: ["second bulk task"] });
    expect(persistenceAttempts).toBe(2);
    expect(getSubagentRunByChildSessionKey(first.childSessionKey)?.endedAt).toBeUndefined();
    expect(getSubagentRunByChildSessionKey(second.childSessionKey)?.endedAt).toBeTypeOf("number");
  });

  it("ignores stale run snapshots in bulk kill requests", async () => {
    const childSessionKey = "agent:main:subagent:stale-kill-all-worker";
    const storePath = await writeSessionStoreFixture("stale-kill-all", {
      [childSessionKey]: {
        updatedAt: Date.now(),
      },
    });

    addSubagentRunForTests({
      runId: "run-current-bulk",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "current bulk task",
      cleanup: "keep",
      createdAt: Date.now() - 4_000,
      startedAt: Date.now() - 3_000,
    });

    const result = await killAllControlledSubagentRuns({
      cfg: cfgWithSessionStore(storePath),
      controller: {
        controllerSessionKey: "agent:main:main",
        callerSessionKey: "agent:main:main",
        callerIsSubagent: false,
        controlScope: "children",
      },
      runs: [
        {
          runId: "run-stale-bulk",
          childSessionKey,
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          controllerSessionKey: "agent:main:main",
          task: "stale bulk task",
          cleanup: "keep",
          createdAt: Date.now() - 9_000,
          startedAt: Date.now() - 8_000,
        },
      ],
    });

    expect(result).toEqual({
      status: "ok",
      killed: 0,
      labels: [],
    });
    const persisted = loadSessionEntry({ storePath, sessionKey: childSessionKey });
    expect(persisted?.abortedLastRun).toBeUndefined();
    expect(getSubagentRunByChildSessionKey(childSessionKey)?.runId).toBe("run-current-bulk");
  });

  it("does not let a stale bulk entry suppress the current yielded entry", async () => {
    const childSessionKey = "agent:main:subagent:stale-kill-all-shadow-worker";
    const storePath = await writeSessionStoreFixture("stale-kill-all-shadow", {
      [childSessionKey]: {
        updatedAt: Date.now(),
      },
    });

    addSubagentRunForTests({
      runId: "run-current-shadow",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "current shadow task",
      cleanup: "keep",
      createdAt: Date.now() - 4_000,
      startedAt: Date.now() - 3_000,
      endedAt: Date.now() - 2_000,
      pauseReason: "sessions_yield",
    });

    const result = await killAllControlledSubagentRuns({
      cfg: cfgWithSessionStore(storePath),
      controller: {
        controllerSessionKey: "agent:main:main",
        callerSessionKey: "agent:main:main",
        callerIsSubagent: false,
        controlScope: "children",
      },
      runs: [
        {
          runId: "run-stale-shadow",
          childSessionKey,
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          controllerSessionKey: "agent:main:main",
          task: "stale shadow task",
          cleanup: "keep",
          createdAt: Date.now() - 9_000,
          startedAt: Date.now() - 8_000,
        },
        {
          runId: "run-current-shadow",
          childSessionKey,
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          controllerSessionKey: "agent:main:main",
          task: "current shadow task",
          cleanup: "keep",
          createdAt: Date.now() - 4_000,
          startedAt: Date.now() - 3_000,
          endedAt: Date.now() - 2_000,
          pauseReason: "sessions_yield",
        },
      ],
    });

    expect(result).toEqual({
      status: "ok",
      killed: 1,
      labels: ["current shadow task"],
    });
    expect(getSubagentRunByChildSessionKey(childSessionKey)?.endedAt).toBeTypeOf("number");
  });

  it("does not kill a newest finished bulk target when only a stale older row is still active", async () => {
    const childSessionKey = "agent:main:subagent:stale-bulk-finished-worker";

    addSubagentRunForTests({
      runId: "run-stale-bulk-finished",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "stale bulk finished task",
      cleanup: "keep",
      createdAt: Date.now() - 9_000,
      startedAt: Date.now() - 8_000,
    });
    addSubagentRunForTests({
      runId: "run-current-bulk-finished",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "current bulk finished task",
      cleanup: "keep",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
      endedAt: Date.now() - 1_000,
      outcome: { status: "ok" },
    });

    const result = await killAllControlledSubagentRuns({
      cfg: cfgWithSessionStore(),
      controller: {
        controllerSessionKey: "agent:main:main",
        callerSessionKey: "agent:main:main",
        callerIsSubagent: false,
        controlScope: "children",
      },
      runs: [
        {
          runId: "run-current-bulk-finished",
          childSessionKey,
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          controllerSessionKey: "agent:main:main",
          task: "current bulk finished task",
          cleanup: "keep",
          createdAt: Date.now() - 5_000,
          startedAt: Date.now() - 4_000,
          endedAt: Date.now() - 1_000,
          outcome: { status: "ok" },
        },
      ],
    });

    expect(result).toEqual({
      status: "ok",
      killed: 0,
      labels: [],
    });
  });

  it("cascades through descendants for an ended current bulk target even when a stale older row is still active", async () => {
    const parentSessionKey = "agent:main:subagent:stale-bulk-desc-parent";
    const childSessionKey = `${parentSessionKey}:subagent:leaf`;

    addSubagentRunForTests({
      runId: "run-stale-bulk-desc-parent",
      childSessionKey: parentSessionKey,
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "stale bulk parent task",
      cleanup: "keep",
      createdAt: Date.now() - 9_000,
      startedAt: Date.now() - 8_000,
    });
    addSubagentRunForTests({
      runId: "run-current-bulk-desc-parent",
      childSessionKey: parentSessionKey,
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "current bulk parent task",
      cleanup: "keep",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
      endedAt: Date.now() - 1_000,
      outcome: { status: "ok" },
    });
    addSubagentRunForTests({
      runId: "run-active-bulk-desc-child",
      childSessionKey,
      controllerSessionKey: parentSessionKey,
      requesterSessionKey: parentSessionKey,
      requesterDisplayKey: parentSessionKey,
      task: "active bulk child task",
      cleanup: "keep",
      createdAt: Date.now() - 3_000,
      startedAt: Date.now() - 2_000,
    });

    const result = await killAllControlledSubagentRuns({
      cfg: cfgWithSessionStore(),
      controller: {
        controllerSessionKey: "agent:main:main",
        callerSessionKey: "agent:main:main",
        callerIsSubagent: false,
        controlScope: "children",
      },
      runs: [
        {
          runId: "run-current-bulk-desc-parent",
          childSessionKey: parentSessionKey,
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          controllerSessionKey: "agent:main:main",
          task: "current bulk parent task",
          cleanup: "keep",
          createdAt: Date.now() - 5_000,
          startedAt: Date.now() - 4_000,
          endedAt: Date.now() - 1_000,
          outcome: { status: "ok" },
        },
      ],
    });

    expect(result).toEqual({
      status: "ok",
      killed: 1,
      labels: ["active bulk child task"],
    });
    expect(getSubagentRunByChildSessionKey(childSessionKey)?.endedAt).toBeTypeOf("number");
  });
});

describe("steerControlledSubagentRun", () => {
  afterEach(() => {
    resetSubagentRegistryForTests({ persist: false });
    testing.setDepsForTest();
  });

  it("returns an error and clears the restart marker when run remap fails", async () => {
    addSubagentRunForTests({
      runId: "run-steer-old",
      childSessionKey: "agent:main:subagent:steer-worker",
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "initial task",
      cleanup: "keep",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
    });

    const replaceSpy = vi
      .spyOn(await import("./subagent-registry.js"), "replaceSubagentRunAfterSteer")
      .mockReturnValue(false);

    setSubagentControlDepsForTest({
      callGateway: async <T = Record<string, unknown>>(request: CallGatewayOptions) => {
        if (request.method === "agent.wait") {
          return {} as T;
        }
        if (request.method === "agent") {
          return { runId: "run-steer-new" } as T;
        }
        throw new Error(`unexpected method: ${request.method}`);
      },
    });

    try {
      const result = await steerControlledSubagentRun({
        cfg: cfgWithSessionStore(),
        controller: {
          controllerSessionKey: "agent:main:main",
          callerSessionKey: "agent:main:main",
          callerIsSubagent: false,
          controlScope: "children",
        },
        entry: {
          runId: "run-steer-old",
          childSessionKey: "agent:main:subagent:steer-worker",
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          controllerSessionKey: "agent:main:main",
          task: "initial task",
          cleanup: "keep",
          createdAt: Date.now() - 5_000,
          startedAt: Date.now() - 4_000,
        },
        message: "updated direction",
      });

      expect(result).toEqual({
        status: "error",
        runId: "run-steer-new",
        sessionKey: "agent:main:subagent:steer-worker",
        sessionId: undefined,
        error: "failed to replace steered subagent run",
      });
      const storedRun = getSubagentRunByChildSessionKey("agent:main:subagent:steer-worker");
      expect(storedRun?.runId).toBe("run-steer-old");
      expect(storedRun?.suppressAnnounceReason).toBeUndefined();
    } finally {
      replaceSpy.mockRestore();
    }
  });

  it("does not replace a finalizing run when its abort is rejected", async () => {
    const childSessionKey = "agent:main:subagent:steer-finalizing";
    const storePath = await writeSessionStoreFixture("steer-finalizing", {
      [childSessionKey]: {
        sessionId: "sess-steer-finalizing",
        updatedAt: Date.now(),
      },
    });
    await replaceSessionEntry(
      { sessionKey: childSessionKey, storePath },
      {
        sessionId: "sess-steer-finalizing",
        updatedAt: Date.now(),
      },
    );
    addSubagentRunForTests({
      runId: "run-steer-finalizing",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "finish the reply",
      cleanup: "keep",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
    });
    const callGateway = vi.fn(async () => {
      throw new Error("gateway should not be called");
    });
    setSubagentControlDepsForTest({
      callGateway,
      isEmbeddedAgentRunActive: () => true,
      abortEmbeddedAgentRun: () => false,
    });

    const result = await steerControlledSubagentRun({
      cfg: cfgWithSessionStore(storePath),
      controller: {
        controllerSessionKey: "agent:main:main",
        callerSessionKey: "agent:main:main",
        callerIsSubagent: false,
        controlScope: "children",
      },
      entry: {
        runId: "run-steer-finalizing",
        childSessionKey,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        controllerSessionKey: "agent:main:main",
        task: "finish the reply",
        cleanup: "keep",
        createdAt: Date.now() - 5_000,
        startedAt: Date.now() - 4_000,
      },
      message: "new direction",
    });

    expect(result).toEqual({
      status: "error",
      runId: "run-steer-finalizing",
      sessionKey: childSessionKey,
      sessionId: "sess-steer-finalizing",
      error: "Subagent reply is already finalizing and can no longer be restarted.",
    });
    expect(callGateway).not.toHaveBeenCalled();
    const storedRun = getSubagentRunByChildSessionKey(childSessionKey);
    expect(storedRun?.runId).toBe("run-steer-finalizing");
    expect(storedRun?.endedAt).toBeUndefined();
    expect(storedRun?.suppressAnnounceReason).toBeUndefined();
  });

  it("rejects steering runs that are no longer tracked in the registry", async () => {
    setSubagentControlDepsForTest({
      callGateway: async () => {
        throw new Error("gateway should not be called");
      },
    });

    const result = await steerControlledSubagentRun({
      cfg: cfgWithSessionStore(),
      controller: {
        controllerSessionKey: "agent:main:main",
        callerSessionKey: "agent:main:main",
        callerIsSubagent: false,
        controlScope: "children",
      },
      entry: {
        runId: "run-stale",
        childSessionKey: "agent:main:subagent:stale-worker",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        controllerSessionKey: "agent:main:main",
        task: "stale task",
        cleanup: "keep",
        createdAt: Date.now() - 5_000,
        startedAt: Date.now() - 4_000,
      },
      message: "updated direction",
    });

    expect(result).toEqual({
      status: "done",
      runId: "run-stale",
      sessionKey: "agent:main:subagent:stale-worker",
      text: "stale task is already finished.",
    });
  });

  it("steers an ended current run that is still waiting on active descendants even when stale older rows exist", async () => {
    const childSessionKey = "agent:main:subagent:stale-steer-worker";
    addSubagentRunForTests({
      runId: "run-stale-active-steer",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "stale active steer task",
      cleanup: "keep",
      createdAt: Date.now() - 9_000,
      startedAt: Date.now() - 8_000,
    });
    addSubagentRunForTests({
      runId: "run-current-ended-steer",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "current ended steer task",
      cleanup: "keep",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
      endedAt: Date.now() - 1_000,
      outcome: { status: "ok" },
    });
    addSubagentRunForTests({
      runId: "run-descendant-active-steer",
      childSessionKey: `${childSessionKey}:subagent:leaf`,
      controllerSessionKey: childSessionKey,
      requesterSessionKey: childSessionKey,
      requesterDisplayKey: childSessionKey,
      task: "leaf task",
      cleanup: "keep",
      createdAt: Date.now() - 500,
      startedAt: Date.now() - 500,
    });

    setSubagentControlDepsForTest({
      callGateway: async <T = Record<string, unknown>>(request: CallGatewayOptions) => {
        if (request.method === "agent.wait") {
          return {} as T;
        }
        if (request.method === "agent") {
          return { runId: "run-followup-steer" } as T;
        }
        throw new Error(`unexpected method: ${request.method}`);
      },
    });

    const result = await steerControlledSubagentRun({
      cfg: cfgWithSessionStore(),
      controller: {
        controllerSessionKey: "agent:main:main",
        callerSessionKey: "agent:main:main",
        callerIsSubagent: false,
        controlScope: "children",
      },
      entry: {
        runId: "run-current-ended-steer",
        childSessionKey,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        controllerSessionKey: "agent:main:main",
        task: "current ended steer task",
        cleanup: "keep",
        createdAt: Date.now() - 5_000,
        startedAt: Date.now() - 4_000,
        endedAt: Date.now() - 1_000,
        outcome: { status: "ok" },
      },
      message: "updated direction",
    });

    expect(result).toEqual({
      status: "accepted",
      runId: "run-followup-steer",
      sessionKey: childSessionKey,
      sessionId: undefined,
      mode: "restart",
      label: "current ended steer task",
      text: "steered current ended steer task.",
    });
  });

  it("steers a yielded run even though the paused attempt has ended", async () => {
    const childSessionKey = "agent:main:subagent:yield-steer-worker";
    addSubagentRunForTests({
      runId: "run-yielded-steer",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "yielded steer task",
      cleanup: "keep",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
      endedAt: Date.now() - 1_000,
      pauseReason: "sessions_yield",
    });

    setSubagentControlDepsForTest({
      callGateway: async <T = Record<string, unknown>>(request: CallGatewayOptions) => {
        if (request.method === "agent.wait") {
          return {} as T;
        }
        if (request.method === "agent") {
          return { runId: "run-yielded-followup" } as T;
        }
        throw new Error(`unexpected method: ${request.method}`);
      },
    });

    const result = await steerControlledSubagentRun({
      cfg: cfgWithSessionStore(),
      controller: {
        controllerSessionKey: "agent:main:main",
        callerSessionKey: "agent:main:main",
        callerIsSubagent: false,
        controlScope: "children",
      },
      entry: {
        runId: "run-yielded-steer",
        childSessionKey,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        controllerSessionKey: "agent:main:main",
        task: "yielded steer task",
        cleanup: "keep",
        createdAt: Date.now() - 5_000,
        startedAt: Date.now() - 4_000,
        endedAt: Date.now() - 1_000,
        pauseReason: "sessions_yield",
      },
      message: "continue now",
    });

    expect(result).toEqual({
      status: "accepted",
      runId: "run-yielded-followup",
      sessionKey: childSessionKey,
      sessionId: undefined,
      mode: "restart",
      label: "yielded steer task",
      text: "steered yielded steer task.",
    });
  });

  it("rotates the child session when restarting a previously active session", async () => {
    const childSessionKey = "agent:main:subagent:active-steer-worker";
    const storePath = await writeSessionStoreFixture("steer-restart-session", {
      [childSessionKey]: {
        sessionId: "old-child-session",
        updatedAt: Date.now(),
      },
    });
    await replaceSessionEntry(
      { sessionKey: childSessionKey, storePath },
      {
        sessionId: "old-child-session",
        updatedAt: Date.now(),
      },
    );
    const agentCalls: CallGatewayOptions[] = [];
    addSubagentRunForTests({
      runId: "run-active-steer",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "active steer task",
      cleanup: "keep",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
    });

    setSubagentControlDepsForTest({
      callGateway: async <T = Record<string, unknown>>(request: CallGatewayOptions) => {
        if (request.method === "agent.wait") {
          return {} as T;
        }
        if (request.method === "agent") {
          agentCalls.push(request);
          return { runId: "run-active-steer-restarted" } as T;
        }
        throw new Error(`unexpected method: ${request.method}`);
      },
    });

    const result = await steerControlledSubagentRun({
      cfg: cfgWithSessionStore(storePath),
      controller: {
        controllerSessionKey: "agent:main:main",
        callerSessionKey: "agent:main:main",
        callerIsSubagent: false,
        controlScope: "children",
      },
      entry: {
        runId: "run-active-steer",
        childSessionKey,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        controllerSessionKey: "agent:main:main",
        task: "active steer task",
        cleanup: "keep",
        createdAt: Date.now() - 5_000,
        startedAt: Date.now() - 4_000,
      },
      message: "updated direction",
    });

    expect(result.status).toBe("accepted");
    expect(result.sessionId).toBeTypeOf("string");
    expect(result.sessionId).not.toBe("old-child-session");
    const agentParams = agentCalls[0]?.params as { sessionId?: string } | undefined;
    expect(agentParams?.sessionId).toBe(result.sessionId);
  });
});

describe("listControlledSubagentRuns", () => {
  beforeEach(() => {
    resetSubagentRegistryForTests({ persist: false });
  });

  it.each([
    {
      name: "control owner",
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:telegram:direct:abc123",
      expectedCount: 1,
    },
    {
      name: "completion owner",
      controllerSessionKey: "agent:main:telegram:direct:abc123",
      requesterSessionKey: "agent:main:main",
      expectedCount: 1,
    },
    {
      name: "unrelated session",
      controllerSessionKey: "agent:other:discord:direct:xyz",
      requesterSessionKey: "agent:other:main",
      expectedCount: 0,
    },
  ])(
    "applies read visibility for the $name",
    ({ controllerSessionKey, requesterSessionKey, expectedCount }) => {
      const childSessionKey = "agent:main:subagent:list-visibility";
      addSubagentRunForTests({
        runId: "run-list-visibility",
        childSessionKey,
        controllerSessionKey,
        requesterSessionKey,
        requesterDisplayKey: requesterSessionKey,
        task: "visibility test",
        cleanup: "keep",
        createdAt: Date.now(),
        startedAt: Date.now(),
      });

      const results = listControlledSubagentRuns("agent:main:main");
      expect(results).toHaveLength(expectedCount);
      if (expectedCount === 1) {
        expect(results[0]?.childSessionKey).toBe(childSessionKey);
      }
    },
  );
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
