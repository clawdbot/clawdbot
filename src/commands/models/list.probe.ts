/** Auth probe planning and execution helpers for model diagnostics. */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import pMap from "p-map";
import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import {
  type AuthProfileCredential as ProfileEntry,
  type AuthProfileEligibilityReasonCode,
  clearRuntimeAuthProfileStoreSnapshot,
  externalCliDiscoveryScoped,
  ensureAuthProfileStore,
  listProfilesForProvider,
  resolveAuthProfileDisplayLabel,
  resolveAuthProfileEligibility,
  upsertAuthProfileWithLock,
} from "../../agents/auth-profiles.js";
import { resolveAuthProfileOrderWithMetadata } from "../../agents/auth-profiles/order.js";
import { resolveAuthProfileDatabasePath } from "../../agents/auth-profiles/sqlite.js";
import { describeFailoverError } from "../../agents/failover-error.js";
import {
  hasUsableCustomProviderApiKey,
  resolveEnvApiKey,
  resolveProviderEntryApiKeyBinding,
  resolveProviderEntryApiKeyProfileReference,
  resolveUsableCustomProviderApiKey,
} from "../../agents/model-auth.js";
import { loadModelCatalog } from "../../agents/model-catalog.js";
import { findNormalizedProviderValue, normalizeProviderId } from "../../agents/model-selection.js";
import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import { resolveDefaultAgentWorkspaceDir } from "../../agents/workspace.js";
import {
  resolveSessionTranscriptPath,
  resolveSessionTranscriptsDirForAgent,
} from "../../config/sessions/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  coerceSecretRef,
  hasConfiguredSecretInput,
  normalizeSecretInputString,
} from "../../config/types.secrets.js";
import { type SecretRefResolveCache, resolveSecretRefString } from "../../secrets/resolve.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { disposeOpenClawAgentDatabaseByPath } from "../../state/openclaw-agent-db.js";
import { redactSecrets } from "../status-all/format.js";
import { buildProbeCandidateMap, selectProbeModel } from "./list.probe.models.js";
import { formatMs } from "./shared.js";

const PROBE_PROMPT = "Reply with OK. Do not use tools.";

/** Scrubs credential-shaped text before probe failures cross a UI or CLI boundary. */
export function redactAuthProbeError(error: string): string {
  return redactSecrets(error);
}

const embeddedRunnerModuleLoader = createLazyImportLoader(
  () => import("../../agents/embedded-agent.js"),
);

function loadEmbeddedRunnerModule() {
  return embeddedRunnerModuleLoader.load();
}

/** Normalized probe status bucket for auth/model diagnostics. */
export type AuthProbeStatus =
  | "ok"
  | "auth"
  | "rate_limit"
  | "billing"
  | "timeout"
  | "format"
  | "unknown"
  | "no_model";

/** Reason code for probes that never reached a model call. */
export type AuthProbeReasonCode =
  | "excluded_by_auth_order"
  | "missing_credential"
  | "expired"
  | "invalid_expires"
  | "unresolved_ref"
  | "ineligible_profile"
  | "no_model";

/** Result for one profile/env/models.json auth probe target. */
export type AuthProbeResult = {
  provider: string;
  model?: string;
  profileId?: string;
  label: string;
  source: "profile" | "env" | "models.json";
  mode?: string;
  status: AuthProbeStatus;
  reasonCode?: AuthProbeReasonCode;
  error?: string;
  latencyMs?: number;
};

type AuthProbeTarget = {
  provider: string;
  model?: { provider: string; model: string } | null;
  profileId?: string;
  label: string;
  source: "profile" | "env" | "models.json";
  mode?: string;
  boundValue?: string;
  useRuntimeAuth?: boolean;
};

/** Summary for a full auth probe run. */
export type AuthProbeSummary = {
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  totalTargets: number;
  options: {
    provider?: string;
    profileIds?: string[];
    timeoutMs: number;
    concurrency: number;
    maxTokens: number;
  };
  results: AuthProbeResult[];
};

/** Runtime options controlling provider/profile filtering and probe cost. */
export type AuthProbeOptions = {
  provider?: string;
  profileIds?: string[];
  includeDirectKeys?: boolean;
  timeoutMs: number;
  concurrency: number;
  maxTokens: number;
};

