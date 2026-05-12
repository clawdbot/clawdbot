import fs from "node:fs";
import path from "node:path";
import { withTempHome as withTempHomeBase } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "./agent-command.test-mocks.js";
import * as acpManagerModule from "../acp/control-plane/manager.js";
import { AcpRuntimeError } from "../acp/runtime/errors.js";
import * as embeddedModule from "../agents/pi-embedded.js";
import * as configIoModule from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import { agentCommand } from "./agent.js";
import { createThrowingTestRuntime } from "./test-runtime-config-helpers.js";

const agentEventMocks = vi.hoisted(() => {
  type AgentEvent = { stream: string; data?: Record<string, unknown>; runId?: string };
  const handlers = new Set<(event: AgentEvent) => void>();
  return {
    clearAgentRunContext: vi.fn(),
    emitAgentEvent: vi.fn((event: AgentEvent) => {
      for (const handler of handlers) {
        handler(event);
      }
    }),
    onAgentEvent: vi.fn((handler: (event: AgentEvent) => void) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    }),
    registerAgentRunContext: vi.fn(),
  };
});

const attemptExecutionMocks = vi.hoisted(() => ({
  emitAcpLifecycleStart: vi.fn(),
  emitAcpLifecycleEnd: vi.fn(),
  emitAcpLifecycleError: vi.fn(),
  persistAcpTurnTranscript: vi.fn(
    async ({ sessionEntry }: { sessionEntry?: unknown }) => sessionEntry,
  ),
}));

vi.mock("../infra/agent-events.js", () => agentEventMocks);

vi.mock("../agents/command/delivery.runtime.js", () => ({
  deliverAgentCommandResult: vi.fn(
    async (params: { runtime: RuntimeEnv; payloads?: Array<{ text?: string }> }) => {
      for (const payload of params.payloads ?? []) {
        if (payload.text) {
          params.runtime.log(payload.text);
        }
      }
    },
  ),
}));

vi.mock("../agents/command/attempt-execution.runtime.js", () => {
  const createAcpVisibleTextAccumulator = () => {
    let text = "";
    return {
      consume(chunk: string) {
        if (!chunk || chunk === "NO_REPLY") {
          return null;
        }
        text += chunk;
        return { text, delta: chunk };
      },
      finalize: () => text.trim(),
      finalizeRaw: () => text,
    };
  };

  return {
    createAcpVisibleTextAccumulator,
    emitAcpLifecycleStart: attemptExecutionMocks.emitAcpLifecycleStart,
    emitAcpLifecycleEnd: attemptExecutionMocks.emitAcpLifecycleEnd,
    emitAcpLifecycleError: attemptExecutionMocks.emitAcpLifecycleError,
    emitAcpAssistantDelta: ({
      runId,
      text,
      delta,
    }: {
      runId: string;
      text: string;
      delta: string;
    }) =>
      agentEventMocks.emitAgentEvent({
        runId,
        stream: "assistant",
        data: { text, delta },
      }),
    buildAcpResult: ({
      payloadText,
      startedAt,
      stopReason,
      abortSignal,
    }: {
      payloadText: string;
      startedAt: number;
      stopReason?: string;
      abortSignal?: AbortSignal;
    }) => ({
      payloads: payloadText ? [{ text: payloadText }] : [],
      meta: {
        durationMs: Date.now() - startedAt,
        aborted: abortSignal?.aborted === true,
        stopReason,
      },
    }),
    persistAcpTurnTranscript: attemptExecutionMocks.persistAcpTurnTranscript,
  };
});

const loadConfigSpy = vi.spyOn(configIoModule, "loadConfig");
const runEmbeddedPiAgentSpy = vi.spyOn(embeddedModule, "runEmbeddedPiAgent");
const getAcpSessionManagerSpy = vi.spyOn(acpManagerModule, "getAcpSessionManager");

const runtime = createThrowingTestRuntime();

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(fn, { prefix: "openclaw-agent-acp-" });
}

