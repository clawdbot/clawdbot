// QA Lab tests cover suite model-pair resolution.
import { describe, expect, it } from "vitest";
import { buildQaGatewayConfig } from "./qa-gateway-config.js";
import { buildQaSuiteSummaryJson } from "./suite-artifacts.js";
import { resolveRequestedQaSuiteModels } from "./suite-model-selection.js";

describe("resolveRequestedQaSuiteModels", () => {
  it("derives Luna after an explicit Sol primary", () => {
    expect(
      resolveRequestedQaSuiteModels({
        providerMode: "live-frontier",
        primaryModel: "openai/gpt-5.6-sol",
        scenarios: [],
      }),
    ).toMatchObject({
      primaryModel: "openai/gpt-5.6-sol",
      alternateModel: "openai/gpt-5.6-luna",
    });
  });

  it("preserves an explicit alternate", () => {
    expect(
      resolveRequestedQaSuiteModels({
        providerMode: "live-frontier",
        primaryModel: "openai/gpt-5.6-luna",
        alternateModel: "openai/gpt-5.6-terra",
        scenarios: [],
      }),
    ).toMatchObject({
      primaryModel: "openai/gpt-5.6-luna",
      alternateModel: "openai/gpt-5.6-terra",
    });
  });

  it.each([
    [undefined, true],
    [true, true],
    [false, false],
  ] as const)(
    "keeps effective fast mode aligned between live-frontier config and summary for input %s",
    (fastMode, expectedFastMode) => {
      const selection = resolveRequestedQaSuiteModels({
        providerMode: "live-frontier",
        primaryModel: "openai/gpt-5.6-sol",
        fastMode,
        scenarios: [],
      });
      const config = buildQaGatewayConfig({
        bind: "loopback",
        gatewayPort: 18789,
        gatewayToken: "test-token",
        workspaceDir: "/tmp/qa-workspace",
        ...selection,
      });
      const summary = buildQaSuiteSummaryJson({
        ...selection,
        scenarios: [],
        startedAt: new Date("2026-08-16T00:00:00.000Z"),
        finishedAt: new Date("2026-08-16T00:00:01.000Z"),
        concurrency: 1,
      });

      expect(config.agents?.defaults?.models?.[selection.primaryModel]?.params?.fastMode).toBe(
        expectedFastMode ? true : undefined,
      );
      expect(summary.run.fastMode).toBe(expectedFastMode);
    },
  );
});
