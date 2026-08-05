/** Claude live session: base64 image payloads in tool_result lines are metered as stubs. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
} from "../../infra/diagnostic-events.js";
import {
  resetDiagnosticRunActivityForTest,
  startDiagnosticRunActivityTracking,
} from "../../logging/diagnostic-run-activity.js";
import type { getProcessSupervisor } from "../../process/supervisor/index.js";
import type { CliToolResultDelta } from "../cli-output.js";
import {
  restoreCliRunnerPrepareTestDeps,
  supervisorSpawnMock,
} from "../cli-runner.test-support.js";
import { runClaudeLiveSessionTurn } from "./claude-live-session.js";
import { resetClaudeLiveSessionsForTest } from "./claude-live-session.test-support.js";
import { setCliRunnerExecuteTestDeps } from "./execute.test-support.js";
import { writeCliSystemPromptFile } from "./helpers.js";
import type { PreparedCliRunContext } from "./types.js";

vi.mock("../../plugin-sdk/anthropic-cli.js", () => ({
  CLAUDE_CLI_BACKEND_ID: "claude-cli",
  isClaudeCliProvider: (providerId: string) => providerId === "claude-cli",
}));

type ProcessSupervisor = ReturnType<typeof getProcessSupervisor>;
type SupervisorSpawnFn = ProcessSupervisor["spawn"];

beforeEach(() => {
  setDiagnosticsEnabledForProcess(true);
  resetDiagnosticRunActivityForTest();
  startDiagnosticRunActivityTracking();
  resetClaudeLiveSessionsForTest();
  restoreCliRunnerPrepareTestDeps();
  setCliRunnerExecuteTestDeps({ writeCliSystemPromptFile });
  supervisorSpawnMock.mockClear();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  resetDiagnosticRunActivityForTest();
  resetClaudeLiveSessionsForTest();
  await waitForDiagnosticEventsDrained();
});

function buildPreparedCliRunContext(params: {
  runId: string;
  sessionId?: string;
  sessionKey?: string;
}): PreparedCliRunContext {
  const backend = {
    command: "claude",
    args: ["-p", "--output-format", "stream-json"],
    output: "jsonl" as const,
    input: "stdin" as const,
    modelArg: "--model",
    sessionArgs: ["--session-id", "{sessionId}"],
    sessionMode: "always" as const,
    systemPromptFileArg: "--append-system-prompt-file",
    systemPromptWhen: "first" as const,
    serialize: true,
    liveSession: "claude-stdio" as const,
  };
  return {
    params: {
      sessionId: params.sessionId ?? "s-img",
      sessionKey: params.sessionKey ?? "agent:main:img",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      provider: "claude-cli",
      model: "sonnet",
      timeoutMs: 60_000,
      runId: params.runId,
    },
    started: Date.now(),
    workspaceDir: "/tmp",
    backendResolved: {
      id: "claude-cli",
      config: backend,
      bundleMcp: true,
      pluginId: "anthropic",
    },
    preparedBackend: {
      backend,
      env: {},
    },
    reusableCliSession: { mode: "none" },
    hadSessionFile: false,
    contextEngineConfig: {},
    modelId: "sonnet",
    normalizedModel: "sonnet",
    systemPrompt: "You are a helpful assistant.",
    systemPromptReport: {} as PreparedCliRunContext["systemPromptReport"],
    bootstrapPromptWarningLines: [],
    authEpochVersion: 2,
  };
}

function getProcessSupervisorForTest() {
  return {
    spawn: (params: Parameters<SupervisorSpawnFn>[0]) =>
      supervisorSpawnMock(params) as ReturnType<SupervisorSpawnFn>,
    cancel: vi.fn(),
    cancelScope: vi.fn(),
    getRecord: vi.fn(),
  };
}

function installLiveStdoutDriver(): {
  cancel: ReturnType<typeof vi.fn>;
  userInputUuids: string[];
  stdout: {
    emit: (chunk: string) => void;
    waitReady: () => Promise<void>;
  };
} {
  let stdoutListener: ((chunk: string) => void) | undefined;
  const cancel = vi.fn();
  const userInputUuids: string[] = [];
  let markReady: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const stdin = {
    write: vi.fn((data: string, cb?: (err?: Error | null) => void) => {
      const parsed = JSON.parse(data) as { type?: string; uuid?: string };
      if (parsed.type === "user" && typeof parsed.uuid === "string") {
        userInputUuids.push(parsed.uuid);
        stdoutListener?.(
          jsonl([{ type: "command_lifecycle", command_uuid: parsed.uuid, state: "started" }]),
        );
      }
      cb?.();
      markReady?.();
    }),
    end: vi.fn(),
  };
  supervisorSpawnMock.mockImplementation(async (...args: unknown[]) => {
    const input = (args[0] ?? {}) as { onStdout?: (chunk: string) => void };
    stdoutListener = input.onStdout;
    return {
      runId: "live-img-run",
      pid: 4242,
      startedAtMs: Date.now(),
      stdin,
      wait: vi.fn(() => new Promise(() => {})),
      cancel,
    };
  });
  return {
    cancel,
    userInputUuids,
    stdout: {
      emit: (chunk: string) => {
        stdoutListener?.(chunk);
      },
      waitReady: () => ready,
    },
  };
}

function jsonl(lines: unknown[]): string {
  return lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
}

function startLiveTurn(params: {
  runId: string;
  onToolResult?: (delta: CliToolResultDelta) => void;
}) {
  const context = buildPreparedCliRunContext({ runId: params.runId });
  return runClaudeLiveSessionTurn({
    context,
    args: context.preparedBackend.backend.args ?? [],
    env: {},
    prompt: "hi",
    useResume: false,
    noOutputTimeoutMs: 5_000,
    getProcessSupervisor: getProcessSupervisorForTest,
    onAssistantDelta: () => {},
    onToolResult: params.onToolResult,
    cleanup: async () => {},
  });
}

function imageToolResultLine(params: {
  toolCallId: string;
  base64: string;
}): Record<string, unknown> {
  return {
    type: "user",
    session_id: "live-img",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: params.toolCallId,
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/jpeg",
                data: params.base64,
              },
            },
          ],
        },
      ],
    },
  };
}

describe("claude live session image payload metering", () => {
  it("completes a photo-heavy turn instead of tripping the raw-chars output cap", async () => {
    const driver = installLiveStdoutDriver();
    const resultPromise = startLiveTurn({ runId: "run-img-over-cap" });
    await driver.stdout.waitReady();

    // Three tool_result lines carrying ~3 MiB of base64 image data each: the
    // turn-level raw-chars cap is 8 MiB, so without stub metering the turn
    // would abort with "Claude CLI turn output exceeded limit". Lines are
    // emitted one per chunk, as the CLI writes them; a single multi-MiB chunk
    // would instead trip the pending-line buffer cap.
    const bigImage = "A".repeat(3 * 1024 * 1024);
    for (const line of [
      { type: "system", subtype: "init", session_id: "live-img" },
      {
        type: "assistant",
        session_id: "live-img",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Reading photos." }],
        },
      },
      imageToolResultLine({ toolCallId: "tool-img-1", base64: bigImage }),
      imageToolResultLine({ toolCallId: "tool-img-2", base64: bigImage }),
      imageToolResultLine({ toolCallId: "tool-img-3", base64: bigImage }),
      {
        type: "assistant",
        session_id: "live-img",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Summarized the photos." }],
        },
      },
      {
        type: "result",
        subtype: "success",
        session_id: "live-img",
        result: "Summarized the photos.",
        stop_reason: "end_turn",
      },
    ]) {
      driver.stdout.emit(`${JSON.stringify(line)}\n`);
    }

    const result = await resultPromise;
    expect(result.output.text).toContain("Summarized the photos.");
    expect(driver.cancel).not.toHaveBeenCalled();
  });

  it("feeds the streaming parser stubbed image payloads instead of raw base64", async () => {
    const driver = installLiveStdoutDriver();
    const onToolResult = vi.fn();
    const resultPromise = startLiveTurn({ runId: "run-img-stub", onToolResult });
    await driver.stdout.waitReady();

    const bigImage = "A".repeat(1024 * 1024);
    driver.stdout.emit(
      jsonl([
        { type: "system", subtype: "init", session_id: "live-img" },
        imageToolResultLine({ toolCallId: "tool-img-stub", base64: bigImage }),
        {
          type: "assistant",
          session_id: "live-img",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Done." }],
          },
        },
        {
          type: "result",
          subtype: "success",
          session_id: "live-img",
          result: "Done.",
          stop_reason: "end_turn",
        },
      ]),
    );

    await resultPromise;
    const delta = onToolResult.mock.calls[0]?.[0];
    expect(delta).toMatchObject({ toolCallId: "tool-img-stub" });
    const blocks = delta?.result as Array<Record<string, unknown>>;
    expect(Array.isArray(blocks)).toBe(true);
    const source = blocks[0]?.source as Record<string, unknown> | undefined;
    expect(source?.data).toBe(`[image: ${bigImage.length} base64 chars omitted]`);
  });
});
