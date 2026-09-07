// Covers gateway security audit aggregation.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { setConfigResolutionFacts } from "../config/resolution-facts.js";
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
  it.each([
    { bind: "loopback", allowTailscale: true, missingAuth: false },
    { bind: "loopback", allowTailscale: false, missingAuth: true },
    { bind: "lan", allowTailscale: true, missingAuth: true },
  ] as const)("limits Tailscale auth to its enabled loopback path: %j", (testCase) => {
    const cfg: OpenClawConfig = {
      gateway: {
        bind: testCase.bind,
        auth: { allowTailscale: testCase.allowTailscale },
        tailscale: { mode: "serve" },
      },
    };
    const findings = collectGatewayConfigFindings(cfg, cfg, {});
    const checkId =
      testCase.bind === "loopback" ? "gateway.loopback_no_auth" : "gateway.bind_no_auth";
    expect(hasFindingWithSeverity(checkId, "critical", findings)).toBe(testCase.missingAuth);
  });

  it.each(["undefined", "null", "  undefined  ", "", "  "])(
    'flags a stringified nullish gateway token as critical: "%s"',
    (token) => {
      const cfg: OpenClawConfig = {
        gateway: {
          bind: "loopback",
          auth: { mode: "token", token },
        },
      };
      const findings = collectGatewayConfigFindings(cfg, cfg, {});
      expect(hasFindingWithSeverity("gateway.token_placeholder_value", "critical", findings)).toBe(
        true,
      );
      // The placeholder finding replaces the misleading length-only warning.
      expect(hasFinding("gateway.token_too_short", findings)).toBe(false);
    },
  );

  describe("SecretRef token inspection", () => {
    const ref = { source: "exec", provider: "fixture", id: "gateway" } as const;
    const sourceConfig: OpenClawConfig = {
      gateway: { auth: { mode: "token", token: ref } },
      secrets: { providers: { fixture: { source: "exec", command: "/usr/bin/printf" } } },
    };

    it.each([
      { name: "scrubbed", token: undefined, unresolved: false },
      { name: "structured", token: ref, unresolved: false },
      { name: "pending inline", token: "${GATEWAY_REF}", unresolved: false },
      { name: "unresolved provenance", token: "undefined", unresolved: true },
    ])("does not audit an ambient credential over a $name reference", ({ token, unresolved }) => {
      const cfg: OpenClawConfig = { ...sourceConfig, gateway: { auth: { mode: "token", token } } };
      if (unresolved) {
        setConfigResolutionFacts(cfg, new Set(["gateway.auth.token"]));
      }
      for (const ambient of ["undefined", "short"]) {
        const findings = collectGatewayConfigFindings(cfg, sourceConfig, {
          OPENCLAW_GATEWAY_TOKEN: ambient,
        });
        expect(hasFinding("gateway.token_placeholder_value", findings)).toBe(false);
        expect(hasFinding("gateway.token_too_short", findings)).toBe(false);
      }
    });

    it.each([
      { token: "undefined", critical: true, short: false },
      { token: "short", critical: false, short: true },
      { token: "${LITERAL}", critical: false, short: true },
    ])("audits materialized reference value $token", ({ token, critical, short }) => {
      const cfg: OpenClawConfig = { ...sourceConfig, gateway: { auth: { mode: "token", token } } };
      setConfigResolutionFacts(cfg, new Set());
      const findings = collectGatewayConfigFindings(cfg, sourceConfig, {
        OPENCLAW_GATEWAY_TOKEN: "undefined",
      });
      expect(hasFindingWithSeverity("gateway.token_placeholder_value", "critical", findings)).toBe(
        critical,
      );
      expect(hasFinding("gateway.token_too_short", findings)).toBe(short);
    });

    it.each(["undefined", "short"])(
      "audits explicit override %s over an unresolved reference",
      (token) => {
        const cfg: OpenClawConfig = { ...sourceConfig, gateway: { auth: { mode: "token" } } };
        setConfigResolutionFacts(cfg, new Set(["gateway.auth.token"]));
        const findings = collectGatewayConfigFindings(
          cfg,
          sourceConfig,
          { OPENCLAW_GATEWAY_TOKEN: "ambient-token" },
          {
            gatewayAuthOverride: { mode: "token", token },
          },
        );
        expect(
          hasFindingWithSeverity("gateway.token_placeholder_value", "critical", findings),
        ).toBe(token === "undefined");
        expect(hasFinding("gateway.token_too_short", findings)).toBe(token === "short");
      },
    );
  });

  it("keeps a valid environment fallback authoritative over a blank inline token", () => {
    const cfg: OpenClawConfig = { gateway: { auth: { mode: "token", token: " " } } };
    expect(
      hasFinding(
        "gateway.token_placeholder_value",
        collectGatewayConfigFindings(cfg, cfg, { OPENCLAW_GATEWAY_TOKEN: "synthetic-valid-token" }),
      ),
    ).toBe(false);
  });

  it("does not report an inactive or overridden token as the active credential", () => {
    const cfg: OpenClawConfig = {
      gateway: { auth: { mode: "password", password: "synthetic-password", token: "undefined" } },
    };
    expect(
      hasFinding("gateway.token_placeholder_value", collectGatewayConfigFindings(cfg, cfg, {})),
    ).toBe(false);
    expect(
      hasFinding(
        "gateway.token_placeholder_value",
        collectGatewayConfigFindings(
          cfg,
          cfg,
          {},
          {
            gatewayAuthOverride: { mode: "token", token: "synthetic-valid-token" },
          },
        ),
      ),
    ).toBe(false);
  });

  it("keeps the short-token warning for a real short gateway token", () => {
    const cfg: OpenClawConfig = {
      gateway: {
        bind: "loopback",
        auth: { mode: "token", token: "undefined-ish" },
      },
    };
    const findings = collectGatewayConfigFindings(cfg, cfg, {});
    expect(hasFinding("gateway.token_placeholder_value", findings)).toBe(false);
    expect(hasFindingWithSeverity("gateway.token_too_short", "warn", findings)).toBe(true);
  });

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

  it("honors runtime password auth override for bind auth checks", () => {
    const cfg: OpenClawConfig = {
      gateway: {
        bind: "lan",
        auth: {},
      },
    };

    const findings = collectGatewayConfigFindings(
      cfg,
      cfg,
      {},
      {
        gatewayAuthOverride: {
          mode: "password",
          password: "runtime-gateway-password-1234567890", // pragma: allowlist secret
        },
      },
    );

    expect(hasFinding("gateway.bind_no_auth", findings)).toBe(false);
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

  it("does not count an unresolved token as configured auth", () => {
    const config: OpenClawConfig = {
      gateway: { bind: "lan", auth: { mode: "token", token: "${MISSING_TOKEN}" } },
    };
    setConfigResolutionFacts(config, new Set(["gateway.auth.token"]));

    const unresolved = collectGatewayConfigFindings(config, config, {});
    expect(hasFindingWithSeverity("gateway.bind_no_auth", "critical", unresolved)).toBe(true);

    setConfigResolutionFacts(config, new Set());
    const literal = collectGatewayConfigFindings(config, config, {});
    expect(hasFinding("gateway.bind_no_auth", literal)).toBe(false);
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
