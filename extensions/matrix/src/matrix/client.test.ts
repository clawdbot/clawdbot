import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LookupFn } from "../../runtime-api.js";
import { installMatrixTestRuntime } from "../test-runtime.js";
import type { CoreConfig } from "../types.js";

function createLookupFn(addresses: Array<{ address: string; family: number }>): LookupFn {
  return vi.fn(async (_hostname: string, options?: unknown) => {
    if (typeof options === "number" || !options || !(options as { all?: boolean }).all) {
      return addresses[0];
    }
    return addresses;
  }) as unknown as LookupFn;
}

const saveMatrixCredentialsMock = vi.hoisted(() => vi.fn());
const saveBackfilledMatrixDeviceIdMock = vi.hoisted(() => vi.fn(async () => "saved"));
const touchMatrixCredentialsMock = vi.hoisted(() => vi.fn());
const repairCurrentTokenStorageMetaDeviceIdMock = vi.hoisted(() => vi.fn());

vi.mock("./credentials-read.js", () => ({
  loadMatrixCredentials: vi.fn(() => null),
  credentialsMatchConfig: vi.fn(() => false),
}));

vi.mock("./credentials-write.runtime.js", () => ({
  saveBackfilledMatrixDeviceId: saveBackfilledMatrixDeviceIdMock,
  saveMatrixCredentials: saveMatrixCredentialsMock,
  touchMatrixCredentials: touchMatrixCredentialsMock,
}));

vi.mock("./client/storage.js", async () => {
  const actual = await vi.importActual<typeof import("./client/storage.js")>("./client/storage.js");
  return {
    ...actual,
    repairCurrentTokenStorageMetaDeviceId: repairCurrentTokenStorageMetaDeviceIdMock,
  };
});

const {
  backfillMatrixAuthDeviceIdAfterStartup,
  getMatrixScopedEnvVarNames,
  resolveMatrixConfigForAccount,
  resolveMatrixAuth,
  resolveMatrixAuthContext,
  setMatrixAuthClientDepsForTest,
  resolveValidatedMatrixHomeserverUrl,
  validateMatrixHomeserverUrl,
} = await import("./client/config.js");

let credentialsReadModule: typeof import("./credentials-read.js") | undefined;
const ensureMatrixSdkLoggingConfiguredMock = vi.fn();
const matrixDoRequestMock = vi.fn();

class MockMatrixClient {
  async doRequest(...args: unknown[]) {
    return await matrixDoRequestMock(...args);
  }
}

function requireCredentialsReadModule(): typeof import("./credentials-read.js") {
  if (!credentialsReadModule) {
    throw new Error("credentials-read test module not initialized");
  }
  return credentialsReadModule;
}

function resolveDefaultMatrixAuthContext(
  cfg: CoreConfig,
  env: NodeJS.ProcessEnv = {} as NodeJS.ProcessEnv,
) {
  return resolveMatrixAuthContext({ cfg, env });
}

beforeEach(() => {
  installMatrixTestRuntime();
});

