import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import { testing as replyRunTesting } from "../../auto-reply/reply/reply-run-registry.test-support.js";
import { onAgentEvent, resetAgentEventsForTest } from "../../infra/agent-events.js";
import type { CliBackendConfig } from "../../plugins/cli-backend.types.js";
import type { getProcessSupervisor } from "../../process/supervisor/index.js";
import {
  buildClaudeLiveRunContext,
  buildPreparedCliRunContext,
  createClaudeInputStartedEvent,
  expectRejectsWithFields,
  mockCallArg,
  mockClaudeLiveRun,
} from "../cli-runner.test-helpers.js";
import {
  restoreCliRunnerPrepareTestDeps,
  supervisorSpawnMock,
} from "../cli-runner.test-support.js";
import { runClaudeTurn } from "./claude-live-session.js";
import { resetClaudeLiveSessionsForTest } from "./claude-live-session.test-support.js";
import { executePreparedCliRun } from "./execute.js";

function emitClaudeInputStarted(stdout: ((chunk: string) => void) | undefined, data: string): void {
  const event = createClaudeInputStartedEvent(data);
  if (event) {
    stdout?.(`${JSON.stringify(event)}\n`);
  }
}

beforeEach(() => {
  resetAgentEventsForTest();
  resetClaudeLiveSessionsForTest();
  replyRunTesting.resetReplyRunRegistry();
  restoreCliRunnerPrepareTestDeps();
  supervisorSpawnMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetClaudeLiveSessionsForTest();
  replyRunTesting.resetReplyRunRegistry();
});

const promptFile = "/tmp/system-prompt.md";
const baseBackend = {
  command: "claude",
  args: ["-p"],
  output: "jsonl",
  input: "stdin",
  modelArg: "--model",
  sessionArgs: ["--session-id", "{sessionId}"],
  sessionMode: "always",
  systemPromptArg: "--append-system-prompt",
  systemPromptFileArg: "--append-system-prompt-file",
  systemPromptWhen: "first",
  liveSession: "claude-stdio",
} as CliBackendConfig;

type ProcessSupervisor = ReturnType<typeof getProcessSupervisor>;
type SupervisorSpawnFn = ProcessSupervisor["spawn"];

async function captureClaudeLiveArgs(params: {
  args: string[];
  backend: CliBackendConfig;
  useResume: boolean;
}): Promise<string[]> {
  mockClaudeLiveRun(supervisorSpawnMock, {
    events: [
      { type: "system", subtype: "init", session_id: "live-args" },
      { type: "result", session_id: "live-args", result: "ok" },
    ],
  });
  const context = buildPreparedCliRunContext({ backend: params.backend });
  await runClaudeTurn({
    context,
    args: params.args,
    env: {},
    prompt: "hello",
    useResume: params.useResume,
    noOutputTimeoutMs: 1_000,
    getProcessSupervisor: () => ({
      spawn: (input: Parameters<SupervisorSpawnFn>[0]) =>
        supervisorSpawnMock(input) as ReturnType<SupervisorSpawnFn>,
      cancel: vi.fn(),
      cancelScope: vi.fn(),
      getRecord: vi.fn(),
    }),
    onAssistantDelta: () => {},
    cleanup: async () => {},
  });
  return (mockCallArg(supervisorSpawnMock) as { argv: string[] }).argv;
}

describe("Claude live process arguments", () => {
  it("normalizes the live protocol while retaining resume state", async () => {
    const args = await captureClaudeLiveArgs({
      args: ["-p", "--resume", "claude-session", "--session-id", "openclaw-session"],
      backend: baseBackend,
      useResume: true,
    });

    expect(args).toContain("--resume");
    expect(args).toContain("claude-session");
    expect(args).not.toContain("openclaw-session");
    expect(args).toEqual(
      expect.arrayContaining([
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--permission-prompt-tool",
        "stdio",
      ]),
    );
  });

  it.each([
    { systemPromptWhen: "first", useResume: true, retained: false },
    { systemPromptWhen: "always", useResume: true, retained: true },
    { systemPromptWhen: "first", useResume: false, retained: true },
    { systemPromptWhen: "always", useResume: false, retained: true },
  ] as const)(
    "retains=$retained the prompt file for systemPromptWhen=$systemPromptWhen resume=$useResume",
    async ({ systemPromptWhen, useResume, retained }) => {
      const args = await captureClaudeLiveArgs({
        args: ["-p", "--append-system-prompt-file", promptFile],
        backend: { ...baseBackend, systemPromptWhen },
        useResume,
      });
      expect(args.includes("--append-system-prompt-file")).toBe(retained);
      expect(args.includes(promptFile)).toBe(retained);
    },
  );
});

