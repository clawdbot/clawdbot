export type DockerE2eImageKind = "bare" | "functional";
export type DockerE2eReleaseProfile = "beta" | "stable" | "full";
export type DockerE2eReleaseProfileInput = "minimum" | DockerE2eReleaseProfile;

export type DockerE2eLane = {
  cacheKey?: string;
  command: string;
  e2eImageKind?: DockerE2eImageKind;
  estimateSeconds?: number;
  live: boolean;
  name: string;
  needsLiveImage?: boolean;
  noOutputTimeoutMs?: number;
  resources: string[];
  retries: number;
  retryPatterns: RegExp[];
  stateScenario?: string;
  timeoutMs?: number;
  weight: number;
};

export const DEFAULT_LIVE_RETRIES: number;
export const BUNDLED_PLUGIN_INSTALL_UNINSTALL_SHARDS: number;
export const mainLanes: DockerE2eLane[];
export const tailLanes: DockerE2eLane[];
export function normalizeReleaseProfile(
  raw: DockerE2eReleaseProfileInput | null | undefined,
): DockerE2eReleaseProfile;
export function releasePathChunkLanes(
  chunk: string,
  options?: { includeOpenWebUI?: boolean; releaseProfile?: DockerE2eReleaseProfileInput },
): DockerE2eLane[];
export function allReleasePathLanes(options?: {
  includeOpenWebUI?: boolean;
  releaseProfile?: DockerE2eReleaseProfileInput;
}): DockerE2eLane[];
