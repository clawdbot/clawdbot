// Verifies exec shell snapshots capture safe startup state without leaking secrets.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveStateDir } from "../config/paths.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { maybeWrapCommandWithShellSnapshot } from "./shell-snapshot.js";
import { getBashShellConfig, getShellConfig } from "./shell-utils.js";

const isWin = process.platform === "win32";
const EXEC_SHELL_SNAPSHOT_ENV = "OPENCLAW_EXEC_SHELL_SNAPSHOT";

function resolveShellSnapshotDirForTest(
  env: Record<string, string | undefined> = process.env,
): string {
  return path.join(resolveStateDir(env as NodeJS.ProcessEnv), "cache", "shell-snapshots");
}

function getPosixShellArgs(shellPath: string): string[] {
  return getShellConfig(shellPath).args;
}

function resolveBashForTest(): string | null {
  if (isWin) {
    return null;
  }
  return getBashShellConfig().shell;
}

function resolveZshForTest(): string | null {
  if (isWin) {
    return null;
  }
  if (fs.existsSync("/bin/zsh")) {
    return "/bin/zsh";
  }
  for (const entry of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(entry, "zsh");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Keep searching the test host PATH.
    }
  }
  return null;
}

function setSnapshotStateForTest(
  stateDir: string,
  options: { home?: string; zdotdir?: string } = {},
): void {
  // Snapshot tests mutate trusted process env, not per-command untrusted env.
  setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  if (options.home) {
    setTestEnvValue("HOME", options.home);
  }
  if (options.zdotdir) {
    process.env.ZDOTDIR = options.zdotdir;
  } else {
    delete process.env.ZDOTDIR;
  }
}

