import type { SecretRef } from "../config/types.secrets.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { providerResolutionError, refResolutionError } from "./resolve-errors.js";
import { readSecretStoreValue, SECRET_STORE_VALUE_MAX_BYTES } from "./store/secret-store.js";

// Store values intentionally support large PEM/JSON payloads, so this batch cap is
// independent from the 256 KiB request cap used by file and exec providers.
const STORE_SECRET_REF_BATCH_MAX_BYTES = 512 * SECRET_STORE_VALUE_MAX_BYTES;

export function resolveStoreRefs(params: {
  refs: SecretRef[];
  providerName: string;
  database?: OpenClawStateDatabaseOptions;
}): Map<string, unknown> {
  const resolved = new Map<string, unknown>();
  let resolvedBytes = 0;
  for (const ref of params.refs) {
    const result = readSecretStoreValue({
      scope: { kind: "team" },
      name: ref.id,
      database: params.database,
    });
    if (!result.ok) {
      if (result.error.code === "SECRET_STORE_NOT_FOUND") {
        throw refResolutionError({
          code: "SECRET_REF_NOT_FOUND",
          source: "store",
          provider: params.providerName,
          refId: ref.id,
          message: result.error.message,
        });
      }
      if (result.error.code === "SECRET_STORE_INVALID_NAME") {
        throw refResolutionError({
          code: "SECRET_REF_INVALID",
          source: "store",
          provider: params.providerName,
          refId: ref.id,
          message: result.error.message,
        });
      }
      throw providerResolutionError({
        code: "SECRET_PROVIDER_UNAVAILABLE",
        source: "store",
        provider: params.providerName,
        message: result.error.message,
        cause: result.error.cause,
      });
    }
    resolvedBytes += Buffer.byteLength(result.value, "utf8");
    if (resolvedBytes > STORE_SECRET_REF_BATCH_MAX_BYTES) {
      throw providerResolutionError({
        code: "SECRET_PROVIDER_INVALID",
        source: "store",
        provider: params.providerName,
        message: `Store provider "${params.providerName}" exceeded its ${STORE_SECRET_REF_BATCH_MAX_BYTES}-byte batch limit.`,
      });
    }
    resolved.set(ref.id, result.value);
  }
  return resolved;
}