function createAcpEnabledConfig(home: string, storePath: string): OpenClawConfig {
  return {
    acp: {
      enabled: true,
      backend: "acpx",
      allowedAgents: ["codex", "kimi"],
      dispatch: { enabled: true },
    },
    agents: {
      defaults: {
        model: { primary: "openai/gpt-5.5" },
        models: { "openai/gpt-5.5": {} },
        workspace: path.join(home, "openclaw"),
      },
    },
    session: { store: storePath, mainKey: "main" },
  };
}

function mockConfig(home: string, storePath: string) {
  const cfg = createAcpEnabledConfig(home, storePath);
  loadConfigSpy.mockReturnValue(cfg);
  configIoModule.setRuntimeConfigSnapshot(cfg, cfg);
}

function mockConfigWithAcpOverrides(
  home: string,
  storePath: string,
  acpOverrides: Partial<NonNullable<OpenClawConfig["acp"]>>,
) {
  const cfg = createAcpEnabledConfig(home, storePath);
  cfg.acp = {
    ...cfg.acp,
    ...acpOverrides,
  };
  loadConfigSpy.mockReturnValue(cfg);
  configIoModule.setRuntimeConfigSnapshot(cfg, cfg);
}

function writeAcpSessionStore(storePath: string, agent = "codex") {
  const sessionKey = `agent:${agent}:acp:test`;
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(
    storePath,
    JSON.stringify({
      [sessionKey]: {
        sessionId: "acp-session-1",
        updatedAt: Date.now(),
        acp: {
          backend: "acpx",
          agent,
          runtimeSessionName: sessionKey,
          mode: "oneshot",
          state: "idle",
          lastActivityAt: Date.now(),
        },
      },
    }),
  );
}

function resolveReadySession(
  sessionKey: string,
  agent = "codex",
): ReturnType<ReturnType<typeof acpManagerModule.getAcpSessionManager>["resolveSession"]> {
  return {
    kind: "ready",
    sessionKey,
    meta: {
      backend: "acpx",
      agent,
      runtimeSessionName: sessionKey,
      mode: "oneshot",
      state: "idle",
      lastActivityAt: Date.now(),
    },
  };
}

function mockAcpManager(params: {
  runTurn: (params: unknown) => Promise<void>;
  resolveSession?: (params: {
    cfg: OpenClawConfig;
    sessionKey: string;
  }) => ReturnType<ReturnType<typeof acpManagerModule.getAcpSessionManager>["resolveSession"]>;
}) {
  getAcpSessionManagerSpy.mockReturnValue({
    runTurn: params.runTurn,
    resolveSession:
      params.resolveSession ??
      ((input) => {
        return resolveReadySession(input.sessionKey);
      }),
  } as unknown as ReturnType<typeof acpManagerModule.getAcpSessionManager>);
}

async function withAcpSessionEnv(fn: () => Promise<void>) {
  await withTempHome(async (home) => {
    const storePath = path.join(home, "sessions.json");
    writeAcpSessionStore(storePath);
    mockConfig(home, storePath);
    await fn();
  });
}

async function withAcpSessionEnvInfo(
  fn: (env: { home: string; storePath: string }) => Promise<void>,
) {
  await withTempHome(async (home) => {
    const storePath = path.join(home, "sessions.json");
    writeAcpSessionStore(storePath);
    mockConfig(home, storePath);
    await fn({ home, storePath });
  });
}

function createRunTurnFromTextDeltas(chunks: string[]) {
  return vi.fn(async (paramsUnknown: unknown) => {
    const params = paramsUnknown as {
      onEvent?: (event: { type: string; text?: string; stopReason?: string }) => Promise<void>;
    };
    for (const text of chunks) {
      await params.onEvent?.({ type: "text_delta", text });
    }
    await params.onEvent?.({ type: "done", stopReason: "stop" });
  });
}

function subscribeAssistantEvents() {
  const assistantEvents: Array<{ text?: string; delta?: string }> = [];
  const stop = agentEventMocks.onAgentEvent((evt) => {
    if (evt.stream !== "assistant") {
      return;
    }
    assistantEvents.push({
      text: typeof evt.data?.text === "string" ? evt.data.text : undefined,
      delta: typeof evt.data?.delta === "string" ? evt.data.delta : undefined,
    });
  });
  return { assistantEvents, stop };
}

