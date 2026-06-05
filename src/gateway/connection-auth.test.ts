// Gateway connection auth tests document token/password precedence for local,
// remote, CLI override, env override, and config-secret connection flows.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveGatewayConnectionAuth,
  resolveGatewayConnectionAuthFromConfig,
  type GatewayConnectionAuthOptions,
} from "./connection-auth.js";

type ResolvedAuth = { token?: string; password?: string };

type ConnectionAuthCase = {
  name: string;
  cfgLocal: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  options?: Partial<Omit<GatewayConnectionAuthOptions, "config" | "env">>;
  expected: ResolvedAuth;
};

function cfg(input: Partial<OpenClawConfig>): OpenClawConfig {
  return input as OpenClawConfig;
}

function createRemoteModeConfig() {
  return {
    gateway: {
      mode: "remote" as const,
      auth: {
        token: "local-token",
        password: "local-password", // pragma: allowlist secret
      },
      remote: {
        url: "wss://remote.example",
        token: "remote-token",
        password: "remote-password", // pragma: allowlist secret
      },
    },
  };
}

const DEFAULT_ENV = {
  OPENCLAW_GATEWAY_TOKEN: "env-token",
  OPENCLAW_GATEWAY_PASSWORD: "env-password", // pragma: allowlist secret
} as NodeJS.ProcessEnv;

