import type { MatrixVerificationBootstrapResult } from "@openclaw/matrix/test-api.js";
import type { MatrixQaScenarioContext } from "./scenario-runtime-shared.js";

export function createMatrixQaE2eeTestContext(
  overrides: Partial<MatrixQaScenarioContext> = {},
): MatrixQaScenarioContext {
  return {
    baseUrl: "http://127.0.0.1:9",
    driverAccessToken: "driver-test-token",
    driverUserId: "@driver:matrix-qa.test",
    observedEvents: [],
    observerAccessToken: "observer-test-token",
    observerUserId: "@observer:matrix-qa.test",
    outputDir: "unused-output",
    registrationToken: "registration-test-token",
    roomId: "!room:matrix-qa.test",
    sutAccessToken: "sut-test-token",
    sutUserId: "@sut:matrix-qa.test",
    syncState: {},
    timeoutMs: 1_000,
    topology: { defaultRoomId: "!room:matrix-qa.test", defaultRoomKey: "main", rooms: [] },
    ...overrides,
  };
}

export function createMatrixQaBootstrapFailure(): MatrixVerificationBootstrapResult {
  return {
    success: false,
    error: "Matrix room key backup is not usable",
    cryptoBootstrap: null,
    pendingVerifications: 0,
    crossSigning: {
      userId: null,
      masterKeyPublished: false,
      selfSigningKeyPublished: false,
      userSigningKeyPublished: false,
      published: false,
    },
    verification: {
      encryptionEnabled: true,
      userId: null,
      deviceId: null,
      verified: false,
      localVerified: false,
      crossSigningVerified: false,
      signedByOwner: false,
      recoveryKeyStored: false,
      recoveryKeyCreatedAt: null,
      recoveryKeyId: null,
      backupVersion: null,
      serverDeviceKnown: null,
      backup: {
        serverVersion: null,
        activeVersion: null,
        trusted: null,
        matchesDecryptionKey: null,
        decryptionKeyCached: null,
        keyLoadAttempted: false,
        keyLoadError: null,
      },
    },
  };
}