/** Maps runtime failover reasons into stable auth probe status buckets. */
export function mapFailoverReasonToProbeStatus(reason?: string | null): AuthProbeStatus {
  if (!reason) {
    return "unknown";
  }
  if (reason === "auth" || reason === "auth_permanent") {
    // Keep probe output backward-compatible: permanent auth failures still
    // surface in the auth bucket instead of showing as unknown.
    return "auth";
  }
  if (reason === "rate_limit" || reason === "overloaded") {
    return "rate_limit";
  }
  if (reason === "billing") {
    return "billing";
  }
  if (reason === "timeout") {
    return "timeout";
  }
  if (reason === "model_not_found") {
    return "format";
  }
  if (reason === "format") {
    return "format";
  }
  return "unknown";
}

function mapEligibilityReasonToProbeReasonCode(
  reasonCode: AuthProfileEligibilityReasonCode,
): AuthProbeReasonCode {
  if (reasonCode === "missing_credential") {
    return "missing_credential";
  }
  if (reasonCode === "expired") {
    return "expired";
  }
  if (reasonCode === "invalid_expires") {
    return "invalid_expires";
  }
  if (reasonCode === "unresolved_ref") {
    return "unresolved_ref";
  }
  return "ineligible_profile";
}

function formatMissingCredentialProbeError(reasonCode: AuthProbeReasonCode): string {
  const legacyLine = "Auth profile credentials are missing or expired.";
  if (reasonCode === "expired") {
    return `${legacyLine}\n↳ Auth reason [expired]: token credentials are expired.`;
  }
  if (reasonCode === "invalid_expires") {
    return `${legacyLine}\n↳ Auth reason [invalid_expires]: token expires must be a positive Unix ms timestamp.`;
  }
  if (reasonCode === "missing_credential") {
    return `${legacyLine}\n↳ Auth reason [missing_credential]: no inline credential or SecretRef is configured.`;
  }
  if (reasonCode === "unresolved_ref") {
    return `${legacyLine}\n↳ Auth reason [unresolved_ref]: configured SecretRef could not be resolved.`;
  }
  return `${legacyLine}\n↳ Auth reason [ineligible_profile]: profile is incompatible with provider config.`;
}

function resolveProbeSecretRef(profile: ProfileEntry, cfg: OpenClawConfig) {
  const defaults = cfg.secrets?.defaults;
  if (profile.type === "api_key") {
    if (normalizeSecretInputString(profile.key) !== undefined) {
      return null;
    }
    return coerceSecretRef(profile.keyRef, defaults);
  }
  if (profile.type === "token") {
    if (normalizeSecretInputString(profile.token) !== undefined) {
      return null;
    }
    return coerceSecretRef(profile.tokenRef, defaults);
  }
  return null;
}

function formatUnresolvedRefProbeError(refLabel: string): string {
  const legacyLine = "Auth profile credentials are missing or expired.";
  return `${legacyLine}\n↳ Auth reason [unresolved_ref]: could not resolve SecretRef "${refLabel}".`;
}

function withDirectCredential(
  cfg: OpenClawConfig,
  provider: string,
  value: string,
  mode: string | undefined,
): OpenClawConfig {
  const providers = cfg.models?.providers ?? {};
  const configKey =
    Object.keys(providers).find((key) => normalizeProviderId(key) === provider) ?? provider;
  const configured = providers[configKey];
  if (!configured) {
    return withoutProfileFallback(cfg, provider);
  }
  const auth = mode === "oauth" || mode === "token" ? mode : "api-key";
  return {
    ...cfg,
    models: {
      ...cfg.models,
      providers: {
        ...providers,
        [configKey]: {
          ...configured,
          apiKey: value,
          auth,
        },
      },
    },
    auth: {
      ...cfg.auth,
      order: {
        ...cfg.auth?.order,
        [provider]: [],
      },
    },
  };
}

function withoutProfileFallback(cfg: OpenClawConfig, provider: string): OpenClawConfig {
  return {
    ...cfg,
    auth: {
      ...cfg.auth,
      order: {
        ...cfg.auth?.order,
        [provider]: [],
      },
    },
  };
}

