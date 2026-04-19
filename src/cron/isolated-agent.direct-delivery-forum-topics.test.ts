import "./isolated-agent.mocks.js";
import { beforeEach, describe, expect, it } from "vitest";
import { runSubagentAnnounceFlow } from "../agents/subagent-announce.js";
import {
  createCliDeps,
  expectDirectTelegramDelivery,
  mockAgentPayloads,
  runTelegramAnnounceTurn,
} from "./isolated-agent.delivery.test-helpers.js";
import { withTempCronHome, writeSessionStore } from "./isolated-agent.test-harness.js";
import { setupIsolatedAgentTurnMocks } from "./isolated-agent.test-setup.js";

function makeRunMeta(finalAssistantVisibleText: string) {
  return {
    durationMs: 5,
    agentMeta: { sessionId: "s", provider: "p", model: "m" },
    finalAssistantVisibleText,
  };
}

async function expectTelegramAnnounceDelivery({
  expected,
  meta,
  payloads,
  to,
}: {
  expected: Parameters<typeof expectDirectTelegramDelivery>[1];
  meta?: Parameters<typeof mockAgentPayloads>[1];
  payloads: Parameters<typeof mockAgentPayloads>[0];
  to: string;
}): Promise<void> {
  await withTempCronHome(async (home) => {
    const storePath = await writeSessionStore(home, { lastProvider: "webchat", lastTo: "" });
    const deps = createCliDeps();
    if (meta) {
      mockAgentPayloads(payloads, meta);
    } else {
      mockAgentPayloads(payloads);
    }

    const res = await runTelegramAnnounceTurn({
      home,
      storePath,
      deps,
      delivery: { mode: "announce", channel: "telegram", to },
    });

    expect(res.status).toBe("ok");
    expect(res.delivered).toBe(true);
    expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
    expectDirectTelegramDelivery(deps, expected);
  });
}

describe("runCronIsolatedAgentTurn forum topic delivery", () => {
  beforeEach(() => {
    setupIsolatedAgentTurnMocks();
  });

  it("routes forum-topic telegram targets through the correct delivery path", async () => {
    await expectTelegramAnnounceDelivery({
      to: "123:topic:42",
      payloads: [{ text: "forum message" }],
      expected: {
        chatId: "123",
        text: "forum message",
        messageThreadId: 42,
      },
    });
  });

  it("delivers only the final assistant-visible text to forum-topic telegram targets", async () => {
    await expectTelegramAnnounceDelivery({
      to: "123:topic:42",
      payloads: [
        { text: "section 1" },
        { text: "temporary error", isError: true },
        { text: "section 2" },
      ],
      meta: { meta: makeRunMeta("section 1\nsection 2") },
      expected: {
        chatId: "123",
        text: "section 1\nsection 2",
        messageThreadId: 42,
      },
    });
  });

  it("routes plain telegram targets through the correct delivery path", async () => {
    await expectTelegramAnnounceDelivery({
      to: "123",
      payloads: [{ text: "plain message" }],
      expected: {
        chatId: "123",
        text: "plain message",
      },
    });
  });

  it("delivers only the final assistant-visible text to plain telegram targets", async () => {
    await expectTelegramAnnounceDelivery({
      to: "123",
      payloads: [{ text: "Working on it..." }, { text: "Final weather summary" }],
      meta: { meta: makeRunMeta("Final weather summary") },
      expected: {
        chatId: "123",
        text: "Final weather summary",
      },
    });
  });
});
