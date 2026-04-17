import { beforeEach, describe, expect, it, vi } from "vitest";
import { MatrixCryptoBootstrapper, type MatrixCryptoBootstrapperDeps } from "./crypto-bootstrap.js";
import type { MatrixCryptoBootstrapApi, MatrixRawEvent } from "./types.js";

function createBootstrapperDeps() {
  return {
    getUserId: vi.fn(async () => "@bot:example.org"),
    getPassword: vi.fn<() => string | undefined>(() => "super-secret-password"),
    getDeviceId: vi.fn(() => "DEVICE123"),
    verificationManager: {
      trackVerificationRequest: vi.fn(),
    },
    recoveryKeyStore: {
      bootstrapSecretStorageWithRecoveryKey: vi.fn(async () => {}),
    },
    decryptBridge: {
      bindCryptoRetrySignals: vi.fn(),
    },
  };
}

function createCryptoApi(overrides?: Partial<MatrixCryptoBootstrapApi>): MatrixCryptoBootstrapApi {
  return {
    on: vi.fn(),
    bootstrapCrossSigning: vi.fn(async () => {}),
    bootstrapSecretStorage: vi.fn(async () => {}),
    requestOwnUserVerification: vi.fn(async () => null),
    ...overrides,
  };
}

function createVerifiedDeviceStatus(overrides?: {
  localVerified?: boolean;
  crossSigningVerified?: boolean;
  signedByOwner?: boolean;
}) {
  return {
    isVerified: () => true,
    localVerified: overrides?.localVerified ?? true,
    crossSigningVerified: overrides?.crossSigningVerified ?? true,
    signedByOwner: overrides?.signedByOwner ?? true,
  };
}

function createBootstrapperHarness(
  cryptoOverrides?: Partial<MatrixCryptoBootstrapApi>,
  depsOverrides?: Partial<ReturnType<typeof createBootstrapperDeps>>,
) {
  const deps = {
    ...createBootstrapperDeps(),
    ...depsOverrides,
  };
  const crypto = createCryptoApi(cryptoOverrides);
  const bootstrapper = new MatrixCryptoBootstrapper(
    deps as unknown as MatrixCryptoBootstrapperDeps<MatrixRawEvent>,
  );
  return { deps, crypto, bootstrapper };
}

async function runExplicitSecretStorageRepairScenario(firstError: string) {
  const bootstrapCrossSigning = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(new Error(firstError))
    .mockResolvedValueOnce(undefined);
  const { deps, crypto, bootstrapper } = createBootstrapperHarness({
    bootstrapCrossSigning,
    isCrossSigningReady: vi.fn(async () => true),
    userHasCrossSigningKeys: vi.fn(async () => true),
    getDeviceVerificationStatus: vi.fn(async () => createVerifiedDeviceStatus()),
  });

  await bootstrapper.bootstrap(crypto, {
    strict: true,
    allowSecretStorageRecreateWithoutRecoveryKey: true,
    allowAutomaticCrossSigningReset: false,
  });

  return { deps, crypto, bootstrapCrossSigning };
}

function expectSecretStorageRepairRetry(
  deps: ReturnType<typeof createBootstrapperDeps>,
  crypto: MatrixCryptoBootstrapApi,
  bootstrapCrossSigning: ReturnType<typeof vi.fn>,
) {
  expect(deps.recoveryKeyStore.bootstrapSecretStorageWithRecoveryKey).toHaveBeenCalledWith(crypto, {
    allowSecretStorageRecreateWithoutRecoveryKey: true,
    forceNewSecretStorage: true,
  });
  expect(bootstrapCrossSigning).toHaveBeenCalledTimes(2);
}

async function bootstrapWithVerificationRequestListener(overrides?: {
  deps?: Partial<ReturnType<typeof createBootstrapperDeps>>;
  crypto?: Partial<MatrixCryptoBootstrapApi>;
}) {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const { deps, bootstrapper, crypto } = createBootstrapperHarness(
    {
      getDeviceVerificationStatus: vi.fn(async () => ({
        isVerified: () => true,
      })),
      on: vi.fn((eventName: string, listener: (...args: unknown[]) => void) => {
        listeners.set(eventName, listener);
      }),
      ...overrides?.crypto,
    },
    overrides?.deps,
  );

  await bootstrapper.bootstrap(crypto);
  const listener = Array.from(listeners.entries()).find(([eventName]) =>
    eventName.toLowerCase().includes("verificationrequest"),
  )?.[1];
  expect(listener).toBeTypeOf("function");

  return {
    deps,
    listener,
  };
}

