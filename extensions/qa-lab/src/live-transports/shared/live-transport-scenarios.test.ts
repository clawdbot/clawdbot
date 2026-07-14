// Qa Lab tests cover live transport scenarios plugin behavior.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  LIVE_TRANSPORT_BASELINE_STANDARD_SCENARIO_IDS,
  findMissingLiveTransportStandardScenarios,
} from "openclaw/plugin-sdk/qa-live-transport-scenarios";
import { describe, expect, it } from "vitest";
import { discordQaLiveRuntime } from "../discord/discord-live.runtime.js";
import { testing as slackTesting } from "../slack/slack-live.runtime.js";
import { testing as telegramTesting } from "../telegram/telegram-live.runtime.js";
import { testing as whatsAppTesting } from "../whatsapp/whatsapp-live.runtime.js";
import {
  buildLiveTransportCoverageLaneSummaries,
  collectLiveTransportStandardScenarioCoverage,
  loadNonYamlScenarioRefs,
  selectLiveTransportScenarios,
} from "./live-transport-scenarios.js";

const discordTesting = discordQaLiveRuntime.testing;

describe("live transport scenario helpers", () => {
  it("loads every non-YAML scenario id exactly once", async () => {
    const refs = await loadNonYamlScenarioRefs();

    expect(refs.length).toBeGreaterThan(0);
    expect(new Set(refs.map((ref) => ref.id)).size).toBe(refs.length);
  });

  it("uses the public live transport scenario SDK seam", () => {
    const source = fs.readFileSync(
      fileURLToPath(new URL("./live-transport-scenarios.ts", import.meta.url)),
      "utf8",
    );

    expect(source).toContain("openclaw/plugin-sdk/qa-live-transport-scenarios");
    expect(source).not.toContain("openclaw/plugin-sdk/qa-runtime");
  });

  it("keeps the repo-wide baseline contract ordered", () => {
    expect(LIVE_TRANSPORT_BASELINE_STANDARD_SCENARIO_IDS).toEqual([
      "canary",
      "mention-gating",
      "allowlist-block",
      "top-level-reply-shape",
      "restart-resume",
    ]);
  });

  it("selects requested scenarios and reports unknown ids with the lane label", () => {
    const definitions = [
      { id: "alpha", timeoutMs: 1_000, title: "alpha" },
      { id: "beta", timeoutMs: 1_000, title: "beta" },
    ] as const;

    expect(
      selectLiveTransportScenarios({
        ids: ["beta"],
        laneLabel: "Demo",
        scenarios: definitions,
      }),
    ).toEqual([definitions[1]]);

    expect(() =>
      selectLiveTransportScenarios({
        ids: ["alpha", "missing"],
        laneLabel: "Demo",
        scenarios: definitions,
      }),
    ).toThrow("unknown Demo QA scenario id(s): missing");
  });

  it("dedupes always-on and scenario-backed standard coverage", () => {
    const covered = collectLiveTransportStandardScenarioCoverage({
      alwaysOnStandardScenarioIds: ["canary"],
      scenarios: [
        {
          id: "scenario-1",
          standardId: "mention-gating",
          timeoutMs: 1_000,
          title: "mention",
        },
        {
          id: "scenario-2",
          standardId: "mention-gating",
          timeoutMs: 1_000,
          title: "mention again",
        },
        {
          id: "scenario-3",
          standardId: "restart-resume",
          timeoutMs: 1_000,
          title: "restart",
        },
      ],
    });

    expect(covered).toEqual(["canary", "mention-gating", "restart-resume"]);
    expect(
      findMissingLiveTransportStandardScenarios({
        coveredStandardScenarioIds: covered,
        expectedStandardScenarioIds: LIVE_TRANSPORT_BASELINE_STANDARD_SCENARIO_IDS,
      }),
    ).toEqual(["allowlist-block", "top-level-reply-shape"]);
  });

  it("summarizes live transport lane membership for coverage reports", () => {
    const lanes = buildLiveTransportCoverageLaneSummaries();

    expect(lanes.map((lane) => lane.transportId)).toEqual([
      "discord",
      "slack",
      "telegram",
      "whatsapp",
    ]);
    expect(lanes.find((lane) => lane.transportId === "telegram")?.members).toContainEqual({
      standardId: "canary",
    });
    expect(lanes.find((lane) => lane.transportId === "slack")?.members).toContainEqual({
      standardId: "restart-resume",
      scenarioId: "slack-restart-resume",
    });
    expect(lanes.find((lane) => lane.transportId === "whatsapp")?.members).toContainEqual({
      standardId: "allowlist-block",
      scenarioId: "whatsapp-group-allowlist-block",
    });
    expect(lanes.find((lane) => lane.transportId === "whatsapp")?.members).toContainEqual({
      standardId: "restart-resume",
      scenarioId: "whatsapp-restart-resume",
    });
    expect(
      lanes.find((lane) => lane.transportId === "discord")?.baselineMissingStandardScenarioIds,
    ).toEqual(["allowlist-block", "top-level-reply-shape", "restart-resume"]);
    expect(
      lanes.find((lane) => lane.transportId === "whatsapp")?.baselineMissingStandardScenarioIds,
    ).toEqual([]);
  });

  it("keeps runtime standard coverage represented in mixed-owner lanes", () => {
    const lanes = new Map(
      buildLiveTransportCoverageLaneSummaries().map((lane) => [
        lane.transportId,
        lane.standardScenarioIds,
      ]),
    );

    expect(lanes.get("discord")).toEqual(
      expect.arrayContaining(discordTesting.DISCORD_QA_STANDARD_SCENARIO_IDS),
    );
    expect(lanes.get("slack")).toEqual(
      expect.arrayContaining(slackTesting.SLACK_QA_STANDARD_SCENARIO_IDS),
    );
    expect(lanes.get("telegram")).toEqual(
      expect.arrayContaining([
        "help-command",
        ...telegramTesting.TELEGRAM_QA_STANDARD_SCENARIO_IDS,
      ]),
    );
    expect(lanes.get("whatsapp")).toEqual(
      expect.arrayContaining([
        "help-command",
        ...whatsAppTesting.WHATSAPP_QA_STANDARD_SCENARIO_IDS,
      ]),
    );
  });
});
