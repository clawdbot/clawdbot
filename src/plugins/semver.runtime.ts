import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const semver = require("semver") as {
  satisfies(version: string, range: string, options?: { includePrerelease?: boolean }): boolean;
  valid(version: string): string | null;
  validRange(range: string): string | null;
};

export const satisfies = (
  version: string,
  range: string,
  options?: { includePrerelease?: boolean },
): boolean => semver.satisfies(version, range, options);

export const validSemver = (version: string): string | null => semver.valid(version);

export const validRange = (range: string): string | null => semver.validRange(range);
