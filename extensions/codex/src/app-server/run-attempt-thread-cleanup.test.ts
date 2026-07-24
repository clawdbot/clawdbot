// Codex tests cover run attempt thread cleanup plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  resetAgentEventsForTest,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import type { CodexServerNotification } from "./protocol.js";
import { runCodexAppServerAttempt } from "./run-attempt.js";
import {
  readCodexAppServerBinding,
  registerCodexTestSessionIdentity,
  resetCodexTestBindingStore,
  testCodexAppServerBindingStore,
} from "./session-binding.test-helpers.js";
import type { CodexAppServerClientFactory } from "./shared-client.js";
import {
  adaptCodexTestClientFactory,
  createCodexTestModel,
  type CodexTestAppServerClientFactory,
} from "./test-support.js";

// The keyed router, client runtime, and subagent monitor each add handlers on
// the physical client; single-slot mocks would keep only the last one.
function multiplexedClientFactory(
  factory: CodexTestAppServerClientFactory,
): CodexAppServerClientFactory {
  return adaptCodexTestClientFactory(async (...args) => {
    const client = await factory(...args);
    const notificationHandlers = new Set<Parameters<typeof client.addNotificationHandler>[0]>();
    const requestHandlers = new Set<Parameters<typeof client.addRequestHandler>[0]>();
    client.addNotificationHandler((notification) =>
      Promise.all(
        [...notificationHandlers].map((handler) => Promise.resolve(handler(notification))),
      ).then(() => undefined),
    );
    client.addRequestHandler(async (request) => {
      for (const handler of requestHandlers) {
        const result = await handler(request);
        if (result !== undefined) {
          return result;
        }
      }
      return undefined;
    });
    client.addNotificationHandler = (handler) => {
      notificationHandlers.add(handler);
      return () => notificationHandlers.delete(handler);
    };
    client.addRequestHandler = (handler) => {
      requestHandlers.add(handler);
      return () => requestHandlers.delete(handler);
    };
    return client;
  });
}

let tempDir: string;

function createParams(
  sessionFile: string,
  workspaceDir: string,
  sessionKey = "agent:main:session-1",
): EmbeddedRunAttemptParams {
  registerCodexTestSessionIdentity(sessionFile, "session-1", sessionKey);
  return {
    prompt: "hello",
    sessionId: "session-1",
    sessionKey,
    sessionFile,
    workspaceDir,
    runId: "run-1",
    provider: "codex",
    modelId: "gpt-5.4-codex",
    model: createCodexTestModel("codex"),
    thinkLevel: "medium",
    disableTools: true,
    timeoutMs: 5_000,
    authStorage: {} as never,
    authProfileStore: { version: 1, profiles: {} },
    modelRegistry: {} as never,
  } as EmbeddedRunAttemptParams;
}

function threadStartResult(threadId = "thread-1") {
  return {
    thread: {
      id: threadId,
      sessionId: "session-1",
      forkedFromId: null,
      preview: "",
      ephemeral: false,
      modelProvider: "openai",
      createdAt: 1,
      updatedAt: 1,
      status: { type: "idle" },
      path: null,
      cwd: tempDir || "/tmp/openclaw-codex-test",
      cliVersion: "0.125.0",
      source: "unknown",
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: [],
    },
    model: "gpt-5.4-codex",
    modelProvider: "openai",
    serviceTier: null,
    cwd: tempDir || "/tmp/openclaw-codex-test",
    instructionSources: [],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
    permissionProfile: null,
    reasoningEffort: null,
  };
}

function turnStartResult(turnId = "turn-1") {
  return {
    turn: {
      id: turnId,
      status: "inProgress",
      items: [],
      error: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
    },
  };
}

function getMockServerVersion() {
  return "0.132.0";
}

function getMockRuntimeIdentity() {
  return { serverVersion: getMockServerVersion() };
}

function mockClientRuntimeMethods() {
  return {
    getInstanceId: () => "test-client-1",
    getRuntimeIdentity: getMockRuntimeIdentity,
    getServerVersion: getMockServerVersion,
  };
}

