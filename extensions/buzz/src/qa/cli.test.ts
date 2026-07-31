import { Command } from "commander";
import type { LiveTransportQaSuiteCommandOptions } from "openclaw/plugin-sdk/qa-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runLiveTransportQaSuiteCommand = vi.hoisted(() =>
  vi.fn<(params: LiveTransportQaSuiteCommandOptions) => Promise<void>>(async () => {}),
);

vi.mock("openclaw/plugin-sdk/qa-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/qa-runtime")>()),
  runLiveTransportQaSuiteCommand,
}));

import { buzzQaCliRegistration } from "./cli.js";

describe("Buzz QA CLI", () => {
  beforeEach(() => {
    runLiveTransportQaSuiteCommand.mockClear();
  });

  it("runs the portable canary and mention-gating scenarios", async () => {
    const qa = new Command();
    buzzQaCliRegistration.register(qa);

    await qa.parseAsync([
      "node",
      "openclaw",
      "buzz",
      "--provider-mode",
      "mock-openai",
      "--credential-file",
      "/secure/buzz-qa.json",
    ]);

    const params = runLiveTransportQaSuiteCommand.mock.calls[0]?.[0];
    expect(params).toMatchObject({
      channelId: "buzz",
      defaultProviderMode: "mock-openai",
      options: {
        providerMode: "mock-openai",
        credentialFile: "/secure/buzz-qa.json",
      },
    });
    expect(
      params?.selectScenarioIds({
        primaryModel: "openai/gpt-5.4",
        providerMode: "mock-openai",
      }),
    ).toEqual(["channel-canary", "channel-mention-gating"]);
  });
});
