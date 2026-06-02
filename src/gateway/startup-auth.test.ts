import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { KNOWN_WEAK_GATEWAY_TOKEN_PLACEHOLDERS } from "./known-weak-gateway-secrets.js";
import {
  assertGatewayAuthNotKnownWeak,
  assertHooksTokenSeparateFromGatewayAuth,
  ensureGatewayStartupAuth,
  mergeGatewayTailscaleConfig,
} from "./startup-auth.js";

const mocks = vi.hoisted(() => ({
  replaceConfigFile: vi.fn(async (_params: { nextConfig: OpenClawConfig }) => {}),
}));

vi.mock("../config/mutate.js", () => ({
  replaceConfigFile: mocks.replaceConfigFile,
}));

vi.mock("../config/mutate.js", async () => {
  const actual = await vi.importActual<typeof import("../config/mutate.js")>("../config/mutate.js");
  return {
    ...actual,
    replaceConfigFile: mocks.replaceConfigFile,
  };
});

type StartupAuthInput = Parameters<typeof ensureGatewayStartupAuth>[0];
type StartupAuthResult = Awaited<ReturnType<typeof ensureGatewayStartupAuth>>;
type GatewayAuthConfig = NonNullable<NonNullable<OpenClawConfig["gateway"]>["auth"]>;
type GatewayAuthCheck = Parameters<typeof assertGatewayAuthNotKnownWeak>[0];
type HooksGatewayAuthCheck = Parameters<typeof assertHooksTokenSeparateFromGatewayAuth>[0]["auth"];

function emptyEnv(): NodeJS.ProcessEnv {
  return {} as NodeJS.ProcessEnv;
}

function gatewayEnvSecretRef(id: string) {
  return { source: "env" as const, provider: "default", id };
}

function gatewayAuthConfig(auth: GatewayAuthConfig): OpenClawConfig {
  return {
    gateway: { auth },
  };
}

function gatewayAuthConfigWithDefaultEnvProvider(auth: GatewayAuthConfig): OpenClawConfig {
  return {
    ...gatewayAuthConfig(auth),
    secrets: {
      providers: {
        default: { source: "env" },
      },
    },
  };
}

describe("mergeGatewayTailscaleConfig", () => {
  it("preserves explicit preserveFunnel overrides", () => {
    expect(
      mergeGatewayTailscaleConfig(
        { mode: "serve", resetOnExit: false, preserveFunnel: false },
        { preserveFunnel: true },
      ),
    ).toEqual({ mode: "serve", resetOnExit: false, preserveFunnel: true });
  });

  it("preserves explicit serviceName overrides", () => {
    expect(
      mergeGatewayTailscaleConfig(
        { mode: "serve", serviceName: "svc:old-openclaw", resetOnExit: false },
        { serviceName: "svc:openclaw" },
      ),
    ).toEqual({ mode: "serve", serviceName: "svc:openclaw", resetOnExit: false });
  });
});

