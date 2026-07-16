import path from "node:path";
import {
  normalizeQaProviderMode as normalizeQaProviderModeInput,
  type QaProviderMode,
} from "./model-selection.js";
import { defaultQaRuntimeModelForMode } from "./model-selection.runtime.js";
import type { QaSeedScenario } from "./scenario-catalog.js";

export type { QaProviderMode } from "./model-selection.js";
export type QaProviderModeInput = QaProviderMode | "live-openai";

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

export function createDefaultQaRunSelection(scenarios: QaSeedScenario[]): QaLabRunSelection {
  const providerMode: QaProviderMode = "live-frontier";
  return {
    providerMode,
    primaryModel: defaultQaModelForMode(providerMode),
    alternateModel: defaultQaModelForMode(providerMode, true),
    fastMode: true,
    scenarioIds: scenarios.map((scenario) => scenario.id),
  };
}

export function normalizeQaProviderMode(input: unknown): QaProviderMode {
  return normalizeQaProviderModeInput(
    input === "mock-openai" || input === "live-frontier" || input === "live-openai"
      ? input
      : "live-frontier",
  );
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
    fastMode: providerMode === "live-frontier" || payload.fastMode === true,
    scenarioIds: normalizeScenarioIds(payload.scenarioIds, scenarios),
  };
}

export function createIdleQaRunnerSnapshot(scenarios: QaSeedScenario[]): QaLabRunnerSnapshot {
  return {
    status: "idle",
    selection: createDefaultQaRunSelection(scenarios),
    artifacts: null,
    error: null,
  };
}

export function createQaRunOutputDir(baseDir = process.cwd()) {
  const stamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "").replace("T", "-");
  return path.join(baseDir, ".artifacts", "qa-e2e", `lab-${stamp}`);
}
