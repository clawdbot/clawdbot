import crypto from "node:crypto";
import fs from "node:fs/promises";
import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import {
  type AuthProfileCredential,
  type AuthProfileEligibilityReasonCode,
  externalCliDiscoveryScoped,
  ensureAuthProfileStore,
  listProfilesForProvider,
  resolveAuthProfileDisplayLabel,
  resolveAuthProfileEligibility,
  resolveAuthProfileOrder,
} from "../../agents/auth-profiles.js";
import { describeFailoverError } from "../../agents/failover-error.js";
import { hasUsableCustomProviderApiKey, resolveEnvApiKey } from "../../agents/model-auth.js";
import { loadModelCatalog } from "../../agents/model-catalog.js";
import {
  findNormalizedProviderValue,
  normalizeProviderId,
  parseModelRef,
} from "../../agents/model-selection.js";
import { resolveDefaultAgentWorkspaceDir } from "../../agents/workspace.js";
import {
  resolveSessionTranscriptPath,
  resolveSessionTranscriptsDirForAgent,
} from "../../config/sessions/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { coerceSecretRef, normalizeSecretInputString } from "../../config/types.secrets.js";
import { type SecretRefResolveCache, resolveSecretRefString } from "../../secrets/resolve.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { redactSecrets } from "../status-all/format.js";
import { DEFAULT_PROVIDER, formatMs } from "./shared.js";

const PROBE_PROMPT = "Reply with OK. Do not use tools.";

const embeddedRunnerModuleLoader = createLazyImportLoader(
  () => import("../../agents/pi-embedded.js"),
);

function loadEmbeddedRunnerModule() {
  return embeddedRunnerModuleLoader.load();
}

export type AuthProbeStatus =
  | "ok"
  | "auth"
  | "rate_limit"
  | "billing"
  | "timeout"
  | "format"
  | "unknown"
  | "no_model";

export type AuthProbeReasonCode =
  | "excluded_by_auth_order"
  | "missing_credential"
  | "expired"
  | "invalid_expires"
  | "unresolved_ref"
  | "ineligible_profile"
  | "no_model";

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
};

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

export type AuthProbeOptions = {
  provider?: string;
  profileIds?: string[];
  timeoutMs: number;
  concurrency: number;
  maxTokens: number;
};

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

function buildCandidateMap(modelCandidates: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const raw of modelCandidates) {
    const parsed = parseModelRef(raw ?? "", DEFAULT_PROVIDER);
    if (!parsed) {
      continue;
    }
    const list = map.get(parsed.provider) ?? [];
    if (!list.includes(parsed.model)) {
      list.push(parsed.model);
    }
    map.set(parsed.provider, list);
  }
  return map;
}

function catalogProbePriority(provider: string, modelId: string): number {
  const id = modelId.trim().toLowerCase();
  if (provider !== "anthropic") {
    return 50;
  }
  if (/^claude-haiku-4-5-\d{8}$/.test(id)) {
    return 0;
  }
  if (id === "claude-haiku-4-5") {
    return 1;
  }
  if (id === "claude-sonnet-4-6" || id.startsWith("claude-sonnet-4-6-")) {
    return 2;
  }
  if (id.startsWith("claude-sonnet-4-")) {
    return 3;
  }
  if (id.startsWith("claude-3-")) {
    return 100;
  }
  return 50;
}

function selectProbeModel(params: {
  provider: string;
  candidates: Map<string, string[]>;
  catalog: Array<{ provider: string; id: string }>;
}): { provider: string; model: string } | null {
  const { provider, candidates, catalog } = params;
  const direct = candidates.get(provider);
  if (direct && direct.length > 0) {
    return { provider, model: direct[0] };
  }
  const fromCatalog = catalog
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => normalizeProviderId(entry.provider) === provider)
    .toSorted((left, right) => {
      const priority =
        catalogProbePriority(provider, left.entry.id) -
        catalogProbePriority(provider, right.entry.id);
      return priority || left.index - right.index;
    })[0]?.entry;
  if (fromCatalog) {
    return { provider, model: fromCatalog.id };
  }
  return null;
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