describe("Matrix auth/config live surfaces", () => {
  it("prefers config over env", () => {
    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://cfg.example.org",
          userId: "@cfg:example.org",
          accessToken: "cfg-token",
          password: "cfg-pass",
          deviceName: "CfgDevice",
          initialSyncLimit: 5,
        },
      },
    } as CoreConfig;
    const env = {
      MATRIX_HOMESERVER: "https://env.example.org",
      MATRIX_USER_ID: "@env:example.org",
      MATRIX_ACCESS_TOKEN: "env-token",
      MATRIX_PASSWORD: "env-pass",
      MATRIX_DEVICE_NAME: "EnvDevice",
    } as NodeJS.ProcessEnv;
    const resolved = resolveDefaultMatrixAuthContext(cfg, env).resolved;
    expect(resolved).toEqual({
      homeserver: "https://cfg.example.org",
      userId: "@cfg:example.org",
      accessToken: "cfg-token",
      password: "cfg-pass",
      deviceId: undefined,
      deviceName: "CfgDevice",
      initialSyncLimit: 5,
      encryption: false,
    });
  });

  it("uses env when config is missing", () => {
    const cfg = {} as CoreConfig;
    const env = {
      MATRIX_HOMESERVER: "https://env.example.org",
      MATRIX_USER_ID: "@env:example.org",
      MATRIX_ACCESS_TOKEN: "env-token",
      MATRIX_PASSWORD: "env-pass",
      MATRIX_DEVICE_ID: "ENVDEVICE",
      MATRIX_DEVICE_NAME: "EnvDevice",
    } as NodeJS.ProcessEnv;
    const resolved = resolveDefaultMatrixAuthContext(cfg, env).resolved;
    expect(resolved.homeserver).toBe("https://env.example.org");
    expect(resolved.userId).toBe("@env:example.org");
    expect(resolved.accessToken).toBe("env-token");
    expect(resolved.password).toBe("env-pass");
    expect(resolved.deviceId).toBe("ENVDEVICE");
    expect(resolved.deviceName).toBe("EnvDevice");
    expect(resolved.initialSyncLimit).toBeUndefined();
    expect(resolved.encryption).toBe(false);
  });

  it("resolves accessToken SecretRef against the provided env", () => {
    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://cfg.example.org",
          accessToken: { source: "env", provider: "default", id: "MATRIX_ACCESS_TOKEN" },
        },
      },
      secrets: {
        defaults: {
          env: "default",
        },
      },
    } as CoreConfig;
    const env = {
      MATRIX_ACCESS_TOKEN: "env-token",
    } as NodeJS.ProcessEnv;

    const resolved = resolveDefaultMatrixAuthContext(cfg, env).resolved;
    expect(resolved.accessToken).toBe("env-token");
  });

  it("resolves password SecretRef against the provided env", () => {
    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://cfg.example.org",
          userId: "@cfg:example.org",
          password: { source: "env", provider: "default", id: "MATRIX_PASSWORD" },
        },
      },
      secrets: {
        defaults: {
          env: "default",
        },
      },
    } as CoreConfig;
    const env = {
      MATRIX_PASSWORD: "env-pass",
    } as NodeJS.ProcessEnv;

    const resolved = resolveDefaultMatrixAuthContext(cfg, env).resolved;
    expect(resolved.password).toBe("env-pass");
  });

  it("resolves account accessToken SecretRef against the provided env", () => {
    const cfg = {
      channels: {
        matrix: {
          accounts: {
            ops: {
              homeserver: "https://ops.example.org",
              accessToken: { source: "env", provider: "default", id: "MATRIX_OPS_ACCESS_TOKEN" },
            },
          },
        },
      },
      secrets: {
        defaults: {
          env: "default",
        },
      },
    } as CoreConfig;
    const env = {
      MATRIX_OPS_ACCESS_TOKEN: "ops-token",
    } as NodeJS.ProcessEnv;

    const resolved = resolveMatrixConfigForAccount(cfg, "ops", env);
    expect(resolved.accessToken).toBe("ops-token");
  });

  it("does not resolve account password SecretRefs when scoped token auth is configured", () => {
    const cfg = {
      channels: {
        matrix: {
          accounts: {
            ops: {
              homeserver: "https://ops.example.org",
              password: { source: "env", provider: "default", id: "MATRIX_OPS_PASSWORD" },
            },
          },
        },
      },
      secrets: {
        defaults: {
          env: "default",
        },
      },
    } as CoreConfig;
    const env = {
      MATRIX_OPS_ACCESS_TOKEN: "ops-token",
    } as NodeJS.ProcessEnv;

    const resolved = resolveMatrixConfigForAccount(cfg, "ops", env);
    expect(resolved.accessToken).toBe("ops-token");
    expect(resolved.password).toBeUndefined();
  });

  it("keeps unresolved accessToken SecretRef errors when env fallback is missing", () => {
    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://cfg.example.org",
          accessToken: { source: "env", provider: "default", id: "MATRIX_ACCESS_TOKEN" },
        },
      },
      secrets: {
        defaults: {
          env: "default",
        },
      },
    } as CoreConfig;

    expect(() => resolveDefaultMatrixAuthContext(cfg, {} as NodeJS.ProcessEnv)).toThrow(
      /channels\.matrix\.accessToken: unresolved SecretRef "env:default:MATRIX_ACCESS_TOKEN"/i,
    );
  });

  it("does not bypass env provider allowlists during startup fallback", () => {
    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://cfg.example.org",
          accessToken: { source: "env", provider: "matrix-env", id: "MATRIX_ACCESS_TOKEN" },
        },
      },
      secrets: {
        providers: {
          "matrix-env": {
            source: "env",
            allowlist: ["OTHER_MATRIX_ACCESS_TOKEN"],
          },
        },
      },
    } as CoreConfig;

    expect(() =>
      resolveDefaultMatrixAuthContext(cfg, {
        MATRIX_ACCESS_TOKEN: "env-token",
      } as NodeJS.ProcessEnv),
    ).toThrow(/not allowlisted in secrets\.providers\.matrix-env\.allowlist/i);
  });

  it("does not throw when accessToken uses a non-env SecretRef", () => {
    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://cfg.example.org",
          accessToken: { source: "file", provider: "matrix-file", id: "value" },
        },
      },
      secrets: {
        providers: {
          "matrix-file": {
            source: "file",
            path: "/tmp/matrix-token",
          },
        },
      },
    } as CoreConfig;

    expect(
      resolveDefaultMatrixAuthContext(cfg, {} as NodeJS.ProcessEnv).resolved.accessToken,
    ).toBeUndefined();
  });

  it("uses account-scoped env vars for non-default accounts before global env", () => {
    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://base.example.org",
        },
      },
    } as CoreConfig;
    const env = {
      MATRIX_HOMESERVER: "https://global.example.org",
      MATRIX_ACCESS_TOKEN: "global-token",
      MATRIX_OPS_HOMESERVER: "https://ops.example.org",
      MATRIX_OPS_ACCESS_TOKEN: "ops-token",
      MATRIX_OPS_DEVICE_NAME: "Ops Device",
    } as NodeJS.ProcessEnv;

    const resolved = resolveMatrixConfigForAccount(cfg, "ops", env);
    expect(resolved.homeserver).toBe("https://ops.example.org");
    expect(resolved.accessToken).toBe("ops-token");
    expect(resolved.deviceName).toBe("Ops Device");
  });

  it("uses collision-free scoped env var names for normalized account ids", () => {
    expect(getMatrixScopedEnvVarNames("ops-prod").accessToken).toBe(
      "MATRIX_OPS_X2D_PROD_ACCESS_TOKEN",
    );
    expect(getMatrixScopedEnvVarNames("ops_prod").accessToken).toBe(
      "MATRIX_OPS_X5F_PROD_ACCESS_TOKEN",
    );
  });

  it("prefers channels.matrix.accounts.default over global env for the default account", () => {
    const cfg = {
      channels: {
        matrix: {
          accounts: {
            default: {
              homeserver: "https://matrix.gumadeiras.com",
              userId: "@pinguini:matrix.gumadeiras.com",
              password: "cfg-pass", // pragma: allowlist secret
              deviceName: "OpenClaw Gateway Pinguini",
              encryption: true,
            },
          },
        },
      },
    } as CoreConfig;
    const env = {
      MATRIX_HOMESERVER: "https://env.example.org",
      MATRIX_USER_ID: "@env:example.org",
      MATRIX_PASSWORD: "env-pass",
      MATRIX_DEVICE_NAME: "EnvDevice",
    } as NodeJS.ProcessEnv;

    const resolved = resolveMatrixAuthContext({ cfg, env });
    expect(resolved.accountId).toBe("default");
    expect(resolved.resolved).toMatchObject({
      homeserver: "https://matrix.gumadeiras.com",
      userId: "@pinguini:matrix.gumadeiras.com",
      password: "cfg-pass",
      deviceName: "OpenClaw Gateway Pinguini",
      encryption: true,
    });
  });

  it("ignores typoed defaultAccount values that do not map to a real Matrix account", () => {
    const cfg = {
      channels: {
        matrix: {
          defaultAccount: "ops",
          homeserver: "https://legacy.example.org",
          accessToken: "legacy-token",
        },
      },
    } as CoreConfig;

    expect(resolveMatrixAuthContext({ cfg, env: {} as NodeJS.ProcessEnv }).accountId).toBe(
      "default",
    );
  });

  it("requires explicit defaultAccount selection when multiple named Matrix accounts exist", () => {
    const cfg = {
      channels: {
        matrix: {
          accounts: {
            assistant: {
              homeserver: "https://matrix.assistant.example.org",
              accessToken: "assistant-token",
            },
            ops: {
              homeserver: "https://matrix.ops.example.org",
              accessToken: "ops-token",
            },
          },
        },
      },
    } as CoreConfig;

    expect(() => resolveMatrixAuthContext({ cfg, env: {} as NodeJS.ProcessEnv })).toThrow(
      /channels\.matrix\.defaultAccount.*--account <id>/i,
    );
  });

  it('uses a named "default" account implicitly when multiple Matrix accounts exist', () => {
    const cfg = {
      channels: {
        matrix: {
          accounts: {
            default: {
              homeserver: "https://matrix.default.example.org",
              accessToken: "default-token",
            },
            ops: {
              homeserver: "https://matrix.ops.example.org",
              accessToken: "ops-token",
            },
          },
        },
      },
    } as CoreConfig;

    expect(resolveMatrixAuthContext({ cfg, env: {} as NodeJS.ProcessEnv }).accountId).toBe(
      "default",
    );
  });

  it("does not materialize a default account from shared top-level defaults alone", () => {
    const cfg = {
      channels: {
        matrix: {
          name: "Shared Defaults",
          accounts: {
            ops: {
              homeserver: "https://matrix.ops.example.org",
              accessToken: "ops-token",
            },
          },
        },
      },
    } as CoreConfig;

    expect(resolveMatrixAuthContext({ cfg, env: {} as NodeJS.ProcessEnv }).accountId).toBe("ops");
  });

  it("does not materialize a default account from partial top-level auth defaults", () => {
    const cfg = {
      channels: {
        matrix: {
          accessToken: "shared-token",
          accounts: {
            ops: {
              homeserver: "https://matrix.ops.example.org",
              accessToken: "ops-token",
            },
          },
        },
      },
    } as CoreConfig;

    expect(resolveMatrixAuthContext({ cfg, env: {} as NodeJS.ProcessEnv }).accountId).toBe("ops");
  });

  it('uses the injected env-backed "default" Matrix account when implicit selection is available', () => {
    const cfg = {
      channels: {
        matrix: {},
      },
    } as CoreConfig;
    const env = {
      MATRIX_HOMESERVER: "https://matrix.example.org",
      MATRIX_ACCESS_TOKEN: "default-token",
      MATRIX_OPS_HOMESERVER: "https://matrix.example.org",
      MATRIX_OPS_ACCESS_TOKEN: "ops-token",
    } as NodeJS.ProcessEnv;

    expect(resolveMatrixAuthContext({ cfg, env }).accountId).toBe("default");
  });

  it("does not materialize a default env account from partial global auth fields", () => {
    const cfg = {
      channels: {
        matrix: {},
      },
    } as CoreConfig;
    const env = {
      MATRIX_ACCESS_TOKEN: "shared-token",
      MATRIX_OPS_HOMESERVER: "https://matrix.example.org",
      MATRIX_OPS_ACCESS_TOKEN: "ops-token",
    } as NodeJS.ProcessEnv;

    expect(resolveMatrixAuthContext({ cfg, env }).accountId).toBe("ops");
  });

  it("does not materialize a default account from top-level homeserver plus userId alone", () => {
    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          userId: "@default:example.org",
          accounts: {
            ops: {
              homeserver: "https://matrix.example.org",
              accessToken: "ops-token",
            },
          },
        },
      },
    } as CoreConfig;

    expect(resolveMatrixAuthContext({ cfg, env: {} as NodeJS.ProcessEnv }).accountId).toBe("ops");
  });

  it("does not materialize a default env account from global homeserver plus userId alone", () => {
    const cfg = {
      channels: {
        matrix: {},
      },
    } as CoreConfig;
    const env = {
      MATRIX_HOMESERVER: "https://matrix.example.org",
      MATRIX_USER_ID: "@default:example.org",
      MATRIX_OPS_HOMESERVER: "https://matrix.example.org",
      MATRIX_OPS_ACCESS_TOKEN: "ops-token",
    } as NodeJS.ProcessEnv;

    expect(resolveMatrixAuthContext({ cfg, env }).accountId).toBe("ops");
  });

  it("keeps implicit selection for env-backed accounts that can use cached credentials", () => {
    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
        },
      },
    } as CoreConfig;
    const env = {
      MATRIX_OPS_USER_ID: "@ops:example.org",
    } as NodeJS.ProcessEnv;

    expect(resolveMatrixAuthContext({ cfg, env }).accountId).toBe("ops");
  });

  it("rejects explicit non-default account ids that are neither configured nor scoped in env", () => {
    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://legacy.example.org",
          accessToken: "legacy-token",
          accounts: {
            ops: {
              homeserver: "https://ops.example.org",
              accessToken: "ops-token",
            },
          },
        },
      },
    } as CoreConfig;

    expect(() =>
      resolveMatrixAuthContext({ cfg, env: {} as NodeJS.ProcessEnv, accountId: "typo" }),
    ).toThrow(/Matrix account "typo" is not configured/i);
  });

  it("allows explicit non-default account ids backed only by scoped env vars", () => {
    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://legacy.example.org",
          accessToken: "legacy-token",
        },
      },
    } as CoreConfig;
    const env = {
      MATRIX_OPS_HOMESERVER: "https://ops.example.org",
      MATRIX_OPS_ACCESS_TOKEN: "ops-token",
    } as NodeJS.ProcessEnv;

    expect(resolveMatrixAuthContext({ cfg, env, accountId: "ops" }).accountId).toBe("ops");
  });

  it("does not inherit the base deviceId for non-default accounts", () => {
    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://base.example.org",
          accessToken: "base-token",
          deviceId: "BASEDEVICE",
          accounts: {
            ops: {
              homeserver: "https://ops.example.org",
              accessToken: "ops-token",
            },
          },
        },
      },
    } as CoreConfig;

    const resolved = resolveMatrixConfigForAccount(cfg, "ops", {} as NodeJS.ProcessEnv);
    expect(resolved.deviceId).toBeUndefined();
  });

  it("does not inherit the base userId for non-default accounts", () => {
    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://base.example.org",
          userId: "@base:example.org",
          accessToken: "base-token",
          accounts: {
            ops: {
              homeserver: "https://ops.example.org",
              accessToken: "ops-token",
            },
          },
        },
      },
    } as CoreConfig;

    const resolved = resolveMatrixConfigForAccount(cfg, "ops", {} as NodeJS.ProcessEnv);
    expect(resolved.userId).toBe("");
  });

  it("does not inherit base or global auth secrets for non-default accounts", () => {
    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://base.example.org",
          accessToken: "base-token",
          password: "base-pass", // pragma: allowlist secret
          deviceId: "BASEDEVICE",
          accounts: {
            ops: {
              homeserver: "https://ops.example.org",
              userId: "@ops:example.org",
              password: "ops-pass", // pragma: allowlist secret
            },
          },
        },
      },
    } as CoreConfig;
    const env = {
      MATRIX_ACCESS_TOKEN: "global-token",
      MATRIX_PASSWORD: "global-pass",
      MATRIX_DEVICE_ID: "GLOBALDEVICE",
    } as NodeJS.ProcessEnv;

    const resolved = resolveMatrixConfigForAccount(cfg, "ops", env);
    expect(resolved.accessToken).toBeUndefined();
    expect(resolved.password).toBe("ops-pass");
    expect(resolved.deviceId).toBeUndefined();
  });

  it("does not inherit a base password for non-default accounts", () => {
    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://base.example.org",
          password: "base-pass", // pragma: allowlist secret
          accounts: {
            ops: {
              homeserver: "https://ops.example.org",
              userId: "@ops:example.org",
            },
          },
        },
      },
    } as CoreConfig;
    const env = {
      MATRIX_PASSWORD: "global-pass",
    } as NodeJS.ProcessEnv;

    const resolved = resolveMatrixConfigForAccount(cfg, "ops", env);
    expect(resolved.password).toBeUndefined();
  });

  it("rejects insecure public http Matrix homeservers", () => {
    expect(() => validateMatrixHomeserverUrl("http://matrix.example.org")).toThrow(
      "Matrix homeserver must use https:// unless it targets a private or loopback host",
    );
    expect(validateMatrixHomeserverUrl("http://127.0.0.1:8008")).toBe("http://127.0.0.1:8008");
  });

  it("accepts internal http homeservers only when private-network access is enabled", () => {
    expect(() => validateMatrixHomeserverUrl("http://matrix-synapse:8008")).toThrow(
      "Matrix homeserver must use https:// unless it targets a private or loopback host",
    );
    expect(
      validateMatrixHomeserverUrl("http://matrix-synapse:8008", {
        allowPrivateNetwork: true,
      }),
    ).toBe("http://matrix-synapse:8008");
  });

  it("resolves an explicit proxy dispatcher from top-level Matrix config", () => {
    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          accessToken: "tok-123",
          proxy: "http://127.0.0.1:7890",
        },
      },
    } as CoreConfig;

    const resolved = resolveDefaultMatrixAuthContext(cfg, {} as NodeJS.ProcessEnv).resolved;

    expect(resolved.dispatcherPolicy).toEqual({
      mode: "explicit-proxy",
      proxyUrl: "http://127.0.0.1:7890",
    });
  });

  it("prefers account proxy overrides over top-level Matrix proxy config", () => {
    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          accessToken: "base-token",
          proxy: "http://127.0.0.1:7890",
          accounts: {
            ops: {
              homeserver: "https://matrix.ops.example.org",
              accessToken: "ops-token",
              proxy: "http://127.0.0.1:7891",
            },
          },
        },
      },
    } as CoreConfig;

    const resolved = resolveMatrixConfigForAccount(cfg, "ops", {} as NodeJS.ProcessEnv);

    expect(resolved.dispatcherPolicy).toEqual({
      mode: "explicit-proxy",
      proxyUrl: "http://127.0.0.1:7891",
    });
  });

  it("rejects public http homeservers even when private-network access is enabled", async () => {
    await expect(
      resolveValidatedMatrixHomeserverUrl("http://matrix.example.org:8008", {
        allowPrivateNetwork: true,
        lookupFn: createLookupFn([{ address: "93.184.216.34", family: 4 }]),
      }),
    ).rejects.toThrow(
      "Matrix homeserver must use https:// unless it targets a private or loopback host",
    );
  });

  it("accepts internal http hostnames when the private-network opt-in is explicit", async () => {
    await expect(
      resolveValidatedMatrixHomeserverUrl("http://localhost.localdomain:8008", {
        dangerouslyAllowPrivateNetwork: true,
        lookupFn: createLookupFn([{ address: "127.0.0.1", family: 4 }]),
      }),
    ).resolves.toBe("http://localhost.localdomain:8008");
  });
});

