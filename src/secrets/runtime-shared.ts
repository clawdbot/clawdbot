/** Shared secrets runtime resolver context, assignments, and warning helpers. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { coerceSecretRef, type SecretRef } from "../config/types.secrets.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { secretRefKey } from "./ref-contract.js";
import type { SecretRefResolveCache } from "./resolve-types.js";
import { assertExpectedResolvedSecretValue } from "./secret-value.js";
import { isRecord } from "./shared.js";

export type SecretResolverWarningCode =
  | "SECRETS_REF_OVERRIDES_PLAINTEXT"
  | "SECRETS_REF_IGNORED_INACTIVE_SURFACE"
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
  apply: (value: unknown) => void;
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
export type { SecretRefResolveCache } from "./resolve-types.js";

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
  apply: (value: unknown) => void;
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
    apply: params.apply,
  });
}

/**
 * Applies resolved SecretRef values to their collected config targets with shape validation.
 */
export function applyResolvedAssignments(params: {
  assignments: SecretAssignment[];
  resolved: Map<string, unknown>;
}): void {
  for (const assignment of params.assignments) {
    const key = secretRefKey(assignment.ref);
    if (!params.resolved.has(key)) {
      throw new Error(`Secret reference "${key}" resolved to no value.`);
    }
    const value = params.resolved.get(key);
    assertExpectedResolvedSecretValue({
      value,
      expected: assignment.expected,
      errorMessage:
        assignment.expected === "string"
          ? `${assignment.path} resolved to a non-string or empty value.`
          : `${assignment.path} resolved to an unsupported value type.`,
    });
    assignment.apply(value);
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
