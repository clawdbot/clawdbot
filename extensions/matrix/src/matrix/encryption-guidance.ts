import { normalizeOptionalAccountId } from "openclaw/plugin-sdk/account-id";
import { resolveMatrixDefaultOrOnlyAccountId } from "../account-selection.js";
import type { CoreConfig } from "../types.js";
import { resolveMatrixConfigFieldPath } from "./config-paths.js";

export function resolveMatrixEncryptionConfigPath(
  cfg: CoreConfig,
  accountId?: string | null,
): string {
  const effectiveAccountId =
    normalizeOptionalAccountId(accountId) ?? resolveMatrixDefaultOrOnlyAccountId(cfg);
  return resolveMatrixConfigFieldPath(cfg, effectiveAccountId, "encryption");
}

export function formatMatrixEncryptionUnavailableError(
  cfg: CoreConfig,
  accountId?: string | null,
): string {
  return `Matrix encryption is not available (enable ${resolveMatrixEncryptionConfigPath(cfg, accountId)}=true)`;
}

export function formatMatrixEncryptedEventDisabledWarning(
  cfg: CoreConfig,
  accountId?: string | null,
): string {
  return `matrix: encrypted event received without encryption enabled; set ${resolveMatrixEncryptionConfigPath(cfg, accountId)}=true and verify the device to decrypt`;
}
