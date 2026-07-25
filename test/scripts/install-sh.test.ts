// Install Sh tests cover install sh script behavior.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  writeNpmBeforePolicyFixture,
  writeNpmFreshnessConflictFixture,
} from "./install-npm-fixtures.js";

const SCRIPT_PATH = "scripts/install.sh";

function runInstallShell(script: string, env: NodeJS.ProcessEnv = {}) {
  const home = mkdtempSync(join(tmpdir(), "openclaw-install-home-"));
  try {
    return spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        ...env,
        BASH_ENV: "",
        ENV: "",
        OPENCLAW_INSTALL_SH_NO_RUN: "1",
      },
    });
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
}

describe("install.sh", () => {
  const script = readFileSync(SCRIPT_PATH, "utf8");

  it("runs installer snippets without inherited shell startup files", () => {
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-shell-env-"));
    const bashEnvPath = join(tmp, "bash_env");
    writeFileSync(bashEnvPath, "export OPENCLAW_BASH_ENV_LEAKED=1\n");

    try {
      const result = runInstallShell('printf "leaked=%s\\n" "${OPENCLAW_BASH_ENV_LEAKED:-0}"', {
        BASH_ENV: bashEnvPath,
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toBe("leaked=0\n");
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }
  });

  it("removes a downloaded script temp file when remote execution fails", () => {
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-remote-cleanup-"));
    const tempFile = join(tmp, "remote-script.sh");

    try {
      const result = runInstallShell(
        [
          "set -euo pipefail",
          `source ${JSON.stringify(SCRIPT_PATH)}`,
          'mktemp() { : > "$PROBE_PATH"; printf \'%s\\n\' "$PROBE_PATH"; }',
          "download_file() { printf '#!/bin/bash\\nexit 42\\n' > \"$2\"; }",
          'run_remote_bash "https://example.invalid/setup.sh"',
        ].join("\n"),
        { PROBE_PATH: tempFile },
      );

      expect(result.status).toBe(42);
      expect(existsSync(tempFile)).toBe(false);
      expect(script).not.toMatch(/\$\(\s*mktempfile\s*\)/);
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }
  });

  it("rejects malformed managed scripts without rendering their content", () => {
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-script-validation-"));
    writeFileSync(join(tmp, "empty.sh"), "");
    writeFileSync(join(tmp, "html.sh"), "<html><body>unexpected response</body></html>\n");
    writeFileSync(join(tmp, "nul-prefix.sh"), Buffer.from("\0#!/bin/bash\necho unexpected\n"));
    writeFileSync(join(tmp, "valid.sh"), "#!/bin/bash\necho valid\n");

    try {
      const result = runInstallShell(
        [
          "set -euo pipefail",
          `source ${JSON.stringify(SCRIPT_PATH)}`,
          "for fixture in empty.sh html.sh nul-prefix.sh; do",
          '  if validate_downloaded_script "$FIXTURE_DIR/$fixture" "https://example.invalid/$fixture"; then',
          '    printf "unexpectedly accepted: %s\\n" "$fixture"',
          "    exit 91",
          "  fi",
          "done",
          'validate_downloaded_script "$FIXTURE_DIR/valid.sh" "https://example.invalid/valid.sh"',
        ].join("\n"),
        { FIXTURE_DIR: tmp },
      );

      expect(result.status).toBe(0);
      expect(result.stdout + result.stderr).not.toContain("unexpected response");
      expect(result.stdout + result.stderr).not.toContain("echo unexpected");
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }
  });

  it("does not execute a shebang-prefixed partial file after download failure", () => {
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-partial-download-"));
    const marker = join(tmp, "executed");

    try {
      const result = runInstallShell(
        [
          "set -euo pipefail",
          `source ${JSON.stringify(SCRIPT_PATH)}`,
          'download_file() { printf \'#!/bin/bash\\n: > "$EXECUTION_MARKER"\\n\' > "$2"; return 23; }',
          "set +e",
          'run_remote_bash "https://example.invalid/partial.sh"',
          "status=$?",
          "set -e",
          'printf "status=%s\\n" "$status"',
          '[[ "$status" -ne 0 ]]',
        ].join("\n"),
        { EXECUTION_MARKER: marker },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("status=1");
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }
  });

  it("denies redirects for managed script downloads", () => {
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-managed-download-"));

    try {
      const result = runInstallShell(
        `
          set -euo pipefail
          source "${SCRIPT_PATH}"
          curl() { printf 'curl=%s\n' "$*"; }
          wget() { printf 'wget=%s\n' "$*"; }
          DOWNLOADER=curl
          download_file "https://example.invalid/setup.sh" "$DOWNLOAD_DIR/curl-setup.sh" deny
          DOWNLOADER=wget
          download_file "https://example.invalid/setup.sh" "$DOWNLOAD_DIR/wget-setup.sh" deny
          download_file() {
            printf 'managed-mode=%s\n' "\${3:-}"
            printf '#!/bin/bash\n' > "$2"
          }
          download_validated_script "https://example.invalid/setup.sh" "$DOWNLOAD_DIR/managed-setup.sh"
        `,
        { DOWNLOAD_DIR: tmp },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("curl=-fsSL --max-redirs 0");
      expect(result.stdout).toContain("wget=-q --max-redirect=0");
      expect(result.stdout).toContain("managed-mode=deny");
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }
  });

  it("bounds stalled curl downloads and propagates timeout failures", () => {
    const result = runInstallShell(`
      set -euo pipefail
      source "${SCRIPT_PATH}"
      curl() {
        printf 'curl=%s\n' "$*"
        return 28
      }
      DOWNLOADER=curl
      set +e
      download_file "https://example.invalid/archive.tgz" "/tmp/archive.tgz"
      printf 'status=%s\n' "$?"
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--speed-limit 1 --speed-time 30");
    expect(result.stdout).not.toContain("--connect-timeout");
    expect(result.stdout).not.toContain("--max-redirs");
    expect(result.stdout).toContain("--retry 3 --retry-delay 1 --retry-connrefused");
    expect(result.stdout).toContain("status=28");
  });

  it.each(["apt-get", "dnf", "yum"])(
    "rejects an invalid NodeSource response before %s repository setup",
    (packageManager) => {
      const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-nodesource-validation-"));
      const marker = join(tmp, "configured");

      try {
        const result = runInstallShell(
          `
            set -euo pipefail
            source "${SCRIPT_PATH}"
            OS=linux
            PACKAGE_MANAGER="$PACKAGE_MANAGER_UNDER_TEST"
            require_sudo() { :; }
            install_build_tools_linux() { return 0; }
            is_root() { return 0; }
            command() {
              if [[ "\${1:-}" == "-v" ]]; then
                case "\${2:-}" in
                  pacman|apk) return 1 ;;
                  apt-get|dnf|yum) [[ "$PACKAGE_MANAGER" == "$2" ]]; return ;;
                esac
              fi
              builtin command "$@"
            }
            download_file() {
              printf '<html>unexpected response</html>\n' > "$2"
            }
            ui_info() { printf 'info:%s\n' "$*"; }
            ui_success() { :; }
            ui_error() { printf 'error:%s\n' "$*"; }
            run_quiet_step() {
              local title="$1"
              shift
              printf 'step:%s|%s\n' "$title" "$*"
              if [[ "$title" == "Downloading NodeSource setup script" ]]; then
                "$@"
                return
              fi
              : > "$EXECUTION_MARKER"
              return 0
            }
            install_node
          `,
          { EXECUTION_MARKER: marker, PACKAGE_MANAGER_UNDER_TEST: packageManager },
        );

        expect(result.status).toBe(1);
        expect(result.stdout).toContain("step:Downloading NodeSource setup script");
        expect(result.stdout).not.toContain("unexpected response");
        expect(existsSync(marker)).toBe(false);
      } finally {
        rmSync(tmp, { force: true, recursive: true });
      }
    },
  );

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

  it("rejects unknown installer options", () => {
    const result = runInstallShell(`
      set -euo pipefail
      source "${SCRIPT_PATH}"
      parse_args --bogus
    `);

    expect(result.status).toBe(2);
    expect(result.stdout + result.stderr).toContain("Unknown option: --bogus");
  });

  it("rejects installer options with missing values", () => {
    const result = runInstallShell(`
      set -euo pipefail
      source "${SCRIPT_PATH}"
      parse_args --version --no-onboard
    `);

    expect(result.status).toBe(2);
    expect(result.stdout + result.stderr).toContain("Missing value for --version");
  });

  it("writes git install wrappers with the resolved Node runtime", () => {
    const result = runInstallShell(`
      set -euo pipefail
      source "${SCRIPT_PATH}"
      tmp="$(mktemp -d)"
      repo="$tmp/repo"
      node_dir="node-bin"
      cd "$tmp"
      mkdir -p "$repo/.git" "$repo/dist" "$node_dir"
      touch "$repo/dist/entry.js"
      cat > "$node_dir/node" <<'NODE'
#!/usr/bin/env bash
printf 'fake-node:%s\\n' "$*"
NODE
      chmod +x "$node_dir/node"
      PATH="$node_dir:/usr/bin:/bin"
      export PATH
      OS=macos
      check_git() { return 0; }
      ensure_pnpm() { :; }
      ensure_pnpm_binary_for_scripts() { :; }
      resolve_git_openclaw_ref() { printf 'main\\n'; }
      checkout_git_openclaw_ref() { :; }
      cleanup_legacy_submodules() { :; }
      activate_repo_pnpm_version() { :; }
      git_install_lockfile_flag() { printf '%s\\n' '--frozen-lockfile'; }
      run_quiet_step() { return 0; }
      ensure_user_local_bin_on_path() {
        mkdir -p "$HOME/.local/bin"
        export PATH="$HOME/.local/bin:$PATH"
      }
      ui_info() { :; }
      ui_success() { :; }
      ui_error() { printf 'error:%s\\n' "$*"; }
      git() {
        if [[ "$1" == "-C" && "$3" == "status" ]]; then
          return 0
        fi
        printf 'unexpected git:%s\\n' "$*" >&2
        return 1
      }

      install_openclaw_from_git "$repo"
      wrapper="$HOME/.local/bin/openclaw"
      grep -F "$tmp/$node_dir/node" "$wrapper"
      cd /
      PATH="/usr/bin:/bin" "$wrapper" --version
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("exec ");
    expect(result.stdout).toContain("/node-bin/node");
    expect(result.stdout).toContain("fake-node:");
    expect(result.stdout).toContain("/repo/dist/entry.js --version");
  });

  it("accepts GNU and musl Linux shells in OS detection", () => {
    expect(script).toContain('[[ "$OSTYPE" == "linux"* ]]');
    expect(script).not.toContain('[[ "$OSTYPE" == "linux-gnu"* ]]');
  });

  it("installs Node.js with apk on Alpine before falling back to NodeSource", () => {
    expect(script).toContain("finish_linux_node_install()");
    expect(script).toContain("is_alpine_linux()");
    expect(script).toContain("install_node_with_apk()");
    expect(script).toContain('ui_info "Installing Node.js via apk (Alpine Linux detected)"');
    expect(script).toContain(
      'run_required_step "Installing Node.js" apk add --no-cache nodejs npm',
    );
    expect(script).toContain(
      'run_required_step "Installing Node.js" sudo apk add --no-cache nodejs npm',
    );
    expect(script).toContain(
      'run_required_step "Installing nodejs-current" apk add --no-cache nodejs-current npm',
    );
    expect(script).toContain("if ! node_is_supported; then");

    const apkIndex = script.indexOf("if command -v apk &> /dev/null && is_alpine_linux; then");
    const nodeSourceIndex = script.indexOf('ui_info "Installing Node.js via NodeSource"');
    expect(apkIndex).toBeGreaterThan(-1);
    expect(nodeSourceIndex).toBeGreaterThan(apkIndex);
  });

  it("uses the apk Node.js installer path on Alpine", () => {
    const result = runInstallShell(`
      set -euo pipefail
      source "${SCRIPT_PATH}"
      OS=linux
      require_sudo() { :; }
      install_build_tools_linux() { return 0; }
      is_root() { return 0; }
      is_alpine_linux() { return 0; }
      ui_info() { printf 'info:%s\\n' "$*"; }
      ui_success() { printf 'success:%s\\n' "$*"; }
      run_quiet_step() { printf 'step:%s|%s\\n' "$1" "\${*:2}"; }
      apk() { :; }
      node_is_supported() { return 0; }
      finish_linux_node_install() { printf 'finish-linux-node\\n'; }
      install_node
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("info:Installing Node.js via apk (Alpine Linux detected)");
    expect(result.stdout).toContain("step:Installing Node.js|apk add --no-cache nodejs npm");
    expect(result.stdout).toContain("finish-linux-node");
    expect(result.stdout).not.toContain("Installing Node.js via NodeSource");
  });

  it("ignores an unrelated pacman command on Debian", () => {
    const result = runInstallShell(`
      set -euo pipefail
      source "${SCRIPT_PATH}"
      OS=linux
      require_sudo() { :; }
      install_build_tools_linux() { return 0; }
      is_root() { return 0; }
      is_arch_linux() { return 1; }
      is_alpine_linux() { return 1; }
      pacman() { printf 'pacman:%s\\n' "$*"; }
      apt-get() { :; }
      download_validated_script() { :; }
      ui_info() { printf 'info:%s\\n' "$*"; }
      ui_success() { :; }
      run_required_step() { printf 'step:%s|%s\\n' "$1" "\${*:2}"; }
      finish_linux_node_install() { printf 'finish-linux-node\\n'; }
      install_node
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("info:Installing Node.js via NodeSource");
    expect(result.stdout).toContain("step:Installing Node.js|apt_get_install nodejs");
    expect(result.stdout).toContain("finish-linux-node");
    expect(result.stdout).not.toContain("pacman:");
  });

  it("uses pacman for Node.js on Arch Linux", () => {
    const result = runInstallShell(`
      set -euo pipefail
      source "${SCRIPT_PATH}"
      OS=linux
      require_sudo() { :; }
      install_build_tools_linux() { return 0; }
      is_root() { return 0; }
      is_arch_linux() { return 0; }
      pacman() { :; }
      ui_info() { printf 'info:%s\\n' "$*"; }
      ui_success() { :; }
      run_required_step() { printf 'step:%s|%s\\n' "$1" "\${*:2}"; }
      finish_linux_node_install() { printf 'finish-linux-node\\n'; }
      install_node
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "info:Installing Node.js via pacman (Arch-based distribution detected)",
    );
    expect(result.stdout).toContain("step:Installing Node.js|pacman -Sy --noconfirm nodejs npm");
    expect(result.stdout).toContain("finish-linux-node");
    expect(result.stdout).not.toContain("Installing Node.js via NodeSource");
  });

  it("tries nodejs-current when Alpine nodejs is below the runtime floor", () => {
    const result = runInstallShell(`
      set -euo pipefail
      source "${SCRIPT_PATH}"
      OS=linux
      NODE_FAKE_VERSION=v20.15.1
      require_sudo() { :; }
      install_build_tools_linux() { return 0; }
      is_root() { return 0; }
      is_alpine_linux() { return 0; }
      ui_info() { printf 'info:%s\\n' "$*"; }
      ui_success() { printf 'success:%s\\n' "$*"; }
      ui_warn() { printf 'warn:%s\\n' "$*"; }
      run_quiet_step() {
        printf 'step:%s|%s\\n' "$1" "\${*:2}"
        "\${@:2}"
      }
      apk() {
        printf 'apk:%s\\n' "$*"
        if [[ "$*" == *"nodejs-current"* ]]; then
          NODE_FAKE_VERSION=v22.22.3
        fi
      }
      node() {
        if [[ "\${1:-}" == "-v" ]]; then
          printf '%s\\n' "$NODE_FAKE_VERSION"
        fi
      }
      activate_supported_node_on_path() { :; }
      finish_linux_node_install() { printf 'finish-linux-node\\n'; }
      install_node
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("step:Installing Node.js|apk add --no-cache nodejs npm");
    expect(result.stdout).toContain("warn:Alpine nodejs package installed v20.15.1");
    expect(result.stdout).toContain(
      "step:Installing nodejs-current|apk add --no-cache nodejs-current npm",
    );
    expect(result.stdout).toContain("finish-linux-node");
  });

  it("fails with Alpine guidance when apk cannot provide a safe SQLite runtime", () => {
    const result = runInstallShell(`
      set -euo pipefail
      source "${SCRIPT_PATH}"
      OS=linux
      NODE_FAKE_VERSION=v20.15.1
      require_sudo() { :; }
      install_build_tools_linux() { return 0; }
      is_root() { return 0; }
      is_alpine_linux() { return 0; }
      ui_info() { printf 'info:%s\\n' "$*"; }
      ui_success() { printf 'success:%s\\n' "$*"; }
      ui_warn() { printf 'warn:%s\\n' "$*"; }
      ui_error() { printf 'error:%s\\n' "$*"; }
      run_quiet_step() {
        printf 'step:%s|%s\\n' "$1" "\${*:2}"
        "\${@:2}"
      }
      apk() {
        printf 'apk:%s\\n' "$*"
        if [[ "$*" == *"nodejs-current"* ]]; then
          NODE_FAKE_VERSION=v21.7.3
        fi
      }
      node() {
        if [[ "\${1:-}" == "-v" ]]; then
          printf '%s\\n' "$NODE_FAKE_VERSION"
        fi
      }
      activate_supported_node_on_path() { :; }
      install_node
    `);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("warn:Alpine nodejs package installed v20.15.1");
    expect(result.stdout).toContain(
      "step:Installing nodejs-current|apk add --no-cache nodejs-current npm",
    );
    expect(result.stdout).toContain(
      "error:Alpine apk repositories did not provide Node.js with WAL-reset-safe SQLite",
    );
    expect(result.stdout).toContain(
      "Use an official node:24-alpine container or a glibc-based host",
    );
  });

  it("stops when NodeSource repository setup fails", () => {
    const result = runInstallShell(`
      set -euo pipefail
      source "${SCRIPT_PATH}"
      OS=linux
      require_sudo() { :; }
      install_build_tools_linux() { return 0; }
      is_root() { return 0; }
      is_alpine_linux() { return 1; }
      apt-get() { :; }
      download_validated_script() { return 0; }
      ui_info() { printf 'info:%s\\n' "$*"; }
      ui_success() { printf 'success:%s\\n' "$*"; }
      ui_error() { printf 'error:%s\\n' "$*"; }
      run_quiet_step() {
        printf 'step:%s|%s\\n' "$1" "\${*:2}"
        if [[ "$1" == "Configuring NodeSource repository" ]]; then
          return 64
        fi
        return 0
      }
      node() {
        if [[ "\${1:-}" == "-v" ]]; then
          printf 'v24.0.0\\n'
        fi
      }
      activate_supported_node_on_path() { :; }
      if install_node; then
        echo "install_node returned success"
      fi
    `);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("step:Configuring NodeSource repository|bash");
    expect(result.stdout).not.toContain("step:Installing Node.js|apt_get_install nodejs");
    expect(result.stdout).not.toContain("success:Node.js v24.0.0 installed");
    expect(result.stdout).not.toContain("install_node returned success");
  });

  it("stops when apt cannot install the Node.js package", () => {
    const result = runInstallShell(`
      set -euo pipefail
      source "${SCRIPT_PATH}"
      OS=linux
      require_sudo() { :; }
      install_build_tools_linux() { return 0; }
      is_root() { return 0; }
      is_alpine_linux() { return 1; }
      apt-get() { :; }
      download_validated_script() { return 0; }
      ui_info() { printf 'info:%s\\n' "$*"; }
      ui_success() { printf 'success:%s\\n' "$*"; }
      ui_error() { printf 'error:%s\\n' "$*"; }
      run_quiet_step() {
        printf 'step:%s|%s\\n' "$1" "\${*:2}"
        if [[ "$1" == "Installing Node.js" ]]; then
          return 65
        fi
        return 0
      }
      node() {
        if [[ "\${1:-}" == "-v" ]]; then
          printf 'v24.0.0\\n'
        fi
      }
      activate_supported_node_on_path() { :; }
      if install_node; then
        echo "install_node returned success"
      fi
    `);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("step:Configuring NodeSource repository|bash");
    expect(result.stdout).toContain("step:Installing Node.js|apt_get_install nodejs");
    expect(result.stdout).not.toContain("success:Node.js v24.0.0 installed");
    expect(result.stdout).not.toContain("install_node returned success");
  });

  it("installs Git with apk on Alpine", () => {
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-git-apk-"));
    const bin = join(tmp, "bin");
    const apkLog = join(tmp, "apk-args.txt");
    mkdirSync(bin, { recursive: true });
    const fakeApk = join(bin, "apk");
    writeFileSync(
      fakeApk,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `printf '%s\\n' "$*" >> ${JSON.stringify(apkLog)}`,
        "",
      ].join("\n"),
    );
    chmodSync(fakeApk, 0o755);

    try {
      const result = runInstallShell(`
        set -euo pipefail
        source "${SCRIPT_PATH}"
        PATH=${JSON.stringify(`${bin}:/bin`)}
        OS=linux
        require_sudo() { :; }
        is_root() { return 0; }
        is_alpine_linux() { return 0; }
        ui_success() { printf 'success:%s\\n' "$*"; }
        ui_error() { printf 'error:%s\\n' "$*"; }
        run_quiet_step() {
          printf 'step:%s|%s\\n' "$1" "\${*:2}"
          "\${@:2}"
        }
        install_git
      `);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("step:Installing Git|apk add --no-cache git");
      expect(result.stdout).toContain("success:Git installed");
      expect(readFileSync(apkLog, "utf8").trim()).toBe("add --no-cache git");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not select apk Git on non-Alpine hosts", () => {
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-git-native-"));
    const bin = join(tmp, "bin");
    const apkLog = join(tmp, "apk-args.txt");
    mkdirSync(bin, { recursive: true });
    const fakeApk = join(bin, "apk");
    const fakeApt = join(bin, "apt-get");
    writeFileSync(apkLog, "");
    writeFileSync(
      fakeApk,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `printf '%s\\n' "$*" >> ${JSON.stringify(apkLog)}`,
        "",
      ].join("\n"),
    );
    writeFileSync(fakeApt, "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(fakeApk, 0o755);
    chmodSync(fakeApt, 0o755);

    try {
      const result = runInstallShell(`
        set -euo pipefail
        source "${SCRIPT_PATH}"
        PATH=${JSON.stringify(`${bin}:/bin`)}
        OS=linux
        require_sudo() { :; }
        is_root() { return 0; }
        is_alpine_linux() { return 1; }
        apt_get_update() { printf 'apt-update\\n'; }
        apt_get_install() { printf 'apt-install:%s\\n' "$*"; }
        ui_success() { printf 'success:%s\\n' "$*"; }
        ui_error() { printf 'error:%s\\n' "$*"; }
        run_quiet_step() {
          printf 'step:%s|%s\\n' "$1" "\${*:2}"
          "\${@:2}"
        }
        install_git
      `);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("step:Updating package index|apt_get_update");
      expect(result.stdout).toContain("apt-update");
      expect(result.stdout).toContain("step:Installing Git|apt_get_install git");
      expect(result.stdout).toContain("apt-install:git");
      expect(readFileSync(apkLog, "utf8")).toBe("");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("clears npm freshness filters for package installs", () => {
    expect(script).toContain("env -u NPM_CONFIG_BEFORE -u npm_config_before");
    expect(script).toContain('freshness_flag="--min-release-age=0"');
    expect(script).toContain('npm_config_has_raw_key npm "min-release-age"');
    expect(script).toContain('freshness_flag="--before=$(date -u');
    expect(script).toContain('cmd+=(--no-fund --no-audit "$freshness_flag" install -g "$spec")');
  });

  it("does not emit --before when raw user npmrc config contains min-release-age", () => {
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-npmrc-"));
    const bin = join(tmp, "bin");
    const home = join(tmp, "home");
    const npmrc = join(tmp, "user.npmrc");
    const calls = join(tmp, "npm-calls.txt");
    const installArgs = join(tmp, "npm-install-args.txt");
    mkdirSync(bin, { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(npmrc, "min-release-age=7\n");
    const fakeNpm = join(bin, "npm");
    writeFileSync(
      fakeNpm,
      [
        "#!/usr/bin/env bash",
        'printf "%s\\n" "$*" >> "$NPM_FAKE_CALLS"',
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
      const result = runInstallShell(
        [
          "set -euo pipefail",
          `cd ${JSON.stringify(process.cwd())}`,
          `source ${JSON.stringify(SCRIPT_PATH)}`,
          `run_npm_global_install openclaw@latest ${JSON.stringify(join(tmp, "install.log"))}`,
          'printf "cmd=%s\\n" "$LAST_NPM_INSTALL_CMD"',
        ].join("\n"),
        {
          HOME: home,
          NPM_CONFIG_USERCONFIG: npmrc,
          NPM_FAKE_CALLS: calls,
          NPM_FAKE_INSTALL_ARGS: installArgs,
          PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`,
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("--min-release-age=0");
      expect(result.stdout).not.toContain("--before=");
      expect(readFileSync(installArgs, "utf8")).toContain("--min-release-age=0\n");
      expect(readFileSync(installArgs, "utf8")).not.toContain("--before=");
      expect(readFileSync(calls, "utf8")).not.toContain("config get before");
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }
  });

  it("does not emit --before when default global npmrc config contains min-release-age", () => {
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-global-npmrc-"));
    const bin = join(tmp, "bin");
    const home = join(tmp, "home");
    const prefix = join(tmp, "prefix");
    const npmrc = join(prefix, "etc", "npmrc");
    const calls = join(tmp, "npm-calls.txt");
    const installArgs = join(tmp, "npm-install-args.txt");
    mkdirSync(bin, { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(join(prefix, "etc"), { recursive: true });
    writeFileSync(npmrc, "min-release-age=7\n");
    const fakeNpm = join(bin, "npm");
    writeFileSync(
      fakeNpm,
      [
        "#!/usr/bin/env bash",
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
      const result = runInstallShell(
        [
          "set -euo pipefail",
          `cd ${JSON.stringify(process.cwd())}`,
          `source ${JSON.stringify(SCRIPT_PATH)}`,
          `run_npm_global_install openclaw@latest ${JSON.stringify(join(tmp, "install.log"))}`,
          'printf "cmd=%s\\n" "$LAST_NPM_INSTALL_CMD"',
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
      expect(result.stdout).toContain("--min-release-age=0");
      expect(result.stdout).not.toContain("--before=");
      expect(readFileSync(installArgs, "utf8")).toContain("--min-release-age=0\n");
      expect(readFileSync(installArgs, "utf8")).not.toContain("--before=");
      expect(readFileSync(calls, "utf8")).not.toContain("config get before");
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }
  });

  it("does not emit --before when builtin npmrc config contains min-release-age", () => {
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-builtin-npmrc-"));
    const bin = join(tmp, "bin");
    const home = join(tmp, "home");
    const npmrc = join(tmp, "npmrc");
    const calls = join(tmp, "npm-calls.txt");
    const installArgs = join(tmp, "npm-install-args.txt");
    mkdirSync(bin, { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(npmrc, "min-release-age=7\n");
    const fakeNpm = join(bin, "npm");
    writeFileSync(
      fakeNpm,
      [
        "#!/usr/bin/env bash",
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
      const result = runInstallShell(
        [
          "set -euo pipefail",
          `cd ${JSON.stringify(process.cwd())}`,
          `source ${JSON.stringify(SCRIPT_PATH)}`,
          `run_npm_global_install openclaw@latest ${JSON.stringify(join(tmp, "install.log"))}`,
          'printf "cmd=%s\\n" "$LAST_NPM_INSTALL_CMD"',
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
      expect(result.stdout).toContain("--min-release-age=0");
      expect(result.stdout).not.toContain("--before=");
      expect(readFileSync(installArgs, "utf8")).toContain("--min-release-age=0\n");
      expect(readFileSync(installArgs, "utf8")).not.toContain("--before=");
      expect(readFileSync(calls, "utf8")).not.toContain("config get before");
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }
  });

  it("uses OPENCLAW_HOME for git defaults", () => {
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-home-"));
    const osHome = join(tmp, "os-home");
    const openclawHome = join(tmp, "openclaw-home");
    mkdirSync(osHome, { recursive: true });
    mkdirSync(openclawHome, { recursive: true });

    let result: ReturnType<typeof runInstallShell> | undefined;
    try {
      result = runInstallShell(
        [
          `cd ${JSON.stringify(process.cwd())}`,
          `source ${JSON.stringify(SCRIPT_PATH)}`,
          'printf "git=%s\\n" "$GIT_DIR"',
        ].join("\n"),
        {
          HOME: osHome,
          OPENCLAW_HOME: openclawHome,
          OPENCLAW_GIT_DIR: undefined,
          TERM: "dumb",
        },
      );
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }

    expect(result?.status).toBe(0);
    const output = result?.stdout ?? "";
    expect(output).toContain(`git=${join(openclawHome, "openclaw")}`);
    const mkdirParentIndex = script.indexOf('mkdir -p "$(dirname "$repo_dir")"');
    const cloneIndex = script.indexOf(
      'run_quiet_step "Cloning OpenClaw" git clone "$repo_url" "$repo_dir"',
    );
    expect(mkdirParentIndex).toBeGreaterThan(-1);
    expect(cloneIndex).toBeGreaterThan(-1);
    expect(mkdirParentIndex).toBeLessThan(cloneIndex);
  });

  it("does not treat OS HOME config as active when OPENCLAW_HOME is set", () => {
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-legacy-config-"));
    const osHome = join(tmp, "os-home");
    const openclawHome = join(tmp, "openclaw-home");
    const legacyConfigDir = join(osHome, ".openclaw");
    mkdirSync(legacyConfigDir, { recursive: true });
    mkdirSync(openclawHome, { recursive: true });
    writeFileSync(join(legacyConfigDir, "openclaw.json"), "{}\n");

    let result: ReturnType<typeof runInstallShell> | undefined;
    try {
      result = runInstallShell(
        [
          `cd ${JSON.stringify(process.cwd())}`,
          `source ${JSON.stringify(SCRIPT_PATH)}`,
          'if has_openclaw_config; then printf "configured=1\\n"; else printf "configured=0\\n"; fi',
        ].join("\n"),
        {
          HOME: osHome,
          OPENCLAW_HOME: openclawHome,
          OPENCLAW_CONFIG_PATH: undefined,
          TERM: "dumb",
        },
      );
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }

    expect(result?.status).toBe(0);
    expect(result?.stdout).toContain("configured=0");
    expect(result?.stderr ?? "").toBe("");
  });

  it.each(["openclaw.json", "clawdbot.json"])(
    "detects %s under OPENCLAW_STATE_DIR",
    (configName) => {
      const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-state-config-"));
      const stateDir = join(tmp, "state");
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, configName), "{}\n");

      let result: ReturnType<typeof runInstallShell> | undefined;
      try {
        result = runInstallShell(
          [
            `cd ${JSON.stringify(process.cwd())}`,
            `source ${JSON.stringify(SCRIPT_PATH)}`,
            'if has_openclaw_config; then printf "configured=1\\n"; else printf "configured=0\\n"; fi',
          ].join("\n"),
          {
            OPENCLAW_CONFIG_PATH: undefined,
            OPENCLAW_STATE_DIR: stateDir,
            TERM: "dumb",
          },
        );
      } finally {
        rmSync(tmp, { force: true, recursive: true });
      }

      expect(result?.status).toBe(0);
      expect(result?.stdout).toContain("configured=1");
      expect(result?.stderr ?? "").toBe("");
    },
  );

  it("does not fall back to home config when OPENCLAW_STATE_DIR is set", () => {
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-state-override-"));
    const home = join(tmp, "home");
    const stateDir = join(tmp, "state");
    mkdirSync(join(home, ".openclaw"), { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(home, ".openclaw", "openclaw.json"), "{}\n");

    let result: ReturnType<typeof runInstallShell> | undefined;
    try {
      result = runInstallShell(
        [
          `cd ${JSON.stringify(process.cwd())}`,
          `source ${JSON.stringify(SCRIPT_PATH)}`,
          'if has_openclaw_config; then printf "configured=1\\n"; else printf "configured=0\\n"; fi',
        ].join("\n"),
        {
          HOME: home,
          OPENCLAW_CONFIG_PATH: undefined,
          OPENCLAW_HOME: undefined,
          OPENCLAW_STATE_DIR: stateDir,
          TERM: "dumb",
        },
      );
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }

    expect(result?.status).toBe(0);
    expect(result?.stdout).toContain("configured=0");
    expect(result?.stderr ?? "").toBe("");
  });

  it.each([
    {
      expected: /No TTY; run .*\/\.local\/bin\/openclaw onboard to finish setup/,
      name: "starts setup",
      noOnboard: 0,
    },
    {
      expected: /Skipping onboard .*run .*\/\.local\/bin\/openclaw onboard later/,
      name: "honors --no-onboard",
      noOnboard: 1,
    },
  ])(
    "$name for an unconfigured git install replacing an existing binary",
    ({ expected, noOnboard }) => {
      const result = runInstallShell(`
      set -euo pipefail
      source "${SCRIPT_PATH}"
      INSTALL_METHOD=git
      GIT_DIR="$HOME/openclaw"
      NO_ONBOARD=${noOnboard}
      NO_PROMPT=1
      VERIFY_INSTALL=1
      OS=linux

      bootstrap_gum_temp() { :; }
      print_installer_banner() { :; }
      print_gum_status() { :; }
      detect_os_or_die() { OS=linux; }
      detect_openclaw_checkout() { return 1; }
      show_install_plan() { :; }
      check_existing_openclaw() { return 0; }
      load_nvm_for_node_detection() { :; }
      check_node() { return 0; }
      activate_supported_node_on_path() { :; }
      ensure_default_node_active_shell() { return 0; }
      npm() { return 1; }
      install_openclaw_from_git() {
        mkdir -p "$HOME/.local/bin"
        printf '#!/bin/sh\\nexit 0\\n' > "$HOME/.local/bin/openclaw"
        chmod +x "$HOME/.local/bin/openclaw"
        export PATH="$HOME/.local/bin:$PATH"
      }
      resolve_openclaw_bin() { printf '%s\\n' "$HOME/.local/bin/openclaw"; }
      warn_duplicate_openclaw_global_installs() { :; }
      npm_global_bin_dir() { :; }
      warn_shell_path_missing_dir() { :; }
      refresh_gateway_service_if_loaded() { printf 'gateway-refresh-called\\n'; }
      run_doctor() {
        printf 'doctor-called\\n'
        return 0
      }
      resolve_openclaw_version() { printf 'test-version\\n'; }
      is_gateway_daemon_loaded() {
        printf 'gateway-probe-called\\n'
        return 1
      }
      maybe_open_dashboard() { :; }
      show_footer_links() { :; }

      main
    `);

      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain("doctor-called");
      expect(result.stdout).not.toContain("gateway-refresh-called");
      expect(result.stdout).not.toContain("gateway-probe-called");
      expect(result.stdout).toMatch(/Update command:.*\/\.local\/bin\/openclaw update/);
      expect(result.stdout).toMatch(expected);
    },
  );

  it("honors --verify for an unconfigured install without a TTY", () => {
    const result = runInstallShell(`
      set -euo pipefail
      source "${SCRIPT_PATH}"
      INSTALL_METHOD=git
      GIT_DIR="$HOME/openclaw"
      NO_ONBOARD=0
      NO_PROMPT=1
      VERIFY_INSTALL=1
      OS=linux

      bootstrap_gum_temp() { :; }
      print_installer_banner() { :; }
      print_gum_status() { :; }
      detect_os_or_die() { OS=linux; }
      detect_openclaw_checkout() { return 1; }
      show_install_plan() { :; }
      check_existing_openclaw() { return 0; }
      load_nvm_for_node_detection() { :; }
      check_node() { return 0; }
      activate_supported_node_on_path() { :; }
      ensure_default_node_active_shell() { return 0; }
      npm() { return 1; }
      install_openclaw_from_git() {
        mkdir -p "$HOME/.local/bin"
        printf '#!/bin/sh\\nexit 1\\n' > "$HOME/.local/bin/openclaw"
        chmod +x "$HOME/.local/bin/openclaw"
        export PATH="$HOME/.local/bin:$PATH"
      }
      resolve_openclaw_bin() { printf '%s\\n' "$HOME/.local/bin/openclaw"; }
      warn_duplicate_openclaw_global_installs() { :; }
      npm_global_bin_dir() { :; }
      warn_shell_path_missing_dir() { :; }
      refresh_gateway_service_if_loaded() { :; }
      resolve_openclaw_version() { printf 'test-version\\n'; }
      maybe_open_dashboard() { :; }
      show_footer_links() { :; }

      main
    `);

    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/No TTY; run .*\/\.local\/bin\/openclaw onboard to finish setup/);
  });

  it("runs migration doctor for a configured upgrade without a TTY", () => {
    const result = runInstallShell(`
      set -euo pipefail
      source "${SCRIPT_PATH}"
      INSTALL_METHOD=npm
      NO_ONBOARD=0
      NO_PROMPT=0
      OS=linux
      mkdir -p "$HOME/.openclaw"
      printf '{}\\n' > "$HOME/.openclaw/openclaw.json"

      bootstrap_gum_temp() { :; }
      print_installer_banner() { :; }
      print_gum_status() { :; }
      detect_os_or_die() { OS=linux; }
      detect_openclaw_checkout() { return 1; }
      show_install_plan() { :; }
      check_existing_openclaw() { return 0; }
      load_nvm_for_node_detection() { :; }
      check_node() { return 0; }
      activate_supported_node_on_path() { :; }
      ensure_default_node_active_shell() { return 0; }
      check_git() { return 0; }
      fix_npm_permissions() { :; }
      install_openclaw() {
        mkdir -p "$HOME/.local/bin"
        printf '#!/bin/sh\\nexit 0\\n' > "$HOME/.local/bin/openclaw"
        chmod +x "$HOME/.local/bin/openclaw"
        export PATH="$HOME/.local/bin:$PATH"
      }
      resolve_openclaw_bin() { printf '%s\\n' "$HOME/.local/bin/openclaw"; }
      warn_duplicate_openclaw_global_installs() { :; }
      npm_global_bin_dir() { :; }
      warn_shell_path_missing_dir() { :; }
      refresh_gateway_service_if_loaded() { :; }
      run_doctor() {
        printf 'doctor-called\\n'
        return 0
      }
      resolve_openclaw_version() { printf 'test-version\\n'; }
      is_gateway_daemon_loaded() { return 1; }
      verify_installation() { return 0; }
      maybe_open_dashboard() { printf 'dashboard-called\\n'; }
      show_footer_links() { :; }

      main
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("doctor-called");
    expect(result.stdout).toContain("dashboard-called");
  });

  it("rejects OpenClaw GitHub source targets for npm installs", () => {
    const result = runInstallShell(`
      set -euo pipefail
      source "${SCRIPT_PATH}"
      set +e
      OPENCLAW_VERSION=main
      USE_BETA=0
      install_openclaw
      status=$?
      printf 'status=%s\\n' "$status"
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("status=1");
    expect(result.stdout).toContain("npm installs do not support OpenClaw GitHub source targets");
    expect(result.stdout).toContain("--install-method git --version main");
  });

  it("does not emit before args when npmrc min-release-age computes a before cutoff", () => {
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-npm-freshness-"));
    const bin = join(tmp, "bin");
    const home = join(tmp, "home");
    const argsLog = join(tmp, "npm-args.log");
    mkdirSync(bin, { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, ".npmrc"), "min-release-age=7\n");
    writeNpmFreshnessConflictFixture(join(bin, "npm"), argsLog);

    let result: ReturnType<typeof runInstallShell> | undefined;
    let argsOutput;
    try {
      result = runInstallShell(
        [
          "set -euo pipefail",
          `source ${JSON.stringify(SCRIPT_PATH)}`,
          `HOME=${JSON.stringify(home)}`,
          `PATH=${JSON.stringify(`${bin}:/usr/bin:/bin`)}`,
          "NPM_LOGLEVEL=error",
          "NPM_SILENT_FLAG=",
          `run_npm_global_install openclaw@latest ${JSON.stringify(join(tmp, "install.log"))}`,
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
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-global-freshness-"));
    const bin = join(tmp, "bin");
    const home = join(tmp, "home");
    const project = join(tmp, "project");
    const argsLog = join(tmp, "npm-args.log");
    mkdirSync(bin, { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(join(home, ".npmrc"), "before=2026-01-01T00:00:00.000Z\n");
    writeFileSync(join(project, ".npmrc"), "min-release-age=7\n");
    writeNpmBeforePolicyFixture(join(bin, "npm"), argsLog);

    let result: ReturnType<typeof runInstallShell> | undefined;
    let argsOutput;
    try {
      result = runInstallShell(
        [
          "set -euo pipefail",
          `cd ${JSON.stringify(project)}`,
          `source ${JSON.stringify(process.cwd() + "/" + SCRIPT_PATH)}`,
          `HOME=${JSON.stringify(home)}`,
          `PATH=${JSON.stringify(`${bin}:/usr/bin:/bin`)}`,
          "NPM_LOGLEVEL=error",
          "NPM_SILENT_FLAG=",
          `run_npm_global_install openclaw@latest ${JSON.stringify(join(tmp, "install.log"))}`,
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

  it("exports noninteractive apt env during Linux startup", () => {
    expect(script).toMatch(
      /detect_os_or_die\s+if \[\[ "\$OS" == "linux" \]\]; then\s+export DEBIAN_FRONTEND="\$\{DEBIAN_FRONTEND:-noninteractive\}"\s+export NEEDRESTART_MODE="\$\{NEEDRESTART_MODE:-a\}"\s+fi/m,
    );
    expect(script).toContain(
      'run_required_step "Configuring NodeSource repository" sudo -E bash "$tmp"',
    );
  });

  it("counts the verify stage when --verify is enabled", () => {
    const result = runInstallShell(
      [
        `source ${JSON.stringify(SCRIPT_PATH)}`,
        "parse_args --verify",
        "configure_install_stage_total",
        'ui_stage "Preparing environment"',
        'ui_stage "Installing OpenClaw"',
        'ui_stage "Finalizing setup"',
        'ui_stage "Verifying installation"',
      ].join("\n"),
      { TERM: "dumb" },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[4/4] Verifying installation");
    expect(result.stdout).not.toContain("[4/3] Verifying installation");
  });

  it("bounds installer npm prefix probes during finalization helpers", () => {
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-npm-probe-"));
    const npm = join(tmp, "npm");
    writeFileSync(
      npm,
      [
        "#!/usr/bin/env bash",
        'if [[ "$1" == "prefix" && "$2" == "-g" ]]; then',
        "  sleep 2",
        "  exit 0",
        "fi",
        'if [[ "$1" == "config" && "$2" == "get" && "$3" == "prefix" ]]; then',
        '  printf "/tmp/openclaw-npm\\n"',
        "  exit 0",
        "fi",
        "exit 1",
        "",
      ].join("\n"),
    );
    chmodSync(npm, 0o755);

    try {
      const result = runInstallShell(
        [`source ${JSON.stringify(SCRIPT_PATH)}`, "npm_global_bin_dir"].join("\n"),
        {
          OPENCLAW_INSTALL_PROBE_TIMEOUT_SECONDS: "0.1",
          PATH: `${tmp}:${process.env.PATH ?? ""}`,
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("/tmp/openclaw-npm/bin");
      expect(result.stderr).toContain(
        "timed out during installer finalization probe: npm prefix -g",
      );
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }
  });

  it("bounds daemon status probes during finalization helpers", () => {
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-probe-"));
    const claw = join(tmp, "openclaw");
    writeFileSync(
      claw,
      [
        "#!/usr/bin/env bash",
        'if [[ "$1" == "daemon" && "$2" == "status" && "$3" == "--json" ]]; then',
        "  sleep 2",
        "  exit 0",
        "fi",
        "exit 1",
        "",
      ].join("\n"),
    );
    chmodSync(claw, 0o755);
    try {
      const result = runInstallShell(
        [
          `source ${JSON.stringify(SCRIPT_PATH)}`,
          `if is_gateway_daemon_loaded ${JSON.stringify(claw)}; then`,
          '  printf "loaded\\n"',
          "else",
          '  printf "not-loaded\\n"',
          "fi",
        ].join("\n"),
        { OPENCLAW_INSTALL_PROBE_TIMEOUT_SECONDS: "0.01" },
      );

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("not-loaded");
      expect(result.stderr).toContain(
        "timed out during installer finalization probe: openclaw daemon status --json",
      );
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }
  });

  it("loads nvm before checking Node.js so stale system Node does not win", () => {
    expect(script).toMatch(
      /# Step 1: Node\.js[\s\S]*?load_nvm_for_node_detection\s+if ! check_node; then/,
    );

    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-nvm-"));
    const home = join(tmp, "home");
    const systemBin = join(tmp, "system-bin");
    const nvmBin = join(home, ".nvm/versions/node/v22.22.3/bin");
    mkdirSync(systemBin, { recursive: true });
    mkdirSync(nvmBin, { recursive: true });
    mkdirSync(join(home, ".nvm"), { recursive: true });

    const systemNode = join(systemBin, "node");
    const nvmNode = join(nvmBin, "node");
    writeFileSync(systemNode, "#!/bin/sh\necho v8.11.3\n");
    writeFileSync(nvmNode, "#!/bin/sh\necho v22.22.3\n");
    chmodSync(systemNode, 0o755);
    chmodSync(nvmNode, 0o755);
    writeFileSync(
      join(home, ".nvm/nvm.sh"),
      [
        'NVM_DIR="${NVM_DIR:-$HOME/.nvm}"',
        "export NVM_DIR",
        "nvm() {",
        '  if [ "$1" = "use" ]; then',
        '    export PATH="$NVM_DIR/versions/node/v22.22.3/bin:$PATH"',
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
    expect(output).toContain("version=v22.22.3");
  });

  it("installs Homebrew lazily before macOS Git installs", () => {
    const result = runInstallShell(`
      set -euo pipefail
      source "${SCRIPT_PATH}"
      OS=macos
      install_homebrew() { echo "install_homebrew"; }
      run_quiet_step() { echo "run_quiet_step:$*"; return 0; }
      install_git
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(
      /install_homebrew\s+run_quiet_step:Installing Git brew install git/,
    );
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
    writeFileSync(supportedNode, "#!/bin/sh\necho v22.22.3\n");
    chmodSync(staleNode, 0o755);
    chmodSync(supportedNode, 0o755);

    let result: ReturnType<typeof runInstallShell> | undefined;
    try {
      result = runInstallShell(
        [
          `cd ${JSON.stringify(process.cwd())}`,
          `source ${JSON.stringify(SCRIPT_PATH)}`,
          "type() {",
          '  if [[ "$*" == "-P -a node" ]]; then',
          `    printf '%s\\n' ${JSON.stringify(staleNode)} ${JSON.stringify(supportedNode)}`,
          "    return 0",
          "  fi",
          '  builtin type "$@"',
          "}",
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
    expect(output).toContain("version=v22.22.3");
  });

  it("uses the package engine range when accepting existing Node runtimes", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      engines?: { node?: string };
    };
    expect(pkg.engines?.node).toBe(">=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0");

    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-node-floor-"));
    const bin = join(tmp, "bin");
    mkdirSync(bin, { recursive: true });

    const nodePath = join(bin, "node");
    writeFileSync(
      nodePath,
      ["#!/bin/sh", 'printf "%s\\n" "${FAKE_NODE_VERSION:-v0.0.0}"', ""].join("\n"),
    );
    chmodSync(nodePath, 0o755);

    let result: ReturnType<typeof runInstallShell> | undefined;
    try {
      result = runInstallShell(
        [
          `cd ${JSON.stringify(process.cwd())}`,
          `source ${JSON.stringify(SCRIPT_PATH)}`,
          "set +e",
          `PATH=${JSON.stringify(`${bin}:/usr/bin:/bin`)}`,
          "export PATH",
          "unset -f node 2>/dev/null || true",
          "unalias node 2>/dev/null || true",
          'node() { printf "%s\\n" "${FAKE_NODE_VERSION:-v0.0.0}"; }',
          "for version in 22.22.2 22.22.3 23.11.0 24.14.1 24.15.0 25.8.1 25.9.0 26.0.0; do",
          '  FAKE_NODE_VERSION="v${version}"',
          "  export FAKE_NODE_VERSION",
          "  node_is_supported",
          '  printf "%s=%s\\n" "$version" "$?"',
          "done",
          "exit 0",
        ].join("\n"),
        {
          PATH: `${bin}:/usr/bin:/bin`,
          TERM: "dumb",
        },
      );
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }

    expect(result?.status).toBe(0);
    expect(result?.stdout).toContain("22.22.2=1");
    expect(result?.stdout).toContain("22.22.3=0");
    expect(result?.stdout).toContain("23.11.0=1");
    expect(result?.stdout).toContain("24.14.1=1");
    expect(result?.stdout).toContain("24.15.0=0");
    expect(result?.stdout).toContain("25.8.1=1");
    expect(result?.stdout).toContain("25.9.0=0");
    expect(result?.stdout).toContain("26.0.0=0");
  });

  it("rejects a supported Node version when its linked SQLite is unsafe", () => {
    const result = runInstallShell(
      [
        `cd ${JSON.stringify(process.cwd())}`,
        `source ${JSON.stringify(SCRIPT_PATH)}`,
        "set +e",
        "node() {",
        '  if [[ "${1:-}" == "-v" ]]; then printf "v24.17.0\\n"; return 0; fi',
        '  if [[ "${1:-}" == "-e" ]]; then return 1; fi',
        "  return 1",
        "}",
        "node_is_supported",
        'printf "status=%s\\n" "$?"',
        "exit 0",
      ].join("\n"),
      { TERM: "dumb" },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("status=1");
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
        'if [[ "${1:-}" == "-p" ]]; then echo "24 15"; exit 0; fi',
        'if [[ "${1:-}" == "-v" ]]; then echo "v24.15.0"; exit 0; fi',
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
    const staleBin = join(tmp, "stale-bin");
    const visibleBin = join(tmp, "visible-bin");
    mkdirSync(npmBin, { recursive: true });
    mkdirSync(staleBin, { recursive: true });
    mkdirSync(visibleBin, { recursive: true });
    const openclawBin = join(npmBin, "openclaw");
    const staleOpenclawBin = join(staleBin, "openclaw");
    writeFileSync(openclawBin, "#!/bin/sh\nexit 0\n");
    writeFileSync(staleOpenclawBin, "#!/bin/sh\nexit 0\n");
    chmodSync(openclawBin, 0o755);
    chmodSync(staleOpenclawBin, 0o755);

    let result: ReturnType<typeof runInstallShell> | undefined;
    try {
      result = runInstallShell(`
        set -euo pipefail
        source "${SCRIPT_PATH}"
        ORIGINAL_PATH=${JSON.stringify(`${visibleBin}:/usr/bin:/bin`)}
        printf 'missing=%s\\n' "$(openclaw_command_for_user "${openclawBin}")"
        ORIGINAL_PATH=${JSON.stringify(`${npmBin}:${visibleBin}:/usr/bin:/bin`)}
        printf 'present=%s\\n' "$(openclaw_command_for_user "${openclawBin}")"
        ORIGINAL_PATH=${JSON.stringify(`${staleBin}:${npmBin}:/usr/bin:/bin`)}
        printf 'shadowed=%s\\n' "$(openclaw_command_for_user "${openclawBin}")"
      `);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }

    expect(result?.status).toBe(0);
    expect(result?.stdout).toContain(`missing=${openclawBin.replace(/ /g, "\\ ")}`);
    expect(result?.stdout).toContain("present=openclaw");
    expect(result?.stdout).toContain(`shadowed=${openclawBin.replace(/ /g, "\\ ")}`);
  });

  it("prefers the binary owned by the completed install method over stale PATH entries", () => {
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-selected-bin-"));
    const home = join(tmp, "home");
    const npmBin = join(tmp, "npm-bin");
    const staleBin = join(tmp, "stale-bin");
    const gitBin = join(home, ".local", "bin");
    mkdirSync(npmBin, { recursive: true });
    mkdirSync(staleBin, { recursive: true });
    mkdirSync(gitBin, { recursive: true });
    for (const bin of [
      join(npmBin, "openclaw"),
      join(staleBin, "openclaw"),
      join(gitBin, "openclaw"),
    ]) {
      writeFileSync(bin, "#!/bin/sh\nexit 0\n");
      chmodSync(bin, 0o755);
    }

    let result: ReturnType<typeof runInstallShell> | undefined;
    try {
      result = runInstallShell(
        `
          set -euo pipefail
          source "${SCRIPT_PATH}"
          INSTALL_METHOD=git
          printf 'git=%s\\n' "$(resolve_installed_openclaw_bin)"
          INSTALL_METHOD=npm
          npm_global_bin_dir() { printf '%s\\n' "${npmBin}"; }
          printf 'npm=%s\\n' "$(resolve_installed_openclaw_bin)"
        `,
        {
          HOME: home,
          PATH: `${staleBin}:${process.env.PATH ?? ""}`,
        },
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }

    expect(result?.status).toBe(0);
    expect(result?.stdout).toContain(`git=${join(gitBin, "openclaw")}`);
    expect(result?.stdout).toContain(`npm=${join(npmBin, "openclaw")}`);
  });

  it("uses the selected binary in gateway recovery guidance", () => {
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-gateway-guidance-"));
    const currentBin = join(tmp, "current bin");
    const staleBin = join(tmp, "stale-bin");
    mkdirSync(currentBin, { recursive: true });
    mkdirSync(staleBin, { recursive: true });
    const openclawBin = join(currentBin, "openclaw");
    writeFileSync(openclawBin, "#!/bin/sh\nexit 0\n");
    writeFileSync(join(staleBin, "openclaw"), "#!/bin/sh\nexit 0\n");
    chmodSync(openclawBin, 0o755);
    chmodSync(join(staleBin, "openclaw"), 0o755);

    let result: ReturnType<typeof runInstallShell> | undefined;
    try {
      result = runInstallShell(`
        set -euo pipefail
        source "${SCRIPT_PATH}"
        OPENCLAW_BIN=${JSON.stringify(openclawBin)}
        ORIGINAL_PATH=${JSON.stringify(`${staleBin}:${currentBin}:/usr/bin:/bin`)}
        VERIFY_INSTALL=1
        is_gateway_daemon_loaded() { return 0; }
        run_quiet_step() {
          case "$1" in
            "Restarting gateway service"|"Checking gateway service") return 1 ;;
            *) return 0 ;;
          esac
        }
        refresh_gateway_service_if_loaded
        verify_installation true || true
      `);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }

    const quotedBin = openclawBin.replace(/ /g, "\\ ");
    expect(result?.status).toBe(0);
    expect(result?.stdout).toContain(`Run: ${quotedBin} gateway restart`);
    expect(result?.stdout).toContain(`Run: ${quotedBin} gateway status --deep`);
  });

  it("refreshes the shell command cache after loading a persisted PATH update", () => {
    const result = runInstallShell(`
      set -euo pipefail
      source "${SCRIPT_PATH}"
      printf 'export PATH="$HOME/.local/bin:$PATH"\\n' > "$HOME/.bashrc"
      ORIGINAL_PATH="/usr/bin:/bin"
      warn_shell_path_missing_dir "$HOME/.local/bin" "user-local bin dir"
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("For this shell, run: source ");
    expect(result.stdout).toContain("; hash -r");
  });

  it("resolves requested git install versions to checkout refs", () => {
    const result = runInstallShell(`
      set -euo pipefail
      source "${SCRIPT_PATH}"
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
    const result = runInstallShell(`
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
      'CI="${CI:-true}" run_quiet_step "Installing dependencies" run_pnpm -C "$repo_dir" install "$install_lockfile_flag"',
    );
  });

  it("aligns pnpm to the checked-out repo packageManager before installing", () => {
    expect(script).toContain("activate_repo_pnpm_version()");
    expect(script).toContain('corepack prepare "pnpm@${version}" --activate');
    expect(script).toContain('activate_repo_pnpm_version "$repo_dir"');
  });

  it("uses the repo Corepack pnpm when a global pnpm version is already present", () => {
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-pnpm-version-"));
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
      const result = runInstallShell(
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
      expect(result.stdout).toContain("cmd=corepack pnpm");
      expect(result.stdout).toContain("run=11.2.2");
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }
  });

  it("does not treat /dev/tty permissions as a controlling terminal", () => {
    const result = runInstallShell(`
      set -euo pipefail
      source "${SCRIPT_PATH}"
      if has_controlling_tty; then echo "has_tty=1"; else echo "has_tty=0"; fi
      if is_promptable; then echo "promptable=1"; else echo "promptable=0"; fi
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("has_tty=0");
    expect(result.stdout).toContain("promptable=0");
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
      node_is_supported() { return 1; }
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
      '"$GUM" spin --spinner dot --title "$title" -- "$@" < /dev/null >"$gum_out" 2>"$gum_err" || gum_status=$?',
    );
    expect(script).toContain(
      '"$GUM" spin --spinner dot --title "$title" -- "$@" >"$gum_out" 2>"$gum_err" || gum_status=$?',
    );
    expect(script).toContain(
      'if is_gum_raw_mode_failure "$gum_out" || is_gum_raw_mode_failure "$gum_err"; then',
    );
    expect(script).toContain(
      'ui_warn "Spinner unavailable in this terminal; continuing without spinner"',
    );
    expect(script).toContain(
      'if needs_stdin_isolation; then\n                    "$@" < /dev/null\n                else\n                    "$@"\n                fi\n                return $?',
    );
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

  it("gum spin preserves terminal stdin for direct interactive installs", () => {
    // When needs_stdin_isolation returns false (direct interactive run),
    // gum spin should NOT redirect stdin from /dev/null so that wrapped
    // commands like Homebrew can still prompt the user via stdin.
    const dir = mkdtempSync(join(tmpdir(), "openclaw-install-sh-gum-stdin-"));
    try {
      const gumPath = join(dir, "gum");
      const commandPath = join(dir, "command");
      const stdinLog = join(dir, "stdin-source");
      // Gum stub: skip args up to and including "--", then run the rest
      writeFileSync(
        gumPath,
        '#!/usr/bin/env bash\nwhile [[ "$#" -gt 0 && "$1" != "--" ]]; do shift; done\nshift\n"$@"\n',
        { mode: 0o755 },
      );
      // Command: detects whether stdin is literally /dev/null by comparing
      // device:inode of fd 0 against /dev/null (reliable across macOS/Linux)
      writeFileSync(
        commandPath,
        `#!/usr/bin/env bash
stdin_dev=$(stat -f '%d:%i' /dev/fd/0 2>/dev/null || stat -c '%d:%i' /dev/fd/0 2>/dev/null)
null_dev=$(stat -f '%d:%i' /dev/null 2>/dev/null || stat -c '%d:%i' /dev/null 2>/dev/null)
if [ "$stdin_dev" = "$null_dev" ]; then echo "devnull" > "${stdinLog}"; else echo "other" > "${stdinLog}"; fi
exit 0
`,
        { mode: 0o755 },
      );

      const result = runInstallShell(`
        set -euo pipefail
        source "${SCRIPT_PATH}"
        # Override needs_stdin_isolation to return false (direct interactive)
        needs_stdin_isolation() { return 1; }
        gum_is_tty() { return 0; }
        GUM="${gumPath}"
        run_with_spinner "Installing node" "${commandPath}"
      `);

      // The gum spin command should NOT have redirected stdin from /dev/null
      expect(result.status).toBe(0);
      // Assert the child command's stdin was NOT /dev/null
      const observed = readFileSync(stdinLog, "utf8").trim();
      expect(observed).toBe("other");
      expect(script).toContain("needs_stdin_isolation; then");
      expect(script).toContain(
        '"$GUM" spin --spinner dot --title "$title" -- "$@" >"$gum_out" 2>"$gum_err" || gum_status=$?',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gum spin redirects stdin from /dev/null for piped installs", () => {
    expect(script).toContain("needs_stdin_isolation; then");
    expect(script).toContain(
      '"$GUM" spin --spinner dot --title "$title" -- "$@" < /dev/null >"$gum_out" 2>"$gum_err" || gum_status=$?',
    );
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

  it("needs_stdin_isolation returns true when stdin is piped", () => {
    const result = spawnSync(
      "bash",
      [
        "-c",
        `source "${SCRIPT_PATH}" && needs_stdin_isolation && echo "ISOLATED" || echo "INTERACTIVE"`,
      ],
      {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          HOME: tmpdir(),
          OPENCLAW_INSTALL_SH_NO_RUN: "1",
          BASH_ENV: "",
          ENV: "",
        },
        input: "",
      },
    );
    expect(result.stdout.trim()).toBe("ISOLATED");
  });

  it("needs_stdin_isolation returns true when NO_PROMPT is set", () => {
    const result = runInstallShell(`
      set -euo pipefail
      source "${SCRIPT_PATH}"
      NO_PROMPT=1
      needs_stdin_isolation && echo "ISOLATED" || echo "INTERACTIVE"
    `);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("ISOLATED");
  });

  it("routes piped interactive subprocesses through the controlling TTY", () => {
    const result = runInstallShell(`
      set -euo pipefail
      source "${SCRIPT_PATH}"
      NO_PROMPT=0
      needs_stdin_isolation() { return 0; }
      has_controlling_tty() { return 0; }
      resolve_subprocess_stdin_path 1
    `);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("/dev/tty");
  });

  it("keeps piped subprocesses nonblocking when prompt output is redirected", () => {
    const result = runInstallShell(`
      set -euo pipefail
      source "${SCRIPT_PATH}"
      NO_PROMPT=0
      needs_stdin_isolation() { return 0; }
      has_controlling_tty() { return 0; }
      resolve_subprocess_stdin_path 0
    `);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("/dev/null");
  });

  it("captures visible prompt output before resolving subprocess stdin", () => {
    const result = runInstallShell(`
      set -euo pipefail
      source "${SCRIPT_PATH}"
      marker="$(mktemp)"
      trap 'rm -f "$marker"' EXIT
      has_visible_prompt_output() { return 0; }
      resolve_subprocess_stdin_path() {
        echo "visible=$1" > "$marker"
        return 1
      }
      run_with_safe_stdin true
      cat "$marker"
    `);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("visible=1");
  });

  it("routes non-promptable subprocesses through /dev/null", () => {
    const result = runInstallShell(`
      set -euo pipefail
      source "${SCRIPT_PATH}"
      NO_PROMPT=1
      has_controlling_tty() { return 0; }
      resolve_subprocess_stdin_path
    `);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("/dev/null");
  });

  it("run_quiet_step redirects stdin to /dev/null in piped context", () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-stdin-test-"));
    const marker = join(dir, "stdin-state");
    try {
      const result = spawnSync(
        "bash",
        [
          "-c",
          `source "${SCRIPT_PATH}" && GUM="" && run_quiet_step "test-step" bash -c 'if read -t 1 line 2>/dev/null && [ -n "$line" ]; then echo "LEAKED:$line" > ${JSON.stringify(marker)}; else echo ISOLATED > ${JSON.stringify(marker)}; fi'`,
        ],
        {
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            HOME: tmpdir(),
            NO_PROMPT: "1",
            OPENCLAW_INSTALL_SH_NO_RUN: "1",
            BASH_ENV: "",
            ENV: "",
          },
          input: "SENTINEL_DATA_SHOULD_NOT_LEAK\n",
        },
      );
      expect(result.status).toBe(0);
      const stdinState = readFileSync(marker, "utf8").trim();
      expect(stdinState).toBe("ISOLATED");
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("pipe data leaks to child when stdin is not isolated (counterproof)", () => {
    // This test proves the fix is necessary: without /dev/null redirect,
    // pipe data from the installer invocation reaches the child process.
    // If this test ever fails, the isolation in run_quiet_step is no longer
    // the only barrier protecting child processes from pipe consumption.
    const dir = mkdtempSync(join(tmpdir(), "openclaw-stdin-leak-"));
    const marker = join(dir, "stdin-state");
    try {
      const result = spawnSync(
        "bash",
        [
          "-c",
          // Bypass run_quiet_step: call the child directly with inherited stdin
          `source "${SCRIPT_PATH}" && bash -c 'output=$(cat); if [ -n "$output" ]; then echo "LEAKED" > ${JSON.stringify(marker)}; else echo "EMPTY" > ${JSON.stringify(marker)}; fi'`,
        ],
        {
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            HOME: tmpdir(),
            OPENCLAW_INSTALL_SH_NO_RUN: "1",
            BASH_ENV: "",
            ENV: "",
          },
          input: "SENTINEL_DATA_SHOULD_LEAK\n",
        },
      );
      expect(result.status).toBe(0);
      const stdinState = readFileSync(marker, "utf8").trim();
      // Without /dev/null redirect, cat reads the sentinel from the pipe.
      expect(stdinState).toBe("LEAKED");
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("run_quiet_step blocks cat from reading pipe data", () => {
    // Stronger version of the isolation test: uses cat to consume all of
    // stdin and verifies it reads nothing (empty output from /dev/null).
    const dir = mkdtempSync(join(tmpdir(), "openclaw-stdin-cat-"));
    const marker = join(dir, "stdin-state");
    try {
      const result = spawnSync(
        "bash",
        [
          "-c",
          `source "${SCRIPT_PATH}" && GUM="" && run_quiet_step "test-step" bash -c 'output=$(cat); if [ -n "$output" ]; then echo "LEAKED" > ${JSON.stringify(marker)}; else echo "ISOLATED" > ${JSON.stringify(marker)}; fi'`,
        ],
        {
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            HOME: tmpdir(),
            NO_PROMPT: "1",
            OPENCLAW_INSTALL_SH_NO_RUN: "1",
            BASH_ENV: "",
            ENV: "",
          },
          input: "SENTINEL_DATA_SHOULD_NOT_LEAK\n",
        },
      );
      expect(result.status).toBe(0);
      const stdinState = readFileSync(marker, "utf8").trim();
      expect(stdinState).toBe("ISOLATED");
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});

describe("install.sh doctor cancellation and dashboard guard", () => {
  const script = readFileSync(SCRIPT_PATH, "utf8");

  it("preserves dashboard stdin for direct interactive installs", () => {
    expect(script).toContain('run_with_safe_stdin "$claw" dashboard || true');
  });

  it("preserves plugin update stdin for direct interactive upgrades", () => {
    expect(script).toContain(
      'OPENCLAW_UPDATE_IN_PROGRESS=1 run_with_safe_stdin "$claw" plugins update --all || true',
    );
  });

  it("guards every run_doctor caller against failure", () => {
    // A failed or cancelled doctor must not launch the dashboard.
    expect(script).toContain("if run_doctor; then");
    // Ensure there is no bare "run_doctor" call followed by
    // "should_open_dashboard=true" without an if-guard
    const bareDoctor = /^\s+run_doctor\s*$/m;
    const lines = script.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line !== undefined && bareDoctor.test(line)) {
        // A bare run_doctor is only acceptable inside the run_doctor
        // function definition itself, not at a call site
        const context = lines.slice(Math.max(0, i - 3), i + 3).join("\n");
        if (!context.includes("run_doctor()")) {
          throw new Error(
            `Unguarded run_doctor call at line ${i + 1}. ` +
              `All run_doctor callers must check the return value.`,
          );
        }
      }
    }
  });

  it("clears dashboard flag when doctor fails during upgrade", () => {
    // The upgrade interactive doctor path must clear should_open_dashboard
    // when doctor_exit is non-zero.
    expect(script).toContain("should_open_dashboard=false");
    expect(script).toContain("if (( doctor_exit != 0 )); then");
  });

  it("propagates signal exit codes through run_quiet_step", () => {
    // run_quiet_step preserves signal exit codes (130=SIGINT, 143=SIGTERM)
    // so run_doctor can detect user cancellation.
    expect(script).toContain("if (( cmd_exit > 128 )); then");
    expect(script).toContain('return "$cmd_exit"');
  });

  it("aborts on SIGINT (exit 130) from doctor", () => {
    // Both the run_doctor function and the interactive doctor path
    // must call abort_install_int on exit code 130.
    expect(script).toContain("if (( doctor_exit == 130 )); then");
    expect(script).toContain("abort_install_int");
  });
});
