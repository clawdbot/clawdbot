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
export type ReleaseTrain =
  | "alpha"
  | "beta"
  | "stable"
  | "extended-stable"
  | "unsupported-extended-stable-correction";
export function parseReleaseVersion(version: string): ParsedReleaseVersion | null;
export function classifyReleaseTrain(parsedVersion: ParsedReleaseVersion): ReleaseTrain;
export function collectReleaseVersionFloorErrors(
  version: string | ParsedReleaseVersion | null,
): string[];
export function compareReleaseVersions(left: string, right: string): number | null;
