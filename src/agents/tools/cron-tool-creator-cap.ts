import { isRecord } from "../../utils.js";
import { readCronScheduledToolProjection } from "../exec-tool-target-pinning.js";
import { createToolPolicyMatcher } from "../tool-policy-match.js";
import {
  buildPluginToolGroups,
  expandPolicyWithPluginGroups,
  expandToolGroups,
  normalizeToolPolicyName,
} from "../tool-policy.js";
import type { CronCreatorToolAllowlistEntry, CronToolsAllowCaptureRef } from "./cron-tool.types.js";

type NormalizedCronCreatorTool = {
  name: string;
  pluginId?: string;
  aliasName?: string;
  execTarget?: { host: "gateway"; ask?: "always" };
};

type CronCreatorCapCaptureOptions = {
  /** Backend-projected native capabilities; must be exact vocabulary names. */
  canonicalToolNames?: readonly string[];
  /**
   * Restrict-only pin for a native `exec` entry. Set only by a caller that knows
   * the native shell ran on the Gateway host (the loopback grant path excludes
   * node placement); a harness that may run its shell remotely leaves it unset.
   */
  nativeExecTarget?: { host: "gateway" };
};

type CronJobUpdatePatchPlan =
  | { kind: "ready"; patch: Record<string, unknown> }
  | { kind: "needs-current-job" }
  | { kind: "needs-creator-authority" };

/**
 * Closed core-owned vocabulary a CLI backend may project its native tools into.
 * Anything else is a backend contract bug and fails closed at capture time so a
 * raw harness tool name can never become a persisted cron capability.
 */
const NATIVE_CRON_CREATOR_CAPABILITIES: ReadonlySet<string> = new Set([
  "read",
  "write",
  "edit",
  "apply_patch",
  "exec",
  "process",
  "web_search",
  "web_fetch",
]);

/** Fails closed on any backend-projected name outside the exact canonical vocabulary. */
export function assertNativeCronCreatorCapabilities(names: readonly string[]): void {
  for (const name of names) {
    // Exact match, no trimming, case folding, or alias folding: a raw harness
    // name such as "Bash" must be projected by its backend, never accepted here.
    if (!NATIVE_CRON_CREATOR_CAPABILITIES.has(name)) {
      throw new Error(
        `cron creator authority rejected non-canonical native capability ${JSON.stringify(name)}`,
      );
    }
  }
}

export const CRON_CREATOR_AUTHORITY_RECOVERY_MESSAGE =
  "Retry from a fresh authenticated direct-local operator turn, or create/edit via the CLI or Gateway with an explicit finite toolsAllow list containing only currently visible tools; no automation changes were saved.";
export const INCOMPLETE_CRON_CREATOR_AUTHORITY_MESSAGE = `Configured MCP authority is unavailable because this turn did not capture the complete model-callable tool surface. ${CRON_CREATOR_AUTHORITY_RECOVERY_MESSAGE}`;

/** No capture marker means this runtime has no deferred configured-MCP surface. */
export function isCronCreatorToolCaptureComplete(
  captureRef: CronToolsAllowCaptureRef | undefined,
): boolean {
  return captureRef === undefined || captureRef.value?.source === "final-executable-surface";
}

export function assertInheritedCronToolCaptureReady(
  value: unknown,
  captureRef: CronToolsAllowCaptureRef | undefined,
): void {
  const payload = isRecord(value) && isRecord(value.payload) ? value.payload : undefined;
  if (payload?.toolsAllowIsDefault !== true || isCronCreatorToolCaptureComplete(captureRef)) {
    return;
  }
  throw new Error(INCOMPLETE_CRON_CREATOR_AUTHORITY_MESSAGE);
}

