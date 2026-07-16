import fs from "node:fs";
import path from "node:path";
import { decodeRecoveryKey } from "matrix-js-sdk/lib/crypto-api/recovery-key.js";
import { formatMatrixErrorMessage, formatMatrixErrorReason } from "../errors.js";
import { LogService } from "./logger.js";
import type {
  MatrixCryptoBootstrapApi,
  MatrixCryptoCallbacks,
  MatrixGeneratedSecretStorageKey,
  MatrixSecretStorageStatus,
  MatrixStoredRecoveryKey,
} from "./types.js";

export function isRepairableSecretStorageAccessError(err: unknown): boolean {
  const message = formatMatrixErrorReason(err);
  if (!message) {
    return false;
  }
  if (message.includes("getsecretstoragekey callback returned falsey")) {
    return true;
  }
  // The homeserver still has secret storage, but the local recovery key cannot
  // authenticate/decrypt a required secret. During explicit bootstrap we can
  // recreate secret storage and continue with a new local baseline.
  if (message.includes("decrypting secret") && message.includes("bad mac")) {
    return true;
  }
  return false;
}

export class MatrixRecoveryKeyStore {
  private readonly secretStorageKeyCache = new Map<
    string,
    { key: Uint8Array; keyInfo?: MatrixStoredRecoveryKey["keyInfo"] }
  >();
  private stagedRecoveryKey: MatrixStoredRecoveryKey | null = null;
  private readonly stagedCacheKeyIds = new Set<string>();

  constructor(private readonly recoveryKeyPath?: string) {}

  buildCryptoCallbacks(): MatrixCryptoCallbacks {
    return {
      getSecretStorageKey: async ({ keys }) => {
        const requestedKeyIds = Object.keys(keys ?? {});
        if (requestedKeyIds.length === 0) {
          return null;
        }

        for (const keyId of requestedKeyIds) {
          const cached = this.secretStorageKeyCache.get(keyId);
          if (cached) {
            return [keyId, new Uint8Array(cached.key)];
          }
        }

        const staged = this.stagedRecoveryKey;
        if (staged?.privateKeyBase64) {
          const privateKey = new Uint8Array(Buffer.from(staged.privateKeyBase64, "base64"));
          if (privateKey.length > 0) {
            const stagedKeyId =
              staged.keyId && requestedKeyIds.includes(staged.keyId)
                ? staged.keyId
                : requestedKeyIds[0];
            if (stagedKeyId) {
              this.rememberSecretStorageKey(stagedKeyId, privateKey, staged.keyInfo);
              this.stagedCacheKeyIds.add(stagedKeyId);
              return [stagedKeyId, privateKey];
            }
          }
        }

        const stored = this.loadStoredRecoveryKey();
        if (!stored?.privateKeyBase64) {
          return null;
        }
        const privateKey = new Uint8Array(Buffer.from(stored.privateKeyBase64, "base64"));
        if (privateKey.length === 0) {
          return null;
        }

        if (stored.keyId && requestedKeyIds.includes(stored.keyId)) {
          this.rememberSecretStorageKey(stored.keyId, privateKey, stored.keyInfo);
          return [stored.keyId, privateKey];
        }

        const firstRequestedKeyId = requestedKeyIds[0];
        if (!firstRequestedKeyId) {
          return null;
        }
        this.rememberSecretStorageKey(firstRequestedKeyId, privateKey, stored.keyInfo);
        return [firstRequestedKeyId, privateKey];
      },
      cacheSecretStorageKey: (keyId, keyInfo, key) => {
        const privateKey = new Uint8Array(key);
        const normalizedKeyInfo: MatrixStoredRecoveryKey["keyInfo"] = {
          passphrase: keyInfo?.passphrase,
          name: typeof keyInfo?.name === "string" ? keyInfo.name : undefined,
        };
        this.rememberSecretStorageKey(keyId, privateKey, normalizedKeyInfo);

        const stored = this.loadStoredRecoveryKey();
        this.saveRecoveryKeyToDisk({
          keyId,
          keyInfo: normalizedKeyInfo,
          privateKey,
          encodedPrivateKey: stored?.encodedPrivateKey,
        });
      },
    };
  }

