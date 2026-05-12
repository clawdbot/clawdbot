import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { expectGeneratedTokenPersistedToGatewayAuth } from "../../test-support.js";
import type { OpenClawConfig } from "../config/config.js";

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn<() => OpenClawConfig>(),
  writeConfigFile: vi.fn<(cfg: OpenClawConfig) => Promise<void>>(async (_cfg) => {}),
  replaceConfigFile: vi.fn(async ({ nextConfig }: { nextConfig: OpenClawConfig }) => {
    await mocks.writeConfigFile(nextConfig);
  }),
  resolveGatewayAuth: vi.fn(
    ({
      authConfig,
    }: {
      authConfig?: NonNullable<NonNullable<OpenClawConfig["gateway"]>["auth"]>;
    }) => {
      const token =
        typeof authConfig?.token === "string"
          ? authConfig.token
          : typeof authConfig?.token === "object"
            ? undefined
            : undefined;
      const password = typeof authConfig?.password === "string" ? authConfig.password : undefined;
      const mode = authConfig?.mode ?? (password ? "password" : token ? "token" : "token");
      return {
        mode,
        token,
        password,
      };
    },
  ),
  ensureGatewayStartupAuth: vi.fn(async ({ cfg }: { cfg: OpenClawConfig }) => ({
    cfg: {
      ...cfg,
      gateway: {
        ...cfg.gateway,
        auth: {
          ...cfg.gateway?.auth,
          mode: "token" as const,
          token: "a".repeat(48),
        },
      },
    },
    auth: {
      mode: "token" as const,
      token: "a".repeat(48),
    },
    generatedToken: "a".repeat(48),
    persistedGeneratedToken: true,
  })),
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
  replaceConfigFile: mocks.replaceConfigFile,
}));

vi.mock("../gateway/startup-auth.js", () => ({
  ensureGatewayStartupAuth: mocks.ensureGatewayStartupAuth,
}));

vi.mock("../gateway/auth.js", () => ({
  resolveGatewayAuth: mocks.resolveGatewayAuth,
}));

function readPersistedConfig(): OpenClawConfig {
  const [call] = mocks.writeConfigFile.mock.calls;
  if (!call) {
    throw new Error("expected persisted config write");
  }
  const [persistedCfg] = call;
  if (!persistedCfg) {
    throw new Error("expected persisted config");
  }
  return persistedCfg;
}

async function expectGeneratedBrowserAuthPersistence(params: {
  cfg: OpenClawConfig;
  mode: "none" | "trusted-proxy";
  generatedAuthField: "token" | "password";
}) {
  mocks.getRuntimeConfig.mockReturnValue(params.cfg);

  const result = await ensureBrowserControlAuth({ cfg: params.cfg, env: {} as NodeJS.ProcessEnv });

  expect(result.generatedToken).toMatch(/^[a-f0-9]{48}$/);
  expect(result.auth[params.generatedAuthField]).toBe(result.generatedToken);
  expect(result.auth[params.generatedAuthField === "token" ? "password" : "token"]).toBeUndefined();
  expect(mocks.writeConfigFile).toHaveBeenCalledTimes(1);
  const persistedCfg = readPersistedConfig();
  expect(persistedCfg?.gateway?.auth?.mode).toBe(params.mode);
  expect(persistedCfg?.gateway?.auth?.[params.generatedAuthField]).toBe(result.generatedToken);
  expect(mocks.ensureGatewayStartupAuth).not.toHaveBeenCalled();
}

async function expectUnresolvedBrowserSecretRefSkipsPersistence(cfg: OpenClawConfig) {
  mocks.getRuntimeConfig.mockReturnValue(cfg);

  const result = await ensureBrowserControlAuth({ cfg, env: {} as NodeJS.ProcessEnv });

  expect(result).toEqual({ auth: {} });
  expect(mocks.writeConfigFile).not.toHaveBeenCalled();
  expect(mocks.ensureGatewayStartupAuth).not.toHaveBeenCalled();
}

let ensureBrowserControlAuth: typeof import("./control-auth.js").ensureBrowserControlAuth;
let resolveBrowserControlAuth: typeof import("./control-auth.js").resolveBrowserControlAuth;

