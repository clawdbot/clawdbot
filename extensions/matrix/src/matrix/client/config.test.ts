import type { LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
// Matrix tests cover config plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMatrixScopedEnvVarNames } from "../../env-vars.js";
import { installMatrixTestRuntime } from "../../test-runtime.js";
import type { CoreConfig } from "../../types.js";
import {
  resolveMatrixConfigForAccount,
  resolveMatrixAuthContext,
  resolveValidatedMatrixHomeserverUrl,
  validateMatrixHomeserverUrl,
} from "./config.js";

function createLookupFn(addresses: Array<{ address: string; family: number }>): LookupFn {
  return vi.fn(async (_hostname: string, options?: unknown) => {
    if (typeof options === "number" || !options || !(options as { all?: boolean }).all) {
      return addresses[0];
    }
    return addresses;
  }) as unknown as LookupFn;
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

afterEach(() => {
  vi.unstubAllEnvs();
});

function createEnvSecretRefConfig(params: {
  field: "accessToken" | "password";
  accountId?: string;
  provider?: string;
  secrets?: CoreConfig["secrets"];
}): CoreConfig {
  const account = {
    homeserver: "https://matrix.example.org",
    userId: "@bot:example.org",
    [params.field]: {
      source: "env",
      provider: params.provider ?? "default",
      id: "MATRIX_TEST_SECRET",
    },
  };
  return {
    channels: {
      matrix:
        params.accountId && params.accountId !== "default"
          ? { accounts: { [params.accountId]: account } }
          : account,
    },
    secrets: params.secrets,
  };
}

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

  it("ignores non-finite initial sync limits", () => {
    const cfg = {
      channels: {
        matrix: {
          initialSyncLimit: Number.NaN,
          accounts: {
            ops: {
              initialSyncLimit: Number.POSITIVE_INFINITY,
            },
          },
        },
      },
    } as unknown as CoreConfig;

    const resolved = resolveMatrixConfigForAccount(cfg, "ops", {} as NodeJS.ProcessEnv);
    expect(resolved.initialSyncLimit).toBeUndefined();
  });

  it.each([
    ["default", "accessToken", "default", undefined],
    ["default", "password", "default", undefined],
    ["ops", "accessToken", "default", undefined],
    ["ops", "password", "default", undefined],
    ["default", "accessToken", "default", "file"],
    ["default", "password", "default", "exec"],
    ["ops", "accessToken", "default", "store"],
    ["ops", "password", "default", "file"],
    ["default", "accessToken", "shared", "exec"],
    ["default", "password", "shared", "store"],
    ["ops", "accessToken", "shared", "file"],
    ["ops", "password", "shared", "exec"],
  ] as const)(
    "resolves %s %s from supplied env with alias %s and declaration %s",
    (accountId, field, provider, declaredSource) => {
      const declarations = {
        file: { source: "file", path: "/unused/matrix-secret.json" },
        exec: { source: "exec", command: "/unused/matrix-secret-command" },
        store: { source: "store" },
      } as const;
      const cfg = createEnvSecretRefConfig({
        accountId,
        field,
        provider,
        secrets: {
          defaults: provider === "shared" ? { env: "shared" } : undefined,
          providers: declaredSource ? { [provider]: declarations[declaredSource] } : undefined,
        },
      });
      const env = { MATRIX_TEST_SECRET: " supplied-secret " };

      const resolved = resolveMatrixAuthContext({ cfg, accountId, env }).resolved;
      expect(resolved[field]).toBe("supplied-secret");
    },
  );

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
      secrets: { providers: { default: { source: "env", allowlist: [] } } },
    } as CoreConfig;
    const env = {
      MATRIX_OPS_ACCESS_TOKEN: "ops-token",
    } as NodeJS.ProcessEnv;

    const resolved = resolveMatrixConfigForAccount(cfg, "ops", env);
    expect(resolved.accessToken).toBe("ops-token");
    expect(resolved.password).toBeUndefined();
  });

  it.each([
    ["accessToken", undefined],
    ["accessToken", "   "],
    ["password", undefined],
    ["password", "   "],
  ] as const)("rejects %s SecretRefs with missing/blank env value %j", (field, value) => {
    vi.stubEnv("MATRIX_ACCESS_TOKEN", "ambient-token");
    vi.stubEnv("MATRIX_PASSWORD", "ambient-password");
    vi.stubEnv("MATRIX_TEST_SECRET", "ambient-secret");
    const cfg = createEnvSecretRefConfig({ field });
    const env = {
      MATRIX_TEST_SECRET: value,
      ...(field === "accessToken" ? { MATRIX_ACCESS_TOKEN: "fallback-token" } : {}),
    };

    expect(() => resolveDefaultMatrixAuthContext(cfg, env)).toThrow(
      `channels.matrix.${field}: unresolved SecretRef "env:default:MATRIX_TEST_SECRET"`,
    );
  });

  it.each([
    ["accessToken", "default", undefined, true],
    ["password", "shared", ["MATRIX_TEST_SECRET"], true],
    ["accessToken", "default", ["OTHER_MATRIX_SECRET"], false],
    ["password", "shared", ["OTHER_MATRIX_SECRET"], false],
    ["accessToken", "default", [], false],
    ["password", "shared", [], false],
  ] as const)(
    "honors explicit env policy for %s at %s with allowlist %j (allowed: %s)",
    (field, provider, allowlist, allowed) => {
      const cfg = createEnvSecretRefConfig({
        field,
        provider,
        secrets: {
          defaults: { env: provider },
          providers: { [provider]: { source: "env", allowlist: allowlist && [...allowlist] } },
        },
      });
      const resolve = () =>
        resolveDefaultMatrixAuthContext(cfg, { MATRIX_TEST_SECRET: "env-secret" });

      if (allowed) {
        expect(resolve().resolved[field]).toBe("env-secret");
      } else {
        expect(resolve).toThrow(`not allowlisted in secrets.providers.${provider}.allowlist`);
      }
    },
  );

  it.each([
    ["other", { source: "file", path: "/unused/matrix-secret.json" }, undefined],
    ["other", undefined, undefined],
    ["default", undefined, "shared"],
  ] as const)(
    "rejects non-default alias %s with declaration %j and env default %s",
    (provider, declaration, envDefault) => {
      const cfg = createEnvSecretRefConfig({
        field: "accessToken",
        provider,
        secrets: {
          defaults: { env: envDefault },
          providers: declaration ? { [provider]: declaration } : undefined,
        },
      });

      expect(() =>
        resolveDefaultMatrixAuthContext(cfg, { MATRIX_TEST_SECRET: "env-secret" }),
      ).toThrow(
        declaration
          ? `Secret provider "${provider}" has source "file" but ref requests "env".`
          : `Secret provider "${provider}" is not configured (ref: env:${provider}:MATRIX_TEST_SECRET).`,
      );
    },
  );

  it("leaves non-env SecretRef access tokens unresolved", () => {
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
    expect(resolved.resolved).toEqual({
      homeserver: "https://matrix.gumadeiras.com",
      userId: "@pinguini:matrix.gumadeiras.com",
      accessToken: undefined,
      password: "cfg-pass",
      deviceId: undefined,
      deviceName: "OpenClaw Gateway Pinguini",
      initialSyncLimit: undefined,
      encryption: true,
      allowPrivateNetwork: undefined,
      ssrfPolicy: undefined,
      dispatcherPolicy: undefined,
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

  it("rejects invalid explicit account ids instead of borrowing the default account", () => {
    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://legacy.example.org",
          accessToken: "legacy-token",
        },
      },
    } as CoreConfig;

    expect(() =>
      resolveMatrixAuthContext({ cfg, env: {} as NodeJS.ProcessEnv, accountId: "!!!" }),
    ).toThrow(/Matrix account id "!!!" is invalid/i);
  });

  it.each(["channel", "account"])(
    "rejects a disabled %s before resolving secrets",
    (disabledScope) => {
      const cfg = {
        channels: {
          matrix: {
            enabled: disabledScope !== "channel",
            homeserver: "https://legacy.example.org",
            accessToken: "legacy-token",
            accounts: {
              disabled: {
                enabled: disabledScope !== "account",
                homeserver: "https://disabled.example.org",
                accessToken: {
                  source: "env",
                  provider: "default",
                  id: "MATRIX_DISABLED_ACCESS_TOKEN",
                },
              },
            },
          },
        },
      } as CoreConfig;

      expect(() =>
        resolveMatrixAuthContext({
          cfg,
          env: {} as NodeJS.ProcessEnv,
          accountId: "disabled",
        }),
      ).toThrow(/Matrix account "disabled" is disabled/i);
    },
  );

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
    expect(validateMatrixHomeserverUrl("http://[::ffff:127.0.0.1]:8008")).toBe(
      "http://[::ffff:127.0.0.1]:8008",
    );
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
