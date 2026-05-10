import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT_PATH = "scripts/install.sh";

function runInstallShell(script: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      OPENCLAW_INSTALL_SH_NO_RUN: "1",
      ...env,
    },
  });
}

describe("install.sh", () => {
  const script = readFileSync(SCRIPT_PATH, "utf8");

  it("runs apt-get through noninteractive wrappers", () => {
    expect(script).toContain("apt_get()");
    expect(script).toContain('DEBIAN_FRONTEND="${DEBIAN_FRONTEND:-noninteractive}"');
    expect(script).toContain('NEEDRESTART_MODE="${NEEDRESTART_MODE:-a}"');
    expect(script).toContain("sudo env DEBIAN_FRONTEND=");
    expect(script).toContain("-o Dpkg::Options::=--force-confdef");
    expect(script).toContain("-o Dpkg::Options::=--force-confold");

    const rawAptInstalls = script
      .split("\n")
      .filter((line) => /\b(?:sudo\s+)?apt-get\s+install\b/.test(line));
    expect(rawAptInstalls).toStrictEqual([]);
  });

  it("exports noninteractive apt env during Linux startup", () => {
    expect(script).toMatch(
      /detect_os_or_die\s+if \[\[ "\$OS" == "linux" \]\]; then\s+export DEBIAN_FRONTEND="\$\{DEBIAN_FRONTEND:-noninteractive\}"\s+export NEEDRESTART_MODE="\$\{NEEDRESTART_MODE:-a\}"\s+fi/m,
    );
    expect(script).toContain(
      'run_quiet_step "Configuring NodeSource repository" sudo -E bash "$tmp"',
    );
  });

  it("loads nvm before checking Node.js so stale system Node does not win", () => {
    expect(script).toMatch(
      /# Step 2: Node\.js\s+load_nvm_for_node_detection\s+if ! check_node; then/,
    );

    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-nvm-"));
    const home = join(tmp, "home");
    const systemBin = join(tmp, "system-bin");
    const nvmBin = join(home, ".nvm/versions/node/v22.22.1/bin");
    mkdirSync(systemBin, { recursive: true });
    mkdirSync(nvmBin, { recursive: true });
    mkdirSync(join(home, ".nvm"), { recursive: true });

    const systemNode = join(systemBin, "node");
    const nvmNode = join(nvmBin, "node");
    writeFileSync(systemNode, "#!/bin/sh\necho v8.11.3\n");
    writeFileSync(nvmNode, "#!/bin/sh\necho v22.22.1\n");
    chmodSync(systemNode, 0o755);
    chmodSync(nvmNode, 0o755);
    writeFileSync(
      join(home, ".nvm/nvm.sh"),
      [
        'NVM_DIR="${NVM_DIR:-$HOME/.nvm}"',
        "export NVM_DIR",
        "nvm() {",
        '  if [ "$1" = "use" ]; then',
        '    export PATH="$NVM_DIR/versions/node/v22.22.1/bin:$PATH"',
        "    return 0",
        "  fi",
        "  return 0",
        "}",
        "",
      ].join("\n"),
    );

    let result: ReturnType<typeof runInstallShell> | undefined;
    try {
      result = runInstallShell(
        [
          `cd ${JSON.stringify(process.cwd())}`,
          `source ${JSON.stringify(SCRIPT_PATH)}`,
          "set +e",
          "load_nvm_for_node_detection",
          "check_node",
          "status=$?",
          'printf "status=%s\\npath=%s\\nversion=%s\\n" "$status" "$(command -v node)" "$(node -v)"',
          "exit $status",
        ].join("\n"),
        {
          HOME: home,
          NVM_DIR: join(tmp, "stale-nvm"),
          PATH: `${systemBin}:/usr/bin:/bin`,
          TERM: "dumb",
        },
      );
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }

    expect(result?.status).toBe(0);
    const output = result?.stdout ?? "";
    expect(output).toContain("status=0");
    expect(output).toContain(`path=${nvmNode}`);
    expect(output).toContain("version=v22.22.1");
  });

  it("promotes a supported Linux Node binary over stale PATH entries", () => {
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-node-promote-"));
    const staleBin = join(tmp, "usr-local-bin");
    const supportedBin = join(tmp, "usr-bin");
    mkdirSync(staleBin, { recursive: true });
    mkdirSync(supportedBin, { recursive: true });

    const staleNode = join(staleBin, "node");
    const supportedNode = join(supportedBin, "node");
    writeFileSync(staleNode, "#!/bin/sh\necho v20.20.0\n");
    writeFileSync(supportedNode, "#!/bin/sh\necho v22.22.0\n");
    chmodSync(staleNode, 0o755);
    chmodSync(supportedNode, 0o755);

    let result: ReturnType<typeof runInstallShell> | undefined;
    try {
      result = runInstallShell(
        [
          `cd ${JSON.stringify(process.cwd())}`,
          `source ${JSON.stringify(SCRIPT_PATH)}`,
          "set +e",
          "OS=linux",
          "promote_supported_node_binary",
          "promote_status=$?",
          "ensure_default_node_active_shell",
          "active_status=$?",
          'printf "promote=%s\\nactive=%s\\npath=%s\\nversion=%s\\n" "$promote_status" "$active_status" "$(command -v node)" "$(node -v)"',
          "exit $active_status",
        ].join("\n"),
        {
          PATH: `${staleBin}:${supportedBin}:/usr/bin:/bin`,
          TERM: "dumb",
        },
      );
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }

    expect(result?.status).toBe(0);
    const output = result?.stdout ?? "";
    expect(output).toContain("promote=0");
    expect(output).toContain("active=0");
    expect(output).toContain(`path=${supportedNode}`);
    expect(output).toContain("version=v22.22.0");
  });

  it("persists a supported Linux Node path before noninteractive shell guards", () => {
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-linux-node-path-"));
    const home = join(tmp, "home");
    const oldBin = join(tmp, "old/bin");
    const installedBin = join(tmp, "usr/bin");
    mkdirSync(home, { recursive: true });
    mkdirSync(oldBin, { recursive: true });
    mkdirSync(installedBin, { recursive: true });

    const oldNode = join(oldBin, "node");
    const installedNode = join(installedBin, "node");
    writeFileSync(
      join(home, ".bashrc"),
      [
        "case $- in",
        "  *i*) ;;",
        "  *) return ;;",
        "esac",
        `export PATH="${installedBin}:$PATH"`,
        "",
      ].join("\n"),
    );
    writeFileSync(
      oldNode,
      [
        "#!/usr/bin/env bash",
        'if [[ "${1:-}" == "-p" ]]; then echo "20 20"; exit 0; fi',
        'if [[ "${1:-}" == "-v" ]]; then echo "v20.20.0"; exit 0; fi',
        "",
      ].join("\n"),
    );
    writeFileSync(
      installedNode,
      [
        "#!/usr/bin/env bash",
        'if [[ "${1:-}" == "-p" ]]; then echo "24 13"; exit 0; fi',
        'if [[ "${1:-}" == "-v" ]]; then echo "v24.13.0"; exit 0; fi',
        "",
      ].join("\n"),
    );
    chmodSync(oldNode, 0o755);
    chmodSync(installedNode, 0o755);

    let result: ReturnType<typeof runInstallShell> | undefined;
    try {
      result = runInstallShell(`
        set -euo pipefail
        source "${SCRIPT_PATH}"
        OS=linux
        HOME=${JSON.stringify(home)}
        PATH=${JSON.stringify(`${oldBin}:${installedBin}:/usr/bin:/bin`)}
        ui_info() { :; }
        activate_supported_node_on_path
        printf 'first=%s\\n' "$(sed -n '1p' "$HOME/.bashrc")"
        HOME=${JSON.stringify(home)} PATH=${JSON.stringify(`${oldBin}:${installedBin}:/usr/bin:/bin`)} bash -c 'source_rc() { . "$HOME/.bashrc"; }; source_rc; printf "node=%s\\n" "$(command -v node)"'
      `);
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }

    expect(result?.status).toBe(0);
    expect(result?.stdout).toContain(`first=export PATH="${installedBin}:$PATH"`);
    expect(result?.stdout).toContain(`node=${installedNode}`);
  });

  it("warns before redirecting an unwritable npm prefix", () => {
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-npm-prefix-"));
    const home = join(tmp, "home");
    const events = join(tmp, "events.log");
    mkdirSync(home, { recursive: true });

    let result: ReturnType<typeof runInstallShell> | undefined;
    try {
      result = runInstallShell(`
        set -euo pipefail
        source "${SCRIPT_PATH}"
        OS=linux
        HOME=${JSON.stringify(home)}
        prefix=${JSON.stringify(join(tmp, "root-owned-prefix"))}
        events=${JSON.stringify(events)}
        npm() {
          if [[ "$1" == "config" && "$2" == "get" && "$3" == "prefix" ]]; then
            printf '%s\\n' "$prefix"
            return 0
          fi
          if [[ "$1" == "config" && "$2" == "set" && "$3" == "prefix" ]]; then
            printf 'npm-set:%s\\n' "$4" >> "$events"
            return 0
          fi
          return 1
        }
        ui_info() { printf 'info:%s\\n' "$*" >> "$events"; }
        ui_warn() { printf 'warn:%s\\n' "$*" >> "$events"; }
        ui_success() { printf 'success:%s\\n' "$*" >> "$events"; }
        fix_npm_permissions
        cat "$events"
      `);
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }

    expect(result?.status).toBe(0);
    const lines = (result?.stdout ?? "").trim().split("\n");
    const warningIndex = lines.findIndex((line) =>
      line.includes("The installer will switch npm's user prefix"),
    );
    const npmSetIndex = lines.findIndex((line) => line.startsWith("npm-set:"));
    const noSudoWarningIndex = lines.findIndex((line) => line.includes("Avoid sudo npm i -g"));
    expect(warningIndex).toBeGreaterThanOrEqual(0);
    expect(npmSetIndex).toBeGreaterThan(warningIndex);
    expect(noSudoWarningIndex).toBeGreaterThan(npmSetIndex);
    expect(result?.stdout).toContain("npm global prefix is not writable");
    expect(result?.stdout).toContain("npm normally writes that setting to ~/.npmrc");
    expect(result?.stdout).toContain("npm i -g openclaw@latest");
    expect(result?.stdout).toContain("using this user prefix");
    expect(result?.stdout).not.toContain("has been saved");
  });

  it("persists npm prefix PATH before noninteractive shell guards", () => {
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-npm-prefix-shell-"));
    const home = join(tmp, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, ".bashrc"),
      [
        "case $- in",
        "  *i*) ;;",
        "  *) return ;;",
        "esac",
        'export PATH="$HOME/.npm-global/bin:$PATH"',
        "",
      ].join("\n"),
    );

    let result: ReturnType<typeof runInstallShell> | undefined;
    try {
      result = runInstallShell(`
        set -euo pipefail
        source "${SCRIPT_PATH}"
        OS=linux
        HOME=${JSON.stringify(home)}
        PATH=/usr/bin:/bin
        prefix=${JSON.stringify(join(tmp, "root-owned-prefix"))}
        npm() {
          if [[ "$1" == "config" && "$2" == "get" && "$3" == "prefix" ]]; then
            printf '%s\\n' "$prefix"
            return 0
          fi
          if [[ "$1" == "config" && "$2" == "set" && "$3" == "prefix" ]]; then
            return 0
          fi
          return 1
        }
        ui_info() { :; }
        ui_warn() { :; }
        ui_success() { :; }
        fix_npm_permissions
        printf 'first=%s\\n' "$(sed -n '1p' "$HOME/.bashrc")"
        HOME=${JSON.stringify(home)} PATH=/usr/bin:/bin bash -c 'source_rc() { . "$HOME/.bashrc"; }; source_rc; printf "path=%s\\n" "\${PATH%%:*}"'
      `);
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }

    expect(result?.status).toBe(0);
    expect(result?.stdout).toContain('first=export PATH="$HOME/.npm-global/bin:$PATH"');
    expect(result?.stdout).toContain(`path=${home}/.npm-global/bin`);
  });

  it("uses a quoted absolute openclaw path in follow-up commands when npm bin is not on the original PATH", () => {
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-command-"));
    const npmBin = join(tmp, "npm bin");
    const visibleBin = join(tmp, "visible-bin");
    mkdirSync(npmBin, { recursive: true });
    mkdirSync(visibleBin, { recursive: true });
    const openclawBin = join(npmBin, "openclaw");
    writeFileSync(openclawBin, "#!/bin/sh\nexit 0\n");
    chmodSync(openclawBin, 0o755);

    let result: ReturnType<typeof runInstallShell> | undefined;
    try {
      result = runInstallShell(`
        set -euo pipefail
        source "${SCRIPT_PATH}"
        ORIGINAL_PATH=${JSON.stringify(`${visibleBin}:/usr/bin:/bin`)}
        printf 'missing=%s\\n' "$(openclaw_command_for_user "${openclawBin}")"
        ORIGINAL_PATH=${JSON.stringify(`${npmBin}:${visibleBin}:/usr/bin:/bin`)}
        printf 'present=%s\\n' "$(openclaw_command_for_user "${openclawBin}")"
      `);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }

    expect(result?.status).toBe(0);
    expect(result?.stdout).toContain(`missing=${openclawBin.replace(/ /g, "\\ ")}`);
    expect(result?.stdout).toContain("present=openclaw");
  });
});

