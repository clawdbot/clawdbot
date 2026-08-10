/** Claude live-session capability negotiation and input ownership tests. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliBackendParseJsonlEvent } from "../../plugins/cli-backend.types.js";
import type { getProcessSupervisor } from "../../process/supervisor/index.js";
import { buildClaudeLiveRunContext, mockClaudeLiveRun } from "../cli-runner.test-helpers.js";
import { supervisorSpawnMock } from "../cli-runner.test-support.js";
import { runClaudeLiveSessionTurn } from "./claude-live-session.js";
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
    onPhase?: (phase: "send" | "resolve") => void;
    parseJsonlEvent?: CliBackendParseJsonlEvent;
  } = {},
) {
  const context = buildClaudeLiveRunContext({
    runId,
    timeoutMs: 60_000,
    liveSessionRequirement,
    backend: { resumeArgs: ["-p", "--resume", "{sessionId}"] },
  });
  context.backendResolved.parseJsonlEvent = options.parseJsonlEvent;
  return runClaudeLiveSessionTurn({
    context,
    args: context.preparedBackend.backend.args ?? [],
    env: {},
    prompt: "hi",
    useResume,
    noOutputTimeoutMs: 5_000,
    getProcessSupervisor: getProcessSupervisorForTest,
    onAssistantDelta: () => {},
    onPhase: options.onPhase,
    cleanup: async () => {},
  });
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
        startLiveTurn(`run-capable-${testCase.label}`, testCase.useResume),
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
        startLiveTurn(`run-legacy-${testCase.label}`, testCase.useResume),
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