export function replaceWithEffectiveCronCreatorToolAllowlist<T extends { name: string }>(
  target: CronCreatorToolAllowlistEntry[],
  tools: readonly T[],
  toolMeta?: (tool: T) => { pluginId?: string } | undefined,
  options: CronCreatorCapCaptureOptions = {},
): void {
  target.length = 0;
  // Host-created alias projections (for example a Codex gateway shell alias) are
  // recorded under their canonical core tool name so scheduled runtimes rebuild
  // the same capability. The alias name is kept for explicit-cap matching only.
  const captured = new Map<string, NormalizedCronCreatorTool>();
  for (const tool of tools) {
    const projection = readCronScheduledToolProjection(tool);
    const name = normalizeToolPolicyName(projection ? projection.targetTool : tool.name);
    if (!name) {
      continue;
    }
    const aliasName = projection ? normalizeToolPolicyName(tool.name) : undefined;
    const existing = captured.get(name);
    if (existing !== undefined) {
      // Merge duplicate grants of one canonical tool: alias names stay matchable,
      // and the restrict-only target survives only when every grantor pins it.
      if (aliasName && !existing.aliasName) {
        existing.aliasName = aliasName;
      }
      if (existing.execTarget && !projection?.execTarget) {
        delete existing.execTarget;
      } else if (
        existing.execTarget?.ask === "always" &&
        projection?.execTarget?.ask !== "always"
      ) {
        delete existing.execTarget.ask;
      }
      continue;
    }
    const meta = toolMeta?.(tool);
    const pluginId =
      typeof meta?.pluginId === "string" ? normalizeToolPolicyName(meta.pluginId) : undefined;
    captured.set(name, {
      name,
      ...(pluginId ? { pluginId } : {}),
      ...(aliasName && aliasName !== name ? { aliasName } : {}),
      ...(projection?.execTarget ? { execTarget: { ...projection.execTarget } } : {}),
    });
  }
  // Native harness tools do not have OpenClaw tool objects, so their trusted
  // runtime owner contributes canonical capability names at this same final seam.
  // The native shell is a different surface from a Gateway exec alias, so an
  // existing alias entry (and any target pin it carries) stays authoritative.
  assertNativeCronCreatorCapabilities(options.canonicalToolNames ?? []);
  for (const name of options.canonicalToolNames ?? []) {
    if (captured.has(name)) {
      continue;
    }
    captured.set(
      name,
      name === "exec" && options.nativeExecTarget
        ? { name, execTarget: { ...options.nativeExecTarget } }
        : { name },
    );
  }
  target.push(...captured.values());
}

/** Records the creator cap only after every runtime policy and schema quarantine has run. */
export function captureFinalEffectiveCronCreatorToolAllowlist<T extends { name: string }>(
  target: CronCreatorToolAllowlistEntry[],
  captureRef: CronToolsAllowCaptureRef,
  tools: readonly T[],
  toolMeta?: (tool: T) => { pluginId?: string } | undefined,
  options: CronCreatorCapCaptureOptions = {},
): void {
  replaceWithEffectiveCronCreatorToolAllowlist(target, tools, toolMeta, options);
  captureRef.value = { version: 1, source: "final-executable-surface" };
}

function normalizeCronCreatorToolsAllow(
  values: readonly CronCreatorToolAllowlistEntry[],
): NormalizedCronCreatorTool[] {
  const normalized: NormalizedCronCreatorTool[] = [];
  const seen = new Set<string>();
  for (const entry of values) {
    const tool = typeof entry === "string" ? { name: entry } : entry;
    const name = normalizeToolPolicyName(tool.name);
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    const pluginId =
      typeof tool.pluginId === "string" ? normalizeToolPolicyName(tool.pluginId) : undefined;
    const aliasName =
      typeof tool.aliasName === "string" ? normalizeToolPolicyName(tool.aliasName) : undefined;
    const execTarget: NormalizedCronCreatorTool["execTarget"] =
      tool.execTarget?.host === "gateway"
        ? {
            host: "gateway",
            ...(tool.execTarget.ask === "always" ? { ask: "always" } : {}),
          }
        : undefined;
    normalized.push({
      name,
      ...(pluginId ? { pluginId } : {}),
      ...(aliasName && aliasName !== name ? { aliasName } : {}),
      ...(execTarget ? { execTarget } : {}),
    });
  }
  return normalized;
}

/** Restrict-only exec target present only when the creator's exec grant is host-pinned. */
export function resolveCronCreatorExecToolTarget(
  entries: readonly CronCreatorToolAllowlistEntry[] | undefined,
): { host: "gateway"; ask?: "always" } | undefined {
  const execEntry = normalizeCronCreatorToolsAllow(entries ?? []).find(
    (tool) => tool.name === "exec",
  );
  return execEntry?.execTarget ? { ...execEntry.execTarget } : undefined;
}

function hasCronTriggerScript(value: unknown): boolean {
  return isRecord(value) && typeof value.script === "string" && value.script.trim().length > 0;
}

function classifyExplicitToolsAllow(
  payload: Record<string, unknown> | undefined,
): "absent" | "empty" | "finite" | "resolved" {
  if (!payload || !Object.hasOwn(payload, "toolsAllow")) {
    return "absent";
  }
  if (!Array.isArray(payload.toolsAllow)) {
    return "resolved";
  }
  const values = payload.toolsAllow.filter((entry): entry is string => typeof entry === "string");
  if (values.length === 0) {
    return "empty";
  }
  return values.some((entry) => {
    const normalized = normalizeToolPolicyName(entry);
    return normalized === "*" || normalized.startsWith("group:");
  })
    ? "resolved"
    : "finite";
}

