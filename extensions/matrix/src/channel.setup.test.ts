import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime-api.js";

const verificationMocks = vi.hoisted(() => ({
  bootstrapMatrixVerification: vi.fn(),
}));

vi.mock("./matrix/actions/verification.js", () => ({
  bootstrapMatrixVerification: verificationMocks.bootstrapMatrixVerification,
}));

import { matrixConfigAdapter } from "./config-adapter.js";
import { runMatrixSetupBootstrapAfterConfigWrite } from "./setup-bootstrap.js";
import { matrixSetupAdapter } from "./setup-core.js";
import { installMatrixTestRuntime } from "./test-runtime.js";
import type { CoreConfig } from "./types.js";

describe("matrix setup post-write bootstrap", () => {
  const log = vi.fn();
  const error = vi.fn();
  const exit = vi.fn((code: number): never => {
    throw new Error(`exit ${code}`);
  });
  const encryptedDefaultCfg = {
    channels: {
      matrix: {
        encryption: true,
      },
    },
  } as CoreConfig;
  const defaultPasswordInput = {
    homeserver: "https://matrix.example.org",
    userId: "@flurry:example.org",
    password: "secret", // pragma: allowlist secret
  } as const;
  const runtime: RuntimeEnv = {
    log,
    error,
    exit,
  };

  function applyAccountConfig(params: {
    previousCfg: CoreConfig;
    accountId: string;
    input: Record<string, unknown>;
  }) {
    return {
      previousCfg: params.previousCfg,
      accountId: params.accountId,
      input: params.input,
      nextCfg: matrixSetupAdapter.applyAccountConfig({
        cfg: params.previousCfg,
        accountId: params.accountId,
        input: params.input,
      }) as CoreConfig,
    };
  }

  function applyDefaultAccountConfig(input: Record<string, unknown> = defaultPasswordInput) {
    return applyAccountConfig({
      previousCfg: encryptedDefaultCfg,
      accountId: "default",
      input,
    });
  }

  function mockBootstrapResult(params: {
    success: boolean;
    backupVersion?: string | null;
    error?: string;
  }) {
    verificationMocks.bootstrapMatrixVerification.mockResolvedValue({
      success: params.success,
      ...(params.error ? { error: params.error } : {}),
      verification: {
        backupVersion: params.backupVersion ?? null,
      },
      crossSigning: {},
      pendingVerifications: 0,
      cryptoBootstrap: null,
    });
  }

  async function runAfterAccountConfigWritten(params: {
    previousCfg: CoreConfig;
    nextCfg: CoreConfig;
    accountId: string;
    input: Record<string, unknown>;
  }) {
    await runMatrixSetupBootstrapAfterConfigWrite({
      previousCfg: params.previousCfg,
      cfg: params.nextCfg,
      accountId: params.accountId,
      runtime,
    });
  }

  async function withSavedEnv<T>(
    values: Record<string, string | undefined>,
    run: () => Promise<T> | T,
  ) {
    const previousEnv = Object.fromEntries(
      Object.keys(values).map((key) => [key, process.env[key]]),
    ) as Record<string, string | undefined>;
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    try {
      return await run();
    } finally {
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  }

  beforeEach(() => {
    verificationMocks.bootstrapMatrixVerification.mockReset();
    log.mockClear();
    error.mockClear();
    exit.mockClear();
    installMatrixTestRuntime();
  });

  it("bootstraps verification for newly added encrypted accounts", async () => {
    const { previousCfg, nextCfg, accountId, input } = applyDefaultAccountConfig();
    mockBootstrapResult({ success: true, backupVersion: "7" });

    await runAfterAccountConfigWritten({ previousCfg, nextCfg, accountId, input });

    expect(verificationMocks.bootstrapMatrixVerification).toHaveBeenCalledWith({
      accountId: "default",
      cfg: nextCfg,
    });
    expect(log).toHaveBeenCalledWith('Matrix verification bootstrap: complete for "default".');
    expect(log).toHaveBeenCalledWith('Matrix backup version for "default": 7');
    expect(error).not.toHaveBeenCalled();
  });

  it("does not bootstrap verification for already configured accounts", async () => {
    const previousCfg = {
      channels: {
        matrix: {
          accounts: {
            flurry: {
              encryption: true,
              homeserver: "https://matrix.example.org",
              userId: "@flurry:example.org",
              accessToken: "token",
            },
          },
        },
      },
    } as CoreConfig;
    const input = {
      homeserver: "https://matrix.example.org",
      userId: "@flurry:example.org",
      accessToken: "new-token",
    };
    const { nextCfg, accountId } = applyAccountConfig({
      previousCfg,
      accountId: "flurry",
      input,
    });

    await runAfterAccountConfigWritten({ previousCfg, nextCfg, accountId, input });

    expect(verificationMocks.bootstrapMatrixVerification).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("bootstraps verification when setup enables encryption for an existing account", async () => {
    const previousCfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          userId: "@flurry:example.org",
          accessToken: "token",
          encryption: false,
        },
      },
    } as CoreConfig;
    const nextCfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          userId: "@flurry:example.org",
          accessToken: "token",
          encryption: true,
        },
      },
    } as CoreConfig;
    mockBootstrapResult({ success: true, backupVersion: "8" });

    await runAfterAccountConfigWritten({
      previousCfg,
      nextCfg,
      accountId: "default",
      input: {},
    });

    expect(verificationMocks.bootstrapMatrixVerification).toHaveBeenCalledWith({
      accountId: "default",
      cfg: nextCfg,
    });
    expect(log).toHaveBeenCalledWith('Matrix verification bootstrap: complete for "default".');
    expect(log).toHaveBeenCalledWith('Matrix backup version for "default": 8');
  });

  it("logs a warning when verification bootstrap fails", async () => {
    const { previousCfg, nextCfg, accountId, input } = applyDefaultAccountConfig();
    mockBootstrapResult({
      success: false,
      error: "no room-key backup exists on the homeserver",
    });

    await runAfterAccountConfigWritten({ previousCfg, nextCfg, accountId, input });

    expect(error).toHaveBeenCalledWith(
      'Matrix verification bootstrap warning for "default": no room-key backup exists on the homeserver',
    );
  });

  it("bootstraps a newly added env-backed default account when encryption is already enabled", async () => {
    await withSavedEnv(
      {
        MATRIX_HOMESERVER: "https://matrix.example.org",
        MATRIX_ACCESS_TOKEN: "env-token",
      },
      async () => {
        const { previousCfg, nextCfg, accountId, input } = applyDefaultAccountConfig({
          useEnv: true,
        });
        mockBootstrapResult({ success: true, backupVersion: "9" });

        await runAfterAccountConfigWritten({ previousCfg, nextCfg, accountId, input });

        expect(verificationMocks.bootstrapMatrixVerification).toHaveBeenCalledWith({
          accountId: "default",
          cfg: nextCfg,
        });
        expect(log).toHaveBeenCalledWith('Matrix verification bootstrap: complete for "default".');
      },
    );
  });

  it("rejects default useEnv setup when no Matrix auth env vars are available", () => {
    return withSavedEnv(
      {
        MATRIX_HOMESERVER: undefined,
        MATRIX_USER_ID: undefined,
        MATRIX_ACCESS_TOKEN: undefined,
        MATRIX_PASSWORD: undefined,
        MATRIX_DEFAULT_HOMESERVER: undefined,
        MATRIX_DEFAULT_USER_ID: undefined,
        MATRIX_DEFAULT_ACCESS_TOKEN: undefined,
        MATRIX_DEFAULT_PASSWORD: undefined,
      },
      () => {
        expect(
          matrixSetupAdapter.validateInput?.({
            cfg: {} as CoreConfig,
            accountId: "default",
            input: { useEnv: true },
          }),
        ).toContain("Set Matrix env vars for the default account");
      },
    );
  });

  it("clears allowPrivateNetwork and proxy when deleting the default Matrix account config", () => {
    const updated = matrixConfigAdapter.deleteAccount?.({
      cfg: {
        channels: {
          matrix: {
            homeserver: "http://localhost.localdomain:8008",
            network: {
              dangerouslyAllowPrivateNetwork: true,
            },
            proxy: "http://127.0.0.1:7890",
            accounts: {
              ops: {
                enabled: true,
              },
            },
          },
        },
      } as CoreConfig,
      accountId: "default",
    }) as CoreConfig;

    expect(updated.channels?.matrix).toEqual({
      accounts: {
        ops: {
          enabled: true,
        },
      },
    });
  });
});
