import { describe, expect, it, vi } from "vitest";
import { runSlackScenario } from "./scenario-runtime.js";
import { slackQaMpimAppMentionDedupeScenario } from "./slack-live.scenario-implementations.js";

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
  return { env: environment as never, marker: markerText, writes: environment.readMessageWrites };
}

describe("Slack scenario runtime capture merge", () => {
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
