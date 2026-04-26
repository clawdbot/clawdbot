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
    expect(rawAptInstalls).toEqual([]);
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
