import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  collectAttackSurfaceSummaryFindings,
  collectSmallModelRiskFindings,
} from "./audit-extra.summary.js";
import { safeEqualSecret } from "./secret-equal.js";

vi.mock("../plugins/web-search-credential-presence.js", () => ({
  hasConfiguredWebSearchCredential: () => false,
}));

function requireFirstFinding<T>(findings: readonly T[], label: string): T {
  const [finding] = findings;
  if (!finding) {
    throw new Error(`Expected ${label} finding`);
  }
  return finding;
}

describe("collectAttackSurfaceSummaryFindings", () => {
  it.each([
    {
      name: "distinguishes external webhooks from internal hooks when only internal hooks are enabled",
      cfg: {
        hooks: { internal: { enabled: true } },
      } satisfies OpenClawConfig,
      expectedDetail: ["hooks.webhooks: disabled", "hooks.internal: enabled"],
    },
    {
      name: "reports both hook systems as enabled when both are configured",
      cfg: {
        hooks: { enabled: true, internal: { enabled: true } },
      } satisfies OpenClawConfig,
      expectedDetail: ["hooks.webhooks: enabled", "hooks.internal: enabled"],
    },
    {
      name: "reports internal hooks as disabled until configured",
      cfg: {} satisfies OpenClawConfig,
      expectedDetail: ["hooks.webhooks: disabled", "hooks.internal: disabled"],
    },
    {
      name: "reports internal hooks as disabled when explicitly set to false",
      cfg: {
        hooks: { internal: { enabled: false } },
      } satisfies OpenClawConfig,
      expectedDetail: ["hooks.internal: disabled"],
    },
  ])("$name", ({ cfg, expectedDetail }) => {
    const finding = requireFirstFinding(
      collectAttackSurfaceSummaryFindings(cfg),
      "attack surface summary",
    );
    expect(finding.checkId).toBe("summary.attack_surface");
    for (const snippet of expectedDetail) {
      expect(finding.detail).toContain(snippet);
    }
  });
});

describe("safeEqualSecret", () => {
  it.each([
    ["secret-token", "secret-token", true],
    ["secret-token", "secret-tokEn", false],
    ["short", "much-longer", false],
    ["", "", true],
    ["", "secret", false],
    [undefined, "secret", false],
    ["secret", undefined, false],
    [null, "secret", false],
  ] as const)("compares %o and %o", (left, right, expected) => {
    expect(safeEqualSecret(left, right)).toBe(expected);
  });
});

describe("collectSmallModelRiskFindings", () => {
  const browserOffCfg = {
    agents: { defaults: { model: { primary: "ollama/mistral-8b" } } },
    browser: { enabled: false },
    tools: { web: { fetch: { enabled: false } } },
  } satisfies OpenClawConfig;
  const browserDefaultCfg = {
    agents: { defaults: { model: { primary: "ollama/mistral-8b" } } },
    tools: { web: { fetch: { enabled: false } } },
  } satisfies OpenClawConfig;

  it.each([
    {
      name: "small model without web/browser tools is informational even without sandbox all",
      cfg: browserOffCfg,
      env: {},
      expectedSeverity: "info",
      detailIncludes: ["web=[off]", "No web/browser tools detected"],
      detailExcludes: ["web=[browser]"],
    },
    {
      name: "treats browser as enabled by default when browser config is omitted",
      cfg: browserDefaultCfg,
      env: {},
      expectedSeverity: "critical",
      detailIncludes: ["web=[browser]"],
      detailExcludes: ["No web/browser tools detected"],
    },
  ])("$name", ({ cfg, env, expectedSeverity, detailIncludes, detailExcludes }) => {
    const finding = requireFirstFinding(
      collectSmallModelRiskFindings({
        cfg,
        env,
      }),
      "small model risk",
    );

    expect(finding.checkId).toBe("models.small_params");
    expect(finding.severity).toBe(expectedSeverity);
    expect(finding.detail).toContain("ollama/mistral-8b");
    for (const snippet of detailIncludes) {
      expect(finding.detail).toContain(snippet);
    }
    for (const snippet of detailExcludes) {
      expect(finding.detail).not.toContain(snippet);
    }
  });
});
