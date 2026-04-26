import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  buildNetworkHints,
  extractConfigSummary,
  isProbeReachable,
  isScopeLimitedProbeFailure,
  renderProbeSummaryLine,
  resolveAuthForTarget,
  resolveProbeBudgetMs,
  resolveTargets,
  sanitizeSshTarget,
} from "./helpers.js";
import { createSecretRefGatewayConfig } from "./test-support.js";

describe("extractConfigSummary", () => {
  it("marks SecretRef-backed gateway auth credentials as configured", () => {
    const summary = extractConfigSummary({
      path: "/tmp/openclaw.json",
      exists: true,
      valid: true,
      issues: [],
      legacyIssues: [],
      config: createSecretRefGatewayConfig(),
    });

    expect(summary.gateway.authTokenConfigured).toBe(true);
    expect(summary.gateway.authPasswordConfigured).toBe(true);
    expect(summary.gateway.remoteTokenConfigured).toBe(true);
    expect(summary.gateway.remotePasswordConfigured).toBe(true);
  });

  it("still treats empty plaintext auth values as not configured", () => {
    const summary = extractConfigSummary({
      path: "/tmp/openclaw.json",
      exists: true,
      valid: true,
      issues: [],
      legacyIssues: [],
      config: {
        gateway: {
          auth: {
            mode: "token",
            token: "   ",
            password: "",
          },
          remote: {
            token: " ",
            password: "",
          },
        },
      },
    });

    expect(summary.gateway.authTokenConfigured).toBe(false);
    expect(summary.gateway.authPasswordConfigured).toBe(false);
    expect(summary.gateway.remoteTokenConfigured).toBe(false);
    expect(summary.gateway.remotePasswordConfigured).toBe(false);
  });
});

describe("resolveAuthForTarget", () => {
  function createConfigRemoteTarget() {
    return {
      id: "configRemote",
      kind: "configRemote" as const,
      url: "wss://remote.example:18789",
      active: true,
    };
  }

  function createRemoteGatewayTargetConfig(params?: { mode?: "none" | "password" | "token" }) {
    return {
      secrets: {
        providers: {
          default: { source: "env" as const },
        },
      },
      gateway: {
        ...(params?.mode
          ? {
              auth: {
                mode: params.mode,
              },
            }
          : {}),
        remote: {
          token: { source: "env" as const, provider: "default", id: "REMOTE_GATEWAY_TOKEN" },
        },
      },
    };
  }

  it("resolves local auth token SecretRef before probing local targets", async () => {
    await withEnvAsync(
      {
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_GATEWAY_PASSWORD: undefined,
        LOCAL_GATEWAY_TOKEN: "resolved-local-token",
      },
      async () => {
        const auth = await resolveAuthForTarget(
          {
            secrets: {
              providers: {
                default: { source: "env" },
              },
            },
            gateway: {
              auth: {
                token: { source: "env", provider: "default", id: "LOCAL_GATEWAY_TOKEN" },
              },
            },
          },
          {
            id: "localLoopback",
            kind: "localLoopback",
            url: "ws://127.0.0.1:18789",
            active: true,
          },
          {},
        );

        expect(auth).toEqual({ token: "resolved-local-token", password: undefined });
      },
    );
  });

  it("resolves remote auth token SecretRef before probing remote targets", async () => {
    await withEnvAsync(
      {
        REMOTE_GATEWAY_TOKEN: "resolved-remote-token",
      },
      async () => {
        const auth = await resolveAuthForTarget(
          createRemoteGatewayTargetConfig(),
          createConfigRemoteTarget(),
          {},
        );

        expect(auth).toEqual({ token: "resolved-remote-token", password: undefined });
      },
    );
  });

  it("resolves remote auth even when local auth mode is none", async () => {
    await withEnvAsync(
      {
        REMOTE_GATEWAY_TOKEN: "resolved-remote-token",
      },
      async () => {
        const auth = await resolveAuthForTarget(
          createRemoteGatewayTargetConfig({ mode: "none" }),
          createConfigRemoteTarget(),
          {},
        );

        expect(auth).toEqual({ token: "resolved-remote-token", password: undefined });
      },
    );
  });

  it("does not force remote auth type from local auth mode", async () => {
    const auth = await resolveAuthForTarget(
      {
        gateway: {
          auth: {
            mode: "password",
          },
          remote: {
            token: "remote-token",
            password: "remote-password", // pragma: allowlist secret
          },
        },
      },
      {
        id: "configRemote",
        kind: "configRemote",
        url: "wss://remote.example:18789",
        active: true,
      },
      {},
    );

    expect(auth).toEqual({ token: "remote-token", password: undefined });
  });

  it("redacts resolver internals from unresolved SecretRef diagnostics", async () => {
    await withEnvAsync(
      {
        OPENCLAW_GATEWAY_PASSWORD: undefined,
        OPENCLAW_GATEWAY_TOKEN: undefined,
        MISSING_GATEWAY_TOKEN: undefined,
      },
      async () => {
        const auth = await resolveAuthForTarget(
          {
            secrets: {
              providers: {
                default: { source: "env" },
              },
            },
            gateway: {
              auth: {
                mode: "token",
                token: { source: "env", provider: "default", id: "MISSING_GATEWAY_TOKEN" },
              },
            },
          },
          {
            id: "localLoopback",
            kind: "localLoopback",
            url: "ws://127.0.0.1:18789",
            active: true,
          },
          {},
        );

        expect(auth.diagnostics).toContain(
          "gateway.auth.token SecretRef is unresolved (env:default:MISSING_GATEWAY_TOKEN).",
        );
        expect(auth.diagnostics?.join("\n")).not.toContain("missing or empty");
      },
    );
  });
});

