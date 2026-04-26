import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { consumeGatewayRestartIntentSync, writeGatewayRestartIntentSync } from "./restart.js";

const tempDirs: string[] = [];

function createIntentEnv(): NodeJS.ProcessEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-restart-intent-"));
  tempDirs.push(dir);
  return {
    ...process.env,
    OPENCLAW_STATE_DIR: dir,
  };
}

function intentPath(env: NodeJS.ProcessEnv): string {
  return path.join(env.OPENCLAW_STATE_DIR ?? "", "gateway-restart-intent.json");
}

describe("gateway restart intent", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  it("consumes a fresh intent for the current process", () => {
    const env = createIntentEnv();

    expect(writeGatewayRestartIntentSync({ env, targetPid: process.pid })).toBe(true);

    expect(consumeGatewayRestartIntentSync(env)).toBe(true);
    expect(fs.existsSync(intentPath(env))).toBe(false);
  });

  it("rejects an intent for a different process", () => {
    const env = createIntentEnv();

    expect(writeGatewayRestartIntentSync({ env, targetPid: process.pid + 1 })).toBe(true);

    expect(consumeGatewayRestartIntentSync(env)).toBe(false);
    expect(fs.existsSync(intentPath(env))).toBe(false);
  });

  it("rejects oversized intent files before parsing", () => {
    const env = createIntentEnv();
    fs.writeFileSync(intentPath(env), "x".repeat(2048), { encoding: "utf8", mode: 0o600 });

    expect(consumeGatewayRestartIntentSync(env)).toBe(false);
    expect(fs.existsSync(intentPath(env))).toBe(false);
  });

  it("writes intent files with owner-only permissions", () => {
    const env = createIntentEnv();

    expect(writeGatewayRestartIntentSync({ env, targetPid: process.pid })).toBe(true);

    expect(fs.statSync(intentPath(env)).mode & 0o777).toBe(0o600);
  });

  it("does not follow an existing intent-path symlink when writing", () => {
    const env = createIntentEnv();
    const targetPath = path.join(env.OPENCLAW_STATE_DIR ?? "", "attacker-target.txt");
    fs.writeFileSync(targetPath, "keep", "utf8");
    try {
      fs.symlinkSync(targetPath, intentPath(env));
    } catch {
      return;
    }

    expect(writeGatewayRestartIntentSync({ env, targetPid: process.pid })).toBe(true);

    expect(fs.readFileSync(targetPath, "utf8")).toBe("keep");
    expect(fs.lstatSync(intentPath(env)).isSymbolicLink()).toBe(false);
    expect(consumeGatewayRestartIntentSync(env)).toBe(true);
  });
});
