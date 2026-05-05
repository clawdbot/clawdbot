import { resolveAgentRuntimePolicy } from "../agents/agent-runtime-policy.js";
import {
  listAgentEntries,
  resolveAgentModelFallbacksOverride,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import { resolveAgentHarnessPolicy } from "../agents/harness/selection.js";
import {
  modelKey,
  normalizeProviderId,
  parseModelRef,
  resolveDefaultModelForAgent,
} from "../agents/model-selection.js";
import { resolveAgentModelFallbackValues } from "../config/model-input.js";
import type { SessionEntry } from "../config/sessions.js";
import { updateSessionStore } from "../config/sessions/store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listPluginDoctorSessionRouteStateOwners } from "../plugins/doctor-contract-registry.js";
import type { DoctorSessionRouteStateOwner } from "../plugins/doctor-session-route-state-owner-types.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { parseAgentSessionKey } from "../sessions/session-key-utils.js";
import { note } from "../terminal/note.js";

type DoctorPrompterLike = {
  confirmRuntimeRepair: (params: {
    message: string;
    initialValue?: boolean;
    requiresInteractiveConfirmation?: boolean;
  }) => Promise<boolean>;
  note?: typeof note;
};

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeIdSet(values: readonly string[] | undefined): Set<string> {
  return new Set((values ?? []).map((value) => normalizeProviderId(value)));
}

function normalizePrefixList(values: readonly string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean);
}

function ownsPrefixedValue(prefixes: readonly string[], value: unknown): boolean {
  const normalized = normalizeString(value)?.toLowerCase();
  return normalized !== undefined && prefixes.some((prefix) => normalized.startsWith(prefix));
}

function countSessionLabel(count: number): string {
  return countLabel(count, "session");
}

function repairExample(repair: DoctorSessionRouteStateRepair): string {
  return `${repair.key} (${repair.reasons.join(", ")})`;
}

function resolveSessionAgentId(cfg: OpenClawConfig, sessionKey: string): string {
  return parseAgentSessionKey(sessionKey)?.agentId ?? resolveDefaultAgentId(cfg);
}

function resolveRawConfiguredRuntime(params: {
  cfg: OpenClawConfig;
  agentId: string;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  const envRuntime = params.env?.OPENCLAW_AGENT_RUNTIME?.trim();
  if (envRuntime) {
    return normalizeProviderId(envRuntime);
  }
  const agentRuntime = resolveAgentRuntimePolicy(
    listAgentEntries(params.cfg).find(
      (entry) => normalizeAgentId(entry.id) === normalizeAgentId(params.agentId),
    ),
  )?.id?.trim();
  if (agentRuntime) {
    return normalizeProviderId(agentRuntime);
  }
  const defaultsRuntime = resolveAgentRuntimePolicy(params.cfg.agents?.defaults)?.id?.trim();
  return defaultsRuntime ? normalizeProviderId(defaultsRuntime) : undefined;
}

export function resolveConfiguredDoctorSessionStateRoute(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  env?: NodeJS.ProcessEnv;
}): DoctorSessionRouteState {
  const agentId = resolveSessionAgentId(params.cfg, params.sessionKey);
  const primary = resolveDefaultModelForAgent({ cfg: params.cfg, agentId });
  const configuredModelRefs = new Set<string>();
  const addRef = (provider: string, model: string) => {
    configuredModelRefs.add(modelKey(provider, model));
  };
  addRef(primary.provider, primary.model);
  const fallbacks =
    resolveAgentModelFallbacksOverride(params.cfg, agentId) ??
    resolveAgentModelFallbackValues(params.cfg.agents?.defaults?.model);
  for (const fallback of fallbacks) {
    const parsed = parseModelRef(fallback, primary.provider, {
      allowPluginNormalization: false,
    });
    if (parsed) {
      addRef(parsed.provider, parsed.model);
    }
  }
  const runtime = resolveAgentHarnessPolicy({
    config: params.cfg,
    agentId,
    sessionKey: params.sessionKey,
    env: params.env,
  }).runtime;
  return {
    defaultProvider: primary.provider,
    configuredModelRefs: [...configuredModelRefs],
    runtime: resolveRawConfiguredRuntime({ cfg: params.cfg, agentId, env: params.env }) ?? runtime,
  };
}

function resolvePluginDoctorSessionRouteStateOwners(params: {
  env?: NodeJS.ProcessEnv;
}): DoctorSessionRouteStateOwner[] {
  return listPluginDoctorSessionRouteStateOwners({ env: params.env });
}

