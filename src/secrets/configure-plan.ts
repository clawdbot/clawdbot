/** Builds the interactive `openclaw secrets configure` target list and apply plan. */
import { isDeepStrictEqual } from "node:util";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveSecretInputRef,
  type SecretProviderConfig,
  type SecretRef,
} from "../config/types.secrets.js";
import { parseConfigPathArrayIndex } from "../shared/path-array-index.js";
import type { SecretsApplyPlan } from "./plan.js";
import { isRecord } from "./shared.js";
import {
  discoverAuthProfileSecretTargets,
  discoverConfigSecretTargets,
} from "./target-registry.js";

/** Credential target shown by `openclaw secrets configure` before a SecretRef is selected. */
export type ConfigureCandidate = {
  type: string;
  path: string;
  pathSegments: string[];
  label: string;
  configFile: "openclaw.json" | "auth-profiles.json";
  expectedResolvedValue: "string" | "string-or-object";
  existingRef?: SecretRef;
  isDerived?: boolean;
  agentId?: string;
  providerId?: string;
  accountId?: string;
  authProfileProvider?: string;
};

/** Configure candidate after the operator chooses the SecretRef to write. */
export type ConfigureSelectedTarget = ConfigureCandidate & {
  ref: SecretRef;
};

/** Provider config mutations collected while building a secrets configure plan. */
export type ConfigureProviderChanges = {
  upserts: Record<string, SecretProviderConfig>;
  deletes: string[];
};

function getSecretProviders(config: OpenClawConfig): Record<string, SecretProviderConfig> {
  if (!isRecord(config.secrets?.providers)) {
    return {};
  }
  return config.secrets.providers;
}

/** Builds configure candidates for the current OpenClaw config only. */
export function buildConfigureCandidates(config: OpenClawConfig): ConfigureCandidate[] {
  return buildConfigureCandidatesForScope({ config });
}

function configureCandidateSortKey(candidate: ConfigureCandidate): string {
  if (candidate.configFile === "auth-profiles.json") {
    const agentId = candidate.agentId ?? "";
    return `auth-profiles:${agentId}:${candidate.path}`;
  }
  return `openclaw:${candidate.path}`;
}

function resolveAuthProfileProvider(
  store: AuthProfileStore,
  pathSegments: string[],
): string | undefined {
  const profileId = pathSegments[1];
  if (!profileId) {
    return undefined;
  }
  const profile = store.profiles?.[profileId];
  if (!isRecord(profile) || typeof profile.provider !== "string") {
    return undefined;
  }
  const provider = profile.provider.trim();
  return provider.length > 0 ? provider : undefined;
}

/** Builds configure candidates for OpenClaw config plus an optional auth-profile scope. */
export function buildConfigureCandidatesForScope(params: {
  config: OpenClawConfig;
  authoredOpenClawConfig?: OpenClawConfig;
  authProfiles?: {
    agentId: string;
    store: AuthProfileStore;
  };
}): ConfigureCandidate[] {
  const authoredConfig = params.authoredOpenClawConfig ?? params.config;

  const hasPathInAuthoredConfig = (pathSegments: string[]): boolean =>
    hasPath(authoredConfig, pathSegments);

  const openclawCandidates = discoverConfigSecretTargets(params.config)
    .filter((entry) => entry.entry.includeInConfigure)
    .map((entry) => {
      const resolved = resolveSecretInputRef({
        value: entry.value,
        refValue: entry.refValue,
        defaults: params.config.secrets?.defaults,
      });
      const pathExists = hasPathInAuthoredConfig(entry.pathSegments);
      const refPathExists = entry.refPathSegments
        ? hasPathInAuthoredConfig(entry.refPathSegments)
        : false;
      // Generated/defaulted target paths are still configurable, but mark them derived so
      // prompts can distinguish authored config from normalized aliases.
      return Object.assign(
        {
          type: entry.entry.targetType,
          path: entry.path,
          pathSegments: [...entry.pathSegments],
          label: entry.path,
          configFile: `openclaw.json` as const,
          expectedResolvedValue: entry.entry.expectedResolvedValue,
        },
        resolved.ref ? { existingRef: resolved.ref } : {},
        pathExists || refPathExists ? {} : { isDerived: true },
        entry.providerId ? { providerId: entry.providerId } : {},
        entry.accountId ? { accountId: entry.accountId } : {},
      );
    });

  const authCandidates =
    params.authProfiles === undefined
      ? []
      : discoverAuthProfileSecretTargets(params.authProfiles.store)
          .filter((entry) => entry.entry.includeInConfigure)
          .map((entry) => {
            const authProfiles = params.authProfiles;
            if (!authProfiles) {
              throw new Error("Missing auth profile scope for configure candidate discovery.");
            }
            const authProfileProvider = resolveAuthProfileProvider(
              authProfiles.store,
              entry.pathSegments,
            );
            // Auth-profile apply can create missing profiles only when the provider is known.
            const resolved = resolveSecretInputRef({
              value: entry.value,
              refValue: entry.refValue,
              defaults: params.config.secrets?.defaults,
            });
            return Object.assign(
              {
                type: entry.entry.targetType,
                path: entry.path,
                pathSegments: [...entry.pathSegments],
                label: `${entry.path} (auth profile, agent ${authProfiles.agentId})`,
                configFile: `auth-profiles.json` as const,
                expectedResolvedValue: entry.entry.expectedResolvedValue,
              },
              resolved.ref ? { existingRef: resolved.ref } : {},
              { agentId: authProfiles.agentId },
              authProfileProvider ? { authProfileProvider } : {},
            );
          });

  return [...openclawCandidates, ...authCandidates].toSorted((a, b) =>
    configureCandidateSortKey(a).localeCompare(configureCandidateSortKey(b)),
  );
}

