// Docker Build Helper tests cover docker build helper script behavior.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const HELPER_PATH = "scripts/lib/docker-build.sh";
const DOCKER_ALL_SCHEDULER_PATH = "scripts/test-docker-all.mjs";
const DOCKER_E2E_PACKAGE_HELPER_PATH = "scripts/lib/docker-e2e-package.sh";
const DOCKER_E2E_IMAGE_HELPER_PATH = "scripts/lib/docker-e2e-image.sh";
const DOCKER_E2E_SCENARIOS_PATH = "scripts/lib/docker-e2e-scenarios.mjs";
const COMPOSE_SETUP_E2E_PATH = "scripts/e2e/compose-setup.sh";
const DOCKER_PACKAGE_INSTALL_E2E_PATH = "scripts/e2e/docker-package-install.sh";
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
const MCP_CODE_MODE_GATEWAY_DOCKER_E2E_PATH = "scripts/e2e/mcp-code-mode-gateway-docker.sh";
const MCP_CODE_MODE_GATEWAY_LIVE_DOCKER_E2E_PATH =
  "scripts/e2e/mcp-code-mode-gateway-live-docker.sh";
const CODEX_MEDIA_PATH_DOCKER_E2E_PATH = "scripts/e2e/codex-media-path-docker.sh";
const OPENAI_CHAT_TOOLS_DOCKER_E2E_PATH = "scripts/e2e/openai-chat-tools-docker.sh";
const CODEX_MEDIA_PATH_SCENARIO_PATH = "scripts/e2e/lib/codex-media-path/scenario.sh";
const OPENAI_CHAT_TOOLS_SCENARIO_PATH = "scripts/e2e/lib/openai-chat-tools/scenario.sh";
const CODEX_NPM_PLUGIN_LIVE_DOCKER_E2E_PATH = "scripts/e2e/codex-npm-plugin-live-docker.sh";
const CODEX_NPM_PLUGIN_LIVE_ASSERTIONS_PATH =
  "scripts/e2e/lib/codex-npm-plugin-live/assertions.mjs";
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
const AGENT_BUNDLE_MCP_TOOLS_DOCKER_E2E_PATH = "scripts/e2e/agent-bundle-mcp-tools-docker.sh";
const COMMITMENTS_SAFETY_DOCKER_E2E_PATH = "scripts/e2e/commitments-safety-docker.sh";
const SYSTEM_AGENT_FIRST_RUN_DOCKER_E2E_PATH = "scripts/e2e/system-agent-first-run-docker.sh";
const SYSTEM_AGENT_RESCUE_DOCKER_E2E_PATH = "scripts/e2e/system-agent-rescue-docker.sh";
const SESSION_RUNTIME_CONTEXT_DOCKER_E2E_PATH = "scripts/e2e/session-runtime-context-docker.sh";
const BUNDLED_PLUGIN_INSTALL_UNINSTALL_SWEEP_PATH =
  "scripts/e2e/lib/bundled-plugin-install-uninstall/sweep.sh";
const BUNDLED_PLUGIN_INSTALL_UNINSTALL_PROBE_PATH =
  "scripts/e2e/lib/bundled-plugin-install-uninstall/probe.mjs";
const BUNDLED_PLUGIN_INSTALL_UNINSTALL_RUNTIME_SMOKE_PATH =
  "scripts/e2e/lib/bundled-plugin-install-uninstall/runtime-smoke.mjs";
const CLEANUP_SMOKE_DOCKERFILE_PATH = "scripts/docker/cleanup-smoke/Dockerfile";
const CLEANUP_SMOKE_RUN_PATH = "scripts/docker/cleanup-smoke/run.sh";
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
const DOCTOR_SWITCH_LOGINCTL_SHIM_PATH = "scripts/e2e/lib/doctor-install-switch/shims/loginctl";
const DOCTOR_SWITCH_SYSTEMCTL_SHIM_PATH = "scripts/e2e/lib/doctor-install-switch/shims/systemctl";
const PACKAGE_COMPAT_PATH = "scripts/e2e/lib/package-compat.mjs";
const UPGRADE_SURVIVOR_DOCKER_E2E_PATH = "scripts/e2e/upgrade-survivor-docker.sh";
const UPDATE_CHANNEL_SWITCH_DOCKER_E2E_PATH = "scripts/e2e/update-channel-switch-docker.sh";
const UPDATE_CHANNEL_SWITCH_ASSERTIONS_PATH =
  "scripts/e2e/lib/update-channel-switch/assertions.mjs";
const RELEASE_UPGRADE_USER_JOURNEY_SCENARIO_PATH =
  "scripts/e2e/lib/release-upgrade-user-journey/scenario.sh";
const RELEASE_TYPED_ONBOARDING_SCENARIO_PATH =
  "scripts/e2e/lib/release-typed-onboarding/scenario.sh";
const RELEASE_USER_JOURNEY_DOCKER_E2E_PATH = "scripts/e2e/release-user-journey-docker.sh";
const RELEASE_USER_JOURNEY_SCENARIO_PATH = "scripts/e2e/lib/release-user-journey/scenario.sh";
const UPGRADE_SURVIVOR_RUN_SCRIPT = "scripts/e2e/lib/upgrade-survivor/run.sh";
const UPGRADE_SURVIVOR_UPDATE_RESTART_AUTH_PATH =
  "scripts/e2e/lib/upgrade-survivor/update-restart-auth.sh";