describe("runClaudeTurn", () => {
  it("keeps pre-tool commentary out of an empty-result Claude live reply", async () => {
    const agentEvents: Array<{ stream: string; data: unknown }> = [];
    const stop = onAgentEvent((event) => {
      agentEvents.push({ stream: event.stream, data: event.data });
    });
    mockClaudeLiveRun(supervisorSpawnMock, {
      events: [
        { type: "system", subtype: "init", session_id: "live-empty-result" },
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "Let me check." },
          },
        },
        {
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 1,
            content_block: { type: "tool_use", id: "tool-1", name: "Read", input: {} },
          },
        },
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "Final answer." },
          },
        },
        { type: "result", session_id: "live-empty-result", result: "" },
      ],
    });

    try {
      const result = await executePreparedCliRun(
        buildClaudeLiveRunContext({
          emitCommentaryText: true,
        }),
      );

      expect(result.text).toBe("Final answer.");
      expect(agentEvents).toContainEqual({
        stream: "item",
        data: expect.objectContaining({
          kind: "preamble",
          progressText: "Let me check.",
        }),
      });
      expect(agentEvents).toContainEqual({
        stream: "assistant",
        data: { text: "Final answer.", delta: "Final answer." },
      });
    } finally {
      stop();
    }
  });

  it("reports Claude live session reply backends as streaming until the turn finishes", async () => {
    let markWriteReady: (() => void) | undefined;
    const writeReady = new Promise<void>((resolve) => {
      markWriteReady = resolve;
    });
    const live = mockClaudeLiveRun(supervisorSpawnMock, {
      onWrite: () => {
        markWriteReady?.();
      },
    });
    const operation = createReplyOperation({
      sessionKey: "agent:main:main",
      sessionId: "live-session-reply",
      resetTriggered: false,
    });
    operation.setPhase("running");
    const context = buildClaudeLiveRunContext({
      sessionId: "live-session-reply",
      sessionKey: "agent:main:main",
      prompt: "hello",
    });

    const run = executePreparedCliRun({
      ...context,
      params: {
        ...context.params,
        replyOperation: operation,
      },
    });

    await writeReady;
    live.emit([
      { type: "system", subtype: "init", session_id: "live-session-reply" },
      { type: "result", session_id: "live-session-reply", result: "done" },
    ]);

    const result = await run;
    expect(result.text).toBe("done");
    operation.complete();
  });

  it("reuses a Claude live session when resumed turns omit the system prompt arg", async () => {
    let turn = 0;
    mockClaudeLiveRun(supervisorSpawnMock, {
      onWrite: ({ emit }) => {
        turn += 1;
        emit([
          { type: "system", subtype: "init", session_id: "live-system" },
          { type: "result", session_id: "live-system", result: turn === 1 ? "one" : "two" },
        ]);
      },
    });

    const backend = {
      resumeArgs: ["-p", "--output-format", "stream-json", "--resume={sessionId}"],
      liveSession: "claude-stdio" as const,
    };
    const first = await executePreparedCliRun(
      buildPreparedCliRunContext({
        prompt: "first",
        backend,
      }),
    );
    const second = await executePreparedCliRun(
      buildPreparedCliRunContext({
        prompt: "second",
        backend,
      }),
      "live-system",
    );

    expect(first.text).toBe("one");
    expect(second.text).toBe("two");
    expect(supervisorSpawnMock).toHaveBeenCalledOnce();
  });

  it("restarts a warm Claude process when its thinking budget changes", async () => {
    mockClaudeLiveRun(supervisorSpawnMock, {
      events: [
        { type: "system", subtype: "init", session_id: "live-thinking-budget" },
        { type: "result", session_id: "live-thinking-budget", result: "one" },
      ],
      cancelable: true,
    });
    mockClaudeLiveRun(supervisorSpawnMock, {
      events: [
        { type: "system", subtype: "init", session_id: "live-thinking-budget" },
        { type: "result", session_id: "live-thinking-budget", result: "two" },
      ],
    });
    const backend = {
      resumeArgs: ["-p", "--output-format", "stream-json", "--resume={sessionId}"],
      liveSession: "claude-stdio" as const,
    };

    await executePreparedCliRun(
      buildPreparedCliRunContext({
        backend,
        preparedEnv: { MAX_THINKING_TOKENS: "2048" },
      }),
    );
    const second = await executePreparedCliRun(
      buildPreparedCliRunContext({
        backend,
        preparedEnv: { MAX_THINKING_TOKENS: "16384" },
      }),
      "live-thinking-budget",
    );

    expect(second.text).toBe("two");
    expect(supervisorSpawnMock).toHaveBeenCalledTimes(2);
  });

  it("restarts Claude live sessions when a multi-section stable prompt changes", async () => {
    mockClaudeLiveRun(supervisorSpawnMock, {
      events: [
        { type: "system", subtype: "init", session_id: "live-stable-prompt" },
        { type: "result", session_id: "live-stable-prompt", result: "one" },
      ],
      cancelable: true,
    });
    mockClaudeLiveRun(supervisorSpawnMock, {
      events: [
        { type: "system", subtype: "init", session_id: "live-stable-prompt" },
        { type: "result", session_id: "live-stable-prompt", result: "two" },
      ],
    });
    const backend = {
      resumeArgs: ["-p", "--output-format", "stream-json", "--resume={sessionId}"],
      liveSession: "claude-stdio" as const,
      systemPromptWhen: "always" as const,
    };

    await executePreparedCliRun(
      buildPreparedCliRunContext({
        backend,
        systemPrompt: `# OpenClaw\n\n## Stable Instructions\nFirst instructions${SYSTEM_PROMPT_CACHE_BOUNDARY}Metadata`,
      }),
    );
    const second = await executePreparedCliRun(
      buildPreparedCliRunContext({
        backend,
        systemPrompt: `# OpenClaw\n\n## Stable Instructions\nSecond instructions${SYSTEM_PROMPT_CACHE_BOUNDARY}Metadata`,
      }),
      "live-stable-prompt",
    );

    expect(second.text).toBe("two");
    expect(supervisorSpawnMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      name: "ignores the system_prompt field",
      responses: [{ subtype: "success" }],
    },
    {
      name: "rejects the live refresh",
      responses: [
        {
          subtype: "error",
          error: "set_model: system_prompt must be a non-empty string when present",
        },
        { subtype: "error", error: "unsupported" },
      ],
    },
  ])("restarts when Claude $name", async ({ responses }) => {
    let controlRequest = 0;
    mockClaudeLiveRun(supervisorSpawnMock, {
      cancelable: true,
      onWrite: ({ data, emit }) => {
        const parsed = JSON.parse(data) as { type: string; request_id?: string };
        if (parsed.type === "control_request") {
          const response = responses[controlRequest];
          controlRequest += 1;
          emit([
            {
              type: "control_response",
              response: {
                request_id: parsed.request_id,
                ...response,
              },
            },
          ]);
          return;
        }
        emit([
          { type: "system", subtype: "init", session_id: "live-rejected-prompt" },
          { type: "result", session_id: "live-rejected-prompt", result: "one" },
        ]);
      },
    });
    mockClaudeLiveRun(supervisorSpawnMock, {
      events: [
        { type: "system", subtype: "init", session_id: "live-rejected-prompt" },
        { type: "result", session_id: "live-rejected-prompt", result: "two" },
      ],
    });
    const backend = {
      resumeArgs: ["-p", "--output-format", "stream-json", "--resume={sessionId}"],
      liveSession: "claude-stdio" as const,
      systemPromptWhen: "always" as const,
    };

    await executePreparedCliRun(
      buildPreparedCliRunContext({
        backend,
        systemPrompt: `Stable instructions${SYSTEM_PROMPT_CACHE_BOUNDARY}First metadata`,
      }),
    );
    const second = await executePreparedCliRun(
      buildPreparedCliRunContext({
        backend,
        systemPrompt: `Stable instructions${SYSTEM_PROMPT_CACHE_BOUNDARY}Second metadata`,
      }),
      "live-rejected-prompt",
    );

    expect(second.text).toBe("two");
    expect(supervisorSpawnMock).toHaveBeenCalledTimes(2);
    expect(controlRequest).toBe(responses.length);
  });

  it("restarts on marker-free prompt changes instead of weakening prompt identity", async () => {
    mockClaudeLiveRun(supervisorSpawnMock, {
      events: [
        { type: "system", subtype: "init", session_id: "live-marker-free" },
        { type: "result", session_id: "live-marker-free", result: "one" },
      ],
      cancelable: true,
    });
    mockClaudeLiveRun(supervisorSpawnMock, {
      events: [
        { type: "system", subtype: "init", session_id: "live-marker-free" },
        { type: "result", session_id: "live-marker-free", result: "two" },
      ],
    });
    const backend = {
      resumeArgs: ["-p", "--output-format", "stream-json", "--resume={sessionId}"],
      liveSession: "claude-stdio" as const,
      systemPromptWhen: "always" as const,
    };

    await executePreparedCliRun(
      buildPreparedCliRunContext({ backend, systemPrompt: "First complete prompt" }),
    );
    const second = await executePreparedCliRun(
      buildPreparedCliRunContext({ backend, systemPrompt: "Second complete prompt" }),
      "live-marker-free",
    );

    expect(second.text).toBe("two");
    expect(supervisorSpawnMock).toHaveBeenCalledTimes(2);
  });

  it("keeps legacy first-only system prompts on full-prompt restart identity", async () => {
    mockClaudeLiveRun(supervisorSpawnMock, {
      events: [
        { type: "system", subtype: "init", session_id: "live-first-only-prompt" },
        { type: "result", session_id: "live-first-only-prompt", result: "one" },
      ],
      cancelable: true,
    });
    mockClaudeLiveRun(supervisorSpawnMock, {
      events: [
        { type: "system", subtype: "init", session_id: "live-first-only-prompt" },
        { type: "result", session_id: "live-first-only-prompt", result: "two" },
      ],
    });
    const backend = {
      resumeArgs: ["-p", "--output-format", "stream-json", "--resume={sessionId}"],
      liveSession: "claude-stdio" as const,
      systemPromptWhen: "first" as const,
    };

    await executePreparedCliRun(
      buildPreparedCliRunContext({
        backend,
        systemPrompt: `Stable instructions${SYSTEM_PROMPT_CACHE_BOUNDARY}First metadata`,
      }),
    );
    const second = await executePreparedCliRun(
      buildPreparedCliRunContext({
        backend,
        systemPrompt: `Stable instructions${SYSTEM_PROMPT_CACHE_BOUNDARY}Second metadata`,
      }),
      "live-first-only-prompt",
    );

    expect(second.text).toBe("two");
    expect(supervisorSpawnMock).toHaveBeenCalledTimes(2);
  });

  it("restarts the Claude live process after request abort", async () => {
    const abortController = new AbortController();
    let stdoutListener: ((chunk: string) => void) | undefined;
    const cancels: Array<ReturnType<typeof vi.fn>> = [];
    supervisorSpawnMock.mockImplementation(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as { onStdout?: (chunk: string) => void };
      stdoutListener = input.onStdout;
      const spawnIndex = supervisorSpawnMock.mock.calls.length;
      const cancel = vi.fn();
      cancels.push(cancel);
      const stdin = {
        write: vi.fn((dataValue: string, cb?: (err?: Error | null) => void) => {
          emitClaudeInputStarted(stdoutListener, dataValue);
          if (spawnIndex === 2) {
            stdoutListener?.(
              [
                JSON.stringify({ type: "system", subtype: "init", session_id: "live-abort-2" }),
                JSON.stringify({
                  type: "result",
                  session_id: "live-abort-2",
                  result: "second-ok",
                }),
              ].join("\n") + "\n",
            );
          }
          cb?.();
        }),
        end: vi.fn(),
      };
      return {
        runId: `live-run-${spawnIndex}`,
        pid: 2345 + spawnIndex,
        startedAtMs: Date.now(),
        stdin,
        wait: vi.fn(
          () =>
            new Promise((resolve) => {
              if (spawnIndex === 1) {
                cancel.mockImplementationOnce(() => {
                  resolve({
                    reason: "manual-cancel",
                    exitCode: null,
                    exitSignal: null,
                    durationMs: 50,
                    stdout: "",
                    stderr: "",
                    timedOut: false,
                    noOutputTimedOut: false,
                  });
                });
              }
            }),
        ),
        cancel,
      };
    });

    const firstContext = buildClaudeLiveRunContext({});
    firstContext.params.abortSignal = abortController.signal;
    const first = executePreparedCliRun(firstContext);

    await vi.waitFor(() => {
      expect(supervisorSpawnMock).toHaveBeenCalledTimes(1);
    });
    abortController.abort();

    await expectRejectsWithFields(first, { name: "AbortError" });
    expect(cancels[0]).toHaveBeenCalledWith("manual-cancel");
    stdoutListener?.(
      [
        JSON.stringify({ type: "system", subtype: "init", session_id: "live-abort" }),
        JSON.stringify({
          type: "result",
          session_id: "live-abort",
          result: "discarded",
        }),
      ].join("\n") + "\n",
    );

    const second = await executePreparedCliRun(buildClaudeLiveRunContext({}));

    expect(second.text).toBe("second-ok");
    expect(supervisorSpawnMock).toHaveBeenCalledTimes(2);
  });
});