function hasPath(root: unknown, segments: string[]): boolean {
  if (segments.length === 0) {
    return false;
  }
  let cursor: unknown = root;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] ?? "";
    if (Array.isArray(cursor)) {
      const parsedIndex = parseConfigPathArrayIndex(segment);
      if (parsedIndex === undefined || parsedIndex >= cursor.length) {
        return false;
      }
      if (index === segments.length - 1) {
        return true;
      }
      cursor = cursor[parsedIndex];
      continue;
    }
    if (!isRecord(cursor)) {
      return false;
    }
    if (!Object.hasOwn(cursor, segment)) {
      return false;
    }
    if (index === segments.length - 1) {
      return true;
    }
    cursor = cursor[segment];
  }
  return false;
}

/** Computes provider upserts/deletes between original and edited config. */
export function collectConfigureProviderChanges(params: {
  original: OpenClawConfig;
  next: OpenClawConfig;
}): ConfigureProviderChanges {
  const originalProviders = getSecretProviders(params.original);
  const nextProviders = getSecretProviders(params.next);

  const upserts: Record<string, SecretProviderConfig> = {};
  const deletes: string[] = [];

  for (const [providerAlias, nextProviderConfig] of Object.entries(nextProviders)) {
    const current = originalProviders[providerAlias];
    if (isDeepStrictEqual(current, nextProviderConfig)) {
      continue;
    }
    upserts[providerAlias] = structuredClone(nextProviderConfig);
  }

  for (const providerAlias of Object.keys(originalProviders)) {
    if (!Object.hasOwn(nextProviders, providerAlias)) {
      deletes.push(providerAlias);
    }
  }

  return {
    upserts,
    deletes: deletes.toSorted(),
  };
}

/** Returns true when selected targets or provider mutations would produce a plan. */
export function hasConfigurePlanChanges(params: {
  selectedTargets: ReadonlyMap<string, ConfigureSelectedTarget>;
  providerChanges: ConfigureProviderChanges;
}): boolean {
  return (
    params.selectedTargets.size > 0 ||
    Object.keys(params.providerChanges.upserts).length > 0 ||
    params.providerChanges.deletes.length > 0
  );
}

/** Builds the serializable secrets apply plan from configure selections. */
export function buildSecretsConfigurePlan(params: {
  selectedTargets: ReadonlyMap<string, ConfigureSelectedTarget>;
  providerChanges: ConfigureProviderChanges;
  generatedAt?: string;
}): SecretsApplyPlan {
  return {
    version: 1,
    protocolVersion: 1,
    generatedAt: params.generatedAt ?? new Date().toISOString(),
    generatedBy: "openclaw secrets configure",
    targets: [...params.selectedTargets.values()].map((entry) =>
      Object.assign(
        {
          type: entry.type,
          path: entry.path,
          pathSegments: [...entry.pathSegments],
          ref: entry.ref,
        },
        entry.agentId ? { agentId: entry.agentId } : {},
        entry.providerId ? { providerId: entry.providerId } : {},
        entry.accountId ? { accountId: entry.accountId } : {},
        entry.authProfileProvider ? { authProfileProvider: entry.authProfileProvider } : {},
      ),
    ),
    ...(Object.keys(params.providerChanges.upserts).length > 0
      ? { providerUpserts: params.providerChanges.upserts }
      : {}),
    ...(params.providerChanges.deletes.length > 0
      ? { providerDeletes: params.providerChanges.deletes }
      : {}),
    options: {
      scrubEnv: true,
      scrubAuthProfilesForProviderTargets: true,
      scrubLegacyAuthJson: true,
    },
  };
}
