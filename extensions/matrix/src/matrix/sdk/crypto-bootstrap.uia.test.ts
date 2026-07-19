// Matrix tests cover crypto bootstrap UIA challenge routing behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MatrixCryptoBootstrapper } from "./crypto-bootstrap.js";
import {
  createBootstrapperDeps,
  createBootstrapperHarness,
  createCryptoApi,
  createVerifiedDeviceStatus,
  expectBootstrapCrossSigningCall,
  mockObjectArg,
  type MatrixCryptoBootstrapperDeps,
} from "./crypto-bootstrap.test-helpers.js";
import type { MatrixRawEvent, MatrixUiaResponseBody } from "./types.js";

function uiaChallengeError(body: MatrixUiaResponseBody) {
  const err = new Error("Auth required") as Error & {
    httpStatus: number;
    data: MatrixUiaResponseBody;
  };
  err.httpStatus = 401;
  err.data = body;
  return err;
}

function expectResetRequiredError(
  caught: unknown,
): Error & { resetUrl?: string; session?: string; stages: string[] } {
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).name).toBe("MatrixCrossSigningResetRequiredError");
  return caught as Error & { resetUrl?: string; session?: string; stages: string[] };
}

type UiAuthCallback = <T>(
  makeRequest: (authData: Record<string, unknown> | null) => Promise<T>,
) => Promise<T>;

async function createUiAuthCallbackHarness(opts?: { password: string | undefined }) {
  const bootstrapCrossSigning = vi.fn(async () => {});
  const { bootstrapper, crypto } = createBootstrapperHarness(
    {
      bootstrapCrossSigning,
      isCrossSigningReady: vi.fn(async () => true),
      userHasCrossSigningKeys: vi.fn(async () => true),
      getDeviceVerificationStatus: vi.fn(async () => createVerifiedDeviceStatus()),
    },
    opts ? { getPassword: vi.fn<() => string | undefined>(() => opts.password) } : undefined,
  );

  await bootstrapper.bootstrap(crypto);

  const authUploadDeviceSigningKeys = mockObjectArg(bootstrapCrossSigning, "bootstrapCrossSigning")
    .authUploadDeviceSigningKeys as UiAuthCallback;
  expect(authUploadDeviceSigningKeys).toBeTypeOf("function");
  return { authUploadDeviceSigningKeys };
}

