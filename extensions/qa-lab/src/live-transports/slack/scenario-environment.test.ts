// QA Lab Slack tests cover module-specific flow preparation boundaries.
import { describe, expect, it, vi } from "vitest";
import { createSlackQaScenarioEnvironment } from "./scenario-environment.js";
import { slackQaAllowlistBlockScenario } from "./slack-live.scenario-implementations.js";

function createEnvironment() {
  return createSlackQaScenarioEnvironment({
    accountId: "work",
    channelId: "C123456789",
    driverBotUserId: "U123456789",
    driverClient: {} as never,
    sutAppToken: "xapp-test",
    sutBotToken: "xoxb-test",
    sutIdentity: { userId: "U987654321" },
    sutReadClient: {} as never,
    sutWriteClient: {} as never,
  });
}

describe("Slack scenario environment", () => {
  it("leaves generic declarative flows on the adapter's baseline config", async () => {
    const gatewayCall = vi.fn();
    const { prepareFlow } = createEnvironment();

    const prepared = await prepareFlow({
      config: { replyMarker: "QA-THREAD-FOLLOW-UP-OK" },
      gateway: { call: gatewayCall } as never,
      outputDir: "/tmp/slack-output",
      primaryModel: "mock-openai/gpt-5.6-luna",
      scenarioId: "thread-follow-up",
      scenarioTitle: "Thread follow-up",
      timeoutMs: 60_000,
      waitForConfigRestartSettle: vi.fn(),
    });
    expect(prepared.slackScenarioContext.scenario).toEqual({
      id: "thread-follow-up",
      timeoutMs: 60_000,
      title: "Thread follow-up",
    });
    expect(gatewayCall).not.toHaveBeenCalled();
  });

  it("authorizes the exact Slack account and channel array replacement paths", async () => {
    const gatewayCall = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "config.get") {
        return { config: {}, hash: "config-hash" };
      }
      if (method === "config.patch") {
        return { noop: true };
      }
      if (method === "channels.status") {
        return {
          channelAccounts: {
            slack: [
              {
                accountId: "work",
                connected: true,
                lastConnectedAt: Date.now() - 30_000,
                restartPending: false,
                running: true,
              },
            ],
          },
        };
      }
      throw new Error(`unexpected gateway method: ${method}`);
    });
    const { prepareFlow } = createEnvironment();
    const prepared = await prepareFlow({
      config: {},
      gateway: { call: gatewayCall } as never,
      outputDir: "/tmp/slack-output",
      primaryModel: "mock-openai/gpt-5.6-luna",
      scenarioId: "slack-allowlist-block",
      scenarioTitle: "Slack allowlist block",
      timeoutMs: 60_000,
      waitForConfigRestartSettle: vi.fn(),
    });

    await prepared.slackScenarioContext.configureScenario(slackQaAllowlistBlockScenario);

    const patchCall = gatewayCall.mock.calls.find(([method]) => method === "config.patch");
    if (!patchCall) {
      throw new Error("config.patch was not called");
    }
    expect(patchCall[1]).toMatchObject({
      replacePaths: expect.arrayContaining([
        "channels.slack.accounts.work.allowFrom",
        "channels.slack.accounts.work.channels.C123456789.users",
      ]),
    });
  });
});
