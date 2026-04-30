import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

type SemverRuntime = {
  satisfies(version: string, range: string, options?: { includePrerelease?: boolean }): boolean;
  valid(version: string): string | null;
  validRange(range: string): string | null;
};

let semver: SemverRuntime | undefined;

function getSemver(): SemverRuntime {
  semver ??= require("semver") as SemverRuntime;
  return semver;
}

export const satisfies = (
  version: string,
  range: string,
  options?: { includePrerelease?: boolean },
): boolean => getSemver().satisfies(version, range, options);

export const validSemver = (version: string): string | null => getSemver().valid(version);

export const validRange = (range: string): string | null => getSemver().validRange(range);