async function runAcpTurnWithAssistantEvents(chunks: string[]) {
  const { assistantEvents, stop } = subscribeAssistantEvents();
  const runTurn = createRunTurnFromTextDeltas(chunks);

  mockAcpManager({
    runTurn: (params: unknown) => runTurn(params),
  });

  try {
    vi.mocked(runtime.log).mockClear();
    await agentCommand({ message: "ping", sessionKey: "agent:codex:acp:test" }, runtime);
  } finally {
    stop();
  }

  const logLines = vi.mocked(runtime.log).mock.calls.map(([first]) => String(first));
  return { assistantEvents, logLines };
}

async function runAcpTurnWithTextDeltas(params: { message?: string; chunks: string[] }) {
  const runTurn = createRunTurnFromTextDeltas(params.chunks);
  mockAcpManager({
    runTurn: (input: unknown) => runTurn(input),
  });
  await agentCommand(
    {
      message: params.message ?? "ping",
      sessionKey: "agent:codex:acp:test",
    },
    runtime,
  );
  return { runTurn };
}

function expectPersistedAcpTranscript(params: { userContent: string; assistantText: string }) {
  const transcript = attemptExecutionMocks.persistAcpTurnTranscript.mock.calls.at(-1)?.[0] as
    | { body?: string; finalText?: string }
    | undefined;
  expect(transcript?.body).toBe(params.userContent);
  expect(transcript?.finalText).toBe(params.assistantText);
}

async function runAcpSessionWithPolicyOverridesAndExpectBlocked(params: {
  acpOverrides: Partial<NonNullable<OpenClawConfig["acp"]>>;
  resolveSession?: Parameters<typeof mockAcpManager>[0]["resolveSession"];
}) {
  await withTempHome(async (home) => {
    const storePath = path.join(home, "sessions.json");
    writeAcpSessionStore(storePath);
    mockConfigWithAcpOverrides(home, storePath, params.acpOverrides);

    const runTurn = vi.fn(async (_params: unknown) => {});
    mockAcpManager({
      runTurn: (input: unknown) => runTurn(input),
      ...(params.resolveSession ? { resolveSession: params.resolveSession } : {}),
    });

    await expectAcpCommandRejects("agent:codex:acp:test", "ACP_DISPATCH_DISABLED");
    expect(runTurn).not.toHaveBeenCalled();
    expect(runEmbeddedPiAgentSpy).not.toHaveBeenCalled();
  });
}

async function expectAcpCommandRejects(
  sessionKey: string,
  code: string,
  messageIncludes?: string,
): Promise<void> {
  try {
    await agentCommand({ message: "ping", sessionKey }, runtime);
  } catch (error) {
    const acpError = error as { code?: string; message?: string };
    expect(acpError.code).toBe(code);
    if (messageIncludes) {
      expect(acpError.message).toContain(messageIncludes);
    }
    return;
  }
  throw new Error(`Expected ACP command to reject with ${code}`);
}

