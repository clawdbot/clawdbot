// Matrix tests cover crypto facade plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { createMatrixCryptoFacade } from "./crypto-facade.js";
import type { MatrixRecoveryKeyStore } from "./recovery-key-store.js";
import type { MatrixVerificationManager } from "./verification-manager.js";

type MatrixCryptoFacadeDeps = Parameters<typeof createMatrixCryptoFacade>[0];

function createVerificationManagerMock(
  overrides: Partial<MatrixVerificationManager> = {},
): MatrixVerificationManager {
  return {
    requestOwnUserVerification: vi.fn(async () => null),
    listVerifications: vi.fn(async () => []),
    ensureVerificationDmTracked: vi.fn(async () => null),
    requestVerification: vi.fn(),
    acceptVerification: vi.fn(),
    cancelVerification: vi.fn(),
    startVerification: vi.fn(),
    generateVerificationQr: vi.fn(),
    scanVerificationQr: vi.fn(),
    confirmVerificationSas: vi.fn(),
    mismatchVerificationSas: vi.fn(),
    confirmVerificationReciprocateQr: vi.fn(),
    getVerificationSas: vi.fn(),
    ...overrides,
  } as unknown as MatrixVerificationManager;
}

function createRecoveryKeyStoreMock(
  summary: ReturnType<MatrixRecoveryKeyStore["getRecoveryKeySummary"]> = null,
): MatrixRecoveryKeyStore {
  return {
    getRecoveryKeySummary: vi.fn(() => summary),
  } as unknown as MatrixRecoveryKeyStore;
}

function createFacadeHarness(params?: {
  client?: Partial<MatrixCryptoFacadeDeps["client"]>;
  verificationManager?: Partial<MatrixVerificationManager>;
  recoveryKeySummary?: ReturnType<MatrixRecoveryKeyStore["getRecoveryKeySummary"]>;
  isRoomEncrypted?: MatrixCryptoFacadeDeps["isRoomEncrypted"];
  downloadContent?: MatrixCryptoFacadeDeps["downloadContent"];
}) {
  const isRoomEncrypted: MatrixCryptoFacadeDeps["isRoomEncrypted"] =
    params?.isRoomEncrypted ?? (async () => false);
  const downloadContent: MatrixCryptoFacadeDeps["downloadContent"] =
    params?.downloadContent ?? (async () => Buffer.alloc(0));
  const facade = createMatrixCryptoFacade({
    client: {
      getCrypto: params?.client?.getCrypto ?? (() => undefined),
      getUserId: params?.client?.getUserId ?? (() => "@bot:example.org"),
    },
    verificationManager: createVerificationManagerMock(params?.verificationManager),
    recoveryKeyStore: createRecoveryKeyStoreMock(params?.recoveryKeySummary ?? null),
    isRoomEncrypted,
    downloadContent,
  });
  return { facade, isRoomEncrypted, downloadContent };
}