describe("resolveGatewayConnectionAuth", () => {
  const cases: ConnectionAuthCase[] = [
    {
      name: "local mode defaults to env-first token/password",
      cfgLocal: cfg({
        gateway: {
          mode: "local",
          auth: {
            token: "config-token",
            password: "config-password", // pragma: allowlist secret
          },
          remote: {
            token: "remote-token",
            password: "remote-password", // pragma: allowlist secret
          },
        },
      }),
      env: DEFAULT_ENV,
      expected: {
        token: "env-token",
        password: "env-password", // pragma: allowlist secret
      },
    },
    {
      name: "local mode supports config-first token/password",
      cfgLocal: cfg({
        gateway: {
          mode: "local",
          auth: {
            token: "config-token",
            password: "config-password", // pragma: allowlist secret
          },
        },
      }),
      env: DEFAULT_ENV,
      options: {
        localTokenPrecedence: "config-first",
        localPasswordPrecedence: "config-first", // pragma: allowlist secret
      },
      expected: {
        token: "config-token",
        password: "config-password", // pragma: allowlist secret
      },
    },
    {
      name: "local mode precedence can mix env-first token with config-first password",
      cfgLocal: cfg({
        gateway: {
          mode: "local",
          auth: {},
          remote: {
            token: "remote-token",
            password: "remote-password", // pragma: allowlist secret
          },
        },
      }),
      env: DEFAULT_ENV,
      options: {
        localTokenPrecedence: "env-first",
        localPasswordPrecedence: "config-first", // pragma: allowlist secret
      },
      expected: {
        token: "env-token",
        password: "remote-password", // pragma: allowlist secret
      },
    },
    {
      name: "remote mode defaults to remote-first token and env-first password",
      cfgLocal: cfg(createRemoteModeConfig()),
      env: DEFAULT_ENV,
      expected: {
        token: "remote-token",
        password: "env-password", // pragma: allowlist secret
      },
    },
    {
      name: "remote mode supports env-first token with remote-first password",
      cfgLocal: cfg(createRemoteModeConfig()),
      env: DEFAULT_ENV,
      options: {
        remoteTokenPrecedence: "env-first",
        remotePasswordPrecedence: "remote-first", // pragma: allowlist secret
      },
      expected: {
        token: "env-token",
        password: "remote-password", // pragma: allowlist secret
      },
    },
    {
      name: "remote-only fallback can suppress env/local password fallback",
      cfgLocal: cfg({
        gateway: {
          mode: "remote",
          auth: {
            token: "local-token",
            password: "local-password", // pragma: allowlist secret
          },
          remote: {
            url: "wss://remote.example",
            token: "remote-token",
          },
        },
      }),
      env: DEFAULT_ENV,
      options: {
        remoteTokenFallback: "remote-only",
        remotePasswordFallback: "remote-only", // pragma: allowlist secret
      },
      expected: {
        token: "remote-token",
        password: undefined,
      },
    },
    {
      name: "modeOverride can force remote precedence while config gateway.mode is local",
      cfgLocal: cfg({
        gateway: {
          mode: "local",
          auth: {
            token: "local-token",
            password: "local-password", // pragma: allowlist secret
          },
          remote: {
            url: "wss://remote.example",
            token: "remote-token",
            password: "remote-password", // pragma: allowlist secret
          },
        },
      }),
      env: DEFAULT_ENV,
      options: {
        modeOverride: "remote",
        remoteTokenPrecedence: "remote-first",
        remotePasswordPrecedence: "remote-first", // pragma: allowlist secret
      },
      expected: {
        token: "remote-token",
        password: "remote-password", // pragma: allowlist secret
      },
    },
  ];

  it.each(cases)("$name", async ({ cfgLocal, env, options, expected }) => {
    const asyncResolved = await resolveGatewayConnectionAuth({
      config: cfgLocal,
      env,
      ...options,
    });
    const syncResolved = resolveGatewayConnectionAuthFromConfig({
      cfg: cfgLocal,
      env,
      ...options,
    });
    expect(asyncResolved).toEqual(expected);
    expect(syncResolved).toEqual(expected);
  });

  it("resolves local SecretRef token when OPENCLAW env is absent", async () => {
    const config = cfg({
      gateway: {
        mode: "local",
        auth: {
          token: { source: "env", provider: "default", id: "LOCAL_SECRET_TOKEN" },
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    });
    const env = {
      LOCAL_SECRET_TOKEN: "resolved-from-secretref", // pragma: allowlist secret
    } as NodeJS.ProcessEnv;

    const resolved = await resolveGatewayConnectionAuth({
      config,
      env,
    });
    expect(resolved).toEqual({
      token: "resolved-from-secretref",
      password: undefined,
    });
  });

  it("resolves config-first token SecretRef even when OPENCLAW env token exists", async () => {
    const config = cfg({
      gateway: {
        mode: "local",
        auth: {
          token: { source: "env", provider: "default", id: "CONFIG_FIRST_TOKEN" },
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    });
    const env = {
      OPENCLAW_GATEWAY_TOKEN: "env-token",
      CONFIG_FIRST_TOKEN: "config-first-token",
    } as NodeJS.ProcessEnv;

    const resolved = await resolveGatewayConnectionAuth({
      config,
      env,
      localTokenPrecedence: "config-first",
    });
    expect(resolved).toEqual({
      token: "config-first-token",
      password: undefined,
    });
  });

  it("resolves config-first password SecretRef even when OPENCLAW env password exists", async () => {
    const config = cfg({
      gateway: {
        mode: "local",
        auth: {
          mode: "password",
          password: { source: "env", provider: "default", id: "CONFIG_FIRST_PASSWORD" },
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    });
    const env = {
      OPENCLAW_GATEWAY_PASSWORD: "env-password", // pragma: allowlist secret
      CONFIG_FIRST_PASSWORD: "config-first-password", // pragma: allowlist secret
    } as NodeJS.ProcessEnv;

    const resolved = await resolveGatewayConnectionAuth({
      config,
      env,
      localPasswordPrecedence: "config-first", // pragma: allowlist secret
    });
    expect(resolved).toEqual({
      token: undefined,
      password: "config-first-password", // pragma: allowlist secret
    });
  });

  it("throws when config-first token SecretRef cannot resolve even if env token exists", async () => {
    const config = cfg({
      gateway: {
        mode: "local",
        auth: {
          token: { source: "env", provider: "default", id: "MISSING_CONFIG_FIRST_TOKEN" },
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    });
    const env = {
      OPENCLAW_GATEWAY_TOKEN: "env-token",
    } as NodeJS.ProcessEnv;

    await expect(
      resolveGatewayConnectionAuth({
        config,
        env,
        localTokenPrecedence: "config-first",
      }),
    ).rejects.toThrow("gateway.auth.token");
    expect(() =>
      resolveGatewayConnectionAuthFromConfig({
        cfg: config,
        env,
        localTokenPrecedence: "config-first",
      }),
    ).toThrow("gateway.auth.token");
  });

  it("throws when config-first password SecretRef cannot resolve even if env password exists", async () => {
    const config = cfg({
      gateway: {
        mode: "local",
        auth: {
          mode: "password",
          password: { source: "env", provider: "default", id: "MISSING_CONFIG_FIRST_PASSWORD" },
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    });
    const env = {
      OPENCLAW_GATEWAY_PASSWORD: "env-password", // pragma: allowlist secret
    } as NodeJS.ProcessEnv;

    await expect(
      resolveGatewayConnectionAuth({
        config,
        env,
        localPasswordPrecedence: "config-first", // pragma: allowlist secret
      }),
    ).rejects.toThrow("gateway.auth.password");
    expect(() =>
      resolveGatewayConnectionAuthFromConfig({
        cfg: config,
        env,
        localPasswordPrecedence: "config-first", // pragma: allowlist secret
      }),
    ).toThrow("gateway.auth.password");
  });
});
