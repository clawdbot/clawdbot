/** Shared secrets runtime resolver context, assignments, and warning helpers. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { coerceSecretRef, type SecretRef } from "../config/types.secrets.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { secretRefKey } from "./ref-contract.js";
import type { SecretRefResolveCache } from "./resolve-types.js";
import type { SecretAssignmentDisposition, SecretOwnerKind } from "./runtime-degraded-state.js";
import {
  canonicalizeSecretRefsForOwnerContract,
  digestSecretOwnerContract,
} from "./runtime-owner-contract.js";
import { assertExpectedResolvedSecretValue } from "./secret-value.js";
import { isRecord } from "./shared.js";

export type SecretResolverWarningCode =
  | "SECRETS_REF_OVERRIDES_PLAINTEXT"
  | "SECRETS_REF_IGNORED_INACTIVE_SURFACE"
  | "SECRETS_OWNER_UNAVAILABLE"
  | "WEB_SEARCH_PROVIDER_INVALID_AUTODETECT"
  | "WEB_SEARCH_AUTODETECT_SELECTED"
  | "WEB_SEARCH_KEY_UNRESOLVED_FALLBACK_USED"
  | "WEB_SEARCH_KEY_UNRESOLVED_NO_FALLBACK"
  | "WEB_FETCH_PROVIDER_INVALID_AUTODETECT"
  | "WEB_FETCH_AUTODETECT_SELECTED"
  | "WEB_FETCH_PROVIDER_KEY_UNRESOLVED_FALLBACK_USED"
  | "WEB_FETCH_PROVIDER_KEY_UNRESOLVED_NO_FALLBACK";

export type SecretResolverWarning = {
  code: SecretResolverWarningCode;
  path: string;
  message: string;
};

export type SecretAssignment = {
  ref: SecretRef;
  path: string;
  expected: "string" | "string-or-object";
  ownerKind: SecretOwnerKind;
  ownerId: string;
  requiredForGateway: boolean;
  disposition: SecretAssignmentDisposition;
  /** Digest of the complete owner config captured before secret materialization. */
  ownerContractDigest?: string;
  apply: (value: unknown) => void;
  /** Applies the canonical unavailable state when this owner must start cold. */
  applyUnavailable?: () => void;
};

type SecretAssignmentValidationFailure = Pick<
  SecretAssignment,
  "ownerKind" | "ownerId" | "expected"
> & {
  refKey: string;
};

class SecretAssignmentValidationError extends Error {
  readonly failures: SecretAssignmentValidationFailure[];

  constructor(params: { failures: SecretAssignmentValidationFailure[]; error: Error }) {
    super(params.error.message, { cause: params.error });
    this.name = "SecretAssignmentValidationError";
    this.failures = params.failures.map((failure) => ({ ...failure }));
  }
}

/** Returns every assignment whose resolved value failed its target shape contract. */
export function getSecretAssignmentValidationFailures(
  error: unknown,
): SecretAssignmentValidationFailure[] {
  if (!(error instanceof SecretAssignmentValidationError)) {
    return [];
  }
  return error.failures.map((failure) => ({ ...failure }));
}

export type SecretAssignmentOwner = Pick<
  SecretAssignment,
  "ownerKind" | "ownerId" | "requiredForGateway" | "disposition"
> & {
  /** Complete config that controls where/how this owner uses the credential. */
  contract?: unknown;
};

export type ResolverContext = {
  sourceConfig: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  cache: SecretRefResolveCache;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  warnings: SecretResolverWarning[];
  warningKeys: Set<string>;
  assignments: SecretAssignment[];
};

export type SecretDefaults = NonNullable<OpenClawConfig["secrets"]>["defaults"];

/**
 * Creates the mutable collection context used while preparing a secrets runtime snapshot.
 */
export function createResolverContext(params: {
  sourceConfig: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
}): ResolverContext {
  return {
    sourceConfig: params.sourceConfig,
    env: params.env,
    cache: {},
    ...(params.manifestRegistry ? { manifestRegistry: params.manifestRegistry } : {}),
    warnings: [],
    warningKeys: new Set(),
    assignments: [],
  };
}

/**
 * Records a SecretRef assignment that should be resolved and applied later.
 */
export function pushAssignment(context: ResolverContext, assignment: SecretAssignment): void {
  context.assignments.push(assignment);
}

/**
 * Records a resolver warning once per code/path/message tuple.
 */
export function pushWarning(context: ResolverContext, warning: SecretResolverWarning): void {
  const warningKey = `${warning.code}:${warning.path}:${warning.message}`;
  if (context.warningKeys.has(warningKey)) {
    return;
  }
  context.warningKeys.add(warningKey);
  context.warnings.push(warning);
}