describe("createMatrixCryptoFacade", () => {
  it("delegates encrypted-room classification to the canonical client owner", async () => {
    const isRoomEncrypted = vi.fn(async () => true);
    const { facade } = createFacadeHarness({
      isRoomEncrypted,
    });

    await expect(facade.isRoomEncrypted("!room:example.org")).resolves.toBe(true);
    expect(isRoomEncrypted).toHaveBeenCalledWith("!room:example.org");
  });

  it("preserves authoritative plaintext-room classification", async () => {
    const isRoomEncrypted = vi.fn(async () => false);
    const { facade } = createFacadeHarness({
      isRoomEncrypted,
    });

    await expect(facade.isRoomEncrypted("!room:example.org")).resolves.toBe(false);
    expect(isRoomEncrypted).toHaveBeenCalledWith("!room:example.org");
  });

  it("never downgrades an existing malformed encryption event to plaintext", async () => {
    const { facade } = createFacadeHarness({
      isRoomEncrypted: async () => true,
    });

    await expect(facade.isRoomEncrypted("!room:example.org")).resolves.toBe(true);
  });

  it("propagates authoritative room-state failures without permitting plaintext", async () => {
    const error = new Error("Matrix room state authorization failed");
    const { facade } = createFacadeHarness({
      isRoomEncrypted: async () => {
        throw error;
      },
    });

    await expect(facade.isRoomEncrypted("!room:example.org")).rejects.toBe(error);
  });

  it("forwards verification requests and uses client crypto API", async () => {
    const crypto = { requestOwnUserVerification: vi.fn(async () => null) };
    const requestVerification = vi.fn(async () => ({
      id: "verification-1",
      otherUserId: "@alice:example.org",
      isSelfVerification: false,
      initiatedByMe: true,
      phase: 2,
      phaseName: "ready",
      pending: true,
      methods: ["m.sas.v1"],
      canAccept: false,
      hasSas: false,
      hasReciprocateQr: false,
      completed: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    const { facade } = createFacadeHarness({
      client: {
        getCrypto: () => crypto,
      },
      verificationManager: {
        requestVerification,
      },
      recoveryKeySummary: { keyId: "KEY" },
    });

    const result = await facade.requestVerification({
      userId: "@alice:example.org",
      deviceId: "DEVICE",
    });

    expect(requestVerification).toHaveBeenCalledWith(crypto, {
      userId: "@alice:example.org",
      deviceId: "DEVICE",
    });
    expect(result.id).toBe("verification-1");
    await expect(facade.getRecoveryKey()).resolves.toEqual({ keyId: "KEY" });
  });

  it("rehydrates in-progress DM verification requests from the raw crypto layer", async () => {
    const request = {
      transactionId: "txn-dm-in-progress",
      roomId: "!dm:example.org",
      otherUserId: "@alice:example.org",
      initiatedByMe: false,
      isSelfVerification: false,
      phase: 3,
      pending: true,
      accepting: false,
      declining: false,
      methods: ["m.sas.v1"],
      accept: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
      startVerification: vi.fn(),
      scanQRCode: vi.fn(),
      generateQRCode: vi.fn(),
      on: vi.fn(),
      verifier: undefined,
    };
    const trackVerificationRequest = vi.fn(() => ({
      id: "verification-1",
      transactionId: "txn-dm-in-progress",
      roomId: "!dm:example.org",
      otherUserId: "@alice:example.org",
      isSelfVerification: false,
      initiatedByMe: false,
      phase: 3,
      phaseName: "started",
      pending: true,
      methods: ["m.sas.v1"],
      canAccept: false,
      hasSas: false,
      hasReciprocateQr: false,
      completed: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    const crypto = {
      requestOwnUserVerification: vi.fn(async () => null),
      findVerificationRequestDMInProgress: vi.fn(() => request),
    };
    const { facade } = createFacadeHarness({
      client: {
        getCrypto: () => crypto,
      },
      verificationManager: {
        trackVerificationRequest,
      },
    });

    const summary = await facade.ensureVerificationDmTracked({
      roomId: "!dm:example.org",
      userId: "@alice:example.org",
    });

    expect(crypto.findVerificationRequestDMInProgress).toHaveBeenCalledWith(
      "!dm:example.org",
      "@alice:example.org",
    );
    expect(trackVerificationRequest).toHaveBeenCalledWith(request);
    expect(summary?.transactionId).toBe("txn-dm-in-progress");
  });

  it("rehydrates in-progress to-device verification requests before listing", async () => {
    const request = {
      transactionId: "txn-self-in-progress",
      otherUserId: "@bot:example.org",
      initiatedByMe: true,
      isSelfVerification: true,
      phase: 2,
      pending: true,
      accepting: false,
      declining: false,
      methods: ["m.sas.v1"],
      accept: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
      startVerification: vi.fn(),
      scanQRCode: vi.fn(),
      generateQRCode: vi.fn(),
      on: vi.fn(),
      verifier: undefined,
    };
    const tracked = {
      id: "verification-1",
      transactionId: "txn-self-in-progress",
      otherUserId: "@bot:example.org",
      isSelfVerification: true,
      initiatedByMe: true,
      phase: 2,
      phaseName: "ready",
      pending: true,
      methods: ["m.sas.v1"],
      canAccept: false,
      hasSas: false,
      hasReciprocateQr: false,
      completed: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const trackVerificationRequest = vi.fn(() => tracked);
    const listVerifications = vi.fn(() => [tracked]);
    const crypto = {
      getVerificationRequestsToDeviceInProgress: vi.fn(() => [request]),
      requestOwnUserVerification: vi.fn(async () => null),
    };
    const { facade } = createFacadeHarness({
      client: {
        getCrypto: () => crypto,
        getUserId: () => "@bot:example.org",
      },
      verificationManager: {
        listVerifications,
        trackVerificationRequest,
      },
    });

    const summaries = await facade.listVerifications();

    expect(crypto.getVerificationRequestsToDeviceInProgress).toHaveBeenCalledWith(
      "@bot:example.org",
    );
    expect(trackVerificationRequest).toHaveBeenCalledWith(request);
    expect(summaries).toEqual([tracked]);
  });
});
