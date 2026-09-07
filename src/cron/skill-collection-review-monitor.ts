/** Canonical projection from skill workshop config to system-owned cron jobs. */
import {
  listAgentIds,
  resolveAgentConfig,
  resolveAgentModelFallbacksOverride,
  resolveSubagentModelConfigSelectionResult,
  resolveSubagentModelFallbacksOverride,
} from "../agents/agent-scope.js";
import { resolveAvailableAgentHarnessPolicy } from "../agents/harness/availability.js";
import { resolveModelCandidateChain } from "../agents/model-fallback-candidates.js";
import { resolveCliRuntimeExecutionProvider } from "../agents/model-runtime-aliases.js";
import { isCliProvider } from "../agents/model-selection-cli.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection-config.js";
import {
  buildModelAliasIndex,
  inferUniqueProviderFromConfiguredModels,
  normalizeModelSelection,
  resolveModelRefFromString,
} from "../agents/model-selection-shared.js";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../config/model-input.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveHeartbeatSchedulerSeed } from "../infra/heartbeat-runner.js";
import { resolveHeartbeatPhaseMs } from "../infra/heartbeat-schedule.js";
import { resolveSkillWorkshopConfig } from "../skills/workshop/config.js";
import {
  SKILL_WORKSHOP_MAINTENANCE_PROMPT,
  SKILL_WORKSHOP_MAINTENANCE_TOOLS,
} from "../skills/workshop/maintenance-prompt.js";
import { supportsCronExecutionRoot } from "./execution-root-runtime.js";
import { resolveCronAgentConfigFromSnapshot } from "./isolated-agent/run-config.js";
import { resolveCronAgentSessionKey } from "./isolated-agent/session-key.js";
import { partitionSystemMonitors } from "./system-monitor-jobs.js";
import { SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX } from "./system-owned-declaration.js";
import type { CronJob, CronJobCreate } from "./types.js";

const SKILL_COLLECTION_REVIEW_EVERY_MS = 7 * 24 * 60 * 60_000;
const SKILL_COLLECTION_REVIEW_NO_ROOTED_RUNTIME_REASON = "no-rooted-runtime";

/** Returns undefined when static config cannot prove the full runtime chain. */
function hasEligibleSkillCollectionReviewRuntime(
  cfg: OpenClawConfig,
  agentId: string,
): boolean | undefined {
  const agentConfig = resolveAgentConfig(cfg, agentId);
  const { cfgWithAgentDefaults } = resolveCronAgentConfigFromSnapshot({
    config: cfg,
    agentConfigOverride: agentConfig,
  });
  const defaultRef = resolveDefaultModelForAgent({ cfg: cfgWithAgentDefaults });
  const selection = resolveSubagentModelConfigSelectionResult({
    cfg,
    agentId,
    agentConfigOverride: agentConfig,
  });
  const selectedRaw = selection ? normalizeModelSelection(selection.raw) : undefined;
  const aliasIndex = buildModelAliasIndex({ cfg, agentId, defaultProvider: defaultRef.provider });
  const selected = selectedRaw
    ? resolveModelRefFromString({
        cfg,
        agentId,
        aliasIndex,
        raw: selectedRaw,
        defaultProvider: !selectedRaw.includes("/")
          ? (inferUniqueProviderFromConfiguredModels({ cfg, agentId, model: selectedRaw }) ??
            defaultRef.provider)
          : defaultRef.provider,
      })?.ref
    : defaultRef;
  if (!selected) {
    return undefined;
  }

  const agentModel = agentConfig?.model;
  const inheritsDefaultFallbacks =
    typeof agentModel === "string" &&
    resolveAgentModelPrimaryValue(agentModel) ===
      resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model);
  const defaultFallbacks =
    (inheritsDefaultFallbacks
      ? resolveAgentModelFallbackValues(cfgWithAgentDefaults.agents?.defaults?.model)
      : resolveAgentModelFallbacksOverride(cfgWithAgentDefaults, agentId)) ??
    resolveAgentModelFallbackValues(cfgWithAgentDefaults.agents?.defaults?.model);
  const fallbacksOverride =
    (selection?.source === "subagent" || selection?.source === "default-subagent"
      ? resolveSubagentModelFallbacksOverride(cfgWithAgentDefaults, agentId)
      : defaultFallbacks) ?? defaultFallbacks;

  // Advisory model selections are accepted only against the execution owner's live
  // catalog/policy. Projection cannot prove that acceptance, so also consider the
  // default chain that execution retains when the advisory selection is rejected.
  const chains = [
    { selected, fallbacksOverride },
    { selected: defaultRef, fallbacksOverride: defaultFallbacks },
  ];
  const eligibility = new Set(
    chains.map((chain) => {
      // A plugin-owned or otherwise unresolved ref may become runnable after runtime preparation.
      // Keep the job enabled unless every configured candidate can be classified now.
      if (
        chain.fallbacksOverride.some(
          (raw) =>
            !resolveModelRefFromString({
              cfg: cfgWithAgentDefaults,
              agentId,
              aliasIndex,
              raw,
              defaultProvider: chain.selected.provider,
            }),
        )
      ) {
        return undefined;
      }

      const candidates = resolveModelCandidateChain({
        cfg: cfgWithAgentDefaults,
        agentId,
        provider: chain.selected.provider,
        model: chain.selected.model,
        requestedRouteResolution: "resolved",
        fallbacksOverride: chain.fallbacksOverride,
      });
      if (candidates.length === 0) {
        return undefined;
      }
      return candidates.some((candidate) => {
        const policy = resolveAvailableAgentHarnessPolicy({
          mode: "projection",
          config: cfgWithAgentDefaults,
          provider: candidate.provider,
          modelId: candidate.model,
          agentId,
        });
        const executionProvider =
          resolveCliRuntimeExecutionProvider({
            cfg: cfgWithAgentDefaults,
            provider: candidate.provider,
            modelId: candidate.model,
            agentId,
          }) ?? candidate.provider;
        // Implicit/auto runtime selection can still fall back to embedded
        // execution after harness preparation; it cannot prove rejection here.
        return (
          policy.runtimeSource === "implicit" ||
          policy.runtime === "auto" ||
          supportsCronExecutionRoot(
            policy.runtime,
            isCliProvider(executionProvider, cfgWithAgentDefaults),
          )
        );
      });
    }),
  );
  return eligibility.has(true) ? true : eligibility.has(undefined) ? undefined : false;
}

