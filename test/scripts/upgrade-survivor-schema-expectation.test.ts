import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const command = resolve("scripts/e2e/lib/upgrade-survivor/schema-expectation.mjs");

function writeSchema(file: string, version: number) {
  mkdirSync(dirname(file), { recursive: true });
  const database = new DatabaseSync(file);
  try {
    database.exec(`PRAGMA user_version = ${version}`);
  } finally {
    database.close();
  }
}

function fixture(
  baselineVersion = "2026.9.2",
  stateVersion: number | null = 15,
  agentVersion: number | null = 19,
) {
  const root = tempDirs.make("survivor-schema-expectation-");
  const stateDir = join(root, "state");
  const stateDatabase = join(stateDir, "state", "openclaw.sqlite");
  const agentDatabase = join(stateDir, "agents", "ops", "agent", "openclaw-agent.sqlite");
  if (stateVersion !== null) {
    writeSchema(stateDatabase, stateVersion);
  }
  if (agentVersion !== null) {
    writeSchema(agentDatabase, agentVersion);
  }
  const packageRoot = join(root, "baseline");
  mkdirSync(packageRoot);
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "openclaw", version: baselineVersion }),
  );
  writeFileSync(join(packageRoot, "openclaw.mjs"), "// baseline launcher\n");
  const dependencyFile = join(packageRoot, "node_modules", "fixture-dependency", "index.js");
  mkdirSync(dirname(dependencyFile), { recursive: true });
  writeFileSync(dependencyFile, "// baseline dependency\n");
  const candidateDir = join(root, "package");
  mkdirSync(candidateDir);
  // Main can retain the released version while its schema contract advances.
  const candidateVersion = "2026.9.2";
  writeFileSync(
    join(candidateDir, "package.json"),
    JSON.stringify({
      name: "openclaw",
      version: candidateVersion,
      openclaw: { schemaVersions: { state: 16, agent: 19 } },
    }),
  );
  const tarball = join(root, "candidate.tgz");
  execFileSync("tar", ["-czf", tarball, "-C", root, "package"]);
  const snapshotFile = join(root, "snapshot.json");
  const updateFile = join(root, "update.json");
  const errorFile = join(root, "update.err");
  const observationRoot = join(root, "observation");
  const diagnosticsDir = join(observationRoot, "diagnostics");
  mkdirSync(diagnosticsDir, { recursive: true });
  const observationFile = join(diagnosticsDir, "process-123-exited.json");
  writeFileSync(
    observationFile,
    JSON.stringify({
      role: "doctor",
      packageVersion: candidateVersion,
      event: "exited",
      exitCode: 1,
    }),
  );
  const update = {
    status: "error",
    before: { version: baselineVersion },
    steps: [
      {
        name: "openclaw doctor",
        exitCode: 1,
        stdoutTail: "",
        stderrTail:
          "[openclaw] DoctorUpdateSchemaRefusalError: Doctor refused update-time schema repair",
      },
    ],
  };
  writeFileSync(errorFile, "");
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [command, ...args], {
      encoding: "utf8",
      timeout: 10_000,
    });
  const prepared = run("prepare", baselineVersion, tarball, stateDir, snapshotFile, packageRoot);
  expect(prepared.status, prepared.stderr).toBe(0);
  function check(exitCode = 1, installedVersion = baselineVersion) {
    writeFileSync(updateFile, JSON.stringify(update));
    return run(
      "assert",
      snapshotFile,
      String(exitCode),
      installedVersion,
      updateFile,
      errorFile,
      observationRoot,
      packageRoot,
    );
  }
  return {
    prepared,
    check,
    update,
    observationFile,
    stateDatabase,
    agentDatabase,
    packageRoot,
    dependencyFile,
    snapshotFile,
    candidateVersion,
  };
}

