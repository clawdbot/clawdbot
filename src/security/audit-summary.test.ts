// Verifies security audit summary formatting and severity counts.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { collectAttackSurfaceSummaryFindings } from "./audit-extra.summary.js";

function requireAttackSurfaceSummary(
  findings: ReturnType<typeof collectAttackSurfaceSummaryFindings>,
) {
  const summary = findings.find((f) => f.checkId === "summary.attack_surface");
  if (!summary) {
    throw new Error("Expected attack surface summary finding");
  }
  expect(summary.checkId).toBe("summary.attack_surface");
  expect(summary.severity).toBe("info");
  return summary;
}

describe("security audit attack surface summary", () => {
  it("includes an attack surface summary (info)", () => {
    const cfg: OpenClawConfig = {
      channels: { whatsapp: { groupPolicy: "open" }, telegram: { groupPolicy: "allowlist" } },
      tools: { elevated: { enabled: true, allowFrom: { whatsapp: ["+1"] } } },
      hooks: { enabled: true },
      browser: { enabled: true },
    };

    const findings = collectAttackSurfaceSummaryFindings(cfg);
    const summary = requireAttackSurfaceSummary(findings);

    expect(summary.detail).toBe(
      [
        "groups: open=1, allowlist=1",
        "tools.elevated: enabled",
        "hooks.webhooks: enabled",
        "hooks.internal: disabled",
        "browser control: enabled",
        "trust model: personal assistant (one trusted operator boundary), not hostile multi-tenant on one shared gateway. For multiple users or organizations, run one isolated Gateway cell per tenant: https://docs.openclaw.ai/gateway/multi-tenant-hosting",
      ].join("\n"),
    );
  });

  it.each([
    {
      name: "restrictive plugin allowlist excludes browser and no browser config is present",
      cfg: {
        plugins: { allow: ["openai"] },
      } satisfies OpenClawConfig,
      expected: "browser control: disabled",
    },
    {
      name: "explicit browser config does not bypass a restrictive plugin allowlist",
      cfg: {
        browser: { enabled: true },
        plugins: { allow: ["openai"] },
      } satisfies OpenClawConfig,
      expected: "browser control: disabled",
    },
    {
      name: "plugin ids use the same case-insensitive canonical form as startup",
      cfg: {
        plugins: { allow: ["Browser"] },
      } satisfies OpenClawConfig,
      expected: "browser control: enabled",
    },
    {
      name: "plugin deny policy wins over explicit browser config",
      cfg: {
        browser: { enabled: true },
        plugins: { allow: ["browser"], deny: ["browser"] },
      } satisfies OpenClawConfig,
      expected: "browser control: disabled",
    },
    {
      name: "disabled browser plugin entry wins over explicit browser config",
      cfg: {
        browser: { enabled: true },
        plugins: { allow: ["browser"], entries: { browser: { enabled: false } } },
      } satisfies OpenClawConfig,
      expected: "browser control: disabled",
    },
    {
      name: "browser.enabled=false disables browser control",
      cfg: {
        browser: { enabled: false },
        plugins: { allow: ["browser"] },
      } satisfies OpenClawConfig,
      expected: "browser control: disabled",
    },
    {
      name: "case-normalized plugin deny policy disables browser control",
      cfg: {
        plugins: { deny: ["BROWSER"] },
      } satisfies OpenClawConfig,
      expected: "browser control: disabled",
    },
  ])("reports browser control from effective plugin policy: $name", ({ cfg, expected }) => {
    const summary = requireAttackSurfaceSummary(collectAttackSurfaceSummaryFindings(cfg));

    expect(summary.detail).toContain(expected);
  });
});