async function resolveConfiguredProbeCredential(params: {
  cfg: OpenClawConfig;
  input: unknown;
  cache: SecretRefResolveCache;
}): Promise<string | null> {
  const literal = normalizeSecretInputString(params.input);
  if (literal !== undefined) {
    return literal;
  }
  const ref = coerceSecretRef(params.input, params.cfg.secrets?.defaults);
  if (!ref) {
    return null;
  }
  try {
    return await resolveSecretRefString(ref, {
      config: params.cfg,
      env: process.env,
      cache: params.cache,
    });
  } catch {
    return null;
  }
}

async function maybeResolveUnresolvedRefIssue(params: {
  cfg: OpenClawConfig;
  profile?: ProfileEntry;
  cache: SecretRefResolveCache;
}): Promise<{ reasonCode: "unresolved_ref"; error: string } | null> {
  if (!params.profile) {
    return null;
  }
  const ref = resolveProbeSecretRef(params.profile, params.cfg);
  if (!ref) {
    return null;
  }
  try {
    await resolveSecretRefString(ref, {
      config: params.cfg,
      env: process.env,
      cache: params.cache,
    });
    return null;
  } catch {
    return {
      reasonCode: "unresolved_ref",
      error: formatUnresolvedRefProbeError(`${ref.source}:${ref.provider}:${ref.id}`),
    };
  }
}

