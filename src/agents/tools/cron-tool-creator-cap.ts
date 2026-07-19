import { isRecord } from "../../utils.js";
import { isToolAllowedByPolicyName } from "../tool-policy-match.js";
import {
  buildPluginToolGroups,
  expandPolicyWithPluginGroups,
  expandToolGroups,
  normalizeToolName,
} from "../tool-policy.js";
import type { CronCreatorToolAllowlistEntry } from "./cron-tool.types.js";

type NormalizedCronCreatorTool = {
  name: string;
  pluginId?: string;
};

type CronJobUpdatePatchPlan =
  | { kind: "ready"; patch: Record<string, unknown> }
  | { kind: "needs-current-job" };

function normalizeCronToolsAllow(values: readonly string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of expandToolGroups([...values])) {
    const toolName = normalizeToolName(entry);
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
    const name = normalizeToolName(typeof entry === "string" ? entry : entry.name);
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    const pluginId =
      typeof entry === "string" || typeof entry.pluginId !== "string"
        ? undefined
        : normalizeToolName(entry.pluginId);
    normalized.push(pluginId ? { name, pluginId } : { name });
  }
  return normalized;
}

function hasCronTriggerScript(value: unknown): boolean {
  return isRecord(value) && typeof value.script === "string" && value.script.trim().length > 0;
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
  if (!creatorToolAllowlist || !isRecord(value) || !isRecord(value.payload)) {
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
}): CronJobUpdatePatchPlan {
  const patch = structuredClone(params.patch);
  const payload = isRecord(patch.payload) ? patch.payload : undefined;
  const explicitPayloadKind = readCronPayloadKind(payload);
  if (
    params.creatorToolAllowlist &&
    explicitPayloadKind !== undefined &&
    payload &&
    Object.hasOwn(payload, "toolsAllow")
  ) {
    capCronJobToolsAllow({
      payload,
      trigger: patch.trigger,
      creatorToolAllowlist: params.creatorToolAllowlist,
    });
    return { kind: "ready", patch };
  }

  const needsStoredPayloadKind = payload !== undefined && explicitPayloadKind === undefined;
  if (!needsStoredPayloadKind && !params.creatorToolAllowlist) {
    return { kind: "ready", patch };
  }
  if (!params.currentJob) {
    return { kind: "needs-current-job" };
  }

  const existingPayload = params.currentJob.payload;
  const payloadKind = explicitPayloadKind ?? readCronPayloadKind(existingPayload);
  if (payload && payloadKind !== undefined) {
    payload.kind = payloadKind;
    patch.payload = payload;
  }
  if (!params.creatorToolAllowlist) {
    return { kind: "ready", patch };
  }

  const trigger = Object.hasOwn(patch, "trigger") ? patch.trigger : params.currentJob.trigger;
  const writesToolsAllow = payload !== undefined && Object.hasOwn(payload, "toolsAllow");
  if (
    payloadKind !== "agentTurn" &&
    payloadKind !== "script" &&
    !hasCronTriggerScript(trigger) &&
    !writesToolsAllow
  ) {
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
      isRecord(existingPayload) && existingPayload.toolsAllowIsDefault !== true
        ? existingPayload.toolsAllow
        : undefined,
  });
  return { kind: "ready", patch };
}
