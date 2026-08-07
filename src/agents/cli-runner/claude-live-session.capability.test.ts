/** Claude live-session capability negotiation and input ownership tests. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

function startLiveTurn(runId: string, useResume: boolean) {
  const context = buildClaudeLiveRunContext({
    runId,
    timeoutMs: 60_000,
    liveSessionRequirement,
    backend: { resumeArgs: ["-p", "--resume", "{sessionId}"] },
  });
  return runClaudeLiveSessionTurn({
    context,
    args: context.preparedBackend.backend.args ?? [],
    env: {},
    prompt: "hi",
    useResume,
    noOutputTimeoutMs: 5_000,
    getProcessSupervisor: getProcessSupervisorForTest,
    onAssistantDelta: () => {},
    cleanup: async () => {},
  });
}

describe("Claude live-session capability negotiation", () => {
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