describe("Codex app-server main thread cleanup", () => {
  beforeEach(async () => {
    resetCodexTestBindingStore();
    vi.useRealTimers();
    resetAgentEventsForTest();
    vi.stubEnv("OPENCLAW_TRAJECTORY", "0");
    vi.stubEnv("CODEX_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-run-cleanup-"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    resetAgentEventsForTest();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("unsubscribes the main Codex thread after a completed turn", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const requests: Array<{ method: string; params: unknown }> = [];
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
    const request = vi.fn(async (method: string, params?: unknown) => {
      requests.push({ method, params });
      if (method === "thread/start") {
        return threadStartResult();
      }
      if (method === "turn/start") {
        return turnStartResult();
      }
      return {};
    });

    const clientFactory: CodexAppServerClientFactory = multiplexedClientFactory(async () => {
      return {
        ...mockClientRuntimeMethods(),
        request,
        addNotificationHandler: (handler: typeof notify) => {
          notify = handler;
          return () => undefined;
        },
        addRequestHandler: () => () => undefined,
        addCloseHandler: () => () => undefined,
      } as never;
    });

    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), {
      bindingStore: testCodexAppServerBindingStore,
      clientFactory,
    });
    await vi.waitFor(() => expect(requests.map((entry) => entry.method)).toContain("turn/start"), {
      interval: 1,
      timeout: 5_000,
    });
    await notify({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        turn: { id: "turn-1", status: "completed" },
      },
    });

    const result = await run;
    expect(readAttemptTerminal(result).aborted).toBe(false);
    expect(request).toHaveBeenCalledWith(
      "thread/unsubscribe",
      { threadId: "thread-1" },
      { timeoutMs: 5_000 },
    );
    expect(requests.map((entry) => entry.method)).toEqual([
      "thread/start",
      "turn/start",
      "thread/unsubscribe",
    ]);
  });

  it("keeps an incognito thread subscribed for live in-process reuse", async () => {
    const sessionFile = path.join(tempDir, "incognito-session.jsonl");
    const workspaceDir = path.join(tempDir, "incognito-workspace");
    const sessionKey = "agent:main:dashboard:incognito-live-thread";
    const requests: Array<{ method: string; params: unknown }> = [];
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
    const request = vi.fn(async (method: string, params?: unknown) => {
      requests.push({ method, params });
      if (method === "thread/start") {
        return threadStartResult();
      }
      if (method === "turn/start") {
        return turnStartResult();
      }
      return {};
    });
    const clientFactory: CodexAppServerClientFactory = multiplexedClientFactory(async () => {
      return {
        ...mockClientRuntimeMethods(),
        request,
        addNotificationHandler: (handler: typeof notify) => {
          notify = handler;
          return () => undefined;
        },
        addRequestHandler: () => () => undefined,
        addCloseHandler: () => () => undefined,
      } as never;
    });

    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir, sessionKey), {
      bindingStore: testCodexAppServerBindingStore,
      clientFactory,
    });
    await vi.waitFor(() => expect(requests.map((entry) => entry.method)).toContain("turn/start"), {
      interval: 1,
      timeout: 5_000,
    });
    await notify({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        turn: { id: "turn-1", status: "completed" },
      },
    });

    await expect(run).resolves.toMatchObject({ aborted: false, timedOut: false });
    expect(requests.map((entry) => entry.method)).toEqual(["thread/start", "turn/start"]);
    expect(requests[0]?.params).toEqual(expect.objectContaining({ ephemeral: true }));
  });

  it("unsubscribes an incognito Codex thread when turn start fails", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const sessionKey = "agent:main:dashboard:incognito-failed-turn";
    const requests: Array<{ method: string; params: unknown }> = [];
    const request = vi.fn(async (method: string, params?: unknown) => {
      requests.push({ method, params });
      if (method === "thread/start") {
        return threadStartResult();
      }
      if (method === "turn/start") {
        throw new Error("turn start exploded");
      }
      return {};
    });

    const clientFactory: CodexAppServerClientFactory = multiplexedClientFactory(async () => {
      return {
        ...mockClientRuntimeMethods(),
        request,
        addNotificationHandler: () => () => undefined,
        addRequestHandler: () => () => undefined,
        addCloseHandler: () => () => undefined,
      } as never;
    });

    await expect(
      runCodexAppServerAttempt(createParams(sessionFile, workspaceDir, sessionKey), {
        bindingStore: testCodexAppServerBindingStore,
        clientFactory,
      }),
    ).rejects.toThrow("turn start exploded");
    expect(requests.map((entry) => entry.method)).toEqual([
      "thread/start",
      "turn/start",
      "thread/unsubscribe",
    ]);
    expect(request).toHaveBeenCalledWith(
      "thread/unsubscribe",
      { threadId: "thread-1" },
      { timeoutMs: 5_000 },
    );
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toBeUndefined();
  });
});
