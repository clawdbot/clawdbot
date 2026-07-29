// Covers hook routing security audit findings.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { collectHooksHardeningFindings } from "./audit-extra.sync.js";
import { runSecurityAudit } from "./audit.js";

function hasFinding(
  findings: ReturnType<typeof collectHooksHardeningFindings>,
  checkId: string,
  severity: "warn" | "critical",
) {
  return findings.some((finding) => finding.checkId === checkId && finding.severity === severity);
}

function getFinding(findings: ReturnType<typeof collectHooksHardeningFindings>, checkId: string) {
  return findings.find((finding) => finding.checkId === checkId);
}

describe("security audit hooks ingress findings", () => {
  it("evaluates hooks ingress auth and routing findings", () => {
    const unrestrictedBaseHooks = {
      enabled: true,
      token: "shared-gateway-token-1234567890",
      defaultSessionKey: "hook:ingress",
    } satisfies NonNullable<OpenClawConfig["hooks"]>;
    const requestSessionKeyHooks = {
      ...unrestrictedBaseHooks,
      allowRequestSessionKey: true,
    } satisfies NonNullable<OpenClawConfig["hooks"]>;
    const cases = [
      {
        name: "warns when hooks token looks short",
        cfg: {
          hooks: { enabled: true, token: "short" },
        } satisfies OpenClawConfig,
        expectedFinding: "hooks.token_too_short",
        expectedSeverity: "warn" as const,
      },
      {
        name: "flags hooks token reuse of the gateway env token as critical",
        cfg: {
          hooks: { enabled: true, token: "shared-gateway-token-1234567890" },
        } satisfies OpenClawConfig,
        env: {
          OPENCLAW_GATEWAY_TOKEN: "shared-gateway-token-1234567890",
        } as NodeJS.ProcessEnv,
        expectedFinding: "hooks.token_reuse_gateway_token",
        expectedSeverity: "critical" as const,
      },
      {
        name: "warns when hooks.defaultSessionKey is unset",
        cfg: {
          hooks: { enabled: true, token: "shared-gateway-token-1234567890" },
        } satisfies OpenClawConfig,
        expectedFinding: "hooks.default_session_key_unset",
        expectedSeverity: "warn" as const,
      },
      {
        name: "treats wildcard hooks.allowedAgentIds as unrestricted routing",
        cfg: {
          hooks: {
            enabled: true,
            token: "shared-gateway-token-1234567890",
            defaultSessionKey: "hook:ingress",
            allowedAgentIds: ["*"],
          },
        } satisfies OpenClawConfig,
        expectedFinding: "hooks.allowed_agent_ids_unrestricted",
        expectedSeverity: "warn" as const,
      },
      {
        name: "scores unrestricted hooks.allowedAgentIds by local exposure",
        cfg: { hooks: unrestrictedBaseHooks } satisfies OpenClawConfig,
        expectedFinding: "hooks.allowed_agent_ids_unrestricted",
        expectedSeverity: "warn" as const,
      },
      {
        name: "scores unrestricted hooks.allowedAgentIds by remote exposure",
        cfg: { gateway: { bind: "lan" }, hooks: unrestrictedBaseHooks } satisfies OpenClawConfig,
        expectedFinding: "hooks.allowed_agent_ids_unrestricted",
        expectedSeverity: "critical" as const,
      },
      {
        name: "scores hooks request sessionKey override by local exposure",
        cfg: { hooks: requestSessionKeyHooks } satisfies OpenClawConfig,
        expectedFinding: "hooks.request_session_key_enabled",
        expectedSeverity: "warn" as const,
        expectedExtraFinding: {
          checkId: "hooks.request_session_key_prefixes_missing",
          severity: "warn" as const,
        },
      },
      {
        name: "scores hooks request sessionKey override by remote exposure",
        cfg: {
          gateway: { bind: "lan" },
          hooks: requestSessionKeyHooks,
        } satisfies OpenClawConfig,
        expectedFinding: "hooks.request_session_key_enabled",
        expectedSeverity: "critical" as const,
      },
    ] as const;

    for (const testCase of cases) {
      const env = "env" in testCase ? testCase.env : process.env;
      const findings = collectHooksHardeningFindings(testCase.cfg, env);
      expect(
        hasFinding(findings, testCase.expectedFinding, testCase.expectedSeverity),
        testCase.name,
      ).toBe(true);
      if ("expectedExtraFinding" in testCase) {
        expect(
          hasFinding(
            findings,
            testCase.expectedExtraFinding.checkId,
            testCase.expectedExtraFinding.severity,
          ),
          testCase.name,
        ).toBe(true);
      }
    }
  });

  it("flags hooks token reuse of gateway password auth as critical", () => {
    const findings = collectHooksHardeningFindings({
      gateway: {
        auth: {
          mode: "password",
          password: "shared-gateway-password-1234567890", // pragma: allowlist secret
        },
      },
      hooks: {
        enabled: true,
        token: "shared-gateway-password-1234567890",
      },
    });

    expect(hasFinding(findings, "hooks.token_reuse_gateway_token", "critical")).toBe(true);

    const finding = getFinding(findings, "hooks.token_reuse_gateway_token");
    expect(finding?.title).toContain("Gateway password");
    expect(finding?.detail).toContain("gateway.auth password");
    expect(finding?.remediation).toContain("openclaw doctor --fix");
  });

  it("flags hooks token reuse of trusted-proxy local password fallback as critical", () => {
    const findings = collectHooksHardeningFindings({
      gateway: {
        auth: {
          mode: "trusted-proxy",
          trustedProxy: { userHeader: "x-forwarded-user" },
          password: "trusted-proxy-local-password-1234567890", // pragma: allowlist secret
        },
      },
      hooks: {
        enabled: true,
        token: "trusted-proxy-local-password-1234567890",
      },
    });

    expect(hasFinding(findings, "hooks.token_reuse_gateway_token", "critical")).toBe(true);

    const finding = getFinding(findings, "hooks.token_reuse_gateway_token");
    expect(finding?.title).toContain("Gateway password");
    expect(finding?.detail).toContain("gateway.auth password");
  });

  it("flags hooks token reuse of an explicit audit password override as critical", () => {
    const findings = collectHooksHardeningFindings(
      {
        hooks: {
          enabled: true,
          token: "runtime-only-gateway-password-1234567890",
        },
      },
      {} as NodeJS.ProcessEnv,
      {
        gatewayAuthOverride: {
          password: "runtime-only-gateway-password-1234567890", // pragma: allowlist secret
        },
      },
    );

    expect(hasFinding(findings, "hooks.token_reuse_gateway_token", "critical")).toBe(true);

    const finding = getFinding(findings, "hooks.token_reuse_gateway_token");
    expect(finding?.title).toContain("Gateway password");
    expect(finding?.detail).toContain("gateway.auth password");
    expect(finding?.remediation).toContain("doctor can only repair reuse");
  });

  it("does not flag inactive explicit audit password when config mode is token", () => {
    const findings = collectHooksHardeningFindings(
      {
        gateway: {
          auth: {
            mode: "token",
            token: "config-gateway-token-1234567890", // pragma: allowlist secret
          },
        },
        hooks: {
          enabled: true,
          token: "runtime-only-gateway-password-1234567890",
        },
      },
      {} as NodeJS.ProcessEnv,
      {
        gatewayAuthOverride: {
          password: "runtime-only-gateway-password-1234567890", // pragma: allowlist secret
        },
      },
    );

    expect(hasFinding(findings, "hooks.token_reuse_gateway_token", "critical")).toBe(false);
  });

  it("flags explicit audit password reuse when config mode is token", () => {
    const findings = collectHooksHardeningFindings(
      {
        gateway: {
          auth: {
            mode: "token",
            token: "config-gateway-token-1234567890", // pragma: allowlist secret
          },
        },
        hooks: {
          enabled: true,
          token: "runtime-only-gateway-password-1234567890",
        },
      },
      {} as NodeJS.ProcessEnv,
      {
        gatewayAuthOverride: {
          mode: "password",
          password: "runtime-only-gateway-password-1234567890", // pragma: allowlist secret
        },
      },
    );

    expect(hasFinding(findings, "hooks.token_reuse_gateway_token", "critical")).toBe(true);

    const finding = getFinding(findings, "hooks.token_reuse_gateway_token");
    expect(finding?.title).toContain("Gateway password");
    expect(finding?.detail).toContain("gateway.auth password");
  });

  it("keeps config password reuse finding when explicit audit password differs", () => {
    const findings = collectHooksHardeningFindings(
      {
        gateway: {
          auth: {
            mode: "password",
            password: "config-gateway-password-1234567890", // pragma: allowlist secret
          },
        },
        hooks: {
          enabled: true,
          token: "config-gateway-password-1234567890",
        },
      },
      {} as NodeJS.ProcessEnv,
      {
        gatewayAuthOverride: {
          password: "different-runtime-password-1234567890", // pragma: allowlist secret
        },
      },
    );

    expect(hasFinding(findings, "hooks.token_reuse_gateway_token", "critical")).toBe(true);

    const finding = getFinding(findings, "hooks.token_reuse_gateway_token");
    expect(finding?.title).toContain("Gateway password");
    expect(finding?.detail).toContain("gateway.auth password");
  });

  it("flags hooks token reuse of SecretRef-backed gateway password auth in full audit", async () => {
    const report = await runSecurityAudit({
      config: {
        agents: { list: [{ id: "main", default: true }] },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
        gateway: {
          auth: {
            mode: "password",
            password: { source: "env", provider: "default", id: "GW_PASSWORD" },
          },
        },
        hooks: {
          enabled: true,
          token: "shared-gateway-password-1234567890",
        },
      },
      env: {
        GW_PASSWORD: "shared-gateway-password-1234567890", // pragma: allowlist secret
      } as NodeJS.ProcessEnv,
      includeFilesystem: false,
      includeChannelSecurity: false,
    });

    expect(hasFinding(report.findings, "hooks.token_reuse_gateway_token", "critical")).toBe(true);
  });

  it("keeps persisted SecretRef reuse findings when audit password override differs", async () => {
    const report = await runSecurityAudit({
      config: {
        agents: { list: [{ id: "main", default: true }] },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
        gateway: {
          auth: {
            mode: "password",
            password: { source: "env", provider: "default", id: "GW_PASSWORD" },
          },
        },
        hooks: {
          enabled: true,
          token: "config-gateway-password-1234567890",
        },
      },
      env: {
        GW_PASSWORD: "config-gateway-password-1234567890", // pragma: allowlist secret
      } as NodeJS.ProcessEnv,
      auditGatewayAuthOverride: {
        mode: "password",
        password: "different-runtime-password-1234567890", // pragma: allowlist secret
      },
      includeFilesystem: false,
      includeChannelSecurity: false,
    });

    const finding = getFinding(report.findings, "hooks.token_reuse_gateway_token");
    expect(finding?.severity).toBe("critical");
    expect(finding?.remediation).toContain("openclaw doctor --fix");
  });

  it("flags hooks token reuse of SecretRef-backed trusted-proxy password fallback", async () => {
    const report = await runSecurityAudit({
      config: {
        agents: { list: [{ id: "main", default: true }] },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
        gateway: {
          auth: {
            mode: "trusted-proxy",
            trustedProxy: { userHeader: "x-forwarded-user" },
            password: { source: "env", provider: "default", id: "GW_PASSWORD" },
          },
        },
        hooks: {
          enabled: true,
          token: "trusted-proxy-local-password-1234567890",
        },
      },
      env: {
        GW_PASSWORD: "trusted-proxy-local-password-1234567890", // pragma: allowlist secret
      } as NodeJS.ProcessEnv,
      includeFilesystem: false,
      includeChannelSecurity: false,
    });

    expect(hasFinding(report.findings, "hooks.token_reuse_gateway_token", "critical")).toBe(true);
  });

  it("does not resolve gateway auth SecretRefs when hooks are disabled", async () => {
    const report = await runSecurityAudit({
      config: {
        agents: { list: [{ id: "main", default: true }] },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
        gateway: {
          auth: {
            mode: "password",
            password: { source: "env", provider: "default", id: "MISSING_GW_PASSWORD" },
          },
        },
        hooks: {
          enabled: false,
          token: "shared-gateway-password-1234567890",
        },
      },
      env: {} as NodeJS.ProcessEnv,
      includeFilesystem: false,
      includeChannelSecurity: false,
    });

    expect(hasFinding(report.findings, "hooks.token_reuse_gateway_token", "critical")).toBe(false);
  });

  it("skips unavailable gateway auth SecretRefs when auditing hooks token reuse", async () => {
    const report = await runSecurityAudit({
      config: {
        agents: { list: [{ id: "main", default: true }] },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
        gateway: {
          auth: {
            mode: "password",
            password: { source: "env", provider: "default", id: "MISSING_GW_PASSWORD" },
          },
        },
        hooks: {
          enabled: true,
          token: "shared-gateway-password-1234567890",
        },
      },
      env: {} as NodeJS.ProcessEnv,
      includeFilesystem: false,
      includeChannelSecurity: false,
    });

    expect(hasFinding(report.findings, "hooks.token_reuse_gateway_token", "critical")).toBe(false);
  });

  it("does not execute gateway auth SecretRefs during hooks token reuse audit", async () => {
    const report = await runSecurityAudit({
      config: {
        agents: { list: [{ id: "main", default: true }] },
        secrets: {
          providers: {
            vault: {
              source: "exec",
              command: "node",
              args: ["-e", "process.stdout.write('shared-gateway-password-1234567890')"],
            },
          },
        },
        gateway: {
          auth: {
            mode: "password",
            password: { source: "exec", provider: "vault", id: "GW_PASSWORD" },
          },
        },
        hooks: {
          enabled: true,
          token: "shared-gateway-password-1234567890",
        },
      },
      env: {} as NodeJS.ProcessEnv,
      includeFilesystem: false,
      includeChannelSecurity: false,
    });

    expect(hasFinding(report.findings, "hooks.token_reuse_gateway_token", "critical")).toBe(false);
  });
});
