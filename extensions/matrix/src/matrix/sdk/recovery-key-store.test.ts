import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { encodeRecoveryKey } from "matrix-js-sdk/lib/crypto-api/recovery-key.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MatrixRecoveryKeyStore } from "./recovery-key-store.js";
import type { MatrixCryptoBootstrapApi, MatrixSecretStorageStatus } from "./types.js";

function createTempRecoveryKeyPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-recovery-key-store-"));
  return path.join(dir, "recovery-key.json");
}

const EXPECTS_POSIX_PRIVATE_FILE_MODE = process.platform !== "win32";

function createGeneratedRecoveryKey(params: {
  keyId: string;
  name: string;
  bytes: number[];
  encodedPrivateKey: string;
}) {
  return {
    keyId: params.keyId,
    keyInfo: { name: params.name },
    privateKey: new Uint8Array(params.bytes),
    encodedPrivateKey: params.encodedPrivateKey,
  };
}

function createBootstrapSecretStorageMock(errorMessage?: string) {
  return vi.fn(
    async (opts?: {
      setupNewSecretStorage?: boolean;
      createSecretStorageKey?: () => Promise<unknown>;
    }) => {
      if (opts?.setupNewSecretStorage || !errorMessage) {
        await opts?.createSecretStorageKey?.();
        return;
      }
      throw new Error(errorMessage);
    },
  );
}

function createRecoveryKeyCrypto(params: {
  bootstrapSecretStorage: ReturnType<typeof vi.fn>;
  createRecoveryKeyFromPassphrase: ReturnType<typeof vi.fn>;
  status: MatrixSecretStorageStatus;
}): MatrixCryptoBootstrapApi {
  return {
    on: vi.fn(),
    bootstrapCrossSigning: vi.fn(async () => {}),
    bootstrapSecretStorage: params.bootstrapSecretStorage,
    createRecoveryKeyFromPassphrase: params.createRecoveryKeyFromPassphrase,
    getSecretStorageStatus: vi.fn(async () => params.status),
    requestOwnUserVerification: vi.fn(async () => null),
  } as unknown as MatrixCryptoBootstrapApi;
}

function bootstrapSecretStorageCallArg(
  bootstrapSecretStorage: ReturnType<typeof vi.fn>,
  index: number,
) {
  const call = bootstrapSecretStorage.mock.calls[index];
  if (!call) {
    throw new Error(`expected bootstrapSecretStorage call ${index}`);
  }
  return call[0] as { setupNewSecretStorage?: boolean } | undefined;
}

function expectRecoveryKeySummary(
  store: MatrixRecoveryKeyStore,
  expected: { keyId: string; encodedPrivateKey?: string },
) {
  const summary = store.getRecoveryKeySummary();
  if (!summary) {
    throw new Error("expected recovery key summary");
  }
  expect(summary.keyId).toBe(expected.keyId);
  if (expected.encodedPrivateKey !== undefined) {
    expect(summary.encodedPrivateKey).toBe(expected.encodedPrivateKey);
  }
}

async function runSecretStorageBootstrapScenario(params: {
  generated: ReturnType<typeof createGeneratedRecoveryKey>;
  status: MatrixSecretStorageStatus;
  allowSecretStorageRecreateWithoutRecoveryKey?: boolean;
  firstBootstrapError?: string;
}) {
  const recoveryKeyPath = createTempRecoveryKeyPath();
  const store = new MatrixRecoveryKeyStore(recoveryKeyPath);
  const createRecoveryKeyFromPassphrase = vi.fn(async () => params.generated);
  const bootstrapSecretStorage = createBootstrapSecretStorageMock(params.firstBootstrapError);
  const crypto = createRecoveryKeyCrypto({
    bootstrapSecretStorage,
    createRecoveryKeyFromPassphrase,
    status: params.status,
  });

  await store.bootstrapSecretStorageWithRecoveryKey(crypto, {
    allowSecretStorageRecreateWithoutRecoveryKey:
      params.allowSecretStorageRecreateWithoutRecoveryKey ?? false,
  });

  return {
    store,
    createRecoveryKeyFromPassphrase,
    bootstrapSecretStorage,
  };
}