describe("ensureGatewayStartupAuth", () => {
  async function runStartupAuth(
    params: Omit<StartupAuthInput, "env"> & { env?: NodeJS.ProcessEnv },
  ) {
    return ensureGatewayStartupAuth({
      env: emptyEnv(),
      ...params,
    });
  }

  function expectNoGeneratedToken(result: StartupAuthResult) {
    expect(result.generatedToken).toBeUndefined();
    expect(result.persistedGeneratedToken).toBe(false);
  }

  function expectEphemeralGeneratedToken(result: StartupAuthResult) {
    expect(result.generatedToken).toMatch(/^[0-9a-f]{48}$/);
    expect(result.persistedGeneratedToken).toBe(false);
    expect(result.auth.mode).toBe("token");
    expect(result.auth.token).toBe(result.generatedToken);
  }

  function expectResolvedPassword(result: StartupAuthResult, password: string) {
    expectNoGeneratedToken(result);
    expect(result.auth.mode).toBe("password");
    expect(result.auth.password).toBe(password);
  }

  async function expectEphemeralGeneratedTokenWhenOverridden(cfg: OpenClawConfig) {
    const result = await runStartupAuth({
      cfg,
      authOverride: { mode: "token" },
      persist: true,
    });

    expectEphemeralGeneratedToken(result);
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.replaceConfigFile.mockClear();
  });

  async function expectNoTokenGeneration(cfg: OpenClawConfig, mode: string) {
    const result = await runStartupAuth({
      cfg,
      persist: true,
    });

    expectNoGeneratedToken(result);
    expect(result.auth.mode).toBe(mode);
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  }

  async function expectResolvedToken(params: {
    cfg: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    authOverride?: StartupAuthInput["authOverride"];
    expectedToken: string;
    expectedConfiguredToken?: unknown;
  }) {
    const result = await runStartupAuth({
      cfg: params.cfg,
      env: params.env,
      authOverride: params.authOverride,
      persist: true,
    });

    expectNoGeneratedToken(result);
    expect(result.auth.mode).toBe("token");
    expect(result.auth.token).toBe(params.expectedToken);
    if ("expectedConfiguredToken" in params) {
      expect(result.cfg.gateway?.auth?.token).toEqual(params.expectedConfiguredToken);
    }
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  }

  function createMissingGatewayTokenSecretRefConfig(): OpenClawConfig {
    return gatewayAuthConfigWithDefaultEnvProvider({
      mode: "token",
      token: gatewayEnvSecretRef("MISSING_GW_TOKEN"),
    });
  }

  it("generates a runtime token without persisting when startup auth is missing", async () => {
    const result = await runStartupAuth({
      cfg: {},
      persist: true,
    });

    expectEphemeralGeneratedToken(result);
    expect(result.cfg.gateway?.auth?.token).toBe(result.generatedToken);
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("does not generate when token already exists", async () => {
    await expectResolvedToken({
      cfg: gatewayAuthConfig({ mode: "token", token: "configured-token" }),
      env: emptyEnv(),
      expectedToken: "configured-token",
    });
  });

  it("does not generate in password mode", async () => {
    await expectNoTokenGeneration(gatewayAuthConfig({ mode: "password" }), "password");
  });

  it("resolves gateway.auth.password SecretRef before startup auth checks", async () => {
    const configuredPassword = gatewayEnvSecretRef("GW_PASSWORD");
    const result = await runStartupAuth({
      cfg: gatewayAuthConfigWithDefaultEnvProvider({
        mode: "password",
        password: configuredPassword,
      }),
      env: {
        GW_PASSWORD: "resolved-password", // pragma: allowlist secret
      } as NodeJS.ProcessEnv,
      persist: true,
    });

    expectResolvedPassword(result, "resolved-password");
    expect(result.cfg.gateway?.auth?.password).toEqual(configuredPassword);
  });

  it("resolves gateway.auth.token SecretRef before startup auth checks", async () => {
    const configuredToken = gatewayEnvSecretRef("GW_TOKEN");
    await expectResolvedToken({
      cfg: gatewayAuthConfigWithDefaultEnvProvider({
        mode: "token",
        token: configuredToken,
      }),
      env: {
        GW_TOKEN: "resolved-token",
      } as NodeJS.ProcessEnv,
      expectedToken: "resolved-token",
      expectedConfiguredToken: configuredToken,
    });
  });

  it("resolves env-template gateway.auth.token before env-token short-circuiting", async () => {
    await expectResolvedToken({
      cfg: gatewayAuthConfig({ mode: "token", token: "${OPENCLAW_GATEWAY_TOKEN}" }),
      env: {
        OPENCLAW_GATEWAY_TOKEN: "resolved-token",
      } as NodeJS.ProcessEnv,
      expectedToken: "resolved-token",
      expectedConfiguredToken: "${OPENCLAW_GATEWAY_TOKEN}",
    });
  });

  it("uses OPENCLAW_GATEWAY_TOKEN without resolving configured token SecretRef", async () => {
    await expectResolvedToken({
      cfg: createMissingGatewayTokenSecretRefConfig(),
      env: {
        OPENCLAW_GATEWAY_TOKEN: "token-from-env",
      } as NodeJS.ProcessEnv,
      expectedToken: "token-from-env",
    });
  });

  it("fails when gateway.auth.token SecretRef is active and unresolved", async () => {
    await expect(
      runStartupAuth({
        cfg: createMissingGatewayTokenSecretRefConfig(),
        persist: true,
      }),
    ).rejects.toThrow(/MISSING_GW_TOKEN/i);
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("requires explicit gateway.auth.mode when token and password are both configured", async () => {
    await expect(
      runStartupAuth({
        cfg: gatewayAuthConfig({
          token: "configured-token",
          password: "configured-password", // pragma: allowlist secret
        }),
        persist: true,
      }),
    ).rejects.toThrow(/gateway\.auth\.mode is unset/i);
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("uses OPENCLAW_GATEWAY_PASSWORD without resolving configured password SecretRef", async () => {
    const result = await runStartupAuth({
      cfg: gatewayAuthConfigWithDefaultEnvProvider({
        mode: "password",
        password: gatewayEnvSecretRef("MISSING_GW_PASSWORD"),
      }),
      env: {
        OPENCLAW_GATEWAY_PASSWORD: "password-from-env", // pragma: allowlist secret
      } as NodeJS.ProcessEnv,
      persist: true,
    });

    expectResolvedPassword(result, "password-from-env");
  });

  it("does not resolve gateway.auth.password SecretRef when token mode is explicit", async () => {
    const cfg = gatewayAuthConfigWithDefaultEnvProvider({
      mode: "token",
      token: "configured-token",
      password: { source: "env", provider: "missing", id: "GW_PASSWORD" },
    });

    await expectResolvedToken({
      cfg,
      env: emptyEnv(),
      expectedToken: "configured-token",
    });
  });

  it("does not generate in trusted-proxy mode", async () => {
    await expectNoTokenGeneration(
      {
        gateway: {
          auth: {
            mode: "trusted-proxy",
            trustedProxy: { userHeader: "x-forwarded-user" },
          },
        },
      },
      "trusted-proxy",
    );
  });

  it("does not generate in explicit none mode", async () => {
    await expectNoTokenGeneration(
      {
        gateway: {
          auth: {
            mode: "none",
          },
        },
      },
      "none",
    );
  });

  it("treats undefined token override as no override", async () => {
    await expectResolvedToken({
      cfg: {
        gateway: {
          auth: {
            mode: "token",
            token: "from-config",
          },
        },
      },
      env: emptyEnv(),
      authOverride: { mode: "token", token: undefined },
      expectedToken: "from-config",
    });
  });

  it("keeps generated token ephemeral when runtime override flips explicit non-token mode", async () => {
    await expectEphemeralGeneratedTokenWhenOverridden({
      gateway: {
        auth: {
          mode: "password",
        },
      },
    });
  });

  it("keeps generated token ephemeral when runtime override flips explicit none mode", async () => {
    await expectEphemeralGeneratedTokenWhenOverridden({
      gateway: {
        auth: {
          mode: "none",
        },
      },
    });
  });

  it("keeps generated token ephemeral when runtime override flips implicit password mode", async () => {
    await expectEphemeralGeneratedTokenWhenOverridden({
      gateway: {
        auth: {
          password: "configured-password", // pragma: allowlist secret
        },
      },
    });
  });

  it("throws when hooks token reuses gateway token resolved from env", async () => {
    await expect(
      runStartupAuth({
        cfg: {
          hooks: {
            enabled: true,
            token: "shared-gateway-token-1234567890",
          },
        },
        env: {
          OPENCLAW_GATEWAY_TOKEN: "shared-gateway-token-1234567890",
        } as NodeJS.ProcessEnv,
      }),
    ).rejects.toThrow(/hooks\.token must not match gateway auth token/i);
  });

  it("does not block startup when hooks token reuses gateway password auth", async () => {
    const result = await runStartupAuth({
      cfg: {
        hooks: {
          enabled: true,
          token: "shared-gateway-password-1234567890",
        },
        gateway: {
          auth: {
            mode: "password",
            password: "shared-gateway-password-1234567890", // pragma: allowlist secret
          },
        },
      },
    });

    expect(result.auth.mode).toBe("password");
    expectNoGeneratedToken(result);
  });

  it.each(KNOWN_WEAK_GATEWAY_TOKEN_PLACEHOLDERS)(
    "rejects the published placeholder token %s supplied via environment",
    async (token) => {
      await expect(
        runStartupAuth({
          cfg: {},
          env: {
            OPENCLAW_GATEWAY_TOKEN: token,
          } as NodeJS.ProcessEnv,
        }),
      ).rejects.toThrow(/example placeholder/i);
      expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    },
  );

  it.each(KNOWN_WEAK_GATEWAY_TOKEN_PLACEHOLDERS)(
    "rejects the published placeholder token %s supplied via config",
    async (token) => {
      await expect(
        runStartupAuth({
          cfg: gatewayAuthConfig({ mode: "token", token }),
        }),
      ).rejects.toThrow(/example placeholder/i);
      expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    },
  );

  it("rejects the .env.example placeholder password supplied via config", async () => {
    await expect(
      runStartupAuth({
        cfg: gatewayAuthConfig({
          mode: "password",
          password: "change-me-to-a-strong-password", // pragma: allowlist secret
        }),
      }),
    ).rejects.toThrow(/example placeholder/i);
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("accepts any non-placeholder token (negative control)", async () => {
    await expectResolvedToken({
      cfg: gatewayAuthConfig({ mode: "token", token: "a-legit-random-token-0123456789abcdef" }),
      env: emptyEnv(),
      expectedToken: "a-legit-random-token-0123456789abcdef",
    });
  });
});

describe("assertGatewayAuthNotKnownWeak", () => {
  function expectKnownWeakAuthRejected(auth: GatewayAuthCheck) {
    expect(() => assertGatewayAuthNotKnownWeak(auth)).toThrow(/example placeholder/i);
  }

  function expectGatewayAuthAllowed(auth: GatewayAuthCheck) {
    expect(assertGatewayAuthNotKnownWeak(auth)).toBeUndefined();
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.replaceConfigFile.mockClear();
  });

  it.each(KNOWN_WEAK_GATEWAY_TOKEN_PLACEHOLDERS)(
    "throws on the known-weak token sentinel %s",
    (token) => {
      expectKnownWeakAuthRejected({
        mode: "token",
        modeSource: "config",
        token,
        allowTailscale: false,
      });
    },
  );

  it("throws on the known-weak password sentinel", () => {
    expectKnownWeakAuthRejected({
      mode: "password",
      modeSource: "config",
      password: "change-me-to-a-strong-password", // pragma: allowlist secret
      allowTailscale: false,
    });
  });

  it.each(KNOWN_WEAK_GATEWAY_TOKEN_PLACEHOLDERS)(
    "rejects whitespace-padded placeholder token %s after trimming",
    (token) => {
      expectKnownWeakAuthRejected({
        mode: "token",
        modeSource: "config",
        token: `  ${token}  `,
        allowTailscale: false,
      });
    },
  );

  it("allows an empty token to fall through to generation path", () => {
    expectGatewayAuthAllowed({
      mode: "token",
      modeSource: "config",
      token: "",
      allowTailscale: false,
    });
  });

  it("allows a real token", () => {
    expectGatewayAuthAllowed({
      mode: "token",
      modeSource: "config",
      token: "a-legit-random-token-0123456789abcdef",
      allowTailscale: false,
    });
  });

  it("allows the none mode", () => {
    expectGatewayAuthAllowed({
      mode: "none",
      modeSource: "default",
      allowTailscale: false,
    });
  });
});

describe("assertHooksTokenSeparateFromGatewayAuth", () => {
  function expectHooksGatewayAuthAllowed(params: {
    enabled?: boolean;
    hooksToken: string;
    auth: HooksGatewayAuthCheck;
  }) {
    expect(
      assertHooksTokenSeparateFromGatewayAuth({
        cfg: {
          hooks: {
            enabled: params.enabled ?? true,
            token: params.hooksToken,
          },
        },
        auth: params.auth,
      }),
    ).toBeUndefined();
  }

  it("throws when hooks token reuses gateway token auth", () => {
    expect(() =>
      assertHooksTokenSeparateFromGatewayAuth({
        cfg: {
          hooks: {
            enabled: true,
            token: "shared-gateway-token-1234567890",
          },
        },
        auth: {
          mode: "token",
          modeSource: "config",
          token: "shared-gateway-token-1234567890",
          allowTailscale: false,
        },
      }),
    ).toThrow(/hooks\.token must not match gateway auth token/i);
  });

  it("allows hooks token reuse of gateway password auth", () => {
    expectHooksGatewayAuthAllowed({
      hooksToken: "shared-gateway-password-1234567890",
      auth: {
        mode: "password",
        modeSource: "config",
        password: "shared-gateway-password-1234567890", // pragma: allowlist secret
        allowTailscale: false,
      },
    });
  });

  it("allows hooks token reuse of trusted-proxy local password fallback", () => {
    expectHooksGatewayAuthAllowed({
      hooksToken: "trusted-proxy-local-password-1234567890",
      auth: {
        mode: "trusted-proxy",
        modeSource: "config",
        trustedProxy: { userHeader: "x-forwarded-user" },
        password: "trusted-proxy-local-password-1234567890", // pragma: allowlist secret
        allowTailscale: false,
      },
    });
  });

  it("allows distinct hooks token when gateway auth is password mode", () => {
    expectHooksGatewayAuthAllowed({
      hooksToken: "hook-token-1234567890",
      auth: {
        mode: "password",
        modeSource: "config",
        password: "gateway-password-1234567890", // pragma: allowlist secret
        allowTailscale: false,
      },
    });
  });

  it("allows matching values when hooks are disabled", () => {
    expectHooksGatewayAuthAllowed({
      enabled: false,
      hooksToken: "shared-gateway-token-1234567890",
      auth: {
        mode: "token",
        modeSource: "config",
        token: "shared-gateway-token-1234567890",
        allowTailscale: false,
      },
    });
  });
});
