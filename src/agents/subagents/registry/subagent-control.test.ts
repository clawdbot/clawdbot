// Subagent control tests cover sending, steering, killing, and admin cleanup of
// child runs recorded in the subagent registry and session store.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { CallGatewayOptions } from "../../../gateway/call.js";
import { callGateway as callGatewayMock } from "../../../gateway/call.js";
import type { GatewayRecoveryRuntime } from "../../../gateway/server-instance-runtime.types.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/shared-types.js";
import { registerGatewayRecoveryRuntime } from "../../../gateway/server-recovery-runtime-context.js";
import { rotateAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import {
  bindGatewayContextResolver,
  getGatewayContextResolver,
} from "../../../plugins/runtime/gateway-request-scope.js";
import {
  beginSessionWorkAdmission,
  consumeSessionWorkAdmissionHandoff,
  getActiveSessionLifecycleMutationCount,
  SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
} from "../../../sessions/session-lifecycle-admission.js";
import { SUBAGENT_KILL_TASK_ERROR } from "../../../tasks/detached-task-runtime-contract.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import {
  buildControlledSubagentRunsReadContext,
  killAllControlledSubagentRuns,
  killControlledSubagentRun,
  killSubagentRunAdmin,
  listControlledSubagentRuns,
  sendControlledSubagentMessage,
  steerControlledSubagentRun,
} from "./subagent-control.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_KILLED,
} from "./subagent-lifecycle-events.js";
import { activateSubagentRegistry, replaceSubagentRunAfterSteerCore } from "./subagent-registry.js";
import {
  testing as subagentRegistryTesting,
  addSubagentRunForTests,
  getSubagentRunByChildSessionKey,
  resetSubagentRegistryForTests,
} from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type GatewayCaller = typeof import("../../../gateway/call.js").callGateway;
type ControlRuntime = typeof import("./subagent-control.runtime.js");
type ControlTestDeps = ControlRuntime & {
  callGateway: GatewayCaller;
};

const controlRuntimeMocks = vi.hoisted(() => ({
  abortEmbeddedAgentRun: vi.fn<ControlRuntime["abortEmbeddedAgentRun"]>(() => false),
  isEmbeddedAgentRunActive: vi.fn<ControlRuntime["isEmbeddedAgentRunActive"]>(() => false),
  clearSessionQueues: vi.fn<ControlRuntime["clearSessionQueues"]>(() => ({
    followupCleared: 0,
    laneCleared: 0,
    keys: [],
  })),
}));

vi.mock("./subagent-control.runtime.js", () => controlRuntimeMocks);

vi.mock("../../../config/sessions/session-accessor.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../config/sessions/session-accessor.js")>();
  return { ...actual, patchSessionEntryCore: vi.fn(actual.patchSessionEntryCore) };
});

const { patchSessionEntryCore: patchCanonicalSessionEntry } = await vi.importActual<
  typeof import("../../../config/sessions/session-accessor.js")
>("../../../config/sessions/session-accessor.js");

vi.mock("../../../gateway/call.js", () => ({
  callGateway: vi.fn(),
}));

const detachedTaskRuntimeMocks = vi.hoisted(() => ({
  findDetachedTaskRun: vi.fn(() => ({ lookup: "available" as const })),
  finalizeTaskRunByRunId: vi.fn<(_params: unknown) => unknown[]>(() => []),
}));