export type DoctorSessionRouteState = {
  defaultProvider: string;
  configuredModelRefs: string[];
  runtime?: string;
};

export type DoctorSessionRouteStateRepair = {
  key: string;
  ownerId: string;
  ownerLabel: string;
  reasons: string[];
  cliSessionKeys: string[];
};

export type DoctorSessionRouteStateManualReview = {
  key: string;
  ownerLabel: string;
  message: string;
};

export type DoctorSessionRouteStateScan = {
  repairs: DoctorSessionRouteStateRepair[];
  manualReview: DoctorSessionRouteStateManualReview[];
};

function resolvePersistedOverrideModelRef(params: {
  defaultProvider: string;
  overrideProvider?: unknown;
  overrideModel?: unknown;
}): { provider: string; model: string } | null {
  const overrideModel = normalizeString(params.overrideModel);
  if (!overrideModel) {
    return null;
  }
  const overrideProvider = normalizeString(params.overrideProvider);
  return parseModelRef(
    overrideProvider ? `${overrideProvider}/${overrideModel}` : overrideModel,
    params.defaultProvider,
    { allowPluginNormalization: false },
  );
}

function addReason(reasons: string[], reason: string) {
  if (!reasons.includes(reason)) {
    reasons.push(reason);
  }
}

function routeAllowsOwnerState(params: {
  owner: DoctorSessionRouteStateOwner;
  route: DoctorSessionRouteState | undefined;
}): boolean {
  const providerIds = normalizeIdSet(params.owner.providerIds);
  const runtimeIds = normalizeIdSet(params.owner.runtimeIds);
  const routeRuntime = normalizeString(params.route?.runtime);
  if (routeRuntime && runtimeIds.has(normalizeProviderId(routeRuntime))) {
    return true;
  }
  return (
    params.route?.configuredModelRefs.some((ref) => {
      const slash = ref.indexOf("/");
      return slash > 0 && providerIds.has(normalizeProviderId(ref.slice(0, slash)));
    }) ?? false
  );
}

function hasOwnedCliSession(params: {
  entry: Record<string, unknown>;
  cliSessionKeys: readonly string[];
}): boolean {
  const bindings = params.entry.cliSessionBindings;
  const ids = params.entry.cliSessionIds;
  return params.cliSessionKeys.some((key) => {
    const normalized = normalizeProviderId(key);
    return (
      (bindings !== null &&
        typeof bindings === "object" &&
        normalized in bindings &&
        (bindings as Record<string, unknown>)[normalized] !== undefined) ||
      (ids !== null &&
        typeof ids === "object" &&
        normalized in ids &&
        (ids as Record<string, unknown>)[normalized] !== undefined)
    );
  });
}

function modelRefKey(provider: string, model: string): string {
  return modelKey(provider, model).toLowerCase();
}

