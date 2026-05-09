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

describe("mergeGatewayTailscaleConfig", () => {
  it("preserves explicit preserveFunnel overrides", () => {
    expect(
      mergeGatewayTailscaleConfig(
        { mode: "serve", resetOnExit: false, preserveFunnel: false },
        { preserveFunnel: true },
      ),
    ).toEqual({ mode: "serve", resetOnExit: false, preserveFunnel: true });
  });
});

describe("ensureGatewayStartupAuth", () => {
  async function expectEphemeralGeneratedTokenWhenOverridden(cfg: OpenClawConfig) {
    const result = await ensureGatewayStartupAuth({
      cfg,
      env: {} as NodeJS.ProcessEnv,
      authOverride: { mode: "token" },
      persist: true,
    });

    expect(result.generatedToken).toMatch(/^[0-9a-f]{48}$/);
    expect(result.persistedGeneratedToken).toBe(false);
    expect(result.auth.mode).toBe("token");
    expect(result.auth.token).toBe(result.generatedToken);
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.replaceConfigFile.mockClear();
  });

  async function expectNoTokenGeneration(cfg: OpenClawConfig, mode: string) {
    const result = await ensureGatewayStartupAuth({
      cfg,
      env: {} as NodeJS.ProcessEnv,
      persist: true,
    });

    expect(result.generatedToken).toBeUndefined();
    expect(result.persistedGeneratedToken).toBe(false);
    expect(result.auth.mode).toBe(mode);
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  }

  async function expectResolvedToken(params: {
    cfg: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    expectedToken: string;
    expectedConfiguredToken?: unknown;
  }) {
    const result = await ensureGatewayStartupAuth({
      cfg: params.cfg,
      env: params.env,
      persist: true,
    });

    expect(result.generatedToken).toBeUndefined();
    expect(result.persistedGeneratedToken).toBe(false);
    expect(result.auth.mode).toBe("token");
    expect(result.auth.token).toBe(params.expectedToken);
    if ("expectedConfiguredToken" in params) {
      expect(result.cfg.gateway?.auth?.token).toEqual(params.expectedConfiguredToken);
    }
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  }

  function createMissingGatewayTokenSecretRefConfig(): OpenClawConfig {
    return {
      gateway: {
        auth: {
          mode: "token",
          token: { source: "env", provider: "default", id: "MISSING_GW_TOKEN" },
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    };
  }

  it("generates a runtime token without persisting when startup auth is missing", async () => {
    const result = await ensureGatewayStartupAuth({
      cfg: {},
      env: {} as NodeJS.ProcessEnv,
      persist: true,
    });

    expect(result.generatedToken).toMatch(/^[0-9a-f]{48}$/);
    expect(result.persistedGeneratedToken).toBe(false);
    expect(result.auth.mode).toBe("token");
    expect(result.auth.token).toBe(result.generatedToken);
    expect(result.cfg.gateway?.auth?.token).toBe(result.generatedToken);
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("does not generate when token already exists", async () => {
    await expectResolvedToken({
      cfg: {
        gateway: {
          auth: {
            mode: "token",
            token: "configured-token",
          },
        },
      },
      env: {} as NodeJS.ProcessEnv,
      expectedToken: "configured-token",
    });
  });

  it("does not generate in password mode", async () => {
    await expectNoTokenGeneration(
      {
        gateway: {
          auth: {
            mode: "password",
          },
        },
      },
      "password",
    );
  });

  it("resolves gateway.auth.password SecretRef before startup auth checks", async () => {
    const result = await ensureGatewayStartupAuth({
      cfg: {
        gateway: {
          auth: {
            mode: "password",
            password: { source: "env", provider: "default", id: "GW_PASSWORD" },
          },
        },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      },
      env: {
        GW_PASSWORD: "resolved-password", // pragma: allowlist secret
      } as NodeJS.ProcessEnv,
      persist: true,
    });

    expect(result.generatedToken).toBeUndefined();
    expect(result.auth.mode).toBe("password");
    expect(result.auth.password).toBe("resolved-password");
    expect(result.cfg.gateway?.auth?.password).toEqual({
      source: "env",
      provider: "default",
      id: "GW_PASSWORD",
    });
  });

  it("resolves gateway.auth.token SecretRef before startup auth checks", async () => {
    await expectResolvedToken({
      cfg: {
        gateway: {
          auth: {
            mode: "token",
            token: { source: "env", provider: "default", id: "GW_TOKEN" },
          },
        },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      },
      env: {
        GW_TOKEN: "resolved-token",
      } as NodeJS.ProcessEnv,
      expectedToken: "resolved-token",
      expectedConfiguredToken: {
        source: "env",
        provider: "default",
        id: "GW_TOKEN",
      },
    });
  });

  it("resolves env-template gateway.auth.token before env-token short-circuiting", async () => {
    await expectResolvedToken({
      cfg: {
        gateway: {
          auth: {
            mode: "token",
            token: "${OPENCLAW_GATEWAY_TOKEN}",
          },
        },
      },
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
      ensureGatewayStartupAuth({
        cfg: createMissingGatewayTokenSecretRefConfig(),
        env: {} as NodeJS.ProcessEnv,
        persist: true,
      }),
    ).rejects.toThrow(/MISSING_GW_TOKEN/i);
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("requires explicit gateway.auth.mode when token and password are both configured", async () => {
    await expect(
      ensureGatewayStartupAuth({
        cfg: {
          gateway: {
            auth: {
              token: "configured-token",
              password: "configured-password", // pragma: allowlist secret
            },
          },
        },
        env: {} as NodeJS.ProcessEnv,
        persist: true,
      }),
    ).rejects.toThrow(/gateway\.auth\.mode is unset/i);
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("uses OPENCLAW_GATEWAY_PASSWORD without resolving configured password SecretRef", async () => {
    const result = await ensureGatewayStartupAuth({
      cfg: {
        gateway: {
          auth: {
            mode: "password",
            password: { source: "env", provider: "default", id: "MISSING_GW_PASSWORD" },
          },
        },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      },
      env: {
        OPENCLAW_GATEWAY_PASSWORD: "password-from-env", // pragma: allowlist secret
      } as NodeJS.ProcessEnv,
      persist: true,
    });

    expect(result.generatedToken).toBeUndefined();
    expect(result.auth.mode).toBe("password");
    expect(result.auth.password).toBe("password-from-env");
  });

  it("does not resolve gateway.auth.password SecretRef when token mode is explicit", async () => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          mode: "token",
          token: "configured-token",
          password: { source: "env", provider: "missing", id: "GW_PASSWORD" },
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    };

    const result = await ensureGatewayStartupAuth({
      cfg,
      env: {} as NodeJS.ProcessEnv,
      persist: true,
    });

    expect(result.generatedToken).toBeUndefined();
    expect(result.auth.mode).toBe("token");
    expect(result.auth.token).toBe("configured-token");
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
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          mode: "token",
          token: "from-config",
        },
      },
    };
    const result = await ensureGatewayStartupAuth({
      cfg,
      env: {} as NodeJS.ProcessEnv,
      authOverride: { mode: "token", token: undefined },
      persist: true,
    });

    expect(result.generatedToken).toBeUndefined();
    expect(result.persistedGeneratedToken).toBe(false);
    expect(result.auth.mode).toBe("token");
    expect(result.auth.token).toBe("from-config");
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
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
      ensureGatewayStartupAuth({
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

  it.each(KNOWN_WEAK_GATEWAY_TOKEN_PLACEHOLDERS)(
    "rejects the published placeholder token %s supplied via environment",
    async (token) => {
      await expect(
        ensureGatewayStartupAuth({
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
        ensureGatewayStartupAuth({
          cfg: {
            gateway: {
              auth: {
                mode: "token",
                token,
              },
            },
          },
          env: {} as NodeJS.ProcessEnv,
        }),
      ).rejects.toThrow(/example placeholder/i);
      expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    },
  );

  it("rejects the .env.example placeholder password supplied via config", async () => {
    await expect(
      ensureGatewayStartupAuth({
        cfg: {
          gateway: {
            auth: {
              mode: "password",
              password: "change-me-to-a-strong-password", // pragma: allowlist secret
            },
          },
        },
        env: {} as NodeJS.ProcessEnv,
      }),
    ).rejects.toThrow(/example placeholder/i);
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("accepts any non-placeholder token (negative control)", async () => {
    await expectResolvedToken({
      cfg: {
        gateway: {
          auth: {
            mode: "token",
            token: "a-legit-random-token-0123456789abcdef",
          },
        },
      },
      env: {} as NodeJS.ProcessEnv,
      expectedToken: "a-legit-random-token-0123456789abcdef",
    });
  });
});

describe("assertGatewayAuthNotKnownWeak", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.replaceConfigFile.mockClear();
  });

  it.each(KNOWN_WEAK_GATEWAY_TOKEN_PLACEHOLDERS)(
    "throws on the known-weak token sentinel %s",
    (token) => {
      expect(() =>
        assertGatewayAuthNotKnownWeak({
          mode: "token",
          modeSource: "config",
          token,
          allowTailscale: false,
        }),
      ).toThrow(/example placeholder/i);
    },
  );

  it("throws on the known-weak password sentinel", () => {
    expect(() =>
      assertGatewayAuthNotKnownWeak({
        mode: "password",
        modeSource: "config",
        password: "change-me-to-a-strong-password", // pragma: allowlist secret
        allowTailscale: false,
      }),
    ).toThrow(/example placeholder/i);
  });

  it.each(KNOWN_WEAK_GATEWAY_TOKEN_PLACEHOLDERS)(
    "rejects whitespace-padded placeholder token %s after trimming",
    (token) => {
      expect(() =>
        assertGatewayAuthNotKnownWeak({
          mode: "token",
          modeSource: "config",
          token: `  ${token}  `,
          allowTailscale: false,
        }),
      ).toThrow(/example placeholder/i);
    },
  );

  it("allows an empty token to fall through to generation path", () => {
    expect(
      assertGatewayAuthNotKnownWeak({
        mode: "token",
        modeSource: "config",
        token: "",
        allowTailscale: false,
      }),
    ).toBeUndefined();
  });

  it("allows a real token", () => {
    expect(
      assertGatewayAuthNotKnownWeak({
        mode: "token",
        modeSource: "config",
        token: "a-legit-random-token-0123456789abcdef",
        allowTailscale: false,
      }),
    ).toBeUndefined();
  });

  it("allows the none mode", () => {
    expect(
      assertGatewayAuthNotKnownWeak({
        mode: "none",
        modeSource: "default",
        allowTailscale: false,
      }),
    ).toBeUndefined();
  });
});

describe("assertHooksTokenSeparateFromGatewayAuth", () => {
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

  it("allows hooks token when gateway auth is not token mode", () => {
    expect(
      assertHooksTokenSeparateFromGatewayAuth({
        cfg: {
          hooks: {
            enabled: true,
            token: "shared-gateway-token-1234567890",
          },
        },
        auth: {
          mode: "password",
          modeSource: "config",
          password: "pw", // pragma: allowlist secret
          allowTailscale: false,
        },
      }),
    ).toBeUndefined();
  });

  it("allows matching values when hooks are disabled", () => {
    expect(
      assertHooksTokenSeparateFromGatewayAuth({
        cfg: {
          hooks: {
            enabled: false,
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
    ).toBeUndefined();
  });
});