/** Builds probe targets plus preflight failures for missing/invalid credentials. */
export async function buildProbeTargets(params: {
  cfg: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  providers: string[];
  modelCandidates: string[];
  options: AuthProbeOptions;
}): Promise<{ targets: AuthProbeTarget[]; results: AuthProbeResult[] }> {
  const { cfg, agentDir, providers, modelCandidates, options, workspaceDir } = params;
  const authAliasLookupParams = { config: cfg, workspaceDir };
  const store = ensureAuthProfileStore(agentDir, {
    externalCli: externalCliDiscoveryScoped({
      config: cfg,
      allowKeychainPrompt: false,
      providerIds: providers.map((provider) =>
        resolveProviderIdForAuth(provider, authAliasLookupParams),
      ),
      profileIds: options.profileIds,
    }),
  });
  const providerFilter = options.provider?.trim();
  const providerFilterKey = providerFilter ? normalizeProviderId(providerFilter) : null;
  const profileFilter = new Set(normalizeUniqueStringEntries(options.profileIds));
  const refResolveCache: SecretRefResolveCache = {};
  const catalog = await loadModelCatalog({ config: cfg });
  const candidates = buildProbeCandidateMap(modelCandidates);
  const targets: AuthProbeTarget[] = [];
  const results: AuthProbeResult[] = [];

  for (const provider of providers) {
    const providerKey = normalizeProviderId(provider);
    const authProviderKey = resolveProviderIdForAuth(providerKey, authAliasLookupParams);
    if (providerFilterKey && providerKey !== providerFilterKey) {
      continue;
    }

    const model = selectProbeModel({
      provider: providerKey,
      candidates,
      catalog,
    });
    const configuredProvider = findNormalizedProviderValue(cfg.models?.providers, providerKey);
    const includeDirectKeys = options.includeDirectKeys === true && profileFilter.size === 0;
    const includeConfigKey =
      includeDirectKeys &&
      profileFilter.size === 0 &&
      hasConfiguredSecretInput(configuredProvider?.apiKey, cfg.secrets?.defaults);
    // Keep profiles saved under either surface. The production profile helper
    // is alias-aware, but scoped plugin metadata can differ between lookups.
    const profileIds = [
      ...new Set([
        ...listProfilesForProvider(store, authProviderKey),
        ...(authProviderKey === providerKey ? [] : listProfilesForProvider(store, providerKey)),
      ]),
    ];
    const configuredReference = includeConfigKey
      ? resolveProviderEntryApiKeyProfileReference({
          cfg,
          provider: providerKey,
          store,
        })
      : ({ kind: "none" } as const);
    const configuredBinding =
      configuredReference.kind === "profile" && !profileIds.includes(configuredReference.profileId)
        ? await resolveProviderEntryApiKeyBinding({
            cfg,
            provider: providerKey,
            store,
            agentDir,
          })
        : null;
    const configuredValue =
      includeConfigKey &&
      configuredReference.kind !== "profile" &&
      configuredReference.kind !== "profile-incompatible"
        ? configuredReference.kind === "marker"
          ? (resolveUsableCustomProviderApiKey({
              cfg,
              provider: providerKey,
              env: process.env,
            })?.apiKey ?? null)
          : await resolveConfiguredProbeCredential({
              cfg,
              input: configuredProvider?.apiKey,
              cache: refResolveCache,
            })
        : null;
    const configuredMode =
      configuredProvider?.auth === "oauth" || configuredProvider?.auth === "token"
        ? configuredProvider.auth
        : "api_key";
    const resolvedEnvironmentValue = includeDirectKeys
      ? resolveEnvApiKey(authProviderKey, process.env, {
          config: cfg,
          workspaceDir,
        })
      : null;
    const environmentValue =
      resolvedEnvironmentValue?.apiKey === configuredValue ? null : resolvedEnvironmentValue;

    const appendDirectTargets = () => {
      if (includeConfigKey) {
        if (configuredReference.kind === "profile-incompatible") {
          results.push({
            provider: providerKey,
            model: model ? `${model.provider}/${model.model}` : undefined,
            profileId: configuredReference.profileId,
            label: "config",
            source: "models.json",
            mode: configuredMode,
            status: "unknown",
            reasonCode: "ineligible_profile",
            error: "Configured API key references an incompatible auth profile.",
          });
        } else if (configuredReference.kind === "profile") {
          if (!profileIds.includes(configuredReference.profileId)) {
            if (configuredBinding?.kind === "profile-resolved" && model) {
              targets.push({
                provider: providerKey,
                model,
                profileId: configuredBinding.auth.profileId,
                label: "config",
                source: "models.json",
                mode: configuredBinding.auth.mode,
                boundValue: configuredBinding.auth.apiKey,
              });
            } else {
              results.push({
                provider: providerKey,
                model: model ? `${model.provider}/${model.model}` : undefined,
                profileId: configuredReference.profileId,
                label: "config",
                source: "models.json",
                mode: configuredMode,
                status: model ? "unknown" : "no_model",
                reasonCode: model ? "unresolved_ref" : "no_model",
                error: model
                  ? "Configured auth profile could not be resolved."
                  : "No model available for probe",
              });
            }
          }
        } else if (!configuredValue) {
          results.push({
            provider: providerKey,
            model: model ? `${model.provider}/${model.model}` : undefined,
            label: "config",
            source: "models.json",
            mode: configuredMode,
            status: model ? "unknown" : "no_model",
            reasonCode: model ? "unresolved_ref" : "no_model",
            error: model
              ? "Configured API key could not be resolved."
              : "No model available for probe",
          });
        } else if (model) {
          targets.push({
            provider: providerKey,
            model,
            label: "config",
            source: "models.json",
            mode: configuredMode,
            boundValue: configuredValue,
            ...(configuredReference.kind === "marker" ? { useRuntimeAuth: true } : {}),
          });
        } else {
          // Config credential resolved but no probe model exists: report the
          // defined no_model status instead of dropping the target, matching
          // the environment branch below.
          results.push({
            provider: providerKey,
            model: undefined,
            label: "config",
            source: "models.json",
            mode: configuredMode,
            status: "no_model",
            reasonCode: "no_model",
            error: "No model available for probe",
          });
        }
      }
      if (environmentValue) {
        // Honor an explicit provider auth override (token/oauth) the way normal
        // dispatch does; only fall back to the env-name heuristic when the
        // provider does not pin a mode, so a token-auth provider fed by a
        // *_API_KEY var is not misprobed as api-key and falsely failed.
        const mode =
          configuredProvider?.auth === "oauth" || configuredProvider?.auth === "token"
            ? configuredProvider.auth
            : environmentValue.source.includes("OAUTH_TOKEN")
              ? "oauth"
              : "api_key";
        if (model) {
          targets.push({
            provider: providerKey,
            model,
            label: environmentValue.source,
            source: "env",
            mode,
            boundValue: environmentValue.apiKey,
          });
        } else {
          results.push({
            provider: providerKey,
            model: undefined,
            label: environmentValue.source,
            source: "env",
            mode,
            status: "no_model",
            reasonCode: "no_model",
            error: "No model available for probe",
          });
        }
      }
    };
    const explicitOrder =
      findNormalizedProviderValue(store.order, authProviderKey) ??
      findNormalizedProviderValue(store.order, providerKey) ??
      findNormalizedProviderValue(cfg?.auth?.order, authProviderKey) ??
      findNormalizedProviderValue(cfg?.auth?.order, providerKey);
    const orderResolution = resolveAuthProfileOrderWithMetadata({
      cfg,
      store,
      provider: providerKey,
      forModel: model?.model,
    });
    const allowedProfiles = orderResolution.hasExplicitOrder
      ? new Set(orderResolution.profileIds)
      : null;
    // Explicit auth.order both selects and documents profile eligibility; report
    // excluded profiles instead of silently skipping them.
    const filteredProfiles = profileFilter.size
      ? profileIds.filter((id) => profileFilter.has(id))
      : profileIds;

    if (filteredProfiles.length > 0) {
      for (const profileId of filteredProfiles) {
        const profile = store.profiles[profileId];
        const mode = profile?.type;
        const label = resolveAuthProfileDisplayLabel({ cfg, store, profileId });
        // A profile referenced by models.providers.<id>.apiKey is resolved by
        // runtime binding ahead of auth.order fallback, so it stays effective
        // even when excluded from auth.order. Probe it instead of reporting it
        // as excluded, matching runtime credential precedence.
        const isConfigBoundProfile =
          includeConfigKey &&
          configuredReference.kind === "profile" &&
          profileId === configuredReference.profileId;
        if (!isConfigBoundProfile && explicitOrder && !explicitOrder.includes(profileId)) {
          results.push({
            provider: providerKey,
            profileId,
            model: model ? `${model.provider}/${model.model}` : undefined,
            label,
            source: "profile",
            mode,
            status: "unknown",
            reasonCode: "excluded_by_auth_order",
            error: "Excluded by auth.order for this provider.",
          });
          continue;
        }
        if (!isConfigBoundProfile && allowedProfiles && !allowedProfiles.has(profileId)) {
          const eligibility = resolveAuthProfileEligibility({
            cfg,
            store,
            provider: providerKey,
            profileId,
          });
          const reasonCode = mapEligibilityReasonToProbeReasonCode(eligibility.reasonCode);
          results.push({
            provider: providerKey,
            model: model ? `${model.provider}/${model.model}` : undefined,
            profileId,
            label,
            source: "profile",
            mode,
            status: "unknown",
            reasonCode,
            error: formatMissingCredentialProbeError(reasonCode),
          });
          continue;
        }
        const unresolvedRefIssue = await maybeResolveUnresolvedRefIssue({
          cfg,
          profile,
          cache: refResolveCache,
        });
        if (unresolvedRefIssue) {
          results.push({
            provider: providerKey,
            model: model ? `${model.provider}/${model.model}` : undefined,
            profileId,
            label,
            source: "profile",
            mode,
            status: "unknown",
            reasonCode: unresolvedRefIssue.reasonCode,
            error: unresolvedRefIssue.error,
          });
          continue;
        }
        if (!model) {
          results.push({
            provider: providerKey,
            model: undefined,
            profileId,
            label,
            source: "profile",
            mode,
            status: "no_model",
            reasonCode: "no_model",
            error: "No model available for probe",
          });
          continue;
        }
        targets.push({
          provider: providerKey,
          model,
          profileId,
          label,
          source: "profile",
          mode,
        });
      }
      appendDirectTargets();
      continue;
    }

    if (profileFilter.size > 0) {
      continue;
    }
    appendDirectTargets();
    if (includeConfigKey || environmentValue) {
      continue;
    }
    const hasUsableModelsJsonKey = hasUsableCustomProviderApiKey(cfg, providerKey);
    if (orderResolution.hasExplicitOrder && !hasUsableModelsJsonKey) {
      continue;
    }

    const envKey = orderResolution.hasExplicitOrder
      ? null
      : resolveEnvApiKey(authProviderKey, process.env, {
          config: cfg,
          workspaceDir,
        });
    if (!envKey && !hasUsableModelsJsonKey) {
      continue;
    }

    const label = envKey ? "env" : "models.json";
    const source = envKey ? "env" : "models.json";
    const mode = envKey?.source.includes("OAUTH_TOKEN") ? "oauth" : "api_key";

    if (!model) {
      results.push({
        provider: providerKey,
        model: undefined,
        label,
        source,
        mode,
        status: "no_model",
        reasonCode: "no_model",
        error: "No model available for probe",
      });
      continue;
    }

    targets.push({
      provider: providerKey,
      model,
      label,
      source,
      mode,
    });
  }

  return { targets, results };
}

