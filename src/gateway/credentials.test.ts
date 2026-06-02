import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveGatewayCredentialsFromConfig,
  resolveGatewayCredentialsFromValues,
} from "./credentials.js";

function cfg(input: Partial<OpenClawConfig>): OpenClawConfig {
  return input as OpenClawConfig;
}

type ResolveFromConfigInput = Parameters<typeof resolveGatewayCredentialsFromConfig>[0];
type GatewayConfig = NonNullable<OpenClawConfig["gateway"]>;
type ResolveFromConfigOverrides = Partial<Omit<ResolveFromConfigInput, "cfg" | "env">>;

const DEFAULT_GATEWAY_AUTH = { token: "config-token", password: "config-password" }; // pragma: allowlist secret
const DEFAULT_REMOTE_AUTH = { token: "remote-token", password: "remote-password" }; // pragma: allowlist secret
const DEFAULT_GATEWAY_ENV = {
  OPENCLAW_GATEWAY_TOKEN: "env-token",
  OPENCLAW_GATEWAY_PASSWORD: "env-password", // pragma: allowlist secret
} as NodeJS.ProcessEnv;
const EMPTY_GATEWAY_ENV = {} as NodeJS.ProcessEnv;

function envSecretRef(id: string) {
  return { source: "env", provider: "default", id } as const;
}

function cfgWithDefaultEnvSecretProvider(gateway: GatewayConfig): OpenClawConfig {
  return {
    gateway,
    secrets: {
      providers: {
        default: { source: "env" },
      },
    },
  } as unknown as OpenClawConfig;
}

function resolveGatewayCredentialsWithEmptyEnv(
  config: OpenClawConfig,
  overrides: ResolveFromConfigOverrides = {},
) {
  return resolveGatewayCredentialsFromConfig({
    cfg: config,
    env: EMPTY_GATEWAY_ENV,
    ...overrides,
  });
}

function resolveGatewayCredentialsFor(
  gateway: GatewayConfig,
  overrides: ResolveFromConfigOverrides = {},
) {
  return resolveGatewayCredentialsFromConfig({
    cfg: cfg({ gateway }),
    env: DEFAULT_GATEWAY_ENV,
    ...overrides,
  });
}

function resolveLocalGatewayCredentials(gateway: GatewayConfig) {
  return resolveGatewayCredentialsWithEmptyEnv(cfg({ gateway: { mode: "local", ...gateway } }));
}

function expectEnvGatewayCredentials(resolved: { token?: string; password?: string }) {
  expect(resolved).toEqual({
    token: "env-token",
    password: "env-password", // pragma: allowlist secret
  });
}

function expectNoGatewayCredentials(resolved: { token?: string; password?: string }) {
  expect(resolved).toEqual({
    token: undefined,
    password: undefined,
  });
}

function expectRemoteGatewayCredentials(resolved: { token?: string; password?: string }) {
  expect(resolved).toEqual({
    token: "remote-token",
    password: "remote-password", // pragma: allowlist secret
  });
}

function resolveGatewayCredentialsFromDefaultValues(
  overrides: Partial<Parameters<typeof resolveGatewayCredentialsFromValues>[0]> = {},
) {
  return resolveGatewayCredentialsFromValues({
    configToken: "config-token",
    configPassword: "config-password", // pragma: allowlist secret
    env: DEFAULT_GATEWAY_ENV,
    ...overrides,
  });
}

function resolveRemoteModeWithRemoteCredentials(overrides: ResolveFromConfigOverrides = {}) {
  return resolveGatewayCredentialsFor(
    {
      mode: "remote",
      remote: DEFAULT_REMOTE_AUTH,
      auth: DEFAULT_GATEWAY_AUTH,
    },
    overrides,
  );
}

function resolveLocalModeWithUnresolvedPassword(mode: "none" | "trusted-proxy") {
  return resolveGatewayCredentialsWithEmptyEnv(
    cfgWithDefaultEnvSecretProvider({
      mode: "local",
      auth: {
        mode,
        password: envSecretRef("MISSING_GATEWAY_PASSWORD"),
      },
    }),
  );
}

