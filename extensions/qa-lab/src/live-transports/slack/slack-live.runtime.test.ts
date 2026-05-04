import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { __testing, runSlackQaLive } from "./slack-live.runtime.js";

describe("Slack live QA runtime helpers", () => {
  it("resolves env credential payloads", () => {
    expect(
      __testing.resolveSlackQaRuntimeEnv({
        OPENCLAW_QA_SLACK_CHANNEL_ID: "C123456789",
        OPENCLAW_QA_SLACK_DRIVER_BOT_TOKEN: "xoxb-driver",
        OPENCLAW_QA_SLACK_SUT_BOT_TOKEN: "xoxb-sut",
        OPENCLAW_QA_SLACK_SUT_APP_TOKEN: "xapp-sut",
      }),
    ).toEqual({
      channelId: "C123456789",
      driverBotToken: "xoxb-driver",
      sutBotToken: "xoxb-sut",
      sutAppToken: "xapp-sut",
    });
  });

  it("rejects malformed Slack channel ids", () => {
    expect(() =>
      __testing.resolveSlackQaRuntimeEnv({
        OPENCLAW_QA_SLACK_CHANNEL_ID: "qa-channel",
        OPENCLAW_QA_SLACK_DRIVER_BOT_TOKEN: "xoxb-driver",
        OPENCLAW_QA_SLACK_SUT_BOT_TOKEN: "xoxb-sut",
        OPENCLAW_QA_SLACK_SUT_APP_TOKEN: "xapp-sut",
      }),
    ).toThrow("OPENCLAW_QA_SLACK channelId must be a Slack id like C123 or U123.");
  });

  it("parses Convex credential payloads", () => {
    expect(
      __testing.parseSlackQaCredentialPayload({
        channelId: "C123456789",
        driverBotToken: "xoxb-driver",
        sutBotToken: "xoxb-sut",
        sutAppToken: "xapp-sut",
      }),
    ).toEqual({
      channelId: "C123456789",
      driverBotToken: "xoxb-driver",
      sutBotToken: "xoxb-sut",
      sutAppToken: "xapp-sut",
    });
  });

  it("reports standard live transport scenario coverage", () => {
    expect(__testing.SLACK_QA_STANDARD_SCENARIO_IDS).toEqual(["canary", "mention-gating"]);
  });

  it("selects Slack scenarios by id", () => {
    expect(__testing.findScenario(["slack-canary"]).map((scenario) => scenario.id)).toEqual([
      "slack-canary",
    ]);
  });

  it("fails mention-gating when the SUT replies without the marker", async () => {
    const observedMessages: Array<unknown> = [];
    await expect(
      __testing.waitForSlackNoReply({
        channelId: "C123456789",
        client: {
          conversations: {
            history: async () => ({
              messages: [
                {
                  text: "I should not have replied",
                  ts: "2.000000",
                  user: "U999999999",
                },
              ],
            }),
          },
        } as never,
        matchText: "SLACK_QA_NOMENTION_MARKER",
        observedMessages: observedMessages as never,
        observationScenarioId: "slack-mention-gating",
        observationScenarioTitle: "Slack unmentioned bot message does not trigger",
        sentTs: "1.000000",
        sutIdentity: { userId: "U999999999" },
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow("unexpected Slack SUT reply observed");
    expect(observedMessages).toMatchObject([
      {
        matchedScenario: false,
        text: "I should not have replied",
        ts: "2.000000",
        userId: "U999999999",
      },
    ]);
  });

  it("writes artifacts when Convex credential acquisition fails", async () => {
    const outputDir = await fs.mkdtemp(path.join(tmpdir(), "openclaw-slack-qa-"));
    const result = await runSlackQaLive({
      credentialRole: "ci",
      credentialSource: "convex",
      outputDir,
    });

    expect(result.scenarios).toMatchObject([
      {
        id: "slack-canary",
        status: "fail",
      },
    ]);
    expect(result.scenarios[0]?.details).toContain("Missing OPENCLAW_QA_CONVEX_SITE_URL");
    await expect(fs.stat(result.reportPath)).resolves.toMatchObject({
      isFile: expect.any(Function),
    });
    const summary = JSON.parse(await fs.readFile(result.summaryPath, "utf8")) as {
      channelId: string;
      credentials: { kind: string; role?: string; source: string };
    };
    expect(summary.channelId).toBe("<unavailable>");
    expect(summary.credentials).toEqual({
      kind: "slack",
      role: "ci",
      source: "convex",
    });
  });
});
