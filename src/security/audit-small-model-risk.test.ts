// Covers small-model risk audit findings.
import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { collectSmallModelRiskFindings } from "./audit-extra.summary.js";
import { collectAuditModelRefs } from "./audit-model-refs.js";

describe("security audit small-model risk findings", () => {
  it("reports canonical paths for agent model references", () => {
    expect(
      collectAuditModelRefs({
        agents: {
          entries: {
            simple: { model: "ollama/mistral-8b" },
            structured: {
              model: {
                primary: "ollama/gemma-4b",
                fallbacks: ["ollama/phi-3b"],
              },
            },
          },
        },
      } satisfies OpenClawConfig),
    ).toEqual([
      { id: "ollama/mistral-8b", source: "agents.entries.simple.model" },
      { id: "ollama/gemma-4b", source: "agents.entries.structured.model.primary" },
      { id: "ollama/phi-3b", source: "agents.entries.structured.model.fallbacks" },
    ]);
  });

  it("preserves agent policy context for canonical model source paths", () => {
    const finding = expectDefined(
      collectSmallModelRiskFindings({
        cfg: {
          agents: {
            entries: {
              ops: {
                default: true,
                model: { primary: "ollama/mistral-8b" },
                tools: { deny: ["web_search", "web_fetch", "browser"] },
              },
            },
          },
          tools: { web: { search: { enabled: true }, fetch: { enabled: true } } },
          browser: { enabled: true },
        } satisfies OpenClawConfig,
        env: {},
      }).at(0),
      "small-model risk finding for agent policy context",
    );

    expect(finding.severity).toBe("info");
    expect(finding.detail).toContain("@ agents.entries.ops.model.primary");
    expect(finding.detail).toContain("web=[off]");
  });

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
      const finding = expectDefined(
        collectSmallModelRiskFindings({
          cfg: testCase.cfg,
          env: process.env,
        }).at(0),
        `small-model risk finding for ${testCase.name}`,
      );
      expect(finding.severity, testCase.name).toBe(testCase.expectedSeverity);
      for (const snippet of testCase.detailIncludes) {
        expect(finding.detail, `${testCase.name}:${snippet}`).toContain(snippet);
      }
    }
  });

  it("resolves configured aliases before parameter-size classification", () => {
    const finding = expectDefined(
      collectSmallModelRiskFindings({
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
      }).at(0),
      "small-model risk finding for configured alias",
    );

    expect(finding.checkId).toBe("models.small_params");
    expect(finding.detail).toContain("ollama/mistral-8b");
    expect(finding.detail).toContain("@ agents.defaults.model.primary");
    expect(finding.detail).not.toContain("- tiny");
  });

  it("honors provider/model tool deny policy before reporting web exposure", () => {
    const finding = expectDefined(
      collectSmallModelRiskFindings({
        cfg: {
          agents: {
            defaults: {
              model: {
                primary: "openrouter/google/gemma-3-4b-it:free",
              },
            },
          },
          tools: {
            web: { search: { enabled: true }, fetch: { enabled: true } },
            byProvider: {
              "openrouter/google/gemma-3-4b-it:free": {
                deny: ["web_search", "web_fetch", "browser"],
              },
            },
          },
          browser: { enabled: true },
        } satisfies OpenClawConfig,
        env: {},
      }).at(0),
      "small-model risk finding for provider/model deny",
    );

    expect(finding.checkId).toBe("models.small_params");
    expect(finding.severity).toBe("info");
    expect(finding.detail).toContain("openrouter/google/gemma-3-4b-it:free");
    expect(finding.detail).toContain("web=[off]");
    expect(finding.detail).toContain("No web/browser tools detected");
    expect(finding.detail).not.toContain("web=[web_search");
  });
});