describe("MatrixRecoveryKeyStore", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("loads a stored recovery key for requested secret-storage keys", async () => {
    const recoveryKeyPath = createTempRecoveryKeyPath();
    fs.writeFileSync(
      recoveryKeyPath,
      JSON.stringify({
        version: 1,
        createdAt: new Date().toISOString(),
        keyId: "SSSS",
        privateKeyBase64: Buffer.from([1, 2, 3, 4]).toString("base64"),
      }),
      "utf8",
    );

    const store = new MatrixRecoveryKeyStore(recoveryKeyPath);
    const callbacks = store.buildCryptoCallbacks();
    const resolved = await callbacks.getSecretStorageKey?.(
      { keys: { SSSS: { name: "test" } } },
      "m.cross_signing.master",
    );

    expect(resolved?.[0]).toBe("SSSS");
    expect(Array.from(resolved?.[1] ?? [])).toEqual([1, 2, 3, 4]);
  });

  it("persists cached secret-storage keys with secure file permissions", () => {
    const recoveryKeyPath = createTempRecoveryKeyPath();
    const store = new MatrixRecoveryKeyStore(recoveryKeyPath);
    const callbacks = store.buildCryptoCallbacks();

    callbacks.cacheSecretStorageKey?.(
      "KEY123",
      {
        name: "openclaw",
      },
      new Uint8Array([9, 8, 7]),
    );

    const saved = JSON.parse(fs.readFileSync(recoveryKeyPath, "utf8")) as {
      keyId?: string;
      privateKeyBase64?: string;
    };
    expect(saved.keyId).toBe("KEY123");
    expect(saved.privateKeyBase64).toBe(Buffer.from([9, 8, 7]).toString("base64"));

    const mode = fs.statSync(recoveryKeyPath).mode & 0o777;
    if (EXPECTS_POSIX_PRIVATE_FILE_MODE) {
      expect(mode).toBe(0o600);
    }
  });

  it("creates and persists a recovery key when secret storage is missing", async () => {
    const { store, createRecoveryKeyFromPassphrase, bootstrapSecretStorage } =
      await runSecretStorageBootstrapScenario({
        generated: createGeneratedRecoveryKey({
          keyId: "GENERATED",
          name: "generated",
          bytes: [5, 6, 7, 8],
          encodedPrivateKey: "encoded-generated-key", // pragma: allowlist secret
        }),
        status: { ready: false, defaultKeyId: null },
      });

    expect(createRecoveryKeyFromPassphrase).toHaveBeenCalledTimes(1);
    expect(bootstrapSecretStorageCallArg(bootstrapSecretStorage, 0)?.setupNewSecretStorage).toBe(
      true,
    );
    expectRecoveryKeySummary(store, {
      keyId: "GENERATED",
      encodedPrivateKey: "encoded-generated-key", // pragma: allowlist secret
    });
  });

  it("rebinds stored recovery key to server default key id when it changes", async () => {
    const recoveryKeyPath = createTempRecoveryKeyPath();
    fs.writeFileSync(
      recoveryKeyPath,
      JSON.stringify({
        version: 1,
        createdAt: new Date().toISOString(),
        keyId: "OLD",
        privateKeyBase64: Buffer.from([1, 2, 3, 4]).toString("base64"),
      }),
      "utf8",
    );
    const store = new MatrixRecoveryKeyStore(recoveryKeyPath);

    const bootstrapSecretStorage = vi.fn(async () => {});
    const createRecoveryKeyFromPassphrase = vi.fn(async () => {
      throw new Error("should not be called");
    });
    const crypto = {
      on: vi.fn(),
      bootstrapCrossSigning: vi.fn(async () => {}),
      bootstrapSecretStorage,
      createRecoveryKeyFromPassphrase,
      getSecretStorageStatus: vi.fn(async () => ({ ready: true, defaultKeyId: "NEW" })),
      requestOwnUserVerification: vi.fn(async () => null),
    } as unknown as MatrixCryptoBootstrapApi;

    await store.bootstrapSecretStorageWithRecoveryKey(crypto);

    expect(createRecoveryKeyFromPassphrase).not.toHaveBeenCalled();
    expectRecoveryKeySummary(store, {
      keyId: "NEW",
    });
  });

  it("recreates secret storage when default key exists but is not usable locally", async () => {
    const { store, createRecoveryKeyFromPassphrase, bootstrapSecretStorage } =
      await runSecretStorageBootstrapScenario({
        generated: createGeneratedRecoveryKey({
          keyId: "RECOVERED",
          name: "recovered",
          bytes: [1, 1, 2, 3],
          encodedPrivateKey: "encoded-recovered-key", // pragma: allowlist secret
        }),
        status: { ready: false, defaultKeyId: "LEGACY" },
      });

    expect(createRecoveryKeyFromPassphrase).toHaveBeenCalledTimes(1);
    expect(bootstrapSecretStorageCallArg(bootstrapSecretStorage, 0)?.setupNewSecretStorage).toBe(
      true,
    );
    expectRecoveryKeySummary(store, {
      keyId: "RECOVERED",
      encodedPrivateKey: "encoded-recovered-key", // pragma: allowlist secret
    });
  });

  it("recreates secret storage during explicit bootstrap when the server key exists but no local recovery key is available", async () => {
    const { store, createRecoveryKeyFromPassphrase, bootstrapSecretStorage } =
      await runSecretStorageBootstrapScenario({
        generated: createGeneratedRecoveryKey({
          keyId: "REPAIRED",
          name: "repaired",
          bytes: [7, 7, 8, 9],
          encodedPrivateKey: "encoded-repaired-key", // pragma: allowlist secret
        }),
        status: {
          ready: true,
          defaultKeyId: "LEGACY",
          secretStorageKeyValidityMap: { LEGACY: true },
        },
        allowSecretStorageRecreateWithoutRecoveryKey: true,
        firstBootstrapError: "getSecretStorageKey callback returned falsey",
      });

    expect(createRecoveryKeyFromPassphrase).toHaveBeenCalledTimes(1);
    expect(bootstrapSecretStorage).toHaveBeenCalledTimes(2);
    expect(bootstrapSecretStorageCallArg(bootstrapSecretStorage, 1)?.setupNewSecretStorage).toBe(
      true,
    );
    expectRecoveryKeySummary(store, {
      keyId: "REPAIRED",
      encodedPrivateKey: "encoded-repaired-key", // pragma: allowlist secret
    });
  });

  it("recreates secret storage during explicit bootstrap when decrypting a stored secret fails with bad MAC", async () => {
    const { createRecoveryKeyFromPassphrase, bootstrapSecretStorage } =
      await runSecretStorageBootstrapScenario({
        generated: createGeneratedRecoveryKey({
          keyId: "REPAIRED",
          name: "repaired",
          bytes: [7, 7, 8, 9],
          encodedPrivateKey: "encoded-repaired-key", // pragma: allowlist secret
        }),
        status: {
          ready: true,
          defaultKeyId: "LEGACY",
          secretStorageKeyValidityMap: { LEGACY: true },
        },
        allowSecretStorageRecreateWithoutRecoveryKey: true,
        firstBootstrapError: "Error decrypting secret m.cross_signing.master: bad MAC",
      });

    expect(createRecoveryKeyFromPassphrase).toHaveBeenCalledTimes(1);
    expect(bootstrapSecretStorage).toHaveBeenCalledTimes(2);
    expect(bootstrapSecretStorageCallArg(bootstrapSecretStorage, 1)?.setupNewSecretStorage).toBe(
      true,
    );
  });

  it("stores an encoded recovery key and decodes its private key material", () => {
    const recoveryKeyPath = createTempRecoveryKeyPath();
    const store = new MatrixRecoveryKeyStore(recoveryKeyPath);
    const encoded = encodeRecoveryKey(new Uint8Array(Array.from({ length: 32 }, (_, i) => i + 1)));
    expect(encoded).toBeTypeOf("string");

    const summary = store.storeEncodedRecoveryKey({
      encodedPrivateKey: encoded as string,
      keyId: "SSSSKEY",
    });

    expect(summary.keyId).toBe("SSSSKEY");
    expect(summary.encodedPrivateKey).toBe(encoded);
    const persisted = JSON.parse(fs.readFileSync(recoveryKeyPath, "utf8")) as {
      privateKeyBase64?: string;
      keyId?: string;
    };
    expect(persisted.keyId).toBe("SSSSKEY");
    expect(
      Buffer.from(persisted.privateKeyBase64 ?? "", "base64").equals(
        Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)),
      ),
    ).toBe(true);
  });

  it("stages a recovery key for secret storage without persisting it until commit", async () => {
    const recoveryKeyPath = createTempRecoveryKeyPath();
    fs.rmSync(recoveryKeyPath, { force: true });
    const store = new MatrixRecoveryKeyStore(recoveryKeyPath);
    const encoded = encodeRecoveryKey(
      new Uint8Array(Array.from({ length: 32 }, (_, i) => (i + 11) % 255)),
    );
    expect(encoded).toBeTypeOf("string");

    store.stageEncodedRecoveryKey({
      encodedPrivateKey: encoded as string,
      keyId: "SSSSKEY",
    });

    expect(fs.existsSync(recoveryKeyPath)).toBe(false);
    const callbacks = store.buildCryptoCallbacks();
    const resolved = await callbacks.getSecretStorageKey?.(
      { keys: { SSSSKEY: { name: "test" } } },
      "m.cross_signing.master",
    );
    expect(resolved?.[0]).toBe("SSSSKEY");

    store.commitStagedRecoveryKey({ keyId: "SSSSKEY" });

    const persisted = JSON.parse(fs.readFileSync(recoveryKeyPath, "utf8")) as {
      keyId?: string;
      encodedPrivateKey?: string;
    };
    expect(persisted.keyId).toBe("SSSSKEY");
    expect(persisted.encodedPrivateKey).toBe(encoded);
  });

  it("does not overwrite the stored recovery key while a staged key is only being validated", async () => {
    const recoveryKeyPath = createTempRecoveryKeyPath();
    const storedEncoded = encodeRecoveryKey(
      new Uint8Array(Array.from({ length: 32 }, (_, i) => (i + 1) % 255)),
    );
    fs.writeFileSync(
      recoveryKeyPath,
      JSON.stringify({
        version: 1,
        createdAt: "2026-03-12T00:00:00.000Z",
        keyId: "OLD",
        encodedPrivateKey: storedEncoded,
        privateKeyBase64: Buffer.from(
          new Uint8Array(Array.from({ length: 32 }, (_, i) => (i + 1) % 255)),
        ).toString("base64"),
      }),
      "utf8",
    );

    const store = new MatrixRecoveryKeyStore(recoveryKeyPath);
    const stagedEncoded = encodeRecoveryKey(
      new Uint8Array(Array.from({ length: 32 }, (_, i) => (i + 101) % 255)),
    );
    store.stageEncodedRecoveryKey({
      encodedPrivateKey: stagedEncoded as string,
      keyId: "NEW",
    });

    const crypto = {
      on: vi.fn(),
      bootstrapCrossSigning: vi.fn(async () => {}),
      bootstrapSecretStorage: vi.fn(async () => {}),
      createRecoveryKeyFromPassphrase: vi.fn(async () => {
        throw new Error("should not be called");
      }),
      getSecretStorageStatus: vi.fn(async () => ({ ready: true, defaultKeyId: "NEW" })),
      requestOwnUserVerification: vi.fn(async () => null),
    } as unknown as MatrixCryptoBootstrapApi;

    await store.bootstrapSecretStorageWithRecoveryKey(crypto);

    const persisted = JSON.parse(fs.readFileSync(recoveryKeyPath, "utf8")) as {
      keyId?: string;
      encodedPrivateKey?: string;
    };
    expect(persisted.keyId).toBe("OLD");
    expect(persisted.encodedPrivateKey).toBe(storedEncoded);
  });

  it("generates a fresh recovery key when secret storage is explicitly rotated", async () => {
    const recoveryKeyPath = createTempRecoveryKeyPath();
    const oldEncoded = encodeRecoveryKey(
      new Uint8Array(Array.from({ length: 32 }, (_, i) => i + 1)),
    );
    fs.writeFileSync(
      recoveryKeyPath,
      JSON.stringify({
        version: 1,
        createdAt: "2026-03-12T00:00:00.000Z",
        keyId: "OLD",
        encodedPrivateKey: oldEncoded,
        privateKeyBase64: Buffer.from(
          new Uint8Array(Array.from({ length: 32 }, (_, i) => i + 1)),
        ).toString("base64"),
      }),
      "utf8",
    );

    const freshEncoded = encodeRecoveryKey(
      new Uint8Array(Array.from({ length: 32 }, (_, i) => i + 101)),
    ) as string;
    const bootstrapSecretStorage = createBootstrapSecretStorageMock();
    const createRecoveryKeyFromPassphrase = vi.fn(async () =>
      createGeneratedRecoveryKey({
        keyId: "NEW",
        name: "Fresh key",
        bytes: Array.from({ length: 32 }, (_, i) => i + 101),
        encodedPrivateKey: freshEncoded,
      }),
    );
    const crypto = createRecoveryKeyCrypto({
      bootstrapSecretStorage,
      createRecoveryKeyFromPassphrase,
      status: { ready: true, defaultKeyId: "OLD" },
    });
    const store = new MatrixRecoveryKeyStore(recoveryKeyPath);

    await store.bootstrapSecretStorageWithRecoveryKey(crypto, {
      forceNewRecoveryKey: true,
      forceNewSecretStorage: true,
    });

    const persisted = JSON.parse(fs.readFileSync(recoveryKeyPath, "utf8")) as {
      keyId?: string;
      encodedPrivateKey?: string;
    };
    expect(createRecoveryKeyFromPassphrase).toHaveBeenCalledTimes(1);
    expect(persisted.keyId).toBe("NEW");
    expect(persisted.encodedPrivateKey).toBe(freshEncoded);
    expect(persisted.encodedPrivateKey).not.toBe(oldEncoded);
  });
});