async function probeTarget(params: {
  cfg: OpenClawConfig;
  agentId: string;
  agentDir: string;
  workspaceDir: string;
  sessionDir: string;
  target: AuthProbeTarget;
  timeoutMs: number;
  maxTokens: number;
}): Promise<AuthProbeResult> {
  const { cfg, agentId, agentDir, workspaceDir, sessionDir, target, timeoutMs, maxTokens } = params;
  // Marker credentials must be resolved by the runtime from config, but the
  // "config" probe must reflect only that credential — empty the provider auth
  // order and isolate the agent dir so stored profiles cannot satisfy it via
  // failover. Direct bound values instead pin an isolated synthetic profile.
  const probeConfig = !target.boundValue
    ? cfg
    : target.useRuntimeAuth
      ? withoutProfileFallback(cfg, target.provider)
      : withDirectCredential(cfg, target.provider, target.boundValue, target.mode);
  if (!target.model) {
    return {
      provider: target.provider,
      model: undefined,
      profileId: target.profileId,
      label: target.label,
      source: target.source,
      mode: target.mode,
      status: "no_model",
      reasonCode: "no_model",
      error: "No model available for probe",
    };
  }
  const model = target.model;

  const sessionId = `probe-${target.provider}-${crypto.randomUUID()}`;
  const sessionFile = resolveSessionTranscriptPath(sessionId, agentId);
  await fs.mkdir(sessionDir, { recursive: true });
  let isolatedAgentDir: string | null = null;
  let isolatedProfileId: string | undefined;

  const start = Date.now();
  const buildResult = (status: AuthProbeResult["status"], error?: string): AuthProbeResult => ({
    provider: target.provider,
    model: `${model.provider}/${model.model}`,
    profileId: target.profileId,
    label: target.label,
    source: target.source,
    mode: target.mode,
    status,
    ...(error ? { error } : {}),
    latencyMs: Date.now() - start,
  });
  try {
    // Any bound-value target runs in an empty agent dir so stored profiles are
    // absent and cannot satisfy the probe via failover. Direct values pin a
    // synthetic profile; marker values are resolved by the runtime from the
    // profile-order-cleared config.
    if (target.boundValue) {
      // Canonicalize so the isolated agent DB registers and unregisters under
      // one path. os.tmpdir() is a symlink on macOS (/var -> /private/var), and
      // disposeOpenClawAgentDatabaseByPath's exact-path guard would otherwise
      // skip the registry row, leaking an agent_databases entry per probe.
      isolatedAgentDir = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-probe-")),
      );
    }
    if (target.boundValue && !target.useRuntimeAuth && isolatedAgentDir) {
      isolatedProfileId = `${target.provider}:probe-${crypto.randomUUID()}`;
      const value = target.boundValue;
      const profile: ProfileEntry =
        target.mode === "oauth"
          ? {
              type: "oauth",
              provider: target.provider,
              access: value,
              refresh: "not-a-real",
              expires: Date.now() + 60 * 60 * 1000,
            }
          : target.mode === "token"
            ? { type: "token", provider: target.provider, token: value }
            : { type: "api_key", provider: target.provider, key: value };
      const updated = await upsertAuthProfileWithLock({
        profileId: isolatedProfileId,
        credential: profile,
        agentDir: isolatedAgentDir,
      });
      if (!updated) {
        throw new Error("Could not prepare isolated auth probe profile");
      }
    }
    const { runEmbeddedAgent } = await loadEmbeddedRunnerModule();
    await runEmbeddedAgent({
      sessionId,
      sessionFile,
      agentId,
      workspaceDir,
      agentDir: isolatedAgentDir ?? agentDir,
      config: probeConfig,
      prompt: PROBE_PROMPT,
      provider: target.model.provider,
      model: target.model.model,
      authProfileId: isolatedProfileId ?? target.profileId,
      authProfileIdSource: isolatedProfileId || target.profileId ? "user" : undefined,
      timeoutMs,
      runId: `probe-${crypto.randomUUID()}`,
      lane: `auth-probe:${target.provider}:${target.profileId ?? target.source}`,
      thinkLevel: "off",
      reasoningLevel: "off",
      verboseLevel: "off",
      streamParams: { maxTokens },
      disableTools: true,
      modelRun: true,
      cleanupBundleMcpOnRunEnd: true,
    });
    return buildResult("ok");
  } catch (err) {
    const described = describeFailoverError(err);
    return buildResult(
      mapFailoverReasonToProbeStatus(described.reason),
      redactAuthProbeError(described.message),
    );
  } finally {
    if (isolatedAgentDir) {
      clearRuntimeAuthProfileStoreSnapshot(isolatedAgentDir);
      disposeOpenClawAgentDatabaseByPath(resolveAuthProfileDatabasePath(isolatedAgentDir));
      await fs.rm(isolatedAgentDir, { recursive: true, force: true });
    }
  }
}

