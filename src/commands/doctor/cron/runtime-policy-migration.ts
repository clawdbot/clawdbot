// Doctor-only runtime policy repair for migrated cron Codex model refs.
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { tryResolveDefaultAgentId } from "../../../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { normalizeAgentId } from "../../../routing/session-key.js";
import {
  isBlockedLegacyCodexModelRef,
  normalizeRuntimeString,
  type LegacyCodexModelIdentity,
} from "../shared/codex-route-model-ref.js";
import type { CronCodexRuntimePolicyTarget } from "./store-migration.js";

type MutableRecord = Record<string, unknown>;

function ensureRecord(container: MutableRecord, key: string): MutableRecord {
  const existing = asOptionalRecord(container[key]);
  if (existing) {
    return existing;
  }
  const created: MutableRecord = {};
  container[key] = created;
  return created;
}

function resolvePolicyOwner(params: {
  cfg: OpenClawConfig;
  target: CronCodexRuntimePolicyTarget;
}): { owner: MutableRecord; path: string } | undefined {
  const root = params.cfg as unknown as MutableRecord;
  const agents = ensureRecord(root, "agents");
  const requestedAgentId = params.target.agentId
    ? normalizeAgentId(params.target.agentId)
    : undefined;
  const defaultAgentId = tryResolveDefaultAgentId(params.cfg);
  const effectiveAgentId = requestedAgentId ?? defaultAgentId;
  if (!effectiveAgentId) {
    return undefined;
  }
  const list = Array.isArray(agents.list) ? agents.list : [];
  const owner = list.find((entry) => {
    const record = asOptionalRecord(entry);
    return normalizeAgentId(typeof record?.id === "string" ? record.id : "") === effectiveAgentId;
  });
  const record = asOptionalRecord(owner);
  if (record) {
    return { owner: record, path: `agents.list.${effectiveAgentId}` };
  }
  return !requestedAgentId || requestedAgentId === defaultAgentId
    ? { owner: ensureRecord(agents, "defaults"), path: "agents.defaults" }
    : undefined;
}

/** Install model-scoped Codex runtime intent for canonical refs migrated out of cron payloads. */
export function repairCronCodexRuntimePolicies(params: {
  cfg: OpenClawConfig;
  targets: ReadonlyArray<CronCodexRuntimePolicyTarget>;
  blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>;
}): {
  config: OpenClawConfig;
  changes: string[];
  warnings: string[];
  blockedTargets: CronCodexRuntimePolicyTarget[];
  changedTargets: CronCodexRuntimePolicyTarget[];
} {
  if (params.targets.length === 0) {
    return {
      config: params.cfg,
      changes: [],
      warnings: [],
      blockedTargets: [],
      changedTargets: [],
    };
  }
  const next = structuredClone(params.cfg);
  const changes: string[] = [];
  const warnings: string[] = [];
  const blockedTargets: CronCodexRuntimePolicyTarget[] = [];
  const changedTargets: CronCodexRuntimePolicyTarget[] = [];
  // Distinct stored identities (agentId omitted vs the default agent named)
  // can resolve to one policy owner; every equivalent target must inherit the
  // first decision or the deferred rewrite filter misses blocked siblings.
  const decisions = new Map<string, "blocked" | "changed" | "noop">();

  for (const target of params.targets) {
    if (
      isBlockedLegacyCodexModelRef({
        modelRef: target.legacyModelRef ?? target.modelRef,
        blockedModelIdentities: params.blockedModelIdentities,
      })
    ) {
      blockedTargets.push(target);
      continue;
    }
    const owner = resolvePolicyOwner({ cfg: next, target });
    const targetLabel = target.agentId ? `agent ${target.agentId}` : "the default agent";
    if (!owner) {
      blockedTargets.push(target);
      warnings.push(
        `Cron model ${target.modelRef} was migrated to openai/*, but ${targetLabel} has no configured agent entry; set its model-scoped agentRuntime.id to "codex" manually.`,
      );
      continue;
    }
    const key = `${owner.path}\u0000${target.modelRef}`;
    const priorDecision = decisions.get(key);
    if (priorDecision) {
      if (priorDecision === "blocked") {
        blockedTargets.push(target);
      } else if (priorDecision === "changed") {
        changedTargets.push(target);
      }
      continue;
    }
    const models = ensureRecord(owner.owner, "models");
    const modelEntry = ensureRecord(models, target.modelRef);
    const priorRuntime = asOptionalRecord(modelEntry.agentRuntime);
    const priorRuntimeId = normalizeRuntimeString(priorRuntime?.id);
    // "auto" carries no conflicting intent: on the legacy codex provider it
    // selected the codex harness, so replace it like an unset runtime.
    if (priorRuntimeId && priorRuntimeId !== "codex" && priorRuntimeId !== "auto") {
      decisions.set(key, "blocked");
      blockedTargets.push(target);
      warnings.push(
        `Retained ${owner.path}.models.${target.modelRef}.agentRuntime.id="${priorRuntimeId}": it conflicts with migrated cron Codex runtime intent; repair the cron model or runtime policy manually.`,
      );
      continue;
    }
    if (priorRuntimeId === "codex") {
      decisions.set(key, "noop");
      continue;
    }
    decisions.set(key, "changed");
    modelEntry.agentRuntime = { ...priorRuntime, id: "codex" };
    changedTargets.push(target);
    changes.push(
      `Set ${owner.path}.models.${target.modelRef}.agentRuntime.id to "codex" for migrated cron runtime intent.`,
    );
  }

  return {
    config: changes.length > 0 ? next : params.cfg,
    changes,
    warnings,
    blockedTargets,
    changedTargets,
  };
}

/** Restrict a post-config-write cron rewrite to runtime policies already on disk. */
export function planCronCodexRefRewriteAgainstPersistedConfig(params: {
  cfg: OpenClawConfig;
  targets: ReadonlyArray<CronCodexRuntimePolicyTarget>;
  blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>;
}): { warnings: string[]; blockedTargets: CronCodexRuntimePolicyTarget[] } {
  const policyPlan = repairCronCodexRuntimePolicies(params);
  // Keep every raw stored identity: the downstream filter matches on the raw
  // (agentId, modelRef) key, so collapsing identities that merely normalize to
  // the same agent would let the sibling job bypass the block.
  return {
    warnings: [
      ...policyPlan.warnings,
      ...policyPlan.changedTargets.map(
        (target) =>
          `Retained the legacy cron route for ${target.modelRef} because its model-scoped agentRuntime.id="codex" policy is not present in persisted config; rerun doctor --fix.`,
      ),
    ],
    blockedTargets: [...policyPlan.blockedTargets, ...policyPlan.changedTargets],
  };
}
