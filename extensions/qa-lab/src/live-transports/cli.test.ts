// Qa Lab tests cover live transport CLI and adapter contribution discovery.
import { Command } from "commander";
import type { QaRunnerCliContribution } from "openclaw/plugin-sdk/qa-runner-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { listQaRunnerCliContributions, runSlack, runTelegram, runWhatsApp } = vi.hoisted(() => ({
  listQaRunnerCliContributions: vi.fn<() => QaRunnerCliContribution[]>(() => []),
  runSlack: vi.fn(),
  runTelegram: vi.fn(),
  runWhatsApp: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/qa-runner-runtime", () => ({ listQaRunnerCliContributions }));
vi.mock("./slack/cli.runtime.js", () => ({ runQaSlackCommand: runSlack }));
vi.mock("./telegram/cli.runtime.js", () => ({ runQaTelegramCommand: runTelegram }));
vi.mock("./whatsapp/cli.runtime.js", () => ({ runQaWhatsAppCommand: runWhatsApp }));

import { listLiveTransportQaAdapterFactories, listLiveTransportQaCliRegistrations } from "./cli.js";

const matrixFactory = {
  id: "matrix",
  scenarioIds: ["channel-chat-baseline"],
  matches: vi.fn(() => true),
  create: vi.fn(),
};

describe("live transport QA contributions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listQaRunnerCliContributions.mockReturnValue([
      {
        pluginId: "qa-matrix",
        commandName: "matrix",
        status: "available",
        registration: {
          commandName: "matrix",
          adapterFactory: matrixFactory,
          register(qa) {
            qa.command("matrix").action(() => undefined);
          },
        },
      },
    ]);
  });

  it("discovers all four canonical live adapter factories without changing CLI ownership", () => {
    expect(listLiveTransportQaAdapterFactories().map((factory) => factory.id)).toEqual([
      "telegram",
      "slack",
      "whatsapp",
      "matrix",
    ]);
  });

  it.each([
    ["telegram", runTelegram],
    ["slack", runSlack],
    ["whatsapp", runWhatsApp],
  ] as const)("keeps the shipped %s command runner", async (commandName, runCommand) => {
    const registration = listLiveTransportQaCliRegistrations().find(
      (candidate) => candidate.commandName === commandName,
    );
    const qa = new Command();
    registration?.register(qa);

    await qa.parseAsync(["node", "openclaw", commandName, "--scenario", `${commandName}-canary`]);

    expect(runCommand).toHaveBeenCalledWith(
      expect.objectContaining({ scenarioIds: [`${commandName}-canary`] }),
    );
  });
});
