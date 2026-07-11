export type ParsedReleaseVersion = {
  version: string;
  baseVersion: string;
  channel: "stable" | "alpha" | "beta";
  year: number;
  month: number;
  patch: number;
  alphaNumber?: number;
  betaNumber?: number;
  correctionNumber?: number;
};
export type NpmPublishPlan = {
  channel: "stable" | "alpha" | "beta";
  publishTag: "latest" | "alpha" | "beta" | "extended-stable";
  mirrorDistTags: Array<"latest" | "alpha" | "beta">;
};
export type PublishedNpmVersionRoute = "npm-readback" | "npm-mirror" | "npm-tag-repair";
export type NpmRegistryPackumentResult = {
  status: number;
  ok: boolean;
  packument: unknown;
};
export function fetchNpmRegistryPackumentWithRetry(params: {
  packageName: string;
  packageUrl: string;
  attempts?: number;
  timeoutMs?: number;
  fetchImpl?: (input: string, init: RequestInit) => Promise<Response>;
  sleep?: (delayMs: number) => Promise<void>;
  createSignal?: (timeoutMs: number) => AbortSignal;
}): Promise<NpmRegistryPackumentResult>;
export function parseReleaseVersion(version: string): ParsedReleaseVersion | null;
export function collectReleaseVersionFloorErrors(
  version: string | ParsedReleaseVersion | null,
): string[];
export function compareReleaseVersions(left: string, right: string): number | null;
export function resolveNpmPublishPlan(
  version: string,
  currentBetaVersion?: string | null,
  publishTagOverride?: string | null,
): NpmPublishPlan;
export function resolvePublishedNpmVersionRoute(params: {
  packageVersion: string;
  publishPlan: NpmPublishPlan;
  distTags: Record<string, unknown>;
}): PublishedNpmVersionRoute;
export function resolveNpmDistTagMirrorAuth(params?: {
  nodeAuthToken?: string | null;
  npmToken?: string | null;
}): { hasAuth: boolean; source: "node-auth-token" | "npm-token" | "none" };
export function shouldRequireNpmDistTagMirrorAuth(params: {
  mode: "--dry-run" | "--publish";
  mirrorDistTags: readonly string[];
  hasAuth: boolean;
}): boolean;
