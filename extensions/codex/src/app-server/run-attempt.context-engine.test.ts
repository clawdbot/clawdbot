import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness";
import {
  embeddedAgentLog,
  type HarnessContextEngine as ContextEngine,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    authProfileStore: { version: 1, profiles: {} },
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
      await vi.waitFor(() => expect(requests.map((entry) => entry.method)).toContain(method), {
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

function createContextEngine(overrides: Partial<ContextEngine> = {}): ContextEngine {
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
  return engine;
}

type MockCallReader = { mock: { calls: unknown[][] } };

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label} to be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function requireFirstCallArg(mock: unknown, label: string): unknown {
  const call = (mock as MockCallReader).mock.calls.at(0);
  if (!call) {
    throw new Error(`expected ${label} to be called`);
  }
  return call[0];
}

function requireRequestParams(
  harness: ReturnType<typeof createStartedThreadHarness>,
  method: string,
): Record<string, unknown> {
  const request = harness.requests.find((entry) => entry.method === method);
  return requireRecord(request?.params, `${method} params`);
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`expected ${label} to be an array`);
  }
  return value;
}

function expectRequestInputTextContains(
  harness: ReturnType<typeof createStartedThreadHarness>,
  expected: string,
): void {
  expect(getRequestInputText(harness)).toContain(expected);
}

