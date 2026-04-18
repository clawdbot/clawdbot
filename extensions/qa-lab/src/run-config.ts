import path from "node:path";
import { defaultQaModelForMode as defaultStaticQaModelForMode } from "./model-selection.js";
import { defaultQaRuntimeModelForMode } from "./model-selection.runtime.js";
import {
  DEFAULT_QA_LIVE_PROVIDER_MODE,
  getQaProvider,
  isQaProviderModeInput,
  normalizeQaProviderMode as normalizeQaProviderModeInput,
  type QaProviderMode,
} from "./providers/index.js";
import type { QaSeedScenario } from "./scenario-catalog.js";

export type { QaProviderMode } from "./model-selection.js";
export type { QaProviderModeInput } from "./providers/index.js";

export type QaLabRunSelection = {
  providerMode: QaProviderMode;
  primaryModel: string;
  alternateModel: string;
  fastMode: boolean;
  scenarioIds: string[];
};

export type QaLabRunArtifacts = {
  outputDir: string;
  reportPath: string;
  summaryPath: string;
  watchUrl: string;
};

export type QaLabRunnerSnapshot = {
  status: "idle" | "running" | "completed" | "failed";
  selection: QaLabRunSelection;
  startedAt?: string;
  finishedAt?: string;
  artifacts: QaLabRunArtifacts | null;
  error: string | null;
};

export function defaultQaModelForMode(mode: QaProviderMode, alternate = false) {
  return defaultQaRuntimeModelForMode(mode, alternate ? { alternate: true } : undefined);
}

type QaDefaultModelResolver = (mode: QaProviderMode, alternate?: boolean) => string;

function defaultStaticModelForMode(mode: QaProviderMode, alternate = false) {
  return defaultStaticQaModelForMode(mode, alternate ? { alternate: true } : undefined);
}

export function createDefaultQaRunSelection(
  scenarios: QaSeedScenario[],
  options?: { resolveDefaultModel?: QaDefaultModelResolver },
): QaLabRunSelection {
  const providerMode: QaProviderMode = DEFAULT_QA_LIVE_PROVIDER_MODE;
  const resolveDefaultModel = options?.resolveDefaultModel ?? defaultQaModelForMode;
  return {
    providerMode,
    primaryModel: resolveDefaultModel(providerMode),
    alternateModel: resolveDefaultModel(providerMode, true),
    fastMode: true,
    scenarioIds: scenarios.map((scenario) => scenario.id),
  };
}

export function normalizeQaProviderMode(input: unknown): QaProviderMode {
  if (input === undefined || input === null || input === "") {
    return DEFAULT_QA_LIVE_PROVIDER_MODE;
  }
  if (isQaProviderModeInput(input)) {
    return normalizeQaProviderModeInput(input);
  }
  const details = typeof input === "string" ? `: ${input}` : "";
  throw new Error(`unknown QA provider mode${details}`);
}

function normalizeModel(input: unknown, fallback: string) {
  const value = typeof input === "string" ? input.trim() : "";
  return value || fallback;
}

function normalizeScenarioIds(input: unknown, scenarios: QaSeedScenario[]) {
  const availableIds = new Set(scenarios.map((scenario) => scenario.id));
  const requestedIds = Array.isArray(input)
    ? input
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter((value) => value.length > 0)
    : [];
  const selectedIds = requestedIds.filter((id, index) => {
    return availableIds.has(id) && requestedIds.indexOf(id) === index;
  });
  return selectedIds.length > 0 ? selectedIds : scenarios.map((scenario) => scenario.id);
}

export function normalizeQaRunSelection(
  input: unknown,
  scenarios: QaSeedScenario[],
): QaLabRunSelection {
  const payload = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const providerMode = normalizeQaProviderMode(payload.providerMode);
  return {
    providerMode,
    primaryModel: normalizeModel(payload.primaryModel, defaultQaModelForMode(providerMode)),
    alternateModel: normalizeModel(
      payload.alternateModel,
      defaultQaModelForMode(providerMode, true),
    ),
    fastMode: getQaProvider(providerMode).kind === "live" || payload.fastMode === true,
    scenarioIds: normalizeScenarioIds(payload.scenarioIds, scenarios),
  };
}

export function createIdleQaRunnerSnapshot(scenarios: QaSeedScenario[]): QaLabRunnerSnapshot {
  return {
    status: "idle",
    selection: createDefaultQaRunSelection(scenarios, {
      resolveDefaultModel: defaultStaticModelForMode,
    }),
    artifacts: null,
    error: null,
  };
}

export function createQaRunOutputDir(baseDir = process.cwd()) {
  const stamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "").replace("T", "-");
  return path.join(baseDir, ".artifacts", "qa-e2e", `lab-${stamp}`);
}