  getRecoveryKeySummary(): {
    encodedPrivateKey?: string;
    keyId?: string | null;
    createdAt?: string;
  } | null {
    const stored = this.loadStoredRecoveryKey();
    if (!stored) {
      return null;
    }
    return {
      encodedPrivateKey: stored.encodedPrivateKey,
      keyId: stored.keyId,
      createdAt: stored.createdAt,
    };
  }

  private resolveEncodedRecoveryKeyInput(params: {
    encodedPrivateKey: string;
    keyId?: string | null;
    keyInfo?: MatrixStoredRecoveryKey["keyInfo"];
  }): {
    encodedPrivateKey: string;
    privateKey: Uint8Array;
    keyId: string | null;
    keyInfo?: MatrixStoredRecoveryKey["keyInfo"];
  } {
    const encodedPrivateKey = params.encodedPrivateKey.trim();
    if (!encodedPrivateKey) {
      throw new Error("Matrix recovery key is required");
    }
    let privateKey: Uint8Array;
    try {
      privateKey = decodeRecoveryKey(encodedPrivateKey);
    } catch (err) {
      throw new Error(`Invalid Matrix recovery key: ${formatMatrixErrorMessage(err)}`, {
        cause: err,
      });
    }
    const keyId =
      typeof params.keyId === "string" && params.keyId.trim() ? params.keyId.trim() : null;
    return {
      encodedPrivateKey,
      privateKey,
      keyId,
      keyInfo: params.keyInfo ?? this.loadStoredRecoveryKey()?.keyInfo,
    };
  }

  storeEncodedRecoveryKey(params: {
    encodedPrivateKey: string;
    keyId?: string | null;
    keyInfo?: MatrixStoredRecoveryKey["keyInfo"];
  }): {
    encodedPrivateKey?: string;
    keyId?: string | null;
    createdAt?: string;
  } {
    const prepared = this.resolveEncodedRecoveryKeyInput(params);
    this.saveRecoveryKeyToDisk({
      keyId: prepared.keyId,
      keyInfo: prepared.keyInfo,
      privateKey: prepared.privateKey,
      encodedPrivateKey: prepared.encodedPrivateKey,
    });
    if (prepared.keyId) {
      this.rememberSecretStorageKey(prepared.keyId, prepared.privateKey, prepared.keyInfo);
    }
    return this.getRecoveryKeySummary() ?? {};
  }

  stageEncodedRecoveryKey(params: {
    encodedPrivateKey: string;
    keyId?: string | null;
    keyInfo?: MatrixStoredRecoveryKey["keyInfo"];
  }): void {
    const prepared = this.resolveEncodedRecoveryKeyInput(params);
    this.discardStagedRecoveryKey();
    this.stagedRecoveryKey = {
      version: 1,
      createdAt: new Date().toISOString(),
      keyId: prepared.keyId,
      encodedPrivateKey: prepared.encodedPrivateKey,
      privateKeyBase64: Buffer.from(prepared.privateKey).toString("base64"),
      keyInfo: prepared.keyInfo,
    };
  }

  commitStagedRecoveryKey(params?: {
    keyId?: string | null;
    keyInfo?: MatrixStoredRecoveryKey["keyInfo"];
  }): {
    encodedPrivateKey?: string;
    keyId?: string | null;
    createdAt?: string;
  } | null {
    if (!this.stagedRecoveryKey) {
      return this.getRecoveryKeySummary();
    }
    const staged = this.stagedRecoveryKey;
    const privateKey = new Uint8Array(Buffer.from(staged.privateKeyBase64, "base64"));
    const keyId =
      typeof params?.keyId === "string" && params.keyId.trim() ? params.keyId.trim() : staged.keyId;
    this.saveRecoveryKeyToDisk({
      keyId,
      keyInfo: params?.keyInfo ?? staged.keyInfo,
      privateKey,
      encodedPrivateKey: staged.encodedPrivateKey,
    });
    this.clearStagedRecoveryKeyTracking();
    return this.getRecoveryKeySummary();
  }