function expectUnresolvedLocalAuthSecretRefFailure(params: {
  authMode: "token" | "password";
  secretId: string;
  errorPath: "gateway.auth.token" | "gateway.auth.password";
  remote?: { token?: string; password?: string };
}) {
  const localAuth =
    params.authMode === "token"
      ? {
          mode: "token" as const,
          token: envSecretRef(params.secretId),
        }
      : {
          mode: "password" as const,
          password: envSecretRef(params.secretId),
        };

  expect(() =>
    resolveGatewayCredentialsWithEmptyEnv(
      cfgWithDefaultEnvSecretProvider({
        mode: "local",
        auth: localAuth,
        remote: params.remote,
      }),
    ),
  ).toThrow(params.errorPath);
}

describe("resolveGatewayCredentialsFromConfig", () => {
  it("prefers explicit credentials over config and environment", () => {
    const resolved = resolveGatewayCredentialsFor(
      {
        auth: DEFAULT_GATEWAY_AUTH,
      },
      {
        explicitAuth: { token: "explicit-token", password: "explicit-password" }, // pragma: allowlist secret
      },
    );
    expect(resolved).toEqual({
      token: "explicit-token",
      password: "explicit-password", // pragma: allowlist secret
    });
  });

  it("returns empty credentials when url override is used without explicit auth", () => {
    const resolved = resolveGatewayCredentialsFor(
      {
        auth: DEFAULT_GATEWAY_AUTH,
      },
      {
        urlOverride: "wss://example.com",
      },
    );
    expect(resolved).toStrictEqual({});
  });

  it("uses env credentials for env-sourced url overrides", () => {
    const resolved = resolveGatewayCredentialsFor(
      {
        auth: DEFAULT_GATEWAY_AUTH,
      },
      {
        urlOverride: "wss://example.com",
        urlOverrideSource: "env",
      },
    );
    expectEnvGatewayCredentials(resolved);
  });

  it("uses local-mode environment values before local config", () => {
    const resolved = resolveGatewayCredentialsFor({
      mode: "local",
      auth: DEFAULT_GATEWAY_AUTH,
    });
    expectEnvGatewayCredentials(resolved);
  });

  it("uses config-first local token precedence inside gateway service runtime", () => {
    const resolved = resolveGatewayCredentialsFromConfig({
      cfg: cfg({
        gateway: {
          mode: "local",
          auth: { token: "config-token", password: "config-password" }, // pragma: allowlist secret
        },
      }),
      env: {
        OPENCLAW_GATEWAY_TOKEN: "env-token",
        OPENCLAW_GATEWAY_PASSWORD: "env-password", // pragma: allowlist secret
        OPENCLAW_SERVICE_KIND: "gateway",
      } as NodeJS.ProcessEnv,
    });
    expect(resolved).toEqual({
      token: "config-token",
      password: "env-password", // pragma: allowlist secret
    });
  });

  it("falls back to remote credentials in local mode when local auth is missing", () => {
    const resolved = resolveLocalGatewayCredentials({
      remote: DEFAULT_REMOTE_AUTH,
      auth: {},
    });
    expectRemoteGatewayCredentials(resolved);
  });

  it("fails closed when local token SecretRef is unresolved and remote token fallback exists", () => {
    expectUnresolvedLocalAuthSecretRefFailure({
      authMode: "token",
      secretId: "MISSING_LOCAL_TOKEN",
      errorPath: "gateway.auth.token",
      remote: { token: "remote-token" },
    });
  });

  it("fails closed when local password SecretRef is unresolved and remote password fallback exists", () => {
    expectUnresolvedLocalAuthSecretRefFailure({
      authMode: "password",
      secretId: "MISSING_LOCAL_PASSWORD",
      errorPath: "gateway.auth.password",
      remote: { password: "remote-password" }, // pragma: allowlist secret
    });
  });

  it("throws when local password auth relies on an unresolved SecretRef", () => {
    expectUnresolvedLocalAuthSecretRefFailure({
      authMode: "password",
      secretId: "MISSING_GATEWAY_PASSWORD",
      errorPath: "gateway.auth.password",
    });
  });

  it("treats env-template local tokens as SecretRefs instead of plaintext", () => {
    const resolved = resolveGatewayCredentialsFromConfig({
      cfg: cfg({
        gateway: {
          mode: "local",
          auth: {
            mode: "token",
            token: "${OPENCLAW_GATEWAY_TOKEN}",
          },
        },
      }),
      env: {
        OPENCLAW_GATEWAY_TOKEN: "env-token",
      } as NodeJS.ProcessEnv,
    });

    expect(resolved).toEqual({
      token: "env-token",
      password: undefined,
    });
  });

  it("throws when env-template local token SecretRef is unresolved in token mode", () => {
    expect(() =>
      resolveGatewayCredentialsFromConfig({
        cfg: cfg({
          gateway: {
            mode: "local",
            auth: {
              mode: "token",
              token: "${OPENCLAW_GATEWAY_TOKEN}",
            },
          },
        }),
        env: {} as NodeJS.ProcessEnv,
      }),
    ).toThrow("gateway.auth.token");
  });

  it("ignores unresolved local password ref when local auth mode is none", () => {
    const resolved = resolveLocalModeWithUnresolvedPassword("none");
    expectNoGatewayCredentials(resolved);
  });

  it("throws when trusted-proxy local password SecretRef cannot resolve", () => {
    expect(() => resolveLocalModeWithUnresolvedPassword("trusted-proxy")).toThrow(
      "gateway.auth.password",
    );
  });

  it("resolves trusted-proxy local password credentials", () => {
    const resolved = resolveLocalGatewayCredentials({
      auth: {
        mode: "trusted-proxy",
        password: "local-trusted-proxy-password", // pragma: allowlist secret
      },
    });

    expect(resolved).toEqual({
      token: undefined,
      password: "local-trusted-proxy-password", // pragma: allowlist secret
    });
  });

  it("does not use remote password as trusted-proxy local fallback", () => {
    const resolved = resolveLocalGatewayCredentials({
      auth: {
        mode: "trusted-proxy",
      },
      remote: {
        password: "remote-password", // pragma: allowlist secret
      },
    });

    expectNoGatewayCredentials(resolved);
  });

  it("keeps local credentials ahead of remote fallback in local mode", () => {
    const resolved = resolveLocalGatewayCredentials({
      remote: DEFAULT_REMOTE_AUTH,
      auth: { token: "local-token", password: "local-password" }, // pragma: allowlist secret
    });
    expect(resolved).toEqual({
      token: "local-token",
      password: "local-password", // pragma: allowlist secret
    });
  });

  it("uses remote-mode remote credentials before env and local config", () => {
    const resolved = resolveRemoteModeWithRemoteCredentials();
    expect(resolved).toEqual({
      token: "remote-token",
      password: "env-password", // pragma: allowlist secret
    });
  });

  it("falls back to env/config when remote mode omits remote credentials", () => {
    const resolved = resolveGatewayCredentialsFor({
      mode: "remote",
      remote: {},
      auth: DEFAULT_GATEWAY_AUTH,
    });
    expectEnvGatewayCredentials(resolved);
  });

  it("supports env-first password override in remote mode for gateway call path", () => {
    const resolved = resolveRemoteModeWithRemoteCredentials({
      remotePasswordPrecedence: "env-first", // pragma: allowlist secret
    });
    expect(resolved).toEqual({
      token: "remote-token",
      password: "env-password", // pragma: allowlist secret
    });
  });

  it("supports env-first token precedence in remote mode", () => {
    const resolved = resolveRemoteModeWithRemoteCredentials({
      remoteTokenPrecedence: "env-first",
      remotePasswordPrecedence: "remote-first", // pragma: allowlist secret
    });
    expect(resolved).toEqual({
      token: "env-token",
      password: "remote-password", // pragma: allowlist secret
    });
  });

  it("supports remote-only password fallback for strict remote override call sites", () => {
    const resolved = resolveGatewayCredentialsFor(
      {
        mode: "remote",
        remote: { token: "remote-token" },
        auth: DEFAULT_GATEWAY_AUTH,
      },
      {
        remotePasswordFallback: "remote-only", // pragma: allowlist secret
      },
    );
    expect(resolved).toEqual({
      token: "remote-token",
      password: undefined,
    });
  });

  it("supports remote-only token fallback for strict remote override call sites", () => {
    const resolved = resolveGatewayCredentialsFromConfig({
      cfg: cfg({
        gateway: {
          mode: "remote",
          remote: { url: "wss://gateway.example" },
          auth: { token: "local-token" },
        },
      }),
      env: {
        OPENCLAW_GATEWAY_TOKEN: "env-token",
      } as NodeJS.ProcessEnv,
      remoteTokenFallback: "remote-only",
    });
    expect(resolved.token).toBeUndefined();
  });

  it("throws when remote token auth relies on an unresolved SecretRef", () => {
    expect(() =>
      resolveGatewayCredentialsWithEmptyEnv(
        cfgWithDefaultEnvSecretProvider({
          mode: "remote",
          remote: {
            url: "wss://gateway.example",
            token: envSecretRef("MISSING_REMOTE_TOKEN"),
          },
          auth: {},
        }),
        { remoteTokenFallback: "remote-only" },
      ),
    ).toThrow("gateway.remote.token");
  });

  function createRemoteConfigWithMissingLocalTokenRef() {
    return {
      gateway: {
        mode: "remote",
        remote: {
          url: "wss://gateway.example",
        },
        auth: {
          mode: "token",
          token: envSecretRef("MISSING_LOCAL_TOKEN"),
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    } as unknown as OpenClawConfig;
  }

  it("ignores unresolved local token ref in remote-only mode when local auth mode is token", () => {
    const resolved = resolveGatewayCredentialsWithEmptyEnv(
      createRemoteConfigWithMissingLocalTokenRef(),
      {
        remoteTokenFallback: "remote-only",
        remotePasswordFallback: "remote-only", // pragma: allowlist secret
      },
    );
    expect(resolved).toEqual({
      token: undefined,
      password: undefined,
    });
  });

  it("throws for unresolved local token ref in remote mode when local fallback is enabled", () => {
    expect(() =>
      resolveGatewayCredentialsWithEmptyEnv(createRemoteConfigWithMissingLocalTokenRef(), {
        remoteTokenFallback: "remote-env-local",
        remotePasswordFallback: "remote-only", // pragma: allowlist secret
      }),
    ).toThrow("gateway.auth.token");
  });

  it("uses remote password when remote token ref is unresolved", () => {
    const resolved = resolveGatewayCredentialsWithEmptyEnv(
      cfgWithDefaultEnvSecretProvider({
        mode: "remote",
        remote: {
          url: "wss://gateway.example",
          token: envSecretRef("MISSING_REMOTE_TOKEN"),
          password: "remote-password", // pragma: allowlist secret
        },
        auth: {},
      }),
    );
    expect(resolved).toEqual({
      token: undefined,
      password: "remote-password", // pragma: allowlist secret
    });
  });

  it("throws when remote password auth relies on an unresolved SecretRef", () => {
    expect(() =>
      resolveGatewayCredentialsWithEmptyEnv(
        cfgWithDefaultEnvSecretProvider({
          mode: "remote",
          remote: {
            url: "wss://gateway.example",
            password: envSecretRef("MISSING_REMOTE_PASSWORD"),
          },
          auth: {},
        }),
        { remotePasswordFallback: "remote-only" }, // pragma: allowlist secret
      ),
    ).toThrow("gateway.remote.password");
  });
});

describe("resolveGatewayCredentialsFromValues", () => {
  it("supports config-first precedence for token/password", () => {
    const resolved = resolveGatewayCredentialsFromDefaultValues({
      tokenPrecedence: "config-first",
      passwordPrecedence: "config-first", // pragma: allowlist secret
    });
    expect(resolved).toEqual({
      token: "config-token",
      password: "config-password", // pragma: allowlist secret
    });
  });

  it("uses env-first precedence by default", () => {
    const resolved = resolveGatewayCredentialsFromDefaultValues();
    expectEnvGatewayCredentials(resolved);
  });

  it("rejects unresolved env var placeholders in config credentials", () => {
    const resolved = resolveGatewayCredentialsFromValues({
      configToken: "${OPENCLAW_GATEWAY_TOKEN}",
      configPassword: "${OPENCLAW_GATEWAY_PASSWORD}",
      env: {} as NodeJS.ProcessEnv,
      tokenPrecedence: "config-first",
      passwordPrecedence: "config-first", // pragma: allowlist secret
    });
    expect(resolved).toEqual({ token: undefined, password: undefined });
  });

  it("accepts config credentials that do not contain env var references", () => {
    const resolved = resolveGatewayCredentialsFromValues({
      configToken: "real-token-value",
      configPassword: "real-password", // pragma: allowlist secret
      env: {} as NodeJS.ProcessEnv,
      tokenPrecedence: "config-first",
      passwordPrecedence: "config-first", // pragma: allowlist secret
    });
    expect(resolved).toEqual({ token: "real-token-value", password: "real-password" }); // pragma: allowlist secret
  });
});
