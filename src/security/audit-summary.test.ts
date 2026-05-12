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
        "trust model: personal assistant (one trusted operator boundary), not hostile multi-tenant on one shared gateway",
      ].join("\n"),
    );
  });
});