const GATEWAY_NETWORK_DOCKER_E2E_PATH = "scripts/e2e/gateway-network-docker.sh";
const BROWSER_CDP_SNAPSHOT_DOCKER_E2E_PATH = "scripts/e2e/browser-cdp-snapshot-docker.sh";
const CENTRALIZED_BUILD_SCRIPTS = [
  "scripts/docker/setup.sh",
  BROWSER_CDP_SNAPSHOT_DOCKER_E2E_PATH,
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
const BOUNDED_CLIENT_LOG_DOCKER_E2E_SCRIPTS = [
  "scripts/e2e/cron-mcp-cleanup-docker.sh",
  "scripts/e2e/mcp-channels-docker.sh",
  "scripts/e2e/mcp-code-mode-gateway-docker.sh",
  "scripts/e2e/mcp-code-mode-gateway-live-docker.sh",
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

function cleanupSmokeLogTailHelpers(): string {
  const script = readFileSync(CLEANUP_SMOKE_RUN_PATH, "utf8");
  const match = script.match(
    /(read_positive_int_env\(\) \{[\s\S]*?\n\}\n\nprint_log_tail\(\) \{[\s\S]*?\n\})\n\nread_positive_int_env/u,
  );
  if (!match) {
    throw new Error("cleanup smoke log helpers were not found");
  }
  const helpers = match[1];
  if (helpers === undefined) {
    throw new Error("cleanup smoke log helper capture was not found");
  }
  return helpers;
}

function runCleanupDefaultPlatform(env: Record<string, string>, hostArch: string): string {
  const script = readFileSync(CLEANUP_DOCKER_SMOKE_PATH, "utf8");
  const match = script.match(/(resolve_default_cleanup_platform\(\) \{[\s\S]*?\n\})\n\nPLATFORM=/u);
  if (!match) {
    throw new Error("resolve_default_cleanup_platform was not found");
  }
  return execFileSync(
    "bash",
    [
      "--noprofile",
      "--norc",
      "-c",
      `${match[1]}\nuname() { if [[ "\${1:-}" == "-m" ]]; then printf "%s" "$FAKE_UNAME_ARCH"; else command uname "$@"; fi; }\nresolve_default_cleanup_platform`,
    ],
    {
      encoding: "utf8",
      env: {
        HOME: "/tmp",
        PATH: process.env.PATH ?? "",
        FAKE_UNAME_ARCH: hostArch,
        ...env,
      },
    },
  );
}

describe("docker build helper", () => {
  it("allows deployments to build an immutable sandbox image tag", () => {
    const script = readFileSync("scripts/sandbox-setup.sh", "utf8");

    expect(script).toContain(
      'IMAGE_NAME="${OPENCLAW_SANDBOX_IMAGE:-openclaw-sandbox:bookworm-slim}"',
    );
  });

  it("forces BuildKit for centralized Docker builds", () => {
    const helper = readFileSync(HELPER_PATH, "utf8");

    expect(helper).toContain("DOCKER_BUILDKIT=1");
    expect(helper).toContain("docker_build_exec()");
    expect(helper).toContain("docker_build_run()");
    expect(helper).toContain("docker buildx build --load");
    expect(helper).toContain("docker_build_transient_failure()");
    expect(helper).toContain("OPENCLAW_DOCKER_BUILD_RETRIES");
    expect(helper).toContain("OPENCLAW_DOCKER_BUILD_TIMEOUT");
    expect(helper).toContain('docker_build_run_logged "$label" "$timeout_value" "$log_file"');
    expect(helper).toContain("OPENCLAW_DOCKER_BUILD_REQUIRE_TIMEOUT");
    expect(helper).toContain("frontend grpc server closed unexpectedly");
    expect(helper).toContain("docker_build_resource_exhausted_failure()");
  });

  it("treats Docker registry auth 5xx failures as transient build failures", () => {
    const workDir = mkdtempSync(join(tmpdir(), "openclaw-docker-build-transient-"));

    try {
      const logPath = join(workDir, "docker-build.log");
      writeFileSync(
        logPath,
        [
          "#3 ERROR: failed to authorize: failed to fetch oauth token: unexpected status from POST request to https://auth.docker.io/token: 504 Gateway Timeout: error code: 504",
          "ERROR: failed to solve: failed to resolve source metadata for docker.io/docker/dockerfile:1.7",
        ].join("\n"),
      );
      const rootDir = process.cwd();
      const script = `
set -euo pipefail
ROOT_DIR=${shellQuote(rootDir)}
LOG_PATH=${shellQuote(logPath)}
source "$ROOT_DIR/scripts/lib/docker-build.sh"
docker_build_transient_failure "$LOG_PATH"
`;

      execFileSync("bash", ["-lc", script], { encoding: "utf8" });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("detects Docker builder memory exhaustion failures", () => {
    const workDir = mkdtempSync(join(tmpdir(), "openclaw-docker-build-memory-"));

    try {
      const logPath = join(workDir, "docker-build.log");
      writeFileSync(
        logPath,
        [
          'ERROR: failed to build: failed to solve: ResourceExhausted: process "/bin/sh -c pnpm build:docker" did not complete successfully: cannot allocate memory',
        ].join("\n"),
      );
      const rootDir = process.cwd();
      const script = `
set -euo pipefail
ROOT_DIR=${shellQuote(rootDir)}
LOG_PATH=${shellQuote(logPath)}
source "$ROOT_DIR/scripts/lib/docker-build.sh"
docker_build_resource_exhausted_failure "$LOG_PATH"
`;

      execFileSync("bash", ["-lc", script], { encoding: "utf8" });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
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

  it("bounds cleanup-smoke failure log output", () => {
    const cleanupRun = readFileSync(CLEANUP_SMOKE_RUN_PATH, "utf8");

    expect(cleanupRun).toContain("OPENCLAW_CLEANUP_SMOKE_LOG_PRINT_BYTES");
    expect(cleanupRun).toContain(
      "read_positive_int_env OPENCLAW_CLEANUP_SMOKE_LOG_PRINT_BYTES 65536 >/dev/null",
    );
    expect(cleanupRun.match(/print_log_tail \/tmp\/openclaw-cleanup-/g)).toHaveLength(3);
    expect(cleanupRun).not.toContain("cat /tmp/openclaw-cleanup-");
  });

  it("gives cleanup-smoke builds enough Node heap while preserving explicit callers", () => {
    const cleanupRun = readFileSync(CLEANUP_SMOKE_RUN_PATH, "utf8");

    expect(cleanupRun).toContain("ensure_cleanup_smoke_node_options()");
    expect(cleanupRun).toContain('export NODE_OPTIONS="$current"');
    expect(cleanupRun).toContain("--max-old-space-size=8192");
    expect(cleanupRun).toContain('*" --max-old-space-size="*');
    expect(cleanupRun).toContain('*" --max_old_space_size="*');
    expect(cleanupRun.indexOf("ensure_cleanup_smoke_node_options")).toBeLessThan(
      cleanupRun.indexOf("pnpm build >/tmp/openclaw-cleanup-build.log"),
    );
  });

  it("rejects invalid cleanup-smoke log byte limits", () => {
    const workDir = mkdtempSync(join(tmpdir(), "openclaw-cleanup-smoke-log-invalid-"));

    try {
      const logPath = join(workDir, "cleanup.log");
      writeFileSync(logPath, "cleanup output\n");
      const script = `
set -euo pipefail
LOG_PATH=${shellQuote(logPath)}
export OPENCLAW_CLEANUP_SMOKE_LOG_PRINT_BYTES=64kb

${cleanupSmokeLogTailHelpers()}

print_log_tail "$LOG_PATH"
`;

      const result = spawnSync("bash", ["-lc", script], { encoding: "utf8" });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain("invalid OPENCLAW_CLEANUP_SMOKE_LOG_PRINT_BYTES: 64kb");
      expect(result.stdout).toBe("");
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("normalizes zero-padded cleanup-smoke log byte limits", () => {
    const workDir = mkdtempSync(join(tmpdir(), "openclaw-cleanup-smoke-log-tail-"));

    try {
      const logPath = join(workDir, "cleanup.log");
      writeFileSync(logPath, "old-cleanup-output-recent\n");
      const script = `
set -euo pipefail
LOG_PATH=${shellQuote(logPath)}
export OPENCLAW_CLEANUP_SMOKE_LOG_PRINT_BYTES=0008

${cleanupSmokeLogTailHelpers()}

print_log_tail "$LOG_PATH"
`;

      const result = spawnSync("bash", ["-lc", script], { encoding: "utf8" });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("truncated: showing last 8");
      expect(result.stdout).toContain("-recent\n");
      expect(result.stdout).not.toContain("old-cleanup-output");
      expect(result.stderr).toBe("");
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("prints Docker MCP client logs through the bounded helper", () => {
    for (const scriptPath of BOUNDED_CLIENT_LOG_DOCKER_E2E_SCRIPTS) {
      const script = readFileSync(scriptPath, "utf8");

      expect(script, scriptPath).toContain('source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"');
      expect(script.match(/docker_e2e_print_log "\$CLIENT_LOG"/g), scriptPath).toHaveLength(2);
      expect(script, scriptPath).not.toContain('cat "$CLIENT_LOG"');
    }
  });

  it("prints in-container Docker client logs through bounded helpers", () => {
    for (const scriptPath of [CODEX_MEDIA_PATH_SCENARIO_PATH, OPENAI_CHAT_TOOLS_SCENARIO_PATH]) {
      const script = readFileSync(scriptPath, "utf8");

      expect(script, scriptPath).toContain("source scripts/lib/openclaw-e2e-instance.sh");
      expect(script, scriptPath).toContain('openclaw_e2e_print_log "$CLIENT_LOG"');
      expect(script, scriptPath).not.toContain('cat "$CLIENT_LOG"');
    }
  });

  it("runs cleanup smoke on the native ARM platform instead of pulling an amd64 tag", () => {
    expect(runCleanupDefaultPlatform({ CI: "true" }, "aarch64")).toBe("linux/arm64");
    expect(runCleanupDefaultPlatform({ GITHUB_ACTIONS: "true" }, "x86_64")).toBe("linux/amd64");
    expect(runCleanupDefaultPlatform({}, "arm64")).toBe("linux/arm64");
    expect(
      runCleanupDefaultPlatform({ OPENCLAW_CLEANUP_SMOKE_PLATFORM: "linux/s390x" }, "x86_64"),
    ).toBe("linux/s390x");
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
    expect(liveBuild).toContain(
      'LIVE_IMAGE_PULL_ATTEMPTS="${OPENCLAW_LIVE_DOCKER_PULL_ATTEMPTS:-3}"',
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

  it("rejects malformed Docker E2E resource limits before a suite starts", () => {
    const helper = readFileSync(DOCKER_E2E_IMAGE_HELPER_PATH, "utf8");
    const scripts = [
      readFileSync(ONBOARD_DOCKER_E2E_PATH, "utf8"),
      readFileSync(KITCHEN_SINK_PLUGIN_DOCKER_E2E_PATH, "utf8"),
      readFileSync(KITCHEN_SINK_RPC_DOCKER_E2E_PATH, "utf8"),
      readFileSync(OPENWEBUI_DOCKER_E2E_PATH, "utf8"),
    ];

    expect(helper).toContain("docker_e2e_read_nonnegative_decimal_env()");
    for (const script of scripts) {
      expect(script).toContain("docker_e2e_read_nonnegative_decimal_env");
    }

    const runProbe = (value: string) => {
      const script = [
        "source scripts/lib/docker-e2e-image.sh",
        "docker_e2e_read_nonnegative_decimal_env OPENCLAW_SAMPLE_RESOURCE_LIMIT 2048",
      ].join("\n");
      return spawnSync("bash", ["-c", script], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_SAMPLE_RESOURCE_LIMIT: value,
        },
      });
    };

    const invalid = runProbe("12mb");
    const overlarge = runProbe("9999999999");
    const overprecise = runProbe("12.1234567");
    const decimal = runProbe("12.5");
    expect(invalid.status).toBe(2);
    expect(invalid.stderr).toContain("invalid OPENCLAW_SAMPLE_RESOURCE_LIMIT: 12mb");
    expect(overlarge.status).toBe(2);
    expect(overlarge.stderr).toContain("invalid OPENCLAW_SAMPLE_RESOURCE_LIMIT: 9999999999");
    expect(overprecise.status).toBe(2);
    expect(overprecise.stderr).toContain("invalid OPENCLAW_SAMPLE_RESOURCE_LIMIT: 12.1234567");
    expect(decimal.status).toBe(0);
    expect(decimal.stdout.trimEnd()).toBe("12.5");
  });

  it("keeps Testbox image-build fallback before isolating live MCP code-mode runtime flags", () => {
    const script = readFileSync(MCP_CODE_MODE_GATEWAY_LIVE_DOCKER_E2E_PATH, "utf8");
    const buildIndex = script.indexOf('docker_e2e_build_or_reuse "$IMAGE_NAME"');
    const unsetIndex = script.indexOf("unset OPENCLAW_TESTBOX");

    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(unsetIndex).toBeGreaterThan(buildIndex);
    expect(script).toContain("host/testbox mode flags that can change packaged behavior");
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

  it("prints heartbeat progress for long successful centralized Docker builds", () => {
    const workDir = mkdtempSync(join(tmpdir(), "openclaw-docker-build-heartbeat-"));

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
shift 2
"$@"
`,
      );
      chmodSync(join(binDir, "timeout"), 0o755);
      writeFileSync(
        join(binDir, "docker"),
        `#!/bin/sh
printf "captured docker build log\\n"
/bin/sleep 0.05
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
export OPENCLAW_DOCKER_BUILD_HEARTBEAT_SECONDS=1

source "$ROOT_DIR/scripts/lib/docker-build.sh"

printf "captured docker build log\\n" >"$TMPDIR/build.log"
output="$(docker_build_maybe_print_heartbeat e2e-build 1 1 "$TMPDIR/build.log")"
[[ "$output" = *"Docker build e2e-build still running ("* ]]
[[ "$output" = *"log bytes captured"* ]]
[[ "$output" != *"captured docker build log"* ]]
`;

      execFileSync("bash", ["-lc", script], { encoding: "utf8" });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("stops the tracked build command without retrying when interrupted", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "openclaw-docker-build-signal-"));

    try {
      const binDir = join(workDir, "bin");
      mkdirSync(binDir);
      writeFileSync(
        join(binDir, "docker"),
        `#!/bin/bash
set -euo pipefail
count=0
if [ -f "$TMPDIR/docker-count" ]; then
  count="$(<"$TMPDIR/docker-count")"
fi
count="$((count + 1))"
printf '%s\\n' "$count" >"$TMPDIR/docker-count"
printf '%s\\n' "$$" >"$TMPDIR/docker.pid"
printf 'rpc error: code = Unavailable\\n'
trap 'printf "term\\n" >"$TMPDIR/docker.term"; exit 0' TERM
mkfifo "$TMPDIR/docker.block"
printf 'ready\\n' >"$TMPDIR/docker.ready"
while true; do
  read -r -t 1 _ <> "$TMPDIR/docker.block" || true
done
`,
      );
      chmodSync(join(binDir, "docker"), 0o755);
      const rootDir = process.cwd();
      writeFileSync(
        join(workDir, "runner.sh"),
        `#!/bin/bash
set -euo pipefail
ROOT_DIR=${shellQuote(rootDir)}
TMPDIR=${shellQuote(workDir)}
export ROOT_DIR TMPDIR
export PATH="$TMPDIR/bin:$PATH"
export OPENCLAW_DOCKER_BUILD_RETRIES=3
source "$ROOT_DIR/scripts/lib/docker-build.sh"
docker_build_run e2e-build -t demo-image .
`,
      );
      chmodSync(join(workDir, "runner.sh"), 0o755);

      const waitForFile = async (filePath: string) => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (existsSync(filePath)) {
            return;
          }
          await delay(10);
        }
        throw new Error(`file was not written: ${filePath}`);
      };
      const waitForExit = async (child: ReturnType<typeof spawn>) =>
        await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
          child.once("exit", (code, signal) => resolve({ code, signal }));
        });
      const waitForDead = async (pid: number) => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          try {
            process.kill(pid, 0);
          } catch {
            return;
          }
          await delay(10);
        }
        throw new Error(`process stayed alive: ${pid}`);
      };
      const runInterruptedBuild = async (signal: NodeJS.Signals, expectedCode: number) => {
        rmSync(join(workDir, "docker.pid"), { force: true });
        rmSync(join(workDir, "docker.term"), { force: true });
        rmSync(join(workDir, "docker.ready"), { force: true });
        rmSync(join(workDir, "docker.block"), { force: true });
        rmSync(join(workDir, "docker-count"), { force: true });
        const runner = spawn(join(workDir, "runner.sh"), {
          env: { ...process.env, TMPDIR: workDir },
          stdio: "ignore",
        });
        try {
          const pidPath = join(workDir, "docker.pid");
          await waitForFile(pidPath);
          await waitForFile(join(workDir, "docker.ready"));
          const buildPid = Number.parseInt(readFileSync(pidPath, "utf8"), 10);

          runner.kill(signal);
          const exit = await waitForExit(runner);

          expect(exit).toEqual({ code: expectedCode, signal: null });
          await waitForFile(join(workDir, "docker.term"));
          expect(readFileSync(join(workDir, "docker-count"), "utf8").trim()).toBe("1");
          await waitForDead(buildPid);
        } finally {
          if (runner.exitCode === null && runner.signalCode === null) {
            runner.kill("SIGKILL");
          }
        }
      };

      await runInterruptedBuild("SIGTERM", 143);
      await runInterruptedBuild("SIGINT", 130);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("does not delay fast successful centralized Docker builds until the next heartbeat", () => {
    const workDir = mkdtempSync(join(tmpdir(), "openclaw-docker-build-fast-heartbeat-"));

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
shift 2
"$@"
`,
      );
      chmodSync(join(binDir, "timeout"), 0o755);
      writeFileSync(
        join(binDir, "docker"),
        `#!/bin/sh
printf "quick docker build log\\n"
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
export OPENCLAW_DOCKER_BUILD_HEARTBEAT_SECONDS=30

source "$ROOT_DIR/scripts/lib/docker-build.sh"

output="$(docker_build_run e2e-build -t demo-image .)"
[[ -z "$output" ]]
`;
      const startedAt = Date.now();

      execFileSync("bash", ["-lc", script], { encoding: "utf8" });

      expect(Date.now() - startedAt).toBeLessThan(5_000);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("normalizes zero-padded centralized Docker build heartbeat intervals", () => {
    const rootDir = process.cwd();
    const script = `
set -euo pipefail
ROOT_DIR=${shellQuote(rootDir)}
export ROOT_DIR
export OPENCLAW_DOCKER_BUILD_HEARTBEAT_SECONDS=08

source "$ROOT_DIR/scripts/lib/docker-build.sh"

[[ "$(docker_build_heartbeat_seconds)" = "8" ]]
`;

    execFileSync("bash", ["-lc", script], { encoding: "utf8" });
  });

  it("normalizes zero-padded centralized Docker build retry counts", () => {
    const rootDir = process.cwd();
    const script = `
set -euo pipefail
ROOT_DIR=${shellQuote(rootDir)}
export ROOT_DIR
export OPENCLAW_DOCKER_BUILD_RETRIES=08

source "$ROOT_DIR/scripts/lib/docker-build.sh"

[[ "$(docker_build_retry_count)" = "8" ]]
`;

    execFileSync("bash", ["-lc", script], { encoding: "utf8" });
  });

  it.each([
    [
      "retry count",
      "OPENCLAW_DOCKER_BUILD_RETRIES",
      "2x",
      "invalid OPENCLAW_DOCKER_BUILD_RETRIES: 2x",
    ],
    [
      "heartbeat interval",
      "OPENCLAW_DOCKER_BUILD_HEARTBEAT_SECONDS",
      "soon",
      "invalid OPENCLAW_DOCKER_BUILD_HEARTBEAT_SECONDS: soon",
    ],
  ])(
    "rejects invalid centralized Docker build %s before invoking docker",
    (_label, envName, value, expectedError) => {
      const workDir = mkdtempSync(join(tmpdir(), "openclaw-docker-build-config-"));

      try {
        const binDir = join(workDir, "bin");
        const markerPath = join(workDir, "docker-invoked");
        mkdirSync(binDir);
        writeFileSync(
          join(binDir, "docker"),
          `#!/bin/bash
printf invoked >${shellQuote(markerPath)}
exit 0
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

source "$ROOT_DIR/scripts/lib/docker-build.sh"

docker_build_run e2e-build -t demo-image .
`;

        const result = spawnSync("bash", ["-lc", script], {
          encoding: "utf8",
          env: {
            ...process.env,
            [envName]: value,
          },
        });

        expect(result.status).toBe(2);
        expect(result.stderr).toContain(expectedError);
        expect(existsSync(markerPath)).toBe(false);
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    },
  );

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

  it("derives the browser CDP image from the shared functional image", () => {
    const workDir = mkdtempSync(join(tmpdir(), "openclaw-browser-cdp-shared-image-"));

    try {
      const rootDir = process.cwd();
      mkdirSync(join(workDir, "bin"));
      writeFileSync(
        join(workDir, "bin", "docker"),
        `#!/usr/bin/env bash
printf "%s\\n" "$*" >>"$TMPDIR/docker-seen"
case "$1 $2" in
  "image inspect")
    exit 0
    ;;
  "inspect -f")
    printf "true\\n"
    exit 0
    ;;
  "rm -f")
    exit 0
    ;;
  "run "*)
    printf "container-id\\n"
    exit 0
    ;;
  "exec "*)
    exit 0
    ;;
esac
case "$1" in
  build)
    exit 0
    ;;
esac
exit 9
`,
      );
      writeFileSync(
        join(workDir, "bin", "node"),
        `#!/usr/bin/env bash
printf "echo state\\n"
`,
      );
      writeFileSync(
        join(workDir, "bin", "timeout"),
        `#!/usr/bin/env bash
case "\${1:-}" in
  --kill-after=1s | --kill-after=30s)
    shift 2
    ;;
  *)
    shift
    ;;
esac
exec "$@"
`,
      );
      chmodSync(join(workDir, "bin", "docker"), 0o755);
      chmodSync(join(workDir, "bin", "node"), 0o755);
      chmodSync(join(workDir, "bin", "timeout"), 0o755);

      const script = `
set -euo pipefail
ROOT_DIR=${shellQuote(rootDir)}
TMPDIR=${shellQuote(workDir)}
export ROOT_DIR TMPDIR
export PATH="$TMPDIR/bin:$PATH"
export OPENCLAW_SKIP_DOCKER_BUILD=1
export OPENCLAW_DOCKER_E2E_IMAGE=shared-functional
export OPENCLAW_DOCKER_ALL_LANE_NAME=browser-cdp-snapshot

bash "$ROOT_DIR/scripts/e2e/browser-cdp-snapshot-docker.sh"

grep -q '^image inspect shared-functional$' "$TMPDIR/docker-seen"
grep -Fq 'build -t openclaw-browser-cdp-snapshot-e2e:browser-cdp-snapshot' "$TMPDIR/docker-seen"
grep -Fq ' openclaw-browser-cdp-snapshot-e2e:browser-cdp-snapshot ' "$TMPDIR/docker-seen"
if grep -Fq ' shared-functional ' "$TMPDIR/docker-seen"; then
  echo "browser CDP lane reused the shared image without Chromium" >&2
  exit 1
fi
`;

      execFileSync("bash", ["-lc", script], { encoding: "utf8" });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("fails fast on invalid browser CDP snapshot byte limits", () => {
    const result = spawnSync("bash", [BROWSER_CDP_SNAPSHOT_DOCKER_E2E_PATH], {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_BROWSER_CDP_SNAPSHOT_MAX_BYTES: "64kb",
        OPENCLAW_SKIP_DOCKER_BUILD: "1",
      },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("invalid OPENCLAW_BROWSER_CDP_SNAPSHOT_MAX_BYTES: 64kb");
  });

  it("forwards browser CDP snapshot byte limits into the Docker runner", () => {
    const runner = readFileSync(BROWSER_CDP_SNAPSHOT_DOCKER_E2E_PATH, "utf8");

    expect(runner).toContain(
      "docker_e2e_read_positive_int_env OPENCLAW_BROWSER_CDP_SNAPSHOT_MAX_BYTES 524288",
    );
    expect(runner).toContain('-e "OPENCLAW_BROWSER_CDP_SNAPSHOT_MAX_BYTES=$SNAPSHOT_MAX_BYTES"');
  });

  it("uses Playwright Chromium for the browser CDP snapshot image", () => {
    const runner = readFileSync(BROWSER_CDP_SNAPSHOT_DOCKER_E2E_PATH, "utf8");

    expect(runner).toContain("ENV PLAYWRIGHT_BROWSERS_PATH=/home/appuser/.cache/ms-playwright");
    expect(runner).toContain("playwright-core/cli.js install --with-deps chromium");
    expect(runner).not.toContain("apt-get install -y --no-install-recommends chromium");
  });

  it("opens the browser CDP fixture before snapshotting", () => {
    const runner = readFileSync(BROWSER_CDP_SNAPSHOT_DOCKER_E2E_PATH, "utf8");
    const quarantineIndex = runner.indexOf("mkdir -p /tmp/openclaw-browser-cdp");
    const configIndex = runner.indexOf("node scripts/e2e/lib/fixture.mjs browser-cdp");
    const openIndex = runner.indexOf(
      'browser \\"\\${base_args[@]}\\" --browser-profile docker-cdp open',
    );
    const doctorIndex = runner.indexOf(
      'browser \\"\\${base_args[@]}\\" --browser-profile docker-cdp doctor --deep',
    );
    const snapshotIndex = runner.indexOf(
      'browser \\"\\${base_args[@]}\\" --browser-profile docker-cdp snapshot --interactive',
    );

    expect(quarantineIndex).toBeGreaterThan(-1);
    expect(configIndex).toBeGreaterThan(-1);
    expect(configIndex).toBeGreaterThan(quarantineIndex);
    expect(openIndex).toBeGreaterThan(-1);
    expect(openIndex).toBeGreaterThan(configIndex);
    expect(doctorIndex).toBeGreaterThan(openIndex);
    expect(snapshotIndex).toBeGreaterThan(doctorIndex);
    expect(runner).toContain(">/tmp/browser-cdp-doctor.txt 2>&1 || true");
    expect(runner).toContain("failed to disable Playwright AI snapshot chunk");
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
unset OPENCLAW_DOCKER_E2E_DISABLE_RESOURCE_LIMITS
unset OPENCLAW_DOCKER_E2E_MEMORY OPENCLAW_DOCKER_E2E_CPUS OPENCLAW_DOCKER_E2E_PIDS_LIMIT

source "$ROOT_DIR/scripts/lib/docker-e2e-container.sh"

set +e
printf payload | docker_e2e_docker_cmd run -i demo 2>"$TMPDIR/stderr"
status="$?"
set -e

stderr="$(<"$TMPDIR/stderr")"
[[ "$status" = "13" ]]
[[ "$stderr" = *"timeout command not found; using Node watchdog for Docker command timeout 7s"* ]]
[[ "$(<"$TMPDIR/docker-seen")" = "run --memory 8g --cpus 16 --pids-limit 2048 -i demo|payload" ]]
`;

      execFileSync("bash", ["-lc", script], { encoding: "utf8" });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("adds default Docker run resource limits without overriding explicit limits", () => {
    const workDir = mkdtempSync(join(tmpdir(), "openclaw-docker-resource-limits-"));

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
shift 2
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
unset OPENCLAW_DOCKER_E2E_DISABLE_RESOURCE_LIMITS
unset OPENCLAW_DOCKER_E2E_MEMORY OPENCLAW_DOCKER_E2E_CPUS OPENCLAW_DOCKER_E2E_PIDS_LIMIT
export OPENCLAW_DOCKER_E2E_AVAILABLE_CPUS=32

docker() {
  printf "%s\\n" "$*" >>"$TMPDIR/docker-seen"
}
export -f docker

source "$ROOT_DIR/scripts/lib/docker-e2e-container.sh"

docker_e2e_docker_cmd run demo
OPENCLAW_DOCKER_E2E_MEMORY=12g OPENCLAW_DOCKER_E2E_CPUS=4 OPENCLAW_DOCKER_E2E_PIDS_LIMIT=512 docker_e2e_docker_cmd run demo
OPENCLAW_DOCKER_E2E_AVAILABLE_CPUS=8 OPENCLAW_DOCKER_E2E_MEMORY=12g OPENCLAW_DOCKER_E2E_CPUS=16 OPENCLAW_DOCKER_E2E_PIDS_LIMIT=512 docker_e2e_docker_cmd run demo
docker_e2e_docker_cmd run --memory 2g --cpus 3 --pids-limit 99 demo
OPENCLAW_DOCKER_E2E_DISABLE_RESOURCE_LIMITS=1 docker_e2e_docker_cmd run demo

[[ "$(sed -n '1p' "$TMPDIR/docker-seen")" = "run --memory 8g --cpus 16 --pids-limit 2048 demo" ]]
[[ "$(sed -n '2p' "$TMPDIR/docker-seen")" = "run --memory 12g --cpus 4 --pids-limit 512 demo" ]]
[[ "$(sed -n '3p' "$TMPDIR/docker-seen")" = "run --memory 12g --cpus 8 --pids-limit 512 demo" ]]
[[ "$(sed -n '4p' "$TMPDIR/docker-seen")" = "run --memory 2g --cpus 3 --pids-limit 99 demo" ]]
[[ "$(sed -n '5p' "$TMPDIR/docker-seen")" = "run demo" ]]
`;

      execFileSync("bash", ["-lc", script], { encoding: "utf8" });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid Docker run pids limits before invoking docker", () => {
    const workDir = mkdtempSync(join(tmpdir(), "openclaw-docker-resource-pids-"));

    try {
      const rootDir = process.cwd();
      const script = `
set -euo pipefail
ROOT_DIR=${shellQuote(rootDir)}
TMPDIR=${shellQuote(workDir)}
export ROOT_DIR TMPDIR

docker() {
  printf invoked >"$TMPDIR/docker-seen"
}
export -f docker

source "$ROOT_DIR/scripts/lib/docker-e2e-container.sh"

set +e
OPENCLAW_DOCKER_E2E_PIDS_LIMIT=many docker_e2e_docker_cmd run demo 2>"$TMPDIR/stderr"
status="$?"
set -e

[[ "$status" = "2" ]]
[[ "$(<"$TMPDIR/stderr")" = *"invalid OPENCLAW_DOCKER_E2E_PIDS_LIMIT: many"* ]]
[[ ! -e "$TMPDIR/docker-seen" ]]
`;

      execFileSync("bash", ["-lc", script], { encoding: "utf8" });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  for (const [shellSignal, expectedStatus] of [
    ["TERM", "143"],
    ["HUP", "129"],
  ] as const) {
    it(`escalates Docker watchdog children that ignore parent SIG${shellSignal}`, () => {
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
trap "" TERM HUP
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
kill -${shellSignal} "$(/bin/cat "$TMPDIR/watchdog-pid")"
set +e
wait "$watchdog_pid"
status="$?"
set -e
[ "$status" = "${expectedStatus}" ]
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
  }

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
export OPENCLAW_DOCKER_E2E_AVAILABLE_CPUS=8
unset OPENCLAW_DOCKER_E2E_DISABLE_RESOURCE_LIMITS
unset OPENCLAW_DOCKER_E2E_MEMORY OPENCLAW_DOCKER_E2E_CPUS OPENCLAW_DOCKER_E2E_PIDS_LIMIT

docker() {
  printf "%s\\n" "$*" >>"$TMPDIR/docker-seen"
}
export -f docker

source "$ROOT_DIR/scripts/lib/docker-e2e-container.sh"

docker_e2e_docker_run_cmd run demo

[[ "$(<"$TMPDIR/timeout-seen")" = "gtimeout:--kill-after=30s 13s|docker run --memory 8g --cpus 8 --pids-limit 2048 demo" ]]
[[ "$(<"$TMPDIR/docker-seen")" = "run --memory 8g --cpus 8 --pids-limit 2048 demo" ]]
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

  it("rejects invalid package-backed Docker run pids limits before invoking docker", () => {
    const workDir = mkdtempSync(join(tmpdir(), "openclaw-docker-package-pids-"));

    try {
      const rootDir = process.cwd();
      const script = `
set -euo pipefail
ROOT_DIR=${shellQuote(rootDir)}
TMPDIR=${shellQuote(workDir)}
export ROOT_DIR TMPDIR

dirname() {
  /usr/bin/dirname "$@"
}

docker_e2e_docker_cmd() {
  return 0
}

docker() {
  printf invoked >"$TMPDIR/docker-seen"
}
export -f docker_e2e_docker_cmd docker

source "$ROOT_DIR/scripts/lib/docker-e2e-package.sh"

set +e
OPENCLAW_DOCKER_E2E_PIDS_LIMIT=many docker_e2e_docker_run_cmd run demo 2>"$TMPDIR/stderr"
status="$?"
set -e

[[ "$status" = "2" ]]
[[ "$(<"$TMPDIR/stderr")" = *"invalid OPENCLAW_DOCKER_E2E_PIDS_LIMIT: many"* ]]
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
export OPENCLAW_DOCKER_E2E_AVAILABLE_CPUS=8
unset OPENCLAW_DOCKER_E2E_DISABLE_RESOURCE_LIMITS
unset OPENCLAW_DOCKER_E2E_MEMORY OPENCLAW_DOCKER_E2E_CPUS OPENCLAW_DOCKER_E2E_PIDS_LIMIT

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

[[ "$(<"$TMPDIR/timeout-seen")" = "gtimeout:--kill-after=30s 15s|docker run --memory 8g --cpus 8 --pids-limit 2048 demo" ]]
[[ "$(<"$TMPDIR/docker-seen")" = "run --memory 8g --cpus 8 --pids-limit 2048 demo" ]]
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
    timeout_args="$1 $2"
    shift 2
    ;;
  *)
    timeout_args="$1"
    shift
    ;;
esac
if [[ "\${1:-}" == "docker" && "\${2:-}" == "run" ]]; then
  printf "%s\\n" "$timeout_args" >"$TMPDIR/docker-timeout-seen"
fi
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
  if [[ "$1" == "rm" ]]; then
    shift
    test "$1" = "-f"
    shift
    printf "%s\\n" "$1" >>"$TMPDIR/docker-rm-seen"
    return 0
  fi

  local cidfile=""
  local mount_path=""
  local expect_volume_path=0
  local expect_cidfile=0
  local arg
  for arg in "$@"; do
    if [[ "$expect_cidfile" == "1" ]]; then
      cidfile="$arg"
      expect_cidfile=0
      continue
    fi
    if [[ "$expect_volume_path" == "1" ]]; then
      mount_path="\${arg%%:*}"
      expect_volume_path=0
      continue
    fi
    if [[ "$arg" == "--cidfile" ]]; then
      expect_cidfile=1
      continue
    fi
    if [[ "$arg" == "-v" ]]; then
      expect_volume_path=1
    fi
  done

  test -n "$cidfile"
  test ! -e "$cidfile"
  printf "container-%s\\n" "\${DOCKER_STUB_STATUS:-}" >"$cidfile"
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
grep -qx "container-7" "$TMPDIR/docker-rm-seen"
test -f "$TMPDIR/package-mount-seen"
test ! -e "$pack_dir"
test -z "$(find "$TMPDIR" -maxdepth 1 -name 'openclaw-docker-e2e-container.*' -print)"

external_dir="$TMPDIR/external-package"
mkdir -p "$external_dir"
printf fixture >"$external_dir/openclaw-current.tgz"
docker_e2e_package_mount_args "$external_dir/openclaw-current.tgz"
unset DOCKER_COMMAND_TIMEOUT
rm -f "$TMPDIR/docker-timeout-seen"
docker_e2e_run_with_harness image-name bash -lc true
test "$(cat "$TMPDIR/docker-timeout-seen")" = "--kill-after=30s 3600s"
grep -qx "container-" "$TMPDIR/docker-rm-seen"
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

    expect(runner).toContain("append_positive_int_env()");
    expect(runner).toContain("append_positive_number_env()");
    expect(runner).toContain("append_positive_int_env OPENCLAW_PLUGIN_LIFECYCLE_PHASE_TIMEOUT_MS");
    expect(runner).toContain(
      "append_positive_int_env OPENCLAW_PLUGIN_LIFECYCLE_TIMEOUT_KILL_GRACE_MS",
    );
    expect(runner).toContain("append_positive_int_env OPENCLAW_PLUGIN_LIFECYCLE_METRIC_POLL_MS");
    expect(runner).toContain("append_positive_int_env OPENCLAW_PLUGIN_LIFECYCLE_MAX_RSS_KB");
    expect(runner).toContain("append_positive_int_env OPENCLAW_PLUGIN_LIFECYCLE_MAX_WALL_MS");
    expect(runner).toContain(
      "append_positive_number_env OPENCLAW_PLUGIN_LIFECYCLE_MAX_CPU_CORE_RATIO",
    );
    expect(runner).toContain('docker_e2e_run_with_harness \\\n  "${DOCKER_ENV_ARGS[@]}"');
  });

  it.each([
    ["phase timeout", "OPENCLAW_PLUGIN_LIFECYCLE_PHASE_TIMEOUT_MS", "150ms"],
    ["CPU ratio", "OPENCLAW_PLUGIN_LIFECYCLE_MAX_CPU_CORE_RATIO", "0"],
  ])(
    "rejects invalid plugin lifecycle Docker %s overrides before package setup",
    (_label, envName, value) => {
      const result = spawnSync("bash", [PLUGIN_LIFECYCLE_MATRIX_DOCKER_E2E_PATH], {
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_CURRENT_PACKAGE_TGZ: "/tmp/openclaw-missing-package.tgz",
          [envName]: value,
        },
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain(`invalid ${envName}: ${value}`);
      expect(result.stderr).not.toContain("OpenClaw package tarball does not exist");
    },
  );

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
    expect(updateChannel).toContain("openclaw_e2e_print_log /tmp/openclaw-git-install.log");
    expect(updateChannel).toContain('openclaw_e2e_print_log "$package_install_log"');
    expect(updateChannel).not.toContain("cat /tmp/openclaw-git-install.log");
    expect(updateChannel).not.toContain('cat "$package_install_log"');
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

  it("lets upgrade survivor fixture registries resolve transitive public packages", () => {
    const runner = readFileSync(UPGRADE_SURVIVOR_DOCKER_E2E_PATH, "utf8");
    const publishedRunner = readFileSync(UPGRADE_SURVIVOR_RUN_SCRIPT, "utf8");

    for (const script of [runner, publishedRunner]) {
      expect(script).toContain("OPENCLAW_NPM_REGISTRY_UPSTREAM=https://registry.npmjs.org");
      expect(script).toContain("node scripts/e2e/lib/plugins/npm-registry-server.mjs");
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

  it("keeps append-only mock E2E state under per-run scratch roots", () => {
    const scripts = [
      {
        path: RELEASE_TYPED_ONBOARDING_SCENARIO_PATH,
        scratch:
          'scenario_tmp="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-release-typed-onboarding.XXXXXX")"',
        logDir: 'LOG_DIR="$scenario_tmp/logs"',
        requestLog: 'MOCK_REQUEST_LOG="$scenario_tmp/openai-requests.jsonl"',
        expectedPaths: [
          'INSTALL_LOG="$LOG_DIR/install.log"',
          'ONBOARD_LOG="$LOG_DIR/onboard.log"',
          'OPENAI_LOG="$LOG_DIR/openai.log"',
          'AGENT_LOG="$LOG_DIR/agent.log"',
          'input_fifo_dir="$(mktemp -d "$scenario_tmp/input.XXXXXX")"',
        ],
        removed: [
          "/tmp/openclaw-release-typed-onboarding-openai.jsonl",
          "/tmp/openclaw-release-typed-onboarding-install.log",
          "/tmp/openclaw-release-typed-onboarding.log",
          "/tmp/openclaw-release-typed-onboarding-openai.log",
          "/tmp/openclaw-release-typed-onboarding-agent.log",
          'mktemp -d "/tmp/openclaw-release-typed-onboarding.XXXXXX"',
        ],
      },
      {
        path: RELEASE_USER_JOURNEY_SCENARIO_PATH,
        scratch:
          'scenario_tmp="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-release-user-journey.XXXXXX")"',
        logDir: 'LOG_DIR="$scenario_tmp/logs"',
        requestLog: 'MOCK_REQUEST_LOG="$scenario_tmp/openai-requests.jsonl"',
        extraState: 'CLICKCLACK_STATE="$scenario_tmp/clickclack.json"',
        expectedPaths: [
          'INSTALL_LOG="$LOG_DIR/install.log"',
          'ONBOARD_LOG="$LOG_DIR/onboard.log"',
          'OPENAI_LOG="$LOG_DIR/openai.log"',
          'AGENT_LOG="$LOG_DIR/agent.log"',
          'PLUGIN_A_INSTALL_PATH_FILE="$scenario_tmp/plugin-a-install-path.txt"',
          'PLUGIN_A_SOURCE_PATH_FILE="$scenario_tmp/plugin-a-source-path.txt"',
          'plugin_a_dir="$(mktemp -d "$scenario_tmp/plugin-a.XXXXXX")"',
          'plugin_b_dir="$(mktemp -d "$scenario_tmp/plugin-b.XXXXXX")"',
        ],
        removed: [
          "/tmp/openclaw-release-user-journey-openai.jsonl",
          "/tmp/openclaw-release-user-journey-clickclack.json",
          "/tmp/openclaw-release-user-journey-install.log",
          "/tmp/openclaw-release-user-journey-onboard.log",
          "/tmp/openclaw-release-user-journey-agent.log",
          "/tmp/openclaw-release-user-journey-plugin-a-install-path.txt",
          "/tmp/openclaw-release-user-journey-plugin-a-source-path.txt",
          'mktemp -d "/tmp/openclaw-release-journey-plugin-a.XXXXXX"',
          'mktemp -d "/tmp/openclaw-release-journey-plugin-b.XXXXXX"',
        ],
      },
      {
        path: RELEASE_UPGRADE_USER_JOURNEY_SCENARIO_PATH,
        scratch:
          'scenario_tmp="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-release-upgrade-user-journey.XXXXXX")"',
        logDir: 'LOG_DIR="$scenario_tmp/logs"',
        requestLog: 'MOCK_REQUEST_LOG="$scenario_tmp/openai-requests.jsonl"',
        extraState: 'CLICKCLACK_STATE="$scenario_tmp/clickclack.json"',
        expectedPaths: [
          'BASELINE_INSTALL_LOG="$LOG_DIR/baseline-install.log"',
          'CANDIDATE_INSTALL_LOG="$LOG_DIR/candidate-install.log"',
          'ONBOARD_LOG="$LOG_DIR/onboard.log"',
          'OPENAI_LOG="$LOG_DIR/openai.log"',
          'PLUGIN_INSTALL_LOG="$LOG_DIR/plugin-install.log"',
          'AGENT_LOG="$LOG_DIR/agent.log"',
          'plugin_dir="$(mktemp -d "$scenario_tmp/plugin.XXXXXX")"',
          'plugins install "$plugin_dir" --force',
        ],
        removed: [
          "/tmp/openclaw-release-upgrade-user-journey-openai.jsonl",
          "/tmp/openclaw-release-upgrade-user-journey-clickclack.json",
          "/tmp/openclaw-release-upgrade-baseline-install.log",
          "/tmp/openclaw-release-upgrade-candidate-install.log",
          "/tmp/openclaw-release-upgrade-onboard.log",
          "/tmp/openclaw-release-upgrade-agent.log",
          'mktemp -d "/tmp/openclaw-release-upgrade-plugin.XXXXXX"',
        ],
      },
      {
        path: NPM_ONBOARD_CHANNEL_AGENT_DOCKER_E2E_PATH,
        scratch:
          'scenario_tmp="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-npm-onboard-channel-agent.XXXXXX")"',
        requestLog: 'MOCK_REQUEST_LOG="$scenario_tmp/mock-openai-requests.jsonl"',
        removed: ["/tmp/openclaw-mock-openai-requests.jsonl"],
      },
    ];

    for (const {
      path,
      scratch,
      logDir,
      requestLog,
      extraState,
      expectedPaths,
      removed,
    } of scripts) {
      const script = readFileSync(path, "utf8");

      expect(script, path).toContain(scratch);
      if (logDir) {
        expect(script, path).toContain(logDir);
      }
      expect(script, path).toContain(requestLog);
      expect(script, path).toContain('rm -rf "$scenario_tmp"');
      if (extraState) {
        expect(script, path).toContain(extraState);
      }
      for (const expectedPath of expectedPaths ?? []) {
        expect(script, path).toContain(expectedPath);
      }
      for (const stalePath of removed) {
        expect(script, path).not.toContain(stalePath);
      }
      expect(script, path).not.toMatch(/\/tmp\/openclaw-release-[\w-]+\.(?:log|json|err|txt)/u);
    }
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

  it("keeps multi-node update Docker artifacts isolated by default", () => {
    const multiNode = readFileSync(MULTI_NODE_UPDATE_DOCKER_E2E_PATH, "utf8");

    expect(multiNode).toContain(
      'RUN_ID="${OPENCLAW_MULTI_NODE_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$$}"',
    );
    expect(multiNode).toContain(
      'ARTIFACT_DIR="${OPENCLAW_MULTI_NODE_ARTIFACT_DIR:-$ROOT_DIR/.artifacts/multi-node-update/$RUN_ID}"',
    );
    expect(multiNode).toContain('-v "$ARTIFACT_DIR:/tmp/artifacts"');
    expect(multiNode).not.toContain(
      'ARTIFACT_DIR="${OPENCLAW_MULTI_NODE_ARTIFACT_DIR:-$ROOT_DIR/.artifacts/multi-node-update}"',
    );
  });

  it("reuses the shared bare image for multi-node update targeted runs", () => {
    const workDir = mkdtempSync(join(tmpdir(), "openclaw-multi-node-shared-image-"));

    try {
      const rootDir = process.cwd();
      mkdirSync(join(workDir, "bin"));
      writeFileSync(join(workDir, "openclaw-current.tgz"), "fake package");
      writeFileSync(
        join(workDir, "bin", "docker"),
        `#!/usr/bin/env bash
printf "%s\\n" "$*" >>"$TMPDIR/docker-seen"
case "$1 $2" in
  "image inspect")
    exit 0
    ;;
  "run "*)
    exit 0
    ;;
esac
exit 9
`,
      );
      writeFileSync(
        join(workDir, "bin", "timeout"),
        `#!/usr/bin/env bash
case "\${1:-}" in
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
exec "$@"
`,
      );
      chmodSync(join(workDir, "bin", "docker"), 0o755);
      chmodSync(join(workDir, "bin", "timeout"), 0o755);

      const script = `
set -euo pipefail
ROOT_DIR=${shellQuote(rootDir)}
TMPDIR=${shellQuote(workDir)}
export ROOT_DIR TMPDIR
export PATH="$TMPDIR/bin:$PATH"
export OPENCLAW_SKIP_DOCKER_BUILD=1
export OPENCLAW_DOCKER_E2E_IMAGE=shared-bare
export OPENCLAW_CURRENT_PACKAGE_TGZ="$TMPDIR/openclaw-current.tgz"
export OPENCLAW_MULTI_NODE_ARTIFACT_DIR="$TMPDIR/artifacts"

bash "$ROOT_DIR/scripts/e2e/multi-node-update-docker.sh"

grep -q '^image inspect shared-bare$' "$TMPDIR/docker-seen"
grep -Fq ' shared-bare ' "$TMPDIR/docker-seen"
if grep -Fq 'openclaw-multi-node-update-e2e' "$TMPDIR/docker-seen"; then
  echo "multi-node update lane ignored the shared targeted image" >&2
  exit 1
fi
`;

      execFileSync("bash", ["-lc", script], { encoding: "utf8" });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("bounds upgrade survivor foreground OpenClaw CLI calls", () => {
    const runner = readFileSync(UPGRADE_SURVIVOR_DOCKER_E2E_PATH, "utf8");
    const publishedRunner = readFileSync(UPGRADE_SURVIVOR_RUN_SCRIPT, "utf8");
    const updateRestartAuth = readFileSync(UPGRADE_SURVIVOR_UPDATE_RESTART_AUTH_PATH, "utf8");

    expect(runner).toContain('source "$ROOT_DIR/scripts/lib/openclaw-e2e-instance.sh"');
    expect(runner).toContain(
      'START_BUDGET_SECONDS="$(openclaw_e2e_read_positive_int_env OPENCLAW_UPGRADE_SURVIVOR_START_BUDGET_SECONDS 90)"',
    );
    expect(runner).toContain(
      'STATUS_BUDGET_SECONDS="$(openclaw_e2e_read_positive_int_env OPENCLAW_UPGRADE_SURVIVOR_STATUS_BUDGET_SECONDS 30)"',
    );
    expect(runner).toContain(
      '-e OPENCLAW_UPGRADE_SURVIVOR_START_BUDGET_SECONDS="$START_BUDGET_SECONDS"',
    );
    expect(runner).toContain(
      '-e OPENCLAW_UPGRADE_SURVIVOR_STATUS_BUDGET_SECONDS="$STATUS_BUDGET_SECONDS"',
    );
    expect(runner).toContain(
      'START_BUDGET="$(openclaw_e2e_read_positive_int_env OPENCLAW_UPGRADE_SURVIVOR_START_BUDGET_SECONDS 90)"',
    );
    expect(runner).toContain(
      'STATUS_BUDGET="$(openclaw_e2e_read_positive_int_env OPENCLAW_UPGRADE_SURVIVOR_STATUS_BUDGET_SECONDS 30)"',
    );
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
    expect(runner).toContain(
      'PROBE_TIMEOUT_MS="$(openclaw_e2e_read_nonnegative_int_env OPENCLAW_UPGRADE_SURVIVOR_PROBE_TIMEOUT_MS 60000)"',
    );
    expect(runner).toContain(
      "openclaw_e2e_read_positive_int_env OPENCLAW_UPGRADE_SURVIVOR_PROBE_ATTEMPT_TIMEOUT_MS 5000",
    );
    expect(runner).toContain(
      "openclaw_e2e_read_positive_int_env OPENCLAW_UPGRADE_SURVIVOR_PROBE_MAX_BODY_BYTES 1048576",
    );
    expect(runner).toContain('-e OPENCLAW_UPGRADE_SURVIVOR_PROBE_TIMEOUT_MS="$PROBE_TIMEOUT_MS"');
    expect(runner).toContain(
      '-e OPENCLAW_UPGRADE_SURVIVOR_PROBE_ATTEMPT_TIMEOUT_MS="$PROBE_ATTEMPT_TIMEOUT_MS"',
    );
    expect(runner).toContain(
      '-e OPENCLAW_UPGRADE_SURVIVOR_PROBE_MAX_BODY_BYTES="$PROBE_MAX_BODY_BYTES"',
    );
    expect(runner).toContain("readyz_probe_args=(");
    expect(runner).toContain(
      'readyz_probe_args+=(--allow-failing "$OPENCLAW_UPGRADE_SURVIVOR_READYZ_ALLOW_FAILING")',
    );
    expect(runner).toContain("readyz_probe_args+=(--allow-degraded-ready)");
    expect(runner).toContain(
      'node scripts/e2e/lib/upgrade-survivor/probe-gateway.mjs "${readyz_probe_args[@]}"',
    );
    expect(runner).toContain("OPENCLAW_UPGRADE_SURVIVOR_READYZ_ALLOW_FAILING");
    expect(runner).toContain("OPENCLAW_UPGRADE_SURVIVOR_READYZ_ALLOW_DEGRADED");

    expect(publishedRunner).toContain(
      'COMMAND_TIMEOUT="${OPENCLAW_UPGRADE_SURVIVOR_COMMAND_TIMEOUT:-900s}"',
    );
    expect(publishedRunner).toContain(
      'budget="$(openclaw_e2e_read_positive_int_env OPENCLAW_UPGRADE_SURVIVOR_START_BUDGET_SECONDS 90)"',
    );
    expect(publishedRunner).toContain(
      'budget="$(openclaw_e2e_read_positive_int_env OPENCLAW_UPGRADE_SURVIVOR_STATUS_BUDGET_SECONDS 30)"',
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
    expect(publishedRunner).toContain("start_gateway legacy-ready-log-ok");
    expect(publishedRunner).toContain(
      'openclaw_e2e_wait_gateway_ready "$gateway_pid" "$GATEWAY_LOG" 360 "$port" "${1:-strict}"',
    );

    expect(updateRestartAuth).toContain(
      'command_timeout="${OPENCLAW_UPGRADE_SURVIVOR_COMMAND_TIMEOUT:-900s}"',
    );
    expect(updateRestartAuth).toContain(
      'openclaw_e2e_maybe_timeout "$command_timeout" env -u OPENCLAW_GATEWAY_TOKEN',
    );
    expect(updateRestartAuth).toContain('openclaw gateway --port "$port" --bind loopback');
    expect(updateRestartAuth).toContain(
      'openclaw_e2e_wait_gateway_ready "$gateway_pid" "$log_file" 360 "$port"',
    );
  });

  it("keeps upgrade survivor auto-auth success summary set -u safe", () => {
    const runner = readFileSync(UPGRADE_SURVIVOR_DOCKER_E2E_PATH, "utf8");

    const summaryDefaultIndex = runner.indexOf('startup_summary="n/a"');
    const autoAuthIndex = runner.indexOf(
      'if [ "$UPDATE_RESTART_MODE" = "auto-auth" ]; then',
      summaryDefaultIndex,
    );
    const manualSummaryIndex = runner.indexOf('startup_summary="${start_seconds}s"', autoAuthIndex);
    const successIndex = runner.indexOf(
      "startup=${startup_summary} status=${status_seconds}s",
      manualSummaryIndex,
    );

    expect(summaryDefaultIndex).toBeGreaterThan(-1);
    expect(autoAuthIndex).toBeGreaterThan(summaryDefaultIndex);
    expect(manualSummaryIndex).toBeGreaterThan(autoAuthIndex);
    expect(successIndex).toBeGreaterThan(manualSummaryIndex);
  });

  it.each([
    ["start budget", "OPENCLAW_UPGRADE_SURVIVOR_START_BUDGET_SECONDS", "90s"],
    ["status budget", "OPENCLAW_UPGRADE_SURVIVOR_STATUS_BUDGET_SECONDS", "30s"],
    ["probe timeout", "OPENCLAW_UPGRADE_SURVIVOR_PROBE_TIMEOUT_MS", "soon"],
    ["probe attempt timeout", "OPENCLAW_UPGRADE_SURVIVOR_PROBE_ATTEMPT_TIMEOUT_MS", "0"],
    ["probe body cap", "OPENCLAW_UPGRADE_SURVIVOR_PROBE_MAX_BODY_BYTES", "64bytes"],
  ])("rejects invalid upgrade survivor Docker %s before Docker setup", (_label, envName, value) => {
    const result = spawnSync("bash", [UPGRADE_SURVIVOR_DOCKER_E2E_PATH], {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_UPGRADE_SURVIVOR_E2E_SKIP_BUILD: "1",
        [envName]: value,
      },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`invalid ${envName}: ${value}`);
    expect(result.stderr).not.toContain("Docker image not found");
  });

  it("bounds upgrade survivor failure log diagnostics", () => {
    const runner = readFileSync(UPGRADE_SURVIVOR_DOCKER_E2E_PATH, "utf8");
    const publishedRunner = readFileSync(UPGRADE_SURVIVOR_RUN_SCRIPT, "utf8");

    expect(runner).toContain("openclaw_e2e_print_log /tmp/openclaw-upgrade-survivor-update.err");
    expect(runner).toContain("openclaw_e2e_print_log /tmp/openclaw-upgrade-survivor-update.json");
    expect(runner).toContain("openclaw_e2e_print_log /tmp/openclaw-upgrade-survivor-doctor.log");
    expect(runner).toContain("openclaw_e2e_print_log /tmp/openclaw-upgrade-survivor-status.err");
    expect(runner).toContain("openclaw_e2e_print_log /tmp/openclaw-upgrade-survivor-status.json");
    expect(runner).toContain('openclaw_e2e_print_log "$GATEWAY_LOG"');
    expect(runner).toContain('openclaw_e2e_print_log "$SYSTEMCTL_SHIM_DAEMON_LOG"');
    expect(runner).toContain('openclaw_e2e_print_log "$log_file"');
    expect(runner).not.toContain("cat /tmp/openclaw-upgrade-survivor-update.err");
    expect(runner).not.toContain("cat /tmp/openclaw-upgrade-survivor-update.json");
    expect(runner).not.toContain("cat /tmp/openclaw-upgrade-survivor-doctor.log");
    expect(runner).not.toContain("cat /tmp/openclaw-upgrade-survivor-status.err");
    expect(runner).not.toContain("cat /tmp/openclaw-upgrade-survivor-status.json");
    expect(runner).not.toContain('cat "$GATEWAY_LOG"');
    expect(runner).not.toContain('cat "$SYSTEMCTL_SHIM_DAEMON_LOG"');
    expect(runner).not.toContain('cat "$log_file"');

    expect(publishedRunner).toContain('openclaw_e2e_print_log "$BASELINE_INSTALL_LOG"');
    expect(publishedRunner).toContain('openclaw_e2e_print_log "$BASELINE_CONFIG_VALIDATE_LOG"');
    expect(publishedRunner).toContain('openclaw_e2e_print_log "$BASELINE_SERVICE_INSTALL_ERR"');
    expect(publishedRunner).toContain('openclaw_e2e_print_log "$BASELINE_SERVICE_INSTALL_JSON"');
    expect(publishedRunner).toContain('openclaw_e2e_print_log "$UPDATE_ERR"');
    expect(publishedRunner).toContain('openclaw_e2e_print_log "$UPDATE_JSON"');
    expect(publishedRunner).toContain('openclaw_e2e_print_log "$DOCTOR_LOG"');
    expect(publishedRunner).toContain('openclaw_e2e_print_log "$GATEWAY_LOG"');
    expect(publishedRunner).toContain('openclaw_e2e_print_log "$STATUS_ERR"');
    expect(publishedRunner).toContain('openclaw_e2e_print_log "$STATUS_JSON"');
    expect(publishedRunner).toContain('openclaw_e2e_print_log "$log_file"');
    expect(publishedRunner).not.toContain('cat "$BASELINE_INSTALL_LOG"');
    expect(publishedRunner).not.toContain('cat "$BASELINE_CONFIG_VALIDATE_LOG"');
    expect(publishedRunner).not.toContain('cat "$BASELINE_SERVICE_INSTALL_ERR"');
    expect(publishedRunner).not.toContain('cat "$BASELINE_SERVICE_INSTALL_JSON"');
    expect(publishedRunner).not.toContain('cat "$UPDATE_ERR"');
    expect(publishedRunner).not.toContain('cat "$UPDATE_JSON"');
    expect(publishedRunner).not.toContain('cat "$DOCTOR_LOG"');
    expect(publishedRunner).not.toContain('cat "$GATEWAY_LOG"');
    expect(publishedRunner).not.toContain('cat "$STATUS_ERR"');
    expect(publishedRunner).not.toContain('cat "$STATUS_JSON"');
    expect(publishedRunner).not.toContain('cat "$log_file"');
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

  it("forwards harness stdin to backgrounded Docker runs", () => {
    const workDir = mkdtempSync(join(tmpdir(), "openclaw-docker-harness-stdin-"));

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

source "$ROOT_DIR/scripts/lib/docker-e2e-package.sh"

docker() {
  if [[ "$1" == "rm" ]]; then
    return 0
  fi

  local cidfile=""
  local expect_cidfile=0
  local arg
  for arg in "$@"; do
    if [[ "$expect_cidfile" == "1" ]]; then
      cidfile="$arg"
      expect_cidfile=0
      continue
    fi
    if [[ "$arg" == "--cidfile" ]]; then
      expect_cidfile=1
    fi
  done

  test -n "$cidfile"
  printf "container-stdin\\n" >"$cidfile"
  cat >"$TMPDIR/docker-stdin-seen"
}
export -f docker

docker_e2e_run_with_harness image-name bash -s <<'SH'
printf "heredoc reached docker\\n"
SH

grep -Fxq 'printf "heredoc reached docker\\n"' "$TMPDIR/docker-stdin-seen"
`;

      execFileSync("bash", ["-lc", script], { encoding: "utf8" });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("preserves caller-owned file descriptors around harness runs", () => {
    const workDir = mkdtempSync(join(tmpdir(), "openclaw-docker-harness-fd-"));
    try {
      const rootDir = process.cwd();
      const script = String.raw`
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

source "$ROOT_DIR/scripts/lib/docker-e2e-package.sh"

docker() {
  local cidfile=""
  local expect_cidfile=0
  local arg
  for arg in "$@"; do
    if [[ "$expect_cidfile" == "1" ]]; then
      cidfile="$arg"
      expect_cidfile=0
      continue
    fi
    if [[ "$arg" == "--cidfile" ]]; then
      expect_cidfile=1
    fi
  done
  test -n "$cidfile"
  printf "container-fd\n" >"$cidfile"
  cat >/dev/null
}
export -f docker

exec 19>"$TMPDIR/caller-fd"
docker_e2e_run_with_harness image-name bash -s <<'SH'
true
SH
printf "preserved\n" >&19
exec 19>&-
grep -Fxq preserved "$TMPDIR/caller-fd"
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

  it("bounds Codex npm plugin live assertion file and transcript reads", () => {
    const assertions = readFileSync(CODEX_NPM_PLUGIN_LIVE_ASSERTIONS_PATH, "utf8");
    const runner = readFileSync(CODEX_NPM_PLUGIN_LIVE_DOCKER_E2E_PATH, "utf8");

    expect(assertions).toContain("OPENCLAW_CODEX_NPM_PLUGIN_ASSERT_MAX_TEXT_FILE_BYTES");
    expect(assertions).toContain("OPENCLAW_CODEX_NPM_PLUGIN_ASSERT_MAX_ERROR_TAIL_BYTES");
    expect(assertions).toContain("OPENCLAW_CODEX_NPM_PLUGIN_ASSERT_MAX_TRANSCRIPT_FILES");
    expect(assertions).toContain("OPENCLAW_CODEX_NPM_PLUGIN_ASSERT_MAX_TRANSCRIPT_WALK_ENTRIES");
    expect(assertions).toContain("OPENCLAW_CODEX_NPM_PLUGIN_ASSERT_MAX_TRANSCRIPT_SCAN_BYTES");
    expect(assertions).toContain("const AGENT_TURN_TIMEOUT_SECONDS = readPositiveIntEnv(");
    expect(assertions).toContain('"OPENCLAW_CODEX_NPM_PLUGIN_AGENT_TIMEOUT_SECONDS"');
    expect(assertions).toContain("requestTimeoutMs: AGENT_TURN_TIMEOUT_SECONDS * 1000");
    expect(assertions).toContain("timeoutSeconds: AGENT_TURN_TIMEOUT_SECONDS");
    expect(assertions).not.toContain("requestTimeoutMs: 420_000");
    expect(assertions).not.toContain("timeoutSeconds: 420");
    expect(assertions).toContain("readTextFileBounded");
    expect(assertions).toContain("readTextFileTail");
    expect(assertions).toContain(
      ".toSorted((left, right) => right.stat.mtimeMs - left.stat.mtimeMs)",
    );
    expect(assertions).toContain(".slice(0, MAX_TRANSCRIPT_FILES)");
    expect(assertions).toContain("scannedBytes + readableBytes > MAX_TRANSCRIPT_SCAN_BYTES");
    expect(assertions).not.toContain('const content = fs.readFileSync(filePath, "utf8")');
    expect(runner).toContain("docker_e2e_print_log /tmp/openclaw-codex-plugin-pack.log");
    expect(runner).not.toContain("cat /tmp/openclaw-codex-plugin-pack.log");
    expect(assertions).toContain(
      'readTextFileTail(\n        "/tmp/openclaw-codex-agent-after-uninstall.err",',
    );
    expect(runner).toContain('assert-agent-error "$post_uninstall_status"');
    expect(runner).not.toContain("tail -n 120 /tmp/openclaw-codex-agent-after-uninstall.err");
    expect(runner).not.toContain("cat /tmp/openclaw-codex-agent-after-uninstall.err");
    const earlyAgentTimeoutEnvIndex = runner.indexOf(
      "docker_e2e_read_positive_int_env OPENCLAW_CODEX_NPM_PLUGIN_AGENT_TIMEOUT_SECONDS 420",
    );
    const profileSourceIndex = runner.indexOf('source "$PROFILE_FILE"');
    const finalAgentTimeoutEnvIndex = runner.lastIndexOf(
      "docker_e2e_read_positive_int_env OPENCLAW_CODEX_NPM_PLUGIN_AGENT_TIMEOUT_SECONDS",
    );
    const dockerBuildIndex = runner.indexOf("docker_e2e_build_or_reuse");
    const preparePluginSpecIndex = runner.indexOf("\nprepare_codex_plugin_spec\n");
    expect(earlyAgentTimeoutEnvIndex).toBeGreaterThanOrEqual(0);
    expect(dockerBuildIndex).toBeGreaterThan(earlyAgentTimeoutEnvIndex);
    expect(preparePluginSpecIndex).toBeGreaterThan(dockerBuildIndex);
    expect(profileSourceIndex).toBeGreaterThanOrEqual(0);
    expect(profileSourceIndex).toBeGreaterThan(preparePluginSpecIndex);
    expect(finalAgentTimeoutEnvIndex).toBeGreaterThan(profileSourceIndex);
    expect(runner).toContain(
      "docker_e2e_read_positive_int_env OPENCLAW_CODEX_NPM_PLUGIN_AGENT_TIMEOUT_SECONDS 420",
    );
    expect(runner).toContain(
      'docker_e2e_read_positive_int_env OPENCLAW_CODEX_NPM_PLUGIN_AGENT_TIMEOUT_SECONDS "$AGENT_TURN_TIMEOUT_SECONDS"',
    );
    expect(runner).toContain(
      'COMMAND_TIMEOUT="${OPENCLAW_E2E_COMMAND_TIMEOUT:-$((10#$AGENT_TURN_TIMEOUT_SECONDS + 60))s}"',
    );
    expect(runner).toContain(
      '-e "OPENCLAW_CODEX_NPM_PLUGIN_AGENT_TIMEOUT_SECONDS=$AGENT_TURN_TIMEOUT_SECONDS"',
    );
    expect(runner).toContain('-e "OPENCLAW_E2E_COMMAND_TIMEOUT=$COMMAND_TIMEOUT"');
    expect(runner).toContain(
      'AGENT_TURN_TIMEOUT_SECONDS="${OPENCLAW_CODEX_NPM_PLUGIN_AGENT_TIMEOUT_SECONDS:-420}"',
    );
    expect(runner).toContain('--timeout "$AGENT_TURN_TIMEOUT_SECONDS"');
    expect(runner).not.toContain("--timeout 420");
  });

  it.each([
    [
      "Codex npm plugin live",
      CODEX_NPM_PLUGIN_LIVE_DOCKER_E2E_PATH,
      "OPENCLAW_CODEX_NPM_PLUGIN_ASSERT_MAX_TEXT_FILE_BYTES",
      "64kb",
    ],
    [
      "Codex npm plugin live agent timeout",
      CODEX_NPM_PLUGIN_LIVE_DOCKER_E2E_PATH,
      "OPENCLAW_CODEX_NPM_PLUGIN_AGENT_TIMEOUT_SECONDS",
      "420s",
    ],
    [
      "npm onboard channel-agent",
      NPM_ONBOARD_CHANNEL_AGENT_DOCKER_E2E_PATH,
      "OPENCLAW_NPM_ONBOARD_JSON_ARTIFACT_MAX_BYTES",
      "64kb",
    ],
    [
      "plugins",
      PLUGINS_DOCKER_E2E_PATH,
      "OPENCLAW_PLUGINS_E2E_CLAWHUB_PREFLIGHT_TIMEOUT_MS",
      "soon",
    ],
    [
      "release user journey",
      RELEASE_USER_JOURNEY_DOCKER_E2E_PATH,
      "OPENCLAW_RELEASE_USER_JOURNEY_HTTP_BODY_MAX_BYTES",
      "64kb",
    ],
  ])(
    "rejects invalid package assertion env before Docker setup for %s",
    (_label, path, envName, value) => {
      const result = spawnSync("bash", [path], {
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_SKIP_DOCKER_BUILD: "1",
          [envName]: value,
        },
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain(`invalid ${envName}: ${value}`);
      expect(result.stderr).not.toContain("Docker image not found");
    },
  );

  it("forwards package assertion env limits into Docker runners", () => {
    const expectations = [
      [
        CODEX_NPM_PLUGIN_LIVE_DOCKER_E2E_PATH,
        [
          ["OPENCLAW_CODEX_NPM_PLUGIN_ASSERT_MAX_TEXT_FILE_BYTES", "1048576"],
          ["OPENCLAW_CODEX_NPM_PLUGIN_ASSERT_MAX_ERROR_TAIL_BYTES", "65536"],
          ["OPENCLAW_CODEX_NPM_PLUGIN_ASSERT_MAX_TRANSCRIPT_FILES", "64"],
          ["OPENCLAW_CODEX_NPM_PLUGIN_ASSERT_MAX_TRANSCRIPT_WALK_ENTRIES", "4096"],
          ["OPENCLAW_CODEX_NPM_PLUGIN_ASSERT_MAX_TRANSCRIPT_SCAN_BYTES", "2097152"],
          ["OPENCLAW_CODEX_NPM_PLUGIN_AGENT_TIMEOUT_SECONDS", "420"],
        ],
      ],
      [
        NPM_ONBOARD_CHANNEL_AGENT_DOCKER_E2E_PATH,
        [
          ["OPENCLAW_NPM_ONBOARD_JSON_ARTIFACT_MAX_BYTES", "1048576"],
          ["OPENCLAW_NPM_ONBOARD_STATUS_TEXT_MAX_BYTES", "1048576"],
        ],
      ],
      [
        PLUGINS_DOCKER_E2E_PATH,
        [
          ["OPENCLAW_PLUGINS_E2E_CLAWHUB_PREFLIGHT_BODY_MAX_BYTES", "1048576"],
          ["OPENCLAW_PLUGINS_E2E_CLAWHUB_PREFLIGHT_TIMEOUT_MS", "30000"],
        ],
      ],
      [
        RELEASE_USER_JOURNEY_DOCKER_E2E_PATH,
        [
          ["OPENCLAW_RELEASE_USER_JOURNEY_HTTP_TIMEOUT_MS", "5000"],
          ["OPENCLAW_RELEASE_USER_JOURNEY_HTTP_BODY_MAX_BYTES", "1048576"],
        ],
      ],
    ] as const;

    for (const [path, envs] of expectations) {
      const runner = readFileSync(path, "utf8");
      for (const [envName, fallback] of envs) {
        expect(runner, `${path} reads ${envName}`).toContain(
          `docker_e2e_read_positive_int_env ${envName} ${fallback}`,
        );
        expect(runner, `${path} forwards ${envName}`).toContain(`-e "${envName}=`);
      }
    }
  });

  it("gives Codex on-demand package installs enough time to reach Codex assertions", () => {
    const runner = readFileSync(CODEX_ON_DEMAND_DOCKER_E2E_PATH, "utf8");

    expect(runner).toContain(
      'export OPENCLAW_E2E_NPM_INSTALL_TIMEOUT="${OPENCLAW_E2E_NPM_INSTALL_TIMEOUT:-1200s}"',
    );
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

  it("threads the live plugin tool output cap into the Docker harness", () => {
    const runner = readFileSync(LIVE_PLUGIN_TOOL_DOCKER_E2E_PATH, "utf8");

    expect(runner).toContain('source "$ROOT_DIR/scripts/lib/openclaw-e2e-instance.sh"');
    const earlyTimeoutEnvIndex = runner.indexOf(
      "openclaw_e2e_read_positive_int_env OPENCLAW_LIVE_PLUGIN_TOOL_TIMEOUT_SECONDS 300",
    );
    const profileSourceIndex = runner.indexOf('source "$PROFILE_FILE"');
    const finalTimeoutEnvIndex = runner.lastIndexOf(
      "openclaw_e2e_read_positive_int_env OPENCLAW_LIVE_PLUGIN_TOOL_TIMEOUT_SECONDS",
    );
    const dockerBuildIndex = runner.indexOf("docker_e2e_build_or_reuse");
    expect(earlyTimeoutEnvIndex).toBeGreaterThanOrEqual(0);
    expect(dockerBuildIndex).toBeGreaterThan(earlyTimeoutEnvIndex);
    expect(profileSourceIndex).toBeGreaterThanOrEqual(0);
    expect(profileSourceIndex).toBeGreaterThan(dockerBuildIndex);
    expect(finalTimeoutEnvIndex).toBeGreaterThan(profileSourceIndex);
    expect(runner).toContain(
      'AGENT_TURN_TIMEOUT_SECONDS="$(openclaw_e2e_read_positive_int_env OPENCLAW_LIVE_PLUGIN_TOOL_TIMEOUT_SECONDS 300)"',
    );
    expect(runner).toContain(
      'AGENT_TURN_TIMEOUT_SECONDS="$(openclaw_e2e_read_positive_int_env OPENCLAW_LIVE_PLUGIN_TOOL_TIMEOUT_SECONDS "$AGENT_TURN_TIMEOUT_SECONDS")"',
    );
    expect(runner).toContain(
      'COMMAND_TIMEOUT="${OPENCLAW_E2E_COMMAND_TIMEOUT:-$((10#$AGENT_TURN_TIMEOUT_SECONDS + 60))s}"',
    );
    expect(runner).toContain(
      'AGENT_OUTPUT_MAX_BYTES="$(openclaw_e2e_read_positive_int_env OPENCLAW_LIVE_PLUGIN_TOOL_AGENT_OUTPUT_MAX_BYTES 1048576)"',
    );
    expect(runner).toContain(
      'AGENT_OUTPUT_DUMP_BYTES="$(openclaw_e2e_read_nonnegative_int_env OPENCLAW_LIVE_PLUGIN_TOOL_AGENT_OUTPUT_DUMP_BYTES 16384)"',
    );
    expect(runner).toContain(
      'SESSION_SCAN_MAX_ENTRIES="$(openclaw_e2e_read_positive_int_env OPENCLAW_LIVE_PLUGIN_TOOL_SESSION_SCAN_MAX_ENTRIES 50000)"',
    );
    expect(runner).toContain(
      '-e "OPENCLAW_LIVE_PLUGIN_TOOL_AGENT_OUTPUT_DUMP_BYTES=$AGENT_OUTPUT_DUMP_BYTES"',
    );
    expect(runner).toContain(
      '-e "OPENCLAW_LIVE_PLUGIN_TOOL_AGENT_OUTPUT_MAX_BYTES=$AGENT_OUTPUT_MAX_BYTES"',
    );
    expect(runner).toContain(
      '-e "OPENCLAW_LIVE_PLUGIN_TOOL_SESSION_SCAN_MAX_ENTRIES=$SESSION_SCAN_MAX_ENTRIES"',
    );
    expect(runner).toContain('-e "OPENCLAW_E2E_COMMAND_TIMEOUT=$COMMAND_TIMEOUT"');
    expect(runner).not.toContain(
      'AGENT_OUTPUT_MAX_BYTES="${OPENCLAW_LIVE_PLUGIN_TOOL_AGENT_OUTPUT_MAX_BYTES:-1048576}"',
    );
    expect(runner).toContain("OPENCLAW_LIVE_PLUGIN_TOOL_AGENT_OUTPUT_DUMP_BYTES");
    expect(runner).toContain('tail -c "$agent_output_dump_bytes" /tmp/openclaw-agent.json');
    const dumpLogsStart = runner.indexOf("openclaw_e2e_dump_logs \\");
    const dumpLogsEnd = runner.indexOf("\n}", dumpLogsStart);
    expect(runner.slice(dumpLogsStart, dumpLogsEnd)).not.toContain("/tmp/openclaw-agent.json");
  });

  it.each([
    ["timeout", "OPENCLAW_LIVE_PLUGIN_TOOL_TIMEOUT_SECONDS", "1e3"],
    ["output cap", "OPENCLAW_LIVE_PLUGIN_TOOL_AGENT_OUTPUT_MAX_BYTES", "64kb"],
    ["output dump cap", "OPENCLAW_LIVE_PLUGIN_TOOL_AGENT_OUTPUT_DUMP_BYTES", "64kb"],
    ["session scan cap", "OPENCLAW_LIVE_PLUGIN_TOOL_SESSION_SCAN_MAX_ENTRIES", "0"],
  ])(
    "rejects invalid live plugin tool Docker %s values before Docker setup",
    (_label, envName, value) => {
      const result = spawnSync("bash", [LIVE_PLUGIN_TOOL_DOCKER_E2E_PATH], {
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_LIVE_PLUGIN_TOOL_HOST_BUILD: "0",
          OPENCLAW_SKIP_DOCKER_BUILD: "1",
          [envName]: value,
        },
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain(`invalid ${envName}: ${value}`);
      expect(result.stderr).not.toContain("Docker image not found");
    },
  );

  it("keeps live plugin tool npm pack tarball paths inside the fixture directory", () => {
    const runner = readFileSync(LIVE_PLUGIN_TOOL_DOCKER_E2E_PATH, "utf8");

    expect(runner).toContain('npm pack --pack-destination "$fixture_dir" --silent');
    expect(runner).toContain("/tmp/openclaw-live-plugin-tool-pack.log");
    expect(runner).toContain("find \"$fixture_dir\" -maxdepth 1 -type f -name '*.tgz' | sort");
    expect(runner).toContain("Expected one packed fixture plugin tarball");
    expect(runner).toContain("openclaw_e2e_dump_logs /tmp/openclaw-live-plugin-tool-pack.log");
    expect(runner).toContain('plugin_tgz="${plugin_tgzs[0]}"');
    expect(runner).not.toContain('plugin_tgz="$fixture_dir/$plugin_pack"');
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
    expect(readFileSync("scripts/lib/docker-e2e-logs.sh", "utf8")).toContain(
      "OPENCLAW_DOCKER_E2E_LOG_PRINT_BYTES",
    );
    expect(runner).toContain(
      "docker_e2e_read_positive_int_env OPENCLAW_DOCKER_E2E_LOG_PRINT_BYTES 65536",
    );
    expect(runner).toContain(
      '-e "OPENCLAW_DOCKER_E2E_LOG_PRINT_BYTES=$OPENCLAW_DOCKER_E2E_LOG_PRINT_BYTES"',
    );
    expect(runner).toContain("docker_e2e_run_logged_print_with_harness \\");
    expect(runner).not.toContain("docker_e2e_run_logged_with_harness plugins-run");
  });

  it("bounds printed Docker E2E logs to the configured tail", () => {
    const workDir = mkdtempSync(join(tmpdir(), "openclaw-docker-e2e-log-print-tail-"));

    try {
      const rootDir = process.cwd();
      const script = `
set -euo pipefail
ROOT_DIR=${shellQuote(rootDir)}
TMPDIR=${shellQuote(workDir)}
export ROOT_DIR TMPDIR
export OPENCLAW_DOCKER_E2E_LOG_PRINT_BYTES=64

source "$ROOT_DIR/scripts/lib/docker-e2e-logs.sh"

output="$(run_logged_print_heartbeat plugins-run 30 bash -c 'printf "DO_NOT_PRINT_OLD_LOG_START"; printf "%0200d" 0; printf "recent container log tail\\\\n"')"
[[ "$output" = *"truncated: showing last 64"* ]]
[[ "$output" = *"recent container log tail"* ]]
[[ "$output" != *"DO_NOT_PRINT_OLD_LOG_START"* ]]
`;

      execFileSync("bash", ["-lc", script], { encoding: "utf8" });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["printed log bytes", "OPENCLAW_DOCKER_E2E_LOG_PRINT_BYTES", "64kb"],
    ["heartbeat termination grace", "OPENCLAW_DOCKER_E2E_HEARTBEAT_TERM_GRACE_SECONDS", "soon"],
  ])("rejects invalid Docker E2E %s before setup", (_label, envName, value) => {
    const workDir = mkdtempSync(join(tmpdir(), "openclaw-docker-e2e-log-invalid-"));

    try {
      const rootDir = process.cwd();
      const script = `
set -euo pipefail
ROOT_DIR=${shellQuote(rootDir)}
TMPDIR=${shellQuote(workDir)}
export ROOT_DIR TMPDIR
export ${envName}=${shellQuote(value)}

source "$ROOT_DIR/scripts/lib/docker-e2e-logs.sh"

run_logged_print_heartbeat plugins-run 30 bash -c 'printf "should not print\\\\n"'
`;

      const result = spawnSync("bash", ["-lc", script], { encoding: "utf8" });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain(`invalid ${envName}: ${value}`);
      expect(result.stdout).toBe("");
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid Docker E2E log heartbeat env before harness setup", () => {
    const workDir = mkdtempSync(join(tmpdir(), "openclaw-docker-e2e-log-heartbeat-invalid-"));

    try {
      const rootDir = process.cwd();
      const script = `
set -euo pipefail
ROOT_DIR=${shellQuote(rootDir)}
TMPDIR=${shellQuote(workDir)}
export ROOT_DIR TMPDIR
export OPENCLAW_DOCKER_E2E_LOG_HEARTBEAT_SECONDS=1e3

source "$ROOT_DIR/scripts/lib/docker-e2e-package.sh"

docker_e2e_run_with_harness() {
  echo "should not run"
}

docker_e2e_run_logged_print_with_harness plugins-run image-name
`;

      const result = spawnSync("bash", ["-lc", script], { encoding: "utf8" });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain("invalid OPENCLAW_DOCKER_E2E_LOG_HEARTBEAT_SECONDS: 1e3");
      expect(result.stdout).toBe("");
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("prints heartbeat progress for long successful Docker E2E log captures", () => {
    const workDir = mkdtempSync(join(tmpdir(), "openclaw-docker-e2e-log-heartbeat-"));

    try {
      const rootDir = process.cwd();
      const script = `
set -euo pipefail
ROOT_DIR=${shellQuote(rootDir)}
TMPDIR=${shellQuote(workDir)}
export ROOT_DIR TMPDIR

source "$ROOT_DIR/scripts/lib/docker-e2e-logs.sh"

printf "captured container log\\n" >"$TMPDIR/run.log"
output="$(docker_e2e_maybe_print_log_heartbeat plugins-run 1 1 "$TMPDIR/run.log")"
[[ "$output" = *"still running plugins-run ("* ]]
[[ "$output" = *"log bytes captured"* ]]
[[ "$output" != *"captured container log"* ]]
`;

      execFileSync("bash", ["-lc", script], { encoding: "utf8" });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("cleans the heartbeat command when the wrapper is terminated", () => {
    const workDir = mkdtempSync(join(tmpdir(), "openclaw-docker-e2e-log-term-cleanup-"));

    try {
      const rootDir = process.cwd();
      const script = `
set -euo pipefail
ROOT_DIR=${shellQuote(rootDir)}
TMPDIR=${shellQuote(workDir)}
export ROOT_DIR TMPDIR
export OPENCLAW_DOCKER_E2E_HEARTBEAT_TERM_GRACE_SECONDS=1

source "$ROOT_DIR/scripts/lib/docker-e2e-logs.sh"

command_pid_file="$TMPDIR/command.pid"
(
  run_logged_print_heartbeat plugins-run 30 bash -c 'trap "exit 0" TERM; printf "%s" "$$" > "$1"; while true; do /bin/sleep 0.05; done' bash "$command_pid_file"
) &
wrapper_pid="$!"
for _ in $(seq 1 100); do
  [ -s "$command_pid_file" ] && break
  /bin/sleep 0.01
done
if [ ! -s "$command_pid_file" ]; then
  kill -TERM "$wrapper_pid" 2>/dev/null || true
  echo "heartbeat command pid was not recorded" >&2
  exit 1
fi
command_pid="$(cat "$command_pid_file")"
kill -TERM "$wrapper_pid"
for _ in $(seq 1 50); do
  if ! kill -0 "$command_pid" 2>/dev/null; then
    wait "$wrapper_pid" 2>/dev/null || true
    exit 0
  fi
  /bin/sleep 0.01
done
kill -TERM "$command_pid" 2>/dev/null || true
kill -TERM "$wrapper_pid" 2>/dev/null || true
echo "heartbeat command still alive after wrapper termination: $command_pid" >&2
exit 1
`;

      execFileSync("bash", ["-lc", script], { encoding: "utf8" });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("cleans harness containers when heartbeat-wrapped Docker runs are terminated", () => {
    const workDir = mkdtempSync(join(tmpdir(), "openclaw-docker-e2e-harness-term-cleanup-"));

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

source "$ROOT_DIR/scripts/lib/docker-e2e-package.sh"

docker() {
  if [[ "$1" == "rm" ]]; then
    shift
    test "$1" = "-f"
    shift
    printf "%s\\n" "$1" >>"$TMPDIR/docker-rm-seen"
    return 0
  fi

  local cidfile=""
  local expect_cidfile=0
  local arg
  for arg in "$@"; do
    if [[ "$expect_cidfile" == "1" ]]; then
      cidfile="$arg"
      expect_cidfile=0
      continue
    fi
    if [[ "$arg" == "--cidfile" ]]; then
      expect_cidfile=1
    fi
  done

  test -n "$cidfile"
  printf "container-term\\n" >"$cidfile"
  printf "started\\n" >"$TMPDIR/docker-started"
  printf "docker running\\n"
  trap 'exit 143' TERM
  while true; do /bin/sleep 0.05; done
}
export -f docker

(
  docker_e2e_run_logged_print_with_harness plugins-run image-name bash -lc true
) &
wrapper_pid="$!"
for _ in $(seq 1 50); do
  [ -s "$TMPDIR/docker-started" ] && break
  /bin/sleep 0.01
  kill -0 "$wrapper_pid" 2>/dev/null || true
done
test -s "$TMPDIR/docker-started"
kill -TERM "$wrapper_pid" 2>/dev/null || true
wait "$wrapper_pid" 2>/dev/null || true
for _ in $(seq 1 50); do
  grep -qx "container-term" "$TMPDIR/docker-rm-seen" 2>/dev/null && break
  /bin/sleep 0.01
done
grep -qx "container-term" "$TMPDIR/docker-rm-seen"
test -z "$(find "$TMPDIR" -maxdepth 1 -name 'openclaw-docker-e2e-container.*' -print)"
`;

      execFileSync("bash", ["-lc", script], { encoding: "utf8" });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("does not delay fast successful Docker E2E log captures until the next heartbeat", () => {
    const workDir = mkdtempSync(join(tmpdir(), "openclaw-docker-e2e-log-fast-heartbeat-"));

    try {
      const rootDir = process.cwd();
      const script = `
set -euo pipefail
ROOT_DIR=${shellQuote(rootDir)}
TMPDIR=${shellQuote(workDir)}
export ROOT_DIR TMPDIR

source "$ROOT_DIR/scripts/lib/docker-e2e-logs.sh"

output="$(run_logged_print_heartbeat plugins-run 30 bash -c 'printf "quick container log\\\\n"')"
[[ "$output" = "quick container log" ]]
`;
      const startedAt = Date.now();

      execFileSync("bash", ["-lc", script], { encoding: "utf8" });

      expect(Date.now() - startedAt).toBeLessThan(5_000);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("normalizes zero-padded Docker E2E log heartbeat intervals", () => {
    const rootDir = process.cwd();
    const script = `
set -euo pipefail
ROOT_DIR=${shellQuote(rootDir)}
export ROOT_DIR

source "$ROOT_DIR/scripts/lib/docker-e2e-logs.sh"

[[ "$(docker_e2e_normalize_positive_int_value 'Docker E2E log heartbeat interval' 08)" = "8" ]]
`;

    execFileSync("bash", ["-lc", script], { encoding: "utf8" });
  });

  it("normalizes zero-padded Docker E2E stats heartbeat intervals", () => {
    const workDir = mkdtempSync(join(tmpdir(), "openclaw-docker-e2e-stats-zero-heartbeat-"));

    try {
      const rootDir = process.cwd();
      const script = `
set -euo pipefail
ROOT_DIR=${shellQuote(rootDir)}
TMPDIR=${shellQuote(workDir)}
export ROOT_DIR TMPDIR

source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"

docker_e2e_docker_cmd() {
  case "$1" in
    inspect) return 0 ;;
    stats) printf '{"MemUsage":"1MiB / 2MiB","CPUPerc":"0.1%%"}\\n'; return 0 ;;
    *) return 0 ;;
  esac
}

sleep() {
  SECONDS=$((SECONDS + \${1%%.*}))
}

kill_checks=0
kill() {
  if [[ "\${1:-}" == "-0" && "\${2:-}" == "sampled-docker-pid" ]]; then
    kill_checks=$((kill_checks + 1))
    [[ "$kill_checks" -le 6 ]]
    return
  fi
  command kill "$@"
}

stats_log="$TMPDIR/stats.log"
run_log="$TMPDIR/run.log"
sampler_log="$TMPDIR/sampler.log"
printf "container output\\n" >"$run_log"

docker_e2e_sample_stats_until_exit demo sampled-docker-pid "$stats_log" "$run_log" "Docker stats" 08 >"$sampler_log" 2>&1
output="$(cat "$sampler_log")"

[[ "$output" =~ Docker\\ stats\\ still\\ running\\ \\(([0-9]+)s\\ elapsed, ]]
heartbeat_elapsed="\${BASH_REMATCH[1]}"
(( heartbeat_elapsed >= 8 ))
[[ "$output" != *"value too great for base"* ]]
[[ -s "$stats_log" ]]
`;

      execFileSync("bash", ["-lc", script], { encoding: "utf8" });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("includes procps in the shared Docker E2E image for process watchdogs", () => {
    const dockerfile = readFileSync("scripts/e2e/Dockerfile", "utf8");

    expect(dockerfile).toContain("procps");
  });

  it("caches package downloads across prepared Docker E2E image builds", () => {
    const dockerfile = readFileSync("scripts/e2e/Dockerfile", "utf8");

    expect(dockerfile).toContain(
      "--mount=type=cache,target=/home/appuser/.npm,uid=1001,gid=1001,sharing=locked",
    );
  });

  it("keeps onboarding Docker E2E resource-guarded", () => {
    const runner = readFileSync(ONBOARD_DOCKER_E2E_PATH, "utf8");

    expect(runner).toContain("OPENCLAW_ONBOARD_MAX_MEMORY_MIB");
    expect(runner).toContain("OPENCLAW_ONBOARD_MAX_CPU_PERCENT");
    expect(runner).toContain(
      'COMMAND_TIMEOUT="${OPENCLAW_ONBOARD_COMMAND_TIMEOUT:-${OPENCLAW_E2E_COMMAND_TIMEOUT:-300s}}"',
    );
    expect(runner).toContain(
      'GATEWAY_WAIT_ATTEMPTS="$(openclaw_e2e_read_positive_int_env OPENCLAW_ONBOARD_GATEWAY_WAIT_ATTEMPTS 20)"',
    );
    expect(runner).toContain(
      'GATEWAY_WAIT_INTERVAL_S="$(docker_e2e_read_nonnegative_decimal_env OPENCLAW_ONBOARD_GATEWAY_WAIT_INTERVAL_S 1)"',
    );
    expect(runner).toContain('-e "OPENCLAW_E2E_COMMAND_TIMEOUT=$COMMAND_TIMEOUT"');
    expect(runner).toContain('-e "OPENCLAW_ONBOARD_GATEWAY_WAIT_ATTEMPTS=$GATEWAY_WAIT_ATTEMPTS"');
    expect(runner).toContain(
      '-e "OPENCLAW_ONBOARD_GATEWAY_WAIT_INTERVAL_S=$GATEWAY_WAIT_INTERVAL_S"',
    );
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
      expect(runner, path).toContain('docker_e2e_print_log "$RUN_LOG"');
      expect(runner, path).not.toContain('cat "$RUN_LOG"');
      expect(runner, path).not.toMatch(/(^|\n)docker run --name "\$CONTAINER_NAME"/u);
      expect(runner, path).not.toMatch(/(^|\n)docker (?:inspect|stats) /u);
      expect(runner, path).toMatch(/cleanup\(\) \{[\s\S]*rm -f "\$RUN_LOG" "\$STATS_LOG"/u);
      expect(runner, path).toContain(`if [ "$run_status" -eq 0 ]; then\n  ${resourceAssertion}`);
      expect(runner, path).toContain(
        `elif [ -s "$STATS_LOG" ]; then\n  if ! ${resourceAssertion}; then`,
      );
      expect(runner, path).toContain("RESOURCE_CEILING_FAILED lane=");
      expect(runner, path).toContain("primary_status=$run_status");
      expect(runner, path).not.toContain(`${resourceAssertion} || true`);
      expect(runner, path).not.toContain(`${resourceAssertion}\n\nexit "$run_status"`);
    }
  });

  it("keeps captured Docker E2E run log replay bounded", () => {
    for (const path of [
      AGENT_BUNDLE_MCP_TOOLS_DOCKER_E2E_PATH,
      COMMITMENTS_SAFETY_DOCKER_E2E_PATH,
      SYSTEM_AGENT_FIRST_RUN_DOCKER_E2E_PATH,
      SYSTEM_AGENT_RESCUE_DOCKER_E2E_PATH,
      PLUGIN_BINDING_COMMAND_ESCAPE_DOCKER_E2E_PATH,
      SESSION_RUNTIME_CONTEXT_DOCKER_E2E_PATH,
    ]) {
      const runner = readFileSync(path, "utf8");

      expect(runner, path).toContain('RUN_LOG="$(mktemp');
      expect(runner, path).toContain('docker_e2e_print_log "$RUN_LOG"');
      expect(runner, path).not.toContain('cat "$RUN_LOG"');
    }

    const pluginBinding = readFileSync(PLUGIN_BINDING_COMMAND_ESCAPE_DOCKER_E2E_PATH, "utf8");
    expect(pluginBinding).toContain("const scanBytes = 65536");
    expect(pluginBinding).toContain("fs.statSync(logPath)");
    expect(pluginBinding).toContain("fs.readSync(fd, buffer, 0, length, stat.size - length)");
    expect(pluginBinding).not.toContain("process.env.OPENCLAW_DOCKER_E2E_LOG_PRINT_BYTES");
    expect(pluginBinding).not.toContain('readFileSync(logPath, "utf8")');
  });

  it("keeps Open WebUI Docker E2E resource-guarded", () => {
    const runner = readFileSync(OPENWEBUI_DOCKER_E2E_PATH, "utf8");

    expect(runner).toContain(
      'validate_positive_int OPENCLAW_OPENWEBUI_PROVIDER_TIMEOUT_SECONDS "$PROVIDER_TIMEOUT_SECONDS"',
    );
    expect(runner).toContain(
      'validate_positive_int OPENCLAW_OPENWEBUI_FETCH_TIMEOUT_MS "$PROBE_FETCH_TIMEOUT_MS"',
    );
    expect(runner).toContain("docker_e2e_read_tcp_port_env OPENCLAW_OPENWEBUI_GATEWAY_PORT 18789");
    expect(runner).toContain("docker_e2e_read_tcp_port_env OPENCLAW_OPENWEBUI_PORT 8080");
    expect(runner).toContain("OPENCLAW_OPENWEBUI_MAX_MEMORY_MIB");
    expect(runner).toContain("OPENCLAW_OPENWEBUI_MAX_CPU_PERCENT");
    expect(runner).toContain('STATS_LOG="$(mktemp');
    expect(runner).toContain('PROBE_LOG="$(mktemp');
    expect(runner).toContain('STATS_STOP_FILE="$(mktemp');
    expect(runner).toContain("sample_openwebui_stats_once()");
    expect(runner).toContain("start_openwebui_stats_sampler()");
    expect(runner).toContain("start_openwebui_stats_sampler\n");
    expect(runner).toContain('for container_name in "$GW_NAME" "$OW_NAME"; do');
    expect(runner).toContain('"$GW_NAME" \\');
    expect(runner).toContain('"$OW_NAME" \\');
    expect(runner).toContain('"$container_name" >>"$STATS_LOG"');
    expect(runner).toContain("assert_openwebui_stats()");
    expect(runner).toContain(
      'node scripts/e2e/lib/docker-stats/assert-resource-ceiling.mjs "$STATS_LOG" "$MAX_MEMORY_MIB" "$MAX_CPU_PERCENT" openwebui',
    );
    expect(runner).toMatch(
      /cleanup\(\) \{[\s\S]*rm -f "\$STATS_STOP_FILE"[\s\S]*wait "\$stats_pid"/u,
    );
    expect(runner).toMatch(/cleanup\(\) \{[\s\S]*rm -f "\$STATS_LOG" "\$PROBE_LOG"/u);
    expect(runner).toContain('node /app/scripts/e2e/openwebui-probe.mjs >"$PROBE_LOG" 2>&1 &');
    expect(runner).toMatch(
      /sample_openwebui_stats_once\nstop_openwebui_stats_samplers\nassert_openwebui_stats\necho "OK"/u,
    );
  });

  it.each([
    ["gateway", "OPENCLAW_OPENWEBUI_GATEWAY_PORT", "1e3"],
    ["webui", "OPENCLAW_OPENWEBUI_PORT", "65536"],
  ])("rejects invalid Open WebUI Docker %s ports before Docker setup", (_label, envName, value) => {
    const result = spawnSync("bash", [OPENWEBUI_DOCKER_E2E_PATH], {
      encoding: "utf8",
      env: {
        ...process.env,
        [envName]: value,
      },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`invalid ${envName}: ${value}`);
    expect(result.stderr).not.toContain("OPENAI_API_KEY is required");
  });

  it.each([
    ["provider", "OPENCLAW_OPENWEBUI_PROVIDER_TIMEOUT_SECONDS", "300s"],
    ["fetch", "OPENCLAW_OPENWEBUI_FETCH_TIMEOUT_MS", "8000ms"],
  ])(
    "rejects invalid Open WebUI Docker %s timeouts before Docker setup",
    (_label, envName, value) => {
      const result = spawnSync("bash", [OPENWEBUI_DOCKER_E2E_PATH], {
        encoding: "utf8",
        env: {
          ...process.env,
          [envName]: value,
        },
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain(`invalid ${envName}: ${value}`);
      expect(result.stderr).not.toContain("OPENAI_API_KEY is required");
    },
  );

  it("accepts decimal Open WebUI Docker numeric inputs with leading zeroes", () => {
    const result = spawnSync("bash", [OPENWEBUI_DOCKER_E2E_PATH], {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_OPENWEBUI_FETCH_TIMEOUT_MS: "09000",
        OPENCLAW_OPENWEBUI_GATEWAY_PORT: "018789",
        OPENCLAW_OPENWEBUI_PORT: "08080",
        OPENCLAW_OPENWEBUI_PROVIDER_TIMEOUT_SECONDS: "08",
      },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("OPENAI_API_KEY is required");
    expect(result.stderr).not.toContain("value too great for base");
  });

  it.each([
    [MCP_CODE_MODE_GATEWAY_DOCKER_E2E_PATH, "OPENCLAW_MCP_CODE_MODE_GATEWAY_PORT", "1e3"],
    [MCP_CODE_MODE_GATEWAY_DOCKER_E2E_PATH, "OPENCLAW_MCP_CODE_MODE_MOCK_PORT", "65536"],
    [MCP_CODE_MODE_GATEWAY_LIVE_DOCKER_E2E_PATH, "OPENCLAW_MCP_CODE_MODE_LIVE_GATEWAY_PORT", "0"],
    [CODEX_MEDIA_PATH_DOCKER_E2E_PATH, "OPENCLAW_CODEX_MEDIA_PATH_PORT", "18790tcp"],
    [OPENAI_CHAT_TOOLS_DOCKER_E2E_PATH, "OPENCLAW_OPENAI_CHAT_TOOLS_PORT", "0"],
    [OPENAI_WEB_SEARCH_MINIMAL_E2E_PATH, "OPENCLAW_OPENAI_WEB_SEARCH_MINIMAL_PORT", "18789tcp"],
  ])("rejects invalid Docker E2E ports before setup", (scriptPath, envName, value) => {
    const result = spawnSync("bash", [scriptPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        [envName]: value,
      },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`invalid ${envName}: ${value}`);
    expect(result.stderr).not.toContain("OPENAI_API_KEY was not available");
  });

  it.each([
    ["timeout", "OPENCLAW_CODEX_MEDIA_PATH_TIMEOUT_SECONDS", "180s"],
    ["log tail cap", "OPENCLAW_CODEX_MEDIA_PATH_LOG_TAIL_MAX_BYTES", "64kb"],
  ])("rejects invalid Codex media path Docker %s before Docker setup", (_label, envName, value) => {
    const result = spawnSync("bash", [CODEX_MEDIA_PATH_DOCKER_E2E_PATH], {
      encoding: "utf8",
      env: {
        ...process.env,
        [envName]: value,
        OPENCLAW_SKIP_DOCKER_BUILD: "1",
      },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`invalid ${envName}: ${value}`);
    expect(result.stderr).not.toContain("Docker image not found");
  });

  it("forwards Codex media path client limits into Docker", () => {
    const runner = readFileSync(CODEX_MEDIA_PATH_DOCKER_E2E_PATH, "utf8");

    expect(runner).toContain(
      'LOG_TAIL_MAX_BYTES="$(docker_e2e_read_positive_int_env OPENCLAW_CODEX_MEDIA_PATH_LOG_TAIL_MAX_BYTES 2097152)"',
    );
    expect(runner).toContain(
      '-e "OPENCLAW_CODEX_MEDIA_PATH_LOG_TAIL_MAX_BYTES=$LOG_TAIL_MAX_BYTES"',
    );
  });

  it.each([
    [MCP_CODE_MODE_GATEWAY_DOCKER_E2E_PATH, "OPENCLAW_MCP_CODE_MODE_CLIENT_TIMEOUT_MS", "1e3"],
    [
      MCP_CODE_MODE_GATEWAY_DOCKER_E2E_PATH,
      "OPENCLAW_MCP_CODE_MODE_CLIENT_BODY_MAX_BYTES",
      "64bytes",
    ],
    [MCP_CODE_MODE_GATEWAY_LIVE_DOCKER_E2E_PATH, "OPENCLAW_MCP_CODE_MODE_CLIENT_TIMEOUT_MS", "1e3"],
    [
      MCP_CODE_MODE_GATEWAY_LIVE_DOCKER_E2E_PATH,
      "OPENCLAW_MCP_CODE_MODE_CLIENT_BODY_MAX_BYTES",
      "64bytes",
    ],
  ])("rejects invalid MCP code-mode client env before setup", (scriptPath, envName, value) => {
    const result = spawnSync("bash", [scriptPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        [envName]: value,
        OPENCLAW_SKIP_DOCKER_BUILD: "1",
      },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`invalid ${envName}: ${value}`);
    expect(result.stderr).not.toContain("Docker image not found");
    expect(result.stderr).not.toContain("OPENAI_API_KEY was not available");
  });

  it.each([MCP_CODE_MODE_GATEWAY_DOCKER_E2E_PATH, MCP_CODE_MODE_GATEWAY_LIVE_DOCKER_E2E_PATH])(
    "forwards MCP code-mode client fetch limits into Docker",
    (scriptPath) => {
      const runner = readFileSync(scriptPath, "utf8");

      expect(runner).toContain(
        'CLIENT_TIMEOUT_MS="$(docker_e2e_read_positive_int_env OPENCLAW_MCP_CODE_MODE_CLIENT_TIMEOUT_MS 300000)"',
      );
      expect(runner).toContain(
        'CLIENT_BODY_MAX_BYTES="$(docker_e2e_read_positive_int_env OPENCLAW_MCP_CODE_MODE_CLIENT_BODY_MAX_BYTES 1048576)"',
      );
      expect(runner).toContain('-e "OPENCLAW_MCP_CODE_MODE_CLIENT_TIMEOUT_MS=$CLIENT_TIMEOUT_MS"');
      expect(runner).toContain(
        '-e "OPENCLAW_MCP_CODE_MODE_CLIENT_BODY_MAX_BYTES=$CLIENT_BODY_MAX_BYTES"',
      );
    },
  );

  it.each([
    ["timeout", "OPENCLAW_OPENAI_CHAT_TOOLS_TIMEOUT_SECONDS", "180s"],
    ["body cap", "OPENCLAW_OPENAI_CHAT_TOOLS_MAX_BODY_BYTES", "64kb"],
  ])("rejects invalid OpenAI chat tools Docker %s before auth setup", (_label, envName, value) => {
    const result = spawnSync("bash", [OPENAI_CHAT_TOOLS_DOCKER_E2E_PATH], {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENAI_API_KEY: "",
        [envName]: value,
      },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`invalid ${envName}: ${value}`);
    expect(result.stderr).not.toContain("OPENAI_API_KEY was not available");
  });

  it("forwards every OpenAI chat tools runtime env knob into Docker", () => {
    const runner = readFileSync(OPENAI_CHAT_TOOLS_DOCKER_E2E_PATH, "utf8");
    const client = readFileSync("scripts/e2e/lib/openai-chat-tools/client.mjs", "utf8");
    const writer = readFileSync("scripts/e2e/lib/openai-chat-tools/write-config.mjs", "utf8");
    const consumed = new Set(
      [...`${client}\n${writer}`.matchAll(/["`](OPENCLAW_OPENAI_CHAT_TOOLS_[A-Z0-9_]+)["`]/gu)].map(
        (match) => match[1],
      ),
    );
    const forwarded = new Set(
      [...runner.matchAll(/-e\s+"(OPENCLAW_OPENAI_CHAT_TOOLS_[A-Z0-9_]+)=/gu)].map(
        (match) => match[1],
      ),
    );
    const missing = [...consumed].filter((envName) => !forwarded.has(envName)).toSorted();

    expect(missing).toEqual([]);
  });

  it("forwards every kitchen-sink RPC runtime env knob into Docker", () => {
    const runner = readFileSync(KITCHEN_SINK_RPC_DOCKER_E2E_PATH, "utf8");
    const walk = readFileSync("scripts/e2e/kitchen-sink-rpc-walk.mjs", "utf8");
    const consumed = new Set(
      [...walk.matchAll(/\b(?:env|process\.env)\.(OPENCLAW_KITCHEN_SINK_[A-Z0-9_]+)/gu)].map(
        (match) => match[1],
      ),
    );
    const forwarded = new Set(
      [...runner.matchAll(/\b(OPENCLAW_KITCHEN_SINK_[A-Z0-9_]+)\b/gu)].map((match) => match[1]),
    );
    const missing = [...consumed].filter((envName) => !forwarded.has(envName)).toSorted();

    expect(missing).toEqual([]);
  });

  it("keeps the kitchen-sink RPC Docker watchdog above the internal walk budgets", () => {
    const runner = readFileSync(KITCHEN_SINK_RPC_DOCKER_E2E_PATH, "utf8");

    expect(runner).toContain(
      'DOCKER_RUN_TIMEOUT="${OPENCLAW_KITCHEN_SINK_RPC_DOCKER_RUN_TIMEOUT:-1500s}"',
    );
  });

  it("bounds kitchen-sink plugin CLI commands inside the Docker sweep", () => {
    const runner = readFileSync(KITCHEN_SINK_PLUGIN_DOCKER_E2E_PATH, "utf8");
    const sweep = readFileSync("scripts/e2e/lib/kitchen-sink-plugin/sweep.sh", "utf8");

    expect(runner).toContain(
      'KITCHEN_SINK_CLI_TIMEOUT="${OPENCLAW_KITCHEN_SINK_PLUGIN_CLI_TIMEOUT:-${KITCHEN_SINK_CLI_TIMEOUT:-180s}}"',
    );
    expect(runner).toContain(
      "docker_e2e_read_positive_int_env OPENCLAW_DOCKER_E2E_LOG_PRINT_BYTES 65536",
    );
    expect(runner).toContain(
      "docker_e2e_read_positive_int_env OPENCLAW_CLAWHUB_FIXTURE_WAIT_ATTEMPTS 600",
    );
    expect(runner).toContain(
      '-e "OPENCLAW_CLAWHUB_FIXTURE_WAIT_ATTEMPTS=$CLAW_HUB_FIXTURE_WAIT_ATTEMPTS"',
    );
    expect(runner).toContain(
      '-e "OPENCLAW_DOCKER_E2E_LOG_PRINT_BYTES=$OPENCLAW_DOCKER_E2E_LOG_PRINT_BYTES"',
    );
    expect(runner).toContain('-e "KITCHEN_SINK_CLI_TIMEOUT=$KITCHEN_SINK_CLI_TIMEOUT"');
    expect(sweep).toContain('KITCHEN_SINK_CLI_TIMEOUT="${KITCHEN_SINK_CLI_TIMEOUT:-180s}"');
    expect(sweep).toContain("run_kitchen_sink_openclaw_logged()");
    expect(sweep).toContain("run_kitchen_sink_openclaw_capture()");
    expect(sweep).toContain(
      'openclaw_e2e_maybe_timeout "$KITCHEN_SINK_CLI_TIMEOUT" node "$OPENCLAW_ENTRY" "$@" >"$log_file" 2>&1',
    );
    expect(sweep).toContain('local log_file="${KITCHEN_SINK_TMP_DIR}/${safe_label}.log"');
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

    const composeRunner = readFileSync(COMPOSE_SETUP_E2E_PATH, "utf8");
    expect(composeRunner).not.toMatch(/(^|\n)\s*docker rm -f "\$CLI_NAME"/u);
    expect(composeRunner).toContain('docker_e2e_docker_cmd rm -f "$CLI_NAME"');

    const packageRunner = readFileSync(DOCKER_PACKAGE_INSTALL_E2E_PATH, "utf8");
    expect(packageRunner).not.toMatch(/(^|\n)\s*docker rm -f "\$CONTAINER_NAME"/u);
    expect(packageRunner).toContain('docker_e2e_docker_cmd rm -f "$CONTAINER_NAME"');
    expect(packageRunner).toContain(
      'DOCKER_RUN_TIMEOUT="${OPENCLAW_DOCKER_PACKAGE_INSTALL_RUN_TIMEOUT:-120s}"',
    );
    expect(packageRunner).toContain(
      'DOCKER_COMMAND_TIMEOUT="$DOCKER_RUN_TIMEOUT" docker_e2e_docker_run_cmd run -d',
    );
    expect(packageRunner).not.toMatch(/(^|\n)docker run -d/u);
    for (const runner of [composeRunner, packageRunner]) {
      expect(runner).toContain(
        'node --import tsx "$ROOT_DIR/scripts/e2e/lib/docker-artifact-proof/write-identities.ts"',
      );
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

  it("proves gateway suspension across a same-container process restart", () => {
    const runner = readFileSync(GATEWAY_NETWORK_DOCKER_E2E_PATH, "utf8");

    expect(runner).toContain("plugins enable admin-http-rpc");
    expect(runner).toContain("/tmp/gateway-network-configured");
    expect(runner).toContain("run_suspension_phase() {");
    expect(runner).toContain("GW_MODE=suspension-$stage-restart");
    expect(runner).toContain("run_suspension_phase pre");
    expect(runner).toContain("run_suspension_phase post");
    expect(runner).toContain("GW_URL=ws://127.0.0.1:$PORT");
    expect(runner).toContain('SUSPENSION_STATE_PATH="/tmp/gateway-network-suspension.json"');
    expect(runner).toContain('container_id="$(docker_e2e_docker_cmd inspect');
    expect(runner).toContain('docker_e2e_docker_cmd stop "$GW_NAME"');
    expect(runner).toContain('docker_e2e_docker_cmd start "$GW_NAME"');
    expect(runner).toContain('if [[ "$restarted_container_id" != "$container_id" ]]');
    expect(runner).toContain("openclaw_e2e_probe_http http://127.0.0.1:$PORT/readyz ok 400");
    expect(runner).toContain('run_logged_print "gateway-network-suspension-$stage"');
    expect(runner).toContain('"phase":"container-restart","durationMs":%d');
  });

  it.each([
    ["connect", "OPENCLAW_GATEWAY_NETWORK_CLIENT_CONNECT_TIMEOUT_MS", "100ms"],
    ["ready", "OPENCLAW_GATEWAY_NETWORK_CONNECT_READY_TIMEOUT_MS", "1e3"],
  ])(
    "rejects invalid gateway network client %s timeout before Docker setup",
    (_label, envName, value) => {
      const result = spawnSync("bash", [GATEWAY_NETWORK_DOCKER_E2E_PATH], {
        encoding: "utf8",
        env: {
          ...process.env,
          [envName]: value,
          OPENCLAW_SKIP_DOCKER_BUILD: "1",
        },
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain(`invalid ${envName}: ${value}`);
      expect(result.stderr).not.toContain("Docker image not found");
    },
  );

  it("forwards gateway network client timeout env into the Docker client", () => {
    const runner = readFileSync(GATEWAY_NETWORK_DOCKER_E2E_PATH, "utf8");

    expect(runner).toContain(
      "docker_e2e_read_positive_int_env OPENCLAW_GATEWAY_NETWORK_CLIENT_CONNECT_TIMEOUT_MS 80000",
    );
    expect(runner).toContain(
      "docker_e2e_read_positive_int_env OPENCLAW_GATEWAY_NETWORK_CONNECT_READY_TIMEOUT_MS 80000",
    );
    expect(runner).toContain(
      '-e "OPENCLAW_GATEWAY_NETWORK_CLIENT_CONNECT_TIMEOUT_MS=$CLIENT_CONNECT_TIMEOUT_MS"',
    );
    expect(runner).toContain(
      '-e "OPENCLAW_GATEWAY_NETWORK_CONNECT_READY_TIMEOUT_MS=$CONNECT_READY_TIMEOUT_MS"',
    );
    expect(runner).toContain('"${CLIENT_LIMIT_ENV_ARGS[@]}"');
  });

  it("requires TCP readiness for the gateway network runner", () => {
    const runner = readFileSync(GATEWAY_NETWORK_DOCKER_E2E_PATH, "utf8");

    expect(runner).toContain("openclaw_e2e_probe_tcp 127.0.0.1 $PORT");
    expect(runner).not.toMatch(/openclaw_e2e_probe_tcp[^\n]*\|\|[^\n]*gateway-net-e2e\.log/u);
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

    expect(helper).toContain("--allow-unreleased-changelog");
    expect(helper).toContain(
      '-v "$ROOT_DIR/scripts/windows-cmd-helpers.mjs:/app/scripts/windows-cmd-helpers.mjs:ro"',
    );
    expect(helper).toContain('-v "$ROOT_DIR/test/e2e/qa-lab:/app/test/e2e/qa-lab:ro"');
    expect(helper).toContain('-v "$ROOT_DIR/test/helpers:/app/test/helpers:ro"');
  });

  it("preserves pnpm lookup paths for scheduled Docker child lanes", () => {
    const scheduler = readFileSync(DOCKER_ALL_SCHEDULER_PATH, "utf8");

    expect(scheduler).toContain("--allow-unreleased-changelog");
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
      '"OPENCLAW_INSTALL_TAG=beta OPENCLAW_E2E_MODELS=openai OPENCLAW_INSTALL_E2E_IMAGE=openclaw-install-e2e-openai:local OPENCLAW_INSTALL_E2E_AGENT_TOOL_SMOKE=0 OPENCLAW_INSTALL_E2E_OPENAI_MODEL=openai/gpt-5.4-mini OPENCLAW_INSTALL_E2E_AGENT_TURN_TIMEOUT_SECONDS=120 OPENCLAW_INSTALL_E2E_OPENAI_PROVIDER_TIMEOUT_SECONDS=120"',
    );
    expect(scenarios).toContain(
      '"OPENCLAW_INSTALL_TAG=beta OPENCLAW_E2E_MODELS=anthropic OPENCLAW_INSTALL_E2E_IMAGE=openclaw-install-e2e-anthropic:local"',
    );
    expect(scenarios).toContain('"test-install-sh-e2e-docker.sh"');
    expect(scenarios).not.toContain("pnpm test:install:e2e");
    expect(scenarios).toContain(
      '"OPENCLAW_OPENWEBUI_MODEL=openai/gpt-5.4-mini OPENCLAW_OPENWEBUI_PROVIDER_TIMEOUT_SECONDS=300 OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:openwebui"',
    );
    expect(scenarios).not.toContain("OPENWEBUI_SMOKE_MODE=models");
    expect(openWebUiRunner).toContain(
      'SMOKE_MODE="${OPENWEBUI_SMOKE_MODE:-${OPENCLAW_OPENWEBUI_SMOKE_MODE:-chat}}"',
    );
    expect(openWebUiRunner).toContain('-e "OPENWEBUI_SMOKE_MODE=$SMOKE_MODE"');
  });

  it("times and parallelizes release installer E2E agent turns after gateway startup", () => {
    const runner = readFileSync(INSTALL_E2E_RUNNER_PATH, "utf8");
    const wrapper = readFileSync("scripts/test-install-sh-e2e-docker.sh", "utf8");

    expect(runner).toContain(
      'AGENT_TURNS_PARALLEL="$(read_boolean_env OPENCLAW_INSTALL_E2E_AGENT_TURNS_PARALLEL 1)"',
    );
    expect(runner).toContain(
      'AGENT_TOOL_SMOKE="$(read_boolean_env OPENCLAW_INSTALL_E2E_AGENT_TOOL_SMOKE 1)"',
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
    expect(wrapper).toContain(
      "docker_e2e_read_positive_int_env OPENCLAW_INSTALL_E2E_AGENT_TURN_TIMEOUT_SECONDS 300",
    );
    expect(wrapper).toContain(
      'docker_e2e_read_positive_int_env OPENCLAW_INSTALL_E2E_OPENAI_PROVIDER_TIMEOUT_SECONDS "$AGENT_TURN_TIMEOUT_SECONDS"',
    );
    expect(wrapper).toContain(
      '-e OPENCLAW_INSTALL_E2E_AGENT_TURN_TIMEOUT_SECONDS="$AGENT_TURN_TIMEOUT_SECONDS"',
    );
    expect(wrapper).toContain("OPENCLAW_INSTALL_E2E_PROFILE_FILE");
    expect(wrapper).toContain("OPENCLAW_PROFILE_FILE");
    expect(wrapper).toContain("OPENCLAW_TESTBOX_PROFILE_FILE");
    expect(wrapper).toContain("read_profile_env_value");
    expect(wrapper).toContain('source "$PROFILE_FILE"');
    expect(wrapper).not.toContain("set -a");
    expect(wrapper).toContain('export "$key"');
    expect(wrapper).toContain("Profile file: $PROFILE_STATUS");
    expect(runner).toContain("OPENCLAW_INSTALL_E2E_OPENAI_MODEL");
    expect(runner).toContain("OPENCLAW_INSTALL_E2E_OPENAI_PROVIDER_TIMEOUT_SECONDS");
    expect(runner).toContain(
      'AGENT_TURN_TIMEOUT_SECONDS="$(read_positive_int_env OPENCLAW_INSTALL_E2E_AGENT_TURN_TIMEOUT_SECONDS 300)"',
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
    expect(runner).toContain('printf "%s\\n" "\\$!" >"$GATEWAY_PID_FILE"');
    expect(runner).toContain('printf "ActiveState=active\\nSubState=running');
    expect(runner).toContain('status.service?.runtime?.status !== "running"');
    expect(runner).toContain("FAIL: gateway service was not running before update");
    expect(runner).toContain("OPENCLAW_NO_RESPAWN=1");
    expect(runner).toContain("is-enabled)");
    expect(runner).toContain("/healthz");
    expect(runner).toContain("FAIL: gateway install failed before update");
    expect(runner).not.toContain('gateway-install.err" || true');
    expect(runner).not.toContain("WARNING: Gateway status probe failed");
  });

  it("keeps a stalled multi-node health request inside the probe deadline", () => {
    const runner = readFileSync(MULTI_NODE_UPDATE_DOCKER_E2E_PATH, "utf8");
    const startMarker = "if PORT=18789 node <<NODE\n";
    const endMarker = "\nNODE\n  then";
    const start = runner.indexOf(startMarker);
    const end = runner.indexOf(endMarker, start + startMarker.length);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const probe = runner.slice(start + startMarker.length, end);
    const workDir = tempDirs.make("openclaw-multi-node-health-timeout-");
    const preloadPath = join(workDir, "stalling-fetch.mjs");

    writeFileSync(
      preloadPath,
      [
        "// Advance the deadline when the request aborts without waiting 30 wall-clock seconds.",
        "const realSetTimeout = globalThis.setTimeout;",
        "let now = 0;",
        "Date.now = () => now;",
        "Object.defineProperty(AbortSignal, 'timeout', { value(delayMs) {",
        "  const controller = new AbortController();",
        "  realSetTimeout(() => {",
        "    now += delayMs;",
        "    controller.abort(new DOMException('health deadline elapsed', 'TimeoutError'));",
        "  }, 0);",
        "  return controller.signal;",
        "} });",
        "globalThis.fetch = async (_url, init = {}) => await new Promise((_resolve, reject) => {",
        "  init.signal.addEventListener('abort', () => {",
        "    process.stderr.write('hung fetch aborted\\n');",
        "    reject(init.signal.reason);",
        "  }, { once: true });",
        "});",
      ].join("\n"),
    );

    const result = spawnSync(
      process.execPath,
      ["--import", pathToFileURL(preloadPath).href, "--input-type=module", "--eval", probe],
      {
        encoding: "utf8",
        env: { ...process.env, PORT: "18789" },
        timeout: 5_000,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr.match(/hung fetch aborted/gu)).toHaveLength(1);
    expect(result.stderr).toContain("health deadline elapsed");
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
    const doctorLoginctlShim = readFileSync(DOCTOR_SWITCH_LOGINCTL_SHIM_PATH, "utf8");
    const doctorSystemctlShim = readFileSync(DOCTOR_SWITCH_SYSTEMCTL_SHIM_PATH, "utf8");
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
    expect(doctorScenario).toContain("cp scripts/e2e/lib/doctor-install-switch/shims/systemctl");
    expect(doctorScenario).toContain("cp scripts/e2e/lib/doctor-install-switch/shims/loginctl");
    expect(doctorLoginctlShim).toContain("Linger=yes");
    expect(doctorSystemctlShim).toContain("ActiveState=inactive");
    expect(doctorSystemctlShim).toContain('unit_path="$HOME/.config/systemd/user/${unit}"');
    expect(doctorScenario).toContain("OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR=1");
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
    const runner = readFileSync(DOCTOR_SWITCH_DOCKER_E2E_PATH, "utf8");
    const scenario = readFileSync(DOCTOR_SWITCH_SCENARIO_PATH, "utf8");

    expect(runner).toContain('NPM_INSTALL_TIMEOUT="${OPENCLAW_E2E_NPM_INSTALL_TIMEOUT:-600s}"');
    expect(runner).toContain(
      'COMMAND_TIMEOUT="${OPENCLAW_DOCKER_DOCTOR_SWITCH_COMMAND_TIMEOUT:-900s}"',
    );
    expect(runner).toContain('-e "OPENCLAW_E2E_NPM_INSTALL_TIMEOUT=$NPM_INSTALL_TIMEOUT"');
    expect(runner).toContain('-e "OPENCLAW_DOCKER_DOCTOR_SWITCH_COMMAND_TIMEOUT=$COMMAND_TIMEOUT"');
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

  it("bounds doctor install switch command log diagnostics", () => {
    const scenario = readFileSync(DOCTOR_SWITCH_SCENARIO_PATH, "utf8");

    expect(scenario).toContain('openclaw_e2e_print_log "$npm_log"');
    expect(scenario).toContain('openclaw_e2e_print_log "$install_log"');
    expect(scenario).toContain('openclaw_e2e_print_log "$doctor_log"');
    expect(scenario).toContain('openclaw_e2e_print_log "$reinstall_log"');
    expect(scenario).toContain('openclaw_e2e_print_log "$env_repair_log"');
    expect(scenario).toContain('openclaw_e2e_print_log "$clear_log"');
    expect(scenario).not.toContain('cat "$npm_log"');
    expect(scenario).not.toContain('cat "$install_log"');
    expect(scenario).not.toContain('cat "$doctor_log"');
    expect(scenario).not.toContain('cat "$reinstall_log"');
    expect(scenario).not.toContain('cat "$env_repair_log"');
    expect(scenario).not.toContain('cat "$clear_log"');
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
    const forwardedRuntimeEnv = [
      "OPENCLAW_BUNDLED_PLUGIN_LIST_TIMEOUT_MS",
      "OPENCLAW_BUNDLED_PLUGIN_LIST_MAX_BUFFER_BYTES",
      "OPENCLAW_BUNDLED_PLUGIN_RUNTIME_OUTPUT_CHARS",
      "OPENCLAW_BUNDLED_PLUGIN_RUNTIME_LOG_SCAN_BYTES",
      "OPENCLAW_BUNDLED_PLUGIN_RUNTIME_GATEWAY_LOG_BYTES",
      "OPENCLAW_BUNDLED_PLUGIN_RUNTIME_READY_MS",
      "OPENCLAW_BUNDLED_PLUGIN_RUNTIME_RPC_MS",
      "OPENCLAW_BUNDLED_PLUGIN_RUNTIME_RPC_READY_MS",
      "OPENCLAW_BUNDLED_PLUGIN_RUNTIME_COMMAND_MS",
      "OPENCLAW_BUNDLED_PLUGIN_RUNTIME_HTTP_MS",
      "OPENCLAW_BUNDLED_PLUGIN_RUNTIME_TEARDOWN_GRACE_MS",
      "OPENCLAW_BUNDLED_PLUGIN_RUNTIME_TEARDOWN_KILL_GRACE_MS",
      "OPENCLAW_BUNDLED_PLUGIN_RUNTIME_WATCHDOG_MS",
    ] as const;

    expect(runner).toContain("OPENCLAW_BUNDLED_PLUGIN_SWEEP_TOTAL");
    expect(runner).toContain("OPENCLAW_BUNDLED_PLUGIN_SWEEP_INDEX");
    expect(runner).toContain("OPENCLAW_BUNDLED_PLUGIN_SWEEP_COMMAND_TIMEOUT");
    for (const envName of forwardedRuntimeEnv) {
      expect(runner, `${envName} forwarded by Docker wrapper`).toContain(envName);
      expect(probe + runtimeSmoke, `${envName} consumed by probe/runtime smoke`).toContain(envName);
    }
    expect(runner).toContain("OPENCLAW_PLUGIN_LIFECYCLE_TRACE");
    for (const [envName, fallback] of [
      ["OPENCLAW_BUNDLED_PLUGIN_LIST_TIMEOUT_MS", "30000"],
      ["OPENCLAW_BUNDLED_PLUGIN_LIST_MAX_BUFFER_BYTES", "4194304"],
      ["OPENCLAW_BUNDLED_PLUGIN_RUNTIME_OUTPUT_CHARS", "1048576"],
      ["OPENCLAW_BUNDLED_PLUGIN_RUNTIME_LOG_SCAN_BYTES", "262144"],
      ["OPENCLAW_BUNDLED_PLUGIN_RUNTIME_GATEWAY_LOG_BYTES", "16777216"],
      ["OPENCLAW_BUNDLED_PLUGIN_RUNTIME_READY_MS", "900000"],
      ["OPENCLAW_BUNDLED_PLUGIN_RUNTIME_RPC_MS", "60000"],
      ["OPENCLAW_BUNDLED_PLUGIN_RUNTIME_RPC_READY_MS", "210000"],
      ["OPENCLAW_BUNDLED_PLUGIN_RUNTIME_WATCHDOG_MS", "1000"],
      ["OPENCLAW_BUNDLED_PLUGIN_RUNTIME_COMMAND_MS", "120000"],
      ["OPENCLAW_BUNDLED_PLUGIN_RUNTIME_HTTP_MS", "5000"],
      ["OPENCLAW_BUNDLED_PLUGIN_RUNTIME_TEARDOWN_GRACE_MS", "10000"],
      ["OPENCLAW_BUNDLED_PLUGIN_RUNTIME_TEARDOWN_KILL_GRACE_MS", "1000"],
    ] as const) {
      expect(runner, `${envName} host validation`).toContain(
        `docker_e2e_read_positive_int_env ${envName} ${fallback}`,
      );
      expect(runner, `${envName} Docker forwarding`).toContain(`-e "${envName}=`);
    }
    expect(runner).toContain(
      "docker_e2e_read_tcp_port_env OPENCLAW_BUNDLED_PLUGIN_RUNTIME_PORT_BASE 19000",
    );
    expect(runner).toContain('-e "OPENCLAW_BUNDLED_PLUGIN_RUNTIME_PORT_BASE=$RUNTIME_PORT_BASE"');
    expect(runner).toContain("scripts/e2e/lib/bundled-plugin-install-uninstall/sweep.sh");
    expect(runner).toContain('tee "$RUN_LOG"');
    expect(runner).not.toContain('cat "$RUN_LOG"');
    expect(probe).toContain('"openclaw.plugin.json"');
    expect(runtimeSmoke).toContain(
      'readPositiveIntEnv("OPENCLAW_BUNDLED_PLUGIN_RUNTIME_READY_MS", 900000)',
    );
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

  it.each([
    ["list timeout", "OPENCLAW_BUNDLED_PLUGIN_LIST_TIMEOUT_MS", "100ms"],
    ["runtime port base", "OPENCLAW_BUNDLED_PLUGIN_RUNTIME_PORT_BASE", "99999"],
    ["runtime log scan", "OPENCLAW_BUNDLED_PLUGIN_RUNTIME_LOG_SCAN_BYTES", "64bytes"],
    ["runtime command timeout", "OPENCLAW_BUNDLED_PLUGIN_RUNTIME_COMMAND_MS", "soon"],
    ["runtime teardown grace", "OPENCLAW_BUNDLED_PLUGIN_RUNTIME_TEARDOWN_GRACE_MS", "0"],
  ])(
    "rejects invalid bundled plugin Docker %s values before Docker setup",
    (_label, envName, value) => {
      const result = spawnSync("bash", [BUNDLED_PLUGIN_INSTALL_UNINSTALL_E2E_PATH], {
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_SKIP_DOCKER_BUILD: "1",
          [envName]: value,
        },
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain(`invalid ${envName}: ${value}`);
      expect(result.stderr).not.toContain("Docker image not found");
    },
  );

  it("passes installer tag env to bash, not curl", () => {
    const runner = readFileSync(INSTALL_E2E_RUNNER_PATH, "utf8");

    expect(runner).toContain('OPENCLAW_BETA=1 bash "$installer"');
    expect(runner).toContain('OPENCLAW_VERSION="$INSTALL_TAG" bash "$installer"');
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

  it("bounds installer E2E session transcript tool scans", () => {
    const runner = readFileSync(INSTALL_E2E_RUNNER_PATH, "utf8");
    const start = runner.indexOf("assert_session_used_tools() {");
    const end = runner.indexOf("\nsession_jsonl_path()", start);
    const helper = runner.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(helper).toContain("OPENCLAW_INSTALL_E2E_SESSION_SCAN_BYTES");
    expect(helper).toContain("OPENCLAW_INSTALL_E2E_SESSION_LINE_BYTES");
    expect(helper).toContain("OPENCLAW_INSTALL_E2E_SESSION_SCAN_DEPTH");
    expect(helper).toContain("OPENCLAW_INSTALL_E2E_SESSION_SCAN_NODES");
    expect(helper).toContain("fs.createReadStream");
    expect(helper).toContain("Buffer.concat");
    expect(helper).toContain("skippedOversizedLines");
    expect(helper).not.toContain('require("node:readline")');
    expect(helper).not.toContain("fs.readFileSync");
    expect(helper).not.toContain('.split("\\n")');
  });

  it("exports SQLite-backed installer E2E sessions before scanning tools", () => {
    const runner = readFileSync(INSTALL_E2E_RUNNER_PATH, "utf8");
    const start = runner.indexOf("assert_session_used_tools() {");
    const end = runner.indexOf("\nsession_jsonl_path()", start);
    const helper = runner.slice(start, end);

    expect(helper).toContain('jsonl="$(session_jsonl_path "$profile" "$session_id")"');
    expect(helper).toContain('if [[ ! -f "$jsonl" ]]');
    expect(helper).toContain('openclaw --profile "$profile" sessions export-trajectory');
    expect(helper).toContain('--session-key "agent:main:explicit:${session_id}"');
    expect(helper).toContain('--workspace "$export_workspace"');
    expect(helper).toContain(
      'jsonl="$export_workspace/.openclaw/trajectory-exports/scan/events.jsonl"',
    );
    expect(helper).toContain('rm -rf "$export_workspace"');
  });

  it("keeps OpenAI web search smoke on one gateway agent connection", () => {
    const runner = readFileSync(OPENAI_WEB_SEARCH_MINIMAL_E2E_PATH, "utf8");
    const scenario = readFileSync(OPENAI_WEB_SEARCH_MINIMAL_SCENARIO_PATH, "utf8");
    const client = readFileSync(OPENAI_WEB_SEARCH_MINIMAL_CLIENT_PATH, "utf8");

    expect(runner).toContain(
      'PORT="$(docker_e2e_read_tcp_port_env OPENCLAW_OPENAI_WEB_SEARCH_MINIMAL_PORT 18789)"',
    );
    expect(runner).toContain('MOCK_PORT="443"');
    expect(runner).not.toContain("OPENCLAW_OPENAI_WEB_SEARCH_MINIMAL_MOCK_PORT");
    expect(runner).toContain('-e "PORT=$PORT"');
    expect(runner).toContain('-e "MOCK_PORT=$MOCK_PORT"');
    expect(runner).toContain("scripts/e2e/lib/openai-web-search-minimal/scenario.sh");
    expect(scenario).toContain('export NODE_EXTRA_CA_CERTS="$TLS_CA_CERT"');
    expect(scenario).toContain('MOCK_TLS_CERT="$TLS_SERVER_CERT"');
    expect(scenario).toContain('MOCK_TLS_KEY="$TLS_SERVER_KEY"');
    expect(scenario).toContain(
      'openclaw_e2e_wait_mock_openai "$MOCK_PORT" 80 400 "https://api.openai.com:$MOCK_PORT"',
    );
    expect(scenario).toContain("scripts/e2e/lib/openai-web-search-minimal/client.mjs");
    expect(client).toContain("const callGateway = await loadCallGateway();");
    expect(client).toContain('method: "agent"');
    expect(client).toContain("expectFinal: true");
    expect(client).toContain('scopes: ["operator.write"]');
    expect(client).not.toContain('"agent.wait"');
  });

  it("cleans OpenAI web search smoke processes through the E2E helpers", () => {
    const scenario = readFileSync(OPENAI_WEB_SEARCH_MINIMAL_SCENARIO_PATH, "utf8");

    expect(scenario).toContain('openclaw_e2e_terminate_gateways "${gateway_pid:-}"');
    expect(scenario).toContain('openclaw_e2e_stop_process "${mock_pid:-}"');
    expect(scenario).toContain(
      'gateway_pid="$(openclaw_e2e_start_gateway "$entry" "$PORT" "$GATEWAY_LOG")"',
    );
    expect(scenario).toContain(
      'openclaw_e2e_wait_mock_openai "$MOCK_PORT" 80 400 "https://api.openai.com:$MOCK_PORT"',
    );
    expect(scenario).toContain(
      'openclaw_e2e_wait_gateway_ready "$gateway_pid" "$GATEWAY_LOG" 360 "$PORT"',
    );
    expect(scenario).not.toContain("fetch('http://127.0.0.1:${MOCK_PORT}/health')");
    expect(scenario).not.toContain('kill "$gateway_pid"');
    expect(scenario).not.toContain('kill "$mock_pid"');
    expect(scenario).not.toContain('node "$entry" gateway --port "$PORT"');
  });

  it("keeps OpenAI web search smoke logs isolated per run", () => {
    const scenario = readFileSync(OPENAI_WEB_SEARCH_MINIMAL_SCENARIO_PATH, "utf8");

    expect(scenario).toContain(
      'scenario_tmp="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-openai-web-search-minimal.XXXXXX")"',
    );
    expect(scenario).toContain('MOCK_REQUEST_LOG="$scenario_tmp/requests.jsonl"');
    expect(scenario).toContain('GATEWAY_LOG="$scenario_tmp/gateway.log"');
    expect(scenario).toContain('MOCK_LOG="$scenario_tmp/mock.log"');
    expect(scenario).toContain('CLIENT_SUCCESS_LOG="$scenario_tmp/client-success.log"');
    expect(scenario).toContain('CLIENT_REJECT_LOG="$scenario_tmp/client-reject.log"');
    expect(scenario).toContain('openclaw_e2e_print_log "$file"');
    expect(scenario).toContain('rm -rf "$scenario_tmp"');
    expect(scenario).not.toContain("sed -n '1,260p'");
    expect(scenario).not.toContain("/tmp/openclaw-openai-web-search-minimal-requests.jsonl");
    expect(scenario).not.toContain("/tmp/openclaw-openai-web-search-minimal-client-success.log");
    expect(scenario).not.toContain("/tmp/openclaw-openai-web-search-minimal-client-reject.log");
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
    expect(runner).toContain("OPENCLAW_PLUGINS_E2E_LIVE_NPM_REGISTRY");
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
    const runner = readFileSync(PLUGINS_DOCKER_E2E_PATH, "utf8");
    const sweep = readFileSync(PLUGINS_DOCKER_SWEEP_PATH, "utf8");
    const marketplace = readFileSync(PLUGINS_DOCKER_MARKETPLACE_PATH, "utf8");
    const clawhub = readFileSync(PLUGINS_DOCKER_CLAWHUB_PATH, "utf8");
    const assertions = readFileSync(PLUGINS_DOCKER_ASSERTIONS_PATH, "utf8");
    const npmRegistry = readFileSync(PLUGINS_DOCKER_NPM_REGISTRY_PATH, "utf8");

    expect(sweep).toContain('OPENCLAW_PLUGINS_CLI_TIMEOUT="${OPENCLAW_PLUGINS_CLI_TIMEOUT:-180s}"');
    expect(runner).toContain('PLUGINS_CLI_TIMEOUT="${OPENCLAW_PLUGINS_CLI_TIMEOUT:-180s}"');
    expect(runner).toContain('-e "OPENCLAW_PLUGINS_CLI_TIMEOUT=$PLUGINS_CLI_TIMEOUT"');
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

    expect(sweep).toContain('plugins install "$dir_plugin" --force');
    expect(sweep).toContain("plugins update demo-plugin-dir");
    expect(assertions).toContain('Skipping "demo-plugin-dir" (source: path).');

    expect(sweep).toContain("start_npm_fixture_registry");
    expect(sweep).toContain('plugins install "npm:@openclaw/demo-plugin-npm@0.0.1" --force');
    expect(sweep).toContain("plugins update demo-plugin-npm");
    expect(assertions).toContain("demo-plugin-npm is up to date (0.0.1).");
    expect(npmRegistry).toContain('"dist-tags": { latest: entry.latestVersion }');
    expect(npmRegistry).toContain("existing.latestVersion = version");
    expect(npmRegistry).toContain("packageArgs.length % 3");

    expect(sweep).toContain('plugins install "git:$git_update_repo_url@main" --force');
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
