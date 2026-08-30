import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  loadSessionCostSummary,
  loadSessionLogs,
  loadSessionUsageTimeSeries,
} from "./session-cost-usage.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const flatPricing = { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 };
const tieredPricing: ModelDefinitionConfig["cost"] = {
  ...flatPricing,
  tieredPricing: [
    { ...flatPricing, range: [0, 1_000] },
    { input: 2, output: 4, cacheRead: 1, cacheWrite: 0, range: [1_000, 100_000] },
  ],
};

type PricingCase = {
  name: string;
  pricing?: ModelDefinitionConfig["cost"];
  recordedCost?: { total: number; totalOrigin?: "provider-billed" };
  topLevelUsage?: boolean;
  expectedCost: number | undefined;
};

describe("session usage reporting pricing", () => {
  it.each<PricingCase>([
    {
      name: "top-level usage and pricing metadata",
      pricing: flatPricing,
      topLevelUsage: true,
      expectedCost: 0.0021,
    },
    {
      name: "unknown recorded zero cost",
      recordedCost: { total: 0 },
      expectedCost: undefined,
    },
    {
      name: "configured all-zero pricing",
      pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      recordedCost: { total: 0 },
      expectedCost: undefined,
    },
    {
      name: "tiered pricing replacing a recorded flat estimate",
      pricing: tieredPricing,
      recordedCost: { total: 0.001 },
      expectedCost: 0.0042,
    },
    {
      name: "provider-billed zero preserved with tiered pricing",
      pricing: tieredPricing,
      recordedCost: { total: 0, totalOrigin: "provider-billed" },
      expectedCost: 0,
    },
    {
      name: "recorded positive cost preserved with flat pricing",
      pricing: flatPricing,
      recordedCost: { total: 0.125 },
      expectedCost: 0.125,
    },
  ])("keeps logs, summaries, and charts consistent for $name", async (testCase) => {
    const root = tempDirs.make("openclaw-usage-reporting-");
    const sessionFile = path.join(root, "transcript.jsonl");
    const timestamp = Date.UTC(2026, 7, 1, 12);
    const usage = {
      input: 1_000,
      output: 500,
      cacheRead: 200,
      totalTokens: 1_700,
      ...(testCase.recordedCost ? { cost: testCase.recordedCost } : {}),
    };
    const entries = [
      { message: { role: "user", content: "Question", timestamp: timestamp - 1 } },
      {
        provider: "reporting",
        model: "fixture-model",
        ...(testCase.topLevelUsage ? { usage } : {}),
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Answer" },
            { type: "tool_use", name: "lookup" },
          ],
          timestamp,
          ...(testCase.topLevelUsage ? {} : { usage }),
        },
      },
      {
        message: {
          role: "toolResult",
          toolName: "lookup",
          content: "Done",
          timestamp: timestamp + 1,
        },
      },
    ];
    await fs.writeFile(sessionFile, entries.map((entry) => JSON.stringify(entry)).join("\n"));
    const config: OpenClawConfig = testCase.pricing
      ? {
          models: {
            providers: {
              reporting: {
                baseUrl: "https://reporting.invalid",
                models: [
                  {
                    id: "fixture-model",
                    name: "Reporting fixture",
                    reasoning: false,
                    input: ["text"],
                    cost: testCase.pricing,
                    contextWindow: 100_000,
                    maxTokens: 8_000,
                  },
                ],
              },
            },
          },
        }
      : {};

    await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
      const params = { agentId: "main", sessionFile, config };
      const logs = await loadSessionLogs(params);
      expect(logs).toEqual([
        expect.objectContaining({ role: "user", content: "Question" }),
        {
          timestamp,
          role: "assistant",
          content: "Answer\n[Tool: lookup]",
          tokens: 1_700,
          cost: testCase.expectedCost,
        },
        expect.objectContaining({
          role: "toolResult",
          content: "[Tool: lookup]\n[Tool Result]\nDone",
        }),
      ]);

      const summary = await loadSessionCostSummary(params);
      expect(summary?.totalTokens).toBe(1_700);
      expect(summary?.totalCost).toBeCloseTo(testCase.expectedCost ?? 0, 8);
      expect(summary?.missingCostEntries).toBe(testCase.expectedCost === undefined ? 1 : 0);

      const series = await loadSessionUsageTimeSeries(params);
      expect(series?.points).toHaveLength(1);
      expect(series?.points[0]?.totalTokens).toBe(1_700);
      expect(series?.points[0]?.cost).toBeCloseTo(testCase.expectedCost ?? 0, 8);
    });
  });
});
