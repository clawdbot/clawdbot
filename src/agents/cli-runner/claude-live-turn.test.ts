/** Claude live turn parsing, capability negotiation, and input ownership tests. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliBackendParseJsonlEvent } from "../../plugins/cli-backend.types.js";
import type { getProcessSupervisor } from "../../process/supervisor/index.js";
import {
  buildClaudeLiveRunContext,
  expectRejectsWithFields,
  mockClaudeLiveRun,
  type PreparedCliRunContextOverrides,
} from "../cli-runner.test-helpers.js";
import { supervisorSpawnMock } from "../cli-runner.test-support.js";
import { createClaudeApiErrorFixture } from "../test-helpers/claude-api-error-fixture.js";
import { runClaudeTurn } from "./claude-live-session.js";
import { resetClaudeLiveSessionsForTest } from "./claude-live-session.test-support.js";

type ProcessSupervisor = ReturnType<typeof getProcessSupervisor>;
type SupervisorSpawnFn = ProcessSupervisor["spawn"];

const liveSessionRequirement = {
  capability: "msg_lifecycle_v1",
  minimumVersion: "2.1.206",
  versionArgs: ["--version"],
  updateCommand: "claude update",
} as const;

beforeEach(() => {
  resetClaudeLiveSessionsForTest();
  supervisorSpawnMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  resetClaudeLiveSessionsForTest();
});

function getProcessSupervisorForTest() {
  return {
    spawn: (params: Parameters<SupervisorSpawnFn>[0]) =>
      supervisorSpawnMock(params) as ReturnType<SupervisorSpawnFn>,
    cancel: vi.fn(),
    cancelScope: vi.fn(),
    getRecord: vi.fn(),
  };
}

function startLiveTurn(
  runId: string,
  useResume: boolean,
  options: {
    context?: PreparedCliRunContextOverrides;
    abortSignal?: AbortSignal;
    noOutputTimeoutMs?: number;
    requireCapability?: boolean;
    onPhase?: (phase: "send" | "resolve") => void;
    parseJsonlEvent?: CliBackendParseJsonlEvent;
    onToolResult?: (delta: import("../cli-output-contracts.js").CliToolResultDelta) => void;
    resolveToolResultTerminalOutcome?: (
      delta: import("../cli-output-contracts.js").CliToolResultDelta,
    ) => import("./claude-live-turn.js").ClaudeLiveToolTerminalOutcome | undefined;
  } = {},
) {
  const context = buildClaudeLiveRunContext({
    ...options.context,
    runId,
    timeoutMs: options.context?.timeoutMs ?? 60_000,
    ...(options.requireCapability ? { liveSessionRequirement } : {}),
    backend: { resumeArgs: ["-p", "--resume", "{sessionId}"] },
  });
  context.params.abortSignal = options.abortSignal;
  context.backendResolved.parseJsonlEvent = options.parseJsonlEvent;
  return runClaudeTurn({
    context,
    args: context.preparedBackend.backend.args ?? [],
    env: {},
    prompt: "hi",
    useResume,
    noOutputTimeoutMs: options.noOutputTimeoutMs ?? 5_000,
    getProcessSupervisor: getProcessSupervisorForTest,
    onAssistantDelta: () => {},
    onToolResult: options.onToolResult,
    resolveToolResultTerminalOutcome: options.resolveToolResultTerminalOutcome,
    onPhase: options.onPhase,
    cleanup: async () => {},
  });
}

function installLiveStdoutDriver(params: { autoStart?: boolean } = {}) {
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
        if (params.autoStart !== false) {
          stdoutListener?.(
            jsonl([{ type: "command_lifecycle", command_uuid: parsed.uuid, state: "started" }]),
          );
        }
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
      runId: "live-turn-run",
      pid: 4242,
      startedAtMs: Date.now(),
      stdin,
      wait: vi.fn(() => new Promise(() => {})),
      cancel,
    };
  });
  return {
    cancel,
    stdout: {
      emit: (chunk: string) => stdoutListener?.(chunk),
      startCurrentInput: () => {
        const inputUuid = userInputUuids.at(-1);
        if (!inputUuid) {
          throw new Error("Claude input UUID was not written");
        }
        stdoutListener?.(
          jsonl([{ type: "command_lifecycle", command_uuid: inputUuid, state: "started" }]),
        );
      },
      waitReady: () => ready,
    },
  };
}

function jsonl(lines: unknown[]): string {
  return lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
}

describe("Claude live-session capability negotiation", () => {
  it("rejects a malformed terminal result before background-task deferral", async () => {
    const parseJsonlEvent = vi.fn<CliBackendParseJsonlEvent>((line) => {
      const parsed = JSON.parse(line) as { type?: string; result?: string };
      if (parsed.type !== "result" || !parsed.result?.includes('<invoke name="Bash">')) {
        return null;
      }
      return {
        kind: "result",
        errorText:
          "Claude CLI returned malformed tool output (invalid request format): raw tool protocol appeared as assistant text.",
      };
    });
    const phases: Array<"send" | "resolve"> = [];
    const fixture = mockClaudeLiveRun(supervisorSpawnMock, {
      events: [
        {
          type: "system",
          subtype: "init",
          session_id: "live-malformed",
          capabilities: ["msg_lifecycle_v1"],
        },
        {
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [{ task_id: "task-1", task_type: "local_agent", description: "still running" }],
        },
        {
          type: "result",
          subtype: "success",
          session_id: "live-malformed",
          result: [
            '<invoke name="Bash">',
            '<parameter name="command">pwd</parameter>',
            "</invoke>",
          ].join("\n"),
        },
      ],
    });

    await expect(
      startLiveTurn("run-malformed-result", false, {
        parseJsonlEvent,
        onPhase: (phase) => phases.push(phase),
      }),
    ).rejects.toMatchObject({
      name: "FailoverError",
      reason: "format",
      status: 400,
      rawError: expect.stringContaining("raw tool protocol appeared as assistant text"),
    });
    expect(phases).toEqual(["resolve"]);
    expect(fixture.writes.filter((line) => line.includes('"type":"user"'))).toHaveLength(1);
    expect(
      parseJsonlEvent.mock.calls.filter(([line]) => line.includes('"type":"result"')),
    ).toHaveLength(1);
  });

  it.each([
    { label: "fresh", useResume: false },
    { label: "resumed", useResume: true },
  ])(
    "retains a matching start before $label init and trusts capability over version",
    async (testCase) => {
      mockClaudeLiveRun(supervisorSpawnMock, {
        events: [
          {
            type: "system",
            subtype: "init",
            session_id: "live-capable",
            claude_code_version: "2.1.100-custom",
            capabilities: ["interrupt_receipt_v1", "msg_lifecycle_v1", "future_v2"],
          },
          {
            type: "result",
            subtype: "success",
            session_id: "live-capable",
            result: "done",
          },
        ],
      });

      await expect(
        startLiveTurn(`run-capable-${testCase.label}`, testCase.useResume, {
          requireCapability: true,
        }),
      ).resolves.toMatchObject({
        output: { text: "done" },
      });
    },
  );

  it.each([
    { label: "fresh", useResume: false },
    { label: "resumed", useResume: true },
  ])(
    "fails immediately when $label init omits the required lifecycle capability",
    async (testCase) => {
      const fixture = mockClaudeLiveRun(supervisorSpawnMock, {
        events: [
          {
            type: "system",
            subtype: "init",
            session_id: "live-legacy",
            claude_code_version: "2.1.205",
            capabilities: ["interrupt_receipt_v1"],
          },
        ],
      });

      await expect(
        startLiveTurn(`run-legacy-${testCase.label}`, testCase.useResume, {
          requireCapability: true,
        }),
      ).rejects.toMatchObject({
        code: "cli_live_session_unsupported",
        message: expect.stringContaining(
          "Claude Code build (version 2.1.205) did not advertise the required msg_lifecycle_v1 capability",
        ),
      });
      expect(fixture.lifecycle.cancel).toHaveBeenCalledOnce();
    },
  );
});

describe("Claude live turn input ownership and replay safety", () => {
  it("ignores exact synthetic replay until the matching input starts", async () => {
    const driver = installLiveStdoutDriver({ autoStart: false });
    const resultPromise = startLiveTurn("run-synthetic-placeholder", true);
    await driver.stdout.waitReady();

    driver.stdout.emit(
      jsonl([
        { type: "system", subtype: "init", session_id: "live-synthetic" },
        {
          type: "assistant",
          session_id: "live-synthetic",
          message: {
            model: "<synthetic>",
            role: "assistant",
            content: [{ type: "text", text: "No response requested." }],
          },
        },
        {
          type: "result",
          subtype: "success",
          session_id: "live-synthetic",
          result: "",
        },
        {
          type: "command_lifecycle",
          command_uuid: "prior-synthetic-input",
          state: "completed",
        },
      ]),
    );

    let settled = false;
    void resultPromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(driver.cancel).not.toHaveBeenCalled();

    driver.stdout.startCurrentInput();
    driver.stdout.emit(
      jsonl([
        {
          type: "assistant",
          session_id: "live-synthetic",
          message: {
            model: "claude-fable-5",
            role: "assistant",
            content: [{ type: "text", text: "The background work is complete." }],
          },
        },
        {
          type: "result",
          subtype: "success",
          session_id: "live-synthetic",
          result: "The background work is complete.",
        },
      ]),
    );

    const result = await resultPromise;
    expect(result.output.text).toBe("The background work is complete.");
    expect(driver.cancel).not.toHaveBeenCalled();
  });

  it("ignores markerless prior results until the matching input starts", async () => {
    const driver = installLiveStdoutDriver({ autoStart: false });
    const resultPromise = startLiveTurn("run-markerless-prior-result", true);
    await driver.stdout.waitReady();

    driver.stdout.emit(
      jsonl([
        {
          type: "result",
          subtype: "success",
          session_id: "live-markerless",
          result: "",
          origin: { kind: "task-notification" },
        },
        {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          session_id: "live-markerless",
          result: "prior task failed",
        },
        {
          type: "command_lifecycle",
          command_uuid: "prior-markerless-input",
          state: "completed",
        },
      ]),
    );
    let settled = false;
    void resultPromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    driver.stdout.startCurrentInput();
    driver.stdout.emit(
      jsonl([
        {
          type: "assistant",
          session_id: "live-markerless",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "current answer" }],
          },
        },
        {
          type: "result",
          subtype: "success",
          session_id: "live-markerless",
          result: "current answer",
        },
      ]),
    );

    await expect(resultPromise).resolves.toMatchObject({ output: { text: "current answer" } });
    expect(driver.cancel).not.toHaveBeenCalled();
  });

  it("does not defer ordinary or non-empty results that resemble a synthetic placeholder", async () => {
    const ordinaryDriver = installLiveStdoutDriver();
    const ordinaryPromise = startLiveTurn("run-ordinary-placeholder", false);
    await ordinaryDriver.stdout.waitReady();
    ordinaryDriver.stdout.emit(
      jsonl([
        { type: "system", subtype: "init", session_id: "live-ordinary-placeholder" },
        {
          type: "assistant",
          session_id: "live-ordinary-placeholder",
          message: {
            model: "claude-fable-5",
            role: "assistant",
            content: [{ type: "text", text: "No response requested." }],
          },
        },
        {
          type: "result",
          subtype: "success",
          session_id: "live-ordinary-placeholder",
          result: "",
        },
      ]),
    );
    const ordinary = await ordinaryPromise;
    expect(ordinary.output.text).toBe("");
    expect(ordinaryDriver.cancel).not.toHaveBeenCalled();

    resetClaudeLiveSessionsForTest();
    const nonEmptyDriver = installLiveStdoutDriver();
    const nonEmptyPromise = startLiveTurn("run-synthetic-nonempty", true);
    await nonEmptyDriver.stdout.waitReady();
    nonEmptyDriver.stdout.emit(
      jsonl([
        { type: "system", subtype: "init", session_id: "live-synthetic-nonempty" },
        {
          type: "assistant",
          session_id: "live-synthetic-nonempty",
          message: {
            model: "<synthetic>",
            role: "assistant",
            content: [{ type: "text", text: "No response requested." }],
          },
        },
        {
          type: "result",
          subtype: "success",
          session_id: "live-synthetic-nonempty",
          result: "real answer",
        },
      ]),
    );
    const nonEmpty = await nonEmptyPromise;
    expect(nonEmpty.output.text).toBe("real answer");
    expect(nonEmptyDriver.cancel).not.toHaveBeenCalled();
  });

  it("fails a current-input synthetic placeholder on a fresh live process", async () => {
    const driver = installLiveStdoutDriver();
    const resultPromise = startLiveTurn("run-synthetic-fresh", false);
    await driver.stdout.waitReady();
    driver.stdout.emit(
      jsonl([
        { type: "system", subtype: "init", session_id: "live-synthetic-fresh" },
        {
          type: "assistant",
          session_id: "live-synthetic-fresh",
          message: {
            model: "<synthetic>",
            role: "assistant",
            content: [{ type: "text", text: "No response requested." }],
          },
        },
        {
          type: "result",
          subtype: "success",
          session_id: "live-synthetic-fresh",
          result: "",
        },
      ]),
    );

    await expect(resultPromise).rejects.toMatchObject({
      name: "FailoverError",
      reason: "format",
      code: "cli_synthetic_no_response",
    });
    expect(driver.cancel).toHaveBeenCalledWith("manual-cancel");
  });

  it("times out and cleans up when lifecycle records never start the current input", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const driver = installLiveStdoutDriver({ autoStart: false });
    const resultPromise = startLiveTurn("run-missing-input-lifecycle", true, {
      context: { timeoutMs: 60_000 },
      noOutputTimeoutMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(0);
    await driver.stdout.waitReady();

    driver.stdout.emit(
      jsonl([
        {
          type: "command_lifecycle",
          command_uuid: "unrelated-input",
          state: "started",
        },
        {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          session_id: "live-missing-lifecycle",
          result: "unrelated failure",
        },
      ]),
    );

    const rejection = expect(resultPromise).rejects.toMatchObject({
      name: "FailoverError",
      code: undefined,
      cliTimeout: {
        mode: "no-output",
        timeoutSeconds: 1,
        observedActivity: true,
        activeToolCount: 0,
        backgroundTaskCount: 0,
      },
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;
    expect(driver.cancel).toHaveBeenCalledWith("manual-cancel");
  });

  it.each([
    {
      label: "does not replay after current-turn synthetic output",
      useResume: true,
      expectedCode: undefined,
      chunk: jsonl([
        { type: "system", subtype: "init", session_id: "live-synthetic-no-result" },
        {
          type: "assistant",
          session_id: "live-synthetic-no-result",
          message: {
            model: "<synthetic>",
            role: "assistant",
            content: [{ type: "text", text: "No response requested." }],
          },
        },
      ]),
    },
    {
      label: "marks a resumed init-only stall as safe for recovery",
      useResume: true,
      expectedCode: "cli_no_output_timeout",
      chunk: jsonl([{ type: "system", subtype: "init", session_id: "live-init-no-result" }]),
    },
    {
      label: "does not mark a fresh init-only stall as safe to replay",
      useResume: false,
      expectedCode: undefined,
      chunk: jsonl([{ type: "system", subtype: "init", session_id: "live-fresh-init-no-result" }]),
    },
    {
      label: "does not mark a stall as retryable after substantive assistant output",
      useResume: true,
      expectedCode: undefined,
      chunk: jsonl([
        { type: "system", subtype: "init", session_id: "live-synthetic-substantive" },
        {
          type: "assistant",
          session_id: "live-synthetic-substantive",
          message: {
            model: "<synthetic>",
            role: "assistant",
            content: [{ type: "text", text: "No response requested." }],
          },
        },
        {
          type: "assistant",
          session_id: "live-synthetic-substantive",
          message: {
            model: "claude-fable-5",
            role: "assistant",
            content: [{ type: "text", text: "Partial real answer" }],
          },
        },
      ]),
    },
    {
      label: "does not mark an incomplete stdout record as safe to replay",
      useResume: true,
      expectedCode: undefined,
      chunk: '{"type":"assistant","message":{"model":"claude-fable-5"',
    },
  ])("$label", async ({ useResume, expectedCode, chunk }) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const driver = installLiveStdoutDriver();
    const resultPromise = startLiveTurn(
      `run-replay-safe-stall-${useResume ? "resume" : "fresh"}`,
      useResume,
      {
        context: { timeoutMs: 60_000 },
        noOutputTimeoutMs: 1_000,
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    await driver.stdout.waitReady();
    driver.stdout.emit(chunk);

    const errorPromise = resultPromise.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    const error = (await errorPromise) as { code?: string; cliTimeout?: unknown };
    expect(error).toMatchObject({
      name: "FailoverError",
      cliTimeout: {
        mode: "no-output",
        timeoutSeconds: 1,
        observedActivity: true,
        activeToolCount: 0,
        backgroundTaskCount: 0,
      },
    });
    expect(error.code).toBe(expectedCode);
    expect(driver.cancel).toHaveBeenCalledWith("manual-cancel");
  });

  it("still aborts on the turn timeout after input starts but never returns a result", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const driver = installLiveStdoutDriver();
    const resultPromise = startLiveTurn("run-synthetic-timeout", true, {
      context: { timeoutMs: 5_000 },
      noOutputTimeoutMs: 60_000,
    });
    await vi.advanceTimersByTimeAsync(0);
    await driver.stdout.waitReady();

    driver.stdout.emit(
      jsonl([
        { type: "system", subtype: "init", session_id: "live-synthetic-timeout" },
        {
          type: "assistant",
          session_id: "live-synthetic-timeout",
          message: {
            model: "<synthetic>",
            role: "assistant",
            content: [{ type: "text", text: "Continue from where you left off." }],
          },
        },
      ]),
    );

    const rejection = expect(resultPromise).rejects.toMatchObject({
      name: "FailoverError",
      message: expect.stringMatching(/exceeded timeout/i),
      code: "cli_overall_timeout",
      cliTimeout: {
        mode: "overall",
        timeoutSeconds: 5,
        observedActivity: true,
        activeToolCount: 0,
        backgroundTaskCount: 0,
      },
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await rejection;
    expect(driver.cancel).toHaveBeenCalledWith("manual-cancel");
  });

  it("fails immediately when an error result follows a synthetic placeholder", async () => {
    const driver = installLiveStdoutDriver();
    const resultPromise = startLiveTurn("run-synthetic-error", true);
    await driver.stdout.waitReady();

    driver.stdout.emit(
      jsonl([
        { type: "system", subtype: "init", session_id: "live-synthetic-error" },
        {
          type: "assistant",
          session_id: "live-synthetic-error",
          message: {
            model: "<synthetic>",
            role: "assistant",
            content: [{ type: "text", text: "No response requested." }],
          },
        },
        {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          session_id: "live-synthetic-error",
          result: "provider failed",
        },
      ]),
    );

    await expect(resultPromise).rejects.toMatchObject({
      name: "FailoverError",
      rawError: expect.stringMatching(/provider failed/i),
    });
  });

  it("fails the turn on an error result even when background tasks are outstanding", async () => {
    const driver = installLiveStdoutDriver();
    const phases: Array<"send" | "resolve"> = [];
    const resultPromise = startLiveTurn("run-bg-error", false, {
      onPhase: (phase) => phases.push(phase),
    });
    await driver.stdout.waitReady();

    driver.stdout.emit(
      jsonl([
        { type: "system", subtype: "init", session_id: "live-bg-err" },
        {
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [{ task_id: "task-err", task_type: "local_agent", description: "stuck" }],
        },
        {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          session_id: "live-bg-err",
          result: "agent crashed",
        },
      ]),
    );

    await expect(resultPromise).rejects.toMatchObject({
      name: "FailoverError",
      rawError: expect.stringMatching(/agent crashed/i),
    });
    expect(phases).toEqual(["resolve"]);
  });
});

describe("Claude live turn output bounds and result projection", () => {
  it("accepts Claude live stream-json lines larger than 256 KiB", async () => {
    const largeText = "x".repeat(270 * 1024);
    mockClaudeLiveRun(supervisorSpawnMock, {
      events: [{ type: "result", session_id: "live-session-large", result: largeText }],
    });

    const result = await startLiveTurn("run-live-large", false);

    expect(result.output.text).toHaveLength(largeText.length);
    expect(result.output.text).toBe(largeText);
  });

  it("frames coalesced Claude live image and PDF records before omitting retained bytes", async () => {
    const toolResults: unknown[] = [];
    const base64 = "a".repeat(4_300_000);
    mockClaudeLiveRun(supervisorSpawnMock, {
      onWrite: ({ emit }) => {
        const events: Record<string, unknown>[] = [
          { type: "system", subtype: "init", session_id: "live-binary-results" },
        ];
        for (const [type, mediaType] of [
          ["image", "image/png"],
          ["document", "application/pdf"],
        ] as const) {
          events.push(
            {
              type: "assistant",
              session_id: "live-binary-results",
              message: {
                role: "assistant",
                content: [{ type: "tool_use", id: `read-${type}`, name: "Read", input: {} }],
              },
            },
            {
              type: "user",
              session_id: "live-binary-results",
              message: {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: `read-${type}`,
                    content: [
                      { type: "text", text: `Read ${type}` },
                      { type, source: { type: "base64", media_type: mediaType, data: base64 } },
                    ],
                  },
                ],
              },
            },
          );
        }
        events.push({
          type: "result",
          session_id: "live-binary-results",
          result: "both files read",
        });
        emit(events);
      },
    });

    const result = await startLiveTurn("run-live-binary-results", false, {
      onToolResult: (delta) => toolResults.push(delta.result),
    });

    expect(result.output.text).toBe("both files read");
    expect(toolResults).toEqual([
      [
        { type: "text", text: "Read image" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png" },
          omitted: true,
          bytes: 3_225_000,
        },
      ],
      [
        { type: "text", text: "Read document" },
        {
          type: "document",
          source: { type: "base64", media_type: "application/pdf" },
          omitted: true,
          bytes: 3_225_000,
        },
      ],
    ]);
  });

  it.each([
    {
      name: "an oversized complete line",
      chunks: () => [`${"a".repeat(8 * 1024 * 1024 + 1)}\n`],
    },
    {
      name: "an oversized growing unterminated line",
      chunks: () => ["a".repeat(4_300_000), "a".repeat(4_300_000)],
    },
  ])("rejects $name from Claude live stdout", async ({ chunks }) => {
    const live: ReturnType<typeof mockClaudeLiveRun> = mockClaudeLiveRun(supervisorSpawnMock, {
      onWrite: () => {
        for (const chunk of chunks()) {
          live.spawnInput.onStdout?.(chunk);
        }
      },
    });

    await expect(startLiveTurn("run-live-oversized-line", false)).rejects.toThrow(
      "CLI JSONL line exceeded 8388608 characters; refusing to parse output.",
    );
  });

  it.each([
    {
      name: "a coalesced blank-frame flood",
      createChunk: () => "\n".repeat(20_001),
      expectedError: "CLI JSONL output exceeded 20000 lines; refusing to parse output.",
    },
    {
      name: "whitespace-only records exceeding the raw budget",
      createChunk: () => `${" ".repeat(4_300_000)}\n${" ".repeat(4_300_000)}\n`,
      expectedError: "CLI JSONL output exceeded 8388608 characters; refusing to parse output.",
    },
    {
      name: "valid JSON padded beyond the raw budget",
      createChunk: () => `${" ".repeat(4_300_000)}{}\n${" ".repeat(4_300_000)}{}\n`,
      expectedError: "CLI JSONL output exceeded 8388608 characters; refusing to parse output.",
    },
    {
      name: "internal formatting around compacted Claude media",
      createChunk: () => {
        const line = JSON.stringify({
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "padded-live-image",
                content: [
                  {
                    type: "image",
                    source: { type: "base64", media_type: "image/png", data: "YQ==" },
                  },
                ],
              },
            ],
          },
        }).replace('"message":', `"message":${" ".repeat(4_300_000)}`);
        return `${line}\n${line}\n`;
      },
      expectedError: "CLI JSONL output exceeded 8388608 characters; refusing to parse output.",
    },
  ])("reports the exact limit for $name", async ({ createChunk, expectedError }) => {
    const live: ReturnType<typeof mockClaudeLiveRun> = mockClaudeLiveRun(supervisorSpawnMock, {
      onWrite: () => live.spawnInput.onStdout?.(createChunk()),
    });

    await expect(startLiveTurn("run-live-output-budget", false)).rejects.toThrow(expectedError);
  });

  it("reports backend JSONL parser failures without relabeling them as output limits", async () => {
    mockClaudeLiveRun(supervisorSpawnMock, {
      events: [{ type: "system", subtype: "init", session_id: "live-parser-error" }],
    });

    await expectRejectsWithFields(
      startLiveTurn("run-live-parser-error", false, {
        parseJsonlEvent: () => {
          throw new Error("invalid custom event");
        },
      }),
      {
        name: "FailoverError",
        reason: "format",
        message: "CLI backend claude-cli JSONL parser failed: invalid custom event",
      },
    );
  });

  it("ignores non-JSON stdout lines from Claude live sessions", async () => {
    mockClaudeLiveRun(supervisorSpawnMock, {
      events: [
        "Claude CLI warning",
        { type: "system", subtype: "init", session_id: "live-mixed" },
        { type: "result", session_id: "live-mixed", result: "mixed-ok" },
      ],
    });

    const result = await startLiveTurn("run-live-mixed", false);
    expect(result.output.text).toBe("mixed-ok");
  });

  it("fails Claude live turns on is_error results", async () => {
    mockClaudeLiveRun(supervisorSpawnMock, {
      events: [
        { type: "system", subtype: "init", session_id: "live-error" },
        {
          type: "result",
          session_id: "live-error",
          is_error: true,
          result: "Credit balance is too low",
        },
      ],
    });

    await expectRejectsWithFields(startLiveTurn("run-live-error", false), {
      name: "FailoverError",
      message: "Credit balance is too low",
    });
  });

  it("surfaces Claude live max-turn results with run and session recovery context", async () => {
    mockClaudeLiveRun(supervisorSpawnMock, {
      events: [
        { type: "system", subtype: "init", session_id: "live-max-turns" },
        {
          type: "result",
          subtype: "error_max_turns",
          session_id: "live-max-turns",
          num_turns: 2,
          stop_reason: "tool_use",
          terminal_reason: "max_turns",
          errors: ["Reached maximum number of turns (1)"],
        },
      ],
    });

    await expectRejectsWithFields(startLiveTurn("run-live-max-turns", false), {
      name: "FailoverError",
      message:
        "Claude CLI stopped after reaching the maximum number of turns (limit: 1). " +
        "OpenClaw run: run-live-max-turns. OpenClaw session: s1. " +
        "Claude session: live-max-turns. Tool actions may already have run; verify their effects before retrying. " +
        "Retry with a higher --max-turns value or a narrower task.",
      sessionId: "s1",
      reason: "unknown",
      code: "cli_max_turns",
      rawError: "Reached maximum number of turns (1)",
    });
  });

  it("surfaces nested Claude stream-json API errors instead of raw event output", async () => {
    const { message, jsonl: apiErrorJsonl } = createClaudeApiErrorFixture();
    mockClaudeLiveRun(supervisorSpawnMock, {
      events: apiErrorJsonl.split("\n"),
    });

    await expectRejectsWithFields(startLiveTurn("run-live-api-error", false), {
      name: "FailoverError",
      message,
      reason: "billing",
      status: 402,
    });
  });
});