function explicitFiniteToolsNeedResolution(
  payload: Record<string, unknown> | undefined,
  creatorToolAllowlist: readonly CronCreatorToolAllowlistEntry[] | undefined,
): boolean {
  if (classifyExplicitToolsAllow(payload) !== "finite") {
    return false;
  }
  const toolsAllow = payload?.toolsAllow;
  if (!Array.isArray(toolsAllow)) {
    return false;
  }
  const creatorNames = new Set(
    normalizeCronCreatorToolsAllow(creatorToolAllowlist ?? []).flatMap((tool) =>
      tool.aliasName ? [tool.name, tool.aliasName] : [tool.name],
    ),
  );
  return expandToolGroups(
    toolsAllow.filter((entry): entry is string => typeof entry === "string"),
  ).some((name) => !creatorNames.has(name));
}

/** Whether an add needs the creator's complete authority rather than an explicit empty cap. */
export function cronCreateRequiresCreatorAuthority(
  value: unknown,
  creatorToolAllowlist?: readonly CronCreatorToolAllowlistEntry[],
): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const payload = isRecord(value.payload) ? value.payload : undefined;
  const explicitToolsAllow = classifyExplicitToolsAllow(payload);
  if (explicitToolsAllow === "empty") {
    return false;
  }
  if (explicitToolsAllow === "finite") {
    return explicitFiniteToolsNeedResolution(payload, creatorToolAllowlist);
  }
  return (
    hasCronTriggerScript(value.trigger) ||
    payload?.kind === "agentTurn" ||
    payload?.kind === "script" ||
    explicitToolsAllow === "resolved"
  );
}

function capCronJobToolsAllow(params: {
  payload: Record<string, unknown>;
  trigger?: unknown;
  creatorToolAllowlist: readonly CronCreatorToolAllowlistEntry[];
  defaultToolsAllow?: unknown;
}): void {
  const writesToolsAllow = Object.hasOwn(params.payload, "toolsAllow");
  if (
    params.payload.kind !== "agentTurn" &&
    params.payload.kind !== "script" &&
    !hasCronTriggerScript(params.trigger) &&
    !writesToolsAllow
  ) {
    return;
  }

  const creatorToolsAllow = normalizeCronCreatorToolsAllow(params.creatorToolAllowlist);
  const creatorToolNames = creatorToolsAllow.map((tool) => tool.name);
  const requestedRaw = Object.hasOwn(params.payload, "toolsAllow")
    ? params.payload.toolsAllow
    : params.defaultToolsAllow;
  if (!Array.isArray(requestedRaw)) {
    params.payload.toolsAllow = creatorToolNames;
    params.payload.toolsAllowIsDefault = true;
    return;
  }

  const requestedToolsAllow = expandToolGroups(
    requestedRaw.filter((entry): entry is string => typeof entry === "string"),
  );
  if (requestedToolsAllow.includes("*")) {
    params.payload.toolsAllow = creatorToolNames;
    params.payload.toolsAllowIsDefault = true;
    return;
  }
  if (requestedToolsAllow.length === 0 || creatorToolsAllow.length === 0) {
    params.payload.toolsAllow = [];
    delete params.payload.toolsAllowIsDefault;
    return;
  }

  const pluginGroups = buildPluginToolGroups({
    tools: creatorToolsAllow,
    toolMeta: (tool) => (tool.pluginId ? { pluginId: tool.pluginId } : undefined),
  });
  const requestedPolicy = expandPolicyWithPluginGroups(
    { allow: requestedToolsAllow },
    pluginGroups,
  );
  const matches = createToolPolicyMatcher(requestedPolicy);
  // A creator tool matches under its canonical name or the runtime alias the
  // creating surface presented; the persisted cap always holds canonical names.
  params.payload.toolsAllow = creatorToolsAllow
    .filter(
      (tool) => matches(tool.name) || (tool.aliasName !== undefined && matches(tool.aliasName)),
    )
    .map((tool) => tool.name);
  delete params.payload.toolsAllowIsDefault;
}

export function capCronJobToolsAllowOnCreate(
  value: unknown,
  creatorToolAllowlist: readonly CronCreatorToolAllowlistEntry[] | undefined,
): void {
  if (!isRecord(value) || !isRecord(value.payload)) {
    return;
  }
  if (!creatorToolAllowlist) {
    return;
  }
  capCronJobToolsAllow({
    payload: value.payload,
    trigger: value.trigger,
    creatorToolAllowlist,
  });
}

