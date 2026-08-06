/**
 * Creates the Docker E2E/live model matrix plan for a release profile.
 */
export type ReleaseMatrixEntry = {
  chunk_id?: string;
  label?: string;
  timeout_minutes?: number;
  provider_label?: string;
  providers?: string;
  profiles: string;
  models?: string;
  max_models?: string;
};

export type OmittedReleaseMatrixEntry = { id: string; label: string; reason: string };

export function createReleaseWorkflowMatrixPlan(options?: {
  releaseProfile?: string;
  includeReleasePathSuites?: boolean | string;
  dockerLanes?: string;
  includeLiveSuites?: boolean | string;
  liveModelProviders?: string;
  liveSuiteFilter?: string;
}): {
  dockerE2e: {
    count: number;
    matrix: {
      include: ReleaseMatrixEntry[];
    };
    omitted: OmittedReleaseMatrixEntry[];
  };
  liveModels: {
    count: number;
    matrix: {
      include: ReleaseMatrixEntry[];
    };
    omitted: OmittedReleaseMatrixEntry[];
  };
  releaseProfile: string;
};