/**
 * Emits the standard warning for refs configured on currently inactive surfaces.
 */
export function pushInactiveSurfaceWarning(params: {
  context: ResolverContext;
  path: string;
  details?: string;
}): void {
  pushWarning(params.context, {
    code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
    path: params.path,
    message:
      params.details && params.details.trim().length > 0
        ? `${params.path}: ${params.details}`
        : `${params.path}: secret ref is configured on an inactive surface; skipping resolution until it becomes active.`,
  });
}

/**
 * Converts an inline SecretInput value into a deferred assignment when its surface is active.
 */
export function collectSecretInputAssignment(params: {
  value: unknown;
  path: string;
  expected: SecretAssignment["expected"];
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
  active?: boolean;
  inactiveReason?: string;
  owner?: SecretAssignmentOwner;
  apply: (value: unknown) => void;
  applyUnavailable?: () => void;
}): void {
  collectRuntimeSecretInputAssignment(params);
}

/** Internal owner-aware variant used while migrating runtime surfaces to isolation. */
export function collectRuntimeSecretInputAssignment(params: {
  value: unknown;
  path: string;
  expected: SecretAssignment["expected"];
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
  active?: boolean;
  inactiveReason?: string;
  owner?: SecretAssignmentOwner;
  apply: (value: unknown) => void;
  applyUnavailable?: () => void;
}): void {
  const ref = coerceSecretRef(params.value, params.defaults);
  if (!ref) {
    return;
  }
  if (params.active === false) {
    pushInactiveSurfaceWarning({
      context: params.context,
      path: params.path,
      details: params.inactiveReason,
    });
    return;
  }
  pushAssignment(params.context, {
    ref,
    path: params.path,
    expected: params.expected,
    ownerKind: params.owner?.ownerKind ?? "unknown",
    ownerId: params.owner?.ownerId ?? params.path,
    requiredForGateway: params.owner?.requiredForGateway ?? false,
    disposition: params.owner?.disposition ?? "isolate",
    ...(params.owner?.contract !== undefined
      ? {
          ownerContractDigest: digestSecretOwnerContract(
            canonicalizeSecretRefsForOwnerContract(params.owner.contract, params.defaults),
          ),
        }
      : {}),
    apply: params.apply,
    ...(params.applyUnavailable ? { applyUnavailable: params.applyUnavailable } : {}),
  });
}

/**
 * Applies resolved SecretRef values to their collected config targets with shape validation.
 */
export function applyResolvedAssignments(params: {
  assignments: SecretAssignment[];
  resolved: Map<string, unknown>;
}): void {
  const values: unknown[] = [];
  const failures: SecretAssignmentValidationFailure[] = [];
  let firstValidationError: Error | undefined;
  for (const assignment of params.assignments) {
    const key = secretRefKey(assignment.ref);
    if (!params.resolved.has(key)) {
      throw new Error(`Secret reference "${key}" resolved to no value.`);
    }
    const value = params.resolved.get(key);
    try {
      assertExpectedResolvedSecretValue({
        value,
        expected: assignment.expected,
        errorMessage:
          assignment.expected === "string"
            ? `${assignment.path} resolved to a non-string or empty value.`
            : `${assignment.path} resolved to an unsupported value type.`,
      });
    } catch (error) {
      const validationError = error instanceof Error ? error : new Error(String(error));
      firstValidationError ??= validationError;
      failures.push({
        ownerKind: assignment.ownerKind,
        ownerId: assignment.ownerId,
        expected: assignment.expected,
        refKey: key,
      });
    }
    values.push(value);
  }
  if (firstValidationError) {
    throw new SecretAssignmentValidationError({ error: firstValidationError, failures });
  }
  for (const [index, assignment] of params.assignments.entries()) {
    assignment.apply(values[index]);
  }
}

/**
 * Own-property helper used by config collectors that receive unknown object shapes.
 */
export function hasOwnProperty(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key);
}

/**
 * Treats missing or non-object enabled state as enabled by default.
 */
export function isEnabledFlag(value: unknown): boolean {
  if (!isRecord(value)) {
    return true;
  }
  return value.enabled !== false;
}

/**
 * Returns whether both a channel and one account are enabled for secret resolution.
 */
export function isChannelAccountEffectivelyEnabled(
  channel: Record<string, unknown>,
  account: Record<string, unknown>,
): boolean {
  return isEnabledFlag(channel) && isEnabledFlag(account);
}
