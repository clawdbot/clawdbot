#!/usr/bin/env -S node --import tsx
// Sparkle Build script supports OpenClaw repository automation.

import { pathToFileURL } from "node:url";

export type SparkleBuildFloors = {
  releaseKey: number;
  legacyFloor: number;
  laneFloor: number;
  lane: number;
};

const RELEASE_VERSION_REGEX = /^([0-9]{4})\.([0-9]{1,2})\.([1-9][0-9]*)([.-].*)?$/;
const MONTHLY_PATCH_SPARKLE_BUILD_ADOPTION = {
  year: 2026,
  month: 6,
  patch: 5,
};

function compareReleaseParts(
  left: { year: number; month: number; patch: number },
  right: { year: number; month: number; patch: number },
): number {
  if (left.year !== right.year) {
    return Math.sign(left.year - right.year);
  }
  if (left.month !== right.month) {
    return Math.sign(left.month - right.month);
  }
  return Math.sign(left.patch - right.patch);
}

function usesMonthlyPatchSparkleBuild(version: {
  year: number;
  month: number;
  patch: number;
}): boolean {
  return compareReleaseParts(version, MONTHLY_PATCH_SPARKLE_BUILD_ADOPTION) >= 0;
}

function legacyDateReleaseKey(year: number, month: number, patch: number): number {
  return Number(`${year}${String(month).padStart(2, "0")}${String(patch).padStart(2, "0")}`);
}

function monthlyPatchReleaseKey(year: number, month: number, patch: number): number {
  return (year - 2000) * 100_000_000 + month * 1_000_000 + patch * 100;
}

export function sparkleBuildFloorsFromShortVersion(
  shortVersion: string,
): SparkleBuildFloors | null {
  const match = RELEASE_VERSION_REGEX.exec(shortVersion.trim());
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const patch = Number(match[3]);
  if (
    !Number.isSafeInteger(year) ||
    !Number.isSafeInteger(month) ||
    !Number.isSafeInteger(patch) ||
    month < 1 ||
    month > 12 ||
    patch < 1
  ) {
    return null;
  }

  let lane = 90;
  const suffix = match[4] ?? "";
  if (suffix.length > 0) {
    const numericSuffix = /([0-9]+)$/.exec(suffix)?.[1];
    if (numericSuffix) {
      const parsedLane = Number(numericSuffix);
      if (!Number.isSafeInteger(parsedLane) || parsedLane < 1) {
        return null;
      }
      lane = Math.min(parsedLane, 89);
    } else {
      lane = 1;
    }
  }

  if (usesMonthlyPatchSparkleBuild({ year, month, patch })) {
    // Keep old appcast entries byte-stable, then switch to YYMMPPPPLL so
    // monthly patches beyond 31 stay monotonic without pretending to be dates.
    const releaseKey = monthlyPatchReleaseKey(year, month, patch);
    const laneFloor = releaseKey + lane;
    if (!isSafeSparkleFloor(releaseKey) || !isSafeSparkleFloor(laneFloor)) {
      return null;
    }
    return {
      releaseKey,
      legacyFloor: releaseKey,
      laneFloor,
      lane,
    };
  }

  const releaseKey = legacyDateReleaseKey(year, month, patch);
  const legacyFloor = Number(`${releaseKey}0`);
  const laneFloor = Number(`${releaseKey}${String(lane).padStart(2, "0")}`);
  if (
    !isSafeSparkleFloor(releaseKey) ||
    !isSafeSparkleFloor(legacyFloor) ||
    !isSafeSparkleFloor(laneFloor)
  ) {
    return null;
  }
  return { releaseKey, legacyFloor, laneFloor, lane };
}

export function canonicalSparkleBuildFromVersion(shortVersion: string): number | null {
  return sparkleBuildFloorsFromShortVersion(shortVersion)?.laneFloor ?? null;
}

function isSafeSparkleFloor(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function runCli(args: string[]): number {
  const [command, version] = args;
  if (command !== "canonical-build" || !version) {
    return 1;
  }

  const build = canonicalSparkleBuildFromVersion(version);
  if (build === null) {
    return 1;
  }

  console.log(String(build));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(runCli(process.argv.slice(2)));
}
