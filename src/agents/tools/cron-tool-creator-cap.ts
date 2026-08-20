import { isRecord } from "../../utils.js";
import { isToolAllowedByPolicyName } from "../tool-policy-match.js";
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
};

type CronJobUpdatePatchPlan =
  | { kind: "ready"; patch: Record<string, unknown> }
  | { kind: "needs-current-job" }
  | { kind: "needs-creator-authority" };

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
): void {
  target.length = 0;
  const seen = new Set<string>();
  for (const tool of tools) {
    const name = normalizeToolPolicyName(tool.name);
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    const meta = toolMeta?.(tool);
    const pluginId =
      typeof meta?.pluginId === "string" ? normalizeToolPolicyName(meta.pluginId) : undefined;
    target.push(pluginId ? { name, pluginId } : { name });
  }
}

/** Records the creator cap only after every runtime policy and schema quarantine has run. */
export function captureFinalEffectiveCronCreatorToolAllowlist<T extends { name: string }>(
  target: CronCreatorToolAllowlistEntry[],
  captureRef: CronToolsAllowCaptureRef,
  tools: readonly T[],
  toolMeta?: (tool: T) => { pluginId?: string } | undefined,
): void {
  replaceWithEffectiveCronCreatorToolAllowlist(target, tools, toolMeta);
  captureRef.value = { version: 1, source: "final-executable-surface" };
}

function normalizeCronToolsAllow(values: readonly string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of expandToolGroups([...values])) {
    const toolName = normalizeToolPolicyName(entry);
    if (!toolName || seen.has(toolName)) {
      continue;
    }
    seen.add(toolName);
    normalized.push(toolName);
  }
  return normalized;
}

function normalizeCronCreatorToolsAllow(
  values: readonly CronCreatorToolAllowlistEntry[],
): NormalizedCronCreatorTool[] {
  const normalized: NormalizedCronCreatorTool[] = [];
  const seen = new Set<string>();
  for (const entry of values) {
    const name = normalizeToolPolicyName(typeof entry === "string" ? entry : entry.name);
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    const pluginId =
      typeof entry === "string" || typeof entry.pluginId !== "string"
        ? undefined
        : normalizeToolPolicyName(entry.pluginId);
    normalized.push(pluginId ? { name, pluginId } : { name });
  }
  return normalized;
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
    normalizeCronCreatorToolsAllow(creatorToolAllowlist ?? []).map((tool) => tool.name),
  );
  return normalizeCronToolsAllow(
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

  const requestedToolsAllow = normalizeCronToolsAllow(
    requestedRaw.filter((entry): entry is string => typeof entry === "string"),
  );
  if (requestedToolsAllow.length === 0) {
    params.payload.toolsAllow = [];
    delete params.payload.toolsAllowIsDefault;
    return;
  }
  if (requestedToolsAllow.includes("*")) {
    params.payload.toolsAllow = creatorToolNames;
    params.payload.toolsAllowIsDefault = true;
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
  params.payload.toolsAllow = creatorToolNames.filter((toolName) =>
    isToolAllowedByPolicyName(toolName, requestedPolicy),
  );
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
