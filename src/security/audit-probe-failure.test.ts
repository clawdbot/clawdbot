// Verifies probe failure audit reporting.
import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { collectDeepProbeFindings } from "./audit-deep-probe-findings.js";
import { runSecurityAudit } from "./audit.js";

function requireProbeFailure(findings: ReturnType<typeof collectDeepProbeFindings>) {
  const finding = findings.find((entry) => entry.checkId === "gateway.probe_failed");
  if (!finding) {
    throw new Error("Expected gateway probe failure finding");
  }
  return finding;
}

describe("security audit deep probe failure", () => {
  it("redacts gateway URL credentials from the deep audit report", async () => {
    const user = "audit-user-sentinel";
    const password = "audit-password-sentinel";
    const querySecret = "audit-query-sentinel";
    const url = `wss://${user}:${password}@gateway.example.test/socket?client_secret=${querySecret}`;

    const report = await withEnvAsync({ OPENCLAW_GATEWAY_URL: undefined }, async () =>
      runSecurityAudit({
        config: { gateway: { mode: "remote", remote: { url } } },
        sourceConfig: { gateway: { mode: "remote", remote: { url } } },
        env: {},
        deep: true,
        includeFilesystem: false,
        includeChannelSecurity: false,
        loadPluginSecurityCollectors: false,
        probeGatewayFn: async ({ url: probeUrl }) => ({
          ok: false,
          url: probeUrl,
          connectLatencyMs: null,
          error: `failed to connect to ${probeUrl}`,
          close: { code: 1006, reason: `connection closed at ${probeUrl}` },
          auth: { role: null, scopes: [], capability: "unknown" },
          health: null,
          status: null,
          presence: null,
          configSnapshot: null,
        }),
      }),
    );

    expect(report.deep?.gateway).toMatchObject({
      url: "wss://***:***@gateway.example.test/socket?client_secret=***",
      error: "failed to connect to wss://***:***@gateway.example.test/socket?client_secret=***",
      close: {
        reason: "connection closed at wss://***:***@gateway.example.test/socket?client_secret=***",
      },
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(user);
    expect(serialized).not.toContain(password);
    expect(serialized).not.toContain(querySecret);
  });

  it("adds probe_failed warnings for deep probe failure modes", () => {
    const cases: Array<{
      name: string;
      deep: {
        gateway: {
          attempted: boolean;
          url: string | null;
          ok: boolean;
          error: string | null;
          close?: { code: number; reason: string } | null;
        };
      };
      expectedError: string;
    }> = [
      {
        name: "probe returns failed result",
        deep: {
          gateway: {
            attempted: true,
            ok: false,
            url: "ws://127.0.0.1:18789",
            error: "connect failed",
            close: null,
          },
        },
        expectedError: "connect failed",
      },
      {
        name: "probe throws",
        deep: {
          gateway: {
            attempted: true,
            ok: false,
            url: "ws://127.0.0.1:18789",
            error: "probe boom",
            close: null,
          },
        },
        expectedError: "probe boom",
      },
    ];

    for (const testCase of cases) {
      const findings = collectDeepProbeFindings({ deep: testCase.deep });
      const probeFailure = requireProbeFailure(findings);
      expect(probeFailure.detail, testCase.name).toContain(testCase.expectedError);
    }
  });
});
