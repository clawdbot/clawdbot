import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const observer = resolve("scripts/e2e/lib/upgrade-survivor/diagnostics.mjs");

describe("upgrade survivor first-hop process evidence", () => {
  it.each([0, 1])("retains the old parent and target Doctor identities on exit %i", (code) => {
    const root = realpathSync(tempDirs.make("survivor-first-hop-"));
    const artifacts = join(root, "artifacts");
    mkdirSync(artifacts);
    const manifest = join(root, "package.json");
    writeFileSync(manifest, JSON.stringify({ name: "openclaw", version: "2026.7.1-2" }));
    const entrypoint = join(root, "openclaw.mjs");
    // Files change under the running parent. Reading package.json at exit would
    // falsely attribute that parent's result to the newly installed updater.
    writeFileSync(
      entrypoint,
      `import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
if (process.argv[2] === 'update') {
  fs.writeFileSync(${JSON.stringify(manifest)}, JSON.stringify({name:'openclaw',version:'2026.8.1'}));
  const child = spawnSync(process.execPath, ['--import', ${JSON.stringify(observer)}, process.argv[1], 'doctor', '--non-interactive', '--fix'], {
    env: {...process.env, OPENCLAW_UPDATE_IN_PROGRESS:'1'}, stdio:'inherit'
  });
  process.exitCode = child.status;
} else {
  console.log('doctor fixture finished');
  process.exitCode = ${code};
}
`,
    );
    const result = spawnSync(
      process.execPath,
      ["--import", observer, entrypoint, "update", "--tag", "private-argument-value"],
      {
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT: artifacts,
          OPENCLAW_GATEWAY_TOKEN: "private-environment-value",
        },
      },
    );
    expect(result.status, result.stderr).toBe(code);
    expect(result.stdout).toBe("doctor fixture finished\n");
    expect(result.stderr).toBe("");
    const files = readdirSync(join(artifacts, "diagnostics"));
    const reports = files.map((name) =>
      JSON.parse(readFileSync(join(artifacts, "diagnostics", name), "utf8")),
    );
    const started = reports.filter((report) => report.event === "started");
    const parent = started.find((report) => report.role === "update");
    const doctor = started.find((report) => report.role === "doctor");
    expect(started).toHaveLength(2);
    expect(parent).toMatchObject({ packageVersion: "2026.7.1-2" });
    expect(doctor).toMatchObject({ packageVersion: "2026.8.1", parentPid: parent.pid });
    expect(reports.filter((report) => report.event === "exited")).toEqual(
      expect.arrayContaining([
        { ...parent, event: "exited", exitCode: code },
        { ...doctor, event: "exited", exitCode: code },
      ]),
    );
    const serialized = JSON.stringify(reports);
    expect(serialized).not.toContain("private-argument-value");
    expect(serialized).not.toContain("private-environment-value");
    expect(serialized).not.toContain(root);
  });

  it.skipIf(process.platform === "win32")("does not turn a signal into a successful exit", () => {
    const root = realpathSync(tempDirs.make("survivor-interrupted-hop-"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.7.1-2" }),
    );
    const entrypoint = join(root, "openclaw.mjs");
    writeFileSync(entrypoint, 'process.kill(process.pid, "SIGTERM");');
    const result = spawnSync(process.execPath, ["--import", observer, entrypoint, "update"], {
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT: root },
    });
    expect(result.status).toBeNull();
    expect(result.signal).toBe("SIGTERM");
    expect(result.stdout + result.stderr).toBe("");
    const reports = readdirSync(join(root, "diagnostics")).map((name) =>
      JSON.parse(readFileSync(join(root, "diagnostics", name), "utf8")),
    );
    expect(reports).toEqual([
      expect.objectContaining({ role: "update", event: "started", packageVersion: "2026.7.1-2" }),
    ]);
  });
});
