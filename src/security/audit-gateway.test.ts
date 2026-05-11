import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { withEnvAsync } from "../test-utils/env.js";
import { collectGatewayConfigFindings } from "./audit-gateway-config.js";

function hasFinding(checkId: string, findings: ReturnType<typeof collectGatewayConfigFindings>) {
  return findings.some((finding) => finding.checkId === checkId);
}

function hasFindingWithSeverity(
  checkId: string,
  severity: "info" | "warn" | "critical",
  findings: ReturnType<typeof collectGatewayConfigFindings>,
) {
  return findings.some((finding) => finding.checkId === checkId && finding.severity === severity);
}

describe("security audit gateway config findings", () => {
  it("evaluates gateway auth presence and rate-limit guardrails", async () => {
    await Promise.all([
      withEnvAsync(
        {
          OPENCLAW_GATEWAY_TOKEN: undefined,
          OPENCLAW_GATEWAY_PASSWORD: undefined,
        },
        async () => {
          const findings = collectGatewayConfigFindings(
            {
              gateway: {
                bind: "lan",
                auth: {},
              },
            },
            {
              gateway: {
                bind: "lan",
                auth: {},
              },
            },
            process.env,
          );
          expect(hasFindingWithSeverity("gateway.bind_no_auth", "critical", findings)).toBe(true);
        },
      ),
      (async () => {
        const cfg: OpenClawConfig = {
          gateway: {
            bind: "lan",
            auth: {
              password: {
                source: "env",
                provider: "default",
                id: "OPENCLAW_GATEWAY_PASSWORD",
              },
            },
          },
        };
        const findings = collectGatewayConfigFindings(cfg, cfg, {});
        expect(hasFinding("gateway.bind_no_auth", findings)).toBe(false);
      })(),
      (async () => {
        const sourceConfig: OpenClawConfig = {
          gateway: {
            bind: "lan",
            auth: {
              token: {
                source: "env",
                provider: "default",
                id: "OPENCLAW_GATEWAY_TOKEN",
              },
            },
          },
          secrets: {
            providers: {
              default: { source: "env" },
            },
          },
        };
        const resolvedConfig: OpenClawConfig = {
          gateway: {
            bind: "lan",
            auth: {},
          },
          secrets: sourceConfig.secrets,
        };
        const findings = collectGatewayConfigFindings(resolvedConfig, sourceConfig, {});
        expect(hasFinding("gateway.bind_no_auth", findings)).toBe(false);
      })(),
      (async () => {
        const cfg: OpenClawConfig = {
          gateway: {
            bind: "lan",
            auth: { token: "secret" },
          },
        };
        const findings = collectGatewayConfigFindings(cfg, cfg, {});
        expect(hasFindingWithSeverity("gateway.auth_no_rate_limit", "warn", findings)).toBe(true);
      })(),
      (async () => {
        const cfg: OpenClawConfig = {
          gateway: {
            bind: "lan",
            auth: {
              token: "secret",
              rateLimit: { maxAttempts: 10, windowMs: 60_000, lockoutMs: 300_000 },
            },
          },
        };
        const findings = collectGatewayConfigFindings(cfg, cfg, {});
        expect(hasFinding("gateway.auth_no_rate_limit", findings)).toBe(false);
      })(),
    ]);
  });

  it("warns when OPENCLAW_GATEWAY_TOKEN shadows a different configured token source", () => {
    const cfg: OpenClawConfig = {
      gateway: { auth: { token: "config-token" } },
    };
    const findings = collectGatewayConfigFindings(cfg, cfg, {
      OPENCLAW_GATEWAY_TOKEN: "env-token",
    });

    expect(hasFinding("gateway.env_token_overrides_config", findings)).toBe(true);
  });

  it("does not warn inside the managed gateway service credential context", () => {
    const cfg: OpenClawConfig = {
      gateway: { auth: { token: "config-token" } },
    };
    const findings = collectGatewayConfigFindings(cfg, cfg, {
      OPENCLAW_GATEWAY_TOKEN: "env-token",
      OPENCLAW_SERVICE_KIND: "gateway",
    });

    expect(hasFinding("gateway.env_token_overrides_config", findings)).toBe(false);
  });

  it("does not warn when gateway.auth.token resolves from OPENCLAW_GATEWAY_TOKEN", () => {
    const cfg: OpenClawConfig = {
      gateway: { auth: { token: "${OPENCLAW_GATEWAY_TOKEN}" } },
      secrets: { providers: { default: { source: "env" } } },
    };
    const findings = collectGatewayConfigFindings(cfg, cfg, {
      OPENCLAW_GATEWAY_TOKEN: "env-token",
    });

    expect(hasFinding("gateway.env_token_overrides_config", findings)).toBe(false);
  });

  it("does not warn about local gateway auth token precedence in remote mode", () => {
    const cfg: OpenClawConfig = {
      gateway: {
        mode: "remote",
        remote: { token: "remote-token" },
        auth: { token: "local-token" },
      },
    };
    const findings = collectGatewayConfigFindings(cfg, cfg, {
      OPENCLAW_GATEWAY_TOKEN: "env-token",
    });

    expect(hasFinding("gateway.env_token_overrides_config", findings)).toBe(false);
  });
});
