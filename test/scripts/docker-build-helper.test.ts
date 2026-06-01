import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const HELPER_PATH = "scripts/lib/docker-build.sh";
const DOCKER_ALL_SCHEDULER_PATH = "scripts/test-docker-all.mjs";
const DOCKER_E2E_PACKAGE_HELPER_PATH = "scripts/lib/docker-e2e-package.sh";
const DOCKER_E2E_IMAGE_HELPER_PATH = "scripts/lib/docker-e2e-image.sh";
const DOCKER_E2E_SCENARIOS_PATH = "scripts/lib/docker-e2e-scenarios.mjs";
const INSTALL_E2E_RUNNER_PATH = "scripts/docker/install-sh-e2e/run.sh";
const CLEANUP_DOCKER_SMOKE_PATH = "scripts/test-cleanup-docker.sh";
const INSTALL_E2E_DOCKER_SMOKE_PATH = "scripts/test-install-sh-e2e-docker.sh";
const LIVE_CLI_BACKEND_DOCKER_PATH = "scripts/test-live-cli-backend-docker.sh";
const LIVE_BUILD_DOCKER_PATH = "scripts/test-live-build-docker.sh";
const OPENAI_WEB_SEARCH_MINIMAL_E2E_PATH = "scripts/e2e/openai-web-search-minimal-docker.sh";
const OPENAI_WEB_SEARCH_MINIMAL_SCENARIO_PATH =
  "scripts/e2e/lib/openai-web-search-minimal/scenario.sh";
const OPENAI_WEB_SEARCH_MINIMAL_CLIENT_PATH =
  "scripts/e2e/lib/openai-web-search-minimal/client.mjs";
const OPENWEBUI_DOCKER_E2E_PATH = "scripts/e2e/openwebui-docker.sh";
const ONBOARD_DOCKER_E2E_PATH = "scripts/e2e/onboard-docker.sh";
const KITCHEN_SINK_PLUGIN_DOCKER_E2E_PATH = "scripts/e2e/kitchen-sink-plugin-docker.sh";
const KITCHEN_SINK_RPC_DOCKER_E2E_PATH = "scripts/e2e/kitchen-sink-rpc-docker.sh";
const CODEX_ON_DEMAND_DOCKER_E2E_PATH = "scripts/e2e/codex-on-demand-docker.sh";
const CODEX_MEDIA_PATH_SCENARIO_PATH = "scripts/e2e/lib/codex-media-path/scenario.sh";
const CODEX_NPM_PLUGIN_LIVE_DOCKER_E2E_PATH = "scripts/e2e/codex-npm-plugin-live-docker.sh";
const LIVE_PLUGIN_TOOL_DOCKER_E2E_PATH = "scripts/e2e/live-plugin-tool-docker.sh";
const NPM_ONBOARD_CHANNEL_AGENT_DOCKER_E2E_PATH = "scripts/e2e/npm-onboard-channel-agent-docker.sh";
const SKILL_INSTALL_DOCKER_E2E_PATH = "scripts/e2e/skill-install-docker.sh";
const PLUGIN_BINDING_COMMAND_ESCAPE_DOCKER_E2E_PATH =
  "scripts/e2e/plugin-binding-command-escape-docker.sh";
const PLUGIN_BINDING_COMMAND_ESCAPE_DOCKERFILE_PATH =
  "scripts/e2e/plugin-binding-command-escape.Dockerfile";
const QR_IMPORT_DOCKER_E2E_PATH = "scripts/e2e/qr-import-docker.sh";
const MULTI_NODE_UPDATE_DOCKER_E2E_PATH = "scripts/e2e/multi-node-update-docker.sh";
const BUNDLED_PLUGIN_INSTALL_UNINSTALL_E2E_PATH =
  "scripts/e2e/bundled-plugin-install-uninstall-docker.sh";
const BUNDLED_PLUGIN_INSTALL_UNINSTALL_SWEEP_PATH =
  "scripts/e2e/lib/bundled-plugin-install-uninstall/sweep.sh";
const BUNDLED_PLUGIN_INSTALL_UNINSTALL_PROBE_PATH =
  "scripts/e2e/lib/bundled-plugin-install-uninstall/probe.mjs";
const BUNDLED_PLUGIN_INSTALL_UNINSTALL_RUNTIME_SMOKE_PATH =
  "scripts/e2e/lib/bundled-plugin-install-uninstall/runtime-smoke.mjs";
const CLEANUP_SMOKE_DOCKERFILE_PATH = "scripts/docker/cleanup-smoke/Dockerfile";
const PLUGINS_DOCKER_E2E_PATH = "scripts/e2e/plugins-docker.sh";
const PLUGINS_DOCKER_SWEEP_PATH = "scripts/e2e/lib/plugins/sweep.sh";
const PLUGINS_DOCKER_MARKETPLACE_PATH = "scripts/e2e/lib/plugins/marketplace.sh";
const PLUGINS_DOCKER_CLAWHUB_PATH = "scripts/e2e/lib/plugins/clawhub.sh";
const PLUGINS_DOCKER_ASSERTIONS_PATH = "scripts/e2e/lib/plugins/assertions.mjs";
const PLUGINS_DOCKER_NPM_REGISTRY_PATH = "scripts/e2e/lib/plugins/npm-registry-server.mjs";
const PLUGIN_UPDATE_DOCKER_E2E_PATH = "scripts/e2e/plugin-update-unchanged-docker.sh";
const PLUGIN_UPDATE_SCENARIO_PATH = "scripts/e2e/lib/plugin-update/unchanged-scenario.sh";
const PLUGIN_UPDATE_CORRUPT_SCENARIO_PATH =
  "scripts/e2e/lib/plugin-update/corrupt-update-scenario.sh";
const PLUGIN_UPDATE_PROBE_PATH = "scripts/e2e/lib/plugin-update/probe.mjs";
const PLUGIN_LIFECYCLE_MATRIX_DOCKER_E2E_PATH = "scripts/e2e/plugin-lifecycle-matrix-docker.sh";
const DOCTOR_SWITCH_DOCKER_E2E_PATH = "scripts/e2e/doctor-install-switch-docker.sh";
const DOCTOR_SWITCH_SCENARIO_PATH = "scripts/e2e/lib/doctor-install-switch/scenario.sh";
const PACKAGE_COMPAT_PATH = "scripts/e2e/lib/package-compat.mjs";
const UPGRADE_SURVIVOR_DOCKER_E2E_PATH = "scripts/e2e/upgrade-survivor-docker.sh";
const UPDATE_CHANNEL_SWITCH_DOCKER_E2E_PATH = "scripts/e2e/update-channel-switch-docker.sh";
const UPDATE_CHANNEL_SWITCH_ASSERTIONS_PATH =
  "scripts/e2e/lib/update-channel-switch/assertions.mjs";
const RELEASE_UPGRADE_USER_JOURNEY_SCENARIO_PATH =
  "scripts/e2e/lib/release-upgrade-user-journey/scenario.sh";
const UPGRADE_SURVIVOR_RUN_SCRIPT = "scripts/e2e/lib/upgrade-survivor/run.sh";
const UPGRADE_SURVIVOR_UPDATE_RESTART_AUTH_PATH =
  "scripts/e2e/lib/upgrade-survivor/update-restart-auth.sh";
const GATEWAY_NETWORK_DOCKER_E2E_PATH = "scripts/e2e/gateway-network-docker.sh";
const CENTRALIZED_BUILD_SCRIPTS = [
  "scripts/docker/setup.sh",
  "scripts/e2e/browser-cdp-snapshot-docker.sh",
  "scripts/e2e/qr-import-docker.sh",
  "scripts/lib/docker-e2e-image.sh",
  "scripts/sandbox-browser-setup.sh",
  "scripts/sandbox-common-setup.sh",
  "scripts/sandbox-setup.sh",
  "scripts/test-cleanup-docker.sh",
  "scripts/test-install-sh-docker.sh",
  "scripts/test-install-sh-e2e-docker.sh",
  "scripts/test-live-build-docker.sh",
] as const;

