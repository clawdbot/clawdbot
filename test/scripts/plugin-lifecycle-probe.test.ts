import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const probePath = "scripts/e2e/lib/plugin-lifecycle-matrix/probe.mjs";
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "openclaw-plugin-lifecycle-probe-"));
  tempDirs.push(dir);
  return dir;
}

function runProbe(args: string[], home = makeTempDir()) {
  return spawnSync(process.execPath, [probePath, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      OPENCLAW_CONFIG_PATH: path.join(home, ".openclaw", "openclaw.json"),
      USERPROFILE: home,
    },
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("plugin lifecycle matrix probe", () => {
  it("accepts inspect JSON for an enabled loaded plugin", () => {
    const dir = makeTempDir();
    const inspectPath = path.join(dir, "inspect.json");
    writeFileSync(
      inspectPath,
      `${JSON.stringify({ plugin: { enabled: true, id: "lifecycle-claw", status: "loaded" } })}\n`,
      "utf8",
    );

    const result = runProbe(["assert-inspect-loaded", "lifecycle-claw", inspectPath], dir);

    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects inspect JSON that does not prove the runtime loaded", () => {
    const dir = makeTempDir();
    const inspectPath = path.join(dir, "inspect.json");
    writeFileSync(
      inspectPath,
      `${JSON.stringify({ plugin: { enabled: true, id: "lifecycle-claw", status: "pending" } })}\n`,
      "utf8",
    );

    const result = runProbe(["assert-inspect-loaded", "lifecycle-claw", inspectPath], dir);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("expected lifecycle-claw inspect status loaded, got pending");
  });

  it("rejects missing inspect JSON instead of treating it as an empty object", () => {
    const dir = makeTempDir();
    const inspectPath = path.join(dir, "missing.json");

    const result = runProbe(["assert-inspect-loaded", "lifecycle-claw", inspectPath], dir);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`failed to read JSON from ${inspectPath}`);
  });
});
