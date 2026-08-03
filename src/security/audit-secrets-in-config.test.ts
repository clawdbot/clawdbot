// Covers secrets-in-config security audit findings for SecretRef externalization.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SecretRef } from "../config/types.secrets.js";
import { collectSecretsInConfigFindings } from "./audit-extra.sync.js";
import { collectSecurityAuditFindings } from "./audit.test-support.js";

const GATEWAY_PASSWORD_CHECK_ID = "config.secrets.gateway_password_in_config";
const HOOKS_TOKEN_CHECK_ID = "config.secrets.hooks_token_in_config";

describe("collectSecretsInConfigFindings", () => {
  it("warns when the gateway password is a plaintext literal", () => {
    const cfg = {
      gateway: { auth: { password: "plaintext-gateway-password" } },
    } satisfies OpenClawConfig;

    const findings = collectSecretsInConfigFindings(cfg);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.checkId).toBe(GATEWAY_PASSWORD_CHECK_ID);
    expect(findings[0]?.severity).toBe("warn");
  });

  it("does not warn when the gateway password uses an env template string", () => {
    const cfg = {
      gateway: { auth: { password: "${OPENCLAW_GATEWAY_PASSWORD}" } },
    } satisfies OpenClawConfig;

    expect(collectSecretsInConfigFindings(cfg)).toEqual([]);
  });

  it("reports info when the enabled hooks token is a plaintext literal", () => {
    const cfg = {
      hooks: { enabled: true, token: "plaintext-hooks-token" },
    } satisfies OpenClawConfig;

    const findings = collectSecretsInConfigFindings(cfg);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.checkId).toBe(HOOKS_TOKEN_CHECK_ID);
    expect(findings[0]?.severity).toBe("info");
  });

  it("reports no findings when no credentials are configured", () => {
    expect(collectSecretsInConfigFindings({})).toEqual([]);
  });
});

describe("security audit secrets-in-config source classification", () => {
  it("does not warn when the resolved config holds plaintext materialized from a SecretRef", async () => {
    // The CLI resolves command secrets before auditing, so the runtime config carries
    // the plaintext value while the source config keeps the externalized SecretRef.
    const findings = await collectSecurityAuditFindings(
      { gateway: { auth: { password: "resolved-plaintext-password" } } },
      {
        sourceConfig: {
          gateway: {
            auth: {
              password: {
                source: "file",
                provider: "local",
                id: "/gatewayPassword",
              } satisfies SecretRef,
            },
          },
        },
      },
    );

    expect(findings.some((finding) => finding.checkId === GATEWAY_PASSWORD_CHECK_ID)).toBe(false);
  });

  it("still warns when the source config stores a plaintext gateway password", async () => {
    const findings = await collectSecurityAuditFindings(
      { gateway: { auth: { password: "plaintext-gateway-password" } } },
      { sourceConfig: { gateway: { auth: { password: "plaintext-gateway-password" } } } },
    );

    expect(findings.some((finding) => finding.checkId === GATEWAY_PASSWORD_CHECK_ID)).toBe(true);
  });
});