describe("probe reachability classification", () => {
  it("treats missing-scope RPC failures as scope-limited and reachable", () => {
    const probe = {
      ok: false,
      url: "ws://127.0.0.1:18789",
      connectLatencyMs: 51,
      error: "missing scope: operator.read",
      close: null,
      auth: {
        role: "operator",
        scopes: ["operator.write"],
        capability: "write_capable" as const,
      },
      health: null,
      status: null,
      presence: null,
      configSnapshot: null,
    };

    expect(isScopeLimitedProbeFailure(probe)).toBe(true);
    expect(isProbeReachable(probe)).toBe(true);
    expect(renderProbeSummaryLine(probe, false)).toContain("Capability: write-capable");
    expect(renderProbeSummaryLine(probe, false)).toContain("Read probe: limited");
  });

  it("keeps non-scope RPC failures as unreachable", () => {
    const probe = {
      ok: false,
      url: "ws://127.0.0.1:18789",
      connectLatencyMs: 43,
      error: "unknown method: status",
      close: null,
      auth: {
        role: "operator",
        scopes: [],
        capability: "connected_no_operator_scope" as const,
      },
      health: null,
      status: null,
      presence: null,
      configSnapshot: null,
    };

    expect(isScopeLimitedProbeFailure(probe)).toBe(false);
    expect(isProbeReachable(probe)).toBe(false);
    expect(renderProbeSummaryLine(probe, false)).toContain("Capability: connect-only");
    expect(renderProbeSummaryLine(probe, false)).toContain("Read probe: failed");
  });
});
describe("gateway-status local target scheme", () => {
  it("uses wss for local loopback targets and network hints when gateway TLS is enabled", () => {
    const cfg = {
      gateway: {
        mode: "local",
        tls: { enabled: true },
      },
    };

    const targets = resolveTargets(cfg as never);
    expect(targets).toContainEqual(
      expect.objectContaining({
        id: "localLoopback",
        url: "wss://127.0.0.1:18789",
      }),
    );

    const hints = buildNetworkHints(cfg as never);
    expect(hints.localLoopbackUrl).toBe("wss://127.0.0.1:18789");
  });
});

describe("resolveProbeBudgetMs", () => {
  it("lets active local loopback probes use the full caller budget", () => {
    expect(
      resolveProbeBudgetMs(15_000, {
        kind: "localLoopback",
        active: true,
        url: "ws://127.0.0.1:18789",
      }),
    ).toBe(15_000);
    expect(
      resolveProbeBudgetMs(3_000, {
        kind: "localLoopback",
        active: true,
        url: "ws://127.0.0.1:18789",
      }),
    ).toBe(3_000);
  });

  it("keeps inactive local loopback probes on the short cap", () => {
    expect(
      resolveProbeBudgetMs(15_000, {
        kind: "localLoopback",
        active: false,
        url: "ws://127.0.0.1:18789",
      }),
    ).toBe(800);
    expect(
      resolveProbeBudgetMs(500, {
        kind: "localLoopback",
        active: false,
        url: "ws://127.0.0.1:18789",
      }),
    ).toBe(500);
  });

  it("lets explicit loopback URLs use the full caller budget", () => {
    expect(
      resolveProbeBudgetMs(15_000, {
        kind: "explicit",
        active: true,
        url: "ws://127.0.0.1:18789",
      }),
    ).toBe(15_000);
    expect(
      resolveProbeBudgetMs(2_500, {
        kind: "explicit",
        active: true,
        url: "wss://localhost:18789/ws",
      }),
    ).toBe(2_500);
  });

  it("keeps non-local probe caps unchanged", () => {
    expect(
      resolveProbeBudgetMs(15_000, {
        kind: "configRemote",
        active: true,
        url: "wss://gateway.example/ws",
      }),
    ).toBe(1500);
    expect(
      resolveProbeBudgetMs(15_000, {
        kind: "explicit",
        active: true,
        url: "wss://gateway.example/ws",
      }),
    ).toBe(1500);
    expect(
      resolveProbeBudgetMs(15_000, {
        kind: "sshTunnel",
        active: true,
        url: "wss://gateway.example/ws",
      }),
    ).toBe(2000);
  });
});

describe("sanitizeSshTarget", () => {
  it("strips a leading ssh command prefix", () => {
    expect(sanitizeSshTarget("ssh me@studio")).toBe("me@studio");
    expect(sanitizeSshTarget("  ssh me@studio:2222  ")).toBe("me@studio:2222");
  });
});
