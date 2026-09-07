// Covers gateway HTTP auth security audit findings.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  collectGatewayHttpNoAuthFindings,
  collectGatewayHttpSessionKeyOverrideFindings,
} from "./audit-extra.sync.js";

function requireFinding(
  findings: Array<{ checkId: string; detail: string; severity?: string }>,
  checkId: string,
) {
  const finding = findings.find((entry) => entry.checkId === checkId);
  if (!finding) {
    throw new Error(`Expected ${checkId} finding`);
  }
  return finding;
}

describe("security audit gateway HTTP auth findings", () => {
  it.each([
    {
      name: "scores loopback gateway HTTP no-auth as warn",
      cfg: {
        gateway: {
          bind: "loopback",
          auth: { mode: "none" },
          http: { endpoints: { chatCompletions: { enabled: true } } },
        },
      } satisfies OpenClawConfig,
      expectedFinding: { checkId: "gateway.http.no_auth", severity: "warn" as const },
      detailIncludes: ["/tools/invoke", "/v1/chat/completions"],
      env: {} as NodeJS.ProcessEnv,
    },
    {
      name: "scores remote gateway HTTP no-auth as critical",
      cfg: {
        gateway: {
          bind: "lan",
          auth: { mode: "none" },
          http: { endpoints: { responses: { enabled: true } } },
        },
        plugins: { entries: { "admin-http-rpc": { enabled: true } } },
      } satisfies OpenClawConfig,
      expectedFinding: { checkId: "gateway.http.no_auth", severity: "critical" as const },
      detailIncludes: ["/api/v1/admin/rpc"],
      env: {} as NodeJS.ProcessEnv,
    },
    {
      name: "does not report gateway.http.no_auth when auth mode is token",
      cfg: {
        gateway: {
          bind: "loopback",
          auth: { mode: "token", token: "secret" },
          http: {
            endpoints: {
              chatCompletions: { enabled: true },
              responses: { enabled: true },
            },
          },
        },
      } satisfies OpenClawConfig,
      expectedNoFinding: "gateway.http.no_auth",
      env: {} as NodeJS.ProcessEnv,
    },
    {
      name: "does not report gateway.http.no_auth with runtime password auth override",
      cfg: {
        gateway: {
          bind: "loopback",
          auth: { mode: "none" },
          http: {
            endpoints: {
              chatCompletions: { enabled: true },
            },
          },
        },
      } satisfies OpenClawConfig,
      expectedNoFinding: "gateway.http.no_auth",
      env: {} as NodeJS.ProcessEnv,
      gatewayAuthOverride: {
        mode: "password" as const,
        password: "runtime-gateway-password-1234567890", // pragma: allowlist secret
      },
    },
    {
      name: "reports gateway.http.no_auth when runtime password mode lacks a password",
      cfg: {
        gateway: {
          bind: "loopback",
          auth: { mode: "none" },
          http: {
            endpoints: {
              chatCompletions: { enabled: true },
            },
          },
        },
      } satisfies OpenClawConfig,
      expectedFinding: { checkId: "gateway.http.no_auth", severity: "warn" as const },
      env: {} as NodeJS.ProcessEnv,
      gatewayAuthOverride: {
        mode: "password" as const,
      },
    },
    {
      name: "reports HTTP API session-key override surfaces when enabled",
      cfg: {
        gateway: {
          http: {
            endpoints: {
              chatCompletions: { enabled: true },
              responses: { enabled: true },
            },
          },
        },
      } satisfies OpenClawConfig,
      expectedFinding: {
        checkId: "gateway.http.session_key_override_enabled",
        severity: "info" as const,
      },
    },
  ])(
    "$name",
    ({ cfg, expectedFinding, expectedNoFinding, detailIncludes, env, gatewayAuthOverride }) => {
      const findings = [
        ...collectGatewayHttpNoAuthFindings(cfg, env ?? process.env, { gatewayAuthOverride }),
        ...collectGatewayHttpSessionKeyOverrideFindings(cfg),
      ];

      if (expectedFinding) {
        const finding = requireFinding(findings, expectedFinding.checkId);
        expect(finding.severity).toBe(expectedFinding.severity);
        if (detailIncludes) {
          for (const text of detailIncludes) {
            expect(finding.detail, `${expectedFinding.checkId}:${text}`).toContain(text);
          }
        }
      }
      if (expectedNoFinding) {
        expect(findings.map((entry) => entry.checkId)).not.toContain(expectedNoFinding);
      }
    },
  );
});
