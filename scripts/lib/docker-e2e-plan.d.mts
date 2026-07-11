import type {
  DockerE2eImageKind,
  DockerE2eLane,
  DockerE2eReleaseProfile,
  DockerE2eReleaseProfileInput,
} from "./docker-e2e-scenarios.mjs";

export type DockerE2ePlanLane = {
  command: string;
  imageKind?: DockerE2eImageKind;
  live: boolean;
  name: string;
  noOutputTimeoutMs?: number;
  resources: string[];
  stateScenario?: string;
  timeoutMs?: number;
  weight: number;
};

export type DockerE2ePlanOptions = {
  includeOpenWebUI: boolean;
  liveMode: "all" | "only" | "skip";
  liveRetries: number;
  orderLanes: <T>(lanes: T[]) => T[];
  planReleaseAll: boolean;
  profile: string;
  releaseChunk: string;
  releaseProfile?: DockerE2eReleaseProfileInput;
  selectedLaneNames: string[];
  timingStore?: unknown;
  upgradeSurvivorBaselines?: string;
  upgradeSurvivorScenarios?: string;
};

export type DockerE2ePlan = {
  chunk: string;
  credentials: string[];
  imageKinds: DockerE2eImageKind[];
  includeOpenWebUI: boolean;
  lanes: DockerE2ePlanLane[];
  mainLanes: DockerE2ePlanLane[];
  needs: {
    bareImage: boolean;
    e2eImage: boolean;
    functionalImage: boolean;
    liveImage: boolean;
    package: boolean;
  };
  profile: string;
  releaseProfile?: DockerE2eReleaseProfile;
  selectedLanes: DockerE2ePlanLane[];
  tailLanes: DockerE2ePlanLane[];
  version: number;
};

export const DEFAULT_LIVE_RETRIES: number;
export const DEFAULT_E2E_BARE_IMAGE: string;
export const DEFAULT_E2E_FUNCTIONAL_IMAGE: string;
export const DEFAULT_E2E_IMAGE: string;
export const DEFAULT_PARALLELISM: number;
export const DEFAULT_PROFILE: string;
export const DEFAULT_RESOURCE_LIMITS: Record<string, number>;
export const DEFAULT_TAIL_PARALLELISM: number;
export const RELEASE_PATH_PROFILE: string;

export function normalizeReleaseProfile(raw: unknown): DockerE2eReleaseProfile;
export function parseLaneSelection(raw: unknown): string[];
export function normalizeUpgradeSurvivorBaselineSpec(raw: unknown): string | undefined;
export function parseLiveMode(raw: unknown): DockerE2ePlanOptions["liveMode"];
export function parseProfile(raw: unknown): string;
export function laneWeight(poolLane: DockerE2eLane): number;
export function laneResources(poolLane: DockerE2eLane): string[];
export function laneSummary(poolLane: DockerE2eLane): string;
export function lanesNeedE2eImageKind(
  poolLanes: DockerE2eLane[],
  kind: DockerE2eImageKind,
): boolean;
export function lanesNeedOpenClawPackage(poolLanes: DockerE2eLane[]): boolean;
export function findLaneByName(name: string): DockerE2eLane | undefined;
export function resolveDockerE2ePlan(options: DockerE2ePlanOptions): {
  orderedLanes: DockerE2eLane[];
  orderedTailLanes: DockerE2eLane[];
  plan: DockerE2ePlan;
  scheduledLanes: DockerE2eLane[];
};