describe("exec shell snapshots", () => {
  const tempDirs: string[] = [];
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv([
      "HOME",
      "OPENCLAW_STATE_DIR",
      "OPENCLAW_EXEC_SHELL_SNAPSHOT",
      "PNPM_HOME",
      "ZDOTDIR",
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    envSnapshot.restore();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves commands unchanged for unsupported shells", async () => {
    const command = "echo unchanged";
    const wrapped = await maybeWrapCommandWithShellSnapshot({
      command,
      shell: "/bin/fish",
      shellArgs: ["-c"],
      cwd: os.tmpdir(),
      env: {},
    });

    expect(wrapped).toBe(command);
  });

  it("leaves commands unchanged when trusted process env disables snapshots", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-disabled-state-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-disabled-home-"));
    tempDirs.push(stateDir, home);
    setSnapshotStateForTest(stateDir, { home });
    setTestEnvValue(EXEC_SHELL_SNAPSHOT_ENV, "0");
    const command = "echo unchanged";
    const wrapped = await maybeWrapCommandWithShellSnapshot({
      command,
      shell: "/bin/bash",
      shellArgs: ["-c"],
      cwd: os.tmpdir(),
      env: {
        ...process.env,
      },
    });

    expect(wrapped).toBe(command);
    expect(fs.existsSync(resolveShellSnapshotDirForTest({ OPENCLAW_STATE_DIR: stateDir }))).toBe(
      false,
    );
  });

  it("does not honor per-call env for selecting the snapshot state dir", async () => {
    // Per-call env may be model/tool-controlled, so snapshot roots come from process env.
    const trustedStateDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "openclaw-snapshot-trusted-state-"),
    );
    const untrustedStateDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "openclaw-snapshot-untrusted-state-"),
    );
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-state-home-"));
    const untrustedHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "openclaw-snapshot-untrusted-home-"),
    );
    const sideEffectPath = path.join(untrustedHome, "side-effect");
    tempDirs.push(trustedStateDir, untrustedStateDir, home, untrustedHome);
    setSnapshotStateForTest(trustedStateDir, { home });
    fs.writeFileSync(
      path.join(untrustedHome, ".bashrc"),
      `touch ${JSON.stringify(sideEffectPath)}\n`,
    );
    const command = "echo unchanged";
    const wrapped = await maybeWrapCommandWithShellSnapshot({
      command,
      shell: "/bin/bash",
      shellArgs: ["-c"],
      cwd: os.tmpdir(),
      env: {
        ...process.env,
        HOME: untrustedHome,
        [EXEC_SHELL_SNAPSHOT_ENV]: "0",
        OPENCLAW_STATE_DIR: untrustedStateDir,
        SSH_CLIENT: "127.0.0.1 1000 22",
        SSH_CONNECTION: "127.0.0.1 1000 127.0.0.1 22",
      },
    });

    expect(wrapped).not.toBe(command);
    expect(
      fs.existsSync(resolveShellSnapshotDirForTest({ OPENCLAW_STATE_DIR: untrustedStateDir })),
    ).toBe(false);
    expect(
      fs.existsSync(resolveShellSnapshotDirForTest({ OPENCLAW_STATE_DIR: trustedStateDir })),
    ).toBe(true);
    expect(fs.existsSync(sideEffectPath)).toBe(false);
  });

  it("captures bash startup aliases, functions, and safe environment without secrets", async () => {
    const bash = resolveBashForTest();
    if (!bash) {
      return;
    }

    const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-home-"));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-state-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-cwd-"));
    tempDirs.push(home, stateDir, cwd);
    setSnapshotStateForTest(stateDir, { home });
    fs.writeFileSync(
      path.join(home, ".bashrc"),
      [
        "alias oc_snap_alias='printf alias-ok'",
        'alias oc_snap_secret="printf $OPENAI_API_KEY"',
        '[ "$OPENCLAW_SHELL" = exec ] && alias oc_snap_exec_alias="printf marker-ok"',
        "oc_snap_fn() { printf fn-ok; }",
        'export PATH="/snapshot/bin:$PATH"',
        'export OPENAI_API_KEY="snapshot-secret"',
        "",
      ].join("\n"),
    );

    const env = {
      ...process.env,
      HOME: home,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_SHELL: "exec",
      OPENAI_API_KEY: "inherited-secret",
    };
    const shellArgs = getPosixShellArgs(bash);
    const wrapped = await maybeWrapCommandWithShellSnapshot({
      command:
        "oc_snap_fn; printf ' '; oc_snap_alias; printf ' '; oc_snap_exec_alias; printf ' '; case \":$PATH:\" in *:/snapshot/bin:*) printf path-ok;; *) printf path-missing;; esac",
      shell: bash,
      shellArgs,
      cwd,
      env,
    });

    const result = spawnSync(bash, [...shellArgs, wrapped], {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("fn-ok alias-ok marker-ok path-ok");

    const snapshotFiles = fs
      .readdirSync(resolveShellSnapshotDirForTest(env))
      .filter((entry) => entry.endsWith(".sh"));
    expect(snapshotFiles).toHaveLength(1);
    const snapshot = fs.readFileSync(
      path.join(
        resolveShellSnapshotDirForTest(env),
        expectDefined(snapshotFiles[0], "snapshotFiles[0] test invariant"),
      ),
      "utf8",
    );
    expect(snapshot).toContain("oc_snap_fn");
    expect(snapshot).toContain("oc_snap_alias");
    expect(snapshot).not.toContain("snapshot-secret");
    expect(snapshot).not.toContain("inherited-secret");
    expect(snapshot).not.toContain("OPENAI_API_KEY");
  });

  it("captures bash aliases behind common interactive-only guards", async () => {
    const bash = resolveBashForTest();
    if (!bash) {
      return;
    }

    const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-interactive-home-"));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-interactive-state-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-interactive-cwd-"));
    tempDirs.push(home, stateDir, cwd);
    setSnapshotStateForTest(stateDir, { home });
    fs.writeFileSync(
      path.join(home, ".bashrc"),
      [
        "case $- in",
        "  *i*) ;;",
        "  *) return;;",
        "esac",
        "alias oc_interactive_alias='printf interactive-ok'",
        "",
      ].join("\n"),
    );

    const env = {
      ...process.env,
      HOME: home,
    };
    const shellArgs = getPosixShellArgs(bash);
    const wrapped = await maybeWrapCommandWithShellSnapshot({
      command: "oc_interactive_alias",
      shell: bash,
      shellArgs,
      cwd,
      env,
    });
    const result = spawnSync(bash, [...shellArgs, wrapped], {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("interactive-ok");
  });

  it("preserves per-call safe env overrides after trusted capture", async () => {
    const bash = resolveBashForTest();
    if (!bash) {
      return;
    }

    const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-env-home-"));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-env-state-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-env-cwd-"));
    tempDirs.push(home, stateDir, cwd);
    setSnapshotStateForTest(stateDir, { home });
    process.env.PNPM_HOME = "/trusted";
    fs.writeFileSync(path.join(home, ".bashrc"), 'export PNPM_HOME="${PNPM_HOME}/from-rc"\n');

    const shellArgs = getPosixShellArgs(bash);
    const runWithPnpmHome = async (pnpmHome: string): Promise<string> => {
      const env = {
        ...process.env,
        HOME: home,
        OPENCLAW_STATE_DIR: stateDir,
        PNPM_HOME: pnpmHome,
      };
      const wrapped = await maybeWrapCommandWithShellSnapshot({
        command: 'printf "%s" "$PNPM_HOME"',
        shell: bash,
        shellArgs,
        cwd,
        env,
      });
      const result = spawnSync(bash, [...shellArgs, wrapped], {
        cwd,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      expect(result.status).toBe(0);
      return result.stdout;
    };

    await expect(runWithPnpmHome("/first")).resolves.toBe("/first");
    await expect(runWithPnpmHome("/second")).resolves.toBe("/second");
  });

  it("preserves per-call env outside the snapshot allowlist", async () => {
    const bash = resolveBashForTest();
    if (!bash) {
      return;
    }

    const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-plugin-env-home-"));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-plugin-env-state-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-plugin-env-cwd-"));
    tempDirs.push(home, stateDir, cwd);
    setSnapshotStateForTest(stateDir, { home });
    fs.writeFileSync(path.join(home, ".bashrc"), "alias oc_snapshot_alias='printf alias-ok'\n");

    const env = {
      ...process.env,
      HOME: home,
      OPENCLAW_STATE_DIR: stateDir,
      PLUGIN_SAFE: "plugin-ok",
    };
    const shellArgs = getPosixShellArgs(bash);
    const wrapped = await maybeWrapCommandWithShellSnapshot({
      command: 'oc_snapshot_alias; printf ":%s" "$PLUGIN_SAFE"',
      shell: bash,
      shellArgs,
      cwd,
      env,
    });
    const result = spawnSync(bash, [...shellArgs, wrapped], {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("alias-ok:plugin-ok");
  });

  it("does not let non-fingerprinted env change captured shell state", async () => {
    const bash = resolveBashForTest();
    if (!bash) {
      return;
    }

    const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-branch-home-"));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-branch-state-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-branch-cwd-"));
    tempDirs.push(home, stateDir, cwd);
    setSnapshotStateForTest(stateDir, { home });
    fs.writeFileSync(
      path.join(home, ".bashrc"),
      [
        'if [ -n "$VIRTUAL_ENV" ]; then',
        "  alias oc_env_branch='printf virtual'",
        "else",
        "  alias oc_env_branch='printf plain'",
        "fi",
        "",
      ].join("\n"),
    );

    const env = {
      ...process.env,
      HOME: home,
      OPENCLAW_STATE_DIR: stateDir,
      VIRTUAL_ENV: "/tmp/venv",
    };
    const shellArgs = getPosixShellArgs(bash);
    const wrapped = await maybeWrapCommandWithShellSnapshot({
      command: "oc_env_branch",
      shell: bash,
      shellArgs,
      cwd,
      env,
    });
    const result = spawnSync(bash, [...shellArgs, wrapped], {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("plain");
    const snapshotFiles = fs
      .readdirSync(resolveShellSnapshotDirForTest(env))
      .filter((entry) => entry.endsWith(".sh"));
    expect(snapshotFiles).toHaveLength(1);
    const snapshot = fs.readFileSync(
      path.join(
        resolveShellSnapshotDirForTest(env),
        expectDefined(snapshotFiles[0], "snapshotFiles[0] test invariant"),
      ),
      "utf8",
    );
    expect(snapshot).not.toContain("virtual");
    expect(snapshot).not.toContain("VIRTUAL_ENV");
  });

  it("refreshes stale snapshot files when startup files source alias fragments", async () => {
    const bash = resolveBashForTest();
    if (!bash) {
      return;
    }

    const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-refresh-home-"));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-refresh-state-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-refresh-cwd-"));
    tempDirs.push(home, stateDir, cwd);
    setSnapshotStateForTest(stateDir, { home });
    const aliasPath = path.join(home, ".bash_aliases");
    fs.writeFileSync(path.join(home, ".bashrc"), `. ${JSON.stringify(aliasPath)}\n`);
    fs.writeFileSync(aliasPath, "alias oc_refresh_alias='printf old'\n");

    const env = {
      ...process.env,
      HOME: home,
    };
    const shellArgs = getPosixShellArgs(bash);
    const runAlias = async (): Promise<string> => {
      const wrapped = await maybeWrapCommandWithShellSnapshot({
        command: "oc_refresh_alias",
        shell: bash,
        shellArgs,
        cwd,
        env,
      });
      const result = spawnSync(bash, [...shellArgs, wrapped], {
        cwd,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      expect(result.status).toBe(0);
      return result.stdout;
    };

    await expect(runAlias()).resolves.toBe("old");
    fs.writeFileSync(aliasPath, "alias oc_refresh_alias='printf new'\n");
    const snapshotDir = resolveShellSnapshotDirForTest();
    const snapshotFiles = fs.readdirSync(snapshotDir).filter((entry) => entry.endsWith(".sh"));
    expect(snapshotFiles).toHaveLength(1);
    const staleTime = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(
      path.join(snapshotDir, expectDefined(snapshotFiles[0], "snapshotFiles[0] test invariant")),
      staleTime,
      staleTime,
    );
    const refreshAt = Date.now() + 6 * 60 * 1000;
    vi.spyOn(Date, "now").mockReturnValue(refreshAt);

    await expect(runAlias()).resolves.toBe("new");
  });

  it("refreshes fresh cached snapshots that no longer parse", async () => {
    const bash = resolveBashForTest();
    if (!bash) {
      return;
    }

    const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-corrupt-home-"));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-corrupt-state-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-corrupt-cwd-"));
    tempDirs.push(home, stateDir, cwd);
    setSnapshotStateForTest(stateDir, { home });
    fs.writeFileSync(path.join(home, ".bashrc"), "alias oc_clean_alias='printf ok'\n");

    const env = {
      ...process.env,
      HOME: home,
      OPENCLAW_STATE_DIR: stateDir,
    };
    const shellArgs = getPosixShellArgs(bash);
    const wrap = async (): Promise<string> =>
      await maybeWrapCommandWithShellSnapshot({
        command: "oc_clean_alias",
        shell: bash,
        shellArgs,
        cwd,
        env,
      });

    const firstWrapped = await wrap();
    expect(firstWrapped).not.toBe("oc_clean_alias");
    const snapshotDir = resolveShellSnapshotDirForTest(env);
    const snapshotFiles = fs.readdirSync(snapshotDir).filter((entry) => entry.endsWith(".sh"));
    expect(snapshotFiles).toHaveLength(1);
    const snapshotPath = path.join(
      snapshotDir,
      expectDefined(snapshotFiles[0], "snapshotFiles[0] test invariant"),
    );
    fs.writeFileSync(
      snapshotPath,
      [
        "# OpenClaw exec shell snapshot. Generated; do not edit.",
        "unalias -a 2>/dev/null || true",
        "oc_broken_fn() {",
        "        --!(no-*)dir*",
        "}",
        "",
      ].join("\n"),
    );
    const refreshAt = Date.now() + 6 * 60 * 1000;
    vi.spyOn(Date, "now").mockReturnValue(refreshAt);

    const wrapped = await wrap();
    const result = spawnSync(bash, [...shellArgs, wrapped], {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("ok");
    expect(result.stderr).toBe("");
    expect(fs.readFileSync(snapshotPath, "utf8")).not.toContain("--!(no-*)dir*");
  });

  it("refuses to persist aliases or functions with literal secret-looking values", async () => {
    const bash = resolveBashForTest();
    if (!bash) {
      return;
    }

    const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-secret-home-"));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-secret-state-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-secret-cwd-"));
    tempDirs.push(home, stateDir, cwd);
    setSnapshotStateForTest(stateDir, { home });
    fs.writeFileSync(
      path.join(home, ".bashrc"),
      [
        "alias oc_secret_alias='GITHUB_TOKEN=ghp_literal_secret gh'",
        "alias oc_aws_secret_alias='AWS_SECRET_ACCESS_KEY=literal-secret aws sts get-caller-identity'",
        "",
      ].join("\n"),
    );

    const env = {
      ...process.env,
      HOME: home,
      OPENCLAW_STATE_DIR: stateDir,
    };
    const command = "echo fallback";
    const wrapped = await maybeWrapCommandWithShellSnapshot({
      command,
      shell: bash,
      shellArgs: getPosixShellArgs(bash),
      cwd,
      env,
    });

    expect(wrapped).toBe(command);
    const snapshotDir = resolveShellSnapshotDirForTest(env);
    const files = fs.existsSync(snapshotDir)
      ? fs.readdirSync(snapshotDir).filter((entry) => entry.endsWith(".sh"))
      : [];
    expect(files).toHaveLength(0);
  });

  it("captures zsh aliases in sourceable form", async () => {
    const zsh = resolveZshForTest();
    if (!zsh) {
      return;
    }

    const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-zsh-home-"));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-zsh-state-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-zsh-cwd-"));
    tempDirs.push(home, stateDir, cwd);
    setSnapshotStateForTest(stateDir, { home });
    fs.writeFileSync(
      path.join(home, ".zshrc"),
      [
        "alias oc_snap_zsh_alias='printf zsh-alias-ok'",
        "oc_snap_zsh_fn() { printf zsh-fn-ok; }",
        "",
      ].join("\n"),
    );

    const env = {
      ...process.env,
      HOME: home,
      OPENCLAW_STATE_DIR: stateDir,
    };
    const shellArgs = getPosixShellArgs(zsh);
    const wrapped = await maybeWrapCommandWithShellSnapshot({
      command: "oc_snap_zsh_fn; printf ' '; oc_snap_zsh_alias",
      shell: zsh,
      shellArgs,
      cwd,
      env,
    });

    const result = spawnSync(zsh, [...shellArgs, wrapped], {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("zsh-fn-ok zsh-alias-ok");
  });

  it("captures zsh startup state from ZDOTDIR", async () => {
    const zsh = resolveZshForTest();
    if (!zsh) {
      return;
    }

    const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-zdot-home-"));
    const zdotdir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-zdot-dir-"));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-zdot-state-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-zdot-cwd-"));
    tempDirs.push(home, zdotdir, stateDir, cwd);
    setSnapshotStateForTest(stateDir, { home, zdotdir });
    fs.writeFileSync(path.join(home, ".zshrc"), "alias oc_snap_zdot_alias='printf wrong-home'\n");
    fs.writeFileSync(
      path.join(zdotdir, ".zshrc"),
      ["[[ -o interactive ]] || return", "alias oc_snap_zdot_alias='printf zdotdir-ok'", ""].join(
        "\n",
      ),
    );

    const env = {
      ...process.env,
      HOME: home,
      OPENCLAW_STATE_DIR: stateDir,
      ZDOTDIR: zdotdir,
    };
    const shellArgs = getPosixShellArgs(zsh);
    const wrapped = await maybeWrapCommandWithShellSnapshot({
      command: "oc_snap_zdot_alias",
      shell: zsh,
      shellArgs,
      cwd,
      env,
    });

    const result = spawnSync(zsh, [...shellArgs, wrapped], {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("zdotdir-ok");
  });
});
