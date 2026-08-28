// Install Cli tests cover install cli script behavior.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isSupportedOpenClawNodeVersion } from "../../node-version.mjs";
import { NODE_RELEASE_VERSION_CASES } from "../helpers/node-version-cases.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  writeNpmBeforePolicyFixture,
  writeNpmFreshnessConflictFixture,
  writeNpmInstallRetryFixture,
  writeNpmLifecycleFixture,
} from "./install-npm-fixtures.js";

const SCRIPT_PATH = "scripts/install-cli.sh";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function runInstallCliShell(script: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync("/bin/bash", ["-c", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      OPENCLAW_INSTALL_CLI_SH_NO_RUN: "1",
      ...env,
    },
  });
}

function linkRequiredShellTools(bin: string) {
  for (const tool of ["ln", "mkdir"]) {
    symlinkSync(`/bin/${tool}`, join(bin, tool));
  }
}

function linkNodeExecutable(nodeDir: string) {
  const bin = join(nodeDir, "bin");
  mkdirSync(bin, { recursive: true });
  symlinkSync(process.execPath, join(bin, "node"));
}

function writeInstalledOpenClawEntry(nodeDir: string) {
  linkNodeExecutable(nodeDir);
  const entry = join(nodeDir, "lib", "node_modules", "openclaw", "dist", "entry.js");
  mkdirSync(join(entry, ".."), { recursive: true });
  writeFileSync(entry, "");
}

