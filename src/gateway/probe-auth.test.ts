// Probe auth tests cover safe credential resolution, unresolved-secret warnings,
// local/remote target selection, and redacted auth payload handling.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveConfigForRead } from "../config/io.read-helpers.js";
import { setConfigResolutionFacts } from "../config/resolution-facts.js";
import {
  resolveGatewayProbeAuthSafe,
  resolveGatewayProbeAuthSafeWithSecretInputs,
  resolveGatewayProbeTarget,
  resolveGatewayProbeAuthWithSecretInputs,
} from "./probe-auth.js";

const EMPTY_PROBE_AUTH = {
  token: undefined,
  password: undefined,
};

function envSecretRef(id: string) {
  return { source: "env", provider: "default", id } as const;
}

function tokenAuthConfig(id: string) {
  return {
    mode: "token",
    token: envSecretRef(id),
  } as const;
}

function configWithDefaultEnvProvider(gateway: NonNullable<OpenClawConfig["gateway"]>) {
  return {
    gateway,
    secrets: {
      providers: {
        default: { source: "env" },
      },
    },
  } as OpenClawConfig;
}

function configFromAuthoredToken(token: string, env: NodeJS.ProcessEnv): OpenClawConfig {
  const read = resolveConfigForRead({ gateway: { auth: { mode: "token", token } } }, env);
  const config = read.resolvedConfigRaw as OpenClawConfig;
  setConfigResolutionFacts(config, read.resolutionFacts);
  return config;
}

function resolveSafeProbeAuth(cfg: OpenClawConfig, mode: "local" | "remote" = "local") {
  return resolveGatewayProbeAuthSafe({
    cfg,
    mode,
    env: {} as NodeJS.ProcessEnv,
  });
}

function expectUnresolvedProbeTokenWarning(cfg: OpenClawConfig) {
  const result = resolveSafeProbeAuth(cfg);

  expect(result.auth).toStrictEqual({});
  expect(result.warning).toContain("gateway.auth.token");
  expect(result.warning).toContain("unresolved");
}

describe("resolveGatewayProbeAuthSafe", () => {
  it("returns probe auth credentials when available", () => {
    const result = resolveSafeProbeAuth({
      gateway: {
        auth: {
          token: "token-value",
        },
      },
    } as OpenClawConfig);

    expect(result).toEqual({
      auth: {
        token: "token-value",
        password: undefined,
      },
    });
  });

  it("returns warning and empty auth when token SecretRef is unresolved", () => {
    expectUnresolvedProbeTokenWarning(
      configWithDefaultEnvProvider({
        auth: tokenAuthConfig("MISSING_GATEWAY_TOKEN"),
      }),
    );
  });

  it("does not fall through to remote token when local token SecretRef is unresolved", () => {
    expectUnresolvedProbeTokenWarning(
      configWithDefaultEnvProvider({
        mode: "local",
        auth: tokenAuthConfig("MISSING_GATEWAY_TOKEN"),
        remote: {
          token: "remote-token",
        },
      }),
    );
  });

  it("does not fall through to remote credentials for local probes", () => {
    const result = resolveSafeProbeAuth({
      gateway: {
        mode: "local",
        remote: {
          url: "wss://gateway.example",
          token: "remote-token",
          password: "remote-password", // pragma: allowlist secret
        },
      },
    } as OpenClawConfig);

    expect(result).toEqual({
      auth: EMPTY_PROBE_AUTH,
    });
  });

  it("ignores unresolved local token SecretRef in remote mode when remote-only auth is requested", () => {
    const result = resolveSafeProbeAuth(
      configWithDefaultEnvProvider({
        mode: "remote",
        remote: {
          url: "wss://gateway.example",
        },
        auth: tokenAuthConfig("MISSING_LOCAL_TOKEN"),
      }),
      "remote",
    );

    expect(result).toEqual({
      auth: EMPTY_PROBE_AUTH,
    });
  });
});

