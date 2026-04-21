import { describe, expect, it } from "vitest";
import { asConfig, setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.ts";

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();

async function expectInactiveGatewayPassword(config: unknown): Promise<void> {
  const snapshot = await prepareSecretsRuntimeSnapshot({
    config: asConfig(config),
    env: {},
    agentDirs: ["/tmp/openclaw-agent-main"],
    loadAuthStore: () => ({ version: 1, profiles: {} }),
  });

  expect(snapshot.config.gateway?.auth?.password).toEqual({
    source: "env",
    provider: "default",
    id: "GATEWAY_PASSWORD_REF",
  });
  expect(snapshot.warnings.map((warning) => warning.path)).toContain("gateway.auth.password");
}

describe("secrets runtime gateway local surfaces", () => {
  it("treats gateway.remote refs as inactive when local auth credentials are configured", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        gateway: {
          mode: "local",
          auth: {
            mode: "password",
            token: "local-token",
            password: "local-password",
          },
          remote: {
            enabled: true,
            token: { source: "env", provider: "default", id: "MISSING_REMOTE_TOKEN" },
            password: { source: "env", provider: "default", id: "MISSING_REMOTE_PASSWORD" },
          },
        },
      }),
      env: {},
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(snapshot.config.gateway?.remote?.token).toEqual({
      source: "env",
      provider: "default",
      id: "MISSING_REMOTE_TOKEN",
    });
    expect(snapshot.config.gateway?.remote?.password).toEqual({
      source: "env",
      provider: "default",
      id: "MISSING_REMOTE_PASSWORD",
    });
    expect(snapshot.warnings.map((warning) => warning.path)).toEqual(
      expect.arrayContaining(["gateway.remote.token", "gateway.remote.password"]),
    );
  });

  it("treats gateway.auth.password ref as active when mode is unset and no token is configured", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        gateway: {
          auth: {
            password: { source: "env", provider: "default", id: "GATEWAY_PASSWORD_REF" },
          },
        },
      }),
      env: {
        GATEWAY_PASSWORD_REF: "resolved-gateway-password",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(snapshot.config.gateway?.auth?.password).toBe("resolved-gateway-password");
    expect(snapshot.warnings.map((warning) => warning.path)).not.toContain("gateway.auth.password");
  });

  it("treats gateway.auth.token ref as active when token mode is explicit", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        gateway: {
          auth: {
            mode: "token",
            token: { source: "env", provider: "default", id: "GATEWAY_TOKEN_REF" },
          },
        },
      }),
      env: {
        GATEWAY_TOKEN_REF: "resolved-gateway-token",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(snapshot.config.gateway?.auth?.token).toBe("resolved-gateway-token");
    expect(snapshot.warnings.map((warning) => warning.path)).not.toContain("gateway.auth.token");
  });

  it("treats gateway.auth.token ref as inactive when password mode is explicit", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        gateway: {
          auth: {
            mode: "password",
            token: { source: "env", provider: "default", id: "GATEWAY_TOKEN_REF" },
          },
        },
      }),
      env: {},
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(snapshot.config.gateway?.auth?.token).toEqual({
      source: "env",
      provider: "default",
      id: "GATEWAY_TOKEN_REF",
    });
    expect(snapshot.warnings.map((warning) => warning.path)).toContain("gateway.auth.token");
  });

  it("fails when gateway.auth.token ref is active and unresolved", async () => {
    await expect(
      prepareSecretsRuntimeSnapshot({
        config: asConfig({
          gateway: {
            auth: {
              mode: "token",
              token: { source: "env", provider: "default", id: "MISSING_GATEWAY_TOKEN_REF" },
            },
          },
        }),
        env: {},
        agentDirs: ["/tmp/openclaw-agent-main"],
        loadAuthStore: () => ({ version: 1, profiles: {} }),
      }),
    ).rejects.toThrow(/MISSING_GATEWAY_TOKEN_REF/);
  });

  it("treats gateway.auth.password ref as inactive when auth mode is trusted-proxy", async () => {
    await expectInactiveGatewayPassword({
      gateway: {
        auth: {
          mode: "trusted-proxy",
          password: { source: "env", provider: "default", id: "GATEWAY_PASSWORD_REF" },
        },
      },
    });
  });

  it("treats gateway.auth.password ref as inactive when remote token is configured", async () => {
    await expectInactiveGatewayPassword({
      gateway: {
        mode: "local",
        auth: {
          password: { source: "env", provider: "default", id: "GATEWAY_PASSWORD_REF" },
        },
        remote: {
          enabled: true,
          token: "remote-token",
        },
      },
    });
  });

  it.each(["none", "trusted-proxy"] as const)(
    "treats gateway.remote refs as inactive in local mode when auth mode is %s",
    async (mode) => {
      const snapshot = await prepareSecretsRuntimeSnapshot({
        config: asConfig({
          gateway: {
            mode: "local",
            auth: {
              mode,
            },
            remote: {
              enabled: true,
              token: { source: "env", provider: "default", id: "REMOTE_GATEWAY_TOKEN_REF" },
              password: {
                source: "env",
                provider: "default",
                id: "REMOTE_GATEWAY_PASSWORD_REF",
              },
            },
          },
        }),
        env: {},
        agentDirs: ["/tmp/openclaw-agent-main"],
        loadAuthStore: () => ({ version: 1, profiles: {} }),
      });

      expect(snapshot.config.gateway?.remote?.token).toEqual({
        source: "env",
        provider: "default",
        id: "REMOTE_GATEWAY_TOKEN_REF",
      });
      expect(snapshot.config.gateway?.remote?.password).toEqual({
        source: "env",
        provider: "default",
        id: "REMOTE_GATEWAY_PASSWORD_REF",
      });
      expect(snapshot.warnings.map((warning) => warning.path)).toEqual(
        expect.arrayContaining(["gateway.remote.token", "gateway.remote.password"]),
      );
    },
  );

  it("treats gateway.remote.token ref as active in local mode when no local credentials are configured", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        gateway: {
          mode: "local",
          remote: {
            enabled: true,
            token: { source: "env", provider: "default", id: "REMOTE_GATEWAY_TOKEN_REF" },
          },
        },
      }),
      env: {
        REMOTE_GATEWAY_TOKEN_REF: "resolved-remote-gateway-token",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(snapshot.config.gateway?.remote?.token).toBe("resolved-remote-gateway-token");
    expect(snapshot.warnings.map((warning) => warning.path)).not.toContain("gateway.remote.token");
  });

  it("treats gateway.remote.password ref as active in local mode when password can win", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        gateway: {
          mode: "local",
          remote: {
            enabled: true,
            password: { source: "env", provider: "default", id: "REMOTE_GATEWAY_PASSWORD_REF" },
          },
        },
      }),
      env: {
        REMOTE_GATEWAY_PASSWORD_REF: "resolved-remote-gateway-password",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(snapshot.config.gateway?.remote?.password).toBe("resolved-remote-gateway-password");
    expect(snapshot.warnings.map((warning) => warning.path)).not.toContain(
      "gateway.remote.password",
    );
  });

  it("treats gateway.remote refs as active when tailscale serve is enabled", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        gateway: {
          mode: "local",
          tailscale: { mode: "serve" },
          remote: {
            enabled: true,
            token: { source: "env", provider: "default", id: "REMOTE_GATEWAY_TOKEN" },
            password: { source: "env", provider: "default", id: "REMOTE_GATEWAY_PASSWORD" },
          },
        },
      }),
      env: {
        REMOTE_GATEWAY_TOKEN: "tailscale-remote-token",
        REMOTE_GATEWAY_PASSWORD: "tailscale-remote-password",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    expect(snapshot.config.gateway?.remote?.token).toBe("tailscale-remote-token");
    expect(snapshot.config.gateway?.remote?.password).toBe("tailscale-remote-password");
    expect(snapshot.warnings.map((warning) => warning.path)).not.toContain("gateway.remote.token");
    expect(snapshot.warnings.map((warning) => warning.path)).not.toContain(
      "gateway.remote.password",
    );
  });
});
