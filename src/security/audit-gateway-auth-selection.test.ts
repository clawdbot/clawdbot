import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveGatewayProbeAuthSafe, resolveGatewayProbeTarget } from "../gateway/probe-auth.js";
import { collectDeepProbeFindings } from "./audit-deep-probe-findings.js";

function requireProbeAuthWarning(findings: ReturnType<typeof collectDeepProbeFindings>) {
  const warning = findings.find(
    (finding) => finding.checkId === "gateway.probe_auth_secretref_unavailable",
  );
  if (!warning) {
    throw new Error("Expected gateway probe auth SecretRef warning");
  }
  return warning;
}

describe("security audit gateway auth selection", () => {
  it("applies gateway auth precedence across local and remote modes", async () => {
    const makeProbeEnv = (env?: { token?: string; password?: string }) => {
      const probeEnv: NodeJS.ProcessEnv = {};
      if (env?.token !== undefined) {
        probeEnv.OPENCLAW_GATEWAY_TOKEN = env.token;
      }
      if (env?.password !== undefined) {
        probeEnv.OPENCLAW_GATEWAY_PASSWORD = env.password;
      }
      return probeEnv;
    };

    const cases: Array<{
      name: string;
      cfg: OpenClawConfig;
      env?: { token?: string; password?: string };
      expectedAuth: { token?: string; password?: string };
    }> = [
      {
        name: "uses local auth when gateway.mode is local",
        cfg: { gateway: { mode: "local", auth: { token: "local-token-abc123" } } },
        expectedAuth: { token: "local-token-abc123" },
      },
      {
        name: "prefers env token over local config token",
        cfg: { gateway: { mode: "local", auth: { token: "local-token" } } },
        env: { token: "env-token" },
        expectedAuth: { token: "env-token" },
      },
      {
        name: "uses local auth when gateway.mode is undefined (default)",
        cfg: { gateway: { auth: { token: "default-local-token" } } },
        expectedAuth: { token: "default-local-token" },
      },
      {
        name: "uses remote auth when gateway.mode is remote with URL",
        cfg: {
          gateway: {
            mode: "remote",
            auth: { token: "local-token-should-not-use" },
            remote: { url: "wss://remote.example.com:18789", token: "remote-token-xyz789" },
          },
        },
        expectedAuth: { token: "remote-token-xyz789" },
      },
      {
        name: "ignores env token when gateway.mode is remote",
        cfg: {
          gateway: {
            mode: "remote",
            auth: { token: "local-token-should-not-use" },
            remote: { url: "wss://remote.example.com:18789", token: "remote-token" },
          },
        },
        env: { token: "env-token" },
        expectedAuth: { token: "remote-token" },
      },
      {
        name: "falls back to local auth when gateway.mode is remote but URL is missing",
        cfg: {
          gateway: {
            mode: "remote",
            auth: { token: "fallback-local-token" },
            remote: { token: "remote-token-should-not-use" },
          },
        },
        expectedAuth: { token: "fallback-local-token" },
      },
      {
        name: "uses remote password when env is unset",
        cfg: {
          gateway: {
            mode: "remote",
            remote: { url: "wss://remote.example.com:18789", password: "remote-pass" },
          },
        },
        expectedAuth: { password: "remote-pass" },
      },
      {
        name: "prefers env password over remote password",
        cfg: {
          gateway: {
            mode: "remote",
            remote: { url: "wss://remote.example.com:18789", password: "remote-pass" },
          },
        },
        env: { password: "env-pass" },
        expectedAuth: { password: "env-pass" },
      },
    ];

    await Promise.all(
      cases.map(async (testCase) => {
        const target = resolveGatewayProbeTarget(testCase.cfg);
        const result = resolveGatewayProbeAuthSafe({
          cfg: testCase.cfg,
          env: makeProbeEnv(testCase.env),
          mode: target.mode,
        });
        expect(result.auth, testCase.name).toEqual(testCase.expectedAuth);
      }),
    );
  });

  it("adds warning finding when probe auth SecretRef is unavailable", () => {
    const cfg: OpenClawConfig = {
      gateway: {
        mode: "local",
        auth: {
          mode: "token",
          token: { source: "env", provider: "default", id: "MISSING_GATEWAY_TOKEN" },
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    };

    const result = resolveGatewayProbeAuthSafe({
      cfg,
      mode: "local",
      env: {},
    });
    const warning = requireProbeAuthWarning(
      collectDeepProbeFindings({
        deep: {
          gateway: {
            attempted: true,
            url: "ws://127.0.0.1:18789",
            ok: true,
            error: null,
            close: null,
          },
        },
        authWarning: result.warning,
      }),
    );
    expect(warning.severity).toBe("warn");
    expect(warning.detail).toContain("gateway.auth.token");
  });
});
