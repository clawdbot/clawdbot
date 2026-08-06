import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { readQaScenarioById } from "../../scenario-catalog.js";

const LEGACY_TELEGRAM_BEHAVIOR_LEDGER = [
  {
    id: "telegram-other-bot-command-gating",
    owner: "qa/scenarios/channels/telegram-other-bot-command-gating.yaml",
    scenarioId: "telegram-other-bot-command-gating",
  },
  {
    id: "telegram-mentioned-message-reply",
    owner: "qa/scenarios/channels/channel-canary.yaml",
    scenarioId: "channel-canary",
  },
  {
    id: "telegram-stream-final-single-message",
    owner: "qa/scenarios/channels/telegram-stream-final-single-message.yaml",
    scenarioId: "telegram-stream-final-single-message",
  },
  {
    id: "telegram-long-final-reuses-preview",
    owner: "qa/scenarios/channels/telegram-long-final-reuses-preview.yaml",
    scenarioId: "telegram-long-final-reuses-preview",
  },
  {
    id: "telegram-long-final-three-chunks",
    owner: "qa/scenarios/channels/telegram-long-final-three-chunks.yaml",
    scenarioId: "telegram-long-final-three-chunks",
  },
  {
    id: "telegram-mention-gating",
    owner: "qa/scenarios/channels/channel-mention-gating.yaml",
    scenarioId: "channel-mention-gating",
  },
] as const;

const LEGACY_TELEGRAM_CAPABILITY_LEDGER = [
  {
    id: "credentials-and-lease-cleanup",
    owner: "extensions/qa-lab/src/live-transports/telegram/adapter.runtime.ts",
    proof: "acquireQaCredentialLease",
  },
  {
    id: "bot-api-and-rich-message-observation",
    owner: "extensions/qa-lab/src/live-transports/telegram/telegram-api.runtime.ts",
    proof: "normalizeTelegramObservedMessage",
  },
  {
    id: "native-send-reply-edit-mapping",
    owner: "extensions/qa-lab/src/live-transports/telegram/adapter.runtime.ts",
    proof: "reply_parameters",
  },
  {
    id: "gateway-readiness-and-config",
    owner: "extensions/qa-lab/src/live-transports/telegram/telegram-api.runtime.ts",
    proof: "waitForTelegramChannelRunning",
  },
  {
    id: "selection-and-standard-artifacts",
    owner: "extensions/qa-lab/src/live-transports/telegram/cli.runtime.ts",
    proof: "runQaFlowSuiteFromRuntime",
  },
  {
    id: "package-rtt-sampling",
    owner: "scripts/e2e/npm-telegram-live-runner.ts",
    proof: "createRoundTripProbe",
  },
] as const;

describe("legacy Telegram runner parity", () => {
  it("maps every retired scenario to one maintained YAML owner", () => {
    expect(LEGACY_TELEGRAM_BEHAVIOR_LEDGER).toHaveLength(6);
    expect(new Set(LEGACY_TELEGRAM_BEHAVIOR_LEDGER.map(({ id }) => id)).size).toBe(6);

    for (const entry of LEGACY_TELEGRAM_BEHAVIOR_LEDGER) {
      const scenario = readQaScenarioById(entry.scenarioId);
      expect(scenario.sourcePath, entry.id).toBe(entry.owner);
    }
  });

  it("keeps every runner capability at its intended owner boundary", () => {
    for (const entry of LEGACY_TELEGRAM_CAPABILITY_LEDGER) {
      expect(fs.readFileSync(entry.owner, "utf8"), entry.id).toContain(entry.proof);
    }
  });

  it("has no unresolved legacy runner owner", () => {
    expect(
      fs.existsSync("extensions/qa-lab/src/live-transports/telegram/telegram-live.runtime.ts"),
    ).toBe(false);
  });
});