function readCronPayloadKind(value: unknown): string | undefined {
  return isRecord(value) && typeof value.kind === "string" ? value.kind : undefined;
}

/** Purely derives the agent-tool patch; current job state is requested only when required. */
export function planCronJobUpdatePatch(params: {
  patch: Record<string, unknown>;
  creatorToolAllowlist: readonly CronCreatorToolAllowlistEntry[] | undefined;
  currentJob?: Record<string, unknown>;
  creatorAuthorityComplete?: boolean;
}): CronJobUpdatePatchPlan {
  const patch = structuredClone(params.patch);
  const payload = isRecord(patch.payload) ? patch.payload : undefined;
  const explicitPayloadKind = readCronPayloadKind(payload);
  const explicitToolsAllow = classifyExplicitToolsAllow(payload);
  if (payload === undefined && !Object.hasOwn(patch, "trigger")) {
    // Schedule, delivery, naming, and enabled-state edits do not reauthorize
    // legacy jobs. Only tool-runtime changes may synthesize durable authority.
    return { kind: "ready", patch };
  }
  if (
    explicitPayloadKind !== undefined &&
    explicitToolsAllow === "absent" &&
    params.creatorAuthorityComplete !== false &&
    !params.creatorToolAllowlist &&
    !Object.hasOwn(patch, "trigger")
  ) {
    return { kind: "ready", patch };
  }
  if (
    params.creatorAuthorityComplete === false &&
    explicitFiniteToolsNeedResolution(payload, params.creatorToolAllowlist)
  ) {
    return { kind: "needs-creator-authority" };
  }
  if (
    params.creatorToolAllowlist &&
    (explicitToolsAllow === "empty" || explicitToolsAllow === "finite") &&
    explicitPayloadKind !== undefined
  ) {
    capCronJobToolsAllow({
      payload: payload!,
      trigger: patch.trigger,
      creatorToolAllowlist: params.creatorToolAllowlist,
    });
    return { kind: "ready", patch };
  }
  if (!params.currentJob) {
    return { kind: "needs-current-job" };
  }

  const existingPayload = params.currentJob.payload;
  const existingPayloadRecord = isRecord(existingPayload) ? existingPayload : undefined;
  const existingPayloadKind = readCronPayloadKind(existingPayload);
  const payloadKind = explicitPayloadKind ?? readCronPayloadKind(existingPayload);
  if (payload && payloadKind !== undefined) {
    payload.kind = payloadKind;
    patch.payload = payload;
  }

  const trigger = Object.hasOwn(patch, "trigger") ? patch.trigger : params.currentJob.trigger;
  const startsToolPayload =
    explicitPayloadKind !== undefined &&
    explicitPayloadKind !== existingPayloadKind &&
    (payloadKind === "agentTurn" || payloadKind === "script");
  const startsToolTrigger =
    Object.hasOwn(patch, "trigger") &&
    hasCronTriggerScript(trigger) &&
    !hasCronTriggerScript(params.currentJob.trigger);
  const reusesDefaultAuthority =
    explicitToolsAllow === "absent" &&
    (startsToolPayload || startsToolTrigger) &&
    (existingPayloadRecord?.toolsAllowIsDefault === true ||
      !Array.isArray(existingPayloadRecord?.toolsAllow));
  const needsResolvedAuthority =
    explicitToolsAllow === "resolved" ||
    reusesDefaultAuthority ||
    explicitFiniteToolsNeedResolution(payload, params.creatorToolAllowlist);
  if (needsResolvedAuthority && params.creatorAuthorityComplete === false) {
    return { kind: "needs-creator-authority" };
  }
  if (
    !needsResolvedAuthority &&
    (explicitToolsAllow === "empty" || explicitToolsAllow === "finite") &&
    params.creatorToolAllowlist
  ) {
    capCronJobToolsAllow({
      payload: payload!,
      trigger,
      creatorToolAllowlist: params.creatorToolAllowlist,
    });
    return { kind: "ready", patch };
  }
  if (!needsResolvedAuthority || !params.creatorToolAllowlist) {
    return { kind: "ready", patch };
  }

  const nextPayload: Record<string, unknown> = payload ?? {};
  if (payloadKind !== undefined) {
    nextPayload.kind = payloadKind;
  }
  patch.payload = nextPayload;
  capCronJobToolsAllow({
    payload: nextPayload,
    trigger,
    creatorToolAllowlist: params.creatorToolAllowlist,
    defaultToolsAllow:
      existingPayloadRecord && existingPayloadRecord.toolsAllowIsDefault !== true
        ? existingPayloadRecord.toolsAllow
        : undefined,
  });
  return { kind: "ready", patch };
}
