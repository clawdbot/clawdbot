import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { collectSmallModelRiskFindings } from "./audit-extra.summary.js";

describe("security audit small-model risk findings", () => {
  it("scores small-model risk by tool/sandbox exposure", () => {
    const cases: Array<{
      name: string;
      cfg: OpenClawConfig;
      expectedSeverity: "info" | "critical";
      detailIncludes: string[];
    }> = [
      {
        name: "small model with web and browser enabled",
        cfg: {
          agents: { defaults: { model: { primary: "ollama/mistral-8b" } } },
          tools: { web: { search: { enabled: true }, fetch: { enabled: true } } },
          browser: { enabled: true },
        },
        expectedSeverity: "critical",
        detailIncludes: ["mistral-8b", "web_search", "web_fetch", "browser"],
      },
      {
        name: "small model with sandbox all and web/browser disabled",
        cfg: {
          agents: {
            defaults: { model: { primary: "ollama/mistral-8b" }, sandbox: { mode: "all" } },
          },
          tools: { web: { search: { enabled: false }, fetch: { enabled: false } } },
          browser: { enabled: false },
        },
        expectedSeverity: "info",
        detailIncludes: ["mistral-8b", "sandbox=all"],
      },
    ];

    for (const testCase of cases) {
      const [finding] = collectSmallModelRiskFindings({
        cfg: testCase.cfg,
        env: process.env,
      });
      expect(finding?.severity, testCase.name).toBe(testCase.expectedSeverity);
      for (const snippet of testCase.detailIncludes) {
        expect(finding?.detail, `${testCase.name}:${snippet}`).toContain(snippet);
      }
    }
  });

  it("resolves configured aliases before parameter-size classification", () => {
    const [finding] = collectSmallModelRiskFindings({
      cfg: {
        agents: {
          defaults: {
            model: { primary: "tiny" },
            models: {
              "ollama/mistral-8b": { alias: "tiny" },
            },
          },
        },
        tools: { web: { search: { enabled: true }, fetch: { enabled: true } } },
        browser: { enabled: true },
      } satisfies OpenClawConfig,
      env: {},
    });

    expect(finding?.checkId).toBe("models.small_params");
    expect(finding?.detail).toContain("ollama/mistral-8b");
    expect(finding?.detail).toContain("@ agents.defaults.model.primary");
    expect(finding?.detail).not.toContain("- tiny");
  });
});