describe("ensureBrowserControlAuth", () => {
  const expectExplicitModeSkipsAutoAuth = async (mode: "password") => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: { mode },
      },
      browser: {
        enabled: true,
      },
    };

    const result = await ensureBrowserControlAuth({ cfg, env: {} as NodeJS.ProcessEnv });
    expect(result).toEqual({ auth: {} });
    expect(mocks.getRuntimeConfig).not.toHaveBeenCalled();
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
    expect(mocks.ensureGatewayStartupAuth).not.toHaveBeenCalled();
  };

  const expectGeneratedTokenPersisted = async (result: {
    generatedToken?: string;
    auth: { token?: string };
  }) => {
    expect(mocks.ensureGatewayStartupAuth).toHaveBeenCalledTimes(1);
    const ensured = await mocks.ensureGatewayStartupAuth.mock.results[0]?.value;
    expectGeneratedTokenPersistedToGatewayAuth({
      generatedToken: result.generatedToken,
      authToken: result.auth.token,
      persistedConfig: ensured?.cfg,
    });
  };

  beforeAll(async () => {
    ({ ensureBrowserControlAuth, resolveBrowserControlAuth } = await import("./control-auth.js"));
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.getRuntimeConfig.mockClear();
    mocks.writeConfigFile.mockClear();
    mocks.resolveGatewayAuth.mockClear();
    mocks.ensureGatewayStartupAuth.mockClear();
  });

  it("returns existing auth and skips writes", async () => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          token: "already-set",
        },
      },
    };

    const result = await ensureBrowserControlAuth({ cfg, env: {} as NodeJS.ProcessEnv });

    expect(result).toEqual({ auth: { token: "already-set" } });
    expect(mocks.getRuntimeConfig).not.toHaveBeenCalled();
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
    expect(mocks.ensureGatewayStartupAuth).not.toHaveBeenCalled();
  });

  it("returns only the active credential in password mode", () => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          mode: "password",
          token: "inactive-token",
          password: "active-password",
        },
      },
    };

    expect(resolveBrowserControlAuth(cfg, {} as NodeJS.ProcessEnv)).toEqual({
      password: "active-password",
    });
  });

  it("returns only the resolved active credential when mode is inferred", () => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          token: "inactive-token",
          password: "active-password",
        },
      },
    };

    expect(resolveBrowserControlAuth(cfg, {} as NodeJS.ProcessEnv)).toEqual({
      password: "active-password",
    });
  });

  it("returns only the browser token in none mode", () => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          mode: "none",
          token: "browser-token",
          password: "inactive-password",
        },
      },
    };

    expect(resolveBrowserControlAuth(cfg, {} as NodeJS.ProcessEnv)).toEqual({
      token: "browser-token",
    });
  });

  it("returns only the active token in token mode", () => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          mode: "token",
          token: "active-token",
          password: "inactive-password",
        },
      },
    };

    expect(resolveBrowserControlAuth(cfg, {} as NodeJS.ProcessEnv)).toEqual({
      token: "active-token",
    });
  });

  it("returns only the browser password in trusted-proxy mode", () => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          mode: "trusted-proxy",
          token: "inactive-token",
          password: "browser-password",
          trustedProxy: { userHeader: "x-forwarded-user" },
        },
      },
    };

    expect(resolveBrowserControlAuth(cfg, {} as NodeJS.ProcessEnv)).toEqual({
      password: "browser-password",
    });
  });

  it("does not accept an inactive token in trusted-proxy mode", () => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          mode: "trusted-proxy",
          token: "inactive-token",
          trustedProxy: { userHeader: "x-forwarded-user" },
        },
      },
    };

    expect(resolveBrowserControlAuth(cfg, {} as NodeJS.ProcessEnv)).toEqual({});
  });

  it("auto-generates and persists a token when auth is missing", async () => {
    const cfg: OpenClawConfig = {
      browser: {
        enabled: true,
      },
    };
    mocks.getRuntimeConfig.mockReturnValue({
      browser: {
        enabled: true,
      },
    });

    const result = await ensureBrowserControlAuth({ cfg, env: {} as NodeJS.ProcessEnv });
    await expectGeneratedTokenPersisted(result);
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("skips auto-generation in test env", async () => {
    const cfg: OpenClawConfig = {
      browser: {
        enabled: true,
      },
    };

    const result = await ensureBrowserControlAuth({
      cfg,
      env: { NODE_ENV: "test" } as NodeJS.ProcessEnv,
    });

    expect(result).toEqual({ auth: {} });
    expect(mocks.getRuntimeConfig).not.toHaveBeenCalled();
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
    expect(mocks.ensureGatewayStartupAuth).not.toHaveBeenCalled();
  });

  it("respects explicit password mode", async () => {
    await expectExplicitModeSkipsAutoAuth("password");
  });

  it("auto-generates and persists browser auth token in none mode", async () => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: { mode: "none" },
      },
      browser: {
        enabled: true,
      },
    };
    await expectGeneratedBrowserAuthPersistence({
      cfg,
      mode: "none",
      generatedAuthField: "token",
    });
  });

  it("does not persist over unresolved token SecretRef in none mode", async () => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          mode: "none",
          token: { source: "env", provider: "default", id: "BROWSER_TOKEN" },
        },
      },
      browser: {
        enabled: true,
      },
    };
    await expectUnresolvedBrowserSecretRefSkipsPersistence(cfg);
  });

  it("still auto-generates in none mode when only password SecretRef is set", async () => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          mode: "none",
          password: { source: "env", provider: "default", id: "INACTIVE_PASSWORD" },
        },
      },
      browser: {
        enabled: true,
      },
    };
    await expectGeneratedBrowserAuthPersistence({
      cfg,
      mode: "none",
      generatedAuthField: "token",
    });
  });

  it("auto-generates in trusted-proxy mode and persists browser auth password", async () => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: { mode: "trusted-proxy", trustedProxy: { userHeader: "x-forwarded-user" } },
      },
      browser: {
        enabled: true,
      },
    };
    await expectGeneratedBrowserAuthPersistence({
      cfg,
      mode: "trusted-proxy",
      generatedAuthField: "password",
    });
  });

  it("still auto-generates in trusted-proxy mode when only token SecretRef is set", async () => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          mode: "trusted-proxy",
          token: { source: "env", provider: "default", id: "INACTIVE_TOKEN" },
          trustedProxy: { userHeader: "x-forwarded-user" },
        },
      },
      browser: {
        enabled: true,
      },
    };
    await expectGeneratedBrowserAuthPersistence({
      cfg,
      mode: "trusted-proxy",
      generatedAuthField: "password",
    });
  });

  it("does not persist over unresolved password SecretRef in trusted-proxy mode", async () => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          mode: "trusted-proxy",
          password: { source: "env", provider: "default", id: "BROWSER_PASSWORD" },
          trustedProxy: { userHeader: "x-forwarded-user" },
        },
      },
      browser: {
        enabled: true,
      },
    };
    await expectUnresolvedBrowserSecretRefSkipsPersistence(cfg);
  });

  it("reuses auth from latest config snapshot", async () => {
    const cfg: OpenClawConfig = {
      browser: {
        enabled: true,
      },
    };
    mocks.getRuntimeConfig.mockReturnValue({
      gateway: {
        auth: {
          token: "latest-token",
        },
      },
      browser: {
        enabled: true,
      },
    });

    const result = await ensureBrowserControlAuth({ cfg, env: {} as NodeJS.ProcessEnv });

    expect(result).toEqual({ auth: { token: "latest-token" } });
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
    expect(mocks.ensureGatewayStartupAuth).not.toHaveBeenCalled();
  });

  it("fails when gateway.auth.token SecretRef is unresolved", async () => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          mode: "token",
          token: { source: "env", provider: "default", id: "MISSING_GW_TOKEN" },
        },
      },
      browser: {
        enabled: true,
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    };
    mocks.getRuntimeConfig.mockReturnValue(cfg);
    mocks.ensureGatewayStartupAuth.mockRejectedValueOnce(new Error("MISSING_GW_TOKEN"));

    await expect(ensureBrowserControlAuth({ cfg, env: {} as NodeJS.ProcessEnv })).rejects.toThrow(
      /MISSING_GW_TOKEN/i,
    );
    expect(mocks.ensureGatewayStartupAuth).toHaveBeenCalledTimes(1);
  });
});