describe("published survivor schema outcome", () => {
  it.each([
    ["2026.9.2", 15, 19, "schema-refusal"],
    ["2026.9.2-rebuild.1", 15, 19, "schema-refusal"],
    ["2026.9.2", 16, 18, "schema-refusal"],
    ["2026.9.2", 16, 19, "success"],
    ["2026.9.1", 15, 18, "success"],
    ["2026.6.34", 0, 0, "success"],
    ["2026.9.3-beta.1", 15, 18, "success"],
    ["2026.9.3", 15, 18, "success"],
  ] as const)("requires %s with schemas %i/%i to report %s", (baseline, state, agent, expected) => {
    const lane = fixture(baseline, state, agent);
    expect(lane.prepared.stdout.trim()).toBe(expected);
    if (expected === "success") {
      expect(lane.check().status).toBe(1);
      writeSchema(lane.stateDatabase, 16);
      writeSchema(lane.agentDatabase, 19);
      const result = lane.check(0, lane.candidateVersion);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("success");
    } else {
      const result = lane.check();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("schema-refusal");
    }
  });

  it("observes refusal without changing the baseline package or database bytes", () => {
    const lane = fixture();
    const files = [lane.stateDatabase, lane.agentDatabase, join(lane.packageRoot, "openclaw.mjs")];
    const before = files.map((file) => readFileSync(file));
    const result = lane.check();
    expect(result.status, result.stderr).toBe(0);
    expect(files.map((file) => readFileSync(file))).toEqual(before);
  });

  it("expects success for a JSON-era baseline without creating SQLite state while observing it", () => {
    const lane = fixture("2026.6.34", null, null);
    expect(lane.prepared.stdout.trim()).toBe("success");
    expect(JSON.parse(readFileSync(lane.snapshotFile, "utf8")).databases).toEqual([
      { kind: "state", relative: "state/openclaw.sqlite", userVersion: null },
    ]);
    expect(existsSync(lane.stateDatabase)).toBe(false);
    expect(existsSync(lane.agentDatabase)).toBe(false);
    writeSchema(lane.stateDatabase, 16);
    writeSchema(lane.agentDatabase, 19);
    const result = lane.check(0, lane.candidateVersion);
    expect(result.status, result.stderr).toBe(0);
  });

  it("accepts the structured refusal emitted by JSON Doctor", () => {
    const lane = fixture();
    lane.update.steps[0]!.stderrTail = "";
    lane.update.steps[0]!.stdoutTail = JSON.stringify({
      ok: false,
      error: { code: "update-schema-bump-unfenced" },
    });
    const result = lane.check();
    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects a successful update that deleted a baseline agent database", () => {
    const lane = fixture("2026.9.1");
    writeSchema(lane.stateDatabase, 16);
    rmSync(lane.agentDatabase);
    const result = lane.check(0, lane.candidateVersion);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("baseline database missing after update");
  });

  it.each([
    [
      "state migrated",
      (lane: ReturnType<typeof fixture>) => writeSchema(lane.stateDatabase, 16),
      "baseline databases",
    ],
    [
      "agent migrated",
      (lane: ReturnType<typeof fixture>) => writeSchema(lane.agentDatabase, 20),
      "baseline databases",
    ],
    [
      "database lost",
      (lane: ReturnType<typeof fixture>) => rmSync(lane.agentDatabase),
      "baseline databases",
    ],
    [
      "candidate bytes retained at the baseline version",
      (lane: ReturnType<typeof fixture>) =>
        writeFileSync(join(lane.packageRoot, "openclaw.mjs"), "// candidate launcher\n"),
      "package bytes",
    ],
    [
      "changed installed dependency bytes",
      (lane: ReturnType<typeof fixture>) =>
        writeFileSync(lane.dependencyFile, "// candidate dependency\n"),
      "package bytes",
    ],
    [
      "generic Doctor failure",
      (lane: ReturnType<typeof fixture>) => {
        lane.update.steps[0]!.stderrTail = "Doctor failed; run doctor --fix";
      },
      "typed schema refusal",
    ],
    [
      "Doctor did not fail",
      (lane: ReturnType<typeof fixture>) => {
        lane.update.steps[0]!.exitCode = 0;
      },
      "failed Doctor step",
    ],
    [
      "candidate Doctor did not exit",
      (lane: ReturnType<typeof fixture>) => rmSync(lane.observationFile),
      "observed refusal exit",
    ],
  ] as const)("rejects %s", (_name, change, diagnostic) => {
    const lane = fixture();
    change(lane);
    const result = lane.check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(diagnostic);
  });

  it("rejects a successful exit or another installed version instead of refusal", () => {
    const lane = fixture();
    expect(lane.check(0).stderr).toContain("status 1");
    expect(lane.check(1, "2026.9.3").stderr).toContain("previous package version");
  });
});