async function runTargetsWithConcurrency(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  targets: AuthProbeTarget[];
  timeoutMs: number;
  maxTokens: number;
  concurrency: number;
  onProgress?: (update: { completed: number; total: number; label?: string }) => void;
}): Promise<AuthProbeResult[]> {
  const { cfg, targets, timeoutMs, maxTokens, onProgress } = params;
  const concurrency = Math.max(1, Math.min(targets.length || 1, params.concurrency));

  const agentId = params.agentId ?? resolveDefaultAgentId(cfg);
  const agentDir = params.agentDir ?? resolveAgentDir(cfg, agentId);
  const workspaceDir =
    params.workspaceDir ??
    resolveAgentWorkspaceDir(cfg, agentId) ??
    resolveDefaultAgentWorkspaceDir();
  const sessionDir = resolveSessionTranscriptsDirForAgent(agentId);

  await fs.mkdir(workspaceDir, { recursive: true });

  let completed = 0;
  return await pMap(
    targets,
    async (target) => {
      onProgress?.({
        completed,
        total: targets.length,
        label: `Probing ${target.provider}${target.profileId ? ` (${target.label})` : ""}`,
      });
      const result = await probeTarget({
        cfg,
        agentId,
        agentDir,
        workspaceDir,
        sessionDir,
        target,
        timeoutMs,
        maxTokens,
      });
      completed += 1;
      onProgress?.({ completed, total: targets.length });
      return result;
    },
    { concurrency, stopOnError: true },
  );
}

