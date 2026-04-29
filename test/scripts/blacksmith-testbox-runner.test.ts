import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildBlacksmithRunArgs,
  runBlacksmithTestboxRunner,
  splitRunnerArgs,
} from "../../scripts/blacksmith-testbox-runner.mjs";

describe("blacksmith testbox runner", () => {
  it("splits runner args from the remote command", () => {
    expect(
      splitRunnerArgs(["--id", "tbx_abc123", "--", "OPENCLAW_TESTBOX=1", "pnpm", "check:changed"]),
    ).toEqual({
      runnerArgs: ["--id", "tbx_abc123"],
      commandArgs: ["OPENCLAW_TESTBOX=1", "pnpm", "check:changed"],
    });
  });

  it("builds blacksmith run arguments", () => {
    expect(
      buildBlacksmithRunArgs({
        commandArgs: ["OPENCLAW_TESTBOX=1", "pnpm", "check:changed"],
        testboxId: "tbx_abc123",
      }),
    ).toEqual(["testbox", "run", "--id", "tbx_abc123", "OPENCLAW_TESTBOX=1 pnpm check:changed"]);
  });

  it("refuses to run a remote-visible id without a local private key", () => {
    let spawned = false;
    const stderr = { write: (value: string) => value.length };
    const code = runBlacksmithTestboxRunner({
      argv: ["--id", "tbx_01kqap50t9fqggzw1akg5dtmmq", "--", "pnpm", "check:changed"],
      env: { OPENCLAW_BLACKSMITH_TESTBOX_STATE_DIR: "/state/testboxes" },
      spawn: () => {
        spawned = true;
        return { status: 0 };
      },
      stderr,
    });

    expect(code).toBe(2);
    expect(spawned).toBe(false);
  });

  it("refuses to run a keyed id that was not claimed by this checkout", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-testbox-runner-"));
    const testboxDir = path.join(stateDir, "tbx_01kqap50t9fqggzw1akg5dtmmq");
    fs.mkdirSync(testboxDir, { recursive: true });
    fs.writeFileSync(path.join(testboxDir, "id_ed25519"), "test-key\n");

    let spawned = false;
    let stderrText = "";
    const code = runBlacksmithTestboxRunner({
      argv: ["--id", "tbx_01kqap50t9fqggzw1akg5dtmmq", "--", "pnpm", "check:changed"],
      env: { ...process.env, OPENCLAW_BLACKSMITH_TESTBOX_STATE_DIR: stateDir },
      spawn: () => {
        spawned = true;
        return { status: 0 };
      },
      stderr: { write: (value: string) => (stderrText += value) },
    });

    expect(code).toBe(2);
    expect(spawned).toBe(false);
    expect(stderrText).toContain("OpenClaw Testbox claim missing");
  });

  it("claims a keyed id without spawning when no remote command is supplied", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-testbox-runner-"));
    const testboxDir = path.join(stateDir, "tbx_01kqap50t9fqggzw1akg5dtmmq");
    const claimPath = path.join(testboxDir, "openclaw-runner.json");
    fs.mkdirSync(testboxDir, { recursive: true });
    fs.writeFileSync(path.join(testboxDir, "id_ed25519"), "test-key\n");

    let spawned = false;
    let stdoutText = "";
    const code = runBlacksmithTestboxRunner({
      argv: ["--claim", "--id", "tbx_01kqap50t9fqggzw1akg5dtmmq"],
      env: { ...process.env, OPENCLAW_BLACKSMITH_TESTBOX_STATE_DIR: stateDir },
      spawn: () => {
        spawned = true;
        return { status: 0 };
      },
      stdout: { write: (value: string) => (stdoutText += value) },
    });

    expect(code).toBe(0);
    expect(spawned).toBe(false);
    expect(stdoutText).toContain("OpenClaw Testbox claim written");
    expect(JSON.parse(fs.readFileSync(claimPath, "utf8")).repoRoot).toBe(process.cwd());
  });
});
