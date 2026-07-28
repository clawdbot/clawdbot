// Exposes private secret file helpers with fs-safe defaults.
import "./fs-safe-defaults.js";
import { FsSafeError, type FsSafeErrorCode } from "@openclaw/fs-safe";
import {
  readSecretFileSync as readSecretFileSyncImpl,
  tryReadSecretFileSync as tryReadSecretFileSyncImpl,
  type SecretFileReadOptions as FsSafeSecretFileReadOptions,
} from "@openclaw/fs-safe/secret";
import { resolveUserPath } from "../utils.js";

export {
  DEFAULT_SECRET_FILE_MAX_BYTES,
  PRIVATE_SECRET_DIR_MODE,
  PRIVATE_SECRET_FILE_MODE,
  readSecretFileSync,
  type SecretFileReadOptions,
} from "@openclaw/fs-safe/secret";
export { writeSecretFileAtomic as writePrivateSecretFileAtomic } from "@openclaw/fs-safe/secret";

export type SecretFileReadResult =
  | {
      ok: true;
      secret: string;
      resolvedPath: string;
    }
  | {
      ok: false;
      message: string;
      resolvedPath?: string;
      error?: unknown;
    };

type CredentialUnavailableDiagnostic = {
  code: "CREDENTIAL_FILE_UNAVAILABLE";
  path: string;
  reason: FsSafeErrorCode;
};

/** Closed credential state used by channel account resolvers. */
type CredentialResult<T> =
  | { status: "available"; value: T }
  | { status: "configured_unavailable"; diagnostic: CredentialUnavailableDiagnostic }
  | { status: "missing" };
type ConfiguredCredentialResult<T> = Exclude<CredentialResult<T>, { status: "missing" }>;

type CredentialFileReadOptions = FsSafeSecretFileReadOptions & {
  credentialDiagnostic: {
    configPath: string;
    report: (diagnostic: CredentialUnavailableDiagnostic) => void;
  };
};

export function tryReadSecretFileSync(
  filePath: string | undefined,
  label: string,
  options: CredentialFileReadOptions,
): string | undefined;

export function tryReadSecretFileSync(
  filePath: string | undefined,
  label: string,
  options?: FsSafeSecretFileReadOptions,
): string | undefined;
/** Reads an explicitly configured credential file without exposing its filesystem path. */
export function tryReadSecretFileSync(
  filePath: string,
  label: string,
  options: FsSafeSecretFileReadOptions | undefined,
  diagnostic: { configPath: string },
): ConfiguredCredentialResult<string>;
export function tryReadSecretFileSync(
  filePath: string | undefined,
  label: string,
  options: FsSafeSecretFileReadOptions | undefined,
  diagnostic: { configPath: string },
): CredentialResult<string>;
export function tryReadSecretFileSync(
  filePath: string | undefined,
  label: string,
  options: FsSafeSecretFileReadOptions | CredentialFileReadOptions = {},
  diagnostic?: { configPath: string },
): string | undefined | CredentialResult<string> {
  if ("credentialDiagnostic" in options) {
    const { credentialDiagnostic, ...readOptions } = options;
    if (!filePath?.trim()) {
      return undefined;
    }
    try {
      return readSecretFileSyncImpl(filePath, label, readOptions);
    } catch (error) {
      if (!(error instanceof FsSafeError)) {
        throw error;
      }
      credentialDiagnostic.report({
        code: "CREDENTIAL_FILE_UNAVAILABLE",
        path: credentialDiagnostic.configPath,
        reason: error.code,
      });
      return undefined;
    }
  }
  if (!diagnostic) {
    return tryReadSecretFileSyncImpl(filePath, label, options);
  }
  if (!filePath?.trim()) {
    return { status: "missing" };
  }
  try {
    return {
      status: "available",
      value: readSecretFileSyncImpl(filePath, label, options),
    };
  } catch (error) {
    if (!(error instanceof FsSafeError)) {
      throw error;
    }
    return {
      status: "configured_unavailable",
      diagnostic: {
        code: "CREDENTIAL_FILE_UNAVAILABLE",
        path: diagnostic.configPath,
        reason: error.code,
      },
    };
  }
}

/** @deprecated Use readSecretFileSync() or tryReadSecretFileSync(). */
export function loadSecretFileSync(
  filePath: string,
  label: string,
  options: Parameters<typeof readSecretFileSyncImpl>[2] = {},
): SecretFileReadResult {
  const trimmedPath = filePath.trim();
  const resolvedPath = resolveUserPath(trimmedPath);
  if (!resolvedPath) {
    return { ok: false, message: `${label} file path is empty.` };
  }

  try {
    return {
      ok: true,
      secret: readSecretFileSyncImpl(filePath, label, options),
      resolvedPath,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      resolvedPath,
      error,
    };
  }
}