  discardStagedRecoveryKey(): void {
    for (const keyId of this.stagedCacheKeyIds) {
      this.secretStorageKeyCache.delete(keyId);
    }
    this.clearStagedRecoveryKeyTracking();
  }

  async bootstrapSecretStorageWithRecoveryKey(
    crypto: MatrixCryptoBootstrapApi,
    options: {
      setupNewKeyBackup?: boolean;
      allowSecretStorageRecreateWithoutRecoveryKey?: boolean;
      forceNewSecretStorage?: boolean;
    } = {},
  ): Promise<void> {
    let status: MatrixSecretStorageStatus | null = null;
    const getSecretStorageStatus = crypto.getSecretStorageStatus; // pragma: allowlist secret
    if (typeof getSecretStorageStatus === "function") {
      try {
        status = await getSecretStorageStatus.call(crypto);
      } catch (err) {
        LogService.warn("MatrixClientLite", "Failed to read secret storage status:", err);
      }
    }

    const hasDefaultSecretStorageKey = Boolean(status?.defaultKeyId);
    const hasKnownInvalidSecrets = Object.values(status?.secretStorageKeyValidityMap ?? {}).some(
      (valid) => !valid,
    );
    let generatedRecoveryKey = false;
    const storedRecovery = this.loadStoredRecoveryKey();
    const stagedRecovery = this.stagedRecoveryKey;
    const sourceRecovery = stagedRecovery ?? storedRecovery;
    let recoveryKey: MatrixGeneratedSecretStorageKey | null = sourceRecovery
      ? {
          keyInfo: sourceRecovery.keyInfo,
          privateKey: new Uint8Array(Buffer.from(sourceRecovery.privateKeyBase64, "base64")),
          encodedPrivateKey: sourceRecovery.encodedPrivateKey,
        }
      : null;

    if (recoveryKey && status?.defaultKeyId) {
      const defaultKeyId = status.defaultKeyId;
      this.rememberSecretStorageKey(defaultKeyId, recoveryKey.privateKey, recoveryKey.keyInfo);
      if (!stagedRecovery && storedRecovery && storedRecovery.keyId !== defaultKeyId) {
        this.saveRecoveryKeyToDisk({
          keyId: defaultKeyId,
          keyInfo: recoveryKey.keyInfo,
          privateKey: recoveryKey.privateKey,
          encodedPrivateKey: recoveryKey.encodedPrivateKey,
        });
      }
    }

    const ensureRecoveryKey = async (): Promise<MatrixGeneratedSecretStorageKey> => {
      if (recoveryKey) {
        return recoveryKey;
      }
      if (typeof crypto.createRecoveryKeyFromPassphrase !== "function") {
        throw new Error(
          "Matrix crypto backend does not support recovery key generation (createRecoveryKeyFromPassphrase missing)",
        );
      }
      recoveryKey = await crypto.createRecoveryKeyFromPassphrase();
      this.saveRecoveryKeyToDisk(recoveryKey);
      generatedRecoveryKey = true;
      return recoveryKey;
    };

    const shouldRecreateSecretStorage =
      options.forceNewSecretStorage === true ||
      !hasDefaultSecretStorageKey ||
      (!recoveryKey && status?.ready === false) ||
      hasKnownInvalidSecrets;

    if (hasKnownInvalidSecrets) {
      // Existing secret storage keys can't decrypt required secrets. Generate a fresh recovery key.
      recoveryKey = null;
    }

    const secretStorageOptions: {
      createSecretStorageKey?: () => Promise<MatrixGeneratedSecretStorageKey>;
      setupNewSecretStorage?: boolean;
      setupNewKeyBackup?: boolean;
    } = {
      setupNewKeyBackup: options.setupNewKeyBackup === true,
    };

    if (shouldRecreateSecretStorage) {
      secretStorageOptions.setupNewSecretStorage = true;
      secretStorageOptions.createSecretStorageKey = ensureRecoveryKey;
    }

    try {
      await crypto.bootstrapSecretStorage(secretStorageOptions);
    } catch (err) {
      const shouldRecreateWithoutRecoveryKey =
        options.allowSecretStorageRecreateWithoutRecoveryKey === true &&
        hasDefaultSecretStorageKey &&
        isRepairableSecretStorageAccessError(err);
      if (!shouldRecreateWithoutRecoveryKey) {
        throw err;
      }

      recoveryKey = null;
      LogService.warn(
        "MatrixClientLite",
        "Secret storage exists on the server but local recovery material cannot unlock it; recreating secret storage during explicit bootstrap.",
      );
      await crypto.bootstrapSecretStorage({
        setupNewSecretStorage: true,
        setupNewKeyBackup: options.setupNewKeyBackup === true,
        createSecretStorageKey: ensureRecoveryKey,
      });
    }

    if (generatedRecoveryKey && this.recoveryKeyPath) {
      LogService.warn(
        "MatrixClientLite",
        `Generated Matrix recovery key and saved it to ${this.recoveryKeyPath}. Keep this file secure.`,
      );
    }
  }

