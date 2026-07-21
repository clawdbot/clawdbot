import {
  escapeInternalRuntimeContextDelimiters,
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
} from "../agents/internal-runtime-context.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  RuntimeActionRef,
  RuntimeContextConfig,
  RuntimeContextExposureMode,
  RuntimeOffloadTarget,
  RuntimeResources,
  RuntimeSelfContext,
} from "./types.js";

export const RUNTIME_SELF_CONTEXT_TOOL_NAME = "runtime";

const RUNTIME_TOOL_HINT =
  "Runtime details are available through the runtime tool. Do not guess local resources, " +
  "scale options, offload targets, or cost. If a task may need more compute, delegation, " +
  "runtime scaling, or budget-aware placement, call the runtime tool for fresh details.";

function resolveExposureMode(config: RuntimeContextConfig): RuntimeContextExposureMode {
  // Default closed: configuring a runtime context value must not silently add the runtime tool or
  // inject per-turn prompt text. Operators opt in explicitly via expose.mode.
  return config.expose?.mode ?? "none";
}

export function shouldExposeRuntimeSelfContext(config: RuntimeContextConfig | undefined): boolean {
  if (!config) {
    return false;
  }
  return resolveExposureMode(config) !== "none";
}

function resolveRuntimeContextConfig(
  config: OpenClawConfig | undefined,
): RuntimeContextConfig | undefined {
  return config?.runtimeContext;
}

function formatBytes(bytes: number | undefined): string | undefined {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) {
    return undefined;
  }
  const gib = bytes / 1024 ** 3;
  if (gib >= 1) {
    return `${Math.round(gib * 10) / 10} GiB`;
  }
  const mib = bytes / 1024 ** 2;
  if (mib >= 1) {
    return `${Math.round(mib * 10) / 10} MiB`;
  }
  return `${Math.round(bytes)} bytes`;
}

function formatDataString(value: string | undefined): string | undefined {
  const normalized = value
    ?.split("")
    .map((char) => {
      const code = char.charCodeAt(0);
      return code < 32 || code === 127 ? " " : char;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return undefined;
  }
  const clipped = normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
  return JSON.stringify(clipped);
}

function formatResources(resources: RuntimeResources | undefined): string {
  const parts: string[] = [];
  if (resources?.cpu) {
    const cpuParts = [
      typeof resources.cpu.effectiveCores === "number"
        ? `${resources.cpu.effectiveCores} CPU`
        : undefined,
      formatDataString(resources.cpu.model),
      formatDataString(resources.cpu.architecture),
    ].filter((part): part is string => Boolean(part));
    if (cpuParts.length > 0) {
      parts.push(cpuParts.join(", "));
    }
  }
  const memory = formatBytes(resources?.memory?.effectiveBytes);
  if (memory) {
    parts.push(`${memory} memory`);
  }
  const accelerators = resources?.accelerators ?? [];
  if (accelerators.length > 0) {
    parts.push(`${accelerators.length} accelerator${accelerators.length === 1 ? "" : "s"}`);
  } else if (resources) {
    parts.push("no accelerator");
  }
  return parts.length > 0 ? parts.join("; ") : "unknown";
}

function formatActions(actions: RuntimeActionRef[] | undefined): string {
  const kinds = (actions ?? []).map((action) =>
    action.requiresApproval ? `${action.kind} approval` : action.kind,
  );
  return kinds.length > 0 ? kinds.join(", ") : "none";
}

function formatOffloadAvailability(targets: RuntimeOffloadTarget[] | undefined): string {
  const offloadTargets = targets ?? [];
  const availableTargets = offloadTargets.filter(
    (target) => target.availability?.state === "available",
  ).length;
  const unavailableTargets = offloadTargets.filter(
    (target) =>
      target.availability?.state === "unavailable" || target.availability?.state === "error",
  ).length;
  const pendingTargets = offloadTargets.length - availableTargets - unavailableTargets;
  const parts = [
    `${offloadTargets.length} target${offloadTargets.length === 1 ? "" : "s"} configured`,
    availableTargets > 0 ? `${availableTargets} available` : undefined,
    unavailableTargets > 0 ? `${unavailableTargets} unavailable` : undefined,
    pendingTargets > 0 ? `${pendingTargets} pending/unknown` : undefined,
  ].filter((part): part is string => Boolean(part));
  return parts.join(", ");
}

function buildPromptSummary(context: RuntimeSelfContext, config: RuntimeContextConfig): string {
  const current = context.current;
  const currentLabel = formatDataString(
    current?.label ?? context.label ?? current?.id ?? context.id,
  );
  const locality = current?.locality ?? "unknown";
  const offloadTargets = context.offload?.targets ?? [];
  const costModel = context.cost?.model ?? "unknown";
  const validUntil = context.freshness?.validUntil ?? config.validUntil;
  return [
    "Runtime summary:",
    `- current: ${currentLabel ?? "unknown"}, ${locality}`,
    `- resources: ${formatResources(context.resources)}`,
    `- actions: ${formatActions(context.actions)}`,
    `- offload: ${formatOffloadAvailability(offloadTargets)}`,
    `- cost: ${costModel}`,
    '- details: call runtime tool action "describe" for fresh details',
    ...(validUntil ? [`- valid until: ${formatDataString(validUntil) ?? "unknown"}`] : []),
  ].join("\n");
}

function buildRuntimeSelfContextPrompt(config: RuntimeContextConfig | undefined): string {
  if (!config) {
    return "";
  }
  const mode = resolveExposureMode(config);
  if (mode === "none") {
    return "";
  }
  if (mode === "tool_hint") {
    return RUNTIME_TOOL_HINT;
  }
  const summary = config.value ? buildPromptSummary(config.value, config) : "";
  return [RUNTIME_TOOL_HINT, summary].filter((part) => part.trim()).join("\n\n");
}

function buildRuntimeSelfContextInternalBlock(
  config: RuntimeContextConfig | undefined,
  options?: { runtimeToolAvailable?: boolean },
): string | undefined {
  if (options?.runtimeToolAvailable === false) {
    return undefined;
  }
  const prompt = buildRuntimeSelfContextPrompt(config).trim();
  if (!prompt) {
    return undefined;
  }
  return [
    INTERNAL_RUNTIME_CONTEXT_BEGIN,
    escapeInternalRuntimeContextDelimiters(prompt),
    INTERNAL_RUNTIME_CONTEXT_END,
  ].join("\n");
}

export function appendRuntimeSelfContextToPrompt(params: {
  prompt: string;
  config?: OpenClawConfig;
  runtimeToolAvailable?: boolean;
}): string {
  const block = buildRuntimeSelfContextInternalBlock(resolveRuntimeContextConfig(params.config), {
    runtimeToolAvailable: params.runtimeToolAvailable,
  });
  if (!block) {
    return params.prompt;
  }
  return params.prompt.trim() ? `${params.prompt}\n\n${block}` : block;
}