vi.mock("../../../tasks/detached-task-runtime.js", () => ({
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

vi.mock("../../run-wait.js", () => {
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

function setSubagentControlDepsForTest(overrides: Partial<ControlTestDeps> = {}) {
  controlRuntimeMocks.abortEmbeddedAgentRun.mockReset();
  controlRuntimeMocks.isEmbeddedAgentRunActive.mockReset();
  controlRuntimeMocks.clearSessionQueues.mockReset();
  vi.mocked(callGatewayMock).mockReset();
  // Default to the canonical store; individual race tests replace only their fault boundary.
  vi.mocked(patchSessionEntryCore).mockReset();
  if (overrides.abortEmbeddedAgentRun) {
    controlRuntimeMocks.abortEmbeddedAgentRun.mockImplementation(overrides.abortEmbeddedAgentRun);
  }
  if (overrides.isEmbeddedAgentRunActive) {
    controlRuntimeMocks.isEmbeddedAgentRunActive.mockImplementation(
      overrides.isEmbeddedAgentRunActive,
    );
  }
  if (overrides.clearSessionQueues) {
    controlRuntimeMocks.clearSessionQueues.mockImplementation(overrides.clearSessionQueues);
  }
  if (overrides.callGateway) {
    vi.mocked(callGatewayMock).mockImplementation(overrides.callGateway);
  }
}

function mockSessionPatchForStore(storePath: string, implementation: typeof patchSessionEntryCore) {
  // Registry timing writes use a different store; a fault must not fabricate entries there.
  vi.mocked(patchSessionEntryCore).mockImplementation((scope, patcher, options) =>
    scope.storePath === storePath
      ? implementation(scope, patcher, options)
      : patchCanonicalSessionEntry(scope, patcher, options),
  );
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
    loadAgentRuntimePluginRegistryHandle: () => undefined,
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
  });

  it("rejects follow-up messages for collector runs", async () => {
    const result = await sendControlledSubagentMessage({
      cfg: {} as OpenClawConfig,
      controller: {
        controllerSessionKey: "agent:main:main",
        callerSessionKey: "agent:main:main",
        callerIsSubagent: false,
        controlScope: "children",
      },
      entry: createSubagentRunRecord({
        runId: "run-collector",
        childSessionKey: "agent:worker:subagent:collector",
        controllerSessionKey: "agent:main:main",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "collect",
        cleanup: "keep",
        collect: true,
        createdAt: Date.now(),
      }),
      message: "change direction",
    });

    expect(result).toEqual({
      status: "forbidden",
      error: "Collector subagents cannot receive follow-up messages; use agents_wait.",
    });
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
      entry: createSubagentRunRecord({
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
      }),
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
      entry: createSubagentRunRecord({
        runId: "run-owned",
        childSessionKey: "agent:main:subagent:owned",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        controllerSessionKey: "agent:main:main",
        task: "continue work",
        cleanup: "keep",
        createdAt: Date.now() - 5_000,
        startedAt: Date.now() - 4_000,
      }),
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
      entry: createSubagentRunRecord({
        runId: "run-stale-send",
        childSessionKey: "agent:main:subagent:send-worker",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        controllerSessionKey: "agent:main:main",
        task: "stale task",
        cleanup: "keep",
        createdAt: Date.now() - 9_000,
        startedAt: Date.now() - 8_000,
      }),
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
      entry: createSubagentRunRecord({
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
      }),
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
      entry: createSubagentRunRecord({
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
      }),
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
      entry: createSubagentRunRecord({
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
      }),
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
    expect(loadSessionEntry({ storePath, sessionKey: childSessionKey })?.abortedLastRun).toBe(true);
    expect(getSubagentRunByChildSessionKey(childSessionKey)?.execution.endedAt).toBeTypeOf(
      "number",
    );
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

  it("does not kill a replacement run when an exact run id is required", async () => {
    const childSessionKey = "agent:main:subagent:replacement";
    addSubagentRunForTests({
      runId: "run-current",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "replacement work",
      cleanup: "keep",
      createdAt: Date.now() - 1_000,
      startedAt: Date.now() - 900,
    });

    const result = await killSubagentRunAdmin({
      cfg: cfgWithSessionStore(),
      sessionKey: childSessionKey,
      expectedRunId: "run-stale",
    });

    expect(result).toEqual({ found: false, killed: false });
    expect(getSubagentRunByChildSessionKey(childSessionKey)?.execution.endedAt).toBeUndefined();
  });

  it("does not kill a same-id replacement generation", async () => {
    const childSessionKey = "agent:main:subagent:same-id-replacement";
    addSubagentRunForTests({
      runId: "run-reused",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "replacement work",
      cleanup: "keep",
      generation: 2,
      createdAt: Date.now() - 1_000,
      startedAt: Date.now() - 900,
    });

    const result = await killSubagentRunAdmin({
      cfg: cfgWithSessionStore(),
      sessionKey: childSessionKey,
      expectedRunId: "run-reused",
      expectedGeneration: 1,
      expectedOwnerKey: "agent:main:main",
    });
    const foreignOwner = await killSubagentRunAdmin({
      cfg: cfgWithSessionStore(),
      sessionKey: childSessionKey,
      expectedRunId: "run-reused",
      expectedGeneration: 2,
      expectedOwnerKey: "agent:main:other",
    });

    expect(result).toEqual({ found: false, killed: false });
    expect(foreignOwner).toEqual({ found: false, killed: false });
    expect(getSubagentRunByChildSessionKey(childSessionKey)?.execution.endedAt).toBeUndefined();
  });

  it("does not adopt a restart-recovery successor when an exact run id is required", async () => {
    const childSessionKey = "agent:main:subagent:fenced-recovery-successor";
    const sessionId = "sess-fenced-recovery-successor";
    const recoveryRunId = "run-fenced-recovery-successor";
    const receipt = {
      sessionId,
      sessionMarker: `${sessionId}:1`,
      idempotencyKey: recoveryRunId,
      phase: "accepted" as const,
    };
    const source = createSubagentRunRecord({
      runId: "run-fenced-recovery-source",
      childSessionKey,
      controllerSessionKey: "agent:main:controller",
      requesterSessionKey: "agent:main:requester",
      requesterDisplayKey: "requester",
      task: "source recovery task",
      cleanup: "keep",
      generation: 1,
      createdAt: Date.now() - 2_000,
      execution: {
        status: "interrupted",
        startedAt: Date.now() - 1_000,
        restartRecovery: receipt,
      },
    });
    addSubagentRunForTests(source);
    const storePath = await writeSessionStoreFixture("fenced-recovery-successor", {
      [childSessionKey]: { sessionId, updatedAt: Date.now(), abortedLastRun: true },
    });
    const admission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [childSessionKey, sessionId],
      assertAllowed: () => {},
    });
    const handoffId = admission.createHandoff();
    const abort = vi.fn(() => true);
    setSubagentControlDepsForTest({
      isEmbeddedAgentRunActive: () => true,
      abortEmbeddedAgentRun: abort,
      clearSessionQueues: () => ({ followupCleared: 0, laneCleared: 0, keys: [] }),
    });

    const pendingKill = killSubagentRunAdmin({
      cfg: cfgWithSessionStore(storePath),
      sessionKey: childSessionKey,
      expectedRunId: source.runId,
    });
    await vi.waitFor(() => expect(getActiveSessionLifecycleMutationCount()).toBeGreaterThan(0));
    const adopted = consumeSessionWorkAdmissionHandoff({
      handoffId,
      scope: storePath,
      identities: [childSessionKey, sessionId],
      onInterrupt: () => undefined,
    });
    expect(
      replaceSubagentRunAfterSteerCore({
        previousRunId: source.runId,
        nextRunId: recoveryRunId,
        expected: source,
        restartRecovery: receipt,
        persistenceFailure: "return-false",
      }),
    ).toBe(true);
    expect(adopted).toBeDefined();
    adopted?.release();

    await expect(pendingKill).resolves.toMatchObject({
      found: true,
      killed: false,
      runId: source.runId,
    });
    expect(getSubagentRunByChildSessionKey(childSessionKey)).toMatchObject({
      runId: recoveryRunId,
      execution: { status: "running" },
    });
    expect(getSubagentRunByChildSessionKey(childSessionKey)?.execution.endedAt).toBeUndefined();
    expect(abort).not.toHaveBeenCalled();
  });

  it("does not adopt a same-id successor when an exact run id is required", async () => {
    const childSessionKey = "agent:main:subagent:fenced-same-id-successor";
    const runId = "run-fenced-same-id-successor";
    const source = createSubagentRunRecord({
      runId,
      childSessionKey,
      controllerSessionKey: "agent:main:controller",
      requesterSessionKey: "agent:main:requester",
      requesterDisplayKey: "requester",
      task: "same-id recovery source",
      cleanup: "keep",
      generation: 1,
      createdAt: Date.now() - 2_000,
      execution: {
        status: "interrupted",
        startedAt: Date.now() - 1_000,
        restartRecovery: {
          sessionId: "sess-fenced-same-id-successor",
          sessionMarker: "sess-fenced-same-id-successor:1",
          idempotencyKey: runId,
          phase: "accepted",
        },
      },
    });
    addSubagentRunForTests(source);
    const abort = vi.fn(() => false);
    setSubagentControlDepsForTest({
      isEmbeddedAgentRunActive: () => false,
      abortEmbeddedAgentRun: abort,
      clearSessionQueues: () => ({ followupCleared: 0, laneCleared: 0, keys: [] }),
    });

    const pendingKill = killSubagentRunAdmin({
      cfg: cfgWithSessionStore(),
      sessionKey: childSessionKey,
      expectedRunId: runId,
    });
    addSubagentRunForTests({
      ...source,
      task: "same-id recovery successor",
      generation: 2,
      createdAt: Date.now(),
      execution: { status: "running", startedAt: Date.now() },
    });

    await expect(pendingKill).resolves.toMatchObject({
      found: true,
      killed: false,
      runId,
    });
    expect(getSubagentRunByChildSessionKey(childSessionKey)).toMatchObject({
      runId,
      generation: 2,
      execution: { status: "running" },
    });
    expect(getSubagentRunByChildSessionKey(childSessionKey)?.execution.endedAt).toBeUndefined();
    expect(abort).not.toHaveBeenCalled();
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
    const run = createSubagentRunRecord({
      runId: "run-abort-lifecycle-race",
      childSessionKey,
      controllerSessionKey: "agent:main:controller",
      requesterSessionKey: "agent:main:requester",
      requesterDisplayKey: "requester",
      task: "finish while aborting",
      cleanup: "keep",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
    });
    const abortedLastRunWrites: boolean[] = [];
    addSubagentRunForTests(run);
    setSubagentControlDepsForTest({
      isEmbeddedAgentRunActive: () => true,
      abortEmbeddedAgentRun: () => {
        const endedAt = Date.now();
        Object.assign(run, {
          endedReason: SUBAGENT_ENDED_REASON_KILLED,
          suppressAnnounceReason: "killed" as const,
          killReconciliation: { killedAt: endedAt },
        });
        Object.assign(run.execution, {
          status: "terminal" as const,
          endedAt,
          outcome: { status: "error" as const, error: "agent run aborted" },
        });
        return true;
      },
    });
    mockSessionPatchForStore(storePath, async (_scope, patcher) => {
      const current = { sessionId: "sess-abort-lifecycle-race", updatedAt: Date.now() };
      const patch = await patcher(current, { existingEntry: { ...current } });
      abortedLastRunWrites.push(patch?.abortedLastRun === true);
      return patch ? { ...current, ...patch } : current;
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
    expect(abortedLastRunWrites).toEqual([]);
  });

  it("reports when completion wins while the kill path awaits persistence", async () => {
    const childSessionKey = "agent:main:subagent:completion-race";
    const storePath = await writeSessionStoreFixture("admin-kill-completion-race", {
      [childSessionKey]: {
        sessionId: "sess-completion-race",
        updatedAt: Date.now(),
      },
    });
    const run = createSubagentRunRecord({
      runId: "run-completion-race",
      childSessionKey,
      controllerSessionKey: "agent:main:controller",
      requesterSessionKey: "agent:main:requester",
      requesterDisplayKey: "requester",
      task: "finish while cancellation starts",
      cleanup: "keep",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
    });
    const abortedLastRunWrites: boolean[] = [];
    addSubagentRunForTests({
      ...run,
      runId: "run-stale-completion-race",
      task: "stale older row",
      createdAt: Date.now() - 9_000,
      execution: { status: "running", startedAt: Date.now() - 8_000 },
    });
    addSubagentRunForTests(run);
    setSubagentControlDepsForTest({
      isEmbeddedAgentRunActive: () => true,
      abortEmbeddedAgentRun: () => {
        const endedAt = Date.now();
        Object.assign(run, {
          endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
          completion: { required: false, resultText: "done", capturedAt: endedAt },
        });
        Object.assign(run.execution, {
          status: "terminal" as const,
          endedAt,
          outcome: { status: "ok" as const },
        });
        return true;
      },
    });
    mockSessionPatchForStore(storePath, async (_scope, patcher) => {
      const current = { sessionId: "sess-completion-race", updatedAt: Date.now() };
      const patch = await patcher(current, { existingEntry: { ...current } });
      abortedLastRunWrites.push(patch?.abortedLastRun === true);
      return patch ? { ...current, ...patch } : current;
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
    expect(abortedLastRunWrites).toEqual([]);
    expect(run).toMatchObject({
      endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
      execution: { outcome: { status: "ok" } },
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
    const run = createSubagentRunRecord({
      runId: "run-cascade-completion-race",
      childSessionKey,
      controllerSessionKey: "agent:main:controller",
      requesterSessionKey: "agent:main:requester",
      requesterDisplayKey: "requester",
      task: "finish while descendant cancellation settles",
      cleanup: "keep",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
    });
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
    });
    mockSessionPatchForStore(storePath, async (scope, patcher) => {
      if (!scope.storePath) {
        return null;
      }
      const current = loadSessionEntry({
        storePath: scope.storePath,
        sessionKey: scope.sessionKey,
        clone: false,
      });
      if (!current) {
        return null;
      }
      const patch = await patcher(current, { existingEntry: { ...current } });
      if (scope.sessionKey === childSessionKey) {
        abortedLastRunWrites.push(patch?.abortedLastRun === true);
      }
      if (scope.sessionKey === descendantSessionKey) {
        const endedAt = Date.now();
        Object.assign(run, {
          endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
          completion: { required: false, resultText: "done", capturedAt: endedAt },
        });
        Object.assign(run.execution, {
          status: "terminal" as const,
          endedAt,
          outcome: { status: "ok" as const },
        });
      }
      return patch ? { ...current, ...patch } : current;
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
    const run = createSubagentRunRecord({
      runId: "run-yield-race",
      childSessionKey,
      controllerSessionKey: "agent:main:controller",
      requesterSessionKey: "agent:main:requester",
      requesterDisplayKey: "requester",
      task: "yield while cancellation starts",
      cleanup: "keep",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
    });
    const yieldedAt = Date.now() - 1_000;
    addSubagentRunForTests(run);
    setSubagentControlDepsForTest({
      isEmbeddedAgentRunActive: () => true,
      abortEmbeddedAgentRun: () => {
        Object.assign(run.execution, { status: "terminal" as const, endedAt: yieldedAt });
        run.pauseReason = "sessions_yield";
        return true;
      },
    });
    mockSessionPatchForStore(storePath, async () => null);

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
      execution: {
        endedAt: yieldedAt,
        outcome: {
          status: "error",
          endedAt: yieldedAt,
          elapsedMs: yieldedAt - (run.execution.startedAt ?? yieldedAt),
        },
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
    expect(getSubagentRunByChildSessionKey(childSessionKey)?.execution.endedAt).toBeUndefined();
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
    if (!("targetState" in result)) {
      throw new Error("expected finalizing target state");
    }
    expect(result.targetState).toEqual({ state: "finalizing" });
    expect(result.runId).toBe("run-current-admin");
    expect(result.sessionKey).toBe(childSessionKey);
  });

  it("does not retarget an ordinary same-id successor in the admin path", async () => {
    const childSessionKey = "agent:main:subagent:admin-same-id-successor";
    const source = createSubagentRunRecord({
      runId: "run-admin-same-id",
      childSessionKey,
      controllerSessionKey: "agent:main:controller",
      requesterSessionKey: "agent:main:requester",
      requesterDisplayKey: "requester",
      task: "admin source",
      cleanup: "keep",
      generation: 1,
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
    });
    addSubagentRunForTests(source);
    const abort = vi.fn(() => false);
    setSubagentControlDepsForTest({
      isEmbeddedAgentRunActive: () => false,
      abortEmbeddedAgentRun: abort,
      clearSessionQueues: () => ({ followupCleared: 0, laneCleared: 0, keys: [] }),
    });

    const pendingKill = killSubagentRunAdmin({
      cfg: cfgWithSessionStore(),
      sessionKey: childSessionKey,
    });
    addSubagentRunForTests({
      ...source,
      task: "admin successor",
      generation: 2,
      createdAt: Date.now(),
      execution: { status: "running", startedAt: Date.now() },
    });

    await expect(pendingKill).resolves.toMatchObject({
      found: true,
      killed: false,
      runId: source.runId,
    });
    expect(abort).not.toHaveBeenCalled();
    expect(getSubagentRunByChildSessionKey(childSessionKey)).toMatchObject({
      runId: source.runId,
      generation: 2,
      execution: { status: "running" },
    });
  });

  it("does not mutate the run when the durable kill intent cannot persist", async () => {
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

    subagentRegistryTesting.setDepsForTest({
      persistSubagentRunsToDiskOrThrow: () => {
        throw new Error("session store unavailable");
      },
    });

    const result = await killSubagentRunAdmin({
      cfg: cfgWithSessionStore(storePath),
      sessionKey: childSessionKey,
    });

    expect(result).toMatchObject({
      found: true,
      killed: false,
      runId: "run-worker-store-fail",
      sessionKey: childSessionKey,
      error: expect.stringContaining("Failed to persist subagent kill intent"),
    });
    expect(getSubagentRunByChildSessionKey(childSessionKey)).toMatchObject({
      runId: "run-worker-store-fail",
      execution: { status: "running" },
    });
    expect(getSubagentRunByChildSessionKey(childSessionKey)?.execution.endedAt).toBeUndefined();
  });
});

describe("killControlledSubagentRun", () => {
  afterEach(() => {
    resetSubagentRegistryForTests({ persist: false });
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
      entry: createSubagentRunRecord({
        runId: "run-stale",
        childSessionKey,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        controllerSessionKey: "agent:main:main",
        task: "stale task",
        cleanup: "keep",
        createdAt: Date.now() - 9_000,
        startedAt: Date.now() - 8_000,
      }),
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

  it("does not let 24 in-flight kills cross into same-id successor generations", async () => {
    const count = 24;
    const controllerSessionKey = "agent:main:main";
    const oldRuns = Array.from({ length: count }, (_, index) =>
      createSubagentRunRecord({
        runId: `run-old-${index}`,
        childSessionKey: `agent:main:subagent:generation-race-${index}`,
        controllerSessionKey,
        requesterSessionKey: controllerSessionKey,
        requesterDisplayKey: "main",
        task: `old task ${index}`,
        cleanup: "keep",
        generation: 1,
        createdAt: Date.now() - 5_000,
        startedAt: Date.now() - 4_000,
      }),
    );
    const storePath = await writeSessionStoreFixture(
      "generation-race",
      Object.fromEntries(
        oldRuns.map((entry, index) => [
          entry.childSessionKey,
          { sessionId: `sess-generation-race-${index}`, updatedAt: Date.now() },
        ]),
      ),
    );
    for (const entry of oldRuns) {
      addSubagentRunForTests(entry);
    }

    const isActive = vi.fn(() => false);
    const abort = vi.fn(() => false);
    const clearQueues = vi.fn(() => ({ followupCleared: 0, laneCleared: 0, keys: [] }));
    setSubagentControlDepsForTest({
      isEmbeddedAgentRunActive: isActive,
      abortEmbeddedAgentRun: abort,
      clearSessionQueues: clearQueues,
    });

    const pendingKills = oldRuns.map((entry) =>
      killControlledSubagentRun({
        cfg: cfgWithSessionStore(storePath),
        controller: {
          controllerSessionKey,
          callerSessionKey: controllerSessionKey,
          callerIsSubagent: false,
          controlScope: "children",
        },
        entry,
      }),
    );

    const successorKeys: string[] = [];
    const descendantKeys: string[] = [];
    for (const [index, entry] of oldRuns.entries()) {
      successorKeys.push(entry.childSessionKey);
      descendantKeys.push(`${entry.childSessionKey}:subagent:leaf`);
      addSubagentRunForTests({
        ...entry,
        runId: entry.runId,
        task: `successor task ${index}`,
        generation: 2,
        createdAt: Date.now(),
        execution: { status: "running", startedAt: Date.now() },
      });
      addSubagentRunForTests({
        ...entry,
        runId: `run-successor-leaf-${index}`,
        childSessionKey: descendantKeys[index]!,
        controllerSessionKey: entry.childSessionKey,
        requesterSessionKey: entry.childSessionKey,
        requesterDisplayKey: entry.childSessionKey,
        task: `successor leaf ${index}`,
        generation: 1,
        createdAt: Date.now(),
        execution: { status: "running", startedAt: Date.now() },
      });
    }

    const results = await Promise.all(pendingKills);

    expect(results.every((result) => result.status === "done")).toBe(true);
    expect(isActive).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
    expect(clearQueues).not.toHaveBeenCalled();
    for (const [index, childSessionKey] of successorKeys.entries()) {
      expect(getSubagentRunByChildSessionKey(childSessionKey)).toMatchObject({
        runId: `run-old-${index}`,
        controllerSessionKey,
        generation: 2,
        execution: { status: "running" },
      });
      expect(getSubagentRunByChildSessionKey(childSessionKey)?.execution.endedAt).toBeUndefined();
      expect(getSubagentRunByChildSessionKey(descendantKeys[index]!)).toMatchObject({
        runId: `run-successor-leaf-${index}`,
        execution: { status: "running" },
      });
      expect(
        getSubagentRunByChildSessionKey(descendantKeys[index]!)?.execution.endedAt,
      ).toBeUndefined();
    }
  });

  it("fences a successor that appears while kill persistence is pending", async () => {
    const childSessionKey = "agent:main:subagent:persist-generation-race";
    const descendantSessionKey = `${childSessionKey}:subagent:leaf`;
    const controllerSessionKey = "agent:main:main";
    const oldRun = createSubagentRunRecord({
      runId: "run-persist-old",
      childSessionKey,
      controllerSessionKey,
      requesterSessionKey: controllerSessionKey,
      requesterDisplayKey: "main",
      task: "old persisted task",
      cleanup: "keep",
      generation: 1,
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
    });
    const storePath = await writeSessionStoreFixture("persist-generation-race", {
      [childSessionKey]: {
        sessionId: "sess-persist-generation-race",
        updatedAt: Date.now(),
      },
    });
    addSubagentRunForTests(oldRun);

    let releasePersistence!: () => void;
    let markPersistenceStarted!: () => void;
    const persistenceStarted = new Promise<void>((resolve) => {
      markPersistenceStarted = resolve;
    });
    const persistenceRelease = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    const abort = vi.fn(() => false);
    const clearQueues = vi.fn(() => ({ followupCleared: 0, laneCleared: 0, keys: [] }));
    setSubagentControlDepsForTest({
      isEmbeddedAgentRunActive: () => false,
      abortEmbeddedAgentRun: abort,
      clearSessionQueues: clearQueues,
    });
    mockSessionPatchForStore(storePath, async (_scope, patcher) => {
      markPersistenceStarted();
      await persistenceRelease;
      const current = { sessionId: "sess-persist-generation-race", updatedAt: Date.now() };
      const patch = await patcher(current, { existingEntry: { ...current } });
      return patch ? { ...current, ...patch } : current;
    });

    const pendingKill = killControlledSubagentRun({
      cfg: cfgWithSessionStore(storePath),
      controller: {
        controllerSessionKey,
        callerSessionKey: controllerSessionKey,
        callerIsSubagent: false,
        controlScope: "children",
      },
      entry: oldRun,
    });
    await persistenceStarted;

    addSubagentRunForTests({
      ...oldRun,
      runId: "run-persist-successor",
      controllerSessionKey: "agent:foreign:controller",
      requesterSessionKey: "agent:foreign:controller",
      requesterDisplayKey: "agent:foreign:controller",
      task: "successor persisted task",
      generation: 2,
      createdAt: Date.now(),
      execution: { status: "running", startedAt: Date.now() },
    });
    addSubagentRunForTests({
      ...oldRun,
      runId: "run-persist-successor-leaf",
      childSessionKey: descendantSessionKey,
      controllerSessionKey: childSessionKey,
      requesterSessionKey: childSessionKey,
      requesterDisplayKey: childSessionKey,
      task: "successor persisted leaf",
      createdAt: Date.now(),
      execution: { status: "running", startedAt: Date.now() },
    });
    releasePersistence();

    await expect(pendingKill).resolves.toMatchObject({
      status: "ok",
      runId: "run-persist-old",
      killed: true,
    });
    expect(abort).toHaveBeenCalledOnce();
    expect(clearQueues).toHaveBeenCalledOnce();
    expect(getSubagentRunByChildSessionKey(childSessionKey)).toMatchObject({
      runId: "run-persist-successor",
      execution: { status: "running" },
    });
    expect(getSubagentRunByChildSessionKey(childSessionKey)?.execution.endedAt).toBeUndefined();
    expect(getSubagentRunByChildSessionKey(descendantSessionKey)).toMatchObject({
      runId: "run-persist-successor-leaf",
      execution: { status: "running" },
    });
    expect(
      getSubagentRunByChildSessionKey(descendantSessionKey)?.execution.endedAt,
    ).toBeUndefined();
  });

  it("does not abort or clear queues after the child session incarnation resets", async () => {
    const childSessionKey = "agent:main:subagent:kill-session-reset";
    const storePath = await writeSessionStoreFixture("kill-session-reset", {
      [childSessionKey]: {
        sessionId: "sess-kill-session-reset",
        lifecycleRevision: "revision-before-reset",
        updatedAt: Date.now(),
      },
    });
    const entry = createSubagentRunRecord({
      runId: "run-kill-session-reset",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "old session work",
      cleanup: "keep",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
    });
    addSubagentRunForTests(entry);
    const abort = vi.fn(() => true);
    const clearQueues = vi.fn(() => ({ followupCleared: 0, laneCleared: 0, keys: [] }));
    setSubagentControlDepsForTest({
      isEmbeddedAgentRunActive: () => {
        replaceSessionEntrySync(
          { storePath, sessionKey: childSessionKey },
          {
            sessionId: "sess-kill-session-reset",
            lifecycleRevision: "revision-after-reset",
            updatedAt: Date.now(),
          },
        );
        return true;
      },
      abortEmbeddedAgentRun: abort,
      clearSessionQueues: clearQueues,
    });

    await expect(
      killControlledSubagentRun({
        cfg: cfgWithSessionStore(storePath),
        controller: {
          controllerSessionKey: "agent:main:main",
          callerSessionKey: "agent:main:main",
          callerIsSubagent: false,
          controlScope: "children",
        },
        entry,
      }),
    ).resolves.toMatchObject({
      status: "error",
      error: "Subagent session changed while the kill was pending; retry.",
    });

    expect(abort).not.toHaveBeenCalled();
    expect(clearQueues).not.toHaveBeenCalled();
    expect(getSubagentRunByChildSessionKey(childSessionKey)).toMatchObject({
      runId: entry.runId,
      killIntent: undefined,
      execution: { status: "running" },
    });
  });

  it("does not patch the replacement session after the killed row commits", async () => {
    const childSessionKey = "agent:main:subagent:kill-session-patch-reset";
    const storePath = await writeSessionStoreFixture("kill-session-patch-reset", {
      [childSessionKey]: {
        sessionId: "sess-kill-session-patch-reset",
        lifecycleRevision: "revision-before-reset",
        updatedAt: Date.now(),
      },
    });
    const entry = createSubagentRunRecord({
      runId: "run-kill-session-patch-reset",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "do not patch successor",
      cleanup: "keep",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
    });
    addSubagentRunForTests(entry);
    const patches: Array<Partial<SessionEntry> | null> = [];
    mockSessionPatchForStore(storePath, async (_scope, patcher) => {
      const replacement: SessionEntry = {
        sessionId: "sess-kill-session-patch-reset",
        lifecycleRevision: "revision-after-reset",
        updatedAt: Date.now(),
      };
      const patch = await patcher(replacement, { existingEntry: { ...replacement } });
      patches.push(patch);
      return patch ? { ...replacement, ...patch } : replacement;
    });

    await expect(
      killControlledSubagentRun({
        cfg: cfgWithSessionStore(storePath),
        controller: {
          controllerSessionKey: "agent:main:main",
          callerSessionKey: "agent:main:main",
          callerIsSubagent: false,
          controlScope: "children",
        },
        entry,
      }),
    ).resolves.toMatchObject({ status: "ok", killed: true });

    expect(patches).toEqual([null]);
    expect(getSubagentRunByChildSessionKey(childSessionKey)).toMatchObject({
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      execution: { status: "terminal" },
    });
  });

  it("kills a yielded descendant without reviving a stale child row", async () => {
    const parentSessionKey = "agent:main:subagent:kill-parent";
    const childSessionKey = `${parentSessionKey}:subagent:child`;
    const leafSessionKey = `${childSessionKey}:subagent:leaf`;

    const parentRun = createSubagentRunRecord({
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
    addSubagentRunForTests(parentRun);
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
      entry: parentRun,
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
    expect(getSubagentRunByChildSessionKey(leafSessionKey)?.execution.endedAt).toBeTypeOf("number");
  });

  it("does not cascade through a child session that moved to a newer parent", async () => {
    const oldParentSessionKey = "agent:main:subagent:old-parent";
    const newParentSessionKey = "agent:main:subagent:new-parent";
    const childSessionKey = "agent:main:subagent:shared-child";
    const leafSessionKey = `${childSessionKey}:subagent:leaf`;

    const oldParentRun = createSubagentRunRecord({
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
    addSubagentRunForTests(oldParentRun);
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
      entry: oldParentRun,
    });

    expect(result).toEqual({
      status: "done",
      runId: "run-old-parent-current",
      sessionKey: oldParentSessionKey,
      label: "old parent task",
      text: "old parent task is already finished.",
    });
    expect(getSubagentRunByChildSessionKey(leafSessionKey)?.execution.endedAt).toBeUndefined();
  });

  it("interrupts a pending recovery admission before deciding the kill target is inactive", async () => {
    const controllerSessionKey = "agent:main:main";
    const childSessionKey = "agent:main:subagent:kill-recovery-admission";
    const sessionId = "sess-kill-recovery-admission";
    const entry = createSubagentRunRecord({
      runId: "run-kill-recovery-admission",
      childSessionKey,
      controllerSessionKey,
      requesterSessionKey: controllerSessionKey,
      requesterDisplayKey: "main",
      task: "kill recovery admission",
      cleanup: "keep",
      createdAt: Date.now() - 2_000,
      execution: { status: "running", startedAt: Date.now() - 1_000 },
    });
    addSubagentRunForTests(entry);
    const storePath = await writeSessionStoreFixture("kill-recovery-admission", {
      [childSessionKey]: { sessionId, updatedAt: Date.now(), abortedLastRun: true },
    });
    const admission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [childSessionKey, sessionId],
      assertAllowed: () => {},
    });
    const handoffId = admission.createHandoff();
    let recoveryActive = false;
    const abort = vi.fn(() => recoveryActive);
    setSubagentControlDepsForTest({
      isEmbeddedAgentRunActive: () => recoveryActive,
      abortEmbeddedAgentRun: abort,
      clearSessionQueues: () => ({ followupCleared: 0, laneCleared: 0, keys: [] }),
    });

    const pendingKill = killControlledSubagentRun({
      cfg: cfgWithSessionStore(storePath),
      controller: {
        controllerSessionKey,
        callerSessionKey: controllerSessionKey,
        callerIsSubagent: false,
        controlScope: "children",
      },
      entry,
    });
    await vi.waitFor(() => expect(getActiveSessionLifecycleMutationCount()).toBeGreaterThan(0));
    const adopted = consumeSessionWorkAdmissionHandoff({
      handoffId,
      scope: storePath,
      identities: [childSessionKey, sessionId],
      onInterrupt: () => {
        recoveryActive = true;
      },
    });
    expect(adopted).toBeDefined();
    expect(recoveryActive).toBe(true);
    adopted?.release();

    await expect(pendingKill).resolves.toMatchObject({ status: "ok" });
    expect(abort).toHaveBeenCalledWith(sessionId);
    expect(getSubagentRunByChildSessionKey(childSessionKey)).toMatchObject({
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      execution: { status: "terminal" },
    });
  });

  it("returns a structured error when interrupted work does not release before kill timeout", async () => {
    const controllerSessionKey = "agent:main:main";
    const childSessionKey = "agent:main:subagent:kill-admission-timeout";
    const sessionId = "sess-kill-admission-timeout";
    const entry = createSubagentRunRecord({
      runId: "run-kill-admission-timeout",
      childSessionKey,
      controllerSessionKey,
      requesterSessionKey: controllerSessionKey,
      requesterDisplayKey: "main",
      task: "hold admission during kill",
      cleanup: "keep",
      createdAt: Date.now() - 2_000,
      execution: { status: "running", startedAt: Date.now() - 1_000 },
    });
    addSubagentRunForTests(entry);
    const storePath = await writeSessionStoreFixture("kill-admission-timeout", {
      [childSessionKey]: { sessionId, updatedAt: Date.now() },
    });
    const admission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [childSessionKey, sessionId],
      assertAllowed: () => {},
    });
    setSubagentControlDepsForTest({
      isEmbeddedAgentRunActive: () => false,
      abortEmbeddedAgentRun: () => false,
      clearSessionQueues: () => ({ followupCleared: 0, laneCleared: 0, keys: [] }),
    });

    vi.useFakeTimers();
    try {
      const pendingKill = killControlledSubagentRun({
        cfg: cfgWithSessionStore(storePath),
        controller: {
          controllerSessionKey,
          callerSessionKey: controllerSessionKey,
          callerIsSubagent: false,
          controlScope: "children",
        },
        entry,
      });
      await vi.waitFor(() => expect(getActiveSessionLifecycleMutationCount()).toBeGreaterThan(0));
      await vi.advanceTimersByTimeAsync(SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS);

      await expect(pendingKill).resolves.toMatchObject({
        status: "error",
        error: "Subagent is still active; try the kill again in a moment.",
      });
      expect(getSubagentRunByChildSessionKey(childSessionKey)?.execution.endedAt).toBeUndefined();
    } finally {
      admission.release();
      vi.useRealTimers();
    }
  });

  it("adopts the receipt-matched recovery successor and kills its descendants", async () => {
    const controllerSessionKey = "agent:main:main";
    const childSessionKey = "agent:main:subagent:kill-remapped-recovery";
    const descendantSessionKey = `${childSessionKey}:subagent:leaf`;
    const sessionId = "sess-kill-remapped-recovery";
    const recoveryRunId = "recovery-run-kill-remapped";
    const receipt = {
      sessionId,
      sessionMarker: `${sessionId}:1`,
      idempotencyKey: recoveryRunId,
      phase: "accepted" as const,
    };
    const source = createSubagentRunRecord({
      runId: "source-run-kill-remapped",
      childSessionKey,
      controllerSessionKey,
      requesterSessionKey: controllerSessionKey,
      requesterDisplayKey: "main",
      task: "source recovery task",
      cleanup: "keep",
      generation: 1,
      createdAt: Date.now() - 2_000,
      execution: {
        status: "interrupted",
        startedAt: Date.now() - 1_000,
        restartRecovery: receipt,
      },
    });
    addSubagentRunForTests(source);
    const storePath = await writeSessionStoreFixture("kill-remapped-recovery", {
      [childSessionKey]: { sessionId, updatedAt: Date.now(), abortedLastRun: true },
      [descendantSessionKey]: {
        sessionId: "sess-kill-remapped-recovery-leaf",
        updatedAt: Date.now(),
      },
    });
    const admission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [childSessionKey, sessionId],
      assertAllowed: () => {},
    });
    const handoffId = admission.createHandoff();
    setSubagentControlDepsForTest({
      isEmbeddedAgentRunActive: () => true,
      abortEmbeddedAgentRun: () => true,
      clearSessionQueues: () => ({ followupCleared: 0, laneCleared: 0, keys: [] }),
    });

    const pendingKill = killControlledSubagentRun({
      cfg: cfgWithSessionStore(storePath),
      controller: {
        controllerSessionKey,
        callerSessionKey: controllerSessionKey,
        callerIsSubagent: false,
        controlScope: "children",
      },
      entry: source,
    });
    await vi.waitFor(() => expect(getActiveSessionLifecycleMutationCount()).toBeGreaterThan(0));
    const adopted = consumeSessionWorkAdmissionHandoff({
      handoffId,
      scope: storePath,
      identities: [childSessionKey, sessionId],
      onInterrupt: () => undefined,
    });
    expect(
      replaceSubagentRunAfterSteerCore({
        previousRunId: source.runId,
        nextRunId: recoveryRunId,
        expected: source,
        restartRecovery: receipt,
        persistenceFailure: "return-false",
      }),
    ).toBe(true);
    addSubagentRunForTests({
      runId: "run-kill-remapped-leaf",
      childSessionKey: descendantSessionKey,
      controllerSessionKey: childSessionKey,
      requesterSessionKey: childSessionKey,
      requesterDisplayKey: childSessionKey,
      task: "remapped leaf",
      cleanup: "keep",
      createdAt: Date.now(),
      startedAt: Date.now(),
    });
    adopted?.release();

    await expect(pendingKill).resolves.toMatchObject({
      status: "ok",
      runId: source.runId,
      killed: true,
      cascadeKilled: 1,
    });
    expect(getSubagentRunByChildSessionKey(childSessionKey)).toMatchObject({
      runId: recoveryRunId,
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      execution: { status: "terminal", restartRecovery: undefined },
    });
    expect(getSubagentRunByChildSessionKey(descendantSessionKey)).toMatchObject({
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      execution: { status: "terminal" },
    });
  });

  it("leaves restart recovery disabled when the kill tombstone cannot persist", async () => {
    const controllerSessionKey = "agent:main:main";
    const childSessionKey = "agent:main:subagent:kill-tombstone-failure";
    const sessionId = "sess-kill-tombstone-failure";
    const entry = createSubagentRunRecord({
      runId: "run-kill-tombstone-failure",
      childSessionKey,
      controllerSessionKey,
      requesterSessionKey: controllerSessionKey,
      requesterDisplayKey: "main",
      task: "kill tombstone failure",
      cleanup: "keep",
      createdAt: Date.now() - 2_000,
      execution: {
        status: "interrupted",
        startedAt: Date.now() - 1_000,
        restartRecovery: {
          sessionId,
          sessionMarker: `${sessionId}:1`,
          idempotencyKey: "recovery-kill-tombstone-failure",
          phase: "reserved",
        },
      },
    });
    addSubagentRunForTests(entry);
    const storePath = await writeSessionStoreFixture("kill-tombstone-failure", {
      [childSessionKey]: { sessionId, updatedAt: 1, abortedLastRun: true },
    });
    const abortedLastRunWrites: boolean[] = [];
    let persistenceWrites = 0;
    mockSessionPatchForStore(storePath, async (_scope, patcher) => {
      const current = { sessionId, updatedAt: 1, abortedLastRun: true };
      const patch = await patcher(current, { existingEntry: { ...current } });
      if (patch) {
        abortedLastRunWrites.push(patch.abortedLastRun === true);
      }
      return patch ? { ...current, ...patch } : current;
    });
    subagentRegistryTesting.setDepsForTest({
      persistSubagentRunsToDiskOrThrow: () => {
        persistenceWrites += 1;
        if (persistenceWrites === 2) {
          throw new Error("sqlite busy");
        }
      },
    });

    await expect(
      killControlledSubagentRun({
        cfg: cfgWithSessionStore(storePath),
        controller: {
          controllerSessionKey,
          callerSessionKey: controllerSessionKey,
          callerIsSubagent: false,
          controlScope: "children",
        },
        entry,
      }),
    ).resolves.toMatchObject({
      status: "error",
      error: expect.stringContaining("Failed to persist subagent kill tombstone"),
    });

    expect(abortedLastRunWrites).toEqual([]);
    expect(getSubagentRunByChildSessionKey(childSessionKey)).toMatchObject({
      runId: entry.runId,
      killIntent: { reason: "killed", sessionId },
      execution: {
        status: "interrupted",
        restartRecovery: { phase: "reserved" },
      },
    });
    expect(getSubagentRunByChildSessionKey(childSessionKey)?.execution.endedAt).toBeUndefined();
  });
});

describe("killAllControlledSubagentRuns", () => {
  afterEach(() => {
    resetSubagentRegistryForTests({ persist: false });
  });

  it("continues bulk cancellation after one registry persistence failure", async () => {
    let failNextPersistence = true;
    let persistedAfterFailure = false;
    subagentRegistryTesting.setDepsForTest({
      cleanupBrowserSessionsForLifecycleEnd: async () => {},
      ensureContextEnginesInitialized: () => {},
      loadAgentRuntimePluginRegistryHandle: () => undefined,
      persistSubagentRunsToDisk: () => {},
      persistSubagentRunsToDiskOrThrow: () => {
        if (failNextPersistence) {
          failNextPersistence = false;
          throw new Error("sqlite busy");
        }
        persistedAfterFailure = true;
      },
      restoreSubagentRunsFromDisk: () => 0,
      resolveContextEngine: async () => ({
        info: { id: "test", name: "Test" },
        assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
        compact: async () => ({ ok: true, compacted: false }),
        ingest: async () => ({ ingested: false }),
      }),
    });
    const first = createSubagentRunRecord({
      runId: "run-bulk-persistence-failure-first",
      childSessionKey: "agent:main:subagent:bulk-persistence-failure-first",
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "first bulk task",
      cleanup: "keep",
      createdAt: Date.now() - 2_000,
      startedAt: Date.now() - 1_900,
    });
    const second = createSubagentRunRecord({
      ...first,
      runId: "run-bulk-persistence-failure-second",
      childSessionKey: "agent:main:subagent:bulk-persistence-failure-second",
      task: "second bulk task",
      createdAt: Date.now() - 1_000,
      execution: { status: "running", startedAt: Date.now() - 900 },
    });
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

    expect(result).toEqual({
      status: "error",
      error: "first bulk task: Failed to persist subagent kill intent: sqlite busy",
      killed: 1,
      labels: ["second bulk task"],
    });
    expect(persistedAfterFailure).toBe(true);
    expect(
      getSubagentRunByChildSessionKey(first.childSessionKey)?.execution.endedAt,
    ).toBeUndefined();
    expect(getSubagentRunByChildSessionKey(second.childSessionKey)?.execution.endedAt).toBeTypeOf(
      "number",
    );
  });

  it("ignores stale same-id generations in bulk kill requests", async () => {
    const childSessionKey = "agent:main:subagent:stale-kill-all-worker";
    const storePath = await writeSessionStoreFixture("stale-kill-all", {
      [childSessionKey]: {
        updatedAt: Date.now(),
      },
    });

    addSubagentRunForTests({
      runId: "run-same-bulk",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "current bulk task",
      cleanup: "keep",
      generation: 2,
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
        createSubagentRunRecord({
          runId: "run-same-bulk",
          childSessionKey,
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          controllerSessionKey: "agent:main:main",
          task: "stale bulk task",
          cleanup: "keep",
          generation: 1,
          createdAt: Date.now() - 9_000,
          startedAt: Date.now() - 8_000,
        }),
      ],
    });

    expect(result).toEqual({
      status: "ok",
      killed: 0,
      labels: [],
    });
    const persisted = loadSessionEntry({ storePath, sessionKey: childSessionKey });
    expect(persisted?.abortedLastRun).toBeUndefined();
    expect(getSubagentRunByChildSessionKey(childSessionKey)).toMatchObject({
      runId: "run-same-bulk",
      generation: 2,
    });
  });

  it("does not let a stale bulk entry suppress the current yielded entry", async () => {
    const childSessionKey = "agent:main:subagent:stale-kill-all-shadow-worker";
    const storePath = await writeSessionStoreFixture("stale-kill-all-shadow", {
      [childSessionKey]: {
        updatedAt: Date.now(),
      },
    });

    const currentShadowRun = createSubagentRunRecord({
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
    addSubagentRunForTests(currentShadowRun);

    const result = await killAllControlledSubagentRuns({
      cfg: cfgWithSessionStore(storePath),
      controller: {
        controllerSessionKey: "agent:main:main",
        callerSessionKey: "agent:main:main",
        callerIsSubagent: false,
        controlScope: "children",
      },
      runs: [
        createSubagentRunRecord({
          runId: "run-stale-shadow",
          childSessionKey,
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          controllerSessionKey: "agent:main:main",
          task: "stale shadow task",
          cleanup: "keep",
          createdAt: Date.now() - 9_000,
          startedAt: Date.now() - 8_000,
        }),
        currentShadowRun,
      ],
    });

    expect(result).toEqual({
      status: "ok",
      killed: 1,
      labels: ["current shadow task"],
    });
    expect(getSubagentRunByChildSessionKey(childSessionKey)?.execution.endedAt).toBeTypeOf(
      "number",
    );
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
    const currentBulkFinishedRun = createSubagentRunRecord({
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
    addSubagentRunForTests(currentBulkFinishedRun);

    const result = await killAllControlledSubagentRuns({
      cfg: cfgWithSessionStore(),
      controller: {
        controllerSessionKey: "agent:main:main",
        callerSessionKey: "agent:main:main",
        callerIsSubagent: false,
        controlScope: "children",
      },
      runs: [currentBulkFinishedRun],
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
    const currentBulkParentRun = createSubagentRunRecord({
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
    addSubagentRunForTests(currentBulkParentRun);
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
      runs: [currentBulkParentRun],
    });

    expect(result).toEqual({
      status: "ok",
      killed: 1,
      labels: ["active bulk child task"],
    });
    expect(getSubagentRunByChildSessionKey(childSessionKey)?.execution.endedAt).toBeTypeOf(
      "number",
    );
  });
});

describe("steerControlledSubagentRun", () => {
  afterEach(() => {
    resetSubagentRegistryForTests({ persist: false });
  });

  it("rejects steering collector runs", async () => {
    const entry: SubagentRunRecord = {
      runId: "run-collector",
      childSessionKey: "agent:worker:subagent:collector",
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "collect",
      cleanup: "keep",
      collect: true,
      createdAt: Date.now(),
      execution: { status: "running" },
    };
    addSubagentRunForTests(entry);
    const result = await steerControlledSubagentRun({
      cfg: {} as OpenClawConfig,
      controller: {
        controllerSessionKey: "agent:main:main",
        callerSessionKey: "agent:main:main",
        callerIsSubagent: false,
        controlScope: "children",
      },
      entry,
      message: "change direction",
    });

    expect(result).toEqual({
      status: "forbidden",
      runId: entry.runId,
      sessionKey: entry.childSessionKey,
      error: "Collector subagents cannot be steered; use agents_wait or cancel the task.",
    });
  });

  it("returns an error and clears the restart marker when run remap fails", async () => {
    const entry = createSubagentRunRecord({
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
    addSubagentRunForTests(entry);

    const replaceSpy = vi
      .spyOn(await import("./subagent-registry.js"), "replaceSubagentRunAfterSteerCore")
      .mockReturnValue(false);

    const callGatewayImplementation: GatewayCaller = async <T = Record<string, unknown>>(
      request: CallGatewayOptions,
    ) => {
      if (request.method === "agent.wait") {
        return {} as T;
      }
      if (request.method === "agent") {
        return { runId: "run-steer-new" } as T;
      }
      if (request.method === "chat.abort") {
        return {
          aborted: true,
          runIds: [(request.params as { runId: string }).runId],
        } as T;
      }
      throw new Error(`unexpected method: ${request.method}`);
    };
    const callGateway = vi.fn(callGatewayImplementation) as GatewayCaller;
    setSubagentControlDepsForTest({
      callGateway,
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
        entry,
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
      expect(callGateway).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "chat.abort",
          params: {
            sessionKey: "agent:main:subagent:steer-worker",
            runId: "run-steer-new",
          },
        }),
      );
    } finally {
      replaceSpy.mockRestore();
    }
  });

  it("keeps steer dispatch on the registry owner when the global Gateway is replaced", async () => {
    const childSessionKey = "agent:main:subagent:steer-owner-binding";
    const entry = createSubagentRunRecord({
      runId: "run-steer-owner-old",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "old direction",
      cleanup: "keep",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
    });

    const calls = { owner: { agent: 0 }, replacement: { agent: 0 } };
    const ownerRuntime = {
      dispatchAgent: async <T = unknown>() => {
        calls.owner.agent += 1;
        return { runId: "run-steer-owner-new" } as T;
      },
      waitForAgent: async <T = unknown>() => ({}) as T,
    } as unknown as GatewayRecoveryRuntime;
    const replacementRuntime = {
      dispatchAgent: async <T = unknown>() => {
        calls.replacement.agent += 1;
        return { runId: "run-steer-replacement-new" } as T;
      },
      waitForAgent: async <T = unknown>() => ({}) as T,
    } as unknown as GatewayRecoveryRuntime;

    const releaseOwner = registerGatewayRecoveryRuntime(ownerRuntime);
    activateSubagentRegistry(
      () => ({ recoveryRuntime: ownerRuntime }) as unknown as GatewayRequestContext,
    );
    addSubagentRunForTests(entry);
    // Normal registration binds the run to the Gateway that owns the registry;
    // the binding, not the process-global slot, is the dispatch owner.
    const ownerResolver = () =>
      ({ recoveryRuntime: ownerRuntime }) as unknown as GatewayRequestContext;
    bindGatewayContextResolver(entry, ownerResolver);
    // Gateway replacement window: a new instance registers as the process-global
    // recovery runtime and activates the registry in post-attach startup. The
    // live row must keep its original owner binding.
    const releaseReplacement = registerGatewayRecoveryRuntime(replacementRuntime);
    activateSubagentRegistry(
      () => ({ recoveryRuntime: replacementRuntime }) as unknown as GatewayRequestContext,
    );
    expect(getGatewayContextResolver(entry)).toBe(ownerResolver);

    try {
      const result = await steerControlledSubagentRun({
        cfg: cfgWithSessionStore(),
        controller: {
          controllerSessionKey: "agent:main:main",
          callerSessionKey: "agent:main:main",
          callerIsSubagent: false,
          controlScope: "children",
        },
        entry,
        message: "new direction",
      });

      expect(result.status).toBe("accepted");
      expect(calls.owner.agent).toBe(1);
      expect(calls.replacement.agent).toBe(0);
    } finally {
      releaseReplacement();
      releaseOwner();
    }
  });

  it("fails closed when the registry owner Gateway is stale", async () => {
    const childSessionKey = "agent:main:subagent:steer-stale-owner";
    const entry = createSubagentRunRecord({
      runId: "run-steer-stale-old",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "old direction",
      cleanup: "keep",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
    });

    const calls = {
      owner: { agent: 0, wait: 0 },
      replacement: { agent: 0, wait: 0 },
    };
    const ownerRuntime = {
      dispatchAgent: async <T = unknown>() => {
        calls.owner.agent += 1;
        return { runId: "run-steer-stale-new" } as T;
      },
      waitForAgent: async <T = unknown>() => {
        calls.owner.wait += 1;
        return {} as T;
      },
    } as unknown as GatewayRecoveryRuntime;
    const replacementRuntime = {
      dispatchAgent: async <T = unknown>() => {
        calls.replacement.agent += 1;
        return { runId: "run-steer-stale-replacement" } as T;
      },
      waitForAgent: async <T = unknown>() => {
        calls.replacement.wait += 1;
        return {} as T;
      },
    } as unknown as GatewayRecoveryRuntime;

    // Mirror the production kernel fence (`isAvailable() ? context : undefined`):
    // once the owner instance closes, its resolver intentionally returns
    // undefined while the registry still belongs to it.
    let ownerAvailable = true;
    const ownerContext = { recoveryRuntime: ownerRuntime };
    const releaseOwner = registerGatewayRecoveryRuntime(ownerRuntime);
    activateSubagentRegistry(() =>
      ownerAvailable ? (ownerContext as unknown as GatewayRequestContext) : undefined,
    );
    addSubagentRunForTests(entry);
    // Normal registration binds the run to the owning Gateway's fenced resolver.
    bindGatewayContextResolver(entry, () =>
      ownerAvailable ? (ownerContext as unknown as GatewayRequestContext) : undefined,
    );
    // Gateway replacement window: a new instance registers as the process-global
    // recovery runtime and activates the registry, then the owner closes.
    const releaseReplacement = registerGatewayRecoveryRuntime(replacementRuntime);
    activateSubagentRegistry(
      () => ({ recoveryRuntime: replacementRuntime }) as unknown as GatewayRequestContext,
    );
    ownerAvailable = false;

    const { callGateway: genericGatewayTransport } = await import("../../../gateway/call.js");
    vi.mocked(genericGatewayTransport).mockClear();

    try {
      const steerResult = await steerControlledSubagentRun({
        cfg: cfgWithSessionStore(),
        controller: {
          controllerSessionKey: "agent:main:main",
          callerSessionKey: "agent:main:main",
          callerIsSubagent: false,
          controlScope: "children",
        },
        entry,
        message: "new direction",
      });

      expect(steerResult).toMatchObject({
        status: "error",
        error: expect.stringContaining("registry owner Gateway is stale"),
      });
      expect(calls.owner).toEqual({ agent: 0, wait: 0 });
      expect(calls.replacement).toEqual({ agent: 0, wait: 0 });
      expect(genericGatewayTransport).not.toHaveBeenCalled();

      const followUpResult = await sendControlledSubagentMessage({
        cfg: cfgWithSessionStore(),
        controller: {
          controllerSessionKey: "agent:main:main",
          callerSessionKey: "agent:main:main",
          callerIsSubagent: false,
          controlScope: "children",
        },
        entry,
        message: "follow-up direction",
      });

      expect(followUpResult).toMatchObject({
        status: "error",
        error: expect.stringContaining("registry owner Gateway is stale"),
      });
      expect(calls.owner).toEqual({ agent: 0, wait: 0 });
      expect(calls.replacement).toEqual({ agent: 0, wait: 0 });
      expect(genericGatewayTransport).not.toHaveBeenCalled();
    } finally {
      releaseReplacement();
      releaseOwner();
    }
  });

  it("terminates an accepted steer when the Gateway lifecycle rotates during dispatch", async () => {
    const childSessionKey = "agent:main:subagent:steer-generation-race";
    const entry = createSubagentRunRecord({
      runId: "run-steer-generation-old",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "old direction",
      cleanup: "keep",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
    });
    addSubagentRunForTests(entry);
    const callGatewayImplementation: GatewayCaller = async <T = Record<string, unknown>>(
      request: CallGatewayOptions,
    ) => {
      if (request.method === "agent.wait") {
        return {} as T;
      }
      if (request.method === "chat.abort") {
        return {
          aborted: true,
          runIds: [(request.params as { runId: string }).runId],
        } as T;
      }
      if (request.method === "agent") {
        rotateAgentEventLifecycleGeneration();
        return { runId: "run-steer-generation-new" } as T;
      }
      throw new Error(`unexpected method: ${request.method}`);
    };
    const callGateway = vi.fn(callGatewayImplementation) as GatewayCaller;
    setSubagentControlDepsForTest({ callGateway });

    await expect(
      steerControlledSubagentRun({
        cfg: cfgWithSessionStore(),
        controller: {
          controllerSessionKey: "agent:main:main",
          callerSessionKey: "agent:main:main",
          callerIsSubagent: false,
          controlScope: "children",
        },
        entry,
        message: "new direction",
      }),
    ).resolves.toMatchObject({
      status: "error",
      runId: "run-steer-generation-new",
      error: "Gateway lifecycle changed before the steered run could be registered.",
    });

    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "chat.abort",
        params: { sessionKey: childSessionKey, runId: "run-steer-generation-new" },
      }),
    );
    expect(getSubagentRunByChildSessionKey(childSessionKey)).toMatchObject({
      runId: entry.runId,
      suppressAnnounceReason: undefined,
    });
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
    const entry = createSubagentRunRecord({
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
    addSubagentRunForTests(entry);
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
      entry,
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
    expect(storedRun?.execution.endedAt).toBeUndefined();
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
      entry: createSubagentRunRecord({
        runId: "run-stale",
        childSessionKey: "agent:main:subagent:stale-worker",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        controllerSessionKey: "agent:main:main",
        task: "stale task",
        cleanup: "keep",
        createdAt: Date.now() - 5_000,
        startedAt: Date.now() - 4_000,
      }),
      message: "updated direction",
    });

    expect(result).toEqual({
      status: "done",
      runId: "run-stale",
      sessionKey: "agent:main:subagent:stale-worker",
      text: "stale task is already finished.",
    });
  });

  it("does not clear a same-id successor steer marker after the source is replaced", async () => {
    const childSessionKey = "agent:main:subagent:same-id-steer-replacement";
    const controllerSessionKey = "agent:main:main";
    const source = createSubagentRunRecord({
      runId: "run-same-id-steer",
      childSessionKey,
      controllerSessionKey,
      requesterSessionKey: controllerSessionKey,
      requesterDisplayKey: "main",
      task: "source steer task",
      cleanup: "keep",
      generation: 1,
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
    });
    addSubagentRunForTests(source);
    setSubagentControlDepsForTest({
      callGateway: async <T = Record<string, unknown>>(request: CallGatewayOptions) => {
        if (request.method !== "agent.wait") {
          throw new Error("replacement must prevent a new steer dispatch");
        }
        addSubagentRunForTests({
          ...source,
          task: "successor steer task",
          generation: 2,
          createdAt: Date.now(),
          suppressAnnounceReason: "steer-restart",
          execution: { status: "running", startedAt: Date.now() },
        });
        return {} as T;
      },
    });

    await expect(
      steerControlledSubagentRun({
        cfg: cfgWithSessionStore(),
        controller: {
          controllerSessionKey,
          callerSessionKey: controllerSessionKey,
          callerIsSubagent: false,
          controlScope: "children",
        },
        entry: source,
        message: "new direction",
      }),
    ).resolves.toMatchObject({
      status: "done",
      runId: source.runId,
    });

    expect(getSubagentRunByChildSessionKey(childSessionKey)).toMatchObject({
      runId: source.runId,
      generation: 2,
      suppressAnnounceReason: "steer-restart",
      execution: { status: "running" },
    });
  });

  it("steers an ended current run that is still waiting on active descendants even when stale older rows exist", async () => {
    const childSessionKey = "agent:main:subagent:stale-steer-worker";
    const currentCreatedAt = Date.now() - 5_000;
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
      createdAt: currentCreatedAt,
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
      entry: createSubagentRunRecord({
        runId: "run-current-ended-steer",
        childSessionKey,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        controllerSessionKey: "agent:main:main",
        task: "current ended steer task",
        cleanup: "keep",
        createdAt: currentCreatedAt,
        startedAt: Date.now() - 4_000,
        endedAt: Date.now() - 1_000,
        outcome: { status: "ok" },
      }),
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
    const createdAt = Date.now() - 5_000;
    addSubagentRunForTests({
      runId: "run-yielded-steer",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "yielded steer task",
      cleanup: "keep",
      createdAt,
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
      entry: createSubagentRunRecord({
        runId: "run-yielded-steer",
        childSessionKey,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        controllerSessionKey: "agent:main:main",
        task: "yielded steer task",
        cleanup: "keep",
        createdAt,
        startedAt: Date.now() - 4_000,
        endedAt: Date.now() - 1_000,
        pauseReason: "sessions_yield",
      }),
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
    const entry = createSubagentRunRecord({
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
    addSubagentRunForTests(entry);

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
      entry,
      message: "updated direction",
    });

    expect(result.status).toBe("accepted");
    expect(result.sessionId).toBeTypeOf("string");
    expect(result.sessionId).not.toBe("old-child-session");
    const agentParams = agentCalls[0]?.params as { sessionId?: string } | undefined;
    expect(agentParams?.sessionId).toBe(result.sessionId);
  });

  it("does not steer while restart recovery owns the source row", async () => {
    const controllerSessionKey = "agent:main:main";
    const childSessionKey = "agent:main:subagent:steer-recovery-owner";
    const entry = createSubagentRunRecord({
      runId: "run-steer-recovery-owner",
      childSessionKey,
      controllerSessionKey,
      requesterSessionKey: controllerSessionKey,
      requesterDisplayKey: "main",
      task: "recovery-owned task",
      cleanup: "keep",
      createdAt: Date.now() - 2_000,
      execution: {
        status: "interrupted",
        startedAt: Date.now() - 1_000,
        restartRecovery: {
          sessionId: "sess",
          sessionMarker: "sess:1",
          idempotencyKey: "recovery-owned-id",
          phase: "reserved",
        },
      },
    });
    addSubagentRunForTests(entry);

    await expect(
      steerControlledSubagentRun({
        cfg: cfgWithSessionStore(),
        controller: {
          controllerSessionKey,
          callerSessionKey: controllerSessionKey,
          callerIsSubagent: false,
          controlScope: "children",
        },
        entry,
        message: "new steer",
      }),
    ).resolves.toMatchObject({
      status: "error",
      error: expect.stringContaining("restart already owns"),
    });
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

  it("uses one stable snapshot for listing and descendant counts", () => {
    const now = Date.now();
    const rootSessionKey = "agent:main:main";
    const parentSessionKey = "agent:main:subagent:status-parent";
    addSubagentRunForTests({
      runId: "run-status-parent",
      childSessionKey: parentSessionKey,
      controllerSessionKey: rootSessionKey,
      requesterSessionKey: rootSessionKey,
      requesterDisplayKey: rootSessionKey,
      task: "status parent",
      cleanup: "keep",
      createdAt: now - 4_000,
      startedAt: now - 3_500,
      endedAt: now - 3_000,
    });
    addSubagentRunForTests({
      runId: "run-status-child-1",
      childSessionKey: `${parentSessionKey}:subagent:child-1`,
      controllerSessionKey: parentSessionKey,
      requesterSessionKey: parentSessionKey,
      requesterDisplayKey: parentSessionKey,
      task: "status child 1",
      cleanup: "keep",
      createdAt: now - 2_000,
      startedAt: now - 1_500,
    });

    const context = buildControlledSubagentRunsReadContext(rootSessionKey);

    addSubagentRunForTests({
      runId: "run-status-child-2",
      childSessionKey: `${parentSessionKey}:subagent:child-2`,
      controllerSessionKey: parentSessionKey,
      requesterSessionKey: parentSessionKey,
      requesterDisplayKey: parentSessionKey,
      task: "status child 2",
      cleanup: "keep",
      createdAt: now - 1_000,
      startedAt: now - 500,
    });

    expect(context.runs.map((run) => run.runId)).toEqual(["run-status-parent"]);
    expect(context.countPendingDescendantRuns(parentSessionKey)).toBe(1);
    expect(
      buildControlledSubagentRunsReadContext(rootSessionKey).countPendingDescendantRuns(
        parentSessionKey,
      ),
    ).toBe(2);
  });

  it("partitions duplicate bare controller keys by owning agent", () => {
    const now = Date.now();
    for (const agentId of ["research", "ops"]) {
      addSubagentRunForTests({
        runId: `run-${agentId}`,
        childSessionKey: `agent:${agentId}:subagent:child`,
        controllerSessionKey: "global",
        requesterSessionKey: "global",
        requesterAgentId: agentId,
        requesterDisplayKey: "global",
        task: `${agentId} task`,
        cleanup: "keep",
        createdAt: now,
        startedAt: now,
      });
    }

    const cfg = {
      agents: {
        ownership: "explicit",
        entries: { research: {}, ops: {} },
      },
    } as OpenClawConfig;
    expect(listControlledSubagentRuns("global", "research", cfg).map((run) => run.runId)).toEqual([
      "run-research",
    ]);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
