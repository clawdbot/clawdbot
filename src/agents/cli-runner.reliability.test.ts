import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __testing as replyRunTesting,
  createReplyOperation,
  replyRunRegistry,
} from "../auto-reply/reply/reply-run-registry.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { runPreparedCliAgent } from "./cli-runner.js";
import {
  createManagedRun,
  enqueueSystemEventMock,
  requestHeartbeatMock,
  supervisorSpawnMock,
} from "./cli-runner.test-support.js";
import { executePreparedCliRun } from "./cli-runner/execute.js";
import { resolveCliNoOutputTimeoutMs } from "./cli-runner/helpers.js";
import { prepareCliRunContext } from "./cli-runner/prepare.js";
import * as sessionHistoryModule from "./cli-runner/session-history.js";
import { MAX_CLI_SESSION_HISTORY_MESSAGES } from "./cli-runner/session-history.js";
import type { PreparedCliRunContext } from "./cli-runner/types.js";

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => null),
}));

vi.mock("../tts/tts.js", () => ({
  buildTtsSystemPromptHint: vi.fn(() => undefined),
}));

const mockGetGlobalHookRunner = vi.mocked(getGlobalHookRunner);
const hookRunnerGlobalStateKey = Symbol.for("openclaw.plugins.hook-runner-global-state");

type HookRunnerGlobalStateForTest = {
  hookRunner: unknown;
  registry: unknown;
};

function setHookRunnerForTest(hookRunner: unknown): void {
  mockGetGlobalHookRunner.mockReturnValue(hookRunner as never);
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const state = (globalStore[hookRunnerGlobalStateKey] as
    | HookRunnerGlobalStateForTest
    | undefined) ?? {
    hookRunner: null,
    registry: null,
  };
  state.hookRunner = hookRunner;
  state.registry = null;
  globalStore[hookRunnerGlobalStateKey] = state;
}

function createSessionFile(params?: { history?: Array<{ role: "user"; content: string }> }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-hooks-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", dir);
  const sessionFile = path.join(dir, "agents", "main", "sessions", "s1.jsonl");
  const storePath = path.join(path.dirname(sessionFile), "sessions.json");
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(
    storePath,
    JSON.stringify({
      "agent:main:main": {
        sessionId: "s1",
        sessionFile,
        updatedAt: Date.now(),
      },
    }),
    "utf-8",
  );
  fs.writeFileSync(
    sessionFile,
    `${JSON.stringify({
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: "session-test",
      timestamp: new Date(0).toISOString(),
      cwd: dir,
    })}\n`,
    "utf-8",
  );
  for (const [index, entry] of (params?.history ?? []).entries()) {
    fs.appendFileSync(
      sessionFile,
      `${JSON.stringify({
        type: "message",
        id: `msg-${index}`,
        parentId: index > 0 ? `msg-${index - 1}` : null,
        timestamp: new Date(index + 1).toISOString(),
        message: {
          role: entry.role,
          content: entry.content,
          timestamp: index + 1,
        },
      })}\n`,
      "utf-8",
    );
  }
  return { dir, sessionFile, storePath };
}

