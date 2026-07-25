/** Validates and normalizes serialized secrets apply plans before config mutation. */
import { isRecord as isObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import type { SecretProviderConfig, SecretRef } from "../config/types.secrets.js";
import { SecretProviderSchema } from "../config/zod-schema.core.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import { isValidSecretProviderAlias, isValidSecretRef } from "./ref-contract.js";
import { parseDotPath, toDotPath } from "./shared.js";
import { resolvePlanTargetAgainstRegistry, type ResolvedPlanTarget } from "./target-registry.js";

/** Registry target id accepted by a secrets apply plan. */
type SecretsPlanTargetType = string;

/** One planned SecretRef mutation against config or auth-profile storage. */
export type SecretsPlanTarget = {
  type: SecretsPlanTargetType;
  /**
   * Dot path in the target config surface for operator readability.
   * Examples:
   * - "models.providers.openai.apiKey"
   * - "profiles.openai.key"
   */
  path: string;
  /**
   * Canonical path segments used for safe mutation.
   * Examples:
   * - ["models", "providers", "openai", "apiKey"]
   * - ["profiles", "openai", "key"]
   */
  pathSegments?: string[];
  ref: SecretRef;
  /**
   * Required for auth-profiles targets so apply can resolve the correct agent store.
   */
  agentId?: string;
  /**
   * For provider targets, used to scrub auth-profile/static residues.
   */
  providerId?: string;
  /** For account-scoped channel targets. */
  accountId?: string;
  /**
   * Optional auth-profile provider value used when creating new auth profile mappings.
   */
  authProfileProvider?: string;
};

/** Serialized plan produced by `openclaw secrets configure` or supplied manually. */
export type SecretsApplyPlan = {
  version: 1;
  protocolVersion: 1;
  generatedAt: string;
  generatedBy: "openclaw secrets configure" | "manual";
  providerUpserts?: Record<string, SecretProviderConfig>;
  providerDeletes?: string[];
  targets: SecretsPlanTarget[];
  options?: {
    scrubEnv?: boolean;
    scrubAuthProfilesForProviderTargets?: boolean;
    scrubLegacyAuthJson?: boolean;
  };
};

function isSecretProviderConfigShape(value: unknown): value is SecretProviderConfig {
  return SecretProviderSchema.safeParse(value).success;
}

/** Resolves a user-supplied plan target through the registry after path safety checks. */
export function resolveValidatedPlanTarget(candidate: {
  type?: SecretsPlanTargetType;
  path?: string;
  pathSegments?: string[];
  agentId?: string;
  providerId?: string;
  accountId?: string;
  authProfileProvider?: string;
}): ResolvedPlanTarget | null {
  if (typeof candidate.type !== "string" || !candidate.type.trim()) {
    return null;
  }
  const path = typeof candidate.path === "string" ? candidate.path.trim() : "";
  if (!path) {
    return null;
  }
  const segments =
    Array.isArray(candidate.pathSegments) && candidate.pathSegments.length > 0
      ? normalizeStringEntries(candidate.pathSegments)
      : parseDotPath(path);
  if (segments.length === 0 || segments.some(isBlockedObjectKey) || path !== toDotPath(segments)) {
    return null;
  }
  // Registry resolution is the ownership gate; caller-provided paths must map to a known
  // mutable SecretRef target before apply code can write anything.
  return resolvePlanTargetAgainstRegistry({
    type: candidate.type,
    pathSegments: segments,
    providerId: candidate.providerId,
    accountId: candidate.accountId,
  });
}

/** Validates the external secrets apply plan shape and every target/provider mutation. */
export function isSecretsApplyPlan(value: unknown): value is SecretsApplyPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const typed = value as Partial<SecretsApplyPlan>;
  if (typed.version !== 1 || typed.protocolVersion !== 1 || !Array.isArray(typed.targets)) {
    return false;
  }
  for (const target of typed.targets) {
    if (!target || typeof target !== "object") {
      return false;
    }
    const candidate = target as Partial<SecretsPlanTarget>;
    const ref = candidate.ref as Partial<SecretRef> | undefined;
    const resolved = resolveValidatedPlanTarget({
      type: candidate.type,
      path: candidate.path,
      pathSegments: candidate.pathSegments,
      agentId: candidate.agentId,
      providerId: candidate.providerId,
      accountId: candidate.accountId,
      authProfileProvider: candidate.authProfileProvider,
    });
    if (
      typeof candidate.path !== "string" ||
      !candidate.path.trim() ||
      (candidate.pathSegments !== undefined && !Array.isArray(candidate.pathSegments)) ||
      !resolved ||
      !ref ||
      typeof ref !== "object" ||
      (ref.source !== "env" && ref.source !== "file" && ref.source !== "exec") ||
      typeof ref.provider !== "string" ||
      ref.provider.trim().length === 0 ||
      typeof ref.id !== "string" ||
      ref.id.trim().length === 0 ||
      !isValidSecretRef(ref as SecretRef)
    ) {
      return false;
    }
    if (resolved.entry.configFile === "auth-profiles.json") {
      if (typeof candidate.agentId !== "string" || candidate.agentId.trim().length === 0) {
        return false;
      }
      if (
        candidate.authProfileProvider !== undefined &&
        (typeof candidate.authProfileProvider !== "string" ||
          candidate.authProfileProvider.trim().length === 0)
      ) {
        return false;
      }
    }
  }
  if (typed.providerUpserts !== undefined) {
    if (!isObjectRecord(typed.providerUpserts)) {
      return false;
    }
    for (const [providerAlias, providerValue] of Object.entries(typed.providerUpserts)) {
      if (!isValidSecretProviderAlias(providerAlias)) {
        return false;
      }
      if (!isSecretProviderConfigShape(providerValue)) {
        return false;
      }
    }
  }
  if (typed.providerDeletes !== undefined) {
    if (
      !Array.isArray(typed.providerDeletes) ||
      typed.providerDeletes.some(
        (providerAlias) =>
          typeof providerAlias !== "string" || !isValidSecretProviderAlias(providerAlias),
      )
    ) {
      return false;
    }
  }
  return true;
}

/** Normalizes omitted plan options to the apply-time defaults. */
export function normalizeSecretsPlanOptions(
  options: SecretsApplyPlan["options"] | undefined,
): Required<NonNullable<SecretsApplyPlan["options"]>> {
  return {
    scrubEnv: options?.scrubEnv ?? true,
    scrubAuthProfilesForProviderTargets: options?.scrubAuthProfilesForProviderTargets ?? true,
    scrubLegacyAuthJson: options?.scrubLegacyAuthJson ?? true,
  };
}
