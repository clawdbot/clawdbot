import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT_PATH = "scripts/e2e/lib/docker-stats/assert-resource-ceiling.mjs";
const tempRoots: string[] = [];

function writeStats(contents: string): string {
  const root = mkdtempSync(join(tmpdir(), "openclaw-docker-stats-"));
  tempRoots.push(root);
  const file = join(root, "stats.jsonl");
  writeFileSync(file, contents);
  return file;
}

function runAssert(statsFile: string, maxMemoryMiB = "512", maxCpuPercent = "100") {
  return spawnSync(process.execPath, [SCRIPT_PATH, statsFile, maxMemoryMiB, maxCpuPercent, "test"], {
    encoding: "utf8",
  });
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("scripts/e2e/lib/docker-stats/assert-resource-ceiling.mjs", () => {
  it("fails when the stats log contains no parseable samples", () => {
    const result = runAssert(writeStats("not-json\n"));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("was not valid JSON");
  });

  it("rejects invalid resource limits instead of disabling the ceiling", () => {
    const result = runAssert(writeStats('{"MemUsage":"128MiB / 2GiB","CPUPerc":"25.0%"}\n'), "nope");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("max memory MiB must be a finite non-negative number");
  });

  it("rejects JSON samples without parseable Docker resource fields", () => {
    const missing = runAssert(writeStats("{}\n"));

    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain("had invalid MemUsage");

    const malformed = runAssert(writeStats('{"MemUsage":"bad","CPUPerc":"bad"}\n'));

    expect(malformed.status).not.toBe(0);
    expect(malformed.stderr).toContain("had invalid MemUsage");
  });

  it("reports and enforces parsed Docker resource peaks", () => {
    const result = runAssert(
      writeStats('{"MemUsage":"128MiB / 2GiB","CPUPerc":"25.0%"}\n'),
      "256",
      "50",
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("memory=128.0MiB");
    expect(result.stdout).toContain("cpu=25.0%");
    expect(result.stdout).toContain("samples=1");
  });

  it("accepts byte-unit Docker memory samples", () => {
    const result = runAssert(writeStats('{"MemUsage":"512B / 2GiB","CPUPerc":"0.5%"}\n'));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("samples=1");
  });
});
