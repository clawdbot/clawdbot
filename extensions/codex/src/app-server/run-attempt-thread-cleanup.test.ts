import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  resetAgentEventsForTest,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerClientFactory } from "./client-factory.js";
import type { CodexServerNotification } from "./protocol.js";
import { runCodexAppServerAttempt } from "./run-attempt.js";
import { createCodexTestModel } from "./test-support.js";

let tempDir: string;

function createParams(sessionFile: string, workspaceDir: string): EmbeddedRunAttemptParams {
  return {
    prompt: "hello",
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
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

describe("Codex app-server main thread cleanup", () => {
  beforeEach(async () => {
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

    const clientFactory: CodexAppServerClientFactory = async () => {
      return {
        request,
        addNotificationHandler: (handler: typeof notify) => {
          notify = handler;
          return () => undefined;
        },
        addRequestHandler: () => () => undefined,
      } as never;
    };

    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), {
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
    expect(result.aborted).toBe(false);
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

  it("unsubscribes the main Codex thread when turn start fails", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
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

    const clientFactory: CodexAppServerClientFactory = async () => {
      return {
        request,
        addNotificationHandler: () => () => undefined,
        addRequestHandler: () => () => undefined,
      } as never;
    };

    await expect(
      runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), {
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
  });
});
