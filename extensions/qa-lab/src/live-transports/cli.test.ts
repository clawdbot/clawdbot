// Qa Lab tests cover live transport CLI and adapter contribution discovery.
import { Command } from "commander";
import type { QaRunnerCliContribution } from "openclaw/plugin-sdk/qa-runner-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { listQaRunnerCliContributions, runLiveTransportQaSuiteCommand, runTelegram } = vi.hoisted(
  () => ({
    listQaRunnerCliContributions: vi.fn<() => QaRunnerCliContribution[]>(() => []),
    runLiveTransportQaSuiteCommand: vi.fn(),
    runTelegram: vi.fn(),
  }),
);

vi.mock("openclaw/plugin-sdk/qa-runner-runtime", () => ({ listQaRunnerCliContributions }));
vi.mock("./shared/live-transport-suite.runtime.js", () => ({ runLiveTransportQaSuiteCommand }));
vi.mock("./telegram/cli.runtime.js", () => ({ runQaTelegramCommand: runTelegram }));

import { listLiveTransportQaAdapterFactories, listLiveTransportQaCliRegistrations } from "./cli.js";

describe("live transport QA contributions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listQaRunnerCliContributions.mockReturnValue([]);
  });

  it("discovers all five shared live adapter factories without changing CLI ownership", () => {
    expect(listLiveTransportQaAdapterFactories().map((factory) => factory.id)).toEqual([
      "telegram",
      "discord",
      "matrix",
      "slack",
      "whatsapp",
    ]);
  });

  it.each(["discord", "slack", "whatsapp"] as const)(
    "routes the shipped %s command through the shared suite host",
    async (commandName) => {
      const registration = listLiveTransportQaCliRegistrations().find(
        (candidate) => candidate.commandName === commandName,
      );
      const qa = new Command();
      registration?.register(qa);

      await qa.parseAsync(["node", "openclaw", commandName, "--scenario", `${commandName}-canary`]);

      expect(runLiveTransportQaSuiteCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          channelId: commandName,
          options: expect.objectContaining({ scenarioIds: [`${commandName}-canary`] }),
        }),
      );
    },
  );

  it("keeps the specialized Telegram command runner", async () => {
    const registration = listLiveTransportQaCliRegistrations().find(
      (candidate) => candidate.commandName === "telegram",
    );
    const qa = new Command();
    registration?.register(qa);

    await qa.parseAsync(["node", "openclaw", "telegram", "--scenario", "telegram-canary"]);

    expect(runTelegram).toHaveBeenCalledWith(
      expect.objectContaining({ scenarioIds: ["telegram-canary"] }),
    );
  });
});
