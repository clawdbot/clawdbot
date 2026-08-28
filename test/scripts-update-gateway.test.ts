// Regression coverage for scripts/update-gateway.sh stop/backup/rollback flow.
// Runs the real script in a scratch git checkout with PATH-shimmed
// openclaw/pnpm binaries so gateway and build behavior are controlled.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptSource = path.join(repoRoot, "scripts", "update-gateway.sh");

let scratch: string;
let workdir: string;
let shimDir: string;
let invocationLog: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function writeShim(name: string, body: string): void {
  const file = path.join(shimDir, name);
  fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  fs.chmodSync(file, 0o755);
}

function runUpdater(env: Record<string, string> = {}) {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...env,
    PATH: `${shimDir}:${process.env.PATH ?? ""}`,
    UPDATE_TEST_LOG: invocationLog,
  };
  if (!Object.hasOwn(env, "OPENCLAW_UPDATE_RESTART_CMD")) {
    delete childEnv.OPENCLAW_UPDATE_RESTART_CMD;
  }
  if (!Object.hasOwn(env, "OPENCLAW_UPDATE_STOP_CMD")) {
    delete childEnv.OPENCLAW_UPDATE_STOP_CMD;
  }
  return spawnSync("bash", [path.join(workdir, "scripts", "update-gateway.sh")], {
    cwd: workdir,
    encoding: "utf8",
    env: childEnv,
  });
}

function loggedInvocations(): string[] {
  return fs.existsSync(invocationLog)
    ? fs.readFileSync(invocationLog, "utf8").trim().split("\n").filter(Boolean)
    : [];
}

describe("scripts/update-gateway.sh", () => {
  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-update-gateway-"));
    const origin = path.join(scratch, "origin.git");
    const seed = path.join(scratch, "seed");
    workdir = path.join(scratch, "checkout");
    shimDir = path.join(scratch, "bin");
    invocationLog = path.join(scratch, "invocations.log");
    fs.mkdirSync(shimDir);

    // Seed a repo whose main branch carries the real updater script.
    fs.mkdirSync(path.join(seed, "scripts"), { recursive: true });
    fs.copyFileSync(scriptSource, path.join(seed, "scripts", "update-gateway.sh"));
    fs.writeFileSync(path.join(seed, "README.md"), "scratch\n");
    git(seed, "init", "-q", "-b", "main");
    git(seed, "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A");
    git(seed, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "seed");
    git(scratch, "clone", "-q", "--bare", seed, origin);
    git(scratch, "clone", "-q", origin, workdir);

    // The git shim makes it possible to prove invalid lifecycle configuration
    // exits before even a local Git probe, while delegating valid runs to Git.
    writeShim(
      "git",
      ['echo "git $*" >> "$UPDATE_TEST_LOG"', 'PATH="${PATH#*:}" exec git "$@"'].join("\n"),
    );
    // The gateway CLI shim records exactly how the script invokes it.
    writeShim("openclaw", 'echo "openclaw $*" >> "$UPDATE_TEST_LOG"');
    // pnpm shim: `install` always succeeds; `build` obeys UPDATE_TEST_FAIL_BUILD
    // and otherwise writes fresh build output like a real clean build.
    writeShim(
      "pnpm",
      [
        'echo "pnpm $*" >> "$UPDATE_TEST_LOG"',
        'if [ "$1" = "build" ]; then',
        '  if [ "${UPDATE_TEST_FAIL_BUILD:-0}" = "1" ]; then exit 1; fi',
        "  mkdir -p dist && echo new > dist/marker",
        "fi",
        "exit 0",
      ].join("\n"),
    );
  });

  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("accepts the paired built-in defaults, stops non-interactively, and restarts", () => {
    const result = runUpdater();
    expect(result.status).toBe(0);
    const calls = loggedInvocations();
    // Default stop must be non-interactive-safe: gateway stop refuses
    // non-interactive runs without --force, and this script's documented
    // entry point is `ssh … scripts/update-gateway.sh`.
    expect(calls).toContain("openclaw gateway stop --force");
    const stopIndex = calls.indexOf("openclaw gateway stop --force");
    const buildIndex = calls.indexOf("pnpm build");
    expect(stopIndex).toBeGreaterThanOrEqual(0);
    expect(buildIndex).toBeGreaterThan(stopIndex);
    expect(calls).toContain("openclaw gateway restart");
    expect(fs.readFileSync(path.join(workdir, "dist", "marker"), "utf8")).toBe("new\n");
  });

  it("accepts paired custom commands after trimming surrounding whitespace", () => {
    const result = runUpdater({
      OPENCLAW_UPDATE_RESTART_CMD: "  openclaw custom-restart\t",
      OPENCLAW_UPDATE_STOP_CMD: "\n openclaw custom-stop  ",
    });

    expect(result.status).toBe(0);
    const calls = loggedInvocations();
    expect(calls).toContain("openclaw custom-stop");
    expect(calls).toContain("openclaw custom-restart");
  });

  it.each([
    ["stop only", { OPENCLAW_UPDATE_STOP_CMD: "openclaw custom-stop" }],
    ["restart only", { OPENCLAW_UPDATE_RESTART_CMD: "openclaw custom-restart" }],
  ] satisfies Array<[string, Record<string, string>]>)(
    "rejects a %s override before touching git",
    (_name, overrides) => {
      const result = runUpdater(overrides);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("must be set together");
      expect(loggedInvocations()).toEqual([]);
    },
  );

  it.each([
    [
      "stop",
      {
        OPENCLAW_UPDATE_RESTART_CMD: "openclaw custom-restart",
        OPENCLAW_UPDATE_STOP_CMD: " \t\n",
      },
    ],
    [
      "restart",
      {
        OPENCLAW_UPDATE_RESTART_CMD: "\n\t ",
        OPENCLAW_UPDATE_STOP_CMD: "openclaw custom-stop",
      },
    ],
  ] satisfies Array<[string, Record<string, string>]>)(
    "rejects a whitespace-only %s command before touching git",
    (command, overrides) => {
      const result = runUpdater(overrides);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`OPENCLAW_UPDATE_${command.toUpperCase()}_CMD is blank`);
      expect(loggedInvocations()).toEqual([]);
    },
  );

  it("restores the previous build output and restarts the gateway when the build fails", () => {
    fs.mkdirSync(path.join(workdir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(workdir, "dist", "marker"), "old\n");

    const result = runUpdater({ UPDATE_TEST_FAIL_BUILD: "1" });
    expect(result.status).not.toBe(0);
    // Previous output restored so the gateway can boot on the old build.
    expect(fs.readFileSync(path.join(workdir, "dist", "marker"), "utf8")).toBe("old\n");
    // Recovery restart ran even though the update failed.
    expect(loggedInvocations()).toContain("openclaw gateway restart");
    // No backup directory residue is left in the checkout.
    const leftovers = fs
      .readdirSync(workdir)
      .filter((name) => name.startsWith(".update-build-backup."));
    expect(leftovers).toEqual([]);
  });
});
