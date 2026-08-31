import { Command } from "commander";
import type { LiveTransportQaSuiteCommandOptions } from "openclaw/plugin-sdk/qa-runner-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runLiveTransportQaSuiteCommand = vi.hoisted(() =>
  vi.fn<(params: LiveTransportQaSuiteCommandOptions) => Promise<void>>(async () => {}),
);

vi.mock("openclaw/plugin-sdk/qa-runner-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/qa-runner-runtime")>()),
  runLiveTransportQaSuiteCommand,
}));

import { msteamsQaCliRegistration } from "./cli.js";

describe("Microsoft Teams QA CLI", () => {
  beforeEach(() => {
    runLiveTransportQaSuiteCommand.mockClear();
  });

  it("runs the shared channel canary by default", async () => {
    const qa = new Command();
    msteamsQaCliRegistration.register(qa);

    await qa.parseAsync([
      "node",
      "openclaw",
      "msteams",
      "--provider-mode",
      "mock-openai",
      "--output-dir",
      "/tmp/msteams-qa",
    ]);

    const params = runLiveTransportQaSuiteCommand.mock.calls[0]?.[0];
    expect(params).toMatchObject({
      channelId: "msteams",
      defaultProviderMode: "mock-openai",
      options: {
        outputDir: "/tmp/msteams-qa",
        providerMode: "mock-openai",
      },
    });
    expect(
      params?.selectScenarioIds({
        primaryModel: "openai/gpt-5.4",
        providerMode: "mock-openai",
      }),
    ).toEqual(["channel-canary"]);
  });

  it("honors explicit scenario selection", async () => {
    const qa = new Command();
    msteamsQaCliRegistration.register(qa);

    await qa.parseAsync(["node", "openclaw", "msteams", "--scenario", "channel-canary"]);

    const params = runLiveTransportQaSuiteCommand.mock.calls[0]?.[0];
    expect(
      params?.selectScenarioIds({
        primaryModel: "openai/gpt-5.4",
        providerMode: "mock-openai",
        scenarioIds: params.options.scenarioIds,
      }),
    ).toEqual(["channel-canary"]);
  });
});