/** Runs all auth probes with bounded concurrency and returns a summary. */
export async function runAuthProbes(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  providers: string[];
  modelCandidates: string[];
  options: AuthProbeOptions;
  onProgress?: (update: { completed: number; total: number; label?: string }) => void;
}): Promise<AuthProbeSummary> {
  const startedAt = Date.now();
  const plan = await buildProbeTargets({
    cfg: params.cfg,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    providers: params.providers,
    modelCandidates: params.modelCandidates,
    options: params.options,
  });

  const totalTargets = plan.targets.length;
  params.onProgress?.({ completed: 0, total: totalTargets });

  const results = totalTargets
    ? await runTargetsWithConcurrency({
        cfg: params.cfg,
        agentId: params.agentId,
        agentDir: params.agentDir,
        workspaceDir: params.workspaceDir,
        targets: plan.targets,
        timeoutMs: params.options.timeoutMs,
        maxTokens: params.options.maxTokens,
        concurrency: params.options.concurrency,
        onProgress: params.onProgress,
      })
    : [];

  const finishedAt = Date.now();

  return {
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
    totalTargets,
    options: params.options,
    results: [...plan.results, ...results],
  };
}

/** Formats probe latency for table output. */
export function formatProbeLatency(latencyMs?: number | null) {
  if (!latencyMs && latencyMs !== 0) {
    return "-";
  }
  return formatMs(latencyMs);
}

/** Sorts probe results by provider and display label. */
export function sortProbeResults(results: AuthProbeResult[]): AuthProbeResult[] {
  return results.slice().toSorted((a, b) => {
    const provider = a.provider.localeCompare(b.provider);
    if (provider !== 0) {
      return provider;
    }
    const aLabel = a.label || a.profileId || "";
    const bLabel = b.label || b.profileId || "";
    return aLabel.localeCompare(bLabel);
  });
}

/** Produces the terse completion line for auth probe output. */
export function describeProbeSummary(summary: AuthProbeSummary): string {
  if (summary.totalTargets === 0) {
    return "No probe targets.";
  }
  return `Probed ${summary.totalTargets} target${summary.totalTargets === 1 ? "" : "s"} in ${formatMs(summary.durationMs)}`;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
