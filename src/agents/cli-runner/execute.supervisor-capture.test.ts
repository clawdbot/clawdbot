import { beforeEach, describe, expect, it } from "vitest";
import { onAgentEvent, resetAgentEventsForTest } from "../../infra/agent-events.js";
import type { getProcessSupervisor } from "../../process/supervisor/index.js";
import { createManagedRun, supervisorSpawnMock } from "../cli-runner.test-support.js";
import { executePreparedCliRun } from "./execute.js";
import type { PreparedCliRunContext } from "./types.js";

type ProcessSupervisor = ReturnType<typeof getProcessSupervisor>;
type SupervisorSpawnInput = Parameters<ProcessSupervisor["spawn"]>[0];

function buildPreparedCliRunContext(params: {
  output: "jsonl" | "text";
  provider?: string;
}): PreparedCliRunContext {
  const provider = params.provider ?? "codex-cli";
  const backend = {
    command: "agent-cli",
    args: [],
    output: params.output,
    input: "stdin" as const,
    serialize: true,
  };

  return {
    params: {
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      provider,
      model: "model",
      timeoutMs: 1_000,
      runId: `run-${params.output}`,
    },
    started: Date.now(),
    workspaceDir: "/tmp",
    backendResolved: {
      id: provider,
      config: backend,
      bundleMcp: false,
    },
    preparedBackend: {
      backend,
      env: {},
    },
    reusableCliSession: {},
    modelId: "model",
    normalizedModel: "model",
    systemPrompt: "system",
    systemPromptReport: {} as PreparedCliRunContext["systemPromptReport"],
    bootstrapPromptWarningLines: [],
    authEpochVersion: 2,
  };
}

beforeEach(() => {
  resetAgentEventsForTest();
  supervisorSpawnMock.mockReset();
});

describe("executePreparedCliRun supervisor output capture", () => {
  it("disables supervisor capture without parsing from the diagnostic stdout tail", async () => {
    const fullText = `start-${"x".repeat(80 * 1024)}-end`;

    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      input.onStdout?.(fullText);
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: input.captureOutput === false ? "" : fullText,
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    const result = await executePreparedCliRun(buildPreparedCliRunContext({ output: "text" }));
    const spawnInput = supervisorSpawnMock.mock.calls.at(0)?.[0] as SupervisorSpawnInput;

    expect(spawnInput.captureOutput).toBe(false);
    expect(result.rawText).toBe(fullText);
  });

  it("rejects oversized successful stdout instead of parsing a truncated tail", async () => {
    const noisyPrefix = "x".repeat(2 * 1024 * 1024);
    const finalText = "final answer";

    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      input.onStdout?.(noisyPrefix);
      input.onStdout?.(finalText);
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: input.captureOutput === false ? "" : `${noisyPrefix}${finalText}`,
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    await expect(
      executePreparedCliRun(buildPreparedCliRunContext({ output: "text" })),
    ).rejects.toThrow("CLI stdout exceeded");
    const spawnInput = supervisorSpawnMock.mock.calls.at(0)?.[0] as SupervisorSpawnInput;

    expect(spawnInput.captureOutput).toBe(false);
  });

  it("parses valid oversized JSONL output incrementally", async () => {
    const largeToolEvent = `${JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "tool_delta", text: "x".repeat(2 * 1024 * 1024) },
      },
    })}\n`;
    const resultEvent = `${JSON.stringify({
      type: "result",
      session_id: "session-jsonl-large",
      result: "final answer",
    })}\n`;

    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      input.onStdout?.(largeToolEvent);
      input.onStdout?.(resultEvent);
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: input.captureOutput === false ? "" : `${largeToolEvent}${resultEvent}`,
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    const result = await executePreparedCliRun(
      buildPreparedCliRunContext({ output: "jsonl", provider: "claude-cli" }),
    );

    expect(result.text).toBe("final answer");
    expect(result.sessionId).toBe("session-jsonl-large");
  });

  it("parses oversized resume JSONL output from the effective resume output mode", async () => {
    const largeToolEvent = `${JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "tool_delta", text: "x".repeat(2 * 1024 * 1024) },
      },
    })}\n`;
    const resultEvent = `${JSON.stringify({
      type: "result",
      session_id: "resume-jsonl-session",
      result: "resumed answer",
    })}\n`;
    const context = buildPreparedCliRunContext({
      output: "text",
      provider: "resume-jsonl-cli",
    });
    Object.assign(context.preparedBackend.backend, {
      jsonlDialect: "claude-stream-json" as const,
      resumeArgs: ["resume", "{sessionId}"],
      resumeOutput: "jsonl" as const,
      sessionMode: "existing" as const,
    });

    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      input.onStdout?.(largeToolEvent);
      input.onStdout?.(resultEvent);
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: input.captureOutput === false ? "" : `${largeToolEvent}${resultEvent}`,
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    const result = await executePreparedCliRun(context, "resume-jsonl-session");

    expect(result.text).toBe("resumed answer");
    expect(result.sessionId).toBe("resume-jsonl-session");
  });

  it("classifies failed stdout from the retained parse buffer before the diagnostic tail", async () => {
    const errorPrefix = `${JSON.stringify({
      type: "result",
      is_error: true,
      result: "429 rate limit exceeded",
    })}\n`;
    const noisyTail = "x".repeat(80 * 1024);

    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      input.onStdout?.(errorPrefix);
      input.onStdout?.(noisyTail);
      return createManagedRun({
        reason: "exit",
        exitCode: 1,
        exitSignal: null,
        durationMs: 50,
        stdout: input.captureOutput === false ? "" : `${errorPrefix}${noisyTail}`,
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    try {
      await executePreparedCliRun(buildPreparedCliRunContext({ output: "text" }));
    } catch (error) {
      const classified = error as { reason?: unknown; status?: unknown };
      expect(classified.reason).toBe("rate_limit");
      expect(classified.status).toBe(429);
      return;
    }
    throw new Error("Expected CLI run to reject with a rate limit error");
  });

  it("still streams every JSONL stdout chunk with supervisor capture disabled", async () => {
    const agentEvents: Array<{ text?: string; delta?: string }> = [];
    const stop = onAgentEvent((event) => {
      if (event.stream !== "assistant") {
        return;
      }
      agentEvents.push({
        text: typeof event.data.text === "string" ? event.data.text : undefined,
        delta: typeof event.data.delta === "string" ? event.data.delta : undefined,
      });
    });
    const chunks = [
      `${JSON.stringify({ type: "init", session_id: "session-jsonl" })}\n`,
      `${JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } },
      })}\n`,
      `not-json ${"x".repeat(80 * 1024)}\n`,
      `${JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: " world" } },
      })}\n`,
      `${JSON.stringify({
        type: "result",
        session_id: "session-jsonl",
        result: "Hello world",
      })}\n`,
    ];

    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      for (const chunk of chunks) {
        input.onStdout?.(chunk);
      }
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: input.captureOutput === false ? "" : chunks.join(""),
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    try {
      const result = await executePreparedCliRun(
        buildPreparedCliRunContext({ output: "jsonl", provider: "claude-cli" }),
      );
      const spawnInput = supervisorSpawnMock.mock.calls.at(0)?.[0] as SupervisorSpawnInput;

      expect(spawnInput.captureOutput).toBe(false);
      expect(result.text).toBe("Hello world");
      expect(agentEvents).toEqual([
        { text: "Hello", delta: "Hello" },
        { text: "Hello world", delta: " world" },
      ]);
    } finally {
      stop();
    }
  });
});
