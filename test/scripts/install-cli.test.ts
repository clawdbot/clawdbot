// Install Cli tests cover install cli script behavior.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  writeNpmBeforePolicyFixture,
  writeNpmFreshnessConflictFixture,
} from "./install-npm-fixtures.js";

const SCRIPT_PATH = "scripts/install-cli.sh";

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

describe("install-cli.sh", () => {
  const script = readFileSync(SCRIPT_PATH, "utf8");

  it("does not clean an unrelated legacy checkout during the default npm install", () => {
    const main = script.slice(script.indexOf("\nmain() {"));
    expect(main).not.toContain("cleanup_legacy_submodules");
    expect(script).toContain('cleanup_legacy_submodules "$repo_dir"');
  });

  it("accepts only Node versions with the required SQLite statement API", () => {
    const result = runInstallCliShell(`
      set -euo pipefail
      source "${SCRIPT_PATH}"
      set +e
      for version in 22.18.9 22.19.0 23.7.0 23.10.9 23.11.0 24.0.0; do
        node_version_is_supported "$version"
        printf '%s=%s\n' "$version" "$?"
      done
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("22.18.9=1");
    expect(result.stdout).toContain("22.19.0=0");
    expect(result.stdout).toContain("23.7.0=1");
    expect(result.stdout).toContain("23.10.9=1");
    expect(result.stdout).toContain("23.11.0=0");
    expect(result.stdout).toContain("24.0.0=0");
  });

  it("rejects an explicitly requested incompatible Node 23 release", () => {
    const result = runInstallCliShell(`
      set -euo pipefail
      source "${SCRIPT_PATH}"
      NODE_VERSION=23.7.0
      NODE_VERSION_REQUESTED=1
      install_node
    `);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "Node 23.7.0 is unsupported; use Node 22.19+, Node 23.11+, or Node 24+.",
    );
    expect(result.stdout).not.toContain("Installing Node 23.7.0");
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
      'CI="${CI:-true}" run_pnpm -C "$repo_dir" install "$install_lockfile_flag"',
    );
  });

  it("aligns pnpm to the checked-out repo packageManager before installing", () => {
    expect(script).toContain("activate_repo_pnpm_version()");
    expect(script).toContain('"$corepack_cmd" prepare "pnpm@${version}" --activate');
    expect(script).toContain('activate_repo_pnpm_version "$repo_dir"');
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
          "NODE_VERSION=22.22.0",
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
      const nodeLink = join(prefix, "tools", "node-v22.22.0", "bin", "node");
      const npmLink = join(prefix, "tools", "node-v22.22.0", "bin", "npm");
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
    const nodePrefixBin = join(prefix, "tools", "node-v22.22.0", "bin");
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
        "  printf 'v22.22.0\\n'",
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
          "NODE_VERSION=22.22.0",
          "NODE_VERSION_REQUESTED=1",
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
      const nodeLink = join(prefix, "tools", "node-v22.22.0", "bin", "node");
      const npmLink = join(prefix, "tools", "node-v22.22.0", "bin", "npm");
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
        "    printf 'v22.22.2\\n'",
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
          "NODE_VERSION=22.22.0",
          "NODE_VERSION_REQUESTED=1",
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
      const nodeLink = join(prefix, "tools", "node-v22.22.0", "bin", "node");
      const npmLink = join(prefix, "tools", "node-v22.22.0", "bin", "npm");
      expect(lstatSync(nodeLink).isSymbolicLink()).toBe(true);
      expect(readlinkSync(nodeLink)).toBe(fakeNode);
      expect(readlinkSync(npmLink)).toBe(fakeNpm);
      expect(script).toContain("apk add --no-cache git");
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
          "NODE_VERSION=22.22.0",
          "NODE_VERSION_REQUESTED=1",
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
        "Alpine Node package must provide Node >= 22.22.0 with node:sqlite",
      );
      expect(result.stdout).toContain("found v22.18.0");
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }
  });

  it("replaces cached generic Node runtimes below the runtime floor", () => {
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-cli-generic-stale-node-"));
    const prefix = join(tmp, "prefix");
    const nodePrefixBin = join(prefix, "tools", "node-v22.22.0", "bin");
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
        "  printf 'v22.22.0\\n'",
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
          "    */SHASUMS256.txt) printf 'fixture-sha  node-v22.22.0-linux-x64.tar.gz\\n' > \"$2\" ;;",
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
          "NODE_VERSION=22.22.0",
          "NODE_VERSION_REQUESTED=1",
          "install_node",
        ].join("\n"),
        {
          NEW_NODE: newNode,
          NEW_NPM: newNpm,
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Installing Node 22.22.0 (user-space)");
      expect(result.stdout).not.toContain('"status":"skip"');
      expect(readFileSync(staleNode, "utf8")).toContain("v22.22.0");
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
          "    */SHASUMS256.txt) printf 'fixture-sha  node-v22.19.0-linux-x64.tar.gz\\n' > \"$2\" ;;",
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
          "NODE_VERSION=22.19.0",
          "NODE_VERSION_REQUESTED=1",
          "install_node",
        ].join("\n"),
        {
          NEW_NODE: newNode,
          NEW_NPM: newNpm,
        },
      );

      expect(result.status).toBe(1);
      expect(result.stdout).toContain(
        "Installed Node 22.19.0 must provide Node >= 22.19.0 with node:sqlite",
      );
      expect(result.stdout).toContain("found v22.18.0");
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
          "NODE_VERSION=22.22.0",
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

  it("does not emit --before when raw user npmrc config contains min-release-age", () => {
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-cli-npmrc-"));
    const bin = join(tmp, "bin");
    const npmrc = join(tmp, "user.npmrc");
    const installArgs = join(tmp, "npm-install-args.txt");
    const prefix = join(tmp, "prefix");
    const nodeDir = join(tmp, "node");
    mkdirSync(bin, { recursive: true });
    mkdirSync(nodeDir, { recursive: true });
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

  it("does not emit --before when default global npmrc config contains min-release-age", () => {
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-cli-global-npmrc-"));
    const bin = join(tmp, "bin");
    const home = join(tmp, "home");
    const prefix = join(tmp, "prefix");
    const npmrc = join(prefix, "etc", "npmrc");
    const calls = join(tmp, "npm-calls.txt");
    const installArgs = join(tmp, "npm-install-args.txt");
    const installPrefix = join(tmp, "install-prefix");
    const nodeDir = join(tmp, "node");
    mkdirSync(bin, { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(nodeDir, { recursive: true });
    mkdirSync(join(prefix, "etc"), { recursive: true });
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
          NPM_FAKE_GLOBALCONFIG: npmrc,
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

  it("does not emit --before when builtin npmrc config contains min-release-age", () => {
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-cli-builtin-npmrc-"));
    const bin = join(tmp, "bin");
    const home = join(tmp, "home");
    const npmrc = join(tmp, "npmrc");
    const calls = join(tmp, "npm-calls.txt");
    const installArgs = join(tmp, "npm-install-args.txt");
    const installPrefix = join(tmp, "install-prefix");
    const nodeDir = join(tmp, "node");
    mkdirSync(bin, { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(nodeDir, { recursive: true });
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
          NPM_FAKE_GLOBALCONFIG: join(tmp, "missing-global-npmrc"),
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

  it("does not emit before args when npmrc min-release-age computes a before cutoff", () => {
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-cli-freshness-"));
    const prefix = join(tmp, "prefix");
    const home = join(tmp, "home");
    const nodeBin = join(prefix, "tools/node-v22.22.2/bin");
    const argsLog = join(tmp, "npm-args.log");
    mkdirSync(nodeBin, { recursive: true });
    mkdirSync(home, { recursive: true });
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
    const nodeBin = join(prefix, "tools/node-v22.22.2/bin");
    const argsLog = join(tmp, "npm-args.log");
    mkdirSync(nodeBin, { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(project, { recursive: true });
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
