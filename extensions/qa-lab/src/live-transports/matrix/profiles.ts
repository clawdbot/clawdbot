import { listQaScenariosForExecutionProfile } from "../../scenario-catalog.js";

const MATRIX_QA_PROFILES = [
  "all",
  "fast",
  "release",
  "transport",
  "media",
  "e2ee-smoke",
  "e2ee-deep",
  "e2ee-cli",
] as const;

export function resolveMatrixQaScenarioIds(params: {
  profile?: string;
  scenarioIds?: readonly string[];
}): string[] {
  if (params.scenarioIds?.length) {
    return [...params.scenarioIds];
  }
  const profile = params.profile?.trim() || "all";
  if (!MATRIX_QA_PROFILES.some((candidate) => candidate === profile)) {
    throw new Error(
      `Unknown QA Lab Matrix profile "${profile}". Expected one of: ${MATRIX_QA_PROFILES.join(", ")}.`,
    );
  }
  return listQaScenariosForExecutionProfile(`matrix:${profile}`).map((scenario) => scenario.id);
}
