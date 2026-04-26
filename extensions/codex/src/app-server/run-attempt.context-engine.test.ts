import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextEngine } from "../../../../src/context-engine/types.js";
import type { CodexServerNotification } from "./protocol.js";
import { runCodexAppServerAttempt, __testing } from "./run-attempt.js";
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
    modelRegistry: {} as never,
  } as EmbeddedRunAttemptParams;
}

function assistantMessage(text: string, timestamp: number): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "gpt-5.4-codex",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  };
}

function userMessage(text: string, timestamp: number): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp,
  } as AgentMessage;
}

function threadStartResult(threadId = "thread-1") {
  return {
    thread: {
      id: threadId,
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

function turnStartResult(turnId = "turn-1", status = "inProgress") {
  return {
    turn: {
      id: turnId,
      status,
      items: [],
      error: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
    },
  };
}

function createStartedThreadHarness(
  requestImpl: (method: string, params: unknown) => Promise<unknown> = async () => undefined,
) {
  const requests: Array<{ method: string; params: unknown }> = [];
  let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
  const request = vi.fn(async (method: string, params?: unknown) => {
    requests.push({ method, params });
    const override = await requestImpl(method, params);
    if (override !== undefined) {
      return override;
    }
    if (method === "thread/start") {
      return threadStartResult();
    }
    if (method === "turn/start") {
      return turnStartResult();
    }
    return {};
  });

  __testing.setCodexAppServerClientFactoryForTests(
    async () =>
      ({
        request,
        addNotificationHandler: (handler: typeof notify) => {
          notify = handler;
          return () => undefined;
        },
        addRequestHandler: () => () => undefined,
      }) as never,
  );

  return {
    requests,
    async waitForMethod(method: string) {
      await vi.waitFor(() => expect(requests.some((entry) => entry.method === method)).toBe(true), {
        interval: 1,
      });
    },
    async notify(notification: CodexServerNotification) {
      await notify(notification);
    },
    async completeTurn(status: "completed" | "failed" = "completed") {
      await notify({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: {
            id: "turn-1",
            status,
            ...(status === "failed" ? { error: { message: "codex failed" } } : {}),
            items: [{ type: "agentMessage", id: "msg-1", text: "final answer" }],
          },
        },
      });
    },
  };
}

type MockContextEngine = ContextEngine & {
  bootstrap: ReturnType<typeof vi.fn>;
  assemble: ReturnType<typeof vi.fn>;
  maintain: ReturnType<typeof vi.fn>;
  afterTurn?: ReturnType<typeof vi.fn>;
  ingestBatch?: ReturnType<typeof vi.fn>;
  ingest?: ReturnType<typeof vi.fn>;
};

function createContextEngine(overrides: Partial<ContextEngine> = {}): MockContextEngine {
  const engine: ContextEngine = {
    info: {
      id: "lossless-claw",
      name: "Lossless Claw",
      ownsCompaction: true,
    },
    bootstrap: vi.fn(async () => ({ bootstrapped: true })),
    assemble: vi.fn(async ({ messages, prompt }) => ({
      messages: [...messages, userMessage(prompt ?? "", 10)],
      estimatedTokens: 42,
      systemPromptAddition: "context-engine system",
    })),
    ingest: vi.fn(async () => ({ ingested: true })),
    maintain: vi.fn(async () => ({ changed: false, bytesFreed: 0, rewrittenEntries: 0 })),
    compact: vi.fn(async () => ({
      ok: true,
      compacted: true,
      result: { summary: "summary", firstKeptEntryId: "entry-1", tokensBefore: 10 },
    })),
    ...overrides,
  };
  return engine as MockContextEngine;
}

describe("runCodexAppServerAttempt context-engine lifecycle", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-context-engine-"));
  });

  afterEach(async () => {
    __testing.resetCodexAppServerClientFactoryForTests();
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("bootstraps and assembles non-legacy context before the Codex turn starts", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    SessionManager.open(sessionFile).appendMessage(
      assistantMessage("existing context", Date.now()) as never,
    );
    const contextEngine = createContextEngine();
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = contextEngine;
    params.contextTokenBudget = 321;
    params.config = { memory: { citations: "on" } } as EmbeddedRunAttemptParams["config"];

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    expect(contextEngine.bootstrap).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        sessionFile,
      }),
    );
    expect(contextEngine.assemble).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        tokenBudget: 321,
        citationsMode: "on",
        model: "gpt-5.4-codex",
        prompt: "hello",
        messages: [expect.objectContaining({ role: "assistant" })],
        availableTools: new Set(),
      }),
    );
    expect(harness.requests).toEqual(
      expect.arrayContaining([
        {
          method: "thread/start",
          params: expect.objectContaining({
            developerInstructions: expect.stringContaining("context-engine system"),
          }),
        },
        {
          method: "turn/start",
          params: expect.objectContaining({
            input: expect.arrayContaining([
              expect.objectContaining({
                type: "text",
                text: expect.stringContaining("OpenClaw assembled context for this turn:"),
              }),
            ]),
          }),
        },
      ]),
    );

    await harness.completeTurn();
    await run;
  });

  it("calls afterTurn with the mirrored transcript and runs turn maintenance", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const afterTurn = vi.fn(
      async (_params: Parameters<NonNullable<ContextEngine["afterTurn"]>>[0]) => undefined,
    );
    const maintain = vi.fn(async () => ({ changed: false, bytesFreed: 0, rewrittenEntries: 0 }));
    const contextEngine = createContextEngine({ afterTurn, maintain, bootstrap: undefined });
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = contextEngine;
    params.contextTokenBudget = 111;

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.completeTurn();
    await run;

    expect(afterTurn).toHaveBeenCalledTimes(1);
    const afterTurnCall = afterTurn.mock.calls.at(0)?.[0];
    expect(afterTurnCall).toMatchObject({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      prePromptMessageCount: 0,
      tokenBudget: 111,
    });
    expect(afterTurnCall?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user" }),
        expect.objectContaining({ role: "assistant" }),
      ]),
    );
    expect(maintain).toHaveBeenCalledTimes(1);
  });

  it("reloads mirrored history after bootstrap mutates the session transcript", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    SessionManager.open(sessionFile).appendMessage(
      assistantMessage("existing context", Date.now()) as never,
    );
    const afterTurn = vi.fn(
      async (_params: Parameters<NonNullable<ContextEngine["afterTurn"]>>[0]) => undefined,
    );
    const bootstrap = vi.fn(
      async ({ sessionFile: file }: Parameters<NonNullable<ContextEngine["bootstrap"]>>[0]) => {
        SessionManager.open(file).appendMessage(
          assistantMessage("bootstrap context", Date.now() + 1) as never,
        );
        return { bootstrapped: true };
      },
    );
    const contextEngine = createContextEngine({
      bootstrap,
      afterTurn,
      maintain: undefined,
    });
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = contextEngine;

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.completeTurn();
    await run;

    expect(contextEngine.assemble).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({ role: "assistant" }),
          expect.objectContaining({ role: "assistant" }),
        ],
      }),
    );
    expect(afterTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        prePromptMessageCount: 2,
      }),
    );
    const turnStart = harness.requests.find((request) => request.method === "turn/start");
    expect(turnStart?.params).toEqual(
      expect.objectContaining({
        input: expect.arrayContaining([
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining("bootstrap context"),
          }),
        ]),
      }),
    );
  });

  it("logs assemble failures as a formatted message instead of the raw error object", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const rawError = new Error("Authorization: Bearer sk-abcdefghijklmnopqrstuv");
    const contextEngine = createContextEngine({
      assemble: vi.fn(async () => {
        throw rawError;
      }),
      bootstrap: undefined,
    });
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = contextEngine;

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.completeTurn();
    await run;

    expect(warn).toHaveBeenCalledWith(
      "context engine assemble failed; using Codex baseline prompt",
      {
        error: expect.any(String),
      },
    );
    const warning = warn.mock.calls.find(
      ([message]) => message === "context engine assemble failed; using Codex baseline prompt",
    );
    expect(warning?.[1]).not.toEqual({ error: rawError });
    expect(String((warning?.[1] as { error?: unknown } | undefined)?.error)).not.toContain(
      "sk-abcdefghijklmnopqrstuv",
    );
  });

  it("falls back to ingestBatch and skips turn maintenance on prompt failure", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const ingestBatch = vi.fn(async () => ({ ingestedCount: 2 }));
    const maintain = vi.fn(async () => ({ changed: false, bytesFreed: 0, rewrittenEntries: 0 }));
    const contextEngine = createContextEngine({
      afterTurn: undefined,
      ingestBatch,
      maintain,
      bootstrap: undefined,
    });
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = contextEngine;

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.completeTurn("failed");
    await run;

    expect(ingestBatch).toHaveBeenCalledTimes(1);
    expect(maintain).not.toHaveBeenCalled();
  });
});