describe("install.sh macOS Homebrew Node behavior", () => {
  const script = readFileSync(SCRIPT_PATH, "utf8");

  it("stops when Homebrew node installation fails", () => {
    expect(script).toContain(
      'if ! run_quiet_step "Installing node@${NODE_DEFAULT_MAJOR}" brew install "node@${NODE_DEFAULT_MAJOR}"; then',
    );

    const failedInstallIndex = script.indexOf(
      'if ! run_quiet_step "Installing node@${NODE_DEFAULT_MAJOR}" brew install "node@${NODE_DEFAULT_MAJOR}"; then',
    );
    const brewLinkIndex = script.indexOf(
      'brew link "node@${NODE_DEFAULT_MAJOR}" --overwrite --force',
    );
    expect(failedInstallIndex).toBeGreaterThanOrEqual(0);
    expect(brewLinkIndex).toBeGreaterThan(failedInstallIndex);
  });

  it("aborts before brew link when Homebrew node installation fails at runtime", () => {
    const result = runInstallShell(`
      set -euo pipefail
      source "${SCRIPT_PATH}"
      OS=macos
      run_quiet_step() { echo "run_quiet_step:$*"; return 1; }
      brew() { echo "brew:$*"; return 0; }
      ensure_macos_default_node_active() { echo "ensure-called"; return 0; }
      if install_node; then
        echo "install_node returned success"
      else
        echo "install_node returned failure"
      fi
    `);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "Re-run with --verbose or run 'brew install node@24' directly, then rerun the installer.",
    );
    expect(result.stdout).not.toContain("brew:link");
    expect(result.stdout).not.toContain("ensure-called");
  });

  it("separates missing Homebrew node from PATH shadowing", () => {
    const missingNodeGuardIndex = script.indexOf(
      'if [[ -z "$brew_node_prefix" || ! -x "${brew_node_prefix}/bin/node" ]]; then',
    );
    const pathAdviceIndex = script.indexOf("Add this to your shell profile and restart shell:");

    expect(missingNodeGuardIndex).toBeGreaterThanOrEqual(0);
    expect(script).toContain(
      'ui_error "Homebrew node@${NODE_DEFAULT_MAJOR} is not installed on disk"',
    );
    expect(script).toContain('echo "  export PATH=\\"${brew_node_prefix}/bin:\\$PATH\\""');
    expect(pathAdviceIndex).toBeGreaterThan(missingNodeGuardIndex);
  });

  it("does not print PATH advice when Homebrew node is missing at runtime", () => {
    const result = runInstallShell(`
      set -euo pipefail
      source "${SCRIPT_PATH}"
      OS=macos
      missing_prefix="$(mktemp -d)/node@24"
      brew() {
        if [[ "$1" == "--prefix" ]]; then
          echo "$missing_prefix"
          return 0
        fi
        return 0
      }
      node_major_version() { echo 16; }
      if ensure_macos_default_node_active; then
        echo "ensure returned success"
      else
        echo "ensure returned failure"
      fi
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Homebrew node@24 is not installed on disk");
    expect(result.stdout).toContain("ensure returned failure");
    expect(result.stdout).not.toContain("Node.js v24 was installed");
    expect(result.stdout).not.toContain("Add this to your shell profile");
  });

  it("falls back when gum reports raw-mode ioctl failures", () => {
    expect(script).toContain("setrawmode|inappropriate ioctl");
    expect(script).toContain(
      'if "$GUM" spin --spinner dot --title "$title" -- "$@" >"$gum_out" 2>"$gum_err"; then',
    );
    expect(script).toContain(
      'if is_gum_raw_mode_failure "$gum_out" || is_gum_raw_mode_failure "$gum_err"; then',
    );
    expect(script).toContain(
      'ui_warn "Spinner unavailable in this terminal; continuing without spinner"',
    );
    expect(script).toContain('"$@"\n                return $?');
  });

  it("reruns spinner-wrapped commands when gum reports ioctl failure", () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-install-sh-gum-"));
    try {
      const gumPath = join(dir, "gum");
      const commandPath = join(dir, "command");
      const markerPath = join(dir, "marker");
      writeFileSync(
        gumPath,
        "#!/usr/bin/env bash\nprintf 'inappropriate ioctl for device\\n'\nexit 0\n",
        { mode: 0o755 },
      );
      writeFileSync(commandPath, `#!/usr/bin/env bash\nprintf 'ran' >"${markerPath}"\n`, {
        mode: 0o755,
      });

      const result = runInstallShell(`
        set -euo pipefail
        source "${SCRIPT_PATH}"
        gum_is_tty() { return 0; }
        GUM="${gumPath}"
        run_with_spinner "Installing node" "${commandPath}"
        cat "${markerPath}"
      `);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        "Spinner unavailable in this terminal; continuing without spinner",
      );
      expect(result.stdout).toContain("ran");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("install.sh duplicate OpenClaw install detection", () => {
  it("warns with concrete package paths and versions for duplicate npm roots", () => {
    const result = runInstallShell(`
      set -euo pipefail
      source "${SCRIPT_PATH}"
      root="$(mktemp -d)"
      trap 'rm -rf "$root"' EXIT
      mkdir -p "$root/brew/openclaw" "$root/fnm/openclaw"
      printf '{"version":"2026.3.7"}\\n' > "$root/brew/openclaw/package.json"
      printf '{"version":"2026.3.1"}\\n' > "$root/fnm/openclaw/package.json"
      collect_openclaw_npm_root_candidates() { printf '%s\\n' "$root/brew" "$root/fnm"; }
      OPENCLAW_BIN="$root/fnm/.bin/openclaw"
      ui_warn() { echo "WARN: $*"; }
      warn_duplicate_openclaw_global_installs
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Multiple OpenClaw global installs detected");
    expect(result.stdout).toContain("2026.3.7");
    expect(result.stdout).toContain("2026.3.1");
    expect(result.stdout).toContain("/brew/openclaw");
    expect(result.stdout).toContain("/fnm/openclaw");
    expect(result.stdout).toContain("Active openclaw:");
    expect(result.stdout).toContain("npm uninstall -g openclaw");
  });

  it("stays quiet when only one OpenClaw npm root exists", () => {
    const result = runInstallShell(`
      set -euo pipefail
      source "${SCRIPT_PATH}"
      root="$(mktemp -d)"
      trap 'rm -rf "$root"' EXIT
      mkdir -p "$root/only/openclaw"
      printf '{"version":"2026.3.7"}\\n' > "$root/only/openclaw/package.json"
      collect_openclaw_npm_root_candidates() { printf '%s\\n' "$root/only"; }
      ui_warn() { echo "WARN: $*"; }
      warn_duplicate_openclaw_global_installs
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("Multiple OpenClaw global installs detected");
  });
});