export function skillCollectionReviewMonitorAgentId(job: CronJob): string | undefined {
  const key = job.declarationKey;
  if (!key?.startsWith(SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX)) {
    return undefined;
  }
  return key.slice(SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX.length) || undefined;
}

function hasStoredExecutionPreference(
  cfg: OpenClawConfig,
  agentId: string,
  jobId: string,
): boolean {
  try {
    const entry = loadSessionEntry({
      storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId }),
      sessionKey: resolveCronAgentSessionKey({
        sessionKey: `cron:${jobId}`,
        agentId,
        mainKey: cfg.session?.mainKey,
        cfg,
      }),
      readConsistency: "latest",
    });
    return Boolean(entry?.modelOverride || entry?.agentRuntimeOverride);
  } catch {
    // An unavailable session store is not evidence that no preference exists.
    return true;
  }
}

/** One system-owned review job per configured agent and its Workshop directory. */
export function resolveSkillCollectionReviewMonitorSpecs(
  cfg: OpenClawConfig,
  jobs: readonly CronJob[],
  options: { schedulerSeed?: string } = {},
): Array<{ agentId: string; input: CronJobCreate }> {
  const schedulerSeed = resolveHeartbeatSchedulerSeed(options.schedulerSeed);
  const { retained } = partitionSystemMonitors(jobs, skillCollectionReviewMonitorAgentId);
  const workshopEnabled = resolveSkillWorkshopConfig(cfg).autonomous.mode === "auto";
  return listAgentIds(cfg).map((agentId) => {
    const configuredEligibility = hasEligibleSkillCollectionReviewRuntime(cfg, agentId);
    const existing = retained.get(agentId);
    // Config cannot prove the execution chain while a stored session can select
    // a different model or runtime. Leave preference validation to the runner.
    const hasEligibleRuntime =
      configuredEligibility === false &&
      existing &&
      hasStoredExecutionPreference(cfg, agentId, existing.id)
        ? undefined
        : configuredEligibility;
    const enabled = workshopEnabled && hasEligibleRuntime !== false;
    return {
      agentId,
      input: {
        declarationKey: `${SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX}${agentId}`,
        name: `skill-collection-review-${agentId}`,
        displayName:
          workshopEnabled && hasEligibleRuntime === false
            ? `[${SKILL_COLLECTION_REVIEW_NO_ROOTED_RUNTIME_REASON}] Skill collection review (${agentId})`
            : `Skill collection review (${agentId})`,
        agentId,
        enabled,
        schedule: {
          kind: "every",
          everyMs: SKILL_COLLECTION_REVIEW_EVERY_MS,
          anchorMs: resolveHeartbeatPhaseMs({
            schedulerSeed,
            agentId,
            intervalMs: SKILL_COLLECTION_REVIEW_EVERY_MS,
          }),
        },
        payload: {
          kind: "agentTurn",
          message: SKILL_WORKSHOP_MAINTENANCE_PROMPT,
          toolsAllow: [...SKILL_WORKSHOP_MAINTENANCE_TOOLS],
        },
        sessionTarget: "isolated",
        delivery: { mode: "none" },
        wakeMode: "next-heartbeat",
      },
    };
  });
}
