import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { collectModelHygieneFindings } from "./audit-extra.sync.js";

describe("security audit model hygiene findings", () => {
  it("classifies legacy and weak-tier model identifiers", () => {
    const cases: Array<{
      name: string;
      cfg: OpenClawConfig;
      expectedPresent?: Array<{ checkId: string; severity: "warn" }>;
      expectedAbsentCheckId?: string;
    }> = [
      {
        name: "legacy model",
        cfg: {
          agents: { defaults: { model: { primary: "openai/gpt-3.5-turbo" } } },
        },
        expectedPresent: [{ checkId: "models.legacy", severity: "warn" }],
      },
      {
        name: "weak-tier model",
        cfg: {
          agents: { defaults: { model: { primary: "anthropic/claude-haiku-4-5" } } },
        },
        expectedPresent: [{ checkId: "models.weak_tier", severity: "warn" }],
      },
      {
        name: "venice opus-45",
        cfg: {
          agents: { defaults: { model: { primary: "venice/claude-opus-45" } } },
        },
        expectedAbsentCheckId: "models.weak_tier",
      },
    ];

    for (const testCase of cases) {
      const findings = collectModelHygieneFindings(testCase.cfg);
      for (const expected of testCase.expectedPresent ?? []) {
        expect(
          findings.some(
            (finding) =>
              finding.checkId === expected.checkId && finding.severity === expected.severity,
          ),
          testCase.name,
        ).toBe(true);
      }
      if (testCase.expectedAbsentCheckId) {
        expect(
          findings.some((finding) => finding.checkId === testCase.expectedAbsentCheckId),
          testCase.name,
        ).toBe(false);
      }
    }
  });

  it("resolves configured aliases before tier classification", () => {
    const findings = collectModelHygieneFindings({
      agents: {
        defaults: {
          model: {
            primary: "gpt",
            fallbacks: ["gpt-prev", "gpt-mini"],
          },
          models: {
            "openai-codex/gpt-5.5": { alias: "gpt" },
            "openai-codex/gpt-5.4": { alias: "gpt-prev" },
            "openai/gpt-5-mini": { alias: "gpt-mini" },
          },
        },
      },
    } satisfies OpenClawConfig);

    expect(findings.some((finding) => finding.checkId === "models.weak_tier")).toBe(false);
  });
});
