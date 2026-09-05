import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { applyMergePatch, createMergePatch } from "./merge-patch.js";
import { getRuntimeConfigSnapshot, getRuntimeConfigSourceSnapshot } from "./runtime-snapshot.js";
import type { OpenClawConfig } from "./types.js";

export function projectSourceOntoRuntimeShape(source: unknown, runtime: unknown): unknown {
  if (!isRecord(source) || !isRecord(runtime)) {
    return structuredClone(source);
  }

  const next: Record<string, unknown> = {};
  for (const [key, sourceValue] of Object.entries(source)) {
    if (!(key in runtime)) {
      next[key] = structuredClone(sourceValue);
      continue;
    }
    next[key] = projectSourceOntoRuntimeShape(sourceValue, runtime[key]);
  }
  return next;
}

function isCompatibleTopLevelRuntimeProjectionShape(params: {
  runtimeSnapshot: OpenClawConfig;
  candidate: OpenClawConfig;
}): boolean {
  const runtime = params.runtimeSnapshot as Record<string, unknown>;
  const candidate = params.candidate as Record<string, unknown>;
  for (const key of Object.keys(runtime)) {
    if (!Object.hasOwn(candidate, key)) {
      return false;
    }
    const runtimeValue = runtime[key];
    const candidateValue = candidate[key];
    const runtimeType = Array.isArray(runtimeValue)
      ? "array"
      : runtimeValue === null
        ? "null"
        : typeof runtimeValue;
    const candidateType = Array.isArray(candidateValue)
      ? "array"
      : candidateValue === null
        ? "null"
        : typeof candidateValue;
    if (runtimeType !== candidateType) {
      return false;
    }
  }
  return true;
}

/** Projects a runtime-derived config back onto the active authored source snapshot. */
export function projectConfigOntoRuntimeSourceSnapshot(config: OpenClawConfig): OpenClawConfig {
  const runtimeConfigSnapshot = getRuntimeConfigSnapshot();
  const runtimeConfigSourceSnapshot = getRuntimeConfigSourceSnapshot();
  if (!runtimeConfigSnapshot || !runtimeConfigSourceSnapshot) {
    return config;
  }
  if (config === runtimeConfigSnapshot) {
    return runtimeConfigSourceSnapshot;
  }
  if (
    !isCompatibleTopLevelRuntimeProjectionShape({
      runtimeSnapshot: runtimeConfigSnapshot,
      candidate: config,
    })
  ) {
    return config;
  }
  const projectedSource = projectSourceOntoRuntimeShape(
    runtimeConfigSourceSnapshot,
    runtimeConfigSnapshot,
  ) as OpenClawConfig;
  const runtimePatch = createMergePatch(runtimeConfigSnapshot, config);
  return applyMergePatch(projectedSource, runtimePatch) as OpenClawConfig;
}
