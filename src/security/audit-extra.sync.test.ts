// Covers synchronous extra security audit aggregation.
import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { setConfigResolutionFacts } from "../config/resolution-facts.js";
import {
  collectAttackSurfaceSummaryFindings,
  collectSmallModelRiskFindings,
} from "./audit-extra.summary.js";
import { collectSecretsInConfigFindings } from "./audit-extra.sync.js";

vi.mock("../plugins/web-search-credential-presence.js", () => ({
  hasConfiguredWebSearchCredential: () => false,
}));

describe("collectSecretsInConfigFindings", () => {
  it("distinguishes an unresolved password from byte-identical literal text", () => {
    const config = {
      gateway: { auth: { password: "${GATEWAY_PASSWORD}" } },
    } satisfies OpenClawConfig;
    setConfigResolutionFacts(config, new Set(["gateway.auth.password"]));
    expect(collectSecretsInConfigFindings(config)).toHaveLength(0);

    setConfigResolutionFacts(config, new Set());
    expect(collectSecretsInConfigFindings(config)).toHaveLength(1);
  });
});

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
    const finding = expectDefined(
      collectAttackSurfaceSummaryFindings(cfg).at(0),
      "attack surface summary finding",
    );
    expect(finding.checkId).toBe("summary.attack_surface");
    for (const snippet of expectedDetail) {
      expect(finding.detail).toContain(snippet);
    }
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
  const browserBlockedByPluginPolicyCfg = {
    ...browserDefaultCfg,
    plugins: { allow: ["openai"] },
  } satisfies OpenClawConfig;
  const configuredBrowserBlockedByPluginPolicyCfg = {
    ...browserBlockedByPluginPolicyCfg,
    browser: { enabled: true },
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
    {
      name: "treats browser as disabled when restrictive plugin policy excludes it",
      cfg: browserBlockedByPluginPolicyCfg,
      env: {},
      expectedSeverity: "info",
      detailIncludes: ["web=[off]", "No web/browser tools detected"],
      detailExcludes: ["web=[browser]"],
    },
    {
      name: "does not let browser config bypass restrictive plugin policy",
      cfg: configuredBrowserBlockedByPluginPolicyCfg,
      env: {},
      expectedSeverity: "info",
      detailIncludes: ["web=[off]", "No web/browser tools detected"],
      detailExcludes: ["web=[browser]"],
    },
  ])("$name", ({ cfg, env, expectedSeverity, detailIncludes, detailExcludes }) => {
    const finding = expectDefined(
      collectSmallModelRiskFindings({
        cfg,
        env,
      }).at(0),
      "small model risk finding",
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
