import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { runSecurityAuditCore } from "./audit.js";

describe("security audit secrets-in-config", () => {
  it("does not warn when source config externalizes the gateway password but resolved config materialized it", async () => {
    const sourceConfig = {
      gateway: {
        auth: {
          password: { source: "file", provider: "default", id: "/run/secrets/gateway-password" },
        },
      },
    } satisfies OpenClawConfig;
    const resolvedConfig = {
      gateway: {
        auth: { password: "resolved-secret-value" },
      },
    } satisfies OpenClawConfig;

    const report = await runSecurityAuditCore({
      config: resolvedConfig,
      sourceConfig,
      includeFilesystem: false,
      includeChannelSecurity: false,
      loadPluginSecurityCollectors: false,
    });
    expect(
      report.findings.filter(
        (finding) => finding.checkId === "config.secrets.gateway_password_in_config",
      ),
    ).toHaveLength(0);
  });
});