describe("MatrixCryptoBootstrapper UIA", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
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
          throw uiaChallengeError({
            flows: [{ stages: ["m.login.password"] }],
            session: "sess-pw",
          });
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
      "Matrix cross-signing key upload requires UIA stages this client cannot satisfy non-interactively: m.login.password. Set matrix.password to enable the m.login.password fallback.",
    );

    expect(deps.recoveryKeyStore.bootstrapSecretStorageWithRecoveryKey).not.toHaveBeenCalled();
    expect(bootstrapCrossSigning).toHaveBeenCalledTimes(1);
  });

  it("uses password UIA fallback when the homeserver advertises m.login.password", async () => {
    const { authUploadDeviceSigningKeys } = await createUiAuthCallbackHarness();

    const seenAuthStages: Array<Record<string, unknown> | null> = [];
    const result = await authUploadDeviceSigningKeys(async (authData) => {
      seenAuthStages.push(authData);
      if (authData === null) {
        throw uiaChallengeError({
          flows: [{ stages: ["m.login.password"] }],
          session: "sess-pw",
        });
      }
      if (authData.type === "m.login.password") {
        return "ok";
      }
      throw new Error("unexpected auth stage");
    });

    expect(result).toBe("ok");
    expect(seenAuthStages).toEqual([
      null,
      {
        type: "m.login.password",
        identifier: { type: "m.id.user", user: "@bot:example.org" },
        password: "super-secret-password", // pragma: allowlist secret
        session: "sess-pw",
      },
    ]);
  });

  it("routes to the advertised dummy stage and threads the UIA session token", async () => {
    const { authUploadDeviceSigningKeys } = await createUiAuthCallbackHarness();

    const seenAuthStages: Array<Record<string, unknown> | null> = [];
    const result = await authUploadDeviceSigningKeys(async (authData) => {
      seenAuthStages.push(authData);
      if (authData === null) {
        throw uiaChallengeError({
          flows: [{ stages: ["m.login.dummy"] }, { stages: ["m.login.password"] }],
          session: "sess-dummy",
        });
      }
      if (authData.type === "m.login.dummy") {
        return "ok";
      }
      throw new Error("unexpected auth stage");
    });

    expect(result).toBe("ok");
    expect(seenAuthStages).toEqual([null, { type: "m.login.dummy", session: "sess-dummy" }]);
  });

  it("completes the advertised dummy flow instead of raising reset guidance on a mixed challenge", async () => {
    const { authUploadDeviceSigningKeys } = await createUiAuthCallbackHarness();

    const seenAuthStages: Array<Record<string, unknown> | null> = [];
    const result = await authUploadDeviceSigningKeys(async (authData) => {
      seenAuthStages.push(authData);
      if (authData === null) {
        throw uiaChallengeError({
          flows: [{ stages: ["org.matrix.cross_signing_reset"] }, { stages: ["m.login.dummy"] }],
          session: "sess-mixed",
          params: {
            "org.matrix.cross_signing_reset": { url: "https://mas.example.org/account/" },
          },
        });
      }
      if (authData.type === "m.login.dummy") {
        return "ok";
      }
      throw new Error("unexpected auth stage");
    });

    expect(result).toBe("ok");
    expect(seenAuthStages).toEqual([null, { type: "m.login.dummy", session: "sess-mixed" }]);
  });

  it("completes the advertised password flow when the reset flow is only an alternative", async () => {
    const { authUploadDeviceSigningKeys } = await createUiAuthCallbackHarness();

    const seenAuthStages: Array<Record<string, unknown> | null> = [];
    const result = await authUploadDeviceSigningKeys(async (authData) => {
      seenAuthStages.push(authData);
      if (authData === null) {
        throw uiaChallengeError({
          flows: [{ stages: ["org.matrix.cross_signing_reset"] }, { stages: ["m.login.password"] }],
          session: "sess-mixed-pw",
        });
      }
      if (authData.type === "m.login.password") {
        return "ok";
      }
      throw new Error("unexpected auth stage");
    });

    expect(result).toBe("ok");
    expect(seenAuthStages).toEqual([
      null,
      {
        type: "m.login.password",
        identifier: { type: "m.id.user", user: "@bot:example.org" },
        password: "super-secret-password", // pragma: allowlist secret
        session: "sess-mixed-pw",
      },
    ]);
  });

  it("raises reset guidance on a mixed challenge only when the alternative flow needs an unavailable password", async () => {
    const masUrl = "https://mas.example.org/account/cross_signing_reset?token=mixed";
    const { authUploadDeviceSigningKeys } = await createUiAuthCallbackHarness({
      password: undefined,
    });

    let caught: unknown;
    try {
      await authUploadDeviceSigningKeys(async (authData) => {
        if (authData === null) {
          throw uiaChallengeError({
            flows: [
              { stages: ["org.matrix.cross_signing_reset"] },
              { stages: ["m.login.password"] },
            ],
            session: "sess-mixed-reset",
            params: { "org.matrix.cross_signing_reset": { url: masUrl } },
          });
        }
        return "unexpected";
      });
    } catch (err) {
      caught = err;
    }

    const resetErr = expectResetRequiredError(caught);
    expect(resetErr.resetUrl).toBe(masUrl);
    expect(resetErr.session).toBe("sess-mixed-reset");
  });

  it("completes a multi-stage flow by following the server's completed progress", async () => {
    const { authUploadDeviceSigningKeys } = await createUiAuthCallbackHarness();

    const seenAuthStages: Array<Record<string, unknown> | null> = [];
    const result = await authUploadDeviceSigningKeys(async (authData) => {
      seenAuthStages.push(authData);
      if (authData === null) {
        throw uiaChallengeError({
          flows: [{ stages: ["m.login.password", "m.login.dummy"] }],
          session: "sess-multi",
        });
      }
      if (authData.type === "m.login.password") {
        throw uiaChallengeError({
          flows: [{ stages: ["m.login.password", "m.login.dummy"] }],
          completed: ["m.login.password"],
          session: "sess-multi",
        });
      }
      if (authData.type === "m.login.dummy") {
        return "ok";
      }
      throw new Error("unexpected auth stage");
    });

    expect(result).toBe("ok");
    expect(seenAuthStages).toEqual([
      null,
      {
        type: "m.login.password",
        identifier: { type: "m.id.user", user: "@bot:example.org" },
        password: "super-secret-password", // pragma: allowlist secret
        session: "sess-multi",
      },
      { type: "m.login.dummy", session: "sess-multi" },
    ]);
  });

  it("surfaces the server rejection when a submitted stage does not advance the flow", async () => {
    const { authUploadDeviceSigningKeys } = await createUiAuthCallbackHarness();

    let attempts = 0;
    await expect(
      authUploadDeviceSigningKeys(async (authData) => {
        attempts += 1;
        if (authData === null) {
          throw uiaChallengeError({
            flows: [{ stages: ["m.login.password"] }],
            session: "sess-rejected",
          });
        }
        const rejection = uiaChallengeError({
          flows: [{ stages: ["m.login.password"] }],
          session: "sess-rejected",
        });
        rejection.message = "Invalid password";
        throw rejection;
      }),
    ).rejects.toThrow("Invalid password");

    expect(attempts).toBe(2);
  });

  it("rethrows non-UIA upload failures instead of suggesting matrix.password", async () => {
    const { authUploadDeviceSigningKeys } = await createUiAuthCallbackHarness();

    await expect(
      authUploadDeviceSigningKeys(async () => {
        throw new Error("network unreachable");
      }),
    ).rejects.toThrow("network unreachable");
  });

  it("surfaces the MAS reset URL instead of the misleading password hint", async () => {
    const masUrl = "https://mas.example.org/account/cross_signing_reset?token=abc";
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
          throw uiaChallengeError({
            flows: [{ stages: ["org.matrix.cross_signing_reset"] }],
            session: "sess-mas",
            params: { "org.matrix.cross_signing_reset": { url: masUrl } },
          });
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

    let caught: unknown;
    try {
      await bootstrapper.bootstrap(crypto, {
        strict: true,
        forceResetCrossSigning: true,
        allowSecretStorageRecreateWithoutRecoveryKey: true,
      });
    } catch (err) {
      caught = err;
    }

    const resetErr = expectResetRequiredError(caught);
    expect(resetErr.resetUrl).toBe(masUrl);
    expect(resetErr.session).toBe("sess-mas");
    expect(resetErr.stages).toContain("org.matrix.cross_signing_reset");
    expect(resetErr.message).toContain(masUrl);
    expect(deps.recoveryKeyStore.bootstrapSecretStorageWithRecoveryKey).not.toHaveBeenCalled();
  });

  it("surfaces the m.oauth reset stage with its advertised URL", async () => {
    const oauthUrl = "https://mas.example.org/account/?action=org.matrix.cross_signing_reset";
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
          throw uiaChallengeError({
            flows: [{ stages: ["m.oauth"] }],
            session: "sess-oauth",
            params: { "m.oauth": { url: oauthUrl } },
          });
        }
        return undefined;
      });
    });
    const { bootstrapper, crypto } = createBootstrapperHarness({
      bootstrapCrossSigning,
      getDeviceVerificationStatus: vi.fn(async () => createVerifiedDeviceStatus()),
    });

    let caught: unknown;
    try {
      await bootstrapper.bootstrap(crypto, { strict: true });
    } catch (err) {
      caught = err;
    }

    expect(expectResetRequiredError(caught).resetUrl).toBe(oauthUrl);
  });

  it("does not retry with a fresh-identity reset after the MAS reset stage rejects the upload", async () => {
    const bootstrapCrossSigning = vi.fn<
      ({
        authUploadDeviceSigningKeys,
      }: {
        setupNewCrossSigning?: boolean;
        authUploadDeviceSigningKeys?: <T>(
          makeRequest: (authData: Record<string, unknown> | null) => Promise<T>,
        ) => Promise<T>;
      }) => Promise<void>
    >(async ({ authUploadDeviceSigningKeys }) => {
      await authUploadDeviceSigningKeys?.(async (authData) => {
        if (authData === null) {
          throw uiaChallengeError({
            flows: [{ stages: ["org.matrix.cross_signing_reset"] }],
            session: "sess-mas",
          });
        }
        return undefined;
      });
    });
    const { bootstrapper, crypto } = createBootstrapperHarness({
      bootstrapCrossSigning,
      isCrossSigningReady: vi.fn(async () => false),
      userHasCrossSigningKeys: vi.fn(async () => false),
      getDeviceVerificationStatus: vi.fn(async () => createVerifiedDeviceStatus()),
    });

    const result = await bootstrapper.bootstrap(crypto);

    expect(result.crossSigningPublished).toBe(false);
    expect(bootstrapCrossSigning).toHaveBeenCalledTimes(1);
    expect(
      mockObjectArg(bootstrapCrossSigning, "bootstrapCrossSigning").setupNewCrossSigning,
    ).not.toBe(true);
  });

  it("attempts the reset upload after an import-key mismatch so a fresh MAS approval can land", async () => {
    const masUrl = "https://mas.example.org/account/cross_signing_reset?token=xyz";
    const bootstrapCrossSigning = vi
      .fn<
        ({
          authUploadDeviceSigningKeys,
        }: {
          setupNewCrossSigning?: boolean;
          authUploadDeviceSigningKeys?: <T>(
            makeRequest: (authData: Record<string, unknown> | null) => Promise<T>,
          ) => Promise<T>;
        }) => Promise<void>
      >()
      .mockImplementationOnce(async () => {
        throw new Error(
          "Error while importing m.cross_signing.master: The public key of the imported private key doesn't match the public key that was uploaded to the server",
        );
      })
      .mockImplementationOnce(async ({ authUploadDeviceSigningKeys }) => {
        await authUploadDeviceSigningKeys?.(async (authData) => {
          if (authData === null) {
            throw uiaChallengeError({
              flows: [{ stages: ["org.matrix.cross_signing_reset"] }],
              session: "sess-mas",
              params: { "org.matrix.cross_signing_reset": { url: masUrl } },
            });
          }
          return undefined;
        });
      });
    const { bootstrapper, crypto } = createBootstrapperHarness({
      bootstrapCrossSigning,
      isCrossSigningReady: vi.fn(async () => false),
      userHasCrossSigningKeys: vi.fn(async () => true),
      getDeviceVerificationStatus: vi.fn(async () => createVerifiedDeviceStatus()),
    });

    let caught: unknown;
    try {
      await bootstrapper.bootstrap(crypto, { strict: true });
    } catch (err) {
      caught = err;
    }

    expect(expectResetRequiredError(caught).resetUrl).toBe(masUrl);
    expect(bootstrapCrossSigning).toHaveBeenCalledTimes(2);
    expectBootstrapCrossSigningCall(bootstrapCrossSigning, 2, { setupNewCrossSigning: true });
  });

  it("publishes the first identity through the MSC3967 no-auth upload", async () => {
    const { authUploadDeviceSigningKeys } = await createUiAuthCallbackHarness();

    const seenAuthStages: Array<Record<string, unknown> | null> = [];
    const result = await authUploadDeviceSigningKeys(async (authData) => {
      seenAuthStages.push(authData);
      return "ok";
    });

    expect(result).toBe("ok");
    expect(seenAuthStages).toEqual([null]);
  });
});