describe("resolveMatrixAuth", () => {
  beforeAll(async () => {
    credentialsReadModule = await import("./credentials-read.js");
  });

  beforeEach(() => {
    const readModule = requireCredentialsReadModule();
    vi.mocked(readModule.loadMatrixCredentials).mockReset();
    vi.mocked(readModule.loadMatrixCredentials).mockReturnValue(null);
    vi.mocked(readModule.credentialsMatchConfig).mockReset();
    vi.mocked(readModule.credentialsMatchConfig).mockReturnValue(false);
    saveMatrixCredentialsMock.mockReset();
    saveBackfilledMatrixDeviceIdMock.mockReset().mockResolvedValue("saved");
    touchMatrixCredentialsMock.mockReset();
    repairCurrentTokenStorageMetaDeviceIdMock.mockReset().mockReturnValue(true);
    ensureMatrixSdkLoggingConfiguredMock.mockReset();
    matrixDoRequestMock.mockReset();
    setMatrixAuthClientDepsForTest({
      MatrixClient: MockMatrixClient as unknown as typeof import("./sdk.js").MatrixClient,
      ensureMatrixSdkLoggingConfigured: ensureMatrixSdkLoggingConfiguredMock,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    setMatrixAuthClientDepsForTest(undefined);
  });

  it("uses the hardened client request path for password login and persists deviceId", async () => {
    matrixDoRequestMock.mockResolvedValue({
      access_token: "tok-123",
      user_id: "@bot:example.org",
      device_id: "DEVICE123",
    });

    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          password: "secret", // pragma: allowlist secret
          encryption: true,
        },
      },
    } as CoreConfig;

    const auth = await resolveMatrixAuth({
      cfg,
      env: {} as NodeJS.ProcessEnv,
    });

    expect(matrixDoRequestMock).toHaveBeenCalledWith(
      "POST",
      "/_matrix/client/v3/login",
      undefined,
      expect.objectContaining({
        type: "m.login.password",
      }),
    );
    expect(auth).toMatchObject({
      accountId: "default",
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "tok-123",
      deviceId: "DEVICE123",
      encryption: true,
    });
    expect(saveMatrixCredentialsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "tok-123",
        deviceId: "DEVICE123",
      }),
      expect.any(Object),
      "default",
    );
  });

  it("surfaces password login errors when account credentials are invalid", async () => {
    matrixDoRequestMock.mockRejectedValueOnce(new Error("Invalid username or password"));

    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          password: "secret", // pragma: allowlist secret
        },
      },
    } as CoreConfig;

    await expect(
      resolveMatrixAuth({
        cfg,
        env: {} as NodeJS.ProcessEnv,
      }),
    ).rejects.toThrow("Invalid username or password");

    expect(matrixDoRequestMock).toHaveBeenCalledWith(
      "POST",
      "/_matrix/client/v3/login",
      undefined,
      expect.objectContaining({
        type: "m.login.password",
      }),
    );
    expect(saveMatrixCredentialsMock).not.toHaveBeenCalled();
  });

  it("uses cached matching credentials when access token is not configured", async () => {
    vi.mocked(credentialsReadModule!.loadMatrixCredentials).mockReturnValue({
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "cached-token",
      deviceId: "CACHEDDEVICE",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    vi.mocked(credentialsReadModule!.credentialsMatchConfig).mockReturnValue(true);

    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          password: "secret", // pragma: allowlist secret
        },
      },
    } as CoreConfig;

    const auth = await resolveMatrixAuth({
      cfg,
      env: {} as NodeJS.ProcessEnv,
    });

    expect(auth).toMatchObject({
      accountId: "default",
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "cached-token",
      deviceId: "CACHEDDEVICE",
    });
    expect(saveMatrixCredentialsMock).not.toHaveBeenCalled();
  });

  it("uses cached matching credentials for env-backed named accounts without fresh auth", async () => {
    vi.mocked(credentialsReadModule!.loadMatrixCredentials).mockReturnValue({
      homeserver: "https://matrix.example.org",
      userId: "@ops:example.org",
      accessToken: "cached-token",
      deviceId: "CACHEDDEVICE",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    vi.mocked(credentialsReadModule!.credentialsMatchConfig).mockReturnValue(true);

    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
        },
      },
    } as CoreConfig;
    const env = {
      MATRIX_OPS_USER_ID: "@ops:example.org",
    } as NodeJS.ProcessEnv;

    const auth = await resolveMatrixAuth({
      cfg,
      env,
      accountId: "ops",
    });

    expect(auth).toMatchObject({
      accountId: "ops",
      homeserver: "https://matrix.example.org",
      userId: "@ops:example.org",
      accessToken: "cached-token",
      deviceId: "CACHEDDEVICE",
    });
    expect(saveMatrixCredentialsMock).not.toHaveBeenCalled();
  });

  it("rejects embedded credentials in Matrix homeserver URLs", async () => {
    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://user:pass@matrix.example.org",
          accessToken: "tok-123",
        },
      },
    } as CoreConfig;

    await expect(resolveMatrixAuth({ cfg, env: {} as NodeJS.ProcessEnv })).rejects.toThrow(
      "Matrix homeserver URL must not include embedded credentials",
    );
  });

  it("falls back to config deviceId when cached credentials are missing it", async () => {
    vi.mocked(credentialsReadModule!.loadMatrixCredentials).mockReturnValue({
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "tok-123",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    vi.mocked(credentialsReadModule!.credentialsMatchConfig).mockReturnValue(true);

    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          accessToken: "tok-123",
          deviceId: "DEVICE123",
          encryption: true,
        },
      },
    } as CoreConfig;

    const auth = await resolveMatrixAuth({ cfg, env: {} as NodeJS.ProcessEnv });

    expect(auth.deviceId).toBe("DEVICE123");
    expect(auth.accountId).toBe("default");
    expect(saveMatrixCredentialsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "tok-123",
        deviceId: "DEVICE123",
      }),
      expect.any(Object),
      "default",
    );
  });

  it("carries the private-network opt-in through Matrix auth resolution", async () => {
    const cfg = {
      channels: {
        matrix: {
          homeserver: "http://127.0.0.1:8008",
          allowPrivateNetwork: true,
          userId: "@bot:example.org",
          accessToken: "tok-123",
          deviceId: "DEVICE123",
        },
      },
    } as CoreConfig;

    const auth = await resolveMatrixAuth({ cfg, env: {} as NodeJS.ProcessEnv });

    expect(auth).toMatchObject({
      homeserver: "http://127.0.0.1:8008",
      allowPrivateNetwork: true,
      ssrfPolicy: { allowPrivateNetwork: true },
    });
  });

  it("resolves token-only non-default account userId from whoami instead of inheriting the base user", async () => {
    matrixDoRequestMock.mockResolvedValue({
      user_id: "@ops:example.org",
      device_id: "OPSDEVICE",
    });

    const cfg = {
      channels: {
        matrix: {
          userId: "@base:example.org",
          homeserver: "https://matrix.example.org",
          accounts: {
            ops: {
              homeserver: "https://matrix.example.org",
              accessToken: "ops-token",
            },
          },
        },
      },
    } as CoreConfig;

    const auth = await resolveMatrixAuth({
      cfg,
      env: {} as NodeJS.ProcessEnv,
      accountId: "ops",
    });

    expect(matrixDoRequestMock).toHaveBeenCalledWith("GET", "/_matrix/client/v3/account/whoami");
    expect(auth.userId).toBe("@ops:example.org");
    expect(auth.deviceId).toBe("OPSDEVICE");
  });

  it("uses named-account password auth instead of inheriting the base access token", async () => {
    vi.mocked(credentialsReadModule!.loadMatrixCredentials).mockReturnValue(null);
    vi.mocked(credentialsReadModule!.credentialsMatchConfig).mockReturnValue(false);
    matrixDoRequestMock.mockResolvedValue({
      access_token: "ops-token",
      user_id: "@ops:example.org",
      device_id: "OPSDEVICE",
    });

    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          accessToken: "legacy-token",
          accounts: {
            ops: {
              homeserver: "https://matrix.example.org",
              userId: "@ops:example.org",
              password: "ops-pass", // pragma: allowlist secret
            },
          },
        },
      },
    } as CoreConfig;

    const auth = await resolveMatrixAuth({
      cfg,
      env: {} as NodeJS.ProcessEnv,
      accountId: "ops",
    });

    expect(matrixDoRequestMock).toHaveBeenCalledWith(
      "POST",
      "/_matrix/client/v3/login",
      undefined,
      expect.objectContaining({
        type: "m.login.password",
        identifier: { type: "m.id.user", user: "@ops:example.org" },
        password: "ops-pass",
      }),
    );
    expect(auth).toMatchObject({
      accountId: "ops",
      homeserver: "https://matrix.example.org",
      userId: "@ops:example.org",
      accessToken: "ops-token",
      deviceId: "OPSDEVICE",
    });
  });

  it("resolves missing whoami identity fields for token auth", async () => {
    matrixDoRequestMock.mockResolvedValue({
      user_id: "@bot:example.org",
      device_id: "DEVICE123",
    });

    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          accessToken: "tok-123",
          encryption: true,
        },
      },
    } as CoreConfig;

    const auth = await resolveMatrixAuth({
      cfg,
      env: {} as NodeJS.ProcessEnv,
    });

    expect(matrixDoRequestMock).toHaveBeenCalledWith("GET", "/_matrix/client/v3/account/whoami");
    expect(auth).toMatchObject({
      accountId: "default",
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "tok-123",
      deviceId: "DEVICE123",
      encryption: true,
    });
  });

  it("retries token whoami when startup auth hits a transient network error", async () => {
    matrixDoRequestMock
      .mockRejectedValueOnce(
        Object.assign(new TypeError("fetch failed"), {
          cause: Object.assign(new Error("read ECONNRESET"), {
            code: "ECONNRESET",
          }),
        }),
      )
      .mockResolvedValue({
        user_id: "@bot:example.org",
        device_id: "DEVICE123",
      });

    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          accessToken: "tok-123",
        },
      },
    } as CoreConfig;

    const auth = await resolveMatrixAuth({
      cfg,
      env: {} as NodeJS.ProcessEnv,
    });

    expect(matrixDoRequestMock).toHaveBeenCalledTimes(2);
    expect(auth).toMatchObject({
      userId: "@bot:example.org",
      deviceId: "DEVICE123",
    });
  });

  it("does not call whoami when token auth already has a userId and only deviceId is missing", async () => {
    matrixDoRequestMock.mockRejectedValue(new Error("whoami should not be called"));

    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          accessToken: "tok-123",
          encryption: true,
        },
      },
    } as CoreConfig;

    const auth = await resolveMatrixAuth({
      cfg,
      env: {} as NodeJS.ProcessEnv,
    });

    expect(matrixDoRequestMock).not.toHaveBeenCalled();
    expect(auth).toMatchObject({
      accountId: "default",
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "tok-123",
      deviceId: undefined,
      encryption: true,
    });
  });

  it("retries password login when startup auth hits a transient network error", async () => {
    matrixDoRequestMock
      .mockRejectedValueOnce(
        Object.assign(new TypeError("fetch failed"), {
          cause: Object.assign(new Error("socket hang up"), {
            code: "ECONNRESET",
          }),
        }),
      )
      .mockResolvedValue({
        access_token: "tok-123",
        user_id: "@bot:example.org",
        device_id: "DEVICE123",
      });

    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          password: "secret", // pragma: allowlist secret
        },
      },
    } as CoreConfig;

    const auth = await resolveMatrixAuth({
      cfg,
      env: {} as NodeJS.ProcessEnv,
    });

    expect(matrixDoRequestMock).toHaveBeenCalledTimes(2);
    expect(auth).toMatchObject({
      accessToken: "tok-123",
      deviceId: "DEVICE123",
    });
  });

  it("best-effort backfills a missing deviceId after startup", async () => {
    matrixDoRequestMock.mockResolvedValue({
      user_id: "@bot:example.org",
      device_id: "DEVICE123",
    });

    const deviceId = await backfillMatrixAuthDeviceIdAfterStartup({
      auth: {
        accountId: "default",
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "tok-123",
      },
      env: {} as NodeJS.ProcessEnv,
    });

    expect(matrixDoRequestMock).toHaveBeenCalledWith("GET", "/_matrix/client/v3/account/whoami");
    expect(saveBackfilledMatrixDeviceIdMock).toHaveBeenCalledWith(
      {
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "tok-123",
        deviceId: "DEVICE123",
      },
      expect.any(Object),
      "default",
    );
    expect(repairCurrentTokenStorageMetaDeviceIdMock).toHaveBeenCalledWith({
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "tok-123",
      accountId: "default",
      deviceId: "DEVICE123",
      env: expect.any(Object),
    });
    expect(repairCurrentTokenStorageMetaDeviceIdMock.mock.invocationCallOrder[0]).toBeLessThan(
      saveBackfilledMatrixDeviceIdMock.mock.invocationCallOrder[0],
    );
    expect(deviceId).toBe("DEVICE123");
  });

  it("skips deviceId backfill when auth already includes it", async () => {
    const deviceId = await backfillMatrixAuthDeviceIdAfterStartup({
      auth: {
        accountId: "default",
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "tok-123",
        deviceId: "DEVICE123",
      },
      env: {} as NodeJS.ProcessEnv,
    });

    expect(matrixDoRequestMock).not.toHaveBeenCalled();
    expect(saveMatrixCredentialsMock).not.toHaveBeenCalled();
    expect(saveBackfilledMatrixDeviceIdMock).not.toHaveBeenCalled();
    expect(repairCurrentTokenStorageMetaDeviceIdMock).not.toHaveBeenCalled();
    expect(deviceId).toBe("DEVICE123");
  });

  it("fails before saving repaired credentials when storage metadata repair fails", async () => {
    matrixDoRequestMock.mockResolvedValue({
      user_id: "@bot:example.org",
      device_id: "DEVICE123",
    });
    repairCurrentTokenStorageMetaDeviceIdMock.mockReturnValue(false);

    await expect(
      backfillMatrixAuthDeviceIdAfterStartup({
        auth: {
          accountId: "default",
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          accessToken: "tok-123",
        },
        env: {} as NodeJS.ProcessEnv,
      }),
    ).rejects.toThrow("Matrix deviceId backfill failed to repair current-token storage metadata");
    expect(saveBackfilledMatrixDeviceIdMock).not.toHaveBeenCalled();
  });

  it("skips stale deviceId backfill writes after newer credentials take over", async () => {
    matrixDoRequestMock.mockResolvedValue({
      user_id: "@bot:example.org",
      device_id: "DEVICE123",
    });
    vi.mocked(requireCredentialsReadModule().loadMatrixCredentials).mockReturnValue({
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "tok-new",
      deviceId: "DEVICE999",
      createdAt: "2026-03-01T00:00:00.000Z",
    });

    const deviceId = await backfillMatrixAuthDeviceIdAfterStartup({
      auth: {
        accountId: "default",
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "tok-old",
      },
      env: {} as NodeJS.ProcessEnv,
    });

    expect(deviceId).toBeUndefined();
    expect(repairCurrentTokenStorageMetaDeviceIdMock).not.toHaveBeenCalled();
    expect(saveBackfilledMatrixDeviceIdMock).not.toHaveBeenCalled();
  });

  it("skips persistence when startup backfill is aborted before whoami resolves", async () => {
    let resolveWhoami: ((value: { user_id: string; device_id: string }) => void) | undefined;
    matrixDoRequestMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveWhoami = resolve;
        }),
    );
    const abortController = new AbortController();
    const backfillPromise = backfillMatrixAuthDeviceIdAfterStartup({
      auth: {
        accountId: "default",
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "tok-123",
      },
      env: {} as NodeJS.ProcessEnv,
      abortSignal: abortController.signal,
    });

    await vi.waitFor(() => {
      expect(resolveWhoami).toBeTypeOf("function");
    });
    abortController.abort();
    resolveWhoami?.({
      user_id: "@bot:example.org",
      device_id: "DEVICE123",
    });

    await expect(backfillPromise).resolves.toBeUndefined();
    expect(repairCurrentTokenStorageMetaDeviceIdMock).not.toHaveBeenCalled();
    expect(saveBackfilledMatrixDeviceIdMock).not.toHaveBeenCalled();
  });

  it("resolves file-backed accessToken SecretRefs during Matrix auth", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "matrix-secret-ref-"));
    const secretPath = path.join(tempDir, "token.txt");
    await fs.writeFile(secretPath, "file-token\n", "utf8");
    await fs.chmod(secretPath, 0o600);

    matrixDoRequestMock.mockResolvedValue({
      user_id: "@bot:example.org",
      device_id: "DEVICE123",
    });

    try {
      const cfg = {
        channels: {
          matrix: {
            homeserver: "https://matrix.example.org",
            accessToken: { source: "file", provider: "matrix-file", id: "value" },
          },
        },
        secrets: {
          providers: {
            "matrix-file": {
              source: "file",
              path: secretPath,
              mode: "singleValue",
            },
          },
        },
      } as CoreConfig;

      const auth = await resolveMatrixAuth({
        cfg,
        env: {} as NodeJS.ProcessEnv,
      });

      expect(matrixDoRequestMock).toHaveBeenCalledWith("GET", "/_matrix/client/v3/account/whoami");
      expect(auth).toMatchObject({
        accountId: "default",
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "file-token",
        deviceId: "DEVICE123",
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not resolve inactive password SecretRefs when scoped token auth wins", async () => {
    matrixDoRequestMock.mockResolvedValue({
      user_id: "@ops:example.org",
      device_id: "OPSDEVICE",
    });

    const cfg = {
      channels: {
        matrix: {
          accounts: {
            ops: {
              homeserver: "https://matrix.example.org",
              password: { source: "env", provider: "default", id: "MATRIX_OPS_PASSWORD" },
            },
          },
        },
      },
      secrets: {
        defaults: {
          env: "default",
        },
      },
    } as CoreConfig;

    installMatrixTestRuntime({ cfg });

    const auth = await resolveMatrixAuth({
      cfg,
      env: {
        MATRIX_OPS_ACCESS_TOKEN: "ops-token",
      } as NodeJS.ProcessEnv,
      accountId: "ops",
    });

    expect(matrixDoRequestMock).toHaveBeenCalledWith("GET", "/_matrix/client/v3/account/whoami");
    expect(auth).toMatchObject({
      accountId: "ops",
      homeserver: "https://matrix.example.org",
      userId: "@ops:example.org",
      accessToken: "ops-token",
      deviceId: "OPSDEVICE",
      password: undefined,
    });
  });

  it("uses config deviceId with cached credentials when token is loaded from cache", async () => {
    vi.mocked(credentialsReadModule!.loadMatrixCredentials).mockReturnValue({
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "tok-123",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    vi.mocked(credentialsReadModule!.credentialsMatchConfig).mockReturnValue(true);

    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          deviceId: "DEVICE123",
          encryption: true,
        },
      },
    } as CoreConfig;

    const auth = await resolveMatrixAuth({ cfg, env: {} as NodeJS.ProcessEnv });

    expect(auth).toMatchObject({
      accountId: "default",
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "tok-123",
      deviceId: "DEVICE123",
      encryption: true,
    });
  });

  it("falls back to the sole configured account when no global homeserver is set", async () => {
    const cfg = {
      channels: {
        matrix: {
          accounts: {
            ops: {
              homeserver: "https://ops.example.org",
              userId: "@ops:example.org",
              accessToken: "ops-token",
              deviceId: "OPSDEVICE",
              encryption: true,
            },
          },
        },
      },
    } as CoreConfig;

    const auth = await resolveMatrixAuth({ cfg, env: {} as NodeJS.ProcessEnv });

    expect(auth).toMatchObject({
      accountId: "ops",
      homeserver: "https://ops.example.org",
      userId: "@ops:example.org",
      accessToken: "ops-token",
      deviceId: "OPSDEVICE",
      encryption: true,
    });
    expect(saveMatrixCredentialsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        homeserver: "https://ops.example.org",
        userId: "@ops:example.org",
        accessToken: "ops-token",
        deviceId: "OPSDEVICE",
      }),
      expect.any(Object),
      "ops",
    );
  });
});