describe("resolveGatewayProbeTarget", () => {
  it("falls back to local probe mode when remote mode is configured without remote url", () => {
    expect(
      resolveGatewayProbeTarget({
        gateway: {
          mode: "remote",
        },
      } as OpenClawConfig),
    ).toEqual({
      gatewayMode: "remote",
      mode: "local",
      remoteUrlMissing: true,
    });
  });

  it("keeps remote probe mode when remote url is configured", () => {
    expect(
      resolveGatewayProbeTarget({
        gateway: {
          mode: "remote",
          remote: {
            url: "wss://gateway.example",
          },
        },
      } as OpenClawConfig),
    ).toEqual({
      gatewayMode: "remote",
      mode: "remote",
      remoteUrlMissing: false,
    });
  });
});

describe("resolveGatewayProbeAuthSafeWithSecretInputs", () => {
  it.each([
    { mode: "token" as const, value: "configured-token", expected: "ambient-token" },
    { mode: "password" as const, value: "configured-password", expected: "ambient-password" },
    { mode: "token" as const, value: envSecretRef("PROBE_SECRET"), expected: "resolved-secret" },
    {
      mode: "password" as const,
      value: envSecretRef("PROBE_SECRET"),
      expected: "resolved-secret",
    },
  ])("keeps env-first $mode precedence unless an explicit SecretRef owns it", async (testCase) => {
    const result = await resolveGatewayProbeAuthSafeWithSecretInputs({
      cfg: configWithDefaultEnvProvider({
        auth: { mode: testCase.mode, [testCase.mode]: testCase.value },
      }),
      mode: "local",
      localPrecedence: "env-first",
      env: {
        OPENCLAW_GATEWAY_TOKEN: "ambient-token",
        OPENCLAW_GATEWAY_PASSWORD: "ambient-password",
        PROBE_SECRET: "resolved-secret",
      },
    });

    expect(result.warning).toBeUndefined();
    expect(result.auth[testCase.mode]).toBe(testCase.expected);
  });

  it.each(["token", "password"] as const)(
    "does not replace an unavailable active %s SecretRef with env-first auth",
    async (mode) => {
      const result = await resolveGatewayProbeAuthSafeWithSecretInputs({
        cfg: configWithDefaultEnvProvider({
          auth: { mode, [mode]: envSecretRef("MISSING_PROBE_SECRET") },
        }),
        mode: "local",
        localPrecedence: "env-first",
        env: {
          OPENCLAW_GATEWAY_TOKEN: "ambient-token",
          OPENCLAW_GATEWAY_PASSWORD: "ambient-password",
        },
      });

      expect(result.auth).toStrictEqual({});
      expect(result.warning).toContain(`gateway.auth.${mode}`);
    },
  );

  it("does not bypass an implicit password SecretRef with an env-first ambient token", async () => {
    const result = await resolveGatewayProbeAuthSafeWithSecretInputs({
      cfg: configWithDefaultEnvProvider({
        auth: { password: envSecretRef("MISSING_IMPLICIT_PASSWORD") },
      }),
      mode: "local",
      localPrecedence: "env-first",
      env: { OPENCLAW_GATEWAY_TOKEN: "ambient-token" },
    });

    expect(result.auth).toStrictEqual({});
    expect(result.warning).toContain("gateway.auth.password");
  });

  it("resolves env SecretRef token via async secret-inputs path", async () => {
    const result = await resolveGatewayProbeAuthSafeWithSecretInputs({
      cfg: configWithDefaultEnvProvider({
        auth: tokenAuthConfig("OPENCLAW_GATEWAY_TOKEN"),
      }),
      mode: "local",
      env: {
        OPENCLAW_GATEWAY_TOKEN: "test-token-from-env",
      } as NodeJS.ProcessEnv,
    });

    expect(result.warning).toBeUndefined();
    expect(result.auth).toEqual({
      token: "test-token-from-env",
      password: undefined,
    });
  });

  it("preserves a substituted template-looking literal for probe auth", async () => {
    const result = await resolveGatewayProbeAuthSafeWithSecretInputs({
      cfg: configFromAuthoredToken("${SOURCE}", { SOURCE: "${OTHER}" }),
      mode: "local",
      env: {},
    });

    expect(result).toEqual({
      auth: { token: "${OTHER}", password: undefined },
    });
  });

  it.each(["$MISSING", "${MISSING}"])(
    "keeps unresolved authored shorthand unavailable: %s",
    async (authored) => {
      const result = await resolveGatewayProbeAuthSafeWithSecretInputs({
        cfg: configFromAuthoredToken(authored, {}),
        mode: "local",
        env: {},
      });

      expect(result.auth).toStrictEqual({});
      expect(result.warning).toContain("gateway.auth.token");
      expect(result.warning).toContain("unresolved");
    },
  );

  it("returns empty auth without warning for gateway.remote SecretRefs in local probes", async () => {
    const result = await resolveGatewayProbeAuthSafeWithSecretInputs({
      cfg: configWithDefaultEnvProvider({
        mode: "local",
        remote: {
          url: "wss://gateway.example",
          token: envSecretRef("REMOTE_GATEWAY_TOKEN"),
        },
      }),
      mode: "local",
      env: {
        REMOTE_GATEWAY_TOKEN: "remote-token",
      } as NodeJS.ProcessEnv,
    });

    expect(result.warning).toBeUndefined();
    expect(result.auth).toEqual({
      ...EMPTY_PROBE_AUTH,
    });
  });

  it("returns warning and empty auth when SecretRef cannot be resolved via async path", async () => {
    const result = await resolveGatewayProbeAuthSafeWithSecretInputs({
      cfg: configWithDefaultEnvProvider({
        auth: tokenAuthConfig("MISSING_TOKEN_XYZ"),
      }),
      mode: "local",
      env: {} as NodeJS.ProcessEnv,
    });

    expect(result.auth).toStrictEqual({});
    expect(result.warning).toContain("gateway.auth.token");
    expect(result.warning).toContain("unresolved");
  });

  it("keeps a configured remote token authoritative over an environment password", async () => {
    const result = await resolveGatewayProbeAuthSafeWithSecretInputs({
      cfg: configWithDefaultEnvProvider({
        mode: "remote",
        remote: {
          url: "wss://gateway.example",
          token: envSecretRef("REMOTE_GATEWAY_TOKEN"),
        },
      }),
      mode: "remote",
      env: {
        REMOTE_GATEWAY_TOKEN: "resolved-remote-token",
        OPENCLAW_GATEWAY_PASSWORD: "env-password", // pragma: allowlist secret
      } as NodeJS.ProcessEnv,
    });

    expect(result).toEqual({
      auth: {
        token: "resolved-remote-token",
        password: undefined,
      },
    });
  });

  it("keeps a configured remote password authoritative over environment auth", async () => {
    const result = await resolveGatewayProbeAuthSafeWithSecretInputs({
      cfg: {
        gateway: {
          mode: "remote",
          remote: {
            url: "wss://gateway.example",
            password: "remote-password", // pragma: allowlist secret
          },
        },
      },
      mode: "remote",
      env: {
        OPENCLAW_GATEWAY_TOKEN: "env-token",
        OPENCLAW_GATEWAY_PASSWORD: "env-password", // pragma: allowlist secret
      } as NodeJS.ProcessEnv,
    });

    expect(result).toEqual({
      auth: {
        token: undefined,
        password: "remote-password", // pragma: allowlist secret
      },
    });
  });

  it("blocks ambient password fallback when a configured remote token ref fails", async () => {
    const result = await resolveGatewayProbeAuthSafeWithSecretInputs({
      cfg: configWithDefaultEnvProvider({
        mode: "remote",
        remote: { url: "wss://gateway.example", token: envSecretRef("MISSING_REMOTE_TOKEN") },
      }),
      mode: "remote",
      env: { OPENCLAW_GATEWAY_PASSWORD: "ambient-password" } as NodeJS.ProcessEnv, // pragma: allowlist secret
    });

    expect(result.auth).toStrictEqual({});
    expect(result.warning).toContain("gateway.remote.token SecretRef is unresolved");
  });

  it("preserves a configured remote password when the token ref fails", async () => {
    const result = await resolveGatewayProbeAuthSafeWithSecretInputs({
      cfg: configWithDefaultEnvProvider({
        mode: "remote",
        remote: {
          url: "wss://gateway.example",
          token: envSecretRef("MISSING_REMOTE_TOKEN"),
          password: "remote-password", // pragma: allowlist secret
        },
      }),
      mode: "remote",
      env: { OPENCLAW_GATEWAY_PASSWORD: "ambient-password" } as NodeJS.ProcessEnv, // pragma: allowlist secret
    });

    expect(result.auth).toEqual({ token: undefined, password: "remote-password" }); // pragma: allowlist secret
    expect(result.warning).toContain("gateway.remote.token SecretRef is unresolved");
  });

  it("blocks ambient token fallback when a configured remote password ref fails", async () => {
    const result = await resolveGatewayProbeAuthSafeWithSecretInputs({
      cfg: configWithDefaultEnvProvider({
        mode: "remote",
        remote: {
          url: "wss://gateway.example",
          password: envSecretRef("MISSING_REMOTE_PASSWORD"), // pragma: allowlist secret
        },
      }),
      mode: "remote",
      env: { OPENCLAW_GATEWAY_TOKEN: "ambient-token" } as NodeJS.ProcessEnv,
    });

    expect(result.auth).toStrictEqual({});
    expect(result.warning).toContain("gateway.remote.password SecretRef is unresolved");
  });

  it("does not resolve a local password SecretRef for a remote probe", async () => {
    const result = await resolveGatewayProbeAuthSafeWithSecretInputs({
      cfg: configWithDefaultEnvProvider({
        mode: "remote",
        auth: {
          mode: "password",
          password: envSecretRef("LOCAL_GATEWAY_PASSWORD"),
        },
        remote: {
          url: "wss://gateway.example",
          token: "remote-token",
        },
      }),
      mode: "remote",
      env: {
        LOCAL_GATEWAY_PASSWORD: "local-password", // pragma: allowlist secret
      } as NodeJS.ProcessEnv,
    });

    expect(result).toEqual({
      auth: {
        token: "remote-token",
        password: undefined,
      },
    });
  });

  it("does not use ambient credentials for a CLI URL override", async () => {
    const result = await resolveGatewayProbeAuthSafeWithSecretInputs({
      cfg: {
        gateway: {
          mode: "remote",
          remote: { url: "wss://configured.example" },
        },
      } as OpenClawConfig,
      mode: "remote",
      env: {
        OPENCLAW_GATEWAY_PASSWORD: "ambient-password", // pragma: allowlist secret
      } as NodeJS.ProcessEnv,
      urlOverride: "wss://override.example",
      urlOverrideSource: "cli",
    });

    expect(result).toEqual({ auth: {} });
  });
});

describe("resolveGatewayProbeAuthWithSecretInputs", () => {
  it("resolves local probe SecretRef values before shared credential selection", async () => {
    const auth = await resolveGatewayProbeAuthWithSecretInputs({
      cfg: configWithDefaultEnvProvider({
        auth: tokenAuthConfig("DAEMON_GATEWAY_TOKEN"),
      }),
      mode: "local",
      env: {
        DAEMON_GATEWAY_TOKEN: "resolved-daemon-token",
      } as NodeJS.ProcessEnv,
    });

    expect(auth).toEqual({
      token: "resolved-daemon-token",
      password: undefined,
    });
  });
});