function scanEntryForOwner(params: {
  key: string;
  entry: Record<string, unknown>;
  owner: DoctorSessionRouteStateOwner;
  route: DoctorSessionRouteState | undefined;
}): {
  repair?: DoctorSessionRouteStateRepair;
  manualReview?: DoctorSessionRouteStateManualReview;
} {
  const providerIds = normalizeIdSet(params.owner.providerIds);
  const runtimeIds = normalizeIdSet(params.owner.runtimeIds);
  const cliSessionKeys = [...normalizeIdSet(params.owner.cliSessionKeys)];
  const authProfilePrefixes = normalizePrefixList(params.owner.authProfilePrefixes);
  const routeAllowsOwner = routeAllowsOwnerState({ owner: params.owner, route: params.route });
  const reasons: string[] = [];
  const directOverride = resolvePersistedOverrideModelRef({
    defaultProvider: params.route?.defaultProvider ?? "",
    overrideProvider: params.entry.providerOverride,
    overrideModel: params.entry.modelOverride,
  });
  const directOverrideKey = directOverride
    ? modelRefKey(directOverride.provider, directOverride.model)
    : undefined;
  const directOverrideIsOwned =
    directOverride !== null && providerIds.has(normalizeProviderId(directOverride.provider));
  const directOverrideIsConfigured =
    directOverrideKey !== undefined &&
    (params.route?.configuredModelRefs.some((ref) => ref.toLowerCase() === directOverrideKey) ??
      false);
  const directOverrideSource =
    params.entry.modelOverrideSource === "user"
      ? "user"
      : params.entry.modelOverrideSource === "auto"
        ? "auto"
        : params.entry.modelOverride
          ? "legacy"
          : undefined;

  if (directOverrideIsOwned && !directOverrideIsConfigured) {
    if (directOverrideSource === "auto") {
      addReason(reasons, "auto model override");
    } else if (!routeAllowsOwner && directOverride) {
      return {
        manualReview: {
          key: params.key,
          ownerLabel: params.owner.label,
          message: `${params.key} (${modelRefKey(directOverride.provider, directOverride.model)}, ${
            directOverrideSource === "user" ? "user" : "legacy"
          })`,
        },
      };
    }
  }

  const explicitOwnedOverride =
    directOverrideIsOwned && directOverrideSource !== undefined && directOverrideSource !== "auto";
  if (!routeAllowsOwner && !explicitOwnedOverride) {
    const runtimeModel = normalizeString(params.entry.model);
    const runtimeRef = runtimeModel
      ? parseModelRef(runtimeModel, normalizeString(params.entry.modelProvider) ?? "", {
          allowPluginNormalization: false,
        })
      : null;
    if (runtimeRef && providerIds.has(normalizeProviderId(runtimeRef.provider))) {
      addReason(reasons, "runtime model state");
    }
    const harnessId = normalizeString(params.entry.agentHarnessId);
    if (harnessId && runtimeIds.has(normalizeProviderId(harnessId))) {
      addReason(reasons, "pinned runtime");
    }
    if (hasOwnedCliSession({ entry: params.entry, cliSessionKeys })) {
      addReason(reasons, "CLI session binding");
    }
    if (
      params.entry.authProfileOverrideSource === "auto" &&
      ownsPrefixedValue(authProfilePrefixes, params.entry.authProfileOverride)
    ) {
      addReason(reasons, "auto auth profile override");
    }
  }

  if (reasons.length === 0) {
    return {};
  }
  return {
    repair: {
      key: params.key,
      ownerId: params.owner.id,
      ownerLabel: params.owner.label,
      reasons,
      cliSessionKeys,
    },
  };
}

export function scanSessionRouteStateOwners(params: {
  owners: readonly DoctorSessionRouteStateOwner[];
  store: Record<string, Record<string, unknown>>;
  routes: Record<string, DoctorSessionRouteState>;
}): DoctorSessionRouteStateScan {
  const repairs: DoctorSessionRouteStateRepair[] = [];
  const manualReview: DoctorSessionRouteStateManualReview[] = [];
  for (const [key, entry] of Object.entries(params.store)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    for (const owner of params.owners) {
      const scan = scanEntryForOwner({ key, entry, owner, route: params.routes[key] });
      if (scan.repair) {
        repairs.push(scan.repair);
      }
      if (scan.manualReview) {
        manualReview.push(scan.manualReview);
      }
    }
  }
  return { repairs, manualReview };
}

function clearEntryKey(entry: Record<string, unknown>, key: string): boolean {
  if (entry[key] !== undefined) {
    delete entry[key];
    return true;
  }
  return false;
}