function buildPreparedContext(params?: {
  sessionKey?: string;
  cliSessionId?: string;
  runId?: string;
  lane?: string;
  openClawHistoryPrompt?: string;
}): PreparedCliRunContext {
  const backend = {
    command: "codex",
    args: ["exec", "--json"],
    output: "text" as const,
    input: "arg" as const,
    modelArg: "--model",
    sessionMode: "existing" as const,
    serialize: true,
  };
  return {
    params: {
      sessionId: "s1",
      sessionKey: params?.sessionKey,
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      provider: "codex-cli",
      model: "gpt-5.4",
      thinkLevel: "low",
      timeoutMs: 1_000,
      runId: params?.runId ?? "run-2",
      lane: params?.lane,
    },
    started: Date.now(),
    workspaceDir: "/tmp",
    backendResolved: {
      id: "codex-cli",
      config: backend,
      bundleMcp: false,
      pluginId: "openai",
    },
    preparedBackend: {
      backend,
      env: {},
    },
    reusableCliSession: params?.cliSessionId ? { sessionId: params.cliSessionId } : {},
    modelId: "gpt-5.4",
    normalizedModel: "gpt-5.4",
    systemPrompt: "You are a helpful assistant.",
    systemPromptReport: {} as PreparedCliRunContext["systemPromptReport"],
    bootstrapPromptWarningLines: [],
    ...(params?.openClawHistoryPrompt
      ? { openClawHistoryPrompt: params.openClawHistoryPrompt }
      : {}),
    authEpochVersion: 2,
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): Array<unknown> {
  expect(Array.isArray(value), label).toBe(true);
  return value as Array<unknown>;
}

function callArg(
  mock: { mock: { calls: Array<Array<unknown>> } },
  callIndex: number,
  argIndex: number,
  label: string,
) {
  const call = mock.mock.calls.at(callIndex);
  if (!call) {
    throw new Error(`Expected mock call: ${label}`);
  }
  if (argIndex >= call.length) {
    throw new Error(`Expected mock call argument ${argIndex}: ${label}`);
  }
  return call[argIndex];
}

async function expectFailoverAttribution(
  run: Promise<unknown>,
  expected: { sessionId: string; lane: string },
) {
  try {
    await run;
    throw new Error("expected run to fail");
  } catch (error) {
    const failure = requireRecord(error, "failover error");
    expect(failure.name).toBe("FailoverError");
    expect(failure.sessionId).toBe(expected.sessionId);
    expect(failure.lane).toBe(expected.lane);
  }
}

function expectTextMessage(value: unknown, fields: { role: string; content: string }) {
  const message = requireRecord(value, "message");
  expect(message.role).toBe(fields.role);
  expect(message.content).toBe(fields.content);
  expect(message.timestamp).toBeTypeOf("number");
}

describe("runCliAgent reliability", () => {
  afterEach(() => {
    replyRunTesting.resetReplyRunRegistry();
    mockGetGlobalHookRunner.mockReset();
    setHookRunnerForTest(null);
    vi.unstubAllEnvs();
  });

  it("fails with timeout when no-output watchdog trips", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "no-output-timeout",
        exitCode: null,
        exitSignal: "SIGKILL",
        durationMs: 200,
        stdout: "",
        stderr: "",
        timedOut: true,
        noOutputTimedOut: true,
      }),
    );

    await expect(
      executePreparedCliRun(
        buildPreparedContext({ cliSessionId: "thread-123", runId: "run-2" }),
        "thread-123",
      ),
    ).rejects.toThrow("produced no output");
  });

  it("adds request attribution to CLI watchdog failover errors", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "no-output-timeout",
        exitCode: null,
        exitSignal: "SIGKILL",
        durationMs: 200,
        stdout: "",
        stderr: "",
        timedOut: true,
        noOutputTimedOut: true,
      }),
    );

    await expectFailoverAttribution(
      executePreparedCliRun(
        buildPreparedContext({
          cliSessionId: "thread-123",
          lane: "custom-lane",
          runId: "run-attribution",
        }),
        "thread-123",
      ),
      { sessionId: "s1", lane: "custom-lane" },
    );
  });

  it("enqueues a system event and heartbeat wake on no-output watchdog timeout for session runs", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "no-output-timeout",
        exitCode: null,
        exitSignal: "SIGKILL",
        durationMs: 200,
        stdout: "",
        stderr: "",
        timedOut: true,
        noOutputTimedOut: true,
      }),
    );

    await expect(
      executePreparedCliRun(
        buildPreparedContext({
          sessionKey: "agent:main:main",
          cliSessionId: "thread-123",
          runId: "run-2b",
        }),
        "thread-123",
      ),
    ).rejects.toThrow("produced no output");

    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    const [notice, opts] = enqueueSystemEventMock.mock.calls.at(0) ?? [];
    expect(String(notice)).toContain("produced no output");
    expect(String(notice)).toContain("interactive input or an approval prompt");
    expect(requireRecord(opts, "system event options").sessionKey).toBe("agent:main:main");
    expect(requestHeartbeatMock).toHaveBeenCalledWith({
      source: "cli-watchdog",
      intent: "event",
      reason: "cli:watchdog:stall",
      sessionKey: "agent:main:main",
    });
  });

  it("fails with timeout when overall timeout trips", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "overall-timeout",
        exitCode: null,
        exitSignal: "SIGKILL",
        durationMs: 200,
        stdout: "",
        stderr: "",
        timedOut: true,
        noOutputTimedOut: false,
      }),
    );

    await expect(
      executePreparedCliRun(
        buildPreparedContext({ cliSessionId: "thread-123", runId: "run-3" }),
        "thread-123",
      ),
    ).rejects.toThrow("exceeded timeout");
  });

  it("rethrows the retry failure when session-expired recovery retry also fails", async () => {
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => ["llm_input", "agent_end"].includes(hookName)),
      runLlmInput: vi.fn(async () => undefined),
      runLlmOutput: vi.fn(async () => undefined),
      runAgentEnd: vi.fn(async () => undefined),
    };
    setHookRunnerForTest(hookRunner);
    supervisorSpawnMock.mockClear();
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 1,
        exitSignal: null,
        durationMs: 150,
        stdout: "",
        stderr: "session expired",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 1,
        exitSignal: null,
        durationMs: 150,
        stdout: "",
        stderr: "rate limit exceeded",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );
    const { dir, sessionFile } = createSessionFile({
      history: [{ role: "user", content: "earlier context" }],
    });

    try {
      await expect(
        runPreparedCliAgent({
          ...buildPreparedContext({
            sessionKey: "agent:main:subagent:retry",
            runId: "run-retry-failure",
            cliSessionId: "thread-123",
          }),
          params: {
            ...buildPreparedContext({
              sessionKey: "agent:main:subagent:retry",
              runId: "run-retry-failure",
              cliSessionId: "thread-123",
            }).params,
            agentId: "main",
            sessionFile,
            workspaceDir: dir,
          },
        }),
      ).rejects.toThrow("rate limit exceeded");

      expect(supervisorSpawnMock).toHaveBeenCalledTimes(2);
      await vi.waitFor(() => {
        expect(hookRunner.runLlmInput).toHaveBeenCalledTimes(1);
        expect(hookRunner.runAgentEnd).toHaveBeenCalledTimes(1);
      });
      const agentEndEvent = requireRecord(
        callArg(hookRunner.runAgentEnd, 0, 0, "agent_end event"),
        "agent_end event",
      );
      expect(agentEndEvent.success).toBe(false);
      expect(agentEndEvent.error).toBe("rate limit exceeded");
      const messages = requireArray(agentEndEvent.messages, "agent_end messages");
      expect(messages).toHaveLength(2);
      expectTextMessage(messages[0], { role: "user", content: "earlier context" });
      expectTextMessage(messages[1], { role: "user", content: "hi" });
      expect(callArg(hookRunner.runAgentEnd, 0, 1, "agent_end context")).toBeTypeOf("object");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns the assembled CLI prompt in meta for raw trace consumers", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "hello from cli",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    const result = await runPreparedCliAgent({
      ...buildPreparedContext(),
      bootstrapPromptWarningLines: ["Warning: prompt budget low."],
    });

    expect(result.meta.finalPromptText).toContain("Warning: prompt budget low.");
    expect(result.meta.finalPromptText).toContain("hi");
    expect(result.meta.finalAssistantRawText).toBe("hello from cli");
    const executionTrace = requireRecord(result.meta.executionTrace, "execution trace");
    expect(executionTrace.winnerProvider).toBe("codex-cli");
    expect(executionTrace.winnerModel).toBe("gpt-5.4");
    expect(executionTrace.fallbackUsed).toBe(false);
    expect(executionTrace.runner).toBe("cli");
    expect(executionTrace.attempts).toEqual([
      { provider: "codex-cli", model: "gpt-5.4", result: "success" },
    ]);
    const requestShaping = requireRecord(result.meta.requestShaping, "request shaping");
    expect(requestShaping.thinking).toBe("low");
    const completion = requireRecord(result.meta.completion, "completion");
    expect(completion.finishReason).toBe("stop");
    expect(completion.stopReason).toBe("completed");
    expect(completion.refusal).toBe(false);
  });

  it("seeds fresh CLI sessions from the OpenClaw transcript", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "hello from cli",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    const result = await runPreparedCliAgent(
      buildPreparedContext({
        openClawHistoryPrompt:
          "Continue this conversation using the OpenClaw transcript below.\n\nUser: earlier ask\n\nAssistant: earlier answer\n\n<next_user_message>\nhi\n</next_user_message>",
      }),
    );

    expect(result.meta.finalPromptText).toContain("User: earlier ask");
    expect(result.meta.finalPromptText).toContain("Assistant: earlier answer");
  });

  it("keeps resumed CLI sessions on native resume history", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "hello from cli",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    const result = await runPreparedCliAgent(
      buildPreparedContext({
        cliSessionId: "cli-session",
        openClawHistoryPrompt: "User: earlier ask",
      }),
    );

    expect(result.meta.finalPromptText).not.toContain("User: earlier ask");
    expect(result.meta.finalPromptText).toContain("hi");
  });

  it("reports CLI reply backends as streaming until the managed run finishes", async () => {
    const operation = createReplyOperation({
      sessionKey: "agent:main:main",
      sessionId: "s1",
      resetTriggered: false,
    });
    operation.setPhase("running");
    let finishRun: (() => void) | undefined;
    const waitForExit = new Promise<
      Awaited<ReturnType<ReturnType<typeof createManagedRun>["wait"]>>
    >((resolve) => {
      finishRun = () => {
        resolve({
          reason: "exit",
          exitCode: 0,
          exitSignal: null,
          durationMs: 50,
          stdout: "hello from cli",
          stderr: "",
          timedOut: false,
          noOutputTimedOut: false,
        });
      };
    });
    supervisorSpawnMock.mockResolvedValueOnce({
      ...createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "unused",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
      wait: vi.fn(() => waitForExit),
    });

    const run = executePreparedCliRun({
      ...buildPreparedContext({ sessionKey: "agent:main:main" }),
      params: {
        ...buildPreparedContext({ sessionKey: "agent:main:main" }).params,
        replyOperation: operation,
      },
    });

    await vi.waitFor(() => {
      expect(replyRunRegistry.isStreaming("agent:main:main")).toBe(true);
    });

    finishRun?.();
    const result = await run;
    expect(result.text).toBe("hello from cli");
    expect(replyRunRegistry.isStreaming("agent:main:main")).toBe(false);
    operation.complete();
  });

  it("keeps raw assistant output separate from transformed visible CLI output", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "hello from cli",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    const result = await runPreparedCliAgent({
      ...buildPreparedContext(),
      backendResolved: {
        ...buildPreparedContext().backendResolved,
        textTransforms: {
          output: [{ from: "hello", to: "goodbye" }],
        },
      },
    });

    expect(result.payloads).toEqual([{ text: "goodbye from cli" }]);
    expect(result.meta.finalAssistantVisibleText).toBe("goodbye from cli");
    expect(result.meta.finalAssistantRawText).toBe("hello from cli");
  });

  it("emits llm_input, llm_output, and agent_end hooks for successful CLI runs", async () => {
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) =>
        ["llm_input", "llm_output", "agent_end"].includes(hookName),
      ),
      runLlmInput: vi.fn(async () => undefined),
      runLlmOutput: vi.fn(async () => undefined),
      runAgentEnd: vi.fn(async () => undefined),
    };
    setHookRunnerForTest(hookRunner);
    const { dir, sessionFile } = createSessionFile();

    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "hello from cli",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    try {
      await runPreparedCliAgent({
        ...buildPreparedContext(),
        params: {
          ...buildPreparedContext().params,
          sessionFile,
          workspaceDir: dir,
          sessionKey: "agent:main:main",
          agentId: "main",
          messageProvider: "acp",
          messageChannel: "telegram",
          trigger: "user",
        },
      });

      await vi.waitFor(() => {
        expect(hookRunner.runLlmInput).toHaveBeenCalledTimes(1);
        expect(hookRunner.runLlmOutput).toHaveBeenCalledTimes(1);
        expect(hookRunner.runAgentEnd).toHaveBeenCalledTimes(1);
      });

      const llmInputEvent = requireRecord(
        callArg(hookRunner.runLlmInput, 0, 0, "llm_input event"),
        "llm_input event",
      );
      expect(llmInputEvent.runId).toBe("run-2");
      expect(llmInputEvent.sessionId).toBe("s1");
      expect(llmInputEvent.provider).toBe("codex-cli");
      expect(llmInputEvent.model).toBe("gpt-5.4");
      expect(llmInputEvent.prompt).toBe("hi");
      expect(llmInputEvent.systemPrompt).toBe("You are a helpful assistant.");
      expect(Array.isArray(llmInputEvent.historyMessages)).toBe(true);
      expect(llmInputEvent.imagesCount).toBe(0);

      const llmInputContext = requireRecord(
        callArg(hookRunner.runLlmInput, 0, 1, "llm_input context"),
        "llm_input context",
      );
      expect(llmInputContext.runId).toBe("run-2");
      expect(llmInputContext.agentId).toBe("main");
      expect(llmInputContext.sessionKey).toBe("agent:main:main");
      expect(llmInputContext.sessionId).toBe("s1");
      expect(llmInputContext.workspaceDir).toBe(dir);
      expect(llmInputContext.messageProvider).toBe("acp");
      expect(llmInputContext.trigger).toBe("user");
      expect(llmInputContext.channelId).toBe("telegram");

      const llmOutputEvent = requireRecord(
        callArg(hookRunner.runLlmOutput, 0, 0, "llm_output event"),
        "llm_output event",
      );
      expect(llmOutputEvent.runId).toBe("run-2");
      expect(llmOutputEvent.sessionId).toBe("s1");
      expect(llmOutputEvent.provider).toBe("codex-cli");
      expect(llmOutputEvent.model).toBe("gpt-5.4");
      expect(llmOutputEvent.assistantTexts).toEqual(["hello from cli"]);
      const lastAssistant = requireRecord(llmOutputEvent.lastAssistant, "last assistant");
      expect(lastAssistant.role).toBe("assistant");
      expect(lastAssistant.content).toEqual([{ type: "text", text: "hello from cli" }]);
      expect(lastAssistant.provider).toBe("codex-cli");
      expect(lastAssistant.model).toBe("gpt-5.4");
      expect(callArg(hookRunner.runLlmOutput, 0, 1, "llm_output context")).toBeTypeOf("object");

      const agentEndEvent = requireRecord(
        callArg(hookRunner.runAgentEnd, 0, 0, "agent_end event"),
        "agent_end event",
      );
      expect(agentEndEvent.success).toBe(true);
      const messages = requireArray(agentEndEvent.messages, "agent_end messages");
      expect(messages).toHaveLength(2);
      expectTextMessage(messages[0], { role: "user", content: "hi" });
      const assistantMessage = requireRecord(messages[1], "assistant message");
      expect(assistantMessage.role).toBe("assistant");
      expect(assistantMessage.content).toEqual([{ type: "text", text: "hello from cli" }]);
      expect(callArg(hookRunner.runAgentEnd, 0, 1, "agent_end context")).toBeTypeOf("object");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blocks CLI runs before llm_input and model execution when before_agent_run blocks", async () => {
    supervisorSpawnMock.mockClear();
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) =>
        ["before_agent_run", "llm_input", "agent_end"].includes(hookName),
      ),
      runBeforeAgentRun: vi.fn(async () => ({
        pluginId: "policy-plugin",
        decision: {
          outcome: "block" as const,
          reason: "matched secret prompt: secret prompt",
          message: "The agent cannot read this message.",
        },
      })),
      runLlmInput: vi.fn(async () => undefined),
      runAgentEnd: vi.fn(async () => undefined),
    };
    setHookRunnerForTest(hookRunner);
    const { dir, sessionFile } = createSessionFile({
      history: [{ role: "user", content: "earlier context" }],
    });

    try {
      const result = await runPreparedCliAgent({
        ...buildPreparedContext({ sessionKey: "agent:main:main", runId: "run-blocked-cli" }),
        params: {
          ...buildPreparedContext({ sessionKey: "agent:main:main", runId: "run-blocked-cli" })
            .params,
          agentId: "main",
          sessionFile,
          workspaceDir: dir,
          prompt: "secret prompt",
        },
      });

      expect(result.payloads).toEqual([
        {
          text: "Your message could not be sent: The agent cannot read this message. (blocked by policy-plugin)",
          isError: true,
        },
      ]);
      expect(result.meta.livenessState).toBe("blocked");
      expect(supervisorSpawnMock).not.toHaveBeenCalled();
      expect(hookRunner.runLlmInput).not.toHaveBeenCalled();
      const beforeRunEvent = requireRecord(
        callArg(hookRunner.runBeforeAgentRun, 0, 0, "before_agent_run event"),
        "before_agent_run event",
      );
      expect(beforeRunEvent.prompt).toBe("secret prompt");
      const beforeRunMessages = requireArray(beforeRunEvent.messages, "before_agent_run messages");
      expect(
        beforeRunMessages.some((message) => {
          const record = requireRecord(message, "before_agent_run message");
          return record.role === "user" && record.content === "earlier context";
        }),
      ).toBe(true);
      const beforeRunContext = requireRecord(
        callArg(hookRunner.runBeforeAgentRun, 0, 1, "before_agent_run context"),
        "before_agent_run context",
      );
      expect(beforeRunContext.runId).toBe("run-blocked-cli");
      expect(beforeRunContext.agentId).toBe("main");
      expect(beforeRunContext.sessionKey).toBe("agent:main:main");
      await vi.waitFor(() => {
        expect(hookRunner.runAgentEnd).toHaveBeenCalledTimes(1);
      });
      const agentEndEvent = requireRecord(
        callArg(hookRunner.runAgentEnd, 0, 0, "agent_end event"),
        "agent_end event",
      );
      expect(agentEndEvent.success).toBe(false);
      expect(agentEndEvent.error).toBe(
        "Your message could not be sent: The agent cannot read this message. (blocked by policy-plugin)",
      );
      const agentEndMessages = requireArray(agentEndEvent.messages, "agent_end messages");
      expect(
        agentEndMessages.some((message) => {
          const record = requireRecord(message, "agent_end message");
          return (
            record.role === "user" &&
            record.content ===
              "Your message could not be sent: The agent cannot read this message. (blocked by policy-plugin)"
          );
        }),
      ).toBe(true);
      expect(callArg(hookRunner.runAgentEnd, 0, 1, "agent_end context")).toBeTypeOf("object");
      expect(JSON.stringify(hookRunner.runAgentEnd.mock.calls)).not.toContain("secret prompt");

      const lines = fs.readFileSync(sessionFile, "utf-8").trim().split("\n");
      const blockedLine = JSON.parse(lines[lines.length - 1]);
      expect(blockedLine.message.content[0].text).toBe(
        "Your message could not be sent: The agent cannot read this message. (blocked by policy-plugin)",
      );
      expect(JSON.stringify(blockedLine)).not.toContain("secret prompt");
      expect(JSON.stringify(blockedLine)).not.toContain("matched secret prompt");
      expect(blockedLine.message.__openclaw.beforeAgentRunBlocked.blockedBy).toBe("policy-plugin");
      expect(blockedLine.message.__openclaw.beforeAgentRunBlocked).not.toHaveProperty("reason");
      expect(Object.hasOwn(blockedLine.message.__openclaw, "beforeAgentRunBlocked")).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not emit llm_output when the CLI run returns no assistant text", async () => {
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "llm_output"),
      runLlmInput: vi.fn(async () => undefined),
      runLlmOutput: vi.fn(async () => undefined),
      runAgentEnd: vi.fn(async () => undefined),
    };
    setHookRunnerForTest(hookRunner);

    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "   ",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    const result = await runPreparedCliAgent(buildPreparedContext());

    expect(result.payloads).toBeUndefined();
    expect(hookRunner.runLlmOutput).not.toHaveBeenCalled();
  });

  it("emits agent_end with failure details when the CLI run fails", async () => {
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => ["llm_input", "agent_end"].includes(hookName)),
      runLlmInput: vi.fn(async () => undefined),
      runLlmOutput: vi.fn(async () => undefined),
      runAgentEnd: vi.fn(async () => undefined),
    };
    setHookRunnerForTest(hookRunner);

    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 1,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "rate limit exceeded",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    await expect(runPreparedCliAgent(buildPreparedContext())).rejects.toThrow(
      "rate limit exceeded",
    );

    await vi.waitFor(() => {
      expect(hookRunner.runLlmInput).toHaveBeenCalledTimes(1);
      expect(hookRunner.runLlmOutput).not.toHaveBeenCalled();
      expect(hookRunner.runAgentEnd).toHaveBeenCalledTimes(1);
    });

    const agentEndEvent = requireRecord(
      callArg(hookRunner.runAgentEnd, 0, 0, "agent_end event"),
      "agent_end event",
    );
    expect(agentEndEvent.success).toBe(false);
    expect(agentEndEvent.error).toBe("rate limit exceeded");
    const messages = requireArray(agentEndEvent.messages, "agent_end messages");
    expect(messages).toHaveLength(1);
    expectTextMessage(messages[0], { role: "user", content: "hi" });
    expect(callArg(hookRunner.runAgentEnd, 0, 1, "agent_end context")).toBeTypeOf("object");
  });

  it("does not emit duplicate llm_input when session-expired recovery succeeds", async () => {
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) =>
        ["llm_input", "llm_output", "agent_end"].includes(hookName),
      ),
      runLlmInput: vi.fn(async () => undefined),
      runLlmOutput: vi.fn(async () => undefined),
      runAgentEnd: vi.fn(async () => undefined),
    };
    setHookRunnerForTest(hookRunner);
    const { dir, sessionFile } = createSessionFile({
      history: Array.from({ length: MAX_CLI_SESSION_HISTORY_MESSAGES + 5 }, (_, index) => ({
        role: "user" as const,
        content: `history-${index}`,
      })),
    });

    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 1,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "session expired",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "recovered output",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    try {
      const result = await runPreparedCliAgent({
        ...buildPreparedContext({
          sessionKey: "agent:main:main",
          runId: "run-retry-success",
          cliSessionId: "thread-123",
          openClawHistoryPrompt:
            "Continue this conversation using the OpenClaw transcript below.\n\nUser: recovered history\n\n<next_user_message>\nhi\n</next_user_message>",
        }),
        params: {
          ...buildPreparedContext({
            sessionKey: "agent:main:main",
            runId: "run-retry-success",
            cliSessionId: "thread-123",
            openClawHistoryPrompt:
              "Continue this conversation using the OpenClaw transcript below.\n\nUser: recovered history\n\n<next_user_message>\nhi\n</next_user_message>",
          }).params,
          agentId: "main",
          sessionFile,
          workspaceDir: dir,
        },
      });

      expect(result.payloads).toEqual([{ text: "recovered output" }]);
      expect(result.meta.finalPromptText).toContain("User: recovered history");

      await vi.waitFor(() => {
        expect(hookRunner.runLlmInput).toHaveBeenCalledTimes(1);
        expect(hookRunner.runLlmOutput).toHaveBeenCalledTimes(1);
        expect(hookRunner.runAgentEnd).toHaveBeenCalledTimes(1);
      });
      const llmInputEvent = requireRecord(
        callArg(hookRunner.runLlmInput, 0, 0, "llm_input event"),
        "llm_input event",
      );
      const historyMessages = requireArray(llmInputEvent.historyMessages, "history messages");
      expect(historyMessages).toHaveLength(MAX_CLI_SESSION_HISTORY_MESSAGES);
      const firstHistoryMessage = requireRecord(historyMessages[0], "first history message");
      expect(firstHistoryMessage.role).toBe("user");
      expect(firstHistoryMessage.content).toBe(`history-5`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips transcript loading when only llm_output hooks are active", async () => {
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "llm_output"),
      runLlmInput: vi.fn(async () => undefined),
      runLlmOutput: vi.fn(async () => undefined),
      runAgentEnd: vi.fn(async () => undefined),
    };
    setHookRunnerForTest(hookRunner);
    const historySpy = vi.spyOn(sessionHistoryModule, "loadCliSessionHistoryMessages");

    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "hello from cli",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    try {
      await runPreparedCliAgent(buildPreparedContext());

      expect(historySpy).not.toHaveBeenCalled();
      await vi.waitFor(() => {
        expect(hookRunner.runLlmOutput).toHaveBeenCalledTimes(1);
      });
    } finally {
      historySpy.mockRestore();
    }
  });

  it("builds fresh-session history reseed prompts from hook-mutated prompts", async () => {
    const { dir, sessionFile } = createSessionFile({
      history: [{ role: "user", content: "earlier ask" }],
    });
    fs.appendFileSync(
      sessionFile,
      `${JSON.stringify({
        type: "compaction",
        id: "compaction-1",
        parentId: "msg-0",
        timestamp: new Date(2).toISOString(),
        summary: "compacted earlier ask",
        firstKeptEntryId: "msg-0",
        tokensBefore: 10_000,
      })}\n`,
      "utf-8",
    );
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: dir,
          cliBackends: {
            "codex-cli": {
              command: "codex",
              args: ["exec"],
              output: "text",
              input: "arg",
              sessionMode: "existing",
            },
          },
        },
      },
    };
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "before_prompt_build"),
      runBeforePromptBuild: vi.fn(async () => ({ prependContext: "hook context" })),
      runBeforeAgentStart: vi.fn(async () => undefined),
    };
    setHookRunnerForTest(hookRunner);

    try {
      const context = await prepareCliRunContext({
        sessionId: "s1",
        sessionFile,
        workspaceDir: dir,
        config,
        prompt: "current ask",
        provider: "codex-cli",
        model: "gpt-5.4",
        timeoutMs: 1_000,
        runId: "run-history-hook",
      });

      expect(context.params.prompt).toBe("hook context\n\ncurrent ask");
      expect(context.openClawHistoryPrompt).toContain("Compaction summary: compacted earlier ask");
      expect(context.openClawHistoryPrompt).toContain("hook context");
      expect(context.openClawHistoryPrompt).toContain("current ask");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveCliNoOutputTimeoutMs", () => {
  it("uses backend-configured resume watchdog override", () => {
    const timeoutMs = resolveCliNoOutputTimeoutMs({
      backend: {
        command: "codex",
        reliability: {
          watchdog: {
            resume: {
              noOutputTimeoutMs: 42_000,
            },
          },
        },
      },
      timeoutMs: 120_000,
      useResume: true,
    });
    expect(timeoutMs).toBe(42_000);
  });

  it("lets explicit cron timeouts lift the default resume no-output ceiling", () => {
    const timeoutMs = resolveCliNoOutputTimeoutMs({
      backend: { command: "codex" },
      timeoutMs: 600_000,
      useResume: true,
      trigger: "cron",
    });
    expect(timeoutMs).toBe(480_000);
  });
});
