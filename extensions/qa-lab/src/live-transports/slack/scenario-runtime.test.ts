import { afterEach, describe, expect, it, vi } from "vitest";
import { runSlackScenario } from "./scenario-runtime.js";
import type { SlackQaScenarioImplementation, SlackQaScenarioRun } from "./slack-live.contracts.js";
import { slackQaMpimAppMentionDedupeScenario } from "./slack-live.scenario-implementations.js";

const { runSlackApprovalScenario, runSlackCodexApprovalScenario } = vi.hoisted(() => ({
  runSlackApprovalScenario: vi.fn(),
  runSlackCodexApprovalScenario: vi.fn(),
}));

vi.mock("./slack-live.approvals.js", () => ({ runSlackApprovalScenario }));
vi.mock("./slack-live.codex-approval-runner.js", () => ({ runSlackCodexApprovalScenario }));

function createMpimRuntime(
  capturedMessages: Array<{ channelId: string; text: string; ts: string }>,
) {
  const builtRun = slackQaMpimAppMentionDedupeScenario.buildRun("U_SUT");
  if (
    builtRun.kind === "approval" ||
    builtRun.kind === "codex-approval" ||
    builtRun.kind === "direct-transport"
  ) {
    throw new Error("expected Slack MPIM message scenario");
  }
  const markerText = `${builtRun.matchText}_BOT_TESTNONCE`;
  const run = {
    ...builtRun,
    afterReply: undefined,
    beforeRun: undefined,
    cleanup: undefined,
    settleObservedMs: undefined,
  };
  const postMessage = vi.fn().mockResolvedValue({ channel: "C_MPIM", ts: "1.000000" });
  const history = vi.fn().mockResolvedValue({
    messages: [
      {
        bot_id: "B_SUT",
        text: markerText,
        thread_ts: "1.000000",
        ts: "2.000000",
        user: "U_SUT",
      },
    ],
  });
  const environment = {
    channelId: "C_MPIM",
    configureScenario: vi.fn().mockResolvedValue({
      cfg: {},
      primaryModel: "mock-openai/gpt-5.6-luna",
      run,
    }),
    context: {
      driverClient: { chat: { postMessage } },
      sutReadClient: { conversations: { history } },
    },
    getMessageWriteCursor: () => 0,
    observedMessages: [],
    readMessageWrites: vi.fn().mockResolvedValue(capturedMessages),
    scenario: {
      id: "slack-mpim-app-mention-dedupe",
      timeoutMs: 1_000,
      title: "Slack MPIM app mention dispatches once with thread context",
    },
    sutIdentity: { botId: "B_SUT", userId: "U_SUT" },
  };
  return {
    env: environment as never,
    marker: markerText,
    postMessage,
    writes: environment.readMessageWrites,
  };
}

function createScenarioRuntime(run: SlackQaScenarioRun) {
  const implementation = {
    buildRun: () => run,
  } satisfies SlackQaScenarioImplementation;
  const environment = {
    channelId: "C_QA",
    configureScenario: vi.fn().mockResolvedValue({
      cfg: {},
      primaryModel: "openai/gpt-5.6-luna",
      run,
    }),
    context: {},
    observedMessages: [],
    scenario: {
      id: "slack-rtt",
      timeoutMs: 30_000,
      title: "Slack RTT",
    },
    stopGateway: vi.fn(),
    sutAccountId: "sut",
    sutIdentity: { userId: "U_SUT" },
  };
  return { environment: environment as never, implementation };
}

function expectRttEvidence(params: {
  requestStartedAt: string;
  responseObservedAt: string;
  result: unknown;
  rttMs: number;
  source: "approval-request-to-resolution" | "request-to-observed-message";
}) {
  expect(params.result).toEqual(
    expect.objectContaining({
      requestStartedAt: params.requestStartedAt,
      responseObservedAt: params.responseObservedAt,
      rttMs: params.rttMs,
      rttMeasurement: {
        finalMatchedReplyRttMs: params.rttMs,
        requestStartedAt: params.requestStartedAt,
        responseObservedAt: params.responseObservedAt,
        source: params.source,
      },
    }),
  );
}