describe("agentCommand ACP runtime routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runEmbeddedPiAgentSpy.mockResolvedValue({
      payloads: [{ text: "embedded" }],
      meta: {
        durationMs: 5,
      },
    } as never);
  });

  it("routes ACP sessions and preserves exact transcript text", async () => {
    await withAcpSessionEnvInfo(async () => {
      const { runTurn } = await runAcpTurnWithTextDeltas({
        message: "  ping\n",
        chunks: ["  ACP_OK\n"],
      });
      const runTurnInput = runTurn.mock.calls.at(0)?.[0] as
        | { mode?: string; sessionKey?: string; text?: string }
        | undefined;
      expect(runTurnInput?.sessionKey).toBe("agent:codex:acp:test");
      expect(runTurnInput?.text).toBe("  ping\n");
      expect(runTurnInput?.mode).toBe("prompt");
      expect(runEmbeddedPiAgentSpy).not.toHaveBeenCalled();
      const hasAckLog = vi
        .mocked(runtime.log)
        .mock.calls.some(([first]) => typeof first === "string" && first.includes("ACP_OK"));
      expect(hasAckLog).toBe(true);
      expectPersistedAcpTranscript({
        userContent: "  ping\n",
        assistantText: "  ACP_OK\n",
      });
    });
  });

  it("streams ACP visible text deltas", async () => {
    await withAcpSessionEnv(async () => {
      const repeated = await runAcpTurnWithAssistantEvents(["bo", "ok"]);

      expect(repeated.assistantEvents).toEqual([
        { text: "bo", delta: "bo" },
        { text: "book", delta: "ok" },
      ]);
      expect(repeated.logLines.some((line) => line.includes("book"))).toBe(true);
    });
  });

  it("keeps no-reply ACP turns silent", async () => {
    await withAcpSessionEnv(async () => {
      const { assistantEvents, logLines } = await runAcpTurnWithAssistantEvents(["NO_REPLY"]);

      expect(assistantEvents.every((event) => !event.text)).toBe(true);
      expect(logLines.some((line) => line.includes("NO_REPLY"))).toBe(false);
      expect(logLines).toStrictEqual([]);
    });
  });

  it("fails closed for ACP-shaped session keys missing ACP metadata", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      fs.writeFileSync(
        storePath,
        JSON.stringify({
          "agent:codex:acp:stale": {
            sessionId: "stale-1",
            updatedAt: Date.now(),
          },
        }),
      );
      mockConfig(home, storePath);

      const runTurn = vi.fn(async (_params: unknown) => {});
      mockAcpManager({
        runTurn: (params: unknown) => runTurn(params),
        resolveSession: ({ sessionKey }) => {
          return {
            kind: "stale",
            sessionKey,
            error: new AcpRuntimeError(
              "ACP_SESSION_INIT_FAILED",
              `ACP metadata is missing for session ${sessionKey}.`,
            ),
          };
        },
      });

      await expectAcpCommandRejects(
        "agent:codex:acp:stale",
        "ACP_SESSION_INIT_FAILED",
        "ACP metadata is missing",
      );
      expect(runTurn).not.toHaveBeenCalled();
      expect(runEmbeddedPiAgentSpy).not.toHaveBeenCalled();
    });
  });

  it("blocks ACP turns when disabled by policy", async () => {
    for (const acpOverrides of [
      { enabled: false },
      { dispatch: { enabled: false } },
    ] satisfies Array<Partial<NonNullable<OpenClawConfig["acp"]>>>) {
      await runAcpSessionWithPolicyOverridesAndExpectBlocked({ acpOverrides });
    }
  });

  it("blocks ACP turns when ACP agent is disallowed by policy", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      writeAcpSessionStore(storePath);
      mockConfigWithAcpOverrides(home, storePath, {
        allowedAgents: ["claude"],
      });

      const runTurn = vi.fn(async (_params: unknown) => {});
      mockAcpManager({
        runTurn: (params: unknown) => runTurn(params),
        resolveSession: ({ sessionKey }) => resolveReadySession(sessionKey, "codex"),
      });

      await expectAcpCommandRejects(
        "agent:codex:acp:test",
        "ACP_SESSION_INIT_FAILED",
        "not allowed by policy",
      );
      expect(runTurn).not.toHaveBeenCalled();
      expect(runEmbeddedPiAgentSpy).not.toHaveBeenCalled();
    });
  });

  it("allows ACP turns for kimi when policy allowlists kimi", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      writeAcpSessionStore(storePath, "kimi");
      mockConfigWithAcpOverrides(home, storePath, {
        allowedAgents: ["kimi"],
      });

      const runTurn = vi.fn(async (_params: unknown) => {});
      mockAcpManager({
        runTurn: (params: unknown) => runTurn(params),
        resolveSession: ({ sessionKey }) => resolveReadySession(sessionKey, "kimi"),
      });

      await agentCommand({ message: "ping", sessionKey: "agent:kimi:acp:test" }, runtime);

      const runTurnInput = runTurn.mock.calls.at(0)?.[0] as
        | { sessionKey?: string; text?: string }
        | undefined;
      expect(runTurnInput?.sessionKey).toBe("agent:kimi:acp:test");
      expect(runTurnInput?.text).toBe("ping");
      expect(runEmbeddedPiAgentSpy).not.toHaveBeenCalled();
    });
  });
});