  private clearStagedRecoveryKeyTracking(): void {
    this.stagedRecoveryKey = null;
    this.stagedCacheKeyIds.clear();
  }

  private rememberSecretStorageKey(
    keyId: string,
    key: Uint8Array,
    keyInfo?: MatrixStoredRecoveryKey["keyInfo"],
  ): void {
    if (!keyId.trim()) {
      return;
    }
    this.secretStorageKeyCache.set(keyId, {
      key: new Uint8Array(key),
      keyInfo,
    });
  }

  private loadStoredRecoveryKey(): MatrixStoredRecoveryKey | null {
    if (!this.recoveryKeyPath) {
      return null;
    }
    try {
      if (!fs.existsSync(this.recoveryKeyPath)) {
        return null;
      }
      const raw = fs.readFileSync(this.recoveryKeyPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<MatrixStoredRecoveryKey>;
      if (
        parsed.version !== 1 ||
        typeof parsed.createdAt !== "string" ||
        typeof parsed.privateKeyBase64 !== "string" || // pragma: allowlist secret
        !parsed.privateKeyBase64.trim()
      ) {
        return null;
      }
      return {
        version: 1,
        createdAt: parsed.createdAt,
        keyId: typeof parsed.keyId === "string" ? parsed.keyId : null,
        encodedPrivateKey:
          typeof parsed.encodedPrivateKey === "string" ? parsed.encodedPrivateKey : undefined,
        privateKeyBase64: parsed.privateKeyBase64,
        keyInfo:
          parsed.keyInfo && typeof parsed.keyInfo === "object"
            ? {
                passphrase: parsed.keyInfo.passphrase,
                name: typeof parsed.keyInfo.name === "string" ? parsed.keyInfo.name : undefined,
              }
            : undefined,
      };
    } catch {
      return null;
    }
  }

  private saveRecoveryKeyToDisk(params: MatrixGeneratedSecretStorageKey): void {
    if (!this.recoveryKeyPath) {
      return;
    }
    try {
      const payload: MatrixStoredRecoveryKey = {
        version: 1,
        createdAt: new Date().toISOString(),
        keyId: typeof params.keyId === "string" ? params.keyId : null,
        encodedPrivateKey: params.encodedPrivateKey,
        privateKeyBase64: Buffer.from(params.privateKey).toString("base64"),
        keyInfo: params.keyInfo
          ? {
              passphrase: params.keyInfo.passphrase,
              name: params.keyInfo.name,
            }
          : undefined,
      };
      fs.mkdirSync(path.dirname(this.recoveryKeyPath), { recursive: true });
      fs.writeFileSync(this.recoveryKeyPath, JSON.stringify(payload, null, 2), "utf8");
      fs.chmodSync(this.recoveryKeyPath, 0o600);
    } catch (err) {
      LogService.warn("MatrixClientLite", "Failed to persist recovery key:", err);
    }
  }
}