function getRequestInputText(harness: ReturnType<typeof createStartedThreadHarness>): string {
  const params = requireRequestParams(harness, "turn/start");
  const input = requireArray(params.input, "turn/start input");
  return input
    .map((entry) => {
      const item = requireRecord(entry, "turn/start input entry");
      return item.type === "text" ? optionalString(item.text) : "";
    })
    .join("\n");
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
    const openSpy = vi.spyOn(SessionManager, "open");
    const contextEngine = createContextEngine();
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = contextEngine;
    params.contextTokenBudget = 321;
    params.config = { memory: { citations: "on" } } as EmbeddedRunAttemptParams["config"];

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    if (!contextEngine.bootstrap) {
      throw new Error("expected bootstrap hook");
    }
    expect(contextEngine.bootstrap).toHaveBeenCalledTimes(1);
    const bootstrapParams = requireFirstCallArg(contextEngine.bootstrap, "bootstrap") as Parameters<
      NonNullable<ContextEngine["bootstrap"]>
    >[0];
    expect(bootstrapParams.sessionId).toBe("session-1");
    expect(bootstrapParams.sessionKey).toBe("agent:main:session-1");
    expect(bootstrapParams.sessionFile).toBe(sessionFile);

    expect(contextEngine.assemble).toHaveBeenCalledTimes(1);
    const assembleParams = requireFirstCallArg(contextEngine.assemble, "assemble") as Parameters<
      ContextEngine["assemble"]
    >[0];
    expect(assembleParams.sessionId).toBe("session-1");
    expect(assembleParams.sessionKey).toBe("agent:main:session-1");
    expect(assembleParams.tokenBudget).toBe(321);
    expect(assembleParams.citationsMode).toBe("on");
    expect(assembleParams.model).toBe("gpt-5.4-codex");
    expect(assembleParams.prompt).toBe("hello");
    expect(assembleParams.messages.map((message) => message.role)).toEqual(["assistant"]);
    expect(assembleParams.availableTools).toEqual(new Set());

    const threadStartParams = requireRequestParams(harness, "thread/start");
    expect(optionalString(threadStartParams.developerInstructions)).toContain(
      "context-engine system",
    );
    expectRequestInputTextContains(harness, "OpenClaw assembled context for this turn:");

    await harness.completeTurn();
    await run;
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("uses the runtime token budget for large Codex context-engine projections", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const longContext = `large LCM context start ${"x".repeat(30_000)} LARGE_CONTEXT_END`;
    const contextEngine = createContextEngine({
      assemble: vi.fn(async () => ({
        messages: [assistantMessage(longContext, 10)],
        estimatedTokens: 10_000,
        systemPromptAddition: "context-engine system",
      })),
    });
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = contextEngine;
    params.contextTokenBudget = 80_000;

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    const inputText = getRequestInputText(harness);
    expect(inputText.length).toBeGreaterThan(30_000);
    expect(inputText).toContain("LARGE_CONTEXT_END");
    expect(inputText).not.toContain("[truncated ");

    await harness.completeTurn();
    await run;
  });

  it("uses configured compaction reserve when sizing Codex context-engine projections", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const longContext = `configured reserve context start ${"x".repeat(30_000)} CONFIG_END`;
    const contextEngine = createContextEngine({
      assemble: vi.fn(async () => ({
        messages: [assistantMessage(longContext, 10)],
        estimatedTokens: 10_000,
        systemPromptAddition: "context-engine system",
      })),
    });
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = contextEngine;
    params.contextTokenBudget = 80_000;
    params.config = {
      agents: { defaults: { compaction: { reserveTokens: 60_000, reserveTokensFloor: 0 } } },
    } as EmbeddedRunAttemptParams["config"];

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    const inputText = getRequestInputText(harness);
    expect(inputText).toContain("configured reserve context start");
    expect(inputText).toContain("[truncated ");
    expect(inputText).not.toContain("CONFIG_END");

    await harness.completeTurn();
    await run;
  });

  it("keeps current-turn context at the front of the Codex context-engine prompt", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    SessionManager.open(sessionFile).appendMessage(
      assistantMessage("older context", Date.now()) as never,
    );
    const contextEngine = createContextEngine();
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = contextEngine;
    params.currentTurnContext = {
      text: [
        "Conversation context (untrusted, chronological, selected for current message):",
        "#6474 Sun 2026-05-10 22:22 GMT+5:30 [reply target] OpenClaw: anchor REPLYCTX this is the old message",
        "#6498 Sun 2026-05-10 22:22 GMT+5:30 OpenClaw: filler REPLYCTX 23",
      ].join("\n"),
    };

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    const inputText = getRequestInputText(harness);
    expect(inputText).toContain("OpenClaw assembled context for this turn:");
    expect(inputText).toContain("Current user request:\nhello");
    expect(inputText).toContain("[reply target] OpenClaw: anchor REPLYCTX");
    expect(inputText.trim().startsWith("Conversation context (untrusted")).toBe(true);

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
    const afterTurnCall = requireFirstCallArg(afterTurn, "afterTurn") as Parameters<
      NonNullable<ContextEngine["afterTurn"]>
    >[0];
    expect(afterTurnCall.sessionId).toBe("session-1");
    expect(afterTurnCall.sessionKey).toBe("agent:main:session-1");
    expect(afterTurnCall.prePromptMessageCount).toBe(0);
    expect(afterTurnCall.tokenBudget).toBe(111);
    expect(afterTurnCall.messages.some((message) => message.role === "user")).toBe(true);
    expect(afterTurnCall.messages.some((message) => message.role === "assistant")).toBe(true);
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

    const assembleParams = requireFirstCallArg(contextEngine.assemble, "assemble") as Parameters<
      ContextEngine["assemble"]
    >[0];
    expect(assembleParams.messages.map((message) => message.role)).toEqual([
      "assistant",
      "assistant",
    ]);
    const afterTurnParams = requireFirstCallArg(afterTurn, "afterTurn") as Parameters<
      NonNullable<ContextEngine["afterTurn"]>
    >[0];
    expect(afterTurnParams.prePromptMessageCount).toBe(2);
    expectRequestInputTextContains(harness, "bootstrap context");
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

    const warning = warn.mock.calls.find(
      ([message]) => message === "context engine assemble failed; using Codex baseline prompt",
    );
    const details = requireRecord(warning?.[1], "assemble warning details");
    expect(typeof details.error).toBe("string");
    expect(warning?.[1]).not.toEqual({ error: rawError });
    expect(String(details.error)).not.toContain("sk-abcdefghijklmnopqrstuv");
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
