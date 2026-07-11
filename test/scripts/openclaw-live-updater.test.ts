import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  acquireMaintenanceLock,
  classifyActions,
  findExactMacTarget,
  inspectBuildState,
  maintainMain,
  originMatches,
} from "../../.agents/skills/openclaw-live-updater/scripts/update-main.mjs";
import {
  BUILD_STAMP_FILE,
  RUNTIME_POSTBUILD_STAMP_FILE,
} from "../../scripts/lib/local-build-metadata.mjs";
import { listCoreRuntimePostBuildOutputs } from "../../scripts/runtime-postbuild.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const script = path.join(repoRoot, ".agents/skills/openclaw-live-updater/scripts/update-main.mjs");
const fixtureOrigins = new Map<string, string>();

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function fetchFixtureMain(checkout: string, remote: string) {
  const origin = fixtureOrigins.get(checkout);
  if (!origin) {
    throw new Error(`missing fixture origin for ${checkout}`);
  }
  git(checkout, "fetch", origin, `main:refs/remotes/${remote}/main`);
}

function maintainFixture(
  options: Record<string, unknown>,
  dependencies: Record<string, unknown> = {},
) {
  return maintainMain(options, { fetchMain: fetchFixtureMain, ...dependencies });
}

function makeFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-live-updater-"));
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const mirror = path.join(root, "mirror");
  mkdirSync(seed);
  git(root, "init", "--bare", origin);
  git(seed, "init", "-b", "main");
  git(seed, "config", "user.name", "Test");
  git(seed, "config", "user.email", "test@example.com");
  writeFileSync(path.join(seed, "README.md"), "one\n");
  writeFileSync(path.join(seed, ".gitignore"), "dist/\nnode_modules/\n");
  git(seed, "add", "README.md", ".gitignore");
  git(seed, "commit", "-m", "initial");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-u", "origin", "main");
  git(root, "--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/main");
  git(root, "clone", origin, mirror);
  const canonicalOrigin = "https://github.com/openclaw/openclaw.git";
  git(mirror, "remote", "set-url", "origin", canonicalOrigin);
  fixtureOrigins.set(mirror, origin);
  return { root, mirror, origin, seed };
}

function writeBuild(mirror: string) {
  mkdirSync(path.join(mirror, "dist/control-ui"), { recursive: true });
  const head = git(mirror, "rev-parse", "HEAD");
  writeFileSync(path.join(mirror, "dist/build-info.json"), `${JSON.stringify({ commit: head })}\n`);
  writeFileSync(path.join(mirror, "dist/index.js"), "// built\n");
  writeFileSync(path.join(mirror, "dist/entry.js"), "// built\n");
  mkdirSync(path.join(mirror, "dist/control-ui/assets"), { recursive: true });
  writeFileSync(
    path.join(mirror, "dist/control-ui/index.html"),
    '<script type="module" src="./assets/app.js"></script>\n',
  );
  writeFileSync(path.join(mirror, "dist/control-ui/assets/app.js"), "// ui\n");
  writeFileSync(path.join(mirror, "dist", BUILD_STAMP_FILE), `${JSON.stringify({ head })}\n`);
  writeFileSync(
    path.join(mirror, "dist", RUNTIME_POSTBUILD_STAMP_FILE),
    `${JSON.stringify({ head })}\n`,
  );
  for (const relativePath of listCoreRuntimePostBuildOutputs({ rootDir: mirror })) {
    const outputPath = path.join(mirror, relativePath);
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, "// runtime postbuild\n");
  }
}

function fakeCommands(mirror: string) {
  const calls: string[] = [];
  return {
    calls,
    runCommand(command: string, args: string[]) {
      calls.push([command, ...args].join(" "));
      if (command === "pnpm" && args[0] === "install") {
        mkdirSync(path.join(mirror, "node_modules"), { recursive: true });
      }
      if (command === "pnpm" && args[0] === "build") {
        writeBuild(mirror);
      }
    },
  };
}

