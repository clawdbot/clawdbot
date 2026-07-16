import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const ensureMatrixSdkLoggingConfiguredMock = vi.hoisted(() => vi.fn());
const resolveValidatedMatrixHomeserverUrlMock = vi.hoisted(() => vi.fn());
const maybeMigrateLegacyStorageMock = vi.hoisted(() => vi.fn(async () => undefined));
const resolveMatrixStoragePathsMock = vi.hoisted(() => vi.fn());
const writeStorageMetaMock = vi.hoisted(() => vi.fn());
const MatrixClientMock = vi.hoisted(() => vi.fn());

vi.mock("./logging.js", () => ({
  ensureMatrixSdkLoggingConfigured: ensureMatrixSdkLoggingConfiguredMock,
}));

vi.mock("./config.js", () => ({
  resolveValidatedMatrixHomeserverUrl: resolveValidatedMatrixHomeserverUrlMock,
}));

vi.mock("./storage.js", () => ({
  maybeMigrateLegacyStorage: maybeMigrateLegacyStorageMock,
  resolveMatrixStoragePaths: resolveMatrixStoragePathsMock,
  writeStorageMeta: writeStorageMetaMock,
}));

vi.mock("../sdk.js", () => ({
  MatrixClient: MatrixClientMock,
}));

let createMatrixClient: typeof import("./create-client.js").createMatrixClient;

describe("createMatrixClient", () => {
  const storagePaths = {
    rootDir: "/tmp/openclaw-matrix-create-client-test",
    storagePath: "/tmp/openclaw-matrix-create-client-test/storage.json",
    recoveryKeyPath: "/tmp/openclaw-matrix-create-client-test/recovery.key",
    idbSnapshotPath: "/tmp/openclaw-matrix-create-client-test/idb.snapshot",
    metaPath: "/tmp/openclaw-matrix-create-client-test/storage-meta.json",
    accountKey: "default",
    tokenHash: "token-hash",
  };

  beforeAll(async () => {
    ({ createMatrixClient } = await import("./create-client.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    ensureMatrixSdkLoggingConfiguredMock.mockReturnValue(undefined);
    resolveValidatedMatrixHomeserverUrlMock.mockResolvedValue("https://matrix.example.org");
    resolveMatrixStoragePathsMock.mockReturnValue(storagePaths);
    MatrixClientMock.mockImplementation(function MockMatrixClient() {
      return {
        stop: vi.fn(),
      };
    });
  });

  it("persists storage metadata by default", async () => {
    await createMatrixClient({
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "tok",
    });

    expect(writeStorageMetaMock).toHaveBeenCalledWith({
      storagePaths,
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accountId: undefined,
      deviceId: undefined,
    });
    expect(resolveMatrixStoragePathsMock).toHaveBeenCalledTimes(1);
    expect(MatrixClientMock).toHaveBeenCalledWith("https://matrix.example.org", "tok", {
      userId: "@bot:example.org",
      password: undefined,
      deviceId: undefined,
      encryption: undefined,
      localTimeoutMs: undefined,
      initialSyncLimit: undefined,
      storagePath: storagePaths.storagePath,
      recoveryKeyPath: storagePaths.recoveryKeyPath,
      idbSnapshotPath: storagePaths.idbSnapshotPath,
      cryptoDatabasePrefix: "openclaw-matrix-default-token-hash",
      autoBootstrapCrypto: undefined,
      ssrfPolicy: undefined,
      dispatcherPolicy: undefined,
    });
  });

  it("skips persistent storage wiring when persistence is disabled", async () => {
    await createMatrixClient({
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "tok",
      persistStorage: false,
    });

    expect(resolveMatrixStoragePathsMock).not.toHaveBeenCalled();
    expect(writeStorageMetaMock).not.toHaveBeenCalled();
    expect(MatrixClientMock).toHaveBeenCalledWith("https://matrix.example.org", "tok", {
      userId: "@bot:example.org",
      password: undefined,
      deviceId: undefined,
      encryption: undefined,
      localTimeoutMs: undefined,
      initialSyncLimit: undefined,
      storagePath: undefined,
      recoveryKeyPath: undefined,
      idbSnapshotPath: undefined,
      cryptoDatabasePrefix: undefined,
      autoBootstrapCrypto: undefined,
      ssrfPolicy: undefined,
      dispatcherPolicy: undefined,
    });
  });
});