function clearRecordKeys(
  entry: Record<string, unknown>,
  recordKey: string,
  ownedKeys: readonly string[],
): boolean {
  const value = entry[recordKey];
  if (value === null || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  let changed = false;
  const next = { ...record };
  for (const key of ownedKeys) {
    const normalized = normalizeProviderId(key);
    if (next[normalized] !== undefined) {
      delete next[normalized];
      changed = true;
    }
  }
  if (!changed) {
    return false;
  }
  entry[recordKey] = Object.keys(next).length > 0 ? next : undefined;
  return true;
}

export function applySessionRouteStateRepair(params: {
  entry: Record<string, unknown>;
  repair: DoctorSessionRouteStateRepair;
  now: number;
}): boolean {
  let changed = false;
  const clear = (key: string) => {
    changed = clearEntryKey(params.entry, key) || changed;
  };
  if (params.repair.reasons.includes("auto model override")) {
    clear("providerOverride");
    clear("modelOverride");
    clear("modelOverrideSource");
    clear("liveModelSwitchPending");
  }
  if (params.repair.reasons.includes("runtime model state")) {
    clear("model");
    clear("modelProvider");
    clear("contextTokens");
    clear("systemPromptReport");
    clear("fallbackNoticeSelectedModel");
    clear("fallbackNoticeActiveModel");
    clear("fallbackNoticeReason");
  }
  if (params.repair.reasons.includes("pinned runtime")) {
    clear("agentHarnessId");
  }
  if (params.repair.reasons.includes("CLI session binding")) {
    changed =
      clearRecordKeys(params.entry, "cliSessionBindings", params.repair.cliSessionKeys) || changed;
    changed =
      clearRecordKeys(params.entry, "cliSessionIds", params.repair.cliSessionKeys) || changed;
  }
  if (params.repair.reasons.includes("auto auth profile override")) {
    clear("authProfileOverride");
    clear("authProfileOverrideSource");
    clear("authProfileOverrideCompactionCount");
  }
  if (changed) {
    params.entry.updatedAt = params.now;
  }
  return changed;
}

function groupRepairsByOwner(
  repairs: readonly DoctorSessionRouteStateRepair[],
): Map<string, DoctorSessionRouteStateRepair[]> {
  const grouped = new Map<string, DoctorSessionRouteStateRepair[]>();
  for (const repair of repairs) {
    const key = repair.ownerLabel;
    grouped.set(key, [...(grouped.get(key) ?? []), repair]);
  }
  return grouped;
}

export async function runPluginSessionStateDoctorRepairs(params: {
  cfg: OpenClawConfig;
  store: Record<string, SessionEntry>;
  absoluteStorePath: string;
  prompter: DoctorPrompterLike;
  env?: NodeJS.ProcessEnv;
  warnings: string[];
  changes: string[];
}): Promise<void> {
  const owners = resolvePluginDoctorSessionRouteStateOwners({ env: params.env });
  if (owners.length === 0) {
    return;
  }
  const routes = Object.fromEntries(
    Object.keys(params.store).map((sessionKey) => [
      sessionKey,
      resolveConfiguredDoctorSessionStateRoute({ cfg: params.cfg, sessionKey, env: params.env }),
    ]),
  );
  const store = params.store as unknown as Record<string, Record<string, unknown>>;
  const scan = scanSessionRouteStateOwners({ owners, store, routes });
  if (scan.repairs.length > 0) {
    for (const [ownerLabel, repairs] of groupRepairsByOwner(scan.repairs)) {
      const staleCount = countSessionLabel(repairs.length);
      params.warnings.push(
        [
          `- Found stale ${ownerLabel} session routing state in ${staleCount} outside the current configured model/runtime route.`,
          "  This can keep later message-channel runs pinned to an old runtime/provider after defaults move elsewhere.",
          `  Examples: ${repairs.slice(0, 3).map(repairExample).join(", ")}`,
        ].join("\n"),
      );
      const repairState = await params.prompter.confirmRuntimeRepair({
        message: `Clear stale ${ownerLabel} session routing state for ${staleCount}?`,
        initialValue: true,
      });
      if (repairState) {
        let repaired = 0;
        const repairedAt = Date.now();
        const repairsByKey = new Map(repairs.map((repair) => [repair.key, repair]));
        await updateSessionStore(params.absoluteStorePath, (currentStore) => {
          const currentMutableStore = currentStore as unknown as Record<
            string,
            Record<string, unknown>
          >;
          for (const [key, repair] of repairsByKey) {
            const current = currentMutableStore[key];
            if (
              current &&
              applySessionRouteStateRepair({ entry: current, repair, now: repairedAt })
            ) {
              repaired += 1;
            }
          }
        });
        if (repaired > 0) {
          params.changes.push(
            `- Cleared stale ${ownerLabel} session routing state for ${countSessionLabel(
              repaired,
            )}.`,
          );
        }
      }
    }
  }
  if (scan.manualReview.length > 0) {
    const grouped = new Map<string, DoctorSessionRouteStateManualReview[]>();
    for (const hit of scan.manualReview) {
      grouped.set(hit.ownerLabel, [...(grouped.get(hit.ownerLabel) ?? []), hit]);
    }
    for (const [ownerLabel, hits] of grouped) {
      params.warnings.push(
        [
          `- Found explicit ${ownerLabel} model overrides in ${countSessionLabel(
            hits.length,
          )} outside the current configured route.`,
          "  Doctor leaves explicit or legacy user selections untouched; switch them with /model or reset the session if that provider is no longer intended.",
          `  Examples: ${hits
            .slice(0, 3)
            .map((hit) => hit.message)
            .join(", ")}`,
        ].join("\n"),
      );
    }
  }
}
