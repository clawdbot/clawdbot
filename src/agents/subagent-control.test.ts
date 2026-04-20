import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CallGatewayOptions } from "../gateway/call.js";
import {
  __testing,
  killAllControlledSubagentRuns,
  killControlledSubagentRun,
  killSubagentRunAdmin,
  sendControlledSubagentMessage,
  steerControlledSubagentRun,
} from "./subagent-control.js";
import {
  __testing as subagentRegistryTesting,
  addSubagentRunForTests,
  getSubagentRunByChildSessionKey,
  resetSubagentRegistryForTests,
} from "./subagent-registry.js";

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(),
}));

vi.mock("./run-wait.js", () => {
  const readLatestAssistantReplySnapshot = async (params: {
    sessionKey: string;
    limit?: number;
    callGateway?: (request: CallGatewayOptions) => Promise<{ messages?: unknown[] }>;
  }) => {
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
      const text = Array.isArray(content)
        ? content
            .map((block) =>
              block &&
              typeof block === "object" &&
              typeof (block as { text?: unknown }).text === "string"
                ? (block as { text: string }).text
                : "",
            )
            .filter(Boolean)
            .join("\n")
        : typeof content === "string"
          ? content
          : "";
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
  overrides: Parameters<typeof __testing.setDepsForTest>[0] = {},
) {
  __testing.setDepsForTest({
    abortEmbeddedPiRun: () => false,
    clearSessionQueues: () => ({ followupCleared: 0, laneCleared: 0, keys: [] }),
    updateSessionStore: async <T>(
      storePath: string,
      mutator: (store: Record<string, SessionEntry>) => Promise<T> | T,
    ) => {
      const store = JSON.parse(fs.readFileSync(storePath, "utf-8")) as Record<string, SessionEntry>;
      const result = await mutator(store);
      fs.writeFileSync(storePath, JSON.stringify(store, null, 2), "utf-8");
      return result;
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

function writeSessionStoreFixture(label: string, store: Record<string, unknown>) {
  const storePath = nextSessionStorePath(label);
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2), "utf-8");
  return storePath;
}

beforeEach(() => {
  setSubagentControlDepsForTest();
  subagentRegistryTesting.setDepsForTest({
    cleanupBrowserSessionsForLifecycleEnd: async () => {},
    ensureContextEnginesInitialized: () => {},
    ensureRuntimePluginsLoaded: () => {},
    getSubagentRunsSnapshotForRead: (runs) => new Map(runs),
    persistSubagentRunsToDisk: () => {},
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
    __testing.setDepsForTest();
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

    expect(result).toEqual({
      status: "error",
      runId: expect.any(String),
      error: "gateway unavailable",
    });
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
    __testing.setDepsForTest();
  });

  it("kills a subagent by session key without requester ownership checks", async () => {
    const childSessionKey = "agent:main:subagent:worker";
    const storePath = writeSessionStoreFixture("admin-kill", {
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

    expect(result).toMatchObject({
      found: true,
      killed: true,
      runId: "run-worker",
      sessionKey: childSessionKey,
    });
    expect(getSubagentRunByChildSessionKey(childSessionKey)?.endedAt).toBeTypeOf("number");
  });

  it("returns found=false when the session key is not tracked as a subagent run", async () => {
    const result = await killSubagentRunAdmin({
      cfg: cfgWithSessionStore(),
      sessionKey: "agent:main:subagent:missing",
    });

    expect(result).toEqual({ found: false, killed: false });
  });

  it("does not kill a newest finished run when only a stale older row is still active", async () => {
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

    expect(result).toMatchObject({
      found: true,
      killed: false,
      runId: "run-current-admin",
      sessionKey: childSessionKey,
    });
  });

  it("still terminates the run when session store persistence fails during kill", async () => {
    const childSessionKey = "agent:main:subagent:worker-store-fail";
    const storePath = writeSessionStoreFixture("admin-kill-store-fail", {
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
      updateSessionStore: async () => {
        throw new Error("session store unavailable");
      },
    });

    const result = await killSubagentRunAdmin({
      cfg: cfgWithSessionStore(storePath),
      sessionKey: childSessionKey,
    });

    expect(result).toMatchObject({
      found: true,
      killed: true,
      runId: "run-worker-store-fail",
      sessionKey: childSessionKey,
    });
    expect(getSubagentRunByChildSessionKey(childSessionKey)?.endedAt).toBeTypeOf("number");
  });
});

describe("killControlledSubagentRun", () => {
  afterEach(() => {
    resetSubagentRegistryForTests({ persist: false });
    __testing.setDepsForTest();
  });

  it("does not mutate the live session when the caller passes a stale run entry", async () => {
    const childSessionKey = "agent:main:subagent:stale-kill-worker";
    const storePath = writeSessionStoreFixture("stale-kill", {
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
    const persisted = JSON.parse(fs.readFileSync(storePath, "utf-8")) as Record<
      string,
      { abortedLastRun?: boolean }
    >;
    expect(persisted[childSessionKey]?.abortedLastRun).toBeUndefined();
    expect(getSubagentRunByChildSessionKey(childSessionKey)?.runId).toBe("run-current");
  });

  it("does not kill a stale child row while cascading descendants from an ended current parent", async () => {
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
    __testing.setDepsForTest();
  });

  it("ignores stale run snapshots in bulk kill requests", async () => {
    const childSessionKey = "agent:main:subagent:stale-kill-all-worker";
    const storePath = writeSessionStoreFixture("stale-kill-all", {
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
    const persisted = JSON.parse(fs.readFileSync(storePath, "utf-8")) as Record<
      string,
      { abortedLastRun?: boolean }
    >;
    expect(persisted[childSessionKey]?.abortedLastRun).toBeUndefined();
    expect(getSubagentRunByChildSessionKey(childSessionKey)?.runId).toBe("run-current-bulk");
  });

  it("does not let a stale bulk entry suppress the current live entry for the same child key", async () => {
    const childSessionKey = "agent:main:subagent:stale-kill-all-shadow-worker";
    const storePath = writeSessionStoreFixture("stale-kill-all-shadow", {
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
    __testing.setDepsForTest();
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
      expect(getSubagentRunByChildSessionKey("agent:main:subagent:steer-worker")).toMatchObject({
        runId: "run-steer-old",
        suppressAnnounceReason: undefined,
      });
    } finally {
      replaceSpy.mockRestore();
    }
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
});
