import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  detectLegacyRescuePending,
  discardLegacyRescuePending,
} from "./state-migrations.rescue-pending.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function makeStateDir(): string {
  return tempDirs.make("openclaw-rescue-migration-");
}

function writeLegacyApproval(stateDir: string, owner: "crestodian" | "openclaw"): string {
  const sourcePath = path.join(stateDir, owner, "rescue-pending", "approval.json");
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, "{}\n");
  return sourcePath;
}

describe("legacy rescue pending cleanup", () => {
  it("discards both retired stores only during explicit doctor migration", () => {
    const stateDir = makeStateDir();
    const crestodianPath = writeLegacyApproval(stateDir, "crestodian");
    const openclawPath = writeLegacyApproval(stateDir, "openclaw");

    const runtimeDetection = detectLegacyRescuePending({ stateDir });
    expect(runtimeDetection.hasLegacy).toBe(false);
    expect(discardLegacyRescuePending({ detected: runtimeDetection, stateDir })).toEqual({
      changes: [],
      warnings: [],
    });
    expect(fs.existsSync(crestodianPath)).toBe(true);
    expect(fs.existsSync(openclawPath)).toBe(true);

    const doctorDetection = detectLegacyRescuePending({
      stateDir,
      doctorOnlyStateMigrations: true,
    });
    expect(doctorDetection.hasLegacy).toBe(true);
    const result = discardLegacyRescuePending({ detected: doctorDetection, stateDir });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toHaveLength(1);
    expect(fs.existsSync(crestodianPath)).toBe(false);
    expect(fs.existsSync(openclawPath)).toBe(false);
    expect(detectLegacyRescuePending({ stateDir, doctorOnlyStateMigrations: true }).hasLegacy).toBe(
      false,
    );
  });

  it("recomputes fixed owner paths instead of trusting detection paths", () => {
    const stateDir = makeStateDir();
    const openclawPath = writeLegacyApproval(stateDir, "openclaw");

    discardLegacyRescuePending({
      detected: { hasLegacy: true, sourcePaths: [path.join(stateDir, "untrusted")] },
      stateDir,
    });

    expect(fs.existsSync(openclawPath)).toBe(false);
  });

  it("refuses to traverse a symlinked owner directory", () => {
    const stateDir = makeStateDir();
    const externalDir = makeStateDir();
    const externalApproval = writeLegacyApproval(externalDir, "openclaw");
    fs.symlinkSync(path.join(externalDir, "openclaw"), path.join(stateDir, "openclaw"));

    const detected = detectLegacyRescuePending({ stateDir, doctorOnlyStateMigrations: true });
    const result = discardLegacyRescuePending({ detected, stateDir });

    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining("Refused to remove retired rescue approvals through unsafe path"),
    ]);
    expect(fs.existsSync(externalApproval)).toBe(true);
  });
});
