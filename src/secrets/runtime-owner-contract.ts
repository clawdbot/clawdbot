/** Process-local identity for the non-secret config that an owner may use with a credential. */
import { createHash } from "node:crypto";
import { stableStringify } from "../agents/stable-stringify.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { coerceSecretRef } from "../config/types.secrets.js";
import { secretRefKey } from "./ref-contract.js";
import { isRecord } from "./shared.js";

type SecretDefaults = NonNullable<OpenClawConfig["secrets"]>["defaults"];

/** Normalizes equivalent SecretRef input forms before hashing owner config. */
export function canonicalizeSecretRefsForOwnerContract(
  value: unknown,
  defaults: SecretDefaults | undefined,
): unknown {
  const ref = coerceSecretRef(value, defaults);
  if (ref) {
    return { secretRef: secretRefKey(ref) };
  }
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeSecretRefsForOwnerContract(entry, defaults));
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      canonicalizeSecretRefsForOwnerContract(entry, defaults),
    ]),
  );
}

/**
 * Binds last-known-good credentials to their complete owner config. The digest is
 * process-local metadata only; raw config and credential-bearing values are never logged.
 */
export function digestSecretOwnerContract(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

/** Combines assignment fragments into one deterministic owner contract. */
export function combineSecretOwnerContractDigests(digests: readonly string[]): string | undefined {
  const unique = [...new Set(digests)].toSorted();
  return unique.length > 0 ? digestSecretOwnerContract(unique) : undefined;
}

/** Binds a web credential to both tool selection and its owning plugin config. */
export function digestRuntimeWebOwnerContract(params: {
  scopePath: string;
  configuredProvider?: string;
  toolConfig: unknown;
  providers: Array<{ id: string; pluginId?: string }>;
  providerId: string;
  sourceConfig: OpenClawConfig;
}): string {
  const provider = params.providers.find((entry) => entry.id === params.providerId);
  const pluginId = provider?.pluginId;
  return digestSecretOwnerContract(
    canonicalizeSecretRefsForOwnerContract(
      {
        scopePath: params.scopePath,
        configuredProvider: params.configuredProvider,
        toolConfig: params.toolConfig,
        provider,
        pluginConfig: pluginId
          ? params.sourceConfig.plugins?.entries?.[pluginId]?.config
          : undefined,
      },
      params.sourceConfig.secrets?.defaults,
    ),
  );
}