describe("Slack scenario runtime capture merge", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("returns structured RTT evidence for a matched reply", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-03T12:00:00.000Z");
    const runtime = createMpimRuntime([]);
    runtime.postMessage.mockImplementationOnce(async () => {
      vi.advanceTimersByTime(1_750);
      return { channel: "C_MPIM", ts: "1.000000" };
    });

    expectRttEvidence({
      requestStartedAt: "2026-09-03T12:00:00.000Z",
      responseObservedAt: "2026-09-03T12:00:01.750Z",
      result: await runSlackScenario(runtime.env, slackQaMpimAppMentionDedupeScenario),
      rttMs: 1_750,
      source: "request-to-observed-message",
    });
  });

  it("returns structured RTT evidence for a native approval", async () => {
    const runtime = createScenarioRuntime({
      approvalKind: "exec",
      decision: "allow-once",
      kind: "approval",
      token: "SLACK_QA_APPROVAL",
    });
    runSlackApprovalScenario.mockResolvedValueOnce({
      artifact: { approvalId: "approval-1" },
      requestStartedAt: new Date("2026-09-03T12:00:00.000Z"),
      responseObservedAt: new Date("2026-09-03T12:00:01.250Z"),
      rttMs: 1_250,
    });

    expectRttEvidence({
      requestStartedAt: "2026-09-03T12:00:00.000Z",
      responseObservedAt: "2026-09-03T12:00:01.250Z",
      result: await runSlackScenario(runtime.environment, runtime.implementation),
      rttMs: 1_250,
      source: "approval-request-to-resolution",
    });
  });

  it("returns structured RTT evidence for a Codex approval", async () => {
    const runtime = createScenarioRuntime({
      approvalKind: "plugin",
      appServerMethod: "item/commandExecution/requestApproval",
      decision: "allow-once",
      kind: "codex-approval",
      token: "SLACK_QA_CODEX_APPROVAL",
    });
    runSlackCodexApprovalScenario.mockResolvedValueOnce({
      artifact: { approvalId: "approval-2" },
      requestStartedAt: new Date("2026-09-03T12:00:00.000Z"),
      responseObservedAt: new Date("2026-09-03T12:00:02.500Z"),
      rttMs: 2_500,
    });

    expectRttEvidence({
      requestStartedAt: "2026-09-03T12:00:00.000Z",
      responseObservedAt: "2026-09-03T12:00:02.500Z",
      result: await runSlackScenario(runtime.environment, runtime.implementation),
      rttMs: 2_500,
      source: "approval-request-to-resolution",
    });
  });

  it.each([
    ["ignores off-channel captured commentary", "C_OTHER", "commentary", "1.500000", undefined],
    [
      "rejects a second same-channel non-marker response",
      "C_MPIM",
      "commentary",
      "2.500000",
      "1 marker match(es)",
    ],
    ["rejects two marker responses", "C_MPIM", "MARKER", "2.500000", "2 marker match(es)"],
    ["deduplicates the same Slack timestamp", "C_MPIM", "MARKER", "2.000000", undefined],
  ])("%s", async (_label, channelId, capturedText, ts, expectedMarkerCount) => {
    const runtime = createMpimRuntime([]);
    runtime.writes.mockResolvedValue([
      {
        channelId,
        text: capturedText === "MARKER" ? runtime.marker : capturedText,
        ts,
      },
    ]);
    const result = runSlackScenario(runtime.env, slackQaMpimAppMentionDedupeScenario);
    if (expectedMarkerCount) {
      await expect(result).rejects.toThrow(`got 2 response(s) and ${expectedMarkerCount}`);
      return;
    }
    await expect(result).resolves.toEqual(
      expect.objectContaining({ details: expect.stringContaining("one MPIM reply observed") }),
    );
  });
});
