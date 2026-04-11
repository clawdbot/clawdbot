import type { SecretProviderConfig, SecretRef } from "../config/types.secrets.js";
import { SecretProviderSchema } from "../config/zod-schema.core.js";
import { isValidExecSecretRefId, isValidSecretProviderAlias } from "./ref-contract.js";
import { parseDotPath, toDotPath } from "./shared.js";
import {
  isKnownSecretTargetType,
  resolvePlanTargetAgainstRegistry,
  type ResolvedPlanTarget,
} from "./target-registry.js";

export type SecretsPlanTargetType = string;

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

const FORBIDDEN_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSecretProviderConfigShape(value: unknown): value is SecretProviderConfig {
  return SecretProviderSchema.safeParse(value).success;
}

function hasForbiddenPathSegment(segments: string[]): boolean {
  return segments.some((segment) => FORBIDDEN_PATH_SEGMENTS.has(segment));
}

export function resolveValidatedPlanTarget(candidate: {
  type?: SecretsPlanTargetType;
  path?: string;
  pathSegments?: string[];
  agentId?: string;
  providerId?: string;
  accountId?: string;
  authProfileProvider?: string;
}): ResolvedPlanTarget | null {
  if (!isKnownSecretTargetType(candidate.type)) {
    return null;
  }
  const path = typeof candidate.path === "string" ? candidate.path.trim() : "";
  if (!path) {
    return null;
  }
  const segments =
    Array.isArray(candidate.pathSegments) && candidate.pathSegments.length > 0
      ? candidate.pathSegments.map((segment) => segment.trim()).filter(Boolean)
      : parseDotPath(path);
  if (segments.length === 0 || hasForbiddenPathSegment(segments) || path !== toDotPath(segments)) {
    return null;
  }
  return resolvePlanTargetAgainstRegistry({
    type: candidate.type,
    pathSegments: segments,
    providerId: candidate.providerId,
    accountId: candidate.accountId,
  });
}

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
      !isKnownSecretTargetType(candidate.type) ||
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
      (ref.source === "exec" && !isValidExecSecretRefId(ref.id))
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

export function normalizeSecretsPlanOptions(
  options: SecretsApplyPlan["options"] | undefined,
): Required<NonNullable<SecretsApplyPlan["options"]>> {
  return {
    scrubEnv: options?.scrubEnv ?? true,
    scrubAuthProfilesForProviderTargets: options?.scrubAuthProfilesForProviderTargets ?? true,
    scrubLegacyAuthJson: options?.scrubLegacyAuthJson ?? true,
  };
}