describe("openclaw live updater", () => {
  test("accepts supported OpenClaw GitHub origins", () => {
    expect(originMatches("https://github.com/openclaw/openclaw.git")).toBe(true);
    expect(originMatches("git@github.com:openclaw/openclaw.git")).toBe(true);
    expect(originMatches("https://github.com/example/openclaw.git")).toBe(false);
  });

  test("production fetch refreshes the remote-tracking main ref", () => {
    const source = readFileSync(script, "utf8");
    expect(source).toContain("refs/heads/main:refs/remotes/${remoteName}/main");
    expect(source).not.toContain('["fetch", "--prune", remoteName, "main"]');
  });

  test("rejects Git URL rewrites that change the effective fetch source", () => {
    const { mirror, origin } = makeFixture();
    git(mirror, "config", `url.${origin}.insteadOf`, "https://github.com/openclaw/openclaw.git");

    const result = spawnSync(process.execPath, [script, "--checkout", mirror], {
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: "rewritten_origin" },
    });
  });

  test("rejects a symlinked Git directory", () => {
    const { root, mirror } = makeFixture();
    const externalGitDir = path.join(root, "external-git-dir");
    renameSync(path.join(mirror, ".git"), externalGitDir);
    symlinkSync(externalGitDir, path.join(mirror, ".git"), "dir");

    const result = spawnSync(process.execPath, [script, "--checkout", mirror], {
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: "not_standalone_clone" },
    });
  });

  test("classifies exact-head build, install, macOS rebuild, and native UI proof", () => {
    expect(
      classifyActions(["docs/index.md"], {
        buildProvenanceKnown: true,
        buildRequired: true,
        nodeModulesPresent: true,
      }),
    ).toEqual({
      dependencyInstall: false,
      gatewayBuild: true,
      gatewayProbe: true,
      gatewayRestart: true,
      gatewaySelfHeal: false,
      macAppRebuild: false,
      macUiVerification: false,
    });
    expect(
      classifyActions(["package.json", "apps/macos/Sources/OpenClaw/AppDelegate.swift"], {
        buildProvenanceKnown: true,
        buildRequired: true,
        nodeModulesPresent: true,
      }),
    ).toEqual({
      dependencyInstall: true,
      gatewayBuild: true,
      gatewayProbe: true,
      gatewayRestart: true,
      gatewaySelfHeal: false,
      macAppRebuild: true,
      macUiVerification: true,
    });
  });

  test("accepts only the delayed exact target bundle process", () => {
    const executable = "/Users/steipete/openclaw/dist/OpenClaw.app/Contents/MacOS/OpenClaw";
    const foreign = "41 /tmp/agent/OpenClaw.app/Contents/MacOS/OpenClaw";
    expect(findExactMacTarget(foreign, executable)).toBeNull();
    expect(findExactMacTarget(`${foreign}\n42 ${executable} --attach-only`, executable)).toEqual({
      executable,
      pid: 42,
    });
  });

  test("rejects missing or mismatched canonical build stamps", () => {
    const { mirror } = makeFixture();
    writeBuild(mirror);
    const head = git(mirror, "rev-parse", "HEAD");
    const buildStamp = path.join(mirror, "dist", BUILD_STAMP_FILE);
    const runtimeStamp = path.join(mirror, "dist", RUNTIME_POSTBUILD_STAMP_FILE);

    writeFileSync(buildStamp, `${JSON.stringify({ head: "0".repeat(40) })}\n`);
    expect(inspectBuildState(mirror, head)).toMatchObject({
      current: false,
      buildStampHead: "0".repeat(40),
      requirements: { build: { shouldBuild: true, reason: "git_head_changed" } },
    });

    writeFileSync(buildStamp, `${JSON.stringify({ head })}\n`);
    rmSync(runtimeStamp);
    expect(inspectBuildState(mirror, head)).toMatchObject({
      current: false,
      runtimePostBuildStampHead: null,
      requirements: {
        runtimePostBuild: { shouldSync: true, reason: "missing_runtime_postbuild_stamp" },
      },
    });
  });

  test("rejects a missing Control UI asset referenced by index", () => {
    const { mirror } = makeFixture();
    writeBuild(mirror);
    const head = git(mirror, "rev-parse", "HEAD");
    rmSync(path.join(mirror, "dist/control-ui/assets/app.js"));

    expect(inspectBuildState(mirror, head)).toMatchObject({
      current: false,
      missingUiAssets: ["assets/*", "assets/app.js"],
    });
  });

  test("fast-forwards, builds exact SHA, restarts Gateway, then proves exact Mac target", () => {
    const { root, mirror, seed } = makeFixture();
    mkdirSync(path.join(seed, "apps/macos/Sources/OpenClaw"), { recursive: true });
    writeFileSync(path.join(seed, "apps/macos/Sources/OpenClaw/App.swift"), "// changed\n");
    git(seed, "add", ".");
    git(seed, "commit", "-m", "mac change");
    git(seed, "push");
    const commands = fakeCommands(mirror);

    const output = maintainFixture(
      {
        checkout: mirror,
        remote: "origin",
        lockPath: path.join(root, "maintenance.lock"),
        statePath: path.join(root, "maintenance-state.json"),
      },
      {
        runCommand: commands.runCommand,
        verifyMacTarget: () => ({
          executable: path.join(mirror, "dist/OpenClaw.app/Contents/MacOS/OpenClaw"),
          pid: 123,
        }),
      },
    );

    expect(output.updated).toBe(true);
    expect(output.afterSha).toBe(git(seed, "rev-parse", "HEAD"));
    expect(output.buildChangedPaths).toEqual(["apps/macos/Sources/OpenClaw/App.swift"]);
    expect(output.actions).toEqual({
      dependencyInstall: true,
      gatewayBuild: true,
      gatewayProbe: true,
      gatewayRestart: true,
      gatewaySelfHeal: false,
      macAppRebuild: true,
      macUiVerification: true,
    });
    expect(commands.calls).toEqual([
      "pnpm install --frozen-lockfile",
      "pnpm build",
      "pnpm openclaw gateway restart",
      "pnpm openclaw gateway status --deep --require-rpc --json",
      "pnpm openclaw health --verbose --json",
      "bash scripts/restart-mac.sh --sign --wait --target-only",
      "pnpm openclaw gateway status --deep --require-rpc --json",
      "pnpm openclaw health --verbose --json",
    ]);
    expect(output.macTarget?.executable).toBe(
      path.join(mirror, "dist/OpenClaw.app/Contents/MacOS/OpenClaw"),
    );
  });

  test("rejects a local main that is ahead of origin main", () => {
    const { root, mirror } = makeFixture();
    git(mirror, "config", "user.name", "Test");
    git(mirror, "config", "user.email", "test@example.com");
    writeFileSync(path.join(mirror, "local-commit.txt"), "local\n");
    git(mirror, "add", "local-commit.txt");
    git(mirror, "commit", "-m", "local commit");

    expect(() =>
      maintainFixture({
        checkout: mirror,
        remote: "origin",
        lockPath: path.join(root, "maintenance.lock"),
      }),
    ).toThrow(/does not equal origin\/main/u);
  });

  test("builds and restarts when build output is missing without a new commit", () => {
    const { root, mirror } = makeFixture();
    mkdirSync(path.join(mirror, "node_modules"));
    const commands = fakeCommands(mirror);

    const output = maintainFixture(
      { checkout: mirror, remote: "origin", lockPath: path.join(root, "maintenance.lock") },
      { runCommand: commands.runCommand },
    );

    expect(output.updated).toBe(false);
    expect(output.buildBefore.state).toBe("missing");
    expect(output.actions.gatewayBuild).toBe(true);
    expect(output.actions.dependencyInstall).toBe(true);
    expect(commands.calls).toEqual([
      "pnpm install --frozen-lockfile",
      "pnpm build",
      "pnpm openclaw gateway restart",
      "pnpm openclaw gateway status --deep --require-rpc --json",
      "pnpm openclaw health --verbose --json",
    ]);
  });

  test("proves a current exact-SHA Gateway on a no-op heartbeat", () => {
    const { root, mirror } = makeFixture();
    mkdirSync(path.join(mirror, "node_modules"));
    writeBuild(mirror);
    const commands = fakeCommands(mirror);

    const output = maintainFixture(
      { checkout: mirror, remote: "origin", lockPath: path.join(root, "maintenance.lock") },
      { runCommand: commands.runCommand },
    );

    expect(output.updated).toBe(false);
    expect(output.actions).toMatchObject({
      gatewayBuild: false,
      gatewayProbe: true,
      gatewayRestart: false,
      gatewaySelfHeal: false,
    });
    expect(commands.calls).toEqual([
      "pnpm openclaw gateway status --deep --require-rpc --json",
      "pnpm openclaw health --verbose --json",
    ]);
  });

  test("restores missing dependencies before probing a current build", () => {
    const { root, mirror } = makeFixture();
    writeBuild(mirror);
    const commands = fakeCommands(mirror);

    const output = maintainFixture(
      { checkout: mirror, remote: "origin", lockPath: path.join(root, "maintenance.lock") },
      { runCommand: commands.runCommand },
    );

    expect(output.actions).toMatchObject({
      dependencyInstall: true,
      gatewayBuild: false,
      gatewayProbe: true,
    });
    expect(commands.calls).toEqual([
      "pnpm install --frozen-lockfile",
      "pnpm openclaw gateway status --deep --require-rpc --json",
      "pnpm openclaw health --verbose --json",
    ]);
  });

  test("restarts once when a current exact-SHA Gateway probe fails", () => {
    const { root, mirror } = makeFixture();
    mkdirSync(path.join(mirror, "node_modules"));
    writeBuild(mirror);
    const calls: string[] = [];
    let failed = false;

    const output = maintainFixture(
      { checkout: mirror, remote: "origin", lockPath: path.join(root, "maintenance.lock") },
      {
        runCommand(command: string, args: string[]) {
          const call = [command, ...args].join(" ");
          calls.push(call);
          if (!failed && call.includes("gateway status")) {
            failed = true;
            throw new Error("RPC unavailable");
          }
        },
      },
    );

    expect(output.actions).toMatchObject({
      gatewayBuild: false,
      gatewayRestart: true,
      gatewaySelfHeal: true,
    });
    expect(calls).toEqual([
      "pnpm openclaw gateway status --deep --require-rpc --json",
      "pnpm openclaw gateway restart",
      "pnpm openclaw gateway status --deep --require-rpc --json",
      "pnpm openclaw health --verbose --json",
    ]);
  });

  test("keeps successful CLI stdout as one machine-readable JSON object", () => {
    const { root, mirror, origin } = makeFixture();
    mkdirSync(path.join(mirror, "node_modules"));
    writeBuild(mirror);
    const binDir = path.join(root, "bin");
    const pnpm = path.join(binDir, "pnpm");
    const gitShim = path.join(binDir, "git");
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    mkdirSync(binDir);
    writeFileSync(pnpm, "#!/bin/sh\necho child-output\n");
    writeFileSync(
      gitShim,
      `#!/bin/sh\nif [ "$3" = "fetch" ]; then\n  exec "${realGit}" -C "$2" fetch "${origin}" "main:refs/remotes/origin/main"\nfi\nexec "${realGit}" "$@"\n`,
    );
    chmodSync(pnpm, 0o755);
    chmodSync(gitShim, 0o755);

    const result = spawnSync(process.execPath, [script, "--checkout", mirror], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, updated: false });
    expect(result.stderr).toContain("child-output");
  });

  test("does not restart Gateway when build provenance misses the exact SHA", () => {
    const { root, mirror } = makeFixture();
    mkdirSync(path.join(mirror, "node_modules"));
    const calls: string[] = [];

    expect(() =>
      maintainFixture(
        { checkout: mirror, remote: "origin", lockPath: path.join(root, "maintenance.lock") },
        {
          runCommand: (command: string, args: string[]) => calls.push([command, ...args].join(" ")),
        },
      ),
    ).toThrow(/build output does not match/u);
    expect(calls).toEqual(["pnpm install --frozen-lockfile", "pnpm build"]);
  });

  test("retains failed exact-bundle Mac proof for the next heartbeat", () => {
    const { root, mirror, seed } = makeFixture();
    mkdirSync(path.join(seed, "apps/macos/Sources/OpenClaw"), { recursive: true });
    writeFileSync(path.join(seed, "apps/macos/Sources/OpenClaw/App.swift"), "// changed\n");
    git(seed, "add", ".");
    git(seed, "commit", "-m", "mac change");
    git(seed, "push");
    const lockPath = path.join(root, "maintenance.lock");
    const statePath = path.join(root, "maintenance-state.json");
    const firstCommands = fakeCommands(mirror);

    expect(() =>
      maintainFixture(
        { checkout: mirror, remote: "origin", lockPath, statePath },
        {
          runCommand: firstCommands.runCommand,
          verifyMacTarget: () => {
            throw new Error("exact target exited");
          },
        },
      ),
    ).toThrow("exact target exited");
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({
      macPending: true,
      attempts: 1,
      lastFailure: "exact target exited",
    });

    const retryCommands = fakeCommands(mirror);
    const retry = maintainFixture(
      { checkout: mirror, remote: "origin", lockPath, statePath },
      {
        runCommand: retryCommands.runCommand,
        verifyMacTarget: () => ({ executable: "exact", pid: 456 }),
      },
    );
    expect(retry.updated).toBe(false);
    expect(retry.actions.gatewayBuild).toBe(false);
    expect(retry.actions.macAppRebuild).toBe(true);
    expect(retryCommands.calls.slice(0, 3)).toEqual([
      "pnpm openclaw gateway status --deep --require-rpc --json",
      "pnpm openclaw health --verbose --json",
      "bash scripts/restart-mac.sh --sign --wait --target-only",
    ]);
    expect(existsSync(statePath)).toBe(false);
  });

  test("records pending Mac work before Gateway maintenance can fail", () => {
    const { root, mirror, seed } = makeFixture();
    mkdirSync(path.join(seed, "apps/macos/Sources/OpenClaw"), { recursive: true });
    writeFileSync(path.join(seed, "apps/macos/Sources/OpenClaw/App.swift"), "// changed\n");
    git(seed, "add", ".");
    git(seed, "commit", "-m", "mac change");
    git(seed, "push");
    const statePath = path.join(root, "maintenance-state.json");
    const commands = fakeCommands(mirror);

    expect(() =>
      maintainFixture(
        {
          checkout: mirror,
          remote: "origin",
          lockPath: path.join(root, "maintenance.lock"),
          statePath,
        },
        {
          runCommand(command: string, args: string[]) {
            commands.runCommand(command, args);
            if (command === "pnpm" && args.includes("status")) {
              throw new Error("Gateway failed");
            }
          },
        },
      ),
    ).toThrow("Gateway failed");
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({
      macPending: true,
      attempts: 0,
    });
  });

  test("refuses a symlinked maintenance state file without touching its target", () => {
    const { root, mirror } = makeFixture();
    const statePath = path.join(root, "maintenance-state.json");
    const victimPath = path.join(root, "victim.txt");
    writeFileSync(victimPath, "untouched\n");
    symlinkSync(victimPath, statePath);

    expect(() =>
      maintainFixture({
        checkout: mirror,
        remote: "origin",
        lockPath: path.join(root, "maintenance.lock"),
        statePath,
      }),
    ).toThrow(/maintenance state is unreadable/u);
    expect(readFileSync(victimPath, "utf8")).toBe("untouched\n");
  });

  test("skips an overlapping heartbeat while the owner process is alive", () => {
    const { root, mirror } = makeFixture();
    const lockPath = path.join(root, "maintenance.lock");
    const held = acquireMaintenanceLock(mirror, lockPath);
    try {
      const output = maintainFixture({ checkout: mirror, remote: "origin", lockPath });
      expect(output).toMatchObject({ ok: true, skipped: true, reason: "overlap" });
    } finally {
      held.release?.();
    }
  });

  test("atomically recovers a dead maintenance lock", () => {
    const { root, mirror } = makeFixture();
    const lockPath = path.join(root, "maintenance.lock");
    mkdirSync(lockPath);
    writeFileSync(
      path.join(lockPath, "owner.json"),
      `${JSON.stringify({ pid: 999_999_999, checkout: mirror, startedAt: "stale" })}\n`,
    );

    const held = acquireMaintenanceLock(mirror, lockPath);
    try {
      expect(held.acquired).toBe(true);
      expect(held.owner.pid).toBe(process.pid);
      expect(existsSync(`${lockPath}.stale-${process.pid}`)).toBe(false);
    } finally {
      held.release?.();
    }
  });

  test("treats an owner file creation race as a normal overlap", () => {
    const { root, mirror } = makeFixture();
    const lockPath = path.join(root, "maintenance.lock");
    mkdirSync(lockPath);
    const owner = { pid: process.pid, checkout: mirror, startedAt: "racing" };
    const writer = spawn(
      "sh",
      ["-c", 'sleep 0.03; printf "%s\\n" "$OWNER_JSON" > "$LOCK_PATH/owner.json"'],
      {
        env: { ...process.env, LOCK_PATH: lockPath, OWNER_JSON: JSON.stringify(owner) },
        stdio: "ignore",
      },
    );

    try {
      expect(acquireMaintenanceLock(mirror, lockPath)).toMatchObject({
        acquired: false,
        owner,
      });
    } finally {
      writer.kill();
    }
  });

  test("refuses dirty work without moving HEAD", () => {
    const { mirror } = makeFixture();
    const before = git(mirror, "rev-parse", "HEAD");
    writeFileSync(path.join(mirror, "local.txt"), "do not destroy\n");

    const result = spawnSync(process.execPath, [script, "--checkout", mirror], {
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout.trim())).toMatchObject({
      ok: false,
      error: { code: "dirty_checkout" },
    });
    expect(git(mirror, "rev-parse", "HEAD")).toBe(before);
    expect(git(mirror, "status", "--porcelain")).toContain("?? local.txt");
  });
});
