import { describe, expect, it } from "vitest";
import "./runtime-matrix.test-support.ts";
import {
  asConfig,
  loadAuthStoreWithProfiles,
  setupSecretsRuntimeSnapshotTestHooks,
} from "./runtime.test-support.ts";

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();

describe("secrets runtime snapshot matrix shadowing", () => {
  it("ignores Matrix password refs that are shadowed by scoped env access tokens", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          matrix: {
            accounts: {
              ops: {
                password: {
                  source: "env",
                  provider: "default",
                  id: "MATRIX_OPS_PASSWORD",
                },
              },
            },
          },
        },
      }),
      env: {
        MATRIX_OPS_ACCESS_TOKEN: "ops-token",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });

    expect(
      (snapshot.config.channels?.matrix?.accounts?.ops as { password?: unknown } | undefined)
        ?.password,
    ).toEqual({
      source: "env",
      provider: "default",
      id: "MATRIX_OPS_PASSWORD",
    });
    expect(snapshot.warnings).toContainEqual(
      expect.objectContaining({
        code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
        path: "channels.matrix.accounts.ops.password",
      }),
    );
  });

  it.each([
    {
      name: "channels.matrix.accounts.default.accessToken config",
      config: {
        channels: {
          matrix: {
            password: {
              source: "env",
              provider: "default",
              id: "MATRIX_PASSWORD",
            },
            accounts: {
              default: {
                accessToken: "default-token",
              },
            },
          },
        },
      },
      env: {},
    },
    {
      name: "channels.matrix.accounts.default.accessToken SecretRef config",
      config: {
        channels: {
          matrix: {
            password: {
              source: "env",
              provider: "default",
              id: "MATRIX_PASSWORD",
            },
            accounts: {
              default: {
                accessToken: {
                  source: "env",
                  provider: "default",
                  id: "MATRIX_DEFAULT_ACCESS_TOKEN_REF",
                },
              },
            },
          },
        },
      },
      env: {
        MATRIX_DEFAULT_ACCESS_TOKEN_REF: "default-token",
      },
    },
    {
      name: "MATRIX_DEFAULT_ACCESS_TOKEN env auth",
      config: {
        channels: {
          matrix: {
            password: {
              source: "env",
              provider: "default",
              id: "MATRIX_PASSWORD",
            },
          },
        },
      },
      env: {
        MATRIX_DEFAULT_ACCESS_TOKEN: "default-token",
      },
    },
  ])("ignores top-level Matrix password refs shadowed by $name", async ({ config, env }) => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig(config),
      env,
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });

    expect(snapshot.config.channels?.matrix?.password).toEqual({
      source: "env",
      provider: "default",
      id: "MATRIX_PASSWORD",
    });
    expect(snapshot.warnings).toContainEqual(
      expect.objectContaining({
        code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
        path: "channels.matrix.password",
      }),
    );
  });

  it.each([
    {
      name: "top-level Matrix accessToken config",
      config: {
        channels: {
          matrix: {
            accessToken: "default-token",
            accounts: {
              default: {
                password: {
                  source: "env",
                  provider: "default",
                  id: "MATRIX_DEFAULT_PASSWORD",
                },
              },
            },
          },
        },
      },
      env: {},
    },
    {
      name: "top-level Matrix accessToken SecretRef config",
      config: {
        channels: {
          matrix: {
            accessToken: {
              source: "env",
              provider: "default",
              id: "MATRIX_ACCESS_TOKEN_REF",
            },
            accounts: {
              default: {
                password: {
                  source: "env",
                  provider: "default",
                  id: "MATRIX_DEFAULT_PASSWORD",
                },
              },
            },
          },
        },
      },
      env: {
        MATRIX_ACCESS_TOKEN_REF: "default-token",
      },
    },
    {
      name: "MATRIX_ACCESS_TOKEN env auth",
      config: {
        channels: {
          matrix: {
            accounts: {
              default: {
                password: {
                  source: "env",
                  provider: "default",
                  id: "MATRIX_DEFAULT_PASSWORD",
                },
              },
            },
          },
        },
      },
      env: {
        MATRIX_ACCESS_TOKEN: "default-token",
      },
    },
  ])("ignores default-account Matrix password refs shadowed by $name", async ({ config, env }) => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig(config),
      env,
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });

    expect(
      (snapshot.config.channels?.matrix?.accounts?.default as { password?: unknown } | undefined)
        ?.password,
    ).toEqual({
      source: "env",
      provider: "default",
      id: "MATRIX_DEFAULT_PASSWORD",
    });
    expect(snapshot.warnings).toContainEqual(
      expect.objectContaining({
        code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
        path: "channels.matrix.accounts.default.password",
      }),
    );
  });
});