function packageBackedDockerRunnerPaths(): string[] {
  return readdirSync("scripts/e2e")
    .filter((entry) => entry.endsWith("-docker.sh"))
    .map((entry) => join("scripts/e2e", entry))
    .filter((path) => readFileSync(path, "utf8").includes("docker_e2e_prepare_package_tgz"))
    .toSorted();
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

describe("docker build helper", () => {
  it("forces BuildKit for centralized Docker builds", () => {
    const helper = readFileSync(HELPER_PATH, "utf8");

    expect(helper).toContain("DOCKER_BUILDKIT=1");
    expect(helper).toContain("docker_build_exec()");
    expect(helper).toContain("docker_build_run()");
    expect(helper).toContain("docker buildx build --load");
    expect(helper).toContain("docker_build_transient_failure()");
    expect(helper).toContain("OPENCLAW_DOCKER_BUILD_RETRIES");
    expect(helper).toContain("OPENCLAW_DOCKER_BUILD_TIMEOUT");
    expect(helper).toContain('docker_build_run_command "$timeout_value" "${command[@]}"');
    expect(helper).toContain("OPENCLAW_DOCKER_BUILD_REQUIRE_TIMEOUT");
    expect(helper).toContain("frontend grpc server closed unexpectedly");
  });

  it("keeps shell-script Docker builds behind the helper", () => {
    for (const path of CENTRALIZED_BUILD_SCRIPTS) {
      const script = readFileSync(path, "utf8");

      expect(script, path).toMatch(/docker-build\.sh|docker-e2e-image\.sh/);
      expect(script, path).not.toMatch(/\bdocker build\b/);
      expect(script, path).not.toMatch(/run_logged\s+\S+\s+docker\s+build/);
    }
  });

  it("routes standalone Docker smoke runs through the timeout-aware helper", () => {
    const cleanupSmoke = readFileSync(CLEANUP_DOCKER_SMOKE_PATH, "utf8");
    const installE2eSmoke = readFileSync(INSTALL_E2E_DOCKER_SMOKE_PATH, "utf8");

    expect(cleanupSmoke).toContain('source "$ROOT_DIR/scripts/lib/docker-e2e-container.sh"');
    expect(cleanupSmoke).toContain(
      'DOCKER_COMMAND_TIMEOUT="${DOCKER_COMMAND_TIMEOUT:-${OPENCLAW_CLEANUP_SMOKE_DOCKER_TIMEOUT:-600s}}"',
    );
    expect(cleanupSmoke).toContain(
      'docker_e2e_docker_run_cmd run --rm --platform "$PLATFORM" -t "$IMAGE_NAME"',
    );
    expect(cleanupSmoke).not.toContain('docker run --rm --platform "$PLATFORM" -t "$IMAGE_NAME"');

    expect(installE2eSmoke).toContain('source "$ROOT_DIR/scripts/lib/docker-e2e-container.sh"');
    expect(installE2eSmoke).toContain(
      'DOCKER_COMMAND_TIMEOUT="${DOCKER_COMMAND_TIMEOUT:-${OPENCLAW_INSTALL_E2E_DOCKER_TIMEOUT:-2700s}}"',
    );
    expect(installE2eSmoke).toContain("docker_e2e_docker_run_cmd run --rm \\");
    expect(installE2eSmoke).not.toContain("docker run --rm \\");
  });

  it("lets Testbox fall back to building when a reused Docker image is missing", () => {
    const helper = readFileSync(HELPER_PATH, "utf8");
    const e2eImageHelper = readFileSync(DOCKER_E2E_IMAGE_HELPER_PATH, "utf8");
    const liveBuild = readFileSync(LIVE_BUILD_DOCKER_PATH, "utf8");
    const liveCliBackend = readFileSync(LIVE_CLI_BACKEND_DOCKER_PATH, "utf8");

    expect(helper).toContain("docker_build_on_missing_enabled()");
    expect(helper).toContain("OPENCLAW_DOCKER_BUILD_ON_MISSING");
    expect(helper).toContain("OPENCLAW_TESTBOX");
    expect(e2eImageHelper).toContain("docker_build_on_missing_enabled");
    expect(e2eImageHelper).toContain("Docker image not available; building");
    expect(e2eImageHelper).toContain('docker_e2e_docker_cmd image inspect "$image_name"');
    expect(e2eImageHelper).toContain('docker_e2e_docker_cmd pull "$image_name"');
    expect(liveBuild).toContain('source "$SCRIPT_ROOT_DIR/scripts/lib/docker-e2e-container.sh"');
    expect(liveBuild).toContain(
      'DOCKER_COMMAND_TIMEOUT="${DOCKER_COMMAND_TIMEOUT:-${OPENCLAW_LIVE_DOCKER_PULL_TIMEOUT:-600s}}"',
    );
    expect(liveBuild).toContain('docker_e2e_docker_cmd image inspect "$LIVE_IMAGE_NAME"');
    expect(liveBuild).toContain('docker_e2e_docker_cmd pull "$LIVE_IMAGE_NAME"');
    expect(liveBuild).not.toContain('docker image inspect "$LIVE_IMAGE_NAME"');
    expect(liveBuild).not.toContain('docker pull "$LIVE_IMAGE_NAME"');
    expect(liveBuild).toContain("Live-test image not available; building");
    expect(readFileSync(OPENWEBUI_DOCKER_E2E_PATH, "utf8")).toContain(
      'DOCKER_COMMAND_TIMEOUT="$DOCKER_PULL_TIMEOUT" docker_e2e_docker_cmd pull "$OPENWEBUI_IMAGE"',
    );
    expect(readFileSync(OPENWEBUI_DOCKER_E2E_PATH, "utf8")).not.toContain(
      'timeout "$DOCKER_PULL_TIMEOUT" docker pull "$OPENWEBUI_IMAGE"',
    );
    expect(liveCliBackend).toContain(
      'OPENCLAW_LIVE_DOCKER_REPO_ROOT="$ROOT_DIR" "$TRUSTED_HARNESS_DIR/scripts/test-live-build-docker.sh"',
    );
    expect(liveCliBackend).toContain("codex-cli is no longer a bundled CLI backend");
    expect(liveCliBackend).not.toContain("==> Direct Codex CLI probe ok");
    expect(liveCliBackend).not.toContain(
      'echo "==> Reuse live-test image: $LIVE_IMAGE_NAME (OPENCLAW_SKIP_DOCKER_BUILD=1)"',
    );
  });

  it("wraps centralized Docker builds with the timeout helper", () => {
    const workDir = mkdtempSync(join(tmpdir(), "openclaw-docker-build-timeout-"));

    try {
      const binDir = join(workDir, "bin");
      mkdirSync(binDir);
      writeFileSync(
        join(binDir, "timeout"),
        `#!/bin/bash
set -euo pipefail
if [[ "$1" = "--kill-after=1s" ]]; then
  exit 0
fi
printf '%s %s|%s\\n' "$1" "$2" "\${*:3}" >>"$TMPDIR/timeout-seen"
shift 2
"$@"
`,
      );
      chmodSync(join(binDir, "timeout"), 0o755);
      writeFileSync(
        join(binDir, "docker"),
        `#!/bin/sh
printf "%s\\n" "$*" >>"$TMPDIR/docker-seen"
`,
      );
      chmodSync(join(binDir, "docker"), 0o755);
      const rootDir = process.cwd();
      const script = `
set -euo pipefail
ROOT_DIR=${shellQuote(rootDir)}
TMPDIR=${shellQuote(workDir)}
export ROOT_DIR TMPDIR
export PATH="$TMPDIR/bin:$PATH"
export OPENCLAW_DOCKER_BUILD_TIMEOUT=17s

source "$ROOT_DIR/scripts/lib/docker-build.sh"

docker_build_run e2e-build -t demo-image .

grep -q '^--kill-after=30s 17s|env DOCKER_BUILDKIT=1 docker build -t demo-image .$' "$TMPDIR/timeout-seen"
grep -q '^build -t demo-image .$' "$TMPDIR/docker-seen"
`;

      execFileSync("bash", ["-lc", script], { encoding: "utf8" });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("fails centralized Docker builds fast when timeout is unavailable", () => {
    const workDir = mkdtempSync(join(tmpdir(), "openclaw-docker-build-timeout-required-"));

    try {
      mkdirSync(join(workDir, "bin"));
      const rootDir = process.cwd();
      const script = `
set -euo pipefail
ROOT_DIR=${shellQuote(rootDir)}
TMPDIR=${shellQuote(workDir)}
export ROOT_DIR TMPDIR
export PATH="$TMPDIR/bin"
export OPENCLAW_DOCKER_BUILD_TIMEOUT=19s

dirname() {
  /usr/bin/dirname "$@"
}

grep() {
  /usr/bin/grep "$@"
}

cat() {
  /bin/cat "$@"
}

rm() {
  /bin/rm "$@"
}

mktemp() {
  /usr/bin/mktemp "$@"
}

docker() {
  printf "%s\\n" "$*" >"$TMPDIR/docker-seen"
}
export -f dirname grep cat rm mktemp docker

source "$ROOT_DIR/scripts/lib/docker-build.sh"

set +e
docker_build_run e2e-build -t demo-image . >"$TMPDIR/stdout" 2>"$TMPDIR/stderr"
status="$?"
set -e

stdout="$(<"$TMPDIR/stdout")"
[[ "$status" = "1" ]]
[[ "$stdout" = *"timeout command not found; cannot bound Docker command after 19s"* ]]
[[ ! -e "$TMPDIR/docker-seen" ]]
`;

      execFileSync("bash", ["-lc", script], { encoding: "utf8" });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("keeps setup-style Docker builds compatible when timeout is unavailable", () => {
    const workDir = mkdtempSync(join(tmpdir(), "openclaw-docker-build-timeout-optional-"));

    try {
      const binDir = join(workDir, "bin");
      mkdirSync(binDir);
      writeFileSync(
        join(binDir, "env"),
        `#!/bin/sh
while [ "$#" -gt 0 ]; do
  case "$1" in
    *=*)
      shift
      ;;
    *)
      break
      ;;
  esac
done
exec "$@"
`,
      );
      chmodSync(join(binDir, "env"), 0o755);
      writeFileSync(
        join(binDir, "docker"),
        `#!/bin/sh
printf "%s\\n" "$*" >"$TMPDIR/docker-seen"
`,
      );
      chmodSync(join(binDir, "docker"), 0o755);
      const rootDir = process.cwd();
      const script = `
set -euo pipefail
ROOT_DIR=${shellQuote(rootDir)}
TMPDIR=${shellQuote(workDir)}
export ROOT_DIR TMPDIR
export PATH="$TMPDIR/bin"
export OPENCLAW_DOCKER_BUILD_TIMEOUT=23s

dirname() {
  /usr/bin/dirname "$@"
}

grep() {
  /usr/bin/grep "$@"
}

rm() {
  /bin/rm "$@"
}

mktemp() {
  /usr/bin/mktemp "$@"
}
export -f dirname grep rm mktemp

source "$ROOT_DIR/scripts/lib/docker-build.sh"

docker_build_exec -t setup-image .

[[ "$(<"$TMPDIR/docker-seen")" = "build -t setup-image ." ]]
`;

      execFileSync("bash", ["-lc", script], { encoding: "utf8" });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("keeps reused Docker image probes behind the timeout-aware helper", () => {
    const workDir = mkdtempSync(join(tmpdir(), "openclaw-docker-image-reuse-timeout-"));

    try {
      const rootDir = process.cwd();
      const script = `
set -euo pipefail
ROOT_DIR=${shellQuote(rootDir)}
TMPDIR=${shellQuote(workDir)}
export ROOT_DIR TMPDIR
export DOCKER_COMMAND_TIMEOUT=3s
export OPENCLAW_SKIP_DOCKER_BUILD=1

mkdir -p "$TMPDIR/bin"
cat >"$TMPDIR/bin/timeout" <<'SH'
#!/usr/bin/env bash
case "$1" in
  --kill-after=1s)
    exit 0
    ;;
  --kill-after=30s)
    printf "%s %s|%s\\n" "$1" "$2" "$3 $4 $5" >>"$TMPDIR/timeout-seen"
    shift 2
    ;;
  *)
    printf "%s|%s\\n" "$1" "$2 $3 $4" >>"$TMPDIR/timeout-seen"
    shift
    ;;
esac
"$@"
SH
chmod +x "$TMPDIR/bin/timeout"
export PATH="$TMPDIR/bin:$PATH"

docker() {
  printf "%s\\n" "$*" >>"$TMPDIR/docker-seen"
  case "$1 $2" in
    "image inspect")
      return 1
      ;;
    "pull openclaw-reuse-image")
      return 0
      ;;
    *)
      return 9
      ;;
  esac
}
export -f docker

source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"

docker_e2e_build_or_reuse \\
  openclaw-reuse-image \\
  reuse-timeout-proof \\
  "$ROOT_DIR/scripts/e2e/Dockerfile" \\
  "$ROOT_DIR" \\
  functional

test "$(grep -c '^--kill-after=30s 3s|' "$TMPDIR/timeout-seen")" = "2"
grep -q '^image inspect openclaw-reuse-image$' "$TMPDIR/docker-seen"
grep -q '^pull openclaw-reuse-image$' "$TMPDIR/docker-seen"
`;

      execFileSync("bash", ["-lc", script], { encoding: "utf8" });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("fails Docker commands fast when timeout is unavailable", () => {
    const workDir = mkdtempSync(join(tmpdir(), "openclaw-docker-timeout-required-"));

    try {
      mkdirSync(join(workDir, "bin"));
      const rootDir = process.cwd();
      const script = `
set -euo pipefail
ROOT_DIR=${shellQuote(rootDir)}
TMPDIR=${shellQuote(workDir)}
export ROOT_DIR TMPDIR
export PATH="$TMPDIR/bin"
export DOCKER_COMMAND_TIMEOUT=7s

docker() {
  printf "%s\\n" "$*" >"$TMPDIR/docker-seen"
}
export -f docker

source "$ROOT_DIR/scripts/lib/docker-e2e-container.sh"

set +e
docker_e2e_docker_cmd ps 2>"$TMPDIR/stderr"
status="$?"
set -e

stderr="$(<"$TMPDIR/stderr")"
[[ "$status" = "127" ]]
[[ "$stderr" = *"timeout command not found; cannot bound Docker command after 7s"* ]]
[[ ! -e "$TMPDIR/docker-seen" ]]
`;

      execFileSync("bash", ["-lc", script], { encoding: "utf8" });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("uses a Node watchdog for Docker commands when timeout is unavailable", () => {
    const workDir = mkdtempSync(join(tmpdir(), "openclaw-docker-node-timeout-"));

    try {
      const binDir = join(workDir, "bin");
      mkdirSync(binDir);
      writeFileSync(
        join(binDir, "node"),
        `#!/bin/bash\nexec ${shellQuote(process.execPath)} "$@"\n`,
      );
      writeFileSync(
        join(binDir, "docker"),
        `#!/bin/bash\ninput="$(/bin/cat)"\nprintf "%s|%s\\n" "$*" "$input" >"$TMPDIR/docker-seen"\nexit 13\n`,
      );
      chmodSync(join(binDir, "node"), 0o755);
      chmodSync(join(binDir, "docker"), 0o755);
      const rootDir = process.cwd();
      const script = `
set -euo pipefail
ROOT_DIR=${shellQuote(rootDir)}
TMPDIR=${shellQuote(workDir)}
export ROOT_DIR TMPDIR
export PATH="$TMPDIR/bin"
export DOCKER_COMMAND_TIMEOUT=7s

source "$ROOT_DIR/scripts/lib/docker-e2e-container.sh"

set +e
printf payload | docker_e2e_docker_cmd run -i demo 2>"$TMPDIR/stderr"
status="$?"
set -e

stderr="$(<"$TMPDIR/stderr")"
[[ "$status" = "13" ]]
[[ "$stderr" = *"timeout command not found; using Node watchdog for Docker command timeout 7s"* ]]
[[ "$(<"$TMPDIR/docker-seen")" = "run -i demo|payload" ]]
`;

      execFileSync("bash", ["-lc", script], { encoding: "utf8" });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("escalates Docker watchdog children that ignore parent termination", () => {
    const workDir = mkdtempSync(join(tmpdir(), "openclaw-docker-node-signal-"));

    try {
      const binDir = join(workDir, "bin");
      mkdirSync(binDir);
      writeFileSync(
        join(binDir, "node"),
        `#!/bin/bash\nexec ${shellQuote(process.execPath)} "$@"\n`,
      );
      writeFileSync(
        join(binDir, "docker"),
        `#!/bin/bash
printf "%s\\n" "$$" >"$TMPDIR/docker-pid"
printf "%s\\n" "$PPID" >"$TMPDIR/watchdog-pid"
trap "" TERM
while true; do /bin/sleep 1; done
`,
      );
      chmodSync(join(binDir, "node"), 0o755);
      chmodSync(join(binDir, "docker"), 0o755);
      const rootDir = process.cwd();
      const script = `
set -euo pipefail
ROOT_DIR=${shellQuote(rootDir)}
TMPDIR=${shellQuote(workDir)}
export ROOT_DIR TMPDIR
export PATH="$TMPDIR/bin"
export DOCKER_COMMAND_TIMEOUT=30s
export OPENCLAW_DOCKER_TIMEOUT_KILL_GRACE_MS=100

source "$ROOT_DIR/scripts/lib/docker-e2e-container.sh"

docker_e2e_docker_cmd run demo &
watchdog_pid="$!"
for ((i = 0; i < 100; i += 1)); do
  [ -s "$TMPDIR/docker-pid" ] && [ -s "$TMPDIR/watchdog-pid" ] && break
  /bin/sleep 0.02
done
[ -s "$TMPDIR/docker-pid" ]
[ -s "$TMPDIR/watchdog-pid" ]
kill -TERM "$(/bin/cat "$TMPDIR/watchdog-pid")"
set +e
wait "$watchdog_pid"
status="$?"
set -e
[ "$status" = "143" ]
docker_pid="$(/bin/cat "$TMPDIR/docker-pid")"
for ((i = 0; i < 100; i += 1)); do
  kill -0 "$docker_pid" 2>/dev/null || exit 0
  /bin/sleep 0.02
done
echo "docker child still alive after watchdog termination" >&2
exit 1
`;

      execFileSync("bash", ["-lc", script], { encoding: "utf8" });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("uses plain timeout when kill-after is unsupported", () => {
    const workDir = mkdtempSync(join(tmpdir(), "openclaw-docker-plain-timeout-"));

    try {
      const binDir = join(workDir, "bin");
      mkdirSync(binDir);
      writeFileSync(
        join(binDir, "timeout"),
        `#!/bin/bash
set -euo pipefail
if [[ "$1" = "--kill-after=1s" ]]; then
  exit 1
fi
printf 'plain:%s|%s\\n' "$1" "\${*:2}" >>"$TMPDIR/timeout-seen"
shift
"$@"
`,
      );
      chmodSync(join(binDir, "timeout"), 0o755);
      const rootDir = process.cwd();
      const script = `
set -euo pipefail
ROOT_DIR=${shellQuote(rootDir)}
TMPDIR=${shellQuote(workDir)}
export ROOT_DIR TMPDIR
export PATH="$TMPDIR/bin:$PATH"
export DOCKER_COMMAND_TIMEOUT=9s

docker() {
  printf "%s\\n" "$*" >>"$TMPDIR/docker-seen"
}
export -f docker

source "$ROOT_DIR/scripts/lib/docker-e2e-container.sh"

docker_e2e_docker_cmd image inspect demo

grep -q '^plain:9s|docker image inspect demo$' "$TMPDIR/timeout-seen"
grep -q '^image inspect demo$' "$TMPDIR/docker-seen"
`;

      execFileSync("bash", ["-lc", script], { encoding: "utf8" });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("uses gtimeout when timeout is unavailable", () => {
    const workDir = mkdtempSync(join(tmpdir(), "openclaw-docker-gtimeout-"));

    try {
      const binDir = join(workDir, "bin");
      mkdirSync(binDir);
      writeFileSync(
        join(binDir, "gtimeout"),
        `#!/bin/bash
set -euo pipefail
if [[ "$1" = "--kill-after=1s" ]]; then
  exit 0
fi
printf 'gtimeout:%s %s|%s\\n' "$1" "$2" "\${*:3}" >>"$TMPDIR/timeout-seen"
shift 2
"$@"
`,
      );
      chmodSync(join(binDir, "gtimeout"), 0o755);
      const rootDir = process.cwd();
      const script = `
set -euo pipefail
ROOT_DIR=${shellQuote(rootDir)}
TMPDIR=${shellQuote(workDir)}
export ROOT_DIR TMPDIR
export PATH="$TMPDIR/bin"
export OPENCLAW_DOCKER_E2E_RUN_TIMEOUT=13s

docker() {
  printf "%s\\n" "$*" >>"$TMPDIR/docker-seen"
}
export -f docker

source "$ROOT_DIR/scripts/lib/docker-e2e-container.sh"

docker_e2e_docker_run_cmd run demo

[[ "$(<"$TMPDIR/timeout-seen")" = "gtimeout:--kill-after=30s 13s|docker run demo" ]]
[[ "$(<"$TMPDIR/docker-seen")" = "run demo" ]]
`;

      execFileSync("bash", ["-lc", script], { encoding: "utf8" });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("keeps package-backed Docker runs bounded without the shared timeout helper", () => {
    const workDir = mkdtempSync(join(tmpdir(), "openclaw-docker-package-timeout-required-"));

    try {
      mkdirSync(join(workDir, "bin"));
      const rootDir = process.cwd();
      const script = `
set -euo pipefail
ROOT_DIR=${shellQuote(rootDir)}
TMPDIR=${shellQuote(workDir)}
export ROOT_DIR TMPDIR
export PATH="$TMPDIR/bin"
export OPENCLAW_DOCKER_E2E_RUN_TIMEOUT=11s

dirname() {
  /usr/bin/dirname "$@"
}

docker_e2e_docker_cmd() {
  return 0
}

docker() {
  printf "%s\\n" "$*" >"$TMPDIR/docker-seen"
}
export -f docker_e2e_docker_cmd docker

source "$ROOT_DIR/scripts/lib/docker-e2e-package.sh"

set +e
docker_e2e_docker_run_cmd run demo 2>"$TMPDIR/stderr"
status="$?"
set -e

stderr="$(<"$TMPDIR/stderr")"
[[ "$status" = "127" ]]
[[ "$stderr" = *"timeout command not found; cannot bound Docker run after 11s"* ]]
[[ ! -e "$TMPDIR/docker-seen" ]]
`;

      execFileSync("bash", ["-lc", script], { encoding: "utf8" });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("uses gtimeout for package-backed Docker runs without the shared timeout helper", () => {
    const workDir = mkdtempSync(join(tmpdir(), "openclaw-docker-package-gtimeout-"));

    try {
      const binDir = join(workDir, "bin");
      mkdirSync(binDir);
      writeFileSync(
        join(binDir, "gtimeout"),
        `#!/bin/bash
set -euo pipefail
if [[ "$1" = "--kill-after=1s" ]]; then
  exit 0
fi
printf 'gtimeout:%s %s|%s\\n' "$1" "$2" "\${*:3}" >>"$TMPDIR/timeout-seen"
shift 2
"$@"
`,
      );
      chmodSync(join(binDir, "gtimeout"), 0o755);
      const rootDir = process.cwd();
      const script = `
set -euo pipefail
ROOT_DIR=${shellQuote(rootDir)}
TMPDIR=${shellQuote(workDir)}
export ROOT_DIR TMPDIR
export PATH="$TMPDIR/bin"
export OPENCLAW_DOCKER_E2E_RUN_TIMEOUT=15s

dirname() {
  /usr/bin/dirname "$@"
}

docker_e2e_docker_cmd() {
  return 0
}

docker() {
  printf "%s\\n" "$*" >>"$TMPDIR/docker-seen"
}
export -f docker_e2e_docker_cmd docker

source "$ROOT_DIR/scripts/lib/docker-e2e-package.sh"

docker_e2e_docker_run_cmd run demo

[[ "$(<"$TMPDIR/timeout-seen")" = "gtimeout:--kill-after=30s 15s|docker run demo" ]]
[[ "$(<"$TMPDIR/docker-seen")" = "run demo" ]]
`;

      execFileSync("bash", ["-lc", script], { encoding: "utf8" });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("removes functional Docker build package inputs after the build", () => {
    const workDir = mkdtempSync(join(tmpdir(), "openclaw-docker-build-cleanup-"));

    try {
      const rootDir = process.cwd();
      const script = `
set -euo pipefail
ROOT_DIR=${shellQuote(rootDir)}
TMPDIR=${shellQuote(workDir)}
export ROOT_DIR TMPDIR

node() {
  local script="$1"
  shift
  if [[ "$script" != "$ROOT_DIR/scripts/package-openclaw-for-docker.mjs" ]]; then
    command node "$script" "$@"
    return
  fi

  local output_dir=""
  local output_name=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --output-dir)
        output_dir="$2"
        shift 2
        ;;
      --output-name)
        output_name="$2"
        shift 2
        ;;
      *)
        shift
        ;;
    esac
  done

  mkdir -p "$output_dir"
  printf fixture >"$output_dir/$output_name"
  printf "%s\\n" "$output_dir/$output_name"
}
export -f node

source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"

docker_build_run() {
  local build_context=""
  local arg
  for arg in "$@"; do
    case "$arg" in
      openclaw_package=*)
        build_context="\${arg#openclaw_package=}"
        ;;
    esac
  done

  test -n "$build_context"
  test -f "$build_context/openclaw-current.tgz"
  printf "%s\\n" "$build_context" >"$TMPDIR/build-context-seen"
}

docker_e2e_build_or_reuse \\
  openclaw-test-image \\
  cleanup-proof \\
  "$ROOT_DIR/scripts/e2e/Dockerfile" \\
  "$ROOT_DIR" \\
  functional

test -f "$TMPDIR/build-context-seen"
leftovers="$(find "$TMPDIR" -maxdepth 1 \\( \\
  -name 'openclaw-docker-e2e-pack.*' \\
  -o -name 'openclaw-docker-e2e-package-context.*' \\
\\) -print)"
if [[ -n "$leftovers" ]]; then
  printf 'leftover functional build inputs:\\n%s\\n' "$leftovers" >&2
  exit 1
fi
`;

      execFileSync("bash", ["-lc", script], { encoding: "utf8" });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("keeps caller-provided functional Docker build packages", () => {
    const workDir = mkdtempSync(join(tmpdir(), "openclaw-docker-build-external-package-"));

    try {
      const rootDir = process.cwd();
      const script = `
set -euo pipefail
ROOT_DIR=${shellQuote(rootDir)}
TMPDIR=${shellQuote(workDir)}
export ROOT_DIR TMPDIR

external_dir="$TMPDIR/external-package"
mkdir -p "$external_dir"
printf fixture >"$external_dir/openclaw-current.tgz"
OPENCLAW_CURRENT_PACKAGE_TGZ="$external_dir/openclaw-current.tgz"
export OPENCLAW_CURRENT_PACKAGE_TGZ

source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"

docker_build_run() {
  local build_context=""
  local arg
  for arg in "$@"; do
    case "$arg" in
      openclaw_package=*)
        build_context="\${arg#openclaw_package=}"
        ;;
    esac
  done

  test -n "$build_context"
  test -f "$build_context/openclaw-current.tgz"
  printf "%s\\n" "$build_context" >"$TMPDIR/build-context-seen"
}

docker_e2e_build_or_reuse \\
  openclaw-test-image \\
  external-package-proof \\
  "$ROOT_DIR/scripts/e2e/Dockerfile" \\
  "$ROOT_DIR" \\
  functional

test -f "$TMPDIR/build-context-seen"
test -f "$OPENCLAW_CURRENT_PACKAGE_TGZ"
leftovers="$(find "$TMPDIR" -maxdepth 1 -name 'openclaw-docker-e2e-package-context.*' -print)"
if [[ -n "$leftovers" ]]; then
  printf 'leftover functional build context:\\n%s\\n' "$leftovers" >&2
  exit 1
fi
`;

      execFileSync("bash", ["-lc", script], { encoding: "utf8" });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("cleans generated package mounts after harness Docker runs", () => {
    const workDir = mkdtempSync(join(tmpdir(), "openclaw-docker-package-mount-cleanup-"));

    try {
      const rootDir = process.cwd();
      const script = `
set -euo pipefail
ROOT_DIR=${shellQuote(rootDir)}
TMPDIR=${shellQuote(workDir)}
export ROOT_DIR TMPDIR
export DOCKER_COMMAND_TIMEOUT=3s

mkdir -p "$TMPDIR/bin"
cat >"$TMPDIR/bin/timeout" <<'SH'
#!/usr/bin/env bash
case "$1" in
  --kill-after=1s)
    exit 0
    ;;
  --kill-after=30s)
    printf "%s %s\\n" "$1" "$2" >"$TMPDIR/docker-timeout-seen"
    shift 2
    ;;
  *)
    printf "%s\\n" "$1" >"$TMPDIR/docker-timeout-seen"
    shift
    ;;
esac
"$@"
SH
chmod +x "$TMPDIR/bin/timeout"
export PATH="$TMPDIR/bin:$PATH"

node() {
  local script="$1"
  shift
  if [[ "$script" != "$ROOT_DIR/scripts/package-openclaw-for-docker.mjs" ]]; then
    command node "$script" "$@"
    return
  fi

  local output_dir=""
  local output_name=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --output-dir)
        output_dir="$2"
        shift 2
        ;;
      --output-name)
        output_name="$2"
        shift 2
        ;;
      *)
        shift
        ;;
    esac
  done

  mkdir -p "$output_dir"
  printf fixture >"$output_dir/$output_name"
  printf "%s\\n" "$output_dir/$output_name"
}
export -f node

source "$ROOT_DIR/scripts/lib/docker-e2e-package.sh"

docker() {
  local mount_path=""
  local expect_volume_path=0
  local arg
  for arg in "$@"; do
    if [[ "$expect_volume_path" == "1" ]]; then
      mount_path="\${arg%%:*}"
      expect_volume_path=0
      continue
    fi
    if [[ "$arg" == "-v" ]]; then
      expect_volume_path=1
    fi
  done

  test -n "$mount_path"
  test -f "$mount_path"
  printf "%s\\n" "$mount_path" >"$TMPDIR/package-mount-seen"
  return "\${DOCKER_STUB_STATUS:-0}"
}
export -f docker

package_tgz="$(docker_e2e_prepare_package_tgz mount-cleanup)"
pack_dir="$(dirname "$package_tgz")"
docker_e2e_package_mount_args "$package_tgz"
DOCKER_STUB_STATUS=7 docker_e2e_run_with_harness image-name bash -lc true || run_status="$?"
test "\${run_status:-0}" = "7"
test "$(cat "$TMPDIR/docker-timeout-seen")" = "--kill-after=30s 3s"
test -f "$TMPDIR/package-mount-seen"
test ! -e "$pack_dir"

external_dir="$TMPDIR/external-package"
mkdir -p "$external_dir"
printf fixture >"$external_dir/openclaw-current.tgz"
docker_e2e_package_mount_args "$external_dir/openclaw-current.tgz"
unset DOCKER_COMMAND_TIMEOUT
rm -f "$TMPDIR/docker-timeout-seen"
docker_e2e_run_with_harness image-name bash -lc true
test "$(cat "$TMPDIR/docker-timeout-seen")" = "--kill-after=30s 3600s"
test -f "$external_dir/openclaw-current.tgz"
`;

      execFileSync("bash", ["-lc", script], { encoding: "utf8" });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("propagates shared E2E command timeouts into package-backed containers", () => {
    const workDir = mkdtempSync(join(tmpdir(), "openclaw-docker-package-timeout-env-"));

    try {
      const rootDir = process.cwd();
      const script = `
set -euo pipefail
ROOT_DIR=${shellQuote(rootDir)}
TMPDIR=${shellQuote(workDir)}
export ROOT_DIR TMPDIR
source "$ROOT_DIR/scripts/lib/docker-e2e-package.sh"

package="$TMPDIR/openclaw-current.tgz"
printf fixture >"$package"
export OPENCLAW_E2E_NPM_INSTALL_TIMEOUT=42s
export OPENCLAW_E2E_COMMAND_TIMEOUT=23s
docker_e2e_package_mount_args "$package"
printf "%s\\n" "\${DOCKER_E2E_PACKAGE_ARGS[@]}" >"$TMPDIR/package-args"

grep -qx -- "-e" "$TMPDIR/package-args"
grep -qx -- "OPENCLAW_CURRENT_PACKAGE_TGZ=/tmp/openclaw-current.tgz" "$TMPDIR/package-args"
grep -qx -- "OPENCLAW_E2E_NPM_INSTALL_TIMEOUT=42s" "$TMPDIR/package-args"
grep -qx -- "OPENCLAW_E2E_COMMAND_TIMEOUT=23s" "$TMPDIR/package-args"
`;

      execFileSync("bash", ["-lc", script], { encoding: "utf8" });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("passes plugin lifecycle sampler timeout overrides into Docker", () => {
    const runner = readFileSync(PLUGIN_LIFECYCLE_MATRIX_DOCKER_E2E_PATH, "utf8");

    expect(runner).toContain('if [ -n "${OPENCLAW_PLUGIN_LIFECYCLE_PHASE_TIMEOUT_MS:-}" ]; then');
    expect(runner).toContain(
      'DOCKER_ENV_ARGS+=(-e "OPENCLAW_PLUGIN_LIFECYCLE_PHASE_TIMEOUT_MS=$OPENCLAW_PLUGIN_LIFECYCLE_PHASE_TIMEOUT_MS")',
    );
    expect(runner).toContain(
      'if [ -n "${OPENCLAW_PLUGIN_LIFECYCLE_TIMEOUT_KILL_GRACE_MS:-}" ]; then',
    );
    expect(runner).toContain(
      'DOCKER_ENV_ARGS+=(-e "OPENCLAW_PLUGIN_LIFECYCLE_TIMEOUT_KILL_GRACE_MS=$OPENCLAW_PLUGIN_LIFECYCLE_TIMEOUT_KILL_GRACE_MS")',
    );
    expect(runner).toContain('docker_e2e_run_with_harness \\\n  "${DOCKER_ENV_ARGS[@]}"');
  });

  it("wraps direct Docker E2E npm installs with the shared timeout helper", () => {
    const multiNode = readFileSync(MULTI_NODE_UPDATE_DOCKER_E2E_PATH, "utf8");
    const updateChannel = readFileSync(UPDATE_CHANNEL_SWITCH_DOCKER_E2E_PATH, "utf8");
    const doctorSwitch = readFileSync(DOCTOR_SWITCH_SCENARIO_PATH, "utf8");
    const releaseUpgrade = readFileSync(RELEASE_UPGRADE_USER_JOURNEY_SCENARIO_PATH, "utf8");
    const upgradeSurvivor = readFileSync(UPGRADE_SURVIVOR_RUN_SCRIPT, "utf8");
    const pluginCorrupt = readFileSync(PLUGIN_UPDATE_CORRUPT_SCENARIO_PATH, "utf8");

    expect(multiNode).toContain(
      'openclaw_e2e_install_package "$ARTIFACTS/install-a.log" "OpenClaw package under node-A prefix" "$NPM_PREFIX_A"',
    );
    expect(updateChannel).toContain(
      'openclaw_e2e_maybe_timeout "${OPENCLAW_E2E_NPM_INSTALL_TIMEOUT:-600s}" npm install --omit=optional --no-fund --no-audit',
    );
    expect(updateChannel).toContain(
      'openclaw_e2e_maybe_timeout "${OPENCLAW_E2E_NPM_INSTALL_TIMEOUT:-600s}" npm install -g --prefix /tmp/npm-prefix --omit=optional "$pkg_tgz_path"',
    );
    expect(doctorSwitch).toContain(
      'openclaw_e2e_maybe_timeout "${OPENCLAW_E2E_NPM_INSTALL_TIMEOUT:-600s}" npm install --omit=optional --no-fund --no-audit',
    );
    expect(doctorSwitch).toContain(
      'openclaw_e2e_maybe_timeout "${OPENCLAW_E2E_NPM_INSTALL_TIMEOUT:-600s}" npm install -g --prefix /tmp/npm-prefix --omit=optional "$package_tgz"',
    );
    for (const script of [releaseUpgrade, upgradeSurvivor, pluginCorrupt]) {
      expect(script).toContain(
        'openclaw_e2e_maybe_timeout "${OPENCLAW_E2E_NPM_INSTALL_TIMEOUT:-600s}" npm install -g',
      );
    }
  });

  it("keeps upgrade survivor mutable state off the host-mounted artifact tree", () => {
    const runner = readFileSync(UPGRADE_SURVIVOR_DOCKER_E2E_PATH, "utf8");
    const publishedRunner = readFileSync(UPGRADE_SURVIVOR_RUN_SCRIPT, "utf8");

    for (const script of [runner, publishedRunner]) {
      expect(script).toContain("openclaw-upgrade-survivor-runtime");
      expect(script).toContain("OPENCLAW_UPGRADE_SURVIVOR_TMPDIR");
      expect(script).toContain("OPENCLAW_UPGRADE_SURVIVOR_TEST_STATE_TMPDIR");
      expect(script).toContain(
        'export npm_config_cache="${OPENCLAW_UPGRADE_SURVIVOR_NPM_CACHE:-$OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT/npm-cache}"',
      );
      expect(script).toContain('export NPM_CONFIG_CACHE="$npm_config_cache"');
      expect(script).toContain('chmod 700 "$npm_config_cache" || true');
      expect(script).not.toContain('export TMPDIR="$ARTIFACT_ROOT/tmp"');
      expect(script).not.toContain('export TMPDIR="$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/tmp"');
      expect(script).not.toContain('export npm_config_cache="$ARTIFACT_ROOT/npm-cache"');
      expect(script).not.toContain(
        'export npm_config_cache="$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/npm-cache"',
      );
    }
  });

  it("wraps package-backed scenario OpenClaw CLI calls with the shared timeout helper", () => {
    const paths = [
      CODEX_ON_DEMAND_DOCKER_E2E_PATH,
      CODEX_MEDIA_PATH_SCENARIO_PATH,
      CODEX_NPM_PLUGIN_LIVE_DOCKER_E2E_PATH,
      LIVE_PLUGIN_TOOL_DOCKER_E2E_PATH,
      NPM_ONBOARD_CHANNEL_AGENT_DOCKER_E2E_PATH,
      UPDATE_CHANNEL_SWITCH_DOCKER_E2E_PATH,
      RELEASE_UPGRADE_USER_JOURNEY_SCENARIO_PATH,
      "scripts/e2e/lib/release-media-memory/scenario.sh",
      "scripts/e2e/lib/release-plugin-marketplace/scenario.sh",
      "scripts/e2e/lib/release-typed-onboarding/scenario.sh",
      "scripts/e2e/lib/release-user-journey/scenario.sh",
    ];

    for (const path of paths) {
      const script = readFileSync(path, "utf8");

      expect(script, path).toContain("openclaw_e2e_enable_openclaw_cli_timeout");
    }
    expect(readFileSync(RELEASE_UPGRADE_USER_JOURNEY_SCENARIO_PATH, "utf8")).toContain(
      'openclaw_e2e_run_command node "$baseline_entry" onboard',
    );
  });

  it("kills timed Docker scenario runners after the grace period", () => {
    const multiNode = readFileSync(MULTI_NODE_UPDATE_DOCKER_E2E_PATH, "utf8");
    const upgradeSurvivor = readFileSync(UPGRADE_SURVIVOR_DOCKER_E2E_PATH, "utf8");

    expect(multiNode).toContain('timeout --kill-after=30s "$DOCKER_RUN_TIMEOUT" bash -lc');
    expect(upgradeSurvivor).toContain(
      'timeout --kill-after=30s "$DOCKER_RUN_TIMEOUT" bash scripts/e2e/lib/upgrade-survivor/run.sh',
    );
    expect(upgradeSurvivor).toContain('timeout --kill-after=30s "$DOCKER_RUN_TIMEOUT" bash -lc');
    for (const script of [multiNode, upgradeSurvivor]) {
      expect(script).not.toContain('timeout "$DOCKER_RUN_TIMEOUT"');
    }
  });

  it("bounds upgrade survivor foreground OpenClaw CLI calls", () => {
    const runner = readFileSync(UPGRADE_SURVIVOR_DOCKER_E2E_PATH, "utf8");
    const publishedRunner = readFileSync(UPGRADE_SURVIVOR_RUN_SCRIPT, "utf8");
    const updateRestartAuth = readFileSync(UPGRADE_SURVIVOR_UPDATE_RESTART_AUTH_PATH, "utf8");

    expect(runner).toContain(
      'COMMAND_TIMEOUT="${OPENCLAW_UPGRADE_SURVIVOR_COMMAND_TIMEOUT:-900s}"',
    );
    expect(runner).toContain('-e OPENCLAW_UPGRADE_SURVIVOR_COMMAND_TIMEOUT="$COMMAND_TIMEOUT"');
    expect(runner).toContain(
      'command_timeout="${OPENCLAW_UPGRADE_SURVIVOR_COMMAND_TIMEOUT:-900s}"',
    );
    expect(runner).toContain(
      'openclaw_e2e_maybe_timeout "$command_timeout" env -u OPENCLAW_GATEWAY_TOKEN',
    );
    expect(runner).toContain(
      'openclaw_e2e_maybe_timeout "$command_timeout" openclaw doctor --fix --non-interactive',
    );
    expect(runner).toContain(
      'openclaw_e2e_maybe_timeout "$command_timeout" openclaw config validate',
    );
    expect(runner).toContain(
      'openclaw_e2e_maybe_timeout "$command_timeout" openclaw gateway status',
    );
    expect(runner).toContain(
      'openclaw gateway --port "$PORT" --bind loopback --allow-unconfigured',
    );

    expect(publishedRunner).toContain(
      'COMMAND_TIMEOUT="${OPENCLAW_UPGRADE_SURVIVOR_COMMAND_TIMEOUT:-900s}"',
    );
    expect(publishedRunner).toContain(
      'openclaw_e2e_maybe_timeout "$COMMAND_TIMEOUT" env -u OPENCLAW_GATEWAY_TOKEN',
    );
    expect(publishedRunner).toContain(
      'openclaw_e2e_maybe_timeout "$COMMAND_TIMEOUT" openclaw --version',
    );
    expect(publishedRunner).toContain(
      'openclaw_e2e_maybe_timeout "$COMMAND_TIMEOUT" openclaw config validate >"$BASELINE_CONFIG_VALIDATE_LOG"',
    );
    expect(publishedRunner).toContain(
      'openclaw_e2e_maybe_timeout "$COMMAND_TIMEOUT" "${update_env[@]}" openclaw',
    );
    expect(publishedRunner).toContain(
      'openclaw_e2e_maybe_timeout "$COMMAND_TIMEOUT" "${root_cli_env[@]}" openclaw',
    );
    expect(publishedRunner).toContain(
      'openclaw_e2e_maybe_timeout "$COMMAND_TIMEOUT" openclaw doctor --fix --non-interactive',
    );
    expect(publishedRunner).toContain(
      'openclaw_e2e_maybe_timeout "$COMMAND_TIMEOUT" openclaw config validate',
    );
    expect(publishedRunner).toContain(
      'openclaw_e2e_maybe_timeout "$COMMAND_TIMEOUT" openclaw gateway status',
    );
    expect(publishedRunner).toContain('openclaw gateway --port "$port" --bind loopback');

    expect(updateRestartAuth).toContain(
      'command_timeout="${OPENCLAW_UPGRADE_SURVIVOR_COMMAND_TIMEOUT:-900s}"',
    );
    expect(updateRestartAuth).toContain(
      'openclaw_e2e_maybe_timeout "$command_timeout" env -u OPENCLAW_GATEWAY_TOKEN',
    );
    expect(updateRestartAuth).toContain('openclaw gateway --port "$port" --bind loopback');
  });

  it("keeps the harness run wrapper available with pre-sourced Docker command helpers", () => {
    const workDir = mkdtempSync(join(tmpdir(), "openclaw-docker-package-helper-guard-"));

    try {
      const rootDir = process.cwd();
      const script = `
set -euo pipefail
ROOT_DIR=${shellQuote(rootDir)}
TMPDIR=${shellQuote(workDir)}
export ROOT_DIR TMPDIR

mkdir -p "$TMPDIR/bin"
cat >"$TMPDIR/bin/timeout" <<'SH'
#!/usr/bin/env bash
case "$1" in
  --kill-after=1s)
    exit 0
    ;;
  --kill-after=30s)
    shift 2
    ;;
  *)
    shift
    ;;
esac
"$@"
SH
chmod +x "$TMPDIR/bin/timeout"
export PATH="$TMPDIR/bin:$PATH"

docker_e2e_docker_cmd() {
  printf "%s\\n" "$*" >"$TMPDIR/docker-cmd-seen"
}

docker() {
  printf "%s\\n" "$*" >"$TMPDIR/docker-run-seen"
}
export -f docker

source "$ROOT_DIR/scripts/lib/docker-e2e-package.sh"

docker_e2e_run_with_harness image-name bash -lc true
test -f "$TMPDIR/docker-run-seen"

docker_e2e_run_detached_with_harness image-name
test -f "$TMPDIR/docker-cmd-seen"
`;

      execFileSync("bash", ["-lc", script], { encoding: "utf8" });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("cleans Codex npm plugin live package artifacts on every exit path", () => {
    const runner = readFileSync(CODEX_NPM_PLUGIN_LIVE_DOCKER_E2E_PATH, "utf8");

    expect(runner).toContain('CODEX_PLUGIN_PACK_DIR=""');
    expect(runner).toContain('run_log=""');
    expect(runner).toMatch(
      /cleanup\(\) \{[\s\S]*rm -rf "\$CODEX_PLUGIN_PACK_DIR"[\s\S]*docker_e2e_cleanup_package_tgz "\$PACKAGE_TGZ"[\s\S]*rm -f "\$run_log"/u,
    );
    expect(runner).toContain("trap cleanup EXIT");
    expect(runner).not.toContain('rm -f "$run_log"\n  exit 1');
  });

  it("cleans package-backed onboarding and plugin Docker artifacts on every exit path", () => {
    for (const path of [
      CODEX_ON_DEMAND_DOCKER_E2E_PATH,
      LIVE_PLUGIN_TOOL_DOCKER_E2E_PATH,
      NPM_ONBOARD_CHANNEL_AGENT_DOCKER_E2E_PATH,
    ]) {
      const runner = readFileSync(path, "utf8");

      expect(runner, path).toContain('run_log=""');
      expect(runner, path).toMatch(
        /cleanup\(\) \{[\s\S]*docker_e2e_cleanup_package_tgz "\$PACKAGE_TGZ"[\s\S]*rm -f "\$run_log"/u,
      );
      expect(runner, path).toContain("trap cleanup EXIT");
      expect(runner, path).not.toContain('rm -f "$run_log"\n  exit 1');
    }
  });

  it("cleans every prepared Docker package tarball on every runner exit path", () => {
    const paths = packageBackedDockerRunnerPaths();

    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      const runner = readFileSync(path, "utf8");

      expect(runner, path).toMatch(
        /docker_e2e_cleanup_package_tgz "\$\{PACKAGE_TGZ:-\}"|docker_e2e_cleanup_package_tgz "\$PACKAGE_TGZ"/u,
      );
      expect(runner, path).toMatch(/trap cleanup(?:_outer)? EXIT/u);
      expect(runner, path).not.toContain('rm -f "$run_log"\n  exit 1');
    }
  });

  it("runs skill install through the package-cleaning Docker harness", () => {
    const runner = readFileSync(SKILL_INSTALL_DOCKER_E2E_PATH, "utf8");

    expect(runner).toContain('docker_e2e_package_mount_args "$PACKAGE_TGZ"');
    expect(runner).toMatch(
      /run_logged_print \\\n\s+skill-install-run \\\n\s+docker_e2e_run_with_harness \\/u,
    );
    expect(runner).not.toContain("docker_e2e_harness_mount_args");
    expect(runner).not.toContain("docker run --rm");
  });

  it("prints plugins Docker E2E logs on successful runs", () => {
    const helper = readFileSync(DOCKER_E2E_PACKAGE_HELPER_PATH, "utf8");
    const runner = readFileSync(PLUGINS_DOCKER_E2E_PATH, "utf8");

    expect(helper).toContain("docker_e2e_run_logged_print_with_harness()");
    expect(helper).toContain("run_logged_print_heartbeat \\");
    expect(helper).toContain("OPENCLAW_DOCKER_E2E_LOG_HEARTBEAT_SECONDS");
    expect(runner).toContain("docker_e2e_run_logged_print_with_harness \\");
    expect(runner).not.toContain("docker_e2e_run_logged_with_harness plugins-run");
  });

  it("includes procps in the shared Docker E2E image for process watchdogs", () => {
    const dockerfile = readFileSync("scripts/e2e/Dockerfile", "utf8");

    expect(dockerfile).toContain("procps");
  });

  it("keeps onboarding Docker E2E resource-guarded", () => {
    const runner = readFileSync(ONBOARD_DOCKER_E2E_PATH, "utf8");

    expect(runner).toContain("OPENCLAW_ONBOARD_MAX_MEMORY_MIB");
    expect(runner).toContain("OPENCLAW_ONBOARD_MAX_CPU_PERCENT");
    expect(runner).toContain(
      'COMMAND_TIMEOUT="${OPENCLAW_ONBOARD_COMMAND_TIMEOUT:-${OPENCLAW_E2E_COMMAND_TIMEOUT:-300s}}"',
    );
    expect(runner).toContain('-e "OPENCLAW_E2E_COMMAND_TIMEOUT=$COMMAND_TIMEOUT"');
    expect(runner).toContain('--name "$CONTAINER_NAME"');
    expect(runner).toContain("docker_e2e_sample_stats_until_exit \\");
    expect(runner).toContain('"$STATS_LOG" \\');
    expect(runner).toContain('"$RUN_LOG" \\');
    expect(runner).toContain("assert-resource-ceiling.mjs");
    expect(runner).not.toContain("docker_e2e_run_with_harness -t");
  });

  it("cleans resource-sampled Docker E2E temp logs on every exit path", () => {
    for (const { path, label } of [
      { path: ONBOARD_DOCKER_E2E_PATH, label: "onboard" },
      { path: KITCHEN_SINK_PLUGIN_DOCKER_E2E_PATH, label: "kitchen-sink" },
      { path: KITCHEN_SINK_RPC_DOCKER_E2E_PATH, label: "kitchen-sink-rpc" },
    ]) {
      const runner = readFileSync(path, "utf8");
      const resourceAssertion = `node scripts/e2e/lib/docker-stats/assert-resource-ceiling.mjs "$STATS_LOG" "$MAX_MEMORY_MIB" "$MAX_CPU_PERCENT" ${label}`;

      expect(runner, path).toContain('RUN_LOG="$(mktemp');
      expect(runner, path).toContain('STATS_LOG="$(mktemp');
      expect(runner, path).toContain(
        'DOCKER_COMMAND_TIMEOUT="$DOCKER_RUN_TIMEOUT" docker_e2e_docker_run_cmd run --name "$CONTAINER_NAME"',
      );
      expect(runner, path).toContain('DOCKER_RUN_TIMEOUT="${OPENCLAW_');
      expect(runner, path).toContain("docker_e2e_sample_stats_until_exit \\");
      expect(runner, path).toContain('"$STATS_LOG" \\');
      expect(runner, path).toContain('"$RUN_LOG" \\');
      expect(runner, path).not.toMatch(/(^|\n)docker run --name "\$CONTAINER_NAME"/u);
      expect(runner, path).not.toMatch(/(^|\n)docker (?:inspect|stats) /u);
      expect(runner, path).toMatch(/cleanup\(\) \{[\s\S]*rm -f "\$RUN_LOG" "\$STATS_LOG"/u);
      expect(runner, path).toContain(`if [ "$run_status" -eq 0 ]; then\n  ${resourceAssertion}`);
      expect(runner, path).toContain(
        `elif [ -s "$STATS_LOG" ]; then\n  ${resourceAssertion} || true`,
      );
      expect(runner, path).not.toContain(`${resourceAssertion}\n\nexit "$run_status"`);
    }
  });

  it("bounds kitchen-sink plugin CLI commands inside the Docker sweep", () => {
    const runner = readFileSync(KITCHEN_SINK_PLUGIN_DOCKER_E2E_PATH, "utf8");
    const sweep = readFileSync("scripts/e2e/lib/kitchen-sink-plugin/sweep.sh", "utf8");

    expect(runner).toContain(
      'KITCHEN_SINK_CLI_TIMEOUT="${OPENCLAW_KITCHEN_SINK_PLUGIN_CLI_TIMEOUT:-${KITCHEN_SINK_CLI_TIMEOUT:-180s}}"',
    );
    expect(runner).toContain('-e "KITCHEN_SINK_CLI_TIMEOUT=$KITCHEN_SINK_CLI_TIMEOUT"');
    expect(sweep).toContain('KITCHEN_SINK_CLI_TIMEOUT="${KITCHEN_SINK_CLI_TIMEOUT:-180s}"');
    expect(sweep).toContain("run_kitchen_sink_openclaw_logged()");
    expect(sweep).toContain("run_kitchen_sink_openclaw_capture()");
    expect(sweep).toContain(
      'run_logged_print "$label" openclaw_e2e_maybe_timeout "$KITCHEN_SINK_CLI_TIMEOUT" node "$OPENCLAW_ENTRY" "$@"',
    );
    for (const line of sweep.split("\n")) {
      if (!line.includes('node "$OPENCLAW_ENTRY" plugins')) {
        continue;
      }

      expect(line).toContain("openclaw_e2e_maybe_timeout");
    }
  });

  it("routes named Docker E2E container cleanup through the timeout-aware helper", () => {
    for (const path of readdirSync("scripts/e2e")
      .filter((entry) => entry.endsWith("-docker.sh"))
      .map((entry) => join("scripts/e2e", entry))) {
      const runner = readFileSync(path, "utf8");
      if (!runner.includes('CONTAINER_NAME="')) {
        continue;
      }

      expect(runner, path).not.toMatch(/(^|\n)\s*docker rm -f "\$CONTAINER_NAME"/u);
      expect(runner, path).toContain('docker_e2e_docker_cmd rm -f "$CONTAINER_NAME"');
    }
  });

  it("routes the gateway network client through the timeout-aware run helper", () => {
    const runner = readFileSync(GATEWAY_NETWORK_DOCKER_E2E_PATH, "utf8");

    expect(runner).toContain(
      'DOCKER_COMMAND_TIMEOUT="$CLIENT_TIMEOUT" run_logged gateway-network-client docker_e2e_docker_run_cmd run --rm',
    );
    expect(runner).not.toContain(
      'run_logged gateway-network-client timeout "$CLIENT_TIMEOUT" docker run --rm',
    );
  });

  it("copies root lifecycle scripts before cleanup-smoke installs dependencies", () => {
    const dockerfile = readFileSync(CLEANUP_SMOKE_DOCKERFILE_PATH, "utf8");
    const installIndex = dockerfile.indexOf("pnpm install --frozen-lockfile");

    for (const script of [
      "scripts/preinstall-package-manager-warning.mjs",
      "scripts/postinstall-bundled-plugins.mjs",
      "scripts/prepare-git-hooks.mjs",
    ]) {
      const copyIndex = dockerfile.indexOf(script);

      expect(copyIndex, script).toBeGreaterThanOrEqual(0);
      expect(copyIndex, script).toBeLessThan(installIndex);
    }
  });

  it("mounts root helper modules imported by bare Docker E2E scripts", () => {
    const helper = readFileSync(DOCKER_E2E_PACKAGE_HELPER_PATH, "utf8");

    expect(helper).toContain(
      '-v "$ROOT_DIR/scripts/windows-cmd-helpers.mjs:/app/scripts/windows-cmd-helpers.mjs:ro"',
    );
  });

  it("preserves pnpm lookup paths for scheduled Docker child lanes", () => {
    const scheduler = readFileSync(DOCKER_ALL_SCHEDULER_PATH, "utf8");

    expect(scheduler).toContain("env.PNPM_HOME");
    expect(scheduler).toContain("env.npm_execpath ? path.dirname(env.npm_execpath)");
    expect(scheduler).toContain("path.dirname(process.execPath)");
    expect(scheduler).toContain("env.PATH = [...new Set(pathEntries)].join(path.delimiter)");
    expect(scheduler).toContain("withResolvedPnpmCommand");
    expect(scheduler).toContain("OPENCLAW_DOCKER_ALL_PNPM_COMMAND");
  });

  it("runs release installer E2E against the npm beta tag", () => {
    const scenarios = readFileSync(DOCKER_E2E_SCENARIOS_PATH, "utf8");
    const openWebUiRunner = readFileSync(OPENWEBUI_DOCKER_E2E_PATH, "utf8");

    expect(scenarios).toContain(
      '"OPENCLAW_INSTALL_TAG=beta OPENCLAW_E2E_MODELS=openai OPENCLAW_INSTALL_E2E_IMAGE=openclaw-install-e2e-openai:local OPENCLAW_INSTALL_E2E_AGENT_TOOL_SMOKE=0 OPENCLAW_INSTALL_E2E_OPENAI_MODEL=openai/gpt-5.4-mini OPENCLAW_INSTALL_E2E_AGENT_TURN_TIMEOUT_SECONDS=120 OPENCLAW_INSTALL_E2E_OPENAI_PROVIDER_TIMEOUT_SECONDS=120 pnpm test:install:e2e"',
    );
    expect(scenarios).toContain(
      '"OPENCLAW_INSTALL_TAG=beta OPENCLAW_E2E_MODELS=anthropic OPENCLAW_INSTALL_E2E_IMAGE=openclaw-install-e2e-anthropic:local pnpm test:install:e2e"',
    );
    expect(scenarios).toContain(
      '"OPENCLAW_OPENWEBUI_MODEL=openai/gpt-5.4-mini OPENWEBUI_SMOKE_MODE=models OPENCLAW_OPENWEBUI_PROVIDER_TIMEOUT_SECONDS=300 OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:openwebui"',
    );
    expect(openWebUiRunner).toContain(
      'SMOKE_MODE="${OPENWEBUI_SMOKE_MODE:-${OPENCLAW_OPENWEBUI_SMOKE_MODE:-chat}}"',
    );
    expect(openWebUiRunner).toContain('-e "OPENWEBUI_SMOKE_MODE=$SMOKE_MODE"');
  });

  it("times and parallelizes release installer E2E agent turns after gateway startup", () => {
    const runner = readFileSync(INSTALL_E2E_RUNNER_PATH, "utf8");
    const wrapper = readFileSync("scripts/test-install-sh-e2e-docker.sh", "utf8");

    expect(runner).toContain(
      'AGENT_TURNS_PARALLEL="${OPENCLAW_INSTALL_E2E_AGENT_TURNS_PARALLEL:-1}"',
    );
    expect(runner).toContain("time_phase");
    expect(runner).toContain("phase_mark_start");
    expect(runner).toContain("run_agent_turn_bg");
    expect(runner).toContain("wait_agent_turn_batch");
    expect(runner).toContain("agent_turn_outputs_include_billing_drift");
    expect(runner).toContain("SKIP: Anthropic billing drift during installer agent tool smoke");
    expect(runner).not.toContain('run_agent_turn_bg "read proof"');
    expect(runner).toContain('run_agent_turn_bg "image write"');
    expect(runner).toContain('run_agent_turn_logged_or_skip_profile "read proof copy"');
    expect(wrapper).toContain("OPENCLAW_INSTALL_E2E_AGENT_TURNS_PARALLEL");
    expect(wrapper).toContain("OPENCLAW_INSTALL_E2E_AGENT_TOOL_SMOKE");
    expect(wrapper).toContain("OPENCLAW_INSTALL_E2E_OPENAI_MODEL");
    expect(wrapper).toContain("OPENCLAW_INSTALL_E2E_OPENAI_PROVIDER_TIMEOUT_SECONDS");
    expect(wrapper).toContain("OPENCLAW_INSTALL_E2E_AGENT_TURN_TIMEOUT_SECONDS:-300");
    expect(runner).toContain("OPENCLAW_INSTALL_E2E_OPENAI_MODEL");
    expect(runner).toContain("OPENCLAW_INSTALL_E2E_OPENAI_PROVIDER_TIMEOUT_SECONDS");
    expect(runner).toContain(
      'AGENT_TURN_TIMEOUT_SECONDS="${OPENCLAW_INSTALL_E2E_AGENT_TURN_TIMEOUT_SECONDS:-300}"',
    );
  });

  it("keeps package acceptance plugin coverage offline-capable", () => {
    const scenarios = readFileSync(DOCKER_E2E_SCENARIOS_PATH, "utf8");

    expect(scenarios).toContain('"plugins-offline"');
    expect(scenarios).toContain("`bundled-plugin-install-uninstall-${index}`");
    expect(scenarios).toContain("pnpm test:docker:bundled-plugin-install-uninstall");
    expect(scenarios).toContain("OPENCLAW_PLUGINS_E2E_CLAWHUB=0");
  });

  it("allows plugin update smoke to tolerate config metadata migrations", () => {
    const runner = readFileSync(PLUGIN_UPDATE_DOCKER_E2E_PATH, "utf8");
    const scenario = readFileSync(PLUGIN_UPDATE_SCENARIO_PATH, "utf8");
    const probe = readFileSync(PLUGIN_UPDATE_PROBE_PATH, "utf8");

    expect(runner).toContain("scripts/e2e/lib/plugin-update/unchanged-scenario.sh");
    expect(probe).toContain("plugin install record changed unexpectedly");
    expect(probe).toContain(
      "readPluginInstallRecords({ fallbackRecords: config.plugins?.installs ?? {} })",
    );
    expect(scenario).toContain("Config changed unexpectedly for modern package");
    expect(scenario).not.toContain("before_hash");
  });

  it("fails the multi-node update probe on update or restart regressions", () => {
    const runner = readFileSync(MULTI_NODE_UPDATE_DOCKER_E2E_PATH, "utf8");

    expect(runner).toContain("UPDATE_FAILED=0");
    expect(runner).toContain("GATEWAY_START_FAILED=0");
    expect(runner).toContain("GATEWAY_HEALTH_FAILED=0");
    expect(runner).toContain('if [ "$UPDATE_FAILED" -ne 0 ]; then');
    expect(runner).toContain('if [ "$GATEWAY_START_FAILED" -ne 0 ]; then');
    expect(runner).toContain('if [ "$GATEWAY_HEALTH_FAILED" -ne 0 ]; then');
    expect(runner).toContain("ActiveState=active");
    expect(runner).toContain("OPENCLAW_NO_RESPAWN=1");
    expect(runner).toContain("is-enabled)");
    expect(runner).toContain("/healthz");
    expect(runner).toContain("FAIL: gateway install failed before update");
    expect(runner).not.toContain('gateway-install.err" || true');
    expect(runner).not.toContain("WARNING: Gateway status probe failed");
  });

  it("caps package acceptance legacy compatibility at 2026.4.25", () => {
    const doctorScenario = readFileSync(DOCTOR_SWITCH_SCENARIO_PATH, "utf8");
    const updateChannel = readFileSync(UPDATE_CHANNEL_SWITCH_DOCKER_E2E_PATH, "utf8");
    const pluginsSweep = readFileSync(PLUGINS_DOCKER_SWEEP_PATH, "utf8");
    const pluginsMarketplace = readFileSync(PLUGINS_DOCKER_MARKETPLACE_PATH, "utf8");
    const pluginsClawhub = readFileSync(PLUGINS_DOCKER_CLAWHUB_PATH, "utf8");
    const pluginsAssertions = readFileSync(PLUGINS_DOCKER_ASSERTIONS_PATH, "utf8");
    const pluginUpdateScenario = readFileSync(PLUGIN_UPDATE_SCENARIO_PATH, "utf8");
    const pluginUpdateProbe = readFileSync(PLUGIN_UPDATE_PROBE_PATH, "utf8");
    const updateChannelAssertions = readFileSync(UPDATE_CHANNEL_SWITCH_ASSERTIONS_PATH, "utf8");
    const packageCompat = readFileSync(PACKAGE_COMPAT_PATH, "utf8");
    const scripts = [
      doctorScenario,
      updateChannel,
      updateChannelAssertions,
      pluginsSweep,
      pluginsMarketplace,
      pluginsClawhub,
      pluginsAssertions,
      pluginUpdateScenario,
      pluginUpdateProbe,
    ];

    expect(readFileSync(DOCTOR_SWITCH_DOCKER_E2E_PATH, "utf8")).toContain(
      "scripts/e2e/lib/doctor-install-switch/scenario.sh",
    );
    expect(readFileSync(PLUGINS_DOCKER_E2E_PATH, "utf8")).toContain(
      "scripts/e2e/lib/plugins/sweep.sh",
    );
    expect(readFileSync(PLUGIN_UPDATE_DOCKER_E2E_PATH, "utf8")).toContain(
      "scripts/e2e/lib/plugin-update/unchanged-scenario.sh",
    );
    expect(packageCompat).toContain("day <= 25");
    expect(doctorScenario).toContain("scripts/e2e/lib/package-compat.mjs");
    expect(pluginsSweep).toContain("scripts/e2e/lib/package-compat.mjs");
    expect(pluginUpdateProbe).toContain("../package-compat.mjs");
    expect(scripts.join("\n")).toContain("OPENCLAW_PACKAGE_ACCEPTANCE_LEGACY_COMPAT");
    expect(scripts.join("\n")).toContain(
      "Package $package_version must support gateway install --wrapper.",
    );
    expect(updateChannel).toContain("assert-config-channel dev");
    expect(updateChannelAssertions).toContain("expected persisted update.channel ${channel}");
    expect(pluginsAssertions).toContain("expected modern installRecords in installed plugin index");
  });

  it("routes doctor install switch commands through the E2E timeout helper", () => {
    const scenario = readFileSync(DOCTOR_SWITCH_SCENARIO_PATH, "utf8");

    expect(scenario).toContain(
      'command_timeout="${OPENCLAW_DOCKER_DOCTOR_SWITCH_COMMAND_TIMEOUT:-900s}"',
    );
    expect(scenario).toContain(
      'openclaw_e2e_maybe_timeout "$command_timeout" bash -c "$install_cmd"',
    );
    expect(scenario).toContain(
      'openclaw_e2e_maybe_timeout "$command_timeout" bash -c "$doctor_cmd"',
    );
    expect(scenario).toContain(
      'openclaw_e2e_maybe_timeout "$command_timeout" "$npm_bin" gateway install --wrapper "$wrapper" --force',
    );
    expect(scenario).toContain(
      'openclaw_e2e_maybe_timeout "$command_timeout" node "$git_cli" doctor --repair --force --yes',
    );
    expect(scenario).not.toMatch(/^\s*if ! timeout "\$command_timeout"/mu);
  });

  it("prepares pnpm workspace package fixtures without package dependencies", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-update-channel-fixture-"));
    try {
      mkdirSync(join(root, "patches"));
      writeFileSync(
        join(root, "package.json"),
        `${JSON.stringify({ name: "openclaw", version: "2026.5.6", scripts: {} }, null, 2)}\n`,
        "utf8",
      );
      writeFileSync(
        join(root, "pnpm-workspace.yaml"),
        [
          "packages:",
          "  - .",
          "",
          "patchedDependencies:",
          '  "kept@1.0.0": "patches/kept.patch"',
          "allowBuilds:",
          "  esbuild: true",
          "",
        ].join("\n"),
        "utf8",
      );
      writeFileSync(join(root, "patches", "kept.patch"), "", "utf8");

      execFileSync(process.execPath, [
        UPDATE_CHANNEL_SWITCH_ASSERTIONS_PATH,
        "prepare-git-fixture",
        root,
      ]);

      const workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
      const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
        pnpm?: unknown;
      };
      expect(workspace).toContain('  "kept@1.0.0": "patches/kept.patch"');
      expect(workspace).toContain("allowUnusedPatches: true");
      expect(workspace).toContain("minimumReleaseAge: 0");
      expect(workspace).toContain("allowBuilds:");
      expect(manifest.pnpm).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps bundled plugin install/uninstall sweep chunkable", () => {
    const runner = readFileSync(BUNDLED_PLUGIN_INSTALL_UNINSTALL_E2E_PATH, "utf8");
    const sweep = readFileSync(BUNDLED_PLUGIN_INSTALL_UNINSTALL_SWEEP_PATH, "utf8");
    const probe = readFileSync(BUNDLED_PLUGIN_INSTALL_UNINSTALL_PROBE_PATH, "utf8");
    const runtimeSmoke = readFileSync(BUNDLED_PLUGIN_INSTALL_UNINSTALL_RUNTIME_SMOKE_PATH, "utf8");

    expect(runner).toContain("OPENCLAW_BUNDLED_PLUGIN_SWEEP_TOTAL");
    expect(runner).toContain("OPENCLAW_BUNDLED_PLUGIN_SWEEP_INDEX");
    expect(runner).toContain("OPENCLAW_BUNDLED_PLUGIN_RUNTIME_READY_MS");
    expect(runner).toContain("OPENCLAW_PLUGIN_LIFECYCLE_TRACE");
    expect(runner).toContain("scripts/e2e/lib/bundled-plugin-install-uninstall/sweep.sh");
    expect(runner).toContain('tee "$RUN_LOG"');
    expect(runner).not.toContain('cat "$RUN_LOG"');
    expect(probe).toContain('"openclaw.plugin.json"');
    expect(runtimeSmoke).toContain("process.env.OPENCLAW_BUNDLED_PLUGIN_RUNTIME_READY_MS");
    expect(runtimeSmoke).toContain("900000");
    expect(sweep).toContain("read -r plugin_id plugin_dir requires_config");
    expect(sweep).toContain('node "$OPENCLAW_ENTRY" plugins install "$plugin_id"');
    expect(sweep).toContain('node "$OPENCLAW_ENTRY" plugins uninstall "$plugin_id" --force');
    expect(sweep).toContain("now_ms()");
    expect(sweep).toContain("lifecycle_trace_enabled()");
    expect(sweep).toContain("if lifecycle_trace_enabled; then");
    expect(sweep).toContain("install_ms=");
    expect(sweep).toContain("runtime_ms=");
    expect(sweep).toContain("uninstall_ms=");
    expect(sweep).toContain("assert-installed");
    expect(sweep).toContain("assert-uninstalled");
  });

  it("passes installer tag env to bash, not curl", () => {
    const runner = readFileSync(INSTALL_E2E_RUNNER_PATH, "utf8");

    expect(runner).toContain('curl -fsSL "$INSTALL_URL" | OPENCLAW_BETA=1 bash');
    expect(runner).toContain('curl -fsSL "$INSTALL_URL" | OPENCLAW_VERSION="$INSTALL_TAG" bash');
    expect(runner).not.toContain('OPENCLAW_BETA=1 curl -fsSL "$INSTALL_URL" | bash');
    expect(runner).not.toContain(
      'OPENCLAW_VERSION="$INSTALL_TAG" curl -fsSL "$INSTALL_URL" | bash',
    );
  });

  it("keeps installer E2E agent turns out of the interactive bootstrap ritual", () => {
    const runner = readFileSync(INSTALL_E2E_RUNNER_PATH, "utf8");

    expect(runner).toContain('rm -f "$workspace/BOOTSTRAP.md"');
    expect(runner.indexOf('rm -f "$workspace/BOOTSTRAP.md"')).toBeLessThan(
      runner.indexOf('phase_mark_start "Agent turns ($profile)"'),
    );
  });

  it("keeps installer E2E tool smokes in isolated sessions", () => {
    const runner = readFileSync(INSTALL_E2E_RUNNER_PATH, "utf8");

    expect(runner).toContain('SESSION_ID_PREFIX="e2e-tools-${profile}"');
    expect(runner).toContain('TURN2B_SESSION_ID="${SESSION_ID_PREFIX}-read-copy"');
    expect(runner).toContain('TURN3_SESSION_ID="${SESSION_ID_PREFIX}-exec-hostname"');
    expect(runner).toContain('TURN4_SESSION_ID="${SESSION_ID_PREFIX}-image-write"');
  });

  it("keeps OpenAI web search smoke on one gateway agent connection", () => {
    const runner = readFileSync(OPENAI_WEB_SEARCH_MINIMAL_E2E_PATH, "utf8");
    const scenario = readFileSync(OPENAI_WEB_SEARCH_MINIMAL_SCENARIO_PATH, "utf8");
    const client = readFileSync(OPENAI_WEB_SEARCH_MINIMAL_CLIENT_PATH, "utf8");

    expect(runner).toContain("scripts/e2e/lib/openai-web-search-minimal/scenario.sh");
    expect(scenario).toContain("scripts/e2e/lib/openai-web-search-minimal/client.mjs");
    expect(client).toContain("const callGateway = await loadCallGateway();");
    expect(client).toContain('method: "agent"');
    expect(client).toContain("expectFinal: true");
    expect(client).toContain('scopes: ["operator.write"]');
    expect(client).not.toContain('"agent.wait"');
  });

  it("keeps ClawHub plugin Docker smoke hermetic by default", () => {
    const runner = readFileSync(PLUGINS_DOCKER_E2E_PATH, "utf8");
    const sweep = readFileSync(PLUGINS_DOCKER_SWEEP_PATH, "utf8");
    const clawhub = readFileSync(PLUGINS_DOCKER_CLAWHUB_PATH, "utf8");

    expect(runner).toContain("scripts/e2e/lib/plugins/sweep.sh");
    expect(runner).toContain("OPENCLAW_PLUGINS_E2E_LIVE_CLAWHUB");
    expect(sweep).toContain("scripts/e2e/lib/plugins/clawhub.sh");
    expect(clawhub).toContain("start_clawhub_fixture_server()");
    expect(clawhub).toContain('OPENCLAW_CLAWHUB_URL="http://127.0.0.1:');
    expect(clawhub).toContain("OPENCLAW_PLUGINS_E2E_LIVE_CLAWHUB");
    expect(clawhub).toContain("OPENCLAW_PLUGINS_E2E_LIVE_NPM_REGISTRY");
    expect(clawhub).toContain("live ClawHub can rate-limit CI");
    expect(clawhub).toContain('[[ -n "${OPENCLAW_CLAWHUB_URL:-}" || -n "${CLAWHUB_URL:-}" ]]');
    expect(clawhub).toContain("Ignoring ambient ClawHub URL for fixture-mode plugin E2E");
    expect(clawhub).toContain("unset OPENCLAW_CLAWHUB_URL CLAWHUB_URL");
  });

  it("keeps the plugin binding command escape Docker smoke focused", () => {
    const runner = readFileSync(PLUGIN_BINDING_COMMAND_ESCAPE_DOCKER_E2E_PATH, "utf8");
    const dockerfile = readFileSync(PLUGIN_BINDING_COMMAND_ESCAPE_DOCKERFILE_PATH, "utf8");

    expect(runner).toContain("--reporter=verbose -t");
    expect(runner).not.toContain("-- --reporter=verbose");
    expect(runner).toContain(
      'DOCKER_RUN_TIMEOUT="${OPENCLAW_PLUGIN_BINDING_COMMAND_ESCAPE_DOCKER_RUN_TIMEOUT:-900s}"',
    );
    expect(runner).toContain(
      'DOCKER_COMMAND_TIMEOUT="$DOCKER_RUN_TIMEOUT" docker_e2e_docker_run_cmd run --rm',
    );
    expect(runner).toContain('docker_e2e_docker_cmd rm -f "$CONTAINER_NAME"');
    expect(runner).not.toMatch(/(^|\n)docker run --rm/u);
    expect(runner).toContain(
      "keeps unauthorized plugin-owned binding slash replies suppressed while routed to the bound plugin",
    );
    expect(runner).not.toContain(
      "keeps unauthorized plugin-owned binding slash text routed to the bound plugin",
    );
    expect(runner).toContain("expected focused Vitest summary for exactly 3 passed tests");
    expect(dockerfile).toContain("OPENCLAW_DISABLE_BUNDLED_PLUGIN_POSTINSTALL=1");
    expect(dockerfile).toContain(
      "pnpm install --frozen-lockfile --ignore-scripts --filter openclaw",
    );
  });

  it("routes QR import Docker smoke through the timeout-aware run helper", () => {
    const runner = readFileSync(QR_IMPORT_DOCKER_E2E_PATH, "utf8");

    expect(runner).toContain("scripts/lib/docker-e2e-container.sh");
    expect(runner).toContain("run_logged qr-import-run docker_e2e_docker_run_cmd run --rm -t");
    expect(runner).not.toContain("run_logged qr-import-run docker run --rm");
  });

  it("covers plugin CLI sources in the Docker plugin sweep", () => {
    const sweep = readFileSync(PLUGINS_DOCKER_SWEEP_PATH, "utf8");
    const marketplace = readFileSync(PLUGINS_DOCKER_MARKETPLACE_PATH, "utf8");
    const clawhub = readFileSync(PLUGINS_DOCKER_CLAWHUB_PATH, "utf8");
    const assertions = readFileSync(PLUGINS_DOCKER_ASSERTIONS_PATH, "utf8");
    const npmRegistry = readFileSync(PLUGINS_DOCKER_NPM_REGISTRY_PATH, "utf8");

    expect(sweep).toContain('OPENCLAW_PLUGINS_CLI_TIMEOUT="${OPENCLAW_PLUGINS_CLI_TIMEOUT:-180s}"');
    expect(sweep).toContain(
      'run_logged "$label" openclaw_e2e_maybe_timeout "$OPENCLAW_PLUGINS_CLI_TIMEOUT" node "$OPENCLAW_ENTRY" "$@"',
    );
    expect(sweep).toContain("run_plugins_openclaw_capture()");
    expect(sweep).toContain(
      'openclaw_e2e_maybe_timeout "$OPENCLAW_PLUGINS_CLI_TIMEOUT" node "$OPENCLAW_ENTRY" "$@" >"$output_file"',
    );
    expect(sweep).not.toContain('run_logged install-npm node "$OPENCLAW_ENTRY"');
    for (const [path, script] of [
      [PLUGINS_DOCKER_SWEEP_PATH, sweep],
      [PLUGINS_DOCKER_MARKETPLACE_PATH, marketplace],
      [PLUGINS_DOCKER_CLAWHUB_PATH, clawhub],
    ] as const) {
      const unboundedPluginCliLines = script
        .split("\n")
        .filter((line) => line.includes('node "$OPENCLAW_ENTRY" plugins'))
        .filter((line) => !line.includes("openclaw_e2e_maybe_timeout"));

      expect(unboundedPluginCliLines, path).toEqual([]);
    }

    expect(sweep).toContain('plugins install "$dir_plugin"');
    expect(sweep).toContain("plugins update demo-plugin-dir");
    expect(assertions).toContain('Skipping "demo-plugin-dir" (source: path).');

    expect(sweep).toContain("start_npm_fixture_registry");
    expect(sweep).toContain('plugins install "npm:@openclaw/demo-plugin-npm@0.0.1"');
    expect(sweep).toContain("plugins update demo-plugin-npm");
    expect(assertions).toContain("demo-plugin-npm is up to date (0.0.1).");
    expect(npmRegistry).toContain('"dist-tags": { latest: entry.latestVersion }');
    expect(npmRegistry).toContain("existing.latestVersion = version");
    expect(npmRegistry).toContain("packageArgs.length % 3");

    expect(sweep).toContain('plugins install "git:$git_update_repo_url@main"');
    expect(sweep).toContain("plugins update demo-plugin-git-update");
    expect(assertions).toContain("demo.git.update.v2");

    expect(clawhub).toContain('plugins install "$CLAWHUB_PLUGIN_SPEC"');
    expect(clawhub).toContain('plugins update "$CLAWHUB_PLUGIN_ID"');
    expect(clawhub).toContain("run_plugins_openclaw_logged install-clawhub");
    expect(clawhub).toContain('openclaw_e2e_maybe_timeout "$OPENCLAW_PLUGINS_CLI_TIMEOUT"');
    expect(clawhub).toContain("clawhub:@openclaw/kitchen-sink");
    expect(assertions).toContain("clawhub-updated");
    expect(assertions).toContain("record.clawpackSha256");
    expect(assertions).toContain("record.artifactKind");
    expect(assertions).toContain("record.npmIntegrity");
  });
});