function resolveProbeSecretRef(profile: AuthProfileCredential, cfg: OpenClawConfig) {
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

async function maybeResolveUnresolvedRefIssue(params: {
  cfg: OpenClawConfig;
  profile?: AuthProfileCredential;
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

export async function buildProbeTargets(params: {
  cfg: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  providers: string[];
  modelCandidates: string[];
  options: AuthProbeOptions;
}): Promise<{ targets: AuthProbeTarget[]; results: AuthProbeResult[] }> {
  const { cfg, agentDir, providers, modelCandidates, options, workspaceDir } = params;
  const store = ensureAuthProfileStore(agentDir, {
    externalCli: externalCliDiscoveryScoped({
      config: cfg,
      allowKeychainPrompt: false,
      providerIds: providers,
      profileIds: options.profileIds,
    }),
  });
  const providerFilter = options.provider?.trim();
  const providerFilterKey = providerFilter ? normalizeProviderId(providerFilter) : null;
  const profileFilter = new Set((options.profileIds ?? []).map((id) => id.trim()).filter(Boolean));
  const refResolveCache: SecretRefResolveCache = {};
  const catalog = await loadModelCatalog({ config: cfg });
  const candidates = buildCandidateMap(modelCandidates);
  const targets: AuthProbeTarget[] = [];
  const results: AuthProbeResult[] = [];

  for (const provider of providers) {
    const providerKey = normalizeProviderId(provider);
    if (providerFilterKey && providerKey !== providerFilterKey) {
      continue;
    }

    const model = selectProbeModel({
      provider: providerKey,
      candidates,
      catalog,
    });

    const profileIds = listProfilesForProvider(store, providerKey);
    const explicitOrder = (() => {
      return (
        findNormalizedProviderValue(store.order, providerKey) ??
        findNormalizedProviderValue(cfg?.auth?.order, providerKey)
      );
    })();
    const allowedProfiles =
      explicitOrder && explicitOrder.length > 0
        ? new Set(resolveAuthProfileOrder({ cfg, store, provider: providerKey }))
        : null;
    const filteredProfiles = profileFilter.size
      ? profileIds.filter((id) => profileFilter.has(id))
      : profileIds;

    if (filteredProfiles.length > 0) {
      for (const profileId of filteredProfiles) {
        const profile = store.profiles[profileId];
        const mode = profile?.type;
        const label = resolveAuthProfileDisplayLabel({ cfg, store, profileId });
        if (explicitOrder && !explicitOrder.includes(profileId)) {
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
        if (allowedProfiles && !allowedProfiles.has(profileId)) {
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
      continue;
    }

    if (profileFilter.size > 0) {
      continue;
    }

    const envKey = resolveEnvApiKey(providerKey, process.env, {
      config: cfg,
      workspaceDir,
    });
    const hasUsableModelsJsonKey = hasUsableCustomProviderApiKey(cfg, providerKey);
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
    const { runEmbeddedPiAgent } = await loadEmbeddedRunnerModule();
    await runEmbeddedPiAgent({
      sessionId,
      sessionFile,
      agentId,
      workspaceDir,
      agentDir,
      config: cfg,
      prompt: PROBE_PROMPT,
      provider: target.model.provider,
      model: target.model.model,
      authProfileId: target.profileId,
      authProfileIdSource: target.profileId ? "user" : undefined,
      timeoutMs,
      runId: `probe-${crypto.randomUUID()}`,
      lane: `auth-probe:${target.provider}:${target.profileId ?? target.source}`,
      thinkLevel: "off",
      reasoningLevel: "off",
      verboseLevel: "off",
      streamParams: { maxTokens },
      disableTools: true,
      cleanupBundleMcpOnRunEnd: true,
    });
    return buildResult("ok");
  } catch (err) {
    const described = describeFailoverError(err);
    return buildResult(
      mapFailoverReasonToProbeStatus(described.reason),
      redactSecrets(described.message),
    );
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
  const results: Array<AuthProbeResult | undefined> = Array.from({ length: targets.length });
  let cursor = 0;

  const worker = async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= targets.length) {
        return;
      }
      const target = targets[index];
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
      results[index] = result;
      completed += 1;
      onProgress?.({ completed, total: targets.length });
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  return results.filter((entry): entry is AuthProbeResult => Boolean(entry));
}

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

export function formatProbeLatency(latencyMs?: number | null) {
  if (!latencyMs && latencyMs !== 0) {
    return "-";
  }
  return formatMs(latencyMs);
}

export function groupProbeResults(results: AuthProbeResult[]): Map<string, AuthProbeResult[]> {
  const map = new Map<string, AuthProbeResult[]>();
  for (const result of results) {
    const list = map.get(result.provider) ?? [];
    list.push(result);
    map.set(result.provider, list);
  }
  return map;
}

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

export function describeProbeSummary(summary: AuthProbeSummary): string {
  if (summary.totalTargets === 0) {
    return "No probe targets.";
  }
  return `Probed ${summary.totalTargets} target${summary.totalTargets === 1 ? "" : "s"} in ${formatMs(summary.durationMs)}`;
}
