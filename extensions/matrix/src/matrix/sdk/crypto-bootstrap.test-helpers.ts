// Matrix helper module supports crypto bootstrap test harness behavior.
import { expect, vi, type Mock } from "vitest";
import { MatrixCryptoBootstrapper } from "./crypto-bootstrap.js";
import type { MatrixRecoveryKeyStore } from "./recovery-key-store.js";
import type { MatrixCryptoBootstrapApi, MatrixRawEvent } from "./types.js";

export type MatrixCryptoBootstrapperDeps<TRawEvent extends MatrixRawEvent> = ConstructorParameters<
  typeof MatrixCryptoBootstrapper<TRawEvent>
>[0];

export type BootstrapCrossSigningMock = Mock<MatrixCryptoBootstrapApi["bootstrapCrossSigning"]>;
export type MockCallSource = { mock: { calls: Array<Array<unknown>> } };

export function mockObjectArg(
  source: MockCallSource,
  label: string,
  callIndex = 0,
  argIndex = 0,
): Record<string, unknown> {
  const call = source.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected ${label} call ${callIndex} to exist`);
  }
  const value = call[argIndex];
  if (!value || typeof value !== "object") {
    throw new Error(`Expected ${label} call ${callIndex} argument ${argIndex} to be an object`);
  }
  return value as Record<string, unknown>;
}

export function expectBootstrapCrossSigningCall(
  source: MockCallSource,
  callNumber: number,
  expected?: { setupNewCrossSigning?: boolean },
) {
  const options = mockObjectArg(source, "bootstrapCrossSigning", callNumber - 1);
  expect(options.authUploadDeviceSigningKeys).toBeTypeOf("function");
  if (expected && "setupNewCrossSigning" in expected) {
    expect(options.setupNewCrossSigning).toBe(expected.setupNewCrossSigning);
  }
}

export function createBootstrapperDeps() {
  return {
    getUserId: vi.fn(async () => "@bot:example.org"),
    getPassword: vi.fn<() => string | undefined>(() => "super-secret-password"),
    canUnlockSecretStorage: vi.fn(async () => true),
    getDeviceId: vi.fn(() => "DEVICE123"),
    verificationManager: {
      trackVerificationRequest: vi.fn(),
    },
    recoveryKeyStore: {
      bootstrapSecretStorageWithRecoveryKey: vi.fn<
        MatrixRecoveryKeyStore["bootstrapSecretStorageWithRecoveryKey"]
      >(async () => {}),
    },
    decryptBridge: {
      bindCryptoRetrySignals: vi.fn(),
    },
  };
}

export function createCryptoApi(
  overrides?: Partial<MatrixCryptoBootstrapApi>,
): MatrixCryptoBootstrapApi {
  return {
    on: vi.fn(),
    bootstrapCrossSigning: vi.fn(async () => {}),
    bootstrapSecretStorage: vi.fn(async () => {}),
    requestOwnUserVerification: vi.fn(async () => null),
    ...overrides,
  };
}

export function createVerifiedDeviceStatus(overrides?: {
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

export function createBootstrapperHarness(
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