describe("MatrixCryptoBootstrapper", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("bootstraps cross-signing/secret-storage and binds decrypt retry signals", async () => {
    const deps = createBootstrapperDeps();
    const crypto = createCryptoApi({
      getDeviceVerificationStatus: vi.fn(async () => ({
        isVerified: () => true,
      })),
    });
    const bootstrapper = new MatrixCryptoBootstrapper(
      deps as unknown as MatrixCryptoBootstrapperDeps<MatrixRawEvent>,
    );

    await bootstrapper.bootstrap(crypto);

    expect(crypto.bootstrapCrossSigning).toHaveBeenCalledWith(
      expect.objectContaining({
        authUploadDeviceSigningKeys: expect.any(Function),
      }),
    );
    expect(deps.recoveryKeyStore.bootstrapSecretStorageWithRecoveryKey).toHaveBeenCalledWith(
      crypto,
      {
        allowSecretStorageRecreateWithoutRecoveryKey: false,
      },
    );
    expect(deps.recoveryKeyStore.bootstrapSecretStorageWithRecoveryKey).toHaveBeenCalledTimes(2);
    expect(deps.decryptBridge.bindCryptoRetrySignals).toHaveBeenCalledWith(crypto);
  });

  it("forces new cross-signing keys only when readiness check still fails", async () => {
    const deps = createBootstrapperDeps();
    const bootstrapCrossSigning = vi.fn(async () => {});
    const crypto = createCryptoApi({
      bootstrapCrossSigning,
      isCrossSigningReady: vi
        .fn<() => Promise<boolean>>()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
      userHasCrossSigningKeys: vi
        .fn<() => Promise<boolean>>()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
      getDeviceVerificationStatus: vi.fn(async () => ({
        isVerified: () => true,
      })),
    });
    const bootstrapper = new MatrixCryptoBootstrapper(
      deps as unknown as MatrixCryptoBootstrapperDeps<MatrixRawEvent>,
    );

    await bootstrapper.bootstrap(crypto);

    expect(bootstrapCrossSigning).toHaveBeenCalledTimes(2);
    expect(bootstrapCrossSigning).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        authUploadDeviceSigningKeys: expect.any(Function),
      }),
    );
    expect(bootstrapCrossSigning).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        setupNewCrossSigning: true,
        authUploadDeviceSigningKeys: expect.any(Function),
      }),
    );
  });

  it("does not auto-reset cross-signing when automatic reset is disabled", async () => {
    const deps = createBootstrapperDeps();
    const bootstrapCrossSigning = vi.fn(async () => {});
    const crypto = createCryptoApi({
      bootstrapCrossSigning,
      isCrossSigningReady: vi.fn(async () => false),
      userHasCrossSigningKeys: vi.fn(async () => false),
      getDeviceVerificationStatus: vi.fn(async () => ({
        isVerified: () => true,
        localVerified: true,
        crossSigningVerified: false,
        signedByOwner: true,
      })),
    });
    const bootstrapper = new MatrixCryptoBootstrapper(
      deps as unknown as MatrixCryptoBootstrapperDeps<MatrixRawEvent>,
    );

    await bootstrapper.bootstrap(crypto, {
      allowAutomaticCrossSigningReset: false,
    });

    expect(bootstrapCrossSigning).toHaveBeenCalledTimes(1);
    expect(bootstrapCrossSigning).toHaveBeenCalledWith(
      expect.objectContaining({
        authUploadDeviceSigningKeys: expect.any(Function),
      }),
    );
  });

  it("refreshes published cross-signing keys before importing private keys from secret storage", async () => {
    const bootstrapCrossSigning = vi.fn(async () => {});
    const userHasCrossSigningKeys = vi.fn(async () => true);
    const { bootstrapper, crypto } = createBootstrapperHarness({
      bootstrapCrossSigning,
      getDeviceVerificationStatus: vi.fn(async () => createVerifiedDeviceStatus()),
      isCrossSigningReady: vi.fn(async () => true),
      userHasCrossSigningKeys,
    });

    await bootstrapper.bootstrap(crypto, {
      allowAutomaticCrossSigningReset: false,
    });

    expect(userHasCrossSigningKeys).toHaveBeenCalledWith("@bot:example.org", true);
    expect(userHasCrossSigningKeys.mock.invocationCallOrder[0]).toBeLessThan(
      bootstrapCrossSigning.mock.invocationCallOrder[0],
    );
  });

  it("passes explicit secret-storage repair allowance only when requested", async () => {
    const deps = createBootstrapperDeps();
    const crypto = createCryptoApi({
      getDeviceVerificationStatus: vi.fn(async () => ({
        isVerified: () => true,
        localVerified: true,
        crossSigningVerified: true,
        signedByOwner: true,
      })),
    });
    const bootstrapper = new MatrixCryptoBootstrapper(
      deps as unknown as MatrixCryptoBootstrapperDeps<MatrixRawEvent>,
    );

    await bootstrapper.bootstrap(crypto, {
      strict: true,
      allowSecretStorageRecreateWithoutRecoveryKey: true,
    });

    expect(deps.recoveryKeyStore.bootstrapSecretStorageWithRecoveryKey).toHaveBeenCalledWith(
      crypto,
      {
        allowSecretStorageRecreateWithoutRecoveryKey: true,
      },
    );
  });

  it("recreates secret storage and retries cross-signing when explicit bootstrap hits a stale server key", async () => {
    const { deps, crypto, bootstrapCrossSigning } = await runExplicitSecretStorageRepairScenario(
      "getSecretStorageKey callback returned falsey",
    );

    expectSecretStorageRepairRetry(deps, crypto, bootstrapCrossSigning);
    expect(bootstrapCrossSigning).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        authUploadDeviceSigningKeys: expect.any(Function),
      }),
    );
    expect(bootstrapCrossSigning).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        authUploadDeviceSigningKeys: expect.any(Function),
      }),
    );
  });

  it("recreates secret storage and retries cross-signing when explicit bootstrap hits bad MAC", async () => {
    const { deps, crypto, bootstrapCrossSigning } = await runExplicitSecretStorageRepairScenario(
      "Error decrypting secret m.cross_signing.master: bad MAC",
    );

    expectSecretStorageRepairRetry(deps, crypto, bootstrapCrossSigning);
  });

  it("does not mutate secret storage before forced repair fails on password UIA without a password", async () => {
    const deps = createBootstrapperDeps();
    deps.getPassword = vi.fn<() => string | undefined>(() => undefined);
    const bootstrapCrossSigning = vi.fn<
      ({
        authUploadDeviceSigningKeys,
      }: {
        authUploadDeviceSigningKeys?: <T>(
          makeRequest: (authData: Record<string, unknown> | null) => Promise<T>,
        ) => Promise<T>;
      }) => Promise<void>
    >(async ({ authUploadDeviceSigningKeys }) => {
      await authUploadDeviceSigningKeys?.(async (authData) => {
        if (authData === null) {
          throw new Error("need auth");
        }
        if (authData.type === "m.login.dummy") {
          throw new Error("dummy rejected");
        }
        return undefined;
      });
    });
    const crypto = createCryptoApi({
      bootstrapCrossSigning,
      getDeviceVerificationStatus: vi.fn(async () => createVerifiedDeviceStatus()),
    });
    const bootstrapper = new MatrixCryptoBootstrapper(
      deps as unknown as MatrixCryptoBootstrapperDeps<MatrixRawEvent>,
    );

    await expect(
      bootstrapper.bootstrap(crypto, {
        strict: true,
        forceResetCrossSigning: true,
        allowSecretStorageRecreateWithoutRecoveryKey: true,
      }),
    ).rejects.toThrow(
      "Matrix cross-signing key upload requires UIA; provide matrix.password for m.login.password fallback",
    );

    expect(deps.recoveryKeyStore.bootstrapSecretStorageWithRecoveryKey).not.toHaveBeenCalled();
  });

  it("recreates secret storage and retries a forced reset when stale server SSSS blocks it", async () => {
    const bootstrapCrossSigning = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("getSecretStorageKey callback returned falsey"))
      .mockResolvedValueOnce(undefined);
    const { deps, crypto, bootstrapper } = createBootstrapperHarness({
      bootstrapCrossSigning,
      isCrossSigningReady: vi.fn(async () => true),
      userHasCrossSigningKeys: vi.fn(async () => true),
      getDeviceVerificationStatus: vi.fn(async () => createVerifiedDeviceStatus()),
    });

    await bootstrapper.bootstrap(crypto, {
      strict: true,
      forceResetCrossSigning: true,
      allowSecretStorageRecreateWithoutRecoveryKey: true,
    });

    expect(deps.recoveryKeyStore.bootstrapSecretStorageWithRecoveryKey).toHaveBeenCalledWith(
      crypto,
      {
        allowSecretStorageRecreateWithoutRecoveryKey: true,
        forceNewSecretStorage: true,
      },
    );
    expect(bootstrapCrossSigning).toHaveBeenCalledTimes(3);
    expect(bootstrapCrossSigning).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        setupNewCrossSigning: true,
        authUploadDeviceSigningKeys: expect.any(Function),
      }),
    );
    expect(bootstrapCrossSigning).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        authUploadDeviceSigningKeys: expect.any(Function),
      }),
    );
  });

  it("re-exports cross-signing keys after forced reset creates secret storage", async () => {
    const bootstrapCrossSigning = vi.fn(async () => {});
    const { deps, crypto, bootstrapper } = createBootstrapperHarness({
      bootstrapCrossSigning,
      isCrossSigningReady: vi.fn(async () => true),
      userHasCrossSigningKeys: vi.fn(async () => true),
      getDeviceVerificationStatus: vi.fn(async () => createVerifiedDeviceStatus()),
    });

    await bootstrapper.bootstrap(crypto, {
      strict: true,
      forceResetCrossSigning: true,
      allowSecretStorageRecreateWithoutRecoveryKey: true,
    });

    expect(deps.recoveryKeyStore.bootstrapSecretStorageWithRecoveryKey).toHaveBeenCalledWith(
      crypto,
      {
        allowSecretStorageRecreateWithoutRecoveryKey: true,
      },
    );
    expect(bootstrapCrossSigning).toHaveBeenCalledTimes(2);
    expect(bootstrapCrossSigning).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        setupNewCrossSigning: true,
        authUploadDeviceSigningKeys: expect.any(Function),
      }),
    );
    expect(bootstrapCrossSigning).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        authUploadDeviceSigningKeys: expect.any(Function),
      }),
    );
  });

  it("fails in strict mode when cross-signing keys are still unpublished", async () => {
    const deps = createBootstrapperDeps();
    const crypto = createCryptoApi({
      bootstrapCrossSigning: vi.fn(async () => {}),
      isCrossSigningReady: vi.fn(async () => false),
      userHasCrossSigningKeys: vi.fn(async () => false),
      getDeviceVerificationStatus: vi.fn(async () => ({
        isVerified: () => true,
      })),
    });
    const bootstrapper = new MatrixCryptoBootstrapper(
      deps as unknown as MatrixCryptoBootstrapperDeps<MatrixRawEvent>,
    );

    await expect(bootstrapper.bootstrap(crypto, { strict: true })).rejects.toThrow(
      "Cross-signing bootstrap finished but server keys are still not published",
    );
  });

  it("uses password UIA fallback when null and dummy auth fail", async () => {
    const bootstrapCrossSigning = vi.fn(async () => {});
    const { bootstrapper, crypto } = createBootstrapperHarness({
      bootstrapCrossSigning,
      isCrossSigningReady: vi.fn(async () => true),
      userHasCrossSigningKeys: vi.fn(async () => true),
      getDeviceVerificationStatus: vi.fn(async () => ({
        isVerified: () => true,
      })),
    });

    await bootstrapper.bootstrap(crypto);

    const bootstrapCrossSigningCalls = bootstrapCrossSigning.mock.calls as Array<
      [
        {
          authUploadDeviceSigningKeys?: <T>(
            makeRequest: (authData: Record<string, unknown> | null) => Promise<T>,
          ) => Promise<T>;
        }?,
      ]
    >;
    const authUploadDeviceSigningKeys =
      bootstrapCrossSigningCalls[0]?.[0]?.authUploadDeviceSigningKeys;
    expect(authUploadDeviceSigningKeys).toBeTypeOf("function");

    const seenAuthStages: Array<Record<string, unknown> | null> = [];
    const result = await authUploadDeviceSigningKeys?.(async (authData) => {
      seenAuthStages.push(authData);
      if (authData === null) {
        throw new Error("need auth");
      }
      if (authData.type === "m.login.dummy") {
        throw new Error("dummy rejected");
      }
      if (authData.type === "m.login.password") {
        return "ok";
      }
      throw new Error("unexpected auth stage");
    });

    expect(result).toBe("ok");
    expect(seenAuthStages).toEqual([
      null,
      { type: "m.login.dummy" },
      {
        type: "m.login.password",
        identifier: { type: "m.id.user", user: "@bot:example.org" },
        password: "super-secret-password", // pragma: allowlist secret
      },
    ]);
  });

  it("resets cross-signing when first bootstrap attempt throws", async () => {
    const bootstrapCrossSigning = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("first attempt failed"))
      .mockResolvedValueOnce(undefined);
    const { bootstrapper, crypto } = createBootstrapperHarness({
      bootstrapCrossSigning,
      isCrossSigningReady: vi.fn(async () => true),
      userHasCrossSigningKeys: vi.fn(async () => true),
      getDeviceVerificationStatus: vi.fn(async () => ({
        isVerified: () => true,
      })),
    });

    await bootstrapper.bootstrap(crypto);

    expect(bootstrapCrossSigning).toHaveBeenCalledTimes(2);
    expect(bootstrapCrossSigning).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        setupNewCrossSigning: true,
        authUploadDeviceSigningKeys: expect.any(Function),
      }),
    );
  });

  it("marks own device verified and cross-signs it when needed", async () => {
    const deps = createBootstrapperDeps();
    const setDeviceVerified = vi.fn(async () => {});
    const crossSignDevice = vi.fn(async () => {});
    const crypto = createCryptoApi({
      getDeviceVerificationStatus: vi.fn(async () => ({
        isVerified: () => false,
        localVerified: false,
        crossSigningVerified: false,
        signedByOwner: false,
      })),
      setDeviceVerified,
      crossSignDevice,
      isCrossSigningReady: vi.fn(async () => true),
    });
    const bootstrapper = new MatrixCryptoBootstrapper(
      deps as unknown as MatrixCryptoBootstrapperDeps<MatrixRawEvent>,
    );

    await bootstrapper.bootstrap(crypto);

    expect(setDeviceVerified).toHaveBeenCalledWith("@bot:example.org", "DEVICE123", true);
    expect(crossSignDevice).toHaveBeenCalledWith("DEVICE123");
  });

  it("does not treat local-only trust as sufficient for own-device bootstrap", async () => {
    const deps = createBootstrapperDeps();
    const setDeviceVerified = vi.fn(async () => {});
    const crossSignDevice = vi.fn(async () => {});
    const getDeviceVerificationStatus = vi
      .fn<
        () => Promise<{
          isVerified: () => boolean;
          localVerified: boolean;
          crossSigningVerified: boolean;
          signedByOwner: boolean;
        }>
      >()
      .mockResolvedValueOnce({
        isVerified: () => true,
        localVerified: true,
        crossSigningVerified: false,
        signedByOwner: false,
      })
      .mockResolvedValueOnce({
        isVerified: () => true,
        localVerified: true,
        crossSigningVerified: true,
        signedByOwner: true,
      });
    const crypto = createCryptoApi({
      getDeviceVerificationStatus,
      setDeviceVerified,
      crossSignDevice,
      isCrossSigningReady: vi.fn(async () => true),
    });
    const bootstrapper = new MatrixCryptoBootstrapper(
      deps as unknown as MatrixCryptoBootstrapperDeps<MatrixRawEvent>,
    );

    await bootstrapper.bootstrap(crypto);

    expect(setDeviceVerified).toHaveBeenCalledWith("@bot:example.org", "DEVICE123", true);
    expect(crossSignDevice).toHaveBeenCalledWith("DEVICE123");
    expect(getDeviceVerificationStatus).toHaveBeenCalledTimes(2);
  });

  it("tracks incoming verification requests from other users", async () => {
    const { deps, listener } = await bootstrapWithVerificationRequestListener();
    const verificationRequest = {
      otherUserId: "@alice:example.org",
      isSelfVerification: false,
      initiatedByMe: false,
      accept: vi.fn(async () => {}),
    };
    listener?.(verificationRequest);

    expect(deps.verificationManager.trackVerificationRequest).toHaveBeenCalledWith(
      verificationRequest,
    );
    expect(verificationRequest.accept).not.toHaveBeenCalled();
  });

  it("does not touch request state when tracking summary throws", async () => {
    const { listener } = await bootstrapWithVerificationRequestListener({
      deps: {
        verificationManager: {
          trackVerificationRequest: vi.fn(() => {
            throw new Error("summary failure");
          }),
        },
      },
      crypto: {
        getDeviceVerificationStatus: vi.fn(async () => ({
          isVerified: () => true,
        })),
      },
    });

    const verificationRequest = {
      otherUserId: "@alice:example.org",
      isSelfVerification: false,
      initiatedByMe: false,
      accept: vi.fn(async () => {}),
    };
    listener?.(verificationRequest);

    expect(verificationRequest.accept).not.toHaveBeenCalled();
  });

  it("registers verification listeners only once across repeated bootstrap calls", async () => {
    const deps = createBootstrapperDeps();
    const crypto = createCryptoApi({
      getDeviceVerificationStatus: vi.fn(async () => ({
        isVerified: () => true,
      })),
    });
    const bootstrapper = new MatrixCryptoBootstrapper(
      deps as unknown as MatrixCryptoBootstrapperDeps<MatrixRawEvent>,
    );

    await bootstrapper.bootstrap(crypto);
    await bootstrapper.bootstrap(crypto);

    expect(crypto.on).toHaveBeenCalledTimes(1);
    expect(deps.decryptBridge.bindCryptoRetrySignals).toHaveBeenCalledTimes(1);
  });
});