describe("install-cli.sh", () => {
  const script = readFileSync(SCRIPT_PATH, "utf8");

  it("fails a low-space fresh Git install before Node or checkout work", () => {
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-cli-disk-low-"));
    const commandLog = join(tmp, "commands.log");
    const repo = join(tmp, "new", "openclaw");

    try {
      const result = runInstallCliShell(
        [
          "set -euo pipefail",
          `cd ${JSON.stringify(process.cwd())}`,
          `source ${JSON.stringify(SCRIPT_PATH)}`,
          "available_disk_kib() { printf '2097152\\n'; }",
          `install_node() { printf 'node\\n' >> ${JSON.stringify(commandLog)}; }`,
          `install_openclaw_from_git() { printf 'git\\n' >> ${JSON.stringify(commandLog)}; }`,
          `main --json --git --git-dir ${JSON.stringify(repo)}`,
        ].join("\n"),
      );

      expect(result.status).toBe(1);
      expect(existsSync(commandLog)).toBe(false);
      const events = result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { event: string; name?: string; message?: string });
      expect(events).toEqual([
        { event: "step", name: "disk-space", status: "start" },
        {
          event: "error",
          message:
            "Fresh Git installs require at least 6 GiB of free disk space; only 2.0 GiB is available. Free disk space and retry.",
        },
      ]);
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }
  });

  it("allows a fresh Git install with enough free space", () => {
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-cli-disk-ok-"));
    const repo = join(tmp, "new", "openclaw");

    try {
      const result = runInstallCliShell(
        [
          "set -euo pipefail",
          `cd ${JSON.stringify(process.cwd())}`,
          `source ${JSON.stringify(SCRIPT_PATH)}`,
          "JSON=1",
          "available_disk_kib() { printf '7340032\\n'; }",
          `preflight_fresh_git_disk_space ${JSON.stringify(repo)}`,
          "printf 'continued\\n'",
        ].join("\n"),
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('{"event":"step","name":"disk-space","status":"start"}');
      expect(result.stdout).toContain('{"event":"step","name":"disk-space","status":"ok"}');
      expect(result.stdout).toContain("continued");
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }
  });

  it("does not apply the fresh-install disk threshold to an existing checkout", () => {
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-cli-disk-existing-"));
    const repo = join(tmp, "openclaw");
    mkdirSync(join(repo, ".git"), { recursive: true });

    try {
      const result = runInstallCliShell(
        [
          "set -euo pipefail",
          `cd ${JSON.stringify(process.cwd())}`,
          `source ${JSON.stringify(SCRIPT_PATH)}`,
          "JSON=1",
          "available_disk_kib() { printf 'disk check should not run\\n' >&2; return 99; }",
          `preflight_fresh_git_disk_space ${JSON.stringify(repo)}`,
        ].join("\n"),
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }
  });

  it("emits ordered stages for an existing Git checkout build", () => {
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-cli-events-"));
    const repo = join(tmp, "openclaw");
    mkdirSync(join(repo, ".git"), { recursive: true });

    try {
      const result = runInstallCliShell(
        [
          "set -euo pipefail",
          `cd ${JSON.stringify(process.cwd())}`,
          `source ${JSON.stringify(SCRIPT_PATH)}`,
          "JSON=1",
          `PREFIX=${JSON.stringify(join(tmp, "prefix"))}`,
          "ensure_git() { :; }",
          "ensure_pnpm() { :; }",
          "ensure_pnpm_binary_for_scripts() { :; }",
          "ensure_pnpm_git_prepare_allowlist() { :; }",
          "activate_repo_pnpm_version() { :; }",
          "cleanup_legacy_submodules() { :; }",
          "resolve_git_openclaw_ref() { printf 'main\\n'; }",
          "checkout_git_openclaw_ref() { :; }",
          "run_pnpm() { :; }",
          "git() {",
          '  if [[ "$1" == --git-dir=* ]]; then return 0; fi',
          '  if [[ "$1" == "-C" && "$3" == "status" ]]; then return 0; fi',
          "  return 0",
          "}",
          `install_openclaw_from_git ${JSON.stringify(repo)}`,
        ].join("\n"),
      );

      expect(result.status).toBe(0);
      const stages = result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { event: string; name?: string; status?: string })
        .filter((event) => event.event === "step")
        .map((event) => `${event.name}:${event.status}`);
      expect(stages).toEqual([
        "openclaw:start",
        "git-tools:start",
        "git-tools:ok",
        "git-update:start",
        "git-update:ok",
        "dependencies:start",
        "dependencies:ok",
        "control-ui:start",
        "control-ui:ok",
        "cli-build:start",
        "cli-build:ok",
        "openclaw:ok",
      ]);
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }
  });

  it("round-trips dynamic installer values through independent NDJSON records", () => {
    const root = tempDirs.make("openclaw-install-cli-json-events-");
    const dynamicValue = `quote"\\café项目lobster🦞${String.fromCharCode(
      ...Array.from({ length: 31 }, (_, index) => index + 1),
    )}end`;
    const repo = join(root, dynamicValue);
    const legacyDir = join(repo, "Peekaboo");
    const fakeNode = join(root, "node");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(fakeNode, '#!/bin/bash\nprintf "%s" "$EVENT_VALUE"\n');
    chmodSync(fakeNode, 0o755);

    const success = runInstallCliShell(
      [
        "set -euo pipefail",
        `cd ${JSON.stringify(process.cwd())}`,
        `source ${JSON.stringify(SCRIPT_PATH)}`,
        "JSON=1",
        'cleanup_legacy_submodules "$REPO"',
        "try_link_usable_node_runtime_from_path() { return 0; }",
        `node_bin() { printf '%s\\n' ${JSON.stringify(fakeNode)}; }`,
        "install_alpine_node",
        'emit_json done version "$EVENT_VALUE"',
      ].join("\n"),
      { EVENT_VALUE: dynamicValue, REPO: repo },
    );

    expect(success.status, success.stderr || success.stdout).toBe(0);
    expect(existsSync(legacyDir)).toBe(false);
    const successLines = success.stdout.trimEnd().split("\n");
    expect(successLines).toHaveLength(5);
    const successEvents = successLines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(successEvents).toEqual([
      { event: "step", name: "legacy-submodule", status: "start", path: legacyDir },
      { event: "step", name: "legacy-submodule", status: "ok", path: legacyDir },
      { event: "step", name: "node", status: "start", method: "apk" },
      { event: "step", name: "node", status: "ok", method: "system", version: dynamicValue },
      { event: "done", ok: true, version: dynamicValue },
    ]);

    const failure = runInstallCliShell(
      [
        "set -euo pipefail",
        `cd ${JSON.stringify(process.cwd())}`,
        `source ${JSON.stringify(SCRIPT_PATH)}`,
        "JSON=1",
        'fail "$EVENT_VALUE"',
      ].join("\n"),
      { EVENT_VALUE: dynamicValue },
    );

    expect(failure.status).toBe(1);
    expect(failure.stdout.trimEnd().split("\n")).toHaveLength(1);
    expect(JSON.parse(failure.stdout)).toEqual({ event: "error", message: dynamicValue });
  });

  it("rejects a git checkout without a commit before updating it", () => {
    const result = runInstallCliShell(`
      set -euo pipefail
      source "${SCRIPT_PATH}"
      tmp="$(mktemp -d)"
      repo="$tmp/repo"
      mkdir -p "$repo/.git"
      ensure_git() { :; }
      ensure_pnpm() { :; }
      ensure_pnpm_binary_for_scripts() { :; }
      git() {
        [[ "$1" == "--git-dir=$repo/.git" ]] &&
          [[ "$2" == "--work-tree=$repo" ]] &&
          [[ "$3" == "rev-parse" ]] &&
          [[ "$4" == "--verify" ]] &&
          [[ "$5" == "--quiet" ]] &&
          [[ "$6" == "HEAD^{commit}" ]] &&
          return 1
        return 99
      }

      set +e
      (install_openclaw_from_git "$repo")
      status="$?"
      set -e
      [[ "$status" -eq 1 ]]
      [[ -d "$repo/.git" ]]
    `);

    expect(result.status).toBe(0);
  });

  it("keeps a pre-existing empty Git install destination retryable after clone failure", () => {
    const root = tempDirs.make("openclaw-install-cli-empty-retry-");
    const repo = join(root, "openclaw");
    mkdirSync(repo);
    const runAttempt = (cloneMode: "failure" | "success") =>
      runInstallCliShell(
        `
        set -euo pipefail
        source "${SCRIPT_PATH}"
        ensure_git() { :; }
        ensure_pnpm() { :; }
        ensure_pnpm_binary_for_scripts() { :; }
        resolve_git_openclaw_ref() { printf 'main\\n'; }
        checkout_git_openclaw_ref() { :; }
        cleanup_legacy_submodules() { :; }
        ensure_pnpm_git_prepare_allowlist() { :; }
        activate_repo_pnpm_version() { :; }
        git_install_lockfile_flag() { printf '%s\\n' '--frozen-lockfile'; }
        run_pnpm() { :; }
        git() {
          if [[ "$1" == "clone" ]]; then
            target="\${*: -1}"
            mkdir -p "$target/.git"
            if [[ "$CLONE_MODE" == "failure" ]]; then
              return 42
            fi
            printf 'complete\\n' > "$target/checkout.marker"
          fi
          return 0
        }
        install_openclaw_from_git "$REPO"
      `,
        { CLONE_MODE: cloneMode, REPO: repo },
      );

    const failed = runAttempt("failure");
    expect(failed.status, failed.stderr || failed.stdout).toBe(42);
    expect(existsSync(repo)).toBe(true);
    expect(readdirSync(repo)).toEqual([]);

    const succeeded = runAttempt("success");
    expect(succeeded.status, succeeded.stderr || succeeded.stdout).toBe(0);
    expect(readFileSync(join(repo, "checkout.marker"), "utf8")).toBe("complete\n");
  });

  it("publishes fresh Git clones only after success and cleans failed staging directories", () => {
    const root = tempDirs.make("openclaw-install-cli-transactional-clone-");
    const result = runInstallCliShell(
      `
      set -euo pipefail
      source "${SCRIPT_PATH}"
      root="$ROOT"
      git() {
        local target="\${*: -1}"
        mkdir -p "$target/.git"
        printf 'complete\\n' > "$target/checkout.marker"
        if [[ "$CLONE_MODE" == "failure" ]]; then
          return 42
        fi
        if [[ "$CLONE_MODE" == "concurrent" ]]; then
          mkdir -p "$CONCURRENT_REPO"
          printf 'keep\\n' > "$CONCURRENT_REPO/user.marker"
        fi
        if [[ "$CLONE_MODE" == "retarget-alias" ]]; then
          [[ "$(dirname "$target")" == "$ALIAS_TARGET" ]]
          rm "$ALIAS_PATH"
          ln -s "$ALIAS_REPLACEMENT" "$ALIAS_PATH"
        fi
      }

      CLONE_MODE=success
      success_repo="$root/success"
      clone_git_checkout_transactionally https://example.invalid/openclaw.git "$success_repo"
      [[ -f "$success_repo/checkout.marker" ]]

      CLONE_MODE=failure
      failed_repo="$root/failure"
      set +e
      clone_git_checkout_transactionally https://example.invalid/openclaw.git "$failed_repo"
      failure_status="$?"
      set -e
      [[ "$failure_status" -eq 42 ]]
      [[ ! -e "$failed_repo" ]]

      CLONE_MODE=retarget-alias
      ALIAS_TARGET="$root/alias-target"
      ALIAS_REPLACEMENT="$root/alias-replacement"
      ALIAS_PATH="$root/alias"
      mkdir -p "$ALIAS_TARGET" "$ALIAS_REPLACEMENT"
      ln -s "$ALIAS_TARGET" "$ALIAS_PATH"
      clone_git_checkout_transactionally https://example.invalid/openclaw.git "$ALIAS_PATH"
      [[ -f "$ALIAS_TARGET/checkout.marker" ]]
      [[ -z "$(ls -A "$ALIAS_REPLACEMENT")" ]]
      [[ -z "$(find "$ALIAS_TARGET" -maxdepth 1 -name '.openclaw-clone.*' -print -quit)" ]]

      CLONE_MODE=concurrent
      CONCURRENT_REPO="$root/concurrent"
      clone_git_checkout_transactionally https://example.invalid/openclaw.git "$CONCURRENT_REPO"
    `,
      { ROOT: root },
    );

    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain("Git install dir appeared while cloning");
    expect(readFileSync(join(root, "concurrent", "user.marker"), "utf8")).toBe("keep\n");
    expect(existsSync(join(root, "concurrent", "checkout.marker"))).toBe(false);
    expect(readdirSync(root).filter((entry) => entry.startsWith(".openclaw-clone."))).toEqual([]);
  });

  it("keeps the full Git install on the canonical checkout after an alias is retargeted", () => {
    const root = tempDirs.make("openclaw-install-cli-retargeted-alias-");
    const result = runInstallCliShell(
      `
      set -euo pipefail
      source "${SCRIPT_PATH}"
      target="$ROOT/target"
      replacement="$ROOT/replacement"
      alias_path="$ROOT/alias"
      mkdir -p "$target" "$replacement"
      ln -s "$target" "$alias_path"
      PREFIX="$ROOT/prefix"

      ensure_git() { :; }
      ensure_pnpm() { :; }
      ensure_pnpm_binary_for_scripts() { :; }
      resolve_git_openclaw_ref() { printf 'main\\n'; }
      checkout_git_openclaw_ref() { [[ "$1" == "$target" && "$2" == "main" ]]; }
      cleanup_legacy_submodules() { [[ "$1" == "$target" ]]; }
      ensure_pnpm_git_prepare_allowlist() { [[ "$1" == "$target" ]]; }
      activate_repo_pnpm_version() { [[ "$1" == "$target" ]]; }
      git_install_lockfile_flag() {
        [[ "$1" == "$target" ]]
        printf '%s\\n' '--frozen-lockfile'
      }
      run_pnpm() { [[ "$1" == "-C" && "$2" == "$target" ]]; }
      git() {
        if [[ "$1" == "clone" ]]; then
          local clone_target="\${*: -1}"
          mkdir -p "$clone_target/.git"
          printf 'complete\\n' > "$clone_target/checkout.marker"
          rm "$alias_path"
          ln -s "$replacement" "$alias_path"
          return 0
        fi
        [[ "$1" == "-C" && "$2" == "$target" ]]
      }

      install_openclaw_from_git "$alias_path"
      grep -F "$target/dist/entry.js" "$PREFIX/bin/openclaw"
      [[ -z "$(ls -A "$replacement")" ]]
      [[ -z "$(find "$target" -maxdepth 1 -name '.openclaw-clone.*' -print -quit)" ]]
    `,
      { ROOT: root },
    );

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it("bounds stalled curl downloads and propagates timeout failures", () => {
    const result = runInstallCliShell(`
      set -euo pipefail
      source "${SCRIPT_PATH}"
      curl() {
        printf 'curl=%s\n' "$*"
        return 28
      }
      DOWNLOADER=curl
      set +e
      download_file "https://example.invalid/node.tar.gz" "/tmp/node.tar.gz"
      printf 'status=%s\n' "$?"
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--speed-limit 1 --speed-time 30");
    expect(result.stdout).not.toContain("--connect-timeout");
    expect(result.stdout).toContain("--retry 3 --retry-delay 1 --retry-connrefused");
    expect(result.stdout).toContain("status=28");
  });

  it("does not clean an unrelated legacy checkout during the default npm install", () => {
    const main = script.slice(script.indexOf("\nmain() {"));
    expect(main).not.toContain("cleanup_legacy_submodules");
    expect(script).toContain('cleanup_legacy_submodules "$repo_dir"');
  });

  it("matches the canonical release-label contract for installed Node runtimes", () => {
    expect(script).toContain("SELECT sqlite_version() AS version");
    const result = runInstallCliShell(
      [
        "set -euo pipefail",
        `source ${JSON.stringify(SCRIPT_PATH)}`,
        "set +e",
        ...NODE_RELEASE_VERSION_CASES.flatMap((version, index) => [
          `node_release_version_is_supported ${JSON.stringify(version)}`,
          `printf '${index}=%s\\n' "$?"`,
        ]),
      ].join("\n"),
    );

    expect(result.status).toBe(0);
    for (const [index, version] of NODE_RELEASE_VERSION_CASES.entries()) {
      const expectedStatus = isSupportedOpenClawNodeVersion(version) ? 0 : 1;
      expect(result.stdout, version).toContain(`${index}=${expectedStatus}`);
    }
  });

  it("reuses the minimum supported runtime unless a newer version was explicitly requested", () => {
    const result = runInstallCliShell(`
      set -euo pipefail
      source "${SCRIPT_PATH}"
      NODE_VERSION=24.15.0
      NODE_VERSION_REQUESTED=0
      printf 'default=%s\n' "$(required_node_version)"
      NODE_VERSION_REQUESTED=1
      printf 'requested=%s\n' "$(required_node_version)"
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("default=22.22.3");
    expect(result.stdout).toContain("requested=24.15.0");
  });

  it("uses the patched Node 22 line for Linux ARMv7 by default", () => {
    const result = runInstallCliShell(`
      set -euo pipefail
      source "${SCRIPT_PATH}"
      NODE_VERSION=24.15.0
      NODE_VERSION_REQUESTED=0
      select_node_version_for_platform linux armv7l
      printf 'selected=%s\n' "$NODE_VERSION"
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("selected=22.23.2");
    expect(script).toContain('armv7|armv7l) echo "armv7l"');
  });

  it("selects the ARMv7 runtime before constructing PATH", () => {
    const result = runInstallCliShell(`
      set -euo pipefail
      source "${SCRIPT_PATH}"
      os_detect() { printf 'linux\n'; }
      arch_detect() { printf 'armv7l\n'; }
      install_node() {
        printf 'selected=%s\n' "$NODE_VERSION"
        printf 'first-path=%s\n' "\${PATH%%:*}"
        return 17
      }
      main
    `);

    expect(result.status).toBe(17);
    expect(result.stdout).toContain("selected=22.23.2");
    expect(result.stdout).toContain("first-path=");
    expect(result.stdout).toContain("/tools/node-v22.23.2/bin");
    expect(result.stdout).not.toContain("/tools/node-v24.19.0/bin");
  });

  it("fails early for unavailable Node 24 Linux ARMv7 downloads", () => {
    const result = runInstallCliShell(`
      set -euo pipefail
      source "${SCRIPT_PATH}"
      NODE_VERSION=24.15.0
      NODE_VERSION_REQUESTED=1
      select_node_version_for_platform linux armv7l
    `);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "Linux ARMv7 requires Node 22.22.3+ because official Node 24+ binaries are unavailable",
    );
  });

  it("rejects an explicitly requested vulnerable Node release", () => {
    const result = runInstallCliShell(`
      set -euo pipefail
      source "${SCRIPT_PATH}"
      NODE_VERSION=24.14.1
      install_node
    `);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "Node 24.14.1 is unsupported; use Node 22.22.3+, Node 24.15.0+, or Node 25.9.0+.",
    );
    expect(result.stdout).not.toContain("Installing Node 24.14.1");
  });

  it("rejects installer options with missing values", () => {
    const result = runInstallCliShell(`
      set -euo pipefail
      source "${SCRIPT_PATH}"
      parse_args --prefix --no-onboard
    `);

    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain("Missing value for --prefix");
    expect(result.stdout + result.stderr).not.toContain("unbound variable");
  });

  it("matches the Gateway future-config compatibility rule", () => {
    const result = runInstallCliShell(`
      set -euo pipefail
      source "${SCRIPT_PATH}"
      node_bin() { command -v node; }
      set +e
      for pair in \
        2026.7.1-2:2026.7.2 \
        2026.7.2-beta.6:2026.7.2-beta.7 \
        2026.7.2:2026.7.2-beta.7 \
        2026.7.2-beta.7:2026.7.2 \
        2026.7.2-1:2026.7.2-2 \
        2026.7.3-beta.1:2026.7.2; do
        candidate="\${pair%%:*}"
        writer="\${pair#*:}"
        openclaw_version_is_compatible_with "$candidate" "$writer"
        printf '%s=%s\\n' "$pair" "$?"
      done
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("2026.7.1-2:2026.7.2=1");
    expect(result.stdout).toContain("2026.7.2-beta.6:2026.7.2-beta.7=1");
    expect(result.stdout).toContain("2026.7.2:2026.7.2-beta.7=0");
    expect(result.stdout).toContain("2026.7.2-beta.7:2026.7.2=0");
    expect(result.stdout).toContain("2026.7.2-1:2026.7.2-2=0");
    expect(result.stdout).toContain("2026.7.3-beta.1:2026.7.2=0");
  });

  it("rejects an incompatible channel before replacing an existing managed CLI", () => {
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-cli-compatible-"));
    const prefix = join(tmp, "prefix");
    const bin = join(prefix, "bin");
    const openclaw = join(bin, "openclaw");
    mkdirSync(bin, { recursive: true });
    writeFileSync(openclaw, "existing-managed-cli\n");

    try {
      const result = runInstallCliShell(`
        set -euo pipefail
        source "${SCRIPT_PATH}"
        PREFIX=${JSON.stringify(prefix)}
        OPENCLAW_VERSION=latest
        REQUIRED_COMPATIBLE_VERSION=2026.7.2
        node_bin() { command -v node; }
        npm_bin() { printf 'npm\\n'; }
        npm_config_has_raw_key() { return 1; }
        npm() {
          if [[ "$1" == "view" ]]; then printf '2026.7.1-2\\n'; return 0; fi
          if [[ "$1" == "config" ]]; then printf 'null\\n'; return 0; fi
          printf 'unexpected mutation: %s\\n' "$*" >&2
          return 99
        }
        install_openclaw
      `);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("OpenClaw 2026.7.1-2 is older than config writer 2026.7.2");
      expect(result.stderr).not.toContain("unexpected mutation");
      expect(readFileSync(openclaw, "utf8")).toBe("existing-managed-cli\n");
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }
  });

  it("checks a git checkout version before dependency install or wrapper replacement", () => {
    const checkoutIndex = script.indexOf('checkout_git_openclaw_ref "$repo_dir" "$git_ref"');
    const compatibilityIndex = script.indexOf(
      'require_openclaw_version_compatible "$resolved_version"',
    );
    const dependencyInstallIndex = script.indexOf(
      'CI="${CI:-true}" run_pnpm -C "$repo_dir" install "${pnpm_prefer_offline_args[@]}" "$install_lockfile_flag"',
    );
    const wrapperIndex = script.indexOf(
      'publish_executable_wrapper "${PREFIX}/bin/openclaw"',
      compatibilityIndex,
    );

    expect(checkoutIndex).toBeGreaterThan(-1);
    expect(compatibilityIndex).toBeGreaterThan(checkoutIndex);
    expect(dependencyInstallIndex).toBeGreaterThan(compatibilityIndex);
    expect(wrapperIndex).toBeGreaterThan(compatibilityIndex);
  });

  it("does not restart a gateway again after force-install activates it", () => {
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-cli-gateway-refresh-"));
    const prefix = join(tmp, "prefix");
    const bin = join(prefix, "bin");
    const commandLog = join(tmp, "commands.log");
    const openclaw = join(bin, "openclaw");
    mkdirSync(bin, { recursive: true });
    writeFileSync(openclaw, '#!/bin/bash\nprintf "%s\\n" "$*" >> "$COMMAND_LOG"\n');
    chmodSync(openclaw, 0o755);

    try {
      const result = runInstallCliShell(
        [
          "set -euo pipefail",
          `cd ${JSON.stringify(process.cwd())}`,
          `source ${JSON.stringify(SCRIPT_PATH)}`,
          `PREFIX=${JSON.stringify(prefix)}`,
          "is_gateway_daemon_loaded() { return 0; }",
          "refresh_gateway_service_if_loaded",
        ].join("\n"),
        { COMMAND_LOG: commandLog },
      );

      expect(result.status).toBe(0);
      expect(readFileSync(commandLog, "utf8").trim().split("\n")).toEqual([
        "gateway install --force",
        "gateway status --probe --json",
      ]);
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }
  });

  it.each([
    { args: "--json", mode: "JSON" },
    { args: "", mode: "human" },
  ])(
    "rejects a package without a runnable CLI in $mode mode before service refresh",
    ({ args }) => {
      const tmp = tempDirs.make("openclaw-install-cli-invalid-package-");
      const prefix = join(tmp, "prefix");
      const refreshLog = join(tmp, "gateway-refresh.log");

      const result = runInstallCliShell(
        [
          "set -euo pipefail",
          `cd ${JSON.stringify(process.cwd())}`,
          `source ${JSON.stringify(SCRIPT_PATH)}`,
          "npm_lifecycle_allow_arg() { :; }",
          'install_node() { mkdir -p "$(node_dir)/lib/node_modules/openclaw/dist"; : > "$(node_dir)/lib/node_modules/openclaw/dist/entry.js"; }',
          "ensure_git() { :; }",
          'npm_bin() { printf "/usr/bin/true\\n"; }',
          `refresh_gateway_service_if_loaded() { touch ${JSON.stringify(refreshLog)}; }`,
          `main ${args} --prefix ${JSON.stringify(prefix)} --version 0.0.0`,
        ].join("\n"),
      );

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("Installed OpenClaw CLI did not return a version");
      expect(result.stdout).not.toContain('"event":"done"');
      expect(result.stdout).not.toContain("OpenClaw installed.");
      expect(existsSync(refreshLog)).toBe(false);
    },
  );

  it.each([
    { args: "--json", mode: "JSON" },
    { args: "", mode: "human" },
  ])(
    "rejects a version command that prints output and fails in $mode mode before service refresh",
    ({ args }) => {
      const tmp = tempDirs.make("openclaw-install-cli-failed-version-");
      const prefix = join(tmp, "prefix");
      const bin = join(prefix, "bin");
      const openclaw = join(bin, "openclaw");
      const refreshLog = join(tmp, "gateway-refresh.log");
      mkdirSync(bin, { recursive: true });
      writeFileSync(openclaw, '#!/bin/bash\nprintf "OpenClaw 2026.8.1\\n"\nexit 1\n');
      chmodSync(openclaw, 0o755);

      const result = runInstallCliShell(
        [
          "set -euo pipefail",
          `cd ${JSON.stringify(process.cwd())}`,
          `source ${JSON.stringify(SCRIPT_PATH)}`,
          "install_node() { :; }",
          "ensure_git() { :; }",
          "install_openclaw() { :; }",
          `refresh_gateway_service_if_loaded() { touch ${JSON.stringify(refreshLog)}; }`,
          `main ${args} --prefix ${JSON.stringify(prefix)} --version 0.0.0`,
        ].join("\n"),
      );

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("Installed OpenClaw CLI did not return a version");
      expect(result.stdout).not.toContain('"event":"done"');
      expect(result.stdout).not.toContain("OpenClaw installed.");
      expect(existsSync(refreshLog)).toBe(false);
    },
  );

  it("keeps HOME for default prefix while OPENCLAW_HOME controls git checkout paths", () => {
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-cli-home-"));
    const osHome = join(tmp, "os-home");
    const openclawHome = join(tmp, "openclaw-home");
    mkdirSync(osHome, { recursive: true });
    mkdirSync(openclawHome, { recursive: true });

    let result: ReturnType<typeof runInstallCliShell> | undefined;
    try {
      result = runInstallCliShell(
        [
          `cd ${JSON.stringify(process.cwd())}`,
          `source ${JSON.stringify(SCRIPT_PATH)}`,
          'printf "prefix=%s\\ngit=%s\\n" "$PREFIX" "$GIT_DIR"',
        ].join("\n"),
        {
          HOME: osHome,
          OPENCLAW_HOME: openclawHome,
          OPENCLAW_GIT_DIR: undefined,
          OPENCLAW_PREFIX: undefined,
        },
      );
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }

    expect(result?.status).toBe(0);
    const output = result?.stdout ?? "";
    expect(output).toContain(`prefix=${join(osHome, ".openclaw")}`);
    expect(output).toContain(`git=${join(openclawHome, "openclaw")}`);
  });

  it.each([
    { input: "arguments", method: "npm" },
    { input: "environment", method: "npm" },
    { input: "literal tilde", method: "npm" },
    { input: "arguments", method: "git" },
    { input: "environment", method: "git" },
    { input: "literal tilde", method: "git" },
  ] as const)(
    "keeps a generated $method launcher working after $input supplied paths change cwd",
    ({ input, method }) => {
      const tmp = mkdtempSync(join(tmpdir(), `openclaw-install-cli-relative-${method}-`));
      const installRoot = join(tmp, "install-root");
      const otherRoot = join(tmp, "other-root");
      const home = join(tmp, "home");
      const prefixInput = input === "literal tilde" ? "~/openclaw-local" : "openclaw-local";
      const prefix = join(input === "literal tilde" ? home : installRoot, "openclaw-local");
      const nodeDir = join(prefix, "tools", "node-v24.19.0");
      const repoInput = input === "literal tilde" ? "~/openclaw-source" : "openclaw-source";
      const repo = join(input === "literal tilde" ? home : installRoot, "openclaw-source");
      mkdirSync(installRoot, { recursive: true });
      mkdirSync(join(nodeDir, "bin"), { recursive: true });
      mkdirSync(join(nodeDir, "lib", "node_modules", "openclaw", "dist"), { recursive: true });
      mkdirSync(join(repo, ".git"), { recursive: true });
      mkdirSync(join(repo, "dist"), { recursive: true });
      mkdirSync(otherRoot, { recursive: true });
      symlinkSync(process.execPath, join(nodeDir, "bin", "node"));
      symlinkSync("node-v24.19.0", join(prefix, "tools", "node"));
      writeFileSync(
        join(nodeDir, "bin", "npm"),
        '#!/bin/bash\nif [[ "$1" == "--version" ]]; then printf "11.15.0\\n"; elif [[ "$1" == "config" ]]; then printf "null\\n"; fi\n',
      );
      chmodSync(join(nodeDir, "bin", "npm"), 0o755);
      for (const entry of [
        join(nodeDir, "lib", "node_modules", "openclaw", "dist", "entry.js"),
        join(repo, "dist", "entry.js"),
      ]) {
        writeFileSync(entry, 'console.log("fixture cli");\n');
      }

      try {
        const args =
          input !== "environment"
            ? `--prefix ${JSON.stringify(prefixInput)}${
                method === "git" ? ` --git-dir ${JSON.stringify(repoInput)}` : ""
              }`
            : "";
        const result = runInstallCliShell(
          [
            "set -euo pipefail",
            `cd ${JSON.stringify(installRoot)}`,
            `source ${JSON.stringify(join(process.cwd(), SCRIPT_PATH))}`,
            "install_node() { :; }",
            "ensure_git() { :; }",
            "refresh_gateway_service_if_loaded() { :; }",
            ...(method === "git"
              ? [
                  "preflight_fresh_git_disk_space() { :; }",
                  "ensure_pnpm() { :; }",
                  "ensure_pnpm_binary_for_scripts() { :; }",
                  "ensure_pnpm_git_prepare_allowlist() { :; }",
                  "activate_repo_pnpm_version() { :; }",
                  "cleanup_legacy_submodules() { :; }",
                  "resolve_git_openclaw_ref() { printf 'main\\n'; }",
                  "checkout_git_openclaw_ref() { :; }",
                  "git_install_lockfile_flag() { printf '%s\\n' '--no-frozen-lockfile'; }",
                  "run_pnpm() { :; }",
                  "git() { return 0; }",
                ]
              : []),
            `main --${method} ${args}`,
            `cd ${JSON.stringify(otherRoot)}`,
            `${JSON.stringify(join(prefix, "bin", "openclaw"))} --version`,
          ].join("\n"),
          {
            HOME: home,
            OPENCLAW_GIT_DIR: input === "environment" && method === "git" ? repoInput : undefined,
            OPENCLAW_PREFIX: input === "environment" ? prefixInput : undefined,
          },
        );

        expect(result.status, result.stderr || result.stdout).toBe(0);
        expect(result.stdout.trim().split("\n").at(-1)).toBe("fixture cli");
      } finally {
        rmSync(tmp, { force: true, recursive: true });
      }
    },
  );

  it("resolves requested git install versions to checkout refs", () => {
    const result = runInstallCliShell(`
      set -euo pipefail
      source "${SCRIPT_PATH}"
      npm_bin() { echo npm; }
      npm() {
        if [[ "$1" == "view" && "$2" == "openclaw" && "$3" == "dist-tags.beta" ]]; then
          printf '2026.5.12-beta.3\\n'
          return 0
        fi
        return 1
      }
      OPENCLAW_VERSION=v2026.5.12-beta.3
      printf 'tag=%s\\n' "$(resolve_git_openclaw_ref)"
      OPENCLAW_VERSION=2026.5.12-beta.3
      printf 'semver=%s\\n' "$(resolve_git_openclaw_ref)"
      OPENCLAW_VERSION=beta
      printf 'beta=%s\\n' "$(resolve_git_openclaw_ref)"
      OPENCLAW_VERSION=main
      printf 'main=%s\\n' "$(resolve_git_openclaw_ref)"
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("tag=v2026.5.12-beta.3");
    expect(result.stdout).toContain("semver=v2026.5.12-beta.3");
    expect(result.stdout).toContain("beta=v2026.5.12-beta.3");
    expect(result.stdout).toContain("main=main");
  });

  it("fetches moving git refs without tags for git installs", () => {
    expect(script).toContain('git -C "$repo_dir" fetch --no-tags origin main');
    expect(script).toContain(
      'git -C "$repo_dir" fetch --no-tags origin "refs/heads/${ref}:refs/remotes/origin/${ref}"',
    );
    expect(script).toContain('git -C "$repo_dir" pull --rebase --no-tags || true');

    const branchCheckIndex = script.indexOf('ls-remote --exit-code --heads origin "$ref"');
    const tagFetchIndex = script.indexOf("fetch --tags origin");
    expect(branchCheckIndex).toBeGreaterThan(-1);
    expect(tagFetchIndex).toBeGreaterThan(-1);
    expect(branchCheckIndex).toBeLessThan(tagFetchIndex);
  });

  it("uses non-frozen lockfile installs only for moving git refs", () => {
    const result = runInstallCliShell(`
      set -euo pipefail
      source "${SCRIPT_PATH}"
      git() {
        if [[ "$1" == "-C" && "$3" == "ls-remote" && "\${7:-}" == "feature" ]]; then
          return 0
        fi
        return 1
      }
      printf 'main=%s\\n' "$(git_install_lockfile_flag /repo main)"
      printf 'branch=%s\\n' "$(git_install_lockfile_flag /repo feature)"
      printf 'tag=%s\\n' "$(git_install_lockfile_flag /repo v2026.5.12)"
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("main=--no-frozen-lockfile");
    expect(result.stdout).toContain("branch=--no-frozen-lockfile");
    expect(result.stdout).toContain("tag=--frozen-lockfile");
    expect(script).toContain(
      'CI="${CI:-true}" run_pnpm -C "$repo_dir" install "${pnpm_prefer_offline_args[@]}" "$install_lockfile_flag"',
    );
  });

  it("aligns pnpm to the checked-out repo packageManager before installing", () => {
    expect(script).toContain("activate_repo_pnpm_version()");
    expect(script).toContain('"$corepack_cmd" prepare "pnpm@${version}" --activate');
    expect(script).toContain('activate_repo_pnpm_version "$repo_dir"');
  });

  it("preserves explicit pnpm prefer-offline settings", () => {
    const result = runInstallCliShell(`
      set -euo pipefail
      source "${SCRIPT_PATH}"
      unset PNPM_CONFIG_PREFER_OFFLINE pnpm_config_prefer_offline
      if should_prefer_offline_pnpm_install; then printf 'default=true\\n'; fi
      PNPM_CONFIG_PREFER_OFFLINE=false
      if should_prefer_offline_pnpm_install; then printf 'upper=true\\n'; else printf 'upper=false\\n'; fi
      unset PNPM_CONFIG_PREFER_OFFLINE
      pnpm_config_prefer_offline=false
      if should_prefer_offline_pnpm_install; then printf 'lower=true\\n'; else printf 'lower=false\\n'; fi
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("default=true");
    expect(result.stdout).toContain("upper=false");
    expect(result.stdout).toContain("lower=false");
    expect(script).toContain(
      'run_pnpm -C "$repo_dir" install "${pnpm_prefer_offline_args[@]}" "$install_lockfile_flag"',
    );
  });

  it("preserves explicit pnpm prefer-offline settings from npmrc files", () => {
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-cli-prefer-offline-npmrc-"));
    const project = join(tmp, "project");
    const underscoreProject = join(tmp, "underscore-project");
    const userNpmrc = join(tmp, "user.npmrc");
    mkdirSync(project, { recursive: true });
    mkdirSync(underscoreProject, { recursive: true });
    writeFileSync(join(project, ".npmrc"), "prefer-offline=false\n");
    writeFileSync(join(underscoreProject, ".npmrc"), "prefer_offline=false\n");
    writeFileSync(userNpmrc, "prefer-offline=false\n");

    try {
      const projectResult = runInstallCliShell(
        [
          "set -euo pipefail",
          `source "${SCRIPT_PATH}"`,
          "unset PNPM_CONFIG_PREFER_OFFLINE pnpm_config_prefer_offline",
          "unset PNPM_CONFIG_NPMRC_AUTH_FILE pnpm_config_npmrc_auth_file PNPM_CONFIG_USERCONFIG pnpm_config_userconfig NPM_CONFIG_USERCONFIG npm_config_userconfig",
          'if should_prefer_offline_pnpm_install "$PROJECT"; then printf "project=true\\n"; else printf "project=false\\n"; fi',
        ].join("\n"),
        { PROJECT: project },
      );
      const userResult = runInstallCliShell(
        [
          "set -euo pipefail",
          `source "${SCRIPT_PATH}"`,
          "unset PNPM_CONFIG_PREFER_OFFLINE pnpm_config_prefer_offline",
          "unset PNPM_CONFIG_NPMRC_AUTH_FILE pnpm_config_npmrc_auth_file PNPM_CONFIG_USERCONFIG pnpm_config_userconfig NPM_CONFIG_USERCONFIG npm_config_userconfig",
          "for env_key in NPM_CONFIG_USERCONFIG PNPM_CONFIG_USERCONFIG pnpm_config_userconfig PNPM_CONFIG_NPMRC_AUTH_FILE pnpm_config_npmrc_auth_file; do",
          '  export "$env_key=$USER_NPMRC"',
          '  if should_prefer_offline_pnpm_install "$PROJECT"; then printf "%s=true\\n" "$env_key"; else printf "%s=false\\n" "$env_key"; fi',
          '  unset "$env_key"',
          "done",
        ].join("\n"),
        { PROJECT: tmp, USER_NPMRC: userNpmrc },
      );
      const underscoreResult = runInstallCliShell(
        [
          "set -euo pipefail",
          `source "${SCRIPT_PATH}"`,
          "unset PNPM_CONFIG_PREFER_OFFLINE pnpm_config_prefer_offline",
          "unset PNPM_CONFIG_NPMRC_AUTH_FILE pnpm_config_npmrc_auth_file PNPM_CONFIG_USERCONFIG pnpm_config_userconfig NPM_CONFIG_USERCONFIG npm_config_userconfig",
          'if should_prefer_offline_pnpm_install "$PROJECT"; then printf "underscore=true\\n"; else printf "underscore=false\\n"; fi',
        ].join("\n"),
        { PROJECT: underscoreProject },
      );

      expect(projectResult.status).toBe(0);
      expect(projectResult.stdout).toContain("project=false");
      expect(userResult.status).toBe(0);
      for (const envKey of [
        "NPM_CONFIG_USERCONFIG",
        "PNPM_CONFIG_USERCONFIG",
        "pnpm_config_userconfig",
        "PNPM_CONFIG_NPMRC_AUTH_FILE",
        "pnpm_config_npmrc_auth_file",
      ]) {
        expect(userResult.stdout).toContain(`${envKey}=false`);
      }
      expect(underscoreResult.status).toBe(0);
      expect(underscoreResult.stdout).toContain("underscore=true");
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }
  });

  it("uses the repo Corepack pnpm when a global pnpm version is already present", () => {
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-cli-pnpm-version-"));
    const bin = join(tmp, "bin");
    const outer = join(tmp, "outer");
    const repo = join(tmp, "repo");
    mkdirSync(bin, { recursive: true });
    mkdirSync(outer, { recursive: true });
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(outer, "package.json"), '{\n  "packageManager": "yarn@4.5.0"\n}\n');
    writeFileSync(
      join(repo, "package.json"),
      '{\n  "packageManager": "pnpm@11.2.2+sha512.test"\n}\n',
    );
    writeFileSync(
      join(bin, "pnpm"),
      ["#!/bin/bash", '[[ "${1:-}" == "--version" ]] && echo "11.8.0"', ""].join("\n"),
    );
    writeFileSync(
      join(bin, "corepack"),
      [
        "#!/bin/bash",
        'if [[ "${1:-}" == "prepare" ]]; then exit 0; fi',
        'if [[ "${1:-}" == "pnpm" && "${2:-}" == "--version" ]]; then',
        '  if grep -q "pnpm@11.2.2" package.json 2>/dev/null; then echo "11.2.2"; else exit 1; fi',
        "  exit 0",
        "fi",
        "exit 1",
        "",
      ].join("\n"),
    );
    chmodSync(join(bin, "pnpm"), 0o755);
    chmodSync(join(bin, "corepack"), 0o755);

    try {
      const result = runInstallCliShell(
        [
          `cd ${JSON.stringify(process.cwd())}`,
          `source ${JSON.stringify(SCRIPT_PATH)}`,
          `cd ${JSON.stringify(outer)}`,
          `activate_repo_pnpm_version ${JSON.stringify(repo)}`,
          'printf "cmd=%s\\n" "${PNPM_CMD[*]}"',
          `printf "run=%s\\n" "$(run_pnpm -C ${JSON.stringify(repo)} --version)"`,
        ].join("\n"),
        { PATH: `${bin}:${process.env.PATH ?? ""}` },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`cmd=${join(bin, "corepack")} pnpm`);
      expect(result.stdout).toContain("run=11.2.2");
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }
  });

  it("links an existing usable Alpine/musl Node runtime without sudo", () => {
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-cli-alpine-"));
    const bin = join(tmp, "bin");
    const prefix = join(tmp, "prefix");
    const apkLog = join(tmp, "apk.log");
    const fakeApk = join(bin, "apk");
    const fakeNode = join(bin, "node");
    const fakeNpm = join(bin, "npm");

    mkdirSync(bin, { recursive: true });
    linkRequiredShellTools(bin);
    writeFileSync(
      fakeApk,
      ["#!/bin/bash", 'printf "%s\\n" "$*" >> "$APK_LOG"', "exit 99", ""].join("\n"),
    );
    writeFileSync(
      fakeNode,
      [
        "#!/bin/bash",
        'if [[ "${1:-}" == "-v" ]]; then',
        "  printf 'v22.22.3\\n'",
        "  exit 0",
        "fi",
        'if [[ "${1:-}" == "-e" ]]; then',
        "  exit 0",
        "fi",
        "exit 0",
        "",
      ].join("\n"),
    );
    writeFileSync(fakeNpm, ["#!/bin/bash", "exit 0", ""].join("\n"));
    chmodSync(fakeApk, 0o755);
    chmodSync(fakeNode, 0o755);
    chmodSync(fakeNpm, 0o755);

    try {
      const result = runInstallCliShell(
        [
          "set -euo pipefail",
          `cd ${JSON.stringify(process.cwd())}`,
          `source ${JSON.stringify(SCRIPT_PATH)}`,
          `export PATH=${JSON.stringify(bin)}`,
          "os_detect() { printf 'linux\\n'; }",
          "arch_detect() { printf 'x64\\n'; }",
          "is_musl_linux() { return 0; }",
          "is_root() { return 1; }",
          `PREFIX=${JSON.stringify(prefix)}`,
          `APK_NODE_BIN_DIR=${JSON.stringify(bin)}`,
          "install_node",
        ].join("\n"),
        {
          APK_LOG: apkLog,
          PATH: bin,
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain("Installing Node via apk");
      expect(() => readFileSync(apkLog, "utf8")).toThrow();
      const nodeLink = join(prefix, "tools", "node-v24.19.0", "bin", "node");
      const npmLink = join(prefix, "tools", "node-v24.19.0", "bin", "npm");
      expect(lstatSync(nodeLink).isSymbolicLink()).toBe(true);
      expect(readlinkSync(nodeLink)).toBe(fakeNode);
      expect(readlinkSync(npmLink)).toBe(fakeNpm);
      expect(script).toContain("apk add --no-cache git");
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }
  });

  it("replaces a stale Alpine/musl prefix Node before the generic skip", () => {
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-cli-alpine-stale-"));
    const bin = join(tmp, "bin");
    const oldBin = join(tmp, "old-bin");
    const prefix = join(tmp, "prefix");
    const nodePrefixBin = join(prefix, "tools", "node-v22.22.3", "bin");
    const apkLog = join(tmp, "apk.log");
    const fakeApk = join(bin, "apk");
    const fakeNode = join(bin, "node");
    const fakeNpm = join(bin, "npm");
    const oldNode = join(oldBin, "node");
    const oldNpm = join(oldBin, "npm");
    const staleNode = join(nodePrefixBin, "node");

    mkdirSync(bin, { recursive: true });
    linkRequiredShellTools(bin);
    mkdirSync(oldBin, { recursive: true });
    mkdirSync(nodePrefixBin, { recursive: true });
    writeFileSync(
      fakeApk,
      ["#!/bin/bash", 'printf "%s\\n" "$*" >> "$APK_LOG"', "exit 99", ""].join("\n"),
    );
    writeFileSync(
      staleNode,
      [
        "#!/bin/bash",
        'if [[ "${1:-}" == "-v" ]]; then',
        "  printf 'v22.22.3\\n'",
        "  exit 0",
        "fi",
        'if [[ "${1:-}" == "-e" ]]; then',
        "  exit 1",
        "fi",
        "exit 0",
        "",
      ].join("\n"),
    );
    writeFileSync(
      fakeNode,
      [
        "#!/bin/bash",
        'if [[ "${1:-}" == "-v" ]]; then',
        "  printf 'v22.22.3\\n'",
        "  exit 0",
        "fi",
        'if [[ "${1:-}" == "-e" ]]; then',
        "  exit 0",
        "fi",
        "exit 0",
        "",
      ].join("\n"),
    );
    writeFileSync(
      oldNode,
      [
        "#!/bin/bash",
        'if [[ "${1:-}" == "-v" ]]; then',
        "  printf 'v18.20.0\\n'",
        "  exit 0",
        "fi",
        'if [[ "${1:-}" == "-e" ]]; then',
        "  exit 1",
        "fi",
        "exit 0",
        "",
      ].join("\n"),
    );
    writeFileSync(oldNpm, ["#!/bin/bash", "exit 0", ""].join("\n"));
    writeFileSync(fakeNpm, ["#!/bin/bash", "exit 0", ""].join("\n"));
    chmodSync(fakeApk, 0o755);
    chmodSync(staleNode, 0o755);
    chmodSync(oldNode, 0o755);
    chmodSync(oldNpm, 0o755);
    chmodSync(fakeNode, 0o755);
    chmodSync(fakeNpm, 0o755);

    try {
      const result = runInstallCliShell(
        [
          "set -euo pipefail",
          `cd ${JSON.stringify(process.cwd())}`,
          `source ${JSON.stringify(SCRIPT_PATH)}`,
          `export PATH=${JSON.stringify(`${nodePrefixBin}:${oldBin}:${bin}`)}`,
          "os_detect() { printf 'linux\\n'; }",
          "arch_detect() { printf 'x64\\n'; }",
          "is_musl_linux() { return 0; }",
          "is_root() { return 1; }",
          `PREFIX=${JSON.stringify(prefix)}`,
          "NODE_VERSION=22.22.3",
          "install_node",
        ].join("\n"),
        {
          APK_LOG: apkLog,
          PATH: `${nodePrefixBin}:${oldBin}:${bin}`,
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain("Installing Node via apk");
      expect(() => readFileSync(apkLog, "utf8")).toThrow();
      const nodeLink = join(prefix, "tools", "node-v22.22.3", "bin", "node");
      const npmLink = join(prefix, "tools", "node-v22.22.3", "bin", "npm");
      expect(lstatSync(nodeLink).isSymbolicLink()).toBe(true);
      expect(readlinkSync(nodeLink)).toBe(fakeNode);
      expect(readlinkSync(npmLink)).toBe(fakeNpm);
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }
  });

  it("uses apk-managed Node and Git on Alpine/musl when the existing Node is unusable", () => {
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-cli-alpine-apk-"));
    const bin = join(tmp, "bin");
    const prefix = join(tmp, "prefix");
    const apkLog = join(tmp, "apk.log");
    const nodeState = join(tmp, "node-state");
    const fakeApk = join(bin, "apk");
    const fakeNode = join(bin, "node");
    const fakeNpm = join(bin, "npm");

    mkdirSync(bin, { recursive: true });
    linkRequiredShellTools(bin);
    writeFileSync(
      fakeApk,
      [
        "#!/bin/bash",
        'printf "%s\\n" "$*" >> "$APK_LOG"',
        'printf "new\\n" > "$NODE_STATE"',
        "exit 0",
        "",
      ].join("\n"),
    );
    writeFileSync(
      fakeNode,
      [
        "#!/bin/bash",
        'if [[ "${1:-}" == "-v" ]]; then',
        '  if [[ -f "$NODE_STATE" ]]; then',
        "    printf 'v22.22.3\\n'",
        "  else",
        "    printf 'v18.20.0\\n'",
        "  fi",
        "  exit 0",
        "fi",
        'if [[ "${1:-}" == "-e" ]]; then',
        '  [[ -f "$NODE_STATE" ]]',
        "  exit $?",
        "fi",
        "exit 0",
        "",
      ].join("\n"),
    );
    writeFileSync(fakeNpm, ["#!/bin/bash", "exit 0", ""].join("\n"));
    chmodSync(fakeApk, 0o755);
    chmodSync(fakeNode, 0o755);
    chmodSync(fakeNpm, 0o755);

    try {
      const result = runInstallCliShell(
        [
          "set -euo pipefail",
          `cd ${JSON.stringify(process.cwd())}`,
          `source ${JSON.stringify(SCRIPT_PATH)}`,
          `export PATH=${JSON.stringify(bin)}`,
          "os_detect() { printf 'linux\\n'; }",
          "arch_detect() { printf 'x64\\n'; }",
          "is_musl_linux() { return 0; }",
          "is_root() { return 0; }",
          `PREFIX=${JSON.stringify(prefix)}`,
          `APK_NODE_BIN_DIR=${JSON.stringify(bin)}`,
          "NODE_VERSION=22.22.3",
          "install_node",
        ].join("\n"),
        {
          APK_LOG: apkLog,
          NODE_STATE: nodeState,
          PATH: bin,
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Installing Node via apk");
      expect(readFileSync(apkLog, "utf8")).toContain("add --no-cache nodejs npm");
      const nodeLink = join(prefix, "tools", "node-v22.22.3", "bin", "node");
      const npmLink = join(prefix, "tools", "node-v22.22.3", "bin", "npm");
      expect(lstatSync(nodeLink).isSymbolicLink()).toBe(true);
      expect(readlinkSync(nodeLink)).toBe(fakeNode);
      expect(readlinkSync(npmLink)).toBe(fakeNpm);
      expect(script).toContain("apk add --no-cache git");
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }
  });

  it("skips PATH Node runtimes whose npm command cannot start", () => {
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-cli-broken-npm-"));
    const badBin = join(tmp, "bad-bin");
    const goodBin = join(tmp, "good-bin");
    const prefix = join(tmp, "prefix");
    const badNpmLog = join(tmp, "bad-npm.log");
    const goodNpmLog = join(tmp, "good-npm.log");
    const goodNodeLog = join(tmp, "good-node.log");
    const badNode = join(badBin, "node");
    const badNpm = join(badBin, "npm");
    const goodNode = join(goodBin, "node");
    const goodNpm = join(goodBin, "npm");

    mkdirSync(badBin, { recursive: true });
    mkdirSync(goodBin, { recursive: true });
    symlinkSync(process.execPath, badNode);
    writeFileSync(
      goodNode,
      [
        "#!/bin/bash",
        'printf "%s\\n" "$*" >> "$GOOD_NODE_LOG"',
        `exec ${JSON.stringify(process.execPath)} "$@"`,
        "",
      ].join("\n"),
    );
    writeFileSync(
      badNpm,
      ["#!/bin/bash", 'printf "%s\\n" "$*" >> "$BAD_NPM_LOG"', "exit 42", ""].join("\n"),
    );
    writeFileSync(
      goodNpm,
      [
        "#!/usr/bin/env node",
        'require("node:fs").appendFileSync(',
        "  process.env.GOOD_NPM_LOG,",
        '  `${process.argv.slice(2).join(" ")}\\n`,',
        ");",
        "",
      ].join("\n"),
    );
    chmodSync(badNpm, 0o755);
    chmodSync(goodNode, 0o755);
    chmodSync(goodNpm, 0o755);

    try {
      const result = runInstallCliShell(
        [
          "set -euo pipefail",
          `cd ${JSON.stringify(process.cwd())}`,
          `source ${JSON.stringify(SCRIPT_PATH)}`,
          `export PATH=${JSON.stringify(`${badBin}:${goodBin}:${process.env.PATH ?? ""}`)}`,
          `PREFIX=${JSON.stringify(prefix)}`,
          "try_link_usable_node_runtime_from_path",
        ].join("\n"),
        {
          BAD_NPM_LOG: badNpmLog,
          GOOD_NPM_LOG: goodNpmLog,
          GOOD_NODE_LOG: goodNodeLog,
        },
      );

      expect(result.status).toBe(0);
      const nodeLink = join(prefix, "tools", "node-v24.19.0", "bin", "node");
      const npmLink = join(prefix, "tools", "node-v24.19.0", "bin", "npm");
      expect(readFileSync(badNpmLog, "utf8")).toBe("--version\n");
      expect(readFileSync(goodNpmLog, "utf8")).toBe("--version\n");
      expect(readFileSync(goodNodeLog, "utf8")).toContain("npm --version");
      expect(lstatSync(nodeLink).isSymbolicLink()).toBe(true);
      expect(readlinkSync(nodeLink)).toBe(goodNode);
      expect(readlinkSync(npmLink)).toBe(goodNpm);
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }
  });

  it("rejects Alpine/musl Node packages below the requested runtime floor", () => {
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-cli-alpine-old-node-"));
    const bin = join(tmp, "bin");
    const prefix = join(tmp, "prefix");
    const apkLog = join(tmp, "apk.log");
    const fakeApk = join(bin, "apk");
    const fakeNode = join(bin, "node");
    const fakeNpm = join(bin, "npm");

    mkdirSync(bin, { recursive: true });
    linkRequiredShellTools(bin);
    writeFileSync(
      fakeApk,
      ["#!/bin/bash", 'printf "%s\\n" "$*" >> "$APK_LOG"', "exit 0", ""].join("\n"),
    );
    writeFileSync(
      fakeNode,
      [
        "#!/bin/bash",
        'if [[ "${1:-}" == "-v" ]]; then',
        "  printf 'v22.18.0\\n'",
        "  exit 0",
        "fi",
        'if [[ "${1:-}" == "-e" ]]; then',
        "  exit 0",
        "fi",
        "exit 0",
        "",
      ].join("\n"),
    );
    writeFileSync(fakeNpm, ["#!/bin/bash", "exit 0", ""].join("\n"));
    chmodSync(fakeApk, 0o755);
    chmodSync(fakeNode, 0o755);
    chmodSync(fakeNpm, 0o755);

    try {
      const result = runInstallCliShell(
        [
          "set -euo pipefail",
          `cd ${JSON.stringify(process.cwd())}`,
          `source ${JSON.stringify(SCRIPT_PATH)}`,
          `export PATH=${JSON.stringify(bin)}`,
          "os_detect() { printf 'linux\\n'; }",
          "arch_detect() { printf 'x64\\n'; }",
          "is_musl_linux() { return 0; }",
          "is_root() { return 0; }",
          `PREFIX=${JSON.stringify(prefix)}`,
          `APK_NODE_BIN_DIR=${JSON.stringify(bin)}`,
          "NODE_VERSION=22.22.3",
          "install_node",
        ].join("\n"),
        {
          APK_LOG: apkLog,
          PATH: bin,
        },
      );

      expect(result.status).toBe(1);
      expect(readFileSync(apkLog, "utf8")).toContain("add --no-cache nodejs npm");
      expect(result.stdout).toContain(
        "Alpine Node package must provide Node >= 22.22.3 with WAL-reset-safe SQLite 3.51.3+, 3.50.7+ within 3.50.x, or 3.44.6+ within 3.44.x",
      );
      expect(result.stdout).toContain("found Node v22.18.0, SQLite unavailable");
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }
  });

  it("replaces cached generic Node runtimes below the runtime floor", () => {
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-cli-generic-stale-node-"));
    const prefix = join(tmp, "prefix");
    const nodePrefixBin = join(prefix, "tools", "node-v22.22.3", "bin");
    const staleNode = join(nodePrefixBin, "node");
    const staleNpm = join(nodePrefixBin, "npm");
    const newNode = join(tmp, "new-node");
    const newNpm = join(tmp, "new-npm");

    mkdirSync(nodePrefixBin, { recursive: true });
    writeFileSync(
      staleNode,
      [
        "#!/bin/bash",
        'if [[ "${1:-}" == "-v" ]]; then',
        "  printf 'v22.18.0\\n'",
        "  exit 0",
        "fi",
        'if [[ "${1:-}" == "-e" ]]; then',
        "  exit 0",
        "fi",
        "exit 0",
        "",
      ].join("\n"),
    );
    writeFileSync(staleNpm, ["#!/bin/bash", "exit 0", ""].join("\n"));
    writeFileSync(
      newNode,
      [
        "#!/bin/bash",
        'if [[ "${1:-}" == "-v" ]]; then',
        "  printf 'v22.22.3\\n'",
        "  exit 0",
        "fi",
        'if [[ "${1:-}" == "-e" ]]; then',
        "  exit 0",
        "fi",
        "exit 0",
        "",
      ].join("\n"),
    );
    writeFileSync(newNpm, ["#!/bin/bash", "exit 0", ""].join("\n"));
    chmodSync(staleNode, 0o755);
    chmodSync(staleNpm, 0o755);
    chmodSync(newNode, 0o755);
    chmodSync(newNpm, 0o755);

    try {
      const result = runInstallCliShell(
        [
          "set -euo pipefail",
          `cd ${JSON.stringify(process.cwd())}`,
          `source ${JSON.stringify(SCRIPT_PATH)}`,
          "os_detect() { printf 'linux\\n'; }",
          "arch_detect() { printf 'x64\\n'; }",
          "is_musl_linux() { return 1; }",
          "detect_downloader() { :; }",
          "require_bin() { :; }",
          "download_file() {",
          '  case "$1" in',
          "    */SHASUMS256.txt) printf 'fixture-sha  node-v22.22.3-linux-x64.tar.gz\\n' > \"$2\" ;;",
          "    *) printf 'node tarball fixture\\n' > \"$2\" ;;",
          "  esac",
          "}",
          "sha256_file() { printf 'fixture-sha\\n'; }",
          "tar() {",
          "  local dest=''",
          "  while [[ $# -gt 0 ]]; do",
          '    if [[ "$1" == \'-C\' ]]; then dest="$2"; shift 2; else shift; fi',
          "  done",
          '  mkdir -p "$dest/bin"',
          '  cp "$NEW_NODE" "$dest/bin/node"',
          '  cp "$NEW_NPM" "$dest/bin/npm"',
          "}",
          `PREFIX=${JSON.stringify(prefix)}`,
          "NODE_VERSION=22.22.3",
          "install_node",
        ].join("\n"),
        {
          NEW_NODE: newNode,
          NEW_NPM: newNpm,
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Installing Node 22.22.3 (user-space)");
      expect(result.stdout).not.toContain('"status":"skip"');
      expect(readFileSync(staleNode, "utf8")).toContain("v22.22.3");
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }
  });

  it("rejects downloaded generic Node runtimes below the runtime floor", () => {
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-cli-generic-old-node-"));
    const prefix = join(tmp, "prefix");
    const newNode = join(tmp, "new-node");
    const newNpm = join(tmp, "new-npm");

    writeFileSync(
      newNode,
      [
        "#!/bin/bash",
        'if [[ "${1:-}" == "-v" ]]; then',
        "  printf 'v22.22.2\\n'",
        "  exit 0",
        "fi",
        'if [[ "${1:-}" == "-e" ]]; then',
        "  exit 0",
        "fi",
        "exit 0",
        "",
      ].join("\n"),
    );
    writeFileSync(newNpm, ["#!/bin/bash", "exit 0", ""].join("\n"));
    chmodSync(newNode, 0o755);
    chmodSync(newNpm, 0o755);

    try {
      const result = runInstallCliShell(
        [
          "set -euo pipefail",
          `cd ${JSON.stringify(process.cwd())}`,
          `source ${JSON.stringify(SCRIPT_PATH)}`,
          "os_detect() { printf 'linux\\n'; }",
          "arch_detect() { printf 'x64\\n'; }",
          "is_musl_linux() { return 1; }",
          "detect_downloader() { :; }",
          "require_bin() { :; }",
          "download_file() {",
          '  case "$1" in',
          "    */SHASUMS256.txt) printf 'fixture-sha  node-v22.22.3-linux-x64.tar.gz\\n' > \"$2\" ;;",
          "    *) printf 'node tarball fixture\\n' > \"$2\" ;;",
          "  esac",
          "}",
          "sha256_file() { printf 'fixture-sha\\n'; }",
          "tar() {",
          "  local dest=''",
          "  while [[ $# -gt 0 ]]; do",
          '    if [[ "$1" == \'-C\' ]]; then dest="$2"; shift 2; else shift; fi',
          "  done",
          '  mkdir -p "$dest/bin"',
          '  cp "$NEW_NODE" "$dest/bin/node"',
          '  cp "$NEW_NPM" "$dest/bin/npm"',
          "}",
          `PREFIX=${JSON.stringify(prefix)}`,
          "NODE_VERSION=22.22.3",
          "install_node",
        ].join("\n"),
        {
          NEW_NODE: newNode,
          NEW_NPM: newNpm,
        },
      );

      expect(result.status).toBe(1);
      expect(result.stdout).toContain(
        "Installed Node 22.22.3 must provide Node >= 22.22.3 with WAL-reset-safe SQLite",
      );
      expect(result.stdout).toContain("found Node v22.22.2, SQLite unavailable");
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }
  });

  it("removes the Node staging directory when download fails", () => {
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-cli-node-cleanup-"));
    const prefix = join(tmp, "prefix");
    const stagingDir = join(tmp, "node-staging");

    try {
      const result = runInstallCliShell(
        [
          "set -euo pipefail",
          `cd ${JSON.stringify(process.cwd())}`,
          `source ${JSON.stringify(SCRIPT_PATH)}`,
          "os_detect() { printf 'linux\\n'; }",
          "arch_detect() { printf 'x64\\n'; }",
          "is_musl_linux() { return 1; }",
          "linked_node_is_usable() { return 1; }",
          "detect_downloader() { :; }",
          "require_bin() { :; }",
          `mktemp() { mkdir -p ${JSON.stringify(stagingDir)}; printf '%s\\n' ${JSON.stringify(stagingDir)}; }`,
          "download_file() { return 42; }",
          `PREFIX=${JSON.stringify(prefix)}`,
          "NODE_VERSION=22.22.3",
          "install_node",
        ].join("\n"),
      );

      expect(result.status).toBe(42);
      expect(() => lstatSync(stagingDir)).toThrow();
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }
  });

  it("removes the workspace rewrite temp file when rewriting fails", () => {
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-cli-workspace-cleanup-"));
    const repo = join(tmp, "repo");
    const workspaceFile = join(repo, "pnpm-workspace.yaml");
    const rewriteTemp = join(tmp, "workspace-rewrite");
    const workspace = 'packages:\n  - "packages/*"\n\nallowBuilds:\n';
    mkdirSync(repo, { recursive: true });
    writeFileSync(workspaceFile, workspace);

    try {
      const result = runInstallCliShell(
        [
          "set -euo pipefail",
          `cd ${JSON.stringify(process.cwd())}`,
          `source ${JSON.stringify(SCRIPT_PATH)}`,
          `mktemp() { : > ${JSON.stringify(rewriteTemp)}; printf '%s\\n' ${JSON.stringify(rewriteTemp)}; }`,
          "awk() { return 43; }",
          `ensure_pnpm_git_prepare_allowlist ${JSON.stringify(repo)}`,
        ].join("\n"),
      );

      expect(result.status).toBe(43);
      expect(() => lstatSync(rewriteTemp)).toThrow();
      expect(readFileSync(workspaceFile, "utf8")).toBe(workspace);
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }
  });

  it("clears npm freshness filters for package installs", () => {
    expect(script).toContain('freshness_flag="--min-release-age=0"');
    expect(script).toContain('npm_config_has_raw_key "$(npm_bin)" "min-release-age"');
    expect(script).toContain('freshness_flag="--before=$(date -u');
    expect(script).toContain("env -u NPM_CONFIG_BEFORE -u npm_config_before");
  });

  it.each([
    { expected: "", version: "11.15.0" },
    { expected: "--allow-scripts=openclaw", version: "11.16.0" },
    { expected: "--allow-scripts=openclaw", version: "12.0.0" },
  ])("resolves canonical npm lifecycle policy for npm $version", ({ expected, version }) => {
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-cli-lifecycle-"));
    const npm = join(tmp, "npm");
    writeNpmLifecycleFixture(npm);
    try {
      const result = runInstallCliShell(
        [
          `source ${JSON.stringify(SCRIPT_PATH)}`,
          `node_bin() { printf '%s\n' ${JSON.stringify(process.execPath)}; }`,
          `result="$(npm_lifecycle_allow_arg ${JSON.stringify(npm)} openclaw@latest)"`,
          `printf '%s' "$result"`,
        ].join("\n"),
        { NPM_FAKE_VERSION: version },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(expected);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.each(["invalid", "npm 12.0.0 warning"])(
    "rejects npm version %s before mutation",
    (version) => {
      const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-cli-lifecycle-invalid-"));
      const npm = join(tmp, "npm");
      const args = join(tmp, "args");
      writeNpmLifecycleFixture(npm);
      try {
        const result = runInstallCliShell(
          [
            `source ${JSON.stringify(SCRIPT_PATH)}`,
            `node_bin() { printf '%s\n' ${JSON.stringify(process.execPath)}; }`,
            `npm_lifecycle_allow_arg ${JSON.stringify(npm)} openclaw@latest`,
          ].join("\n"),
          { NPM_FAKE_ARGS: args, NPM_FAKE_VERSION: version },
        );
        expect(result.status).not.toBe(0);
        expect(existsSync(args)).toBe(false);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ["openclaw@npm:@scope/candidate@1.0.0", "--allow-scripts=@scope/candidate"],
    ["file:/tmp/openclaw.tgz", "--allow-scripts=file:/tmp/openclaw.tgz"],
    [
      "https://example.invalid/openclaw.tgz",
      "--allow-scripts=https://example.invalid/openclaw.tgz",
    ],
  ])("uses npm-resolved lifecycle identity for %s", (spec, expected) => {
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-cli-identity-"));
    const npm = join(tmp, "npm");
    writeNpmLifecycleFixture(npm);
    try {
      const result = runInstallCliShell(
        [
          `source ${JSON.stringify(SCRIPT_PATH)}`,
          `node_bin() { printf '%s\n' ${JSON.stringify(process.execPath)}; }`,
          `npm_lifecycle_allow_arg ${JSON.stringify(npm)} ${JSON.stringify(spec)}`,
        ].join("\n"),
        { NPM_FAKE_VERSION: "12.0.0" },
      );
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(expected);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("relativizes absolute npm path identities against the command cwd", () => {
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-cli-identity-comma,"));
    const npm = join(tmp, "npm");
    const commandCwd = join(tmp, "safe");
    const candidate = join(tmp, "candidate.tgz");
    mkdirSync(commandCwd);
    writeNpmLifecycleFixture(npm);
    try {
      const result = runInstallCliShell(
        [
          `source ${JSON.stringify(SCRIPT_PATH)}`,
          `node_bin() { printf '%s\\n' ${JSON.stringify(process.execPath)}; }`,
          `cd ${JSON.stringify(commandCwd)}`,
          `npm_lifecycle_allow_arg ${JSON.stringify(npm)} ${JSON.stringify(candidate)} "$PWD"`,
        ].join("\n"),
        { NPM_FAKE_VERSION: "12.0.0" },
      );
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("--allow-scripts=../candidate.tgz");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not emit --before when raw user npmrc config contains min-release-age", () => {
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-cli-npmrc-"));
    const bin = join(tmp, "bin");
    const npmrc = join(tmp, "user.npmrc");
    const installArgs = join(tmp, "npm-install-args.txt");
    const prefix = join(tmp, "prefix");
    const nodeDir = join(tmp, "node");
    mkdirSync(bin, { recursive: true });
    mkdirSync(nodeDir, { recursive: true });
    writeInstalledOpenClawEntry(nodeDir);
    writeFileSync(npmrc, "min-release-age=7\n");
    const fakeNpm = join(bin, "npm");
    writeFileSync(
      fakeNpm,
      [
        "#!/bin/bash",
        'if [[ "$1" == "config" && "$2" == "get" ]]; then',
        '  if [[ "$3" == "min-release-age" ]]; then',
        "    printf 'null\\n'",
        "    exit 0",
        "  fi",
        '  if [[ "$3" == "before" ]]; then',
        "    printf '2026-01-01T00:00:00.000Z\\n'",
        "    exit 0",
        "  fi",
        "fi",
        'printf "%s\\n" "$@" > "$NPM_FAKE_INSTALL_ARGS"',
        "exit 0",
        "",
      ].join("\n"),
    );
    chmodSync(fakeNpm, 0o755);

    try {
      const result = runInstallCliShell(
        [
          "set -euo pipefail",
          `cd ${JSON.stringify(process.cwd())}`,
          `source ${JSON.stringify(SCRIPT_PATH)}`,
          "npm_lifecycle_allow_arg() { :; }",
          `npm_bin() { printf '%s\\n' ${JSON.stringify(fakeNpm)}; }`,
          `node_dir() { printf '%s\\n' ${JSON.stringify(nodeDir)}; }`,
          "emit_json() { :; }",
          "log() { :; }",
          `PREFIX=${JSON.stringify(prefix)}`,
          "SET_NPM_PREFIX=0",
          "OPENCLAW_VERSION=1.2.3",
          "install_openclaw",
        ].join("\n"),
        {
          NPM_CONFIG_USERCONFIG: npmrc,
          NPM_FAKE_INSTALL_ARGS: installArgs,
          PATH: `${bin}:${process.env.PATH}`,
        },
      );

      expect(result.status).toBe(0);
      expect(readFileSync(installArgs, "utf8")).toContain("--min-release-age=0\n");
      expect(readFileSync(installArgs, "utf8")).not.toContain("--before=");
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }
  });

  it.each([
    {
      name: "does not emit --before when default global npmrc config contains min-release-age",
      source: "global" as const,
    },
    {
      name: "does not emit --before when builtin npmrc config contains min-release-age",
      source: "builtin" as const,
    },
  ])("$name", ({ source }) => {
    const tmp = mkdtempSync(join(tmpdir(), `openclaw-install-cli-${source}-npmrc-`));
    const bin = join(tmp, "bin");
    const home = join(tmp, "home");
    const prefix = join(tmp, "prefix");
    const npmrc = source === "global" ? join(prefix, "etc", "npmrc") : join(tmp, "npmrc");
    const calls = join(tmp, "npm-calls.txt");
    const installArgs = join(tmp, "npm-install-args.txt");
    const installPrefix = join(tmp, "install-prefix");
    const nodeDir = join(tmp, "node");
    mkdirSync(bin, { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(nodeDir, { recursive: true });
    writeInstalledOpenClawEntry(nodeDir);
    if (source === "global") {
      mkdirSync(join(prefix, "etc"), { recursive: true });
    }
    writeFileSync(npmrc, "min-release-age=7\n");
    const fakeNpm = join(bin, "npm");
    writeFileSync(
      fakeNpm,
      [
        "#!/bin/bash",
        'printf "%s\\n" "$*" >> "$NPM_FAKE_CALLS"',
        'if [[ "$1" == "config" && "$2" == "get" ]]; then',
        '  if [[ "$3" == "min-release-age" ]]; then',
        "    printf 'null\\n'",
        "    exit 0",
        "  fi",
        '  if [[ "$3" == "globalconfig" ]]; then',
        '    printf "%s\\n" "$NPM_FAKE_GLOBALCONFIG"',
        "    exit 0",
        "  fi",
        '  if [[ "$3" == "before" ]]; then',
        "    printf '2026-01-01T00:00:00.000Z\\n'",
        "    exit 0",
        "  fi",
        "fi",
        'printf "%s\\n" "$@" > "$NPM_FAKE_INSTALL_ARGS"',
        "exit 0",
        "",
      ].join("\n"),
    );
    chmodSync(fakeNpm, 0o755);

    try {
      const result = runInstallCliShell(
        [
          "set -euo pipefail",
          `cd ${JSON.stringify(process.cwd())}`,
          `source ${JSON.stringify(SCRIPT_PATH)}`,
          "npm_lifecycle_allow_arg() { :; }",
          `npm_bin() { printf '%s\\n' ${JSON.stringify(fakeNpm)}; }`,
          `node_dir() { printf '%s\\n' ${JSON.stringify(nodeDir)}; }`,
          "emit_json() { :; }",
          "log() { :; }",
          `PREFIX=${JSON.stringify(installPrefix)}`,
          "SET_NPM_PREFIX=0",
          "OPENCLAW_VERSION=1.2.3",
          "install_openclaw",
        ].join("\n"),
        {
          HOME: home,
          NPM_CONFIG_GLOBALCONFIG: undefined,
          NPM_CONFIG_PREFIX: undefined,
          npm_config_globalconfig: undefined,
          npm_config_prefix: undefined,
          NPM_FAKE_CALLS: calls,
          NPM_FAKE_GLOBALCONFIG: source === "global" ? npmrc : join(tmp, "missing-global-npmrc"),
          NPM_FAKE_INSTALL_ARGS: installArgs,
          PATH: `${bin}:${process.env.PATH}`,
        },
      );

      expect(result.status).toBe(0);
      expect(readFileSync(installArgs, "utf8")).toContain("--min-release-age=0\n");
      expect(readFileSync(installArgs, "utf8")).not.toContain("--before=");
      expect(readFileSync(calls, "utf8")).not.toContain("config get before");
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }
  });

  it("rejects OpenClaw GitHub source targets for npm installs", () => {
    const result = runInstallCliShell(`
      set -euo pipefail
      source "${SCRIPT_PATH}"
      OPENCLAW_VERSION=main
      install_openclaw
    `);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("npm installs do not support OpenClaw GitHub source targets");
    expect(result.stdout).toContain("--install-method git --version main");
  });

  it.each([
    { requested: "latest", outcome: "success", error: "", calls: 1, status: 0 },
    {
      requested: "beta",
      outcome: "transient",
      error: "ECONNRESET socket hang up",
      calls: 2,
      status: 0,
    },
    {
      requested: "next",
      outcome: "transient",
      error: "ECONNRESET socket hang up",
      calls: 2,
      status: 0,
    },
    {
      requested: "2026.8.1",
      outcome: "transient",
      error: "ECONNRESET socket hang up",
      calls: 2,
      status: 0,
    },
    {
      requested: "latest",
      outcome: "persistent",
      error: "EACCES permission denied",
      calls: 2,
      status: 1,
    },
    {
      requested: "beta",
      outcome: "persistent",
      error: "ENOSPC no space left",
      calls: 2,
      status: 1,
    },
  ])(
    "keeps openclaw@$requested immutable across $outcome npm installs",
    ({ requested, outcome, error, calls: expectedCalls, status }) => {
      const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-cli-npm-retry-"));
      const fakeNpm = join(tmp, "npm");
      const calls = join(tmp, "calls");
      const nodeDir = join(tmp, "node");
      const prefix = join(tmp, "prefix");
      writeNpmInstallRetryFixture(fakeNpm);
      linkNodeExecutable(nodeDir);

      try {
        const result = runInstallCliShell(
          [
            "set -euo pipefail",
            `source ${JSON.stringify(SCRIPT_PATH)}`,
            `npm_bin() { printf '%s\\n' ${JSON.stringify(fakeNpm)}; }`,
            `node_dir() { printf '%s\\n' ${JSON.stringify(nodeDir)}; }`,
            "npm_config_has_raw_key() { return 1; }",
            `PREFIX=${JSON.stringify(prefix)}`,
            `OPENCLAW_VERSION=${requested}`,
            "JSON=1",
            "set +e",
            "install_openclaw",
            "status=$?",
            'exit "$status"',
          ].join("\n"),
          {
            NPM_FAKE_CALLS: calls,
            NPM_FAKE_ERROR: error,
            NPM_FAKE_OUTCOME: outcome,
            NPM_FAKE_PACKAGE_DIR: join(nodeDir, "lib", "node_modules", "openclaw"),
          },
        );

        expect(result.status).toBe(status);
        expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual(
          Array.from({ length: expectedCalls }, () => `openclaw@${requested}`),
        );
        if (status !== 0) {
          expect(result.stderr).toContain(`${error} (attempt 2)`);
          expect(result.stdout).not.toContain('"status":"ok"');
          expect(existsSync(join(prefix, "bin", "openclaw"))).toBe(false);
        }
        if (requested !== "next") {
          expect(`${result.stdout}\n${result.stderr}`).not.toContain("openclaw@next");
        }
      } finally {
        rmSync(tmp, { force: true, recursive: true });
      }
    },
  );

  it("fails after retrying the exact npm spec when npm exits zero without installing OpenClaw", () => {
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-cli-empty-success-"));
    const fakeNpm = join(tmp, "npm");
    const calls = join(tmp, "calls");
    const nodeDir = join(tmp, "node");
    const prefix = join(tmp, "prefix");
    writeNpmInstallRetryFixture(fakeNpm);
    linkNodeExecutable(nodeDir);

    try {
      const result = runInstallCliShell(
        [
          "set -euo pipefail",
          `source ${JSON.stringify(SCRIPT_PATH)}`,
          `npm_bin() { printf '%s\\n' ${JSON.stringify(fakeNpm)}; }`,
          `node_dir() { printf '%s\\n' ${JSON.stringify(nodeDir)}; }`,
          "npm_config_has_raw_key() { return 1; }",
          `PREFIX=${JSON.stringify(prefix)}`,
          "OPENCLAW_VERSION=latest",
          "JSON=1",
          "install_openclaw",
        ].join("\n"),
        {
          NPM_FAKE_CALLS: calls,
          NPM_FAKE_ERROR: "",
          NPM_FAKE_OUTCOME: "success",
        },
      );

      expect(result.status).toBe(1);
      expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual([
        "openclaw@latest",
        "openclaw@latest",
      ]);
      expect(result.stdout).toContain("npm install did not produce a usable OpenClaw package");
      expect(result.stdout).not.toContain('"status":"ok"');
      expect(result.stdout).not.toContain("openclaw@next");
      expect(existsSync(join(prefix, "bin", "openclaw"))).toBe(false);
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }
  });

  it("does not emit before args when npmrc min-release-age computes a before cutoff", () => {
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-cli-freshness-"));
    const prefix = join(tmp, "prefix");
    const home = join(tmp, "home");
    const nodeBin = join(prefix, "tools/node-v24.19.0/bin");
    const argsLog = join(tmp, "npm-args.log");
    mkdirSync(nodeBin, { recursive: true });
    mkdirSync(home, { recursive: true });
    writeInstalledOpenClawEntry(join(prefix, "tools", "node-v24.19.0"));
    writeFileSync(join(home, ".npmrc"), "min-release-age=7\n");
    writeNpmFreshnessConflictFixture(join(nodeBin, "npm"), argsLog);

    let result: ReturnType<typeof runInstallCliShell> | undefined;
    let argsOutput;
    try {
      result = runInstallCliShell(
        [
          "set -euo pipefail",
          `HOME=${JSON.stringify(home)}`,
          `OPENCLAW_PREFIX=${JSON.stringify(prefix)}`,
          "OPENCLAW_VERSION=2026.5.19",
          `source ${JSON.stringify(SCRIPT_PATH)}`,
          "ensure_git() { return 0; }",
          "install_openclaw",
        ].join("\n"),
      );
      argsOutput = readFileSync(argsLog, "utf8");
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }

    expect(result?.status).toBe(0);
    expect(argsOutput).toContain("--min-release-age=0");
    expect(argsOutput).not.toContain("--before=");
  });

  it("ignores project npmrc when choosing global install freshness args", () => {
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-cli-global-freshness-"));
    const prefix = join(tmp, "prefix");
    const home = join(tmp, "home");
    const project = join(tmp, "project");
    const nodeBin = join(prefix, "tools/node-v24.19.0/bin");
    const argsLog = join(tmp, "npm-args.log");
    mkdirSync(nodeBin, { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeInstalledOpenClawEntry(join(prefix, "tools", "node-v24.19.0"));
    writeFileSync(join(home, ".npmrc"), "before=2026-01-01T00:00:00.000Z\n");
    writeFileSync(join(project, ".npmrc"), "min-release-age=7\n");
    writeNpmBeforePolicyFixture(join(nodeBin, "npm"), argsLog);

    let result: ReturnType<typeof runInstallCliShell> | undefined;
    let argsOutput;
    try {
      result = runInstallCliShell(
        [
          "set -euo pipefail",
          `cd ${JSON.stringify(project)}`,
          `HOME=${JSON.stringify(home)}`,
          `OPENCLAW_PREFIX=${JSON.stringify(prefix)}`,
          "OPENCLAW_VERSION=2026.5.19",
          `source ${JSON.stringify(process.cwd() + "/" + SCRIPT_PATH)}`,
          "ensure_git() { return 0; }",
          "install_openclaw",
        ].join("\n"),
      );
      argsOutput = readFileSync(argsLog, "utf8");
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }

    expect(result?.status).toBe(0);
    expect(argsOutput).toContain("--before=");
    expect(argsOutput).not.toContain("--min-release-age=0");
  });
});
