// Qa Lab plugin module implements runtime tool metadata behavior.
import {
  asBoolean as readBoolean,
  isRecord,
  normalizeOptionalString as readString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type { QaRuntimeParityTier, QaSeedScenarioWithSource } from "./scenario-catalog.js";

export type QaRuntimeToolBucket =
  | "codex-native-workspace"
  | "openclaw-dynamic-integration"
  | "optional-profile-or-plugin";

export type QaRuntimeToolExpectedLayer =
  | "codex-native-workspace"
  | "openclaw-dynamic"
  | "profile-or-plugin";

export type QaRuntimeCapabilityLayer =
  | "codex-native-workspace"
  | "openclaw-dynamic-direct"
  | "openclaw-dynamic-searchable"
  | "optional-profile-or-plugin"
  | "structural-text";

export type RuntimeParityComparisonMode = "default" | "codex-native-workspace" | "outcome-only";

export type QaRuntimeToolCoverageMetadata = {
  bucket: QaRuntimeToolBucket;
  expectedLayer: QaRuntimeToolExpectedLayer;
  capabilityLayer: QaRuntimeCapabilityLayer;
  required: boolean;
  tracking?: string;
  reason?: string;
  codexDefaultImpact?: string;
  qaImpact?: string;
  action?: string;
};

const QA_RUNTIME_TOOL_BUCKETS: readonly QaRuntimeToolBucket[] = [
  "codex-native-workspace",
  "openclaw-dynamic-integration",
  "optional-profile-or-plugin",
] as const;

const QA_RUNTIME_TOOL_EXPECTED_LAYERS: readonly QaRuntimeToolExpectedLayer[] = [
  "codex-native-workspace",
  "openclaw-dynamic",
  "profile-or-plugin",
] as const;

const QA_RUNTIME_CAPABILITY_LAYERS: readonly QaRuntimeCapabilityLayer[] = [
  "codex-native-workspace",
  "openclaw-dynamic-direct",
  "openclaw-dynamic-searchable",
  "optional-profile-or-plugin",
  "structural-text",
] as const;

const DEFAULT_LAYER_BY_BUCKET: Record<QaRuntimeToolBucket, QaRuntimeToolExpectedLayer> = {
  "codex-native-workspace": "codex-native-workspace",
  "openclaw-dynamic-integration": "openclaw-dynamic",
  "optional-profile-or-plugin": "profile-or-plugin",
};

const DEFAULT_CAPABILITY_LAYER_BY_BUCKET: Record<QaRuntimeToolBucket, QaRuntimeCapabilityLayer> = {
  "codex-native-workspace": "codex-native-workspace",
  "openclaw-dynamic-integration": "openclaw-dynamic-searchable",
  "optional-profile-or-plugin": "optional-profile-or-plugin",
};

function isQaRuntimeToolBucket(value: string): value is QaRuntimeToolBucket {
  return QA_RUNTIME_TOOL_BUCKETS.includes(value as QaRuntimeToolBucket);
}

function isQaRuntimeToolExpectedLayer(value: string): value is QaRuntimeToolExpectedLayer {
  return QA_RUNTIME_TOOL_EXPECTED_LAYERS.includes(value as QaRuntimeToolExpectedLayer);
}

function isQaRuntimeCapabilityLayer(value: string): value is QaRuntimeCapabilityLayer {
  return QA_RUNTIME_CAPABILITY_LAYERS.includes(value as QaRuntimeCapabilityLayer);
}

export function readRuntimeToolCoverageConfig(
  config: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return isRecord(config?.toolCoverage) ? config.toolCoverage : undefined;
}

function inferRuntimeToolBucket(params: {
  config?: Record<string, unknown>;
  runtimeParityTier?: QaRuntimeParityTier;
}): QaRuntimeToolBucket {
  const toolCoverage = readRuntimeToolCoverageConfig(params.config);
  const explicit = readString(toolCoverage?.bucket);
  if (explicit) {
    if (!isQaRuntimeToolBucket(explicit)) {
      throw new Error(
        `unknown runtime tool coverage bucket: ${explicit}; expected ${QA_RUNTIME_TOOL_BUCKETS.join(
          ", ",
        )}`,
      );
    }
    return explicit;
  }
  if (params.runtimeParityTier === "optional" || params.config?.expectedAvailable === false) {
    return "optional-profile-or-plugin";
  }
  return "openclaw-dynamic-integration";
}

export function readRuntimeToolCoverageMetadata(params: {
  config?: Record<string, unknown>;
  runtimeParityTier?: QaRuntimeParityTier;
}): QaRuntimeToolCoverageMetadata {
  const toolCoverage = readRuntimeToolCoverageConfig(params.config);
  const bucket = inferRuntimeToolBucket(params);
  const expectedLayerInput = readString(toolCoverage?.expectedLayer);
  if (expectedLayerInput && !isQaRuntimeToolExpectedLayer(expectedLayerInput)) {
    throw new Error(
      `unknown runtime tool expectedLayer: ${expectedLayerInput}; expected ${QA_RUNTIME_TOOL_EXPECTED_LAYERS.join(
        ", ",
      )}`,
    );
  }
  const expectedLayer = expectedLayerInput
    ? (expectedLayerInput as QaRuntimeToolExpectedLayer)
    : DEFAULT_LAYER_BY_BUCKET[bucket];
  const capabilityLayerInput = readString(toolCoverage?.capabilityLayer);
  if (capabilityLayerInput && !isQaRuntimeCapabilityLayer(capabilityLayerInput)) {
    throw new Error(
      `unknown runtime tool capabilityLayer: ${capabilityLayerInput}; expected ${QA_RUNTIME_CAPABILITY_LAYERS.join(
        ", ",
      )}`,
    );
  }
  const capabilityLayer = capabilityLayerInput
    ? (capabilityLayerInput as QaRuntimeCapabilityLayer)
    : DEFAULT_CAPABILITY_LAYER_BY_BUCKET[bucket];
  const explicitSearchableDynamic = capabilityLayerInput === "openclaw-dynamic-searchable";
  const required =
    readBoolean(toolCoverage?.required) ??
    (bucket !== "optional-profile-or-plugin" && !explicitSearchableDynamic);
  return {
    bucket,
    expectedLayer,
    capabilityLayer,
    required,
    ...((readString(toolCoverage?.tracking) ?? readString(toolCoverage?.issue))
      ? { tracking: readString(toolCoverage?.tracking) ?? readString(toolCoverage?.issue) }
      : {}),
    ...(readString(toolCoverage?.reason) ? { reason: readString(toolCoverage?.reason) } : {}),
    ...(readString(toolCoverage?.codexDefaultImpact)
      ? { codexDefaultImpact: readString(toolCoverage?.codexDefaultImpact) }
      : {}),
    ...(readString(toolCoverage?.qaImpact) ? { qaImpact: readString(toolCoverage?.qaImpact) } : {}),
    ...(readString(toolCoverage?.action) ? { action: readString(toolCoverage?.action) } : {}),
  };
}

export function readScenarioRuntimeToolCoverageMetadata(
  scenario: QaSeedScenarioWithSource,
): QaRuntimeToolCoverageMetadata {
  return readRuntimeToolCoverageMetadata({
    config: scenario.execution.config,
    runtimeParityTier: scenario.runtimeParityTier,
  });
}
