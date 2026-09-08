// Docker Build Helper tests cover docker build helper script behavior.
import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { mainLanes } from "../../scripts/lib/docker-e2e-scenarios.mts";
import { buildSystemdUnit } from "../../src/daemon/systemd-unit.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const HELPER_PATH = "scripts/lib/docker-build.sh";
const DOCKER_ALL_SCHEDULER_PATH = "scripts/test-docker-all.mts";
const DOCKER_E2E_PACKAGE_HELPER_PATH = "scripts/lib/docker-e2e-package.sh";
const DOCKER_E2E_IMAGE_HELPER_PATH = "scripts/lib/docker-e2e-image.sh";
const DOCKER_E2E_SCENARIOS_PATH = "scripts/lib/docker-e2e-scenarios.mts";
const OPENCLAW_E2E_INSTANCE_HELPER_PATH = "scripts/lib/openclaw-e2e-instance.sh";
const COMPOSE_SETUP_E2E_PATH = "scripts/e2e/compose-setup.sh";
const CLI_INSTALLER_DISTRIBUTION_E2E_PATH = "scripts/e2e/cli-installer-distribution-docker.sh";
const DOCKER_PACKAGE_INSTALL_E2E_PATH = "scripts/e2e/docker-package-install.sh";
// Preserve the published 2026.8.1 query; the systemd fixture tests use the current reader.
const SURVIVOR_SERVICE_SHOW_ARGS = [
  "--user",
  "show",
  "openclaw-gateway.service",
  "--property",
  "Id,ActiveState,SubState,Result,NRestarts,StartLimitBurst,MainPID,ExecMainStatus,ExecMainCode,KillMode,TasksCurrent,MemoryCurrent",
];
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
const AGENTS_DELETE_SHARED_WORKSPACE_DOCKER_E2E_PATH =
  "scripts/e2e/agents-delete-shared-workspace-docker.sh";
const OPENWEBUI_DOCKER_E2E_PATH = "scripts/e2e/openwebui-docker.sh";
const ONBOARD_DOCKER_E2E_PATH = "scripts/e2e/onboard-docker.sh";
const ONBOARD_SCENARIO_PATH = "scripts/e2e/lib/onboard/scenario.sh";
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
const CODEX_NPM_PLUGIN_LIVE_FOLLOWTHROUGH_PATH =
  "scripts/e2e/lib/codex-npm-plugin-live/followthrough-turn.mjs";
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
const KITCHEN_SINK_PLUGIN_DOCKER_E2E_PATH = "scripts/e2e/kitchen-sink-plugin-docker.sh";
const PLUGINS_DOCKER_SWEEP_PATH = "scripts/e2e/lib/plugins/sweep.sh";
const PLUGINS_DOCKER_MARKETPLACE_PATH = "scripts/e2e/lib/plugins/marketplace.sh";
const PLUGINS_DOCKER_CLAWHUB_PATH = "scripts/e2e/lib/plugins/clawhub.sh";
const PLUGINS_DOCKER_ASSERTIONS_PATH = "scripts/e2e/lib/plugins/assertions.mjs";
const PLUGINS_DOCKER_NPM_REGISTRY_PATH = "scripts/e2e/lib/plugins/npm-registry-server.mjs";
const PLUGIN_UPDATE_DOCKER_E2E_PATH = "scripts/e2e/plugin-update-unchanged-docker.sh";
const PLUGIN_UPDATE_CORRUPT_DOCKER_E2E_PATH = "scripts/e2e/update-corrupt-plugin-docker.sh";
const PLUGIN_UPDATE_SCENARIO_PATH = "scripts/e2e/lib/plugin-update/unchanged-scenario.sh";
const PLUGIN_UPDATE_CORRUPT_SCENARIO_PATH =
  "scripts/e2e/lib/plugin-update/corrupt-update-scenario.sh";
const PLUGIN_UPDATE_PROBE_PATH = "scripts/e2e/lib/plugin-update/probe.mjs";
const PLUGIN_LIFECYCLE_MATRIX_DOCKER_E2E_PATH = "scripts/e2e/plugin-lifecycle-matrix-docker.sh";
const DOCTOR_SWITCH_DOCKER_E2E_PATH = "scripts/e2e/doctor-install-switch-docker.sh";
const DOCTOR_SWITCH_SCENARIO_PATH = "scripts/e2e/lib/doctor-install-switch/scenario.sh";
const DOCTOR_SWITCH_BUSCTL_SHIM_PATH = "scripts/e2e/lib/doctor-install-switch/shims/busctl";
const DOCTOR_SWITCH_SYSTEMD_EXEC_START_PATH =
  "scripts/e2e/lib/doctor-install-switch/shims/systemd-exec-start.mjs";
const DOCTOR_SWITCH_LOGINCTL_SHIM_PATH = "scripts/e2e/lib/doctor-install-switch/shims/loginctl";
const DOCTOR_SWITCH_SYSTEMCTL_SHIM_PATH = "scripts/e2e/lib/doctor-install-switch/shims/systemctl";
const PACKAGE_COMPAT_PATH = "scripts/e2e/lib/package-compat.mjs";
const UPGRADE_SURVIVOR_DOCKER_E2E_PATH = "scripts/e2e/upgrade-survivor-docker.sh";
const UPGRADE_SURVIVOR_DIAGNOSTICS_PATH = "scripts/e2e/lib/upgrade-survivor/diagnostics.mjs";
const UPGRADE_SURVIVOR_DIAGNOSTICS_PUBLISH_PATH = "scripts/upgrade-survivor-diagnostics.mjs";
const PREPUBLISH_PLUGIN_REGISTRY_HELPER_PATH = "scripts/e2e/lib/prepublish-plugin-registry.sh";
const UPDATE_CHANNEL_SWITCH_DOCKER_E2E_PATH = "scripts/e2e/update-channel-switch-docker.sh";
const UPDATE_CHANNEL_SWITCH_ASSERTIONS_PATH =
  "scripts/e2e/lib/update-channel-switch/assertions.mjs";
const RELEASE_UPGRADE_USER_JOURNEY_SCENARIO_PATH =
  "scripts/e2e/lib/release-upgrade-user-journey/scenario.sh";
const RELEASE_TYPED_ONBOARDING_SCENARIO_PATH =
  "scripts/e2e/lib/release-typed-onboarding/scenario.sh";
const RELEASE_TYPED_ONBOARDING_DOCKER_E2E_PATH = "scripts/e2e/release-typed-onboarding-docker.sh";
const RELEASE_USER_JOURNEY_DOCKER_E2E_PATH = "scripts/e2e/release-user-journey-docker.sh";
const RELEASE_USER_JOURNEY_SCENARIO_PATH = "scripts/e2e/lib/release-user-journey/scenario.sh";
const UPGRADE_SURVIVOR_RUN_SCRIPT = "scripts/e2e/lib/upgrade-survivor/run.sh";
const UPGRADE_SURVIVOR_UPDATE_RESTART_AUTH_PATH =
  "scripts/e2e/lib/upgrade-survivor/update-restart-auth.sh";
const UPGRADE_SURVIVOR_CONFIG_PARKING_PATH = "scripts/e2e/lib/upgrade-survivor/config-parking.mjs";
const GATEWAY_NETWORK_DOCKER_E2E_PATH = "scripts/e2e/gateway-network-docker.sh";
const BROWSER_CDP_SNAPSHOT_DOCKER_E2E_PATH = "scripts/e2e/browser-cdp-snapshot-docker.sh";
const SANDBOX_BROWSER_SIDECAR_DOCKER_E2E_PATH = "scripts/e2e/sandbox-browser-sidecar-docker.sh";
const SANDBOX_BROWSER_SIDECAR_SCENARIO_PATH =
  "scripts/e2e/lib/sandbox-browser-sidecar/scenario.mjs";
const CENTRALIZED_BUILD_SCRIPTS = [
  "scripts/docker/setup.sh",
  BROWSER_CDP_SNAPSHOT_DOCKER_E2E_PATH,
  SANDBOX_BROWSER_SIDECAR_DOCKER_E2E_PATH,
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

function extractUpgradeSurvivorPayload(script: string) {
  const marker = " bash -lc ";
  const start = script.indexOf(marker);
  const quoted = script.slice(start + marker.length).trimEnd();
  const end = quoted.search(/\n'(?:\n|$)/u);
  if (start < 0 || !quoted.startsWith("'") || end < 0) {
    throw new Error("upgrade survivor bash -lc payload not found");
  }
  return quoted.slice(1, end + 1).replaceAll(`'"'"'`, "'");
}

// Prompt-driving scripts must consume public prompts in the order the CLI renders them.
function expectOrderedScriptFragments(script: string, fragments: readonly string[]): void {
  let offset = 0;
  for (const fragment of fragments) {
    const index = script.indexOf(fragment, offset);
    expect(index, `missing ordered script fragment: ${fragment}`).toBeGreaterThanOrEqual(offset);
    offset = index + fragment.length;
  }
}
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

function runSurvivorDiagnostics(
  mode: "capture" | "publish",
  artifacts: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
) {
  return spawnSync(
    process.execPath,
    [
      ...(mode === "publish" ? ["--import", "./scripts/tsx.mjs"] : []),
      mode === "publish"
        ? UPGRADE_SURVIVOR_DIAGNOSTICS_PUBLISH_PATH
        : UPGRADE_SURVIVOR_DIAGNOSTICS_PATH,
      mode,
      artifacts,
      ...args,
    ],
    { encoding: "utf8", env: { ...process.env, ...env } },
  );
}

function survivorPostCoreFixture() {
  const workDir = realpathSync(tempDirs.make("openclaw-survivor-post-core-"));
  const artifacts = join(workDir, "artifacts");
  const resultDir = join(workDir, "openclaw-update-post-core-fixture");
  mkdirSync(artifacts);
  mkdirSync(resultDir);
  const resultPath = join(resultDir, "plugins.json");
  return {
    workDir,
    artifacts,
    resultDir,
    resultPath,
    preloadOptions: `--no-warnings --import=${pathToFileURL(join(process.cwd(), UPGRADE_SURVIVOR_DIAGNOSTICS_PATH)).href}`,
    env: {
      ...process.env,
      HOME: workDir,
      TMPDIR: workDir,
      OPENCLAW_STATE_DIR: workDir,
      OPENCLAW_CONFIG_PATH: join(workDir, "absent"),
      OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT: artifacts,
      OPENCLAW_UPDATE_POST_CORE: "1",
      OPENCLAW_UPDATE_POST_CORE_RESULT_PATH: resultPath,
      NODE_OPTIONS: "--no-warnings",
    },
  };
}

function copySurvivorCaptureClosure(workDir: string) {
  const library = join(workDir, "lib");
  mkdirSync(join(library, "upgrade-survivor"), { recursive: true });
  for (const name of [
    "openclaw-state-paths.mjs",
    "plugin-index-sqlite.mjs",
    "env-limits.mjs",
    "text-file-utils.mjs",
    "upgrade-survivor/diagnostics.mjs",
  ]) {
    writeFileSync(join(library, name), readFileSync(join("scripts/e2e/lib", name)));
  }
  return join(library, "upgrade-survivor", "diagnostics.mjs");
}

function renderRepoShell(
  parts: TemplateStringsArray,
  values: readonly unknown[],
  workDir?: string,
): string {
  const body = parts.reduce(
    (result, part, index) => result + part + (index < values.length ? String(values[index]) : ""),
    "",
  );
  const scriptBody = body.startsWith("\n") ? body.slice(1) : body;
  const tempSetup = workDir ? `TMPDIR=${shellQuote(workDir)}\nexport ROOT_DIR TMPDIR\n` : "";
  return `
set -euo pipefail
ROOT_DIR=${shellQuote(process.cwd())}
${tempSetup}${scriptBody}`;
}

function repoRootShell(parts: TemplateStringsArray, ...values: unknown[]): string {
  return renderRepoShell(parts, values);
}

function repoShell(workDir: string) {
  return (parts: TemplateStringsArray, ...values: unknown[]): string =>
    renderRepoShell(parts, values, workDir);
}

function writeExecutables(directory: string, files: Record<string, string>): void {
  mkdirSync(directory, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(directory, name), contents, { mode: 0o755 });
  }
}

function expectTextToIncludeAll(text: string, snippets: readonly string[]): void {
  for (const snippet of snippets) {
    expect(text).toContain(snippet);
  }
}

function expectTextToIncludeInOrder(text: string, snippets: readonly string[]): void {
  let offset = 0;
  for (const snippet of snippets) {
    const index = text.indexOf(snippet, offset);
    expect(index).toBeGreaterThanOrEqual(offset);
    offset = index + snippet.length;
  }
}

function extractUpgradeSurvivorSupervisor(script: string): string {
  const match = script.match(
    /cat >"\$supervisor_script" <<'SUPERVISOR'\n(?<source>[\s\S]*?)\nSUPERVISOR/u,
  );
  const source = match?.groups?.source;
  if (!source) {
    throw new Error("upgrade survivor supervisor source not found");
  }
  return source;
}

function installUpgradeSurvivorSystemctlShim(
  prefix: string,
  env: NodeJS.ProcessEnv,
  scriptPath = UPGRADE_SURVIVOR_UPDATE_RESTART_AUTH_PATH,
): string {
  const installed = spawnSync(
    "bash",
    [
      "-c",
      'set -euo pipefail; source "$1"; install_update_restart_systemctl_shim',
      "fixture",
      scriptPath,
    ],
    { env: { PATH: process.env.PATH, ...env, npm_config_prefix: prefix }, encoding: "utf8" },
  );
  expect(installed.status, installed.stderr).toBe(0);
  return join(prefix, "bin", "systemctl");
}

async function waitForProcessExit(child: ChildProcess, timeoutMs = 5_000): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return child.exitCode;
  }
  return await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("process did not exit before its test deadline"));
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopUpgradeSurvivorSupervisor(supervisor: ChildProcess, pidPath: string) {
  try {
    if (supervisor.exitCode === null && supervisor.signalCode === null) {
      supervisor.kill("SIGTERM");
      await waitForProcessExit(supervisor).catch(() => undefined);
    }
  } finally {
    // Read the owned fixture's publication during cleanup even if readiness failed
    // before the test learned the descendant PID.
    if (existsSync(pidPath)) {
      const pid = Number(readFileSync(pidPath, "utf8").trim());
      if (Number.isSafeInteger(pid) && pid > 1 && isProcessRunning(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    }
  }
}

function writeTermIgnoringDescendant(workDir: string): string {
  const descendantPath = join(workDir, "descendant.mjs");
  writeFileSync(
    descendantPath,
    `import fs from "node:fs";
process.on("SIGTERM", () => {});
// Readers use file existence as readiness; publish the complete PID atomically.
const pendingPid = process.env.DESCENDANT_PID_FILE + ".pending";
fs.writeFileSync(pendingPid, String(process.pid));
fs.renameSync(pendingPid, process.env.DESCENDANT_PID_FILE);
setInterval(() => {}, 1_000);
`,
  );
  return descendantPath;
}

async function forEachUpgradeSurvivorSystemctlShim(
  callback: (fixture: {
    pid: number;
    run: (command: "is-active" | "stop", procStat?: string) => number | null;
    scriptPath: string;
  }) => void | Promise<void>,
  targetPid?: number,
): Promise<void> {
  for (const scriptPath of [UPGRADE_SURVIVOR_UPDATE_RESTART_AUTH_PATH]) {
    const workDir = tempDirs.make("openclaw-systemctl-shim-");
    const binDir = join(workDir, "bin");
    const pidPath = join(workDir, "gateway.pid");
    const childPidPath = join(workDir, "child.pid");
    const child =
      targetPid === undefined
        ? spawn(process.execPath, [writeTermIgnoringDescendant(workDir)], {
            env: { ...process.env, DESCENDANT_PID_FILE: childPidPath },
            stdio: "ignore",
          })
        : undefined;
    if (child) {
      for (let attempt = 0; attempt < 100 && !existsSync(childPidPath); attempt += 1) {
        await delay(10);
      }
    }
    const pid = targetPid ?? Number.parseInt(readFileSync(childPidPath, "utf8"), 10);
    writeFileSync(pidPath, `${pid}\n`);
    const fixtureEnv = {
      OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_LOG: join(workDir, "systemctl.log"),
      OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE: pidPath,
    };
    const shimPath = installUpgradeSurvivorSystemctlShim(
      workDir,
      { HOME: workDir, ...fixtureEnv },
      scriptPath,
    );
    writeExecutables(binDir, {
      awk: `#!/usr/bin/env bash
[ "$FAKE_PROC_STAT_MODE" != "unreadable" ] || exit 1
set -- $FAKE_PROC_STAT
printf '%s\\n' "\${3:-}"
`,
      cat: `#!/usr/bin/env bash
case "\${1:-}" in
  /proc/*/stat)
    [ "$FAKE_PROC_STAT_MODE" != "unreadable" ] || exit 1
    printf '%s\\n' "$FAKE_PROC_STAT"
    ;;
  *) exec /bin/cat "$@" ;;
esac
`,
      sleep: "#!/usr/bin/env bash\nexit 97\n",
    });
    const run = (command: "is-active" | "stop", procStat?: string) =>
      spawnSync("bash", [shimPath, "--user", command, "openclaw-gateway.service"], {
        encoding: "utf8",
        env: {
          ...process.env,
          FAKE_PROC_STAT: procStat ?? "",
          FAKE_PROC_STAT_MODE: procStat === undefined ? "unreadable" : "readable",
          ...fixtureEnv,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        },
      }).status;

    try {
      await callback({ pid, run, scriptPath });
    } finally {
      if (child) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
        await waitForProcessExit(child).catch(() => undefined);
      }
    }
  }
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

  it("treats Docker registry auth 5xx failures as transient build failures", () => {
    const workDir = tempDirs.make("openclaw-docker-build-transient-");
    const logPath = join(workDir, "docker-build.log");
    writeFileSync(
      logPath,
      [
        "#3 ERROR: failed to authorize: failed to fetch oauth token: unexpected status from POST request to https://auth.docker.io/token: 504 Gateway Timeout: error code: 504",
        "ERROR: failed to solve: failed to resolve source metadata for docker.io/docker/dockerfile:1.7",
      ].join("\n"),
    );

    const script = repoRootShell`
LOG_PATH=${shellQuote(logPath)}
source "$ROOT_DIR/scripts/lib/docker-build.sh"
docker_build_transient_failure "$LOG_PATH"
`;

    execFileSync("bash", ["-lc", script], { encoding: "utf8" });
  });

  it("detects Docker builder memory exhaustion failures", () => {
    const workDir = tempDirs.make("openclaw-docker-build-memory-");
    const logPath = join(workDir, "docker-build.log");
    writeFileSync(
      logPath,
      [
        'ERROR: failed to build: failed to solve: ResourceExhausted: process "/bin/sh -c pnpm build:docker" did not complete successfully: cannot allocate memory',
      ].join("\n"),
    );

    const script = repoRootShell`
LOG_PATH=${shellQuote(logPath)}
source "$ROOT_DIR/scripts/lib/docker-build.sh"
docker_build_resource_exhausted_failure "$LOG_PATH"
`;

    execFileSync("bash", ["-lc", script], { encoding: "utf8" });
  });

  it("detects compiler processes killed by the OOM killer", () => {
    const workDir = tempDirs.make("openclaw-docker-build-killed-compiler-");
    const logPath = join(workDir, "docker-build.log");
    writeFileSync(logPath, "c++: fatal error: Killed signal terminated program cc1plus\n");

    const script = repoRootShell`
LOG_PATH=${shellQuote(logPath)}
source "$ROOT_DIR/scripts/lib/docker-build.sh"
docker_build_resource_exhausted_failure "$LOG_PATH"
`;

    execFileSync("bash", ["-lc", script], { encoding: "utf8" });
  });

  it("retries Corepack connect timeouts without misreading Dockerfile comments as OOM", () => {
    const workDir = tempDirs.make("openclaw-docker-build-connect-timeout-");
    const logPath = join(workDir, "docker-build.log");
    writeFileSync(
      logPath,
      [
        '# Docker builds on small VMs may otherwise fail with "Killed" (exit 137).',
        "ConnectTimeoutError: Connect Timeout Error (attempted addresses: 192.0.2.1:443)",
      ].join("\n"),
    );

    const script = repoRootShell`
LOG_PATH=${shellQuote(logPath)}
source "$ROOT_DIR/scripts/lib/docker-build.sh"
docker_build_transient_failure "$LOG_PATH"
if docker_build_resource_exhausted_failure "$LOG_PATH"; then
  exit 3
fi
`;

    execFileSync("bash", ["-lc", script], { encoding: "utf8" });
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

  it("runs the sandbox browser sidecar proof from the package-installed image", () => {
    const runner = readFileSync(SANDBOX_BROWSER_SIDECAR_DOCKER_E2E_PATH, "utf8");
    const scenario = readFileSync(SANDBOX_BROWSER_SIDECAR_SCENARIO_PATH, "utf8");

    expect(runner).toContain('source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"');
    expect(runner).toContain("docker_e2e_build_or_reuse");
    expect(runner).toContain("--network host");
    expect(runner).toContain('--group-add "$SOCKET_GID"');
    expect(runner).toContain('-v "$DOCKER_SOCKET:/var/run/docker.sock"');
    expect(runner).toContain('-v "$SCENARIO_ROOT:$SCENARIO_ROOT"');
    expect(runner).toContain("scripts/docker/sandbox/Dockerfile.browser");
    expect(scenario).toContain('from "openclaw/plugin-sdk/agent-harness-runtime"');
    expect(scenario).toContain('"sandbox", "list", "--browser", "--json"');
    expect(scenario).not.toMatch(/from\s+["'][.]{1,2}\/.*src\//u);
  });

  it("cleans only the sidecar task's containers when the runner exits early", () => {
    const workDir = realpathSync(tempDirs.make("openclaw-sidecar-cleanup-"));
    const binDir = join(workDir, "bin");
    const scenarioRoot = join(workDir, "scenario");
    const buildRoot = join(workDir, "build");
    const containersPath = join(workDir, "containers.json");
    const sessionKey = "agent:main:sandbox-browser-sidecar";
    const workspaceHash = createHash("sha256")
      .update(join(scenarioRoot, "workspace"))
      .digest("hex")
      .slice(0, 32);
    const scopeKey = `${sessionKey}:workspace:${workspaceHash}`;
    const unrelated = { name: "other-workspace", scopeKey: `${sessionKey}:workspace:other` };
    writeFileSync(
      containersPath,
      JSON.stringify([
        { name: "short-normal-sandbox", scopeKey },
        { name: "short-browser-sidecar", scopeKey },
        unrelated,
      ]),
    );
    writeExecutables(binDir, {
      mktemp: `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const template = args.at(-1);
const target = template.includes("sandbox-browser-sidecar-build.")
  ? ${JSON.stringify(buildRoot)}
  : template.includes("sandbox-browser-sidecar.") ? ${JSON.stringify(scenarioRoot)} : undefined;
if (target) {
  fs.mkdirSync(target, { recursive: true });
  console.log(target);
} else {
  process.stdout.write(require("node:child_process").execFileSync("/usr/bin/mktemp", args));
}
`,
      docker: `#!/usr/bin/env node
const fs = require("node:fs");
const file = ${JSON.stringify(containersPath)};
const containers = JSON.parse(fs.readFileSync(file, "utf8"));
const args = process.argv.slice(2);
if (args[0] === "ps") {
  const filterIndex = args.indexOf("--filter");
  const filter = filterIndex < 0 ? undefined : args[filterIndex + 1];
  for (const container of containers) {
    if (!filter || filter === "label=openclaw.sessionKey=" + container.scopeKey) console.log(container.name);
  }
} else if (args[0] === "rm") {
  fs.writeFileSync(file, JSON.stringify(containers.filter((container) => !args.slice(1).includes(container.name))));
}
`,
    });

    const result = spawnSync("bash", [SANDBOX_BROWSER_SIDECAR_DOCKER_E2E_PATH], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        OPENCLAW_DOCKER_SOCKET: join(workDir, "missing.sock"),
      },
    });

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("Docker socket not found:");
    expect(JSON.parse(readFileSync(containersPath, "utf8"))).toEqual([unrelated]);
    expect(existsSync(scenarioRoot)).toBe(false);
    expect(existsSync(buildRoot)).toBe(false);
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
    const workDir = tempDirs.make("openclaw-cleanup-smoke-log-invalid-");
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
  });

  it("normalizes zero-padded cleanup-smoke log byte limits", () => {
    const workDir = tempDirs.make("openclaw-cleanup-smoke-log-tail-");
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

    expectTextToIncludeAll(helper, [
      "docker_build_on_missing_enabled()",
      "OPENCLAW_DOCKER_BUILD_ON_MISSING",
      "OPENCLAW_TESTBOX",
    ]);

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
    const openWebUi = readFileSync(OPENWEBUI_DOCKER_E2E_PATH, "utf8");
    expect(openWebUi).toContain(
      'OPENWEBUI_IMAGE="${OPENWEBUI_IMAGE:-ghcr.io/open-webui/open-webui:v0.11.0@sha256:72c0ba641ba75e7aa52655cb242570906ececd09b1140fb736483038a22b3228}"',
    );
    expect(openWebUi).toContain(
      'DOCKER_COMMAND_TIMEOUT="$DOCKER_PULL_TIMEOUT" docker_e2e_docker_cmd pull "$OPENWEBUI_IMAGE"',
    );
    expect(openWebUi).toContain(
      "node scripts/e2e/lib/openwebui/http-probe.mjs 'http://$OW_NAME:$WEBUI_PORT/health' 200",
    );
    expect(openWebUi).not.toContain(
      'timeout "$DOCKER_PULL_TIMEOUT" docker pull "$OPENWEBUI_IMAGE"',
    );
    expect(openWebUi).not.toContain(
      "node scripts/e2e/lib/openwebui/http-probe.mjs 'http://$OW_NAME:$WEBUI_PORT/' lt500",
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

  it("resolves source and compiled candidate test-state entrypoints", () => {
    const resolveEntrypoint = (rootDir: string) =>
      spawnSync(
        "bash",
        ["-c", `source "${DOCKER_E2E_IMAGE_HELPER_PATH}"; docker_e2e_test_state_entrypoint`],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: { ...process.env, ROOT_DIR: rootDir },
        },
      );

    const sourceResult = resolveEntrypoint(process.cwd());
    expect(sourceResult.status, sourceResult.stderr).toBe(0);
    expect(sourceResult.stdout.trim()).toBe(
      join(process.cwd(), "scripts/lib/openclaw-test-state.mts"),
    );

    const compiledRoot = tempDirs.make("openclaw-compiled-test-state-");
    const missingResult = resolveEntrypoint(compiledRoot);
    expect(missingResult.status).toBe(1);
    expect(missingResult.stderr).toContain("OpenClaw test-state entrypoint not found");

    const compiledDir = join(compiledRoot, "scripts/lib");
    mkdirSync(compiledDir, { recursive: true });
    const compiledEntrypoint = join(compiledDir, "openclaw-test-state.mjs");
    writeFileSync(compiledEntrypoint, "", "utf8");
    const compiledResult = resolveEntrypoint(compiledRoot);
    expect(compiledResult.status, compiledResult.stderr).toBe(0);
    expect(compiledResult.stdout.trim()).toBe(compiledEntrypoint);
  });

  it("runs current TypeScript and frozen JavaScript Docker harness entrypoints", () => {
    const fixtureRoot = tempDirs.make("openclaw-docker-script-entrypoint-");
    const scriptStem = join(fixtureRoot, "fixture");
    const runFixture = (value: string) =>
      spawnSync(
        "bash",
        [
          "-c",
          `source "${OPENCLAW_E2E_INSTANCE_HELPER_PATH}"; openclaw_e2e_run_script_entrypoint "$1" "$2"`,
          "openclaw-docker-script-entrypoint",
          scriptStem,
          value,
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${join(process.cwd(), "node_modules/.bin")}:${process.env.PATH ?? ""}`,
          },
        },
      );

    writeFileSync(
      `${scriptStem}.mts`,
      'enum Choice { Current = "current" }\nconst value: Choice = process.argv[2] as Choice; process.stdout.write(`mts:${value}`);\n',
      "utf8",
    );
    const sourceResult = runFixture("current");
    expect(sourceResult.status, sourceResult.stderr).toBe(0);
    expect(sourceResult.stdout).toBe("mts:current");

    rmSync(`${scriptStem}.mts`);
    writeFileSync(
      `${scriptStem}.mjs`,
      'process.stdout.write(`mjs:${process.argv[2] ?? ""}`);\n',
      "utf8",
    );
    const compiledResult = runFixture("frozen");
    expect(compiledResult.status, compiledResult.stderr).toBe(0);
    expect(compiledResult.stdout).toBe("mjs:frozen");

    rmSync(`${scriptStem}.mjs`);
    const missingResult = runFixture("missing");
    expect(missingResult.status).toBe(1);
    expect(missingResult.stderr).toContain("script entrypoint not found");
  });

  it("routes package-only Docker TypeScript entrypoints through their required runtime", () => {
    const gatewayRunner = readFileSync(GATEWAY_NETWORK_DOCKER_E2E_PATH, "utf8");
    const imageHelper = readFileSync(DOCKER_E2E_IMAGE_HELPER_PATH, "utf8");
    const kitchenSinkRunner = readFileSync(KITCHEN_SINK_RPC_DOCKER_E2E_PATH, "utf8");
    const releaseUpgradeScenario = readFileSync(RELEASE_UPGRADE_USER_JOURNEY_SCENARIO_PATH, "utf8");
    expect(gatewayRunner).toContain("node scripts/e2e/lib/gateway-network/client.mts");
    expect(kitchenSinkRunner).toContain(
      "openclaw_e2e_run_script_entrypoint scripts/e2e/kitchen-sink-rpc-walk",
    );
    expect(releaseUpgradeScenario).toContain(
      "openclaw_e2e_run_script_entrypoint \\\n      scripts/lib/release-upgrade-baseline",
    );
    expect(gatewayRunner).not.toContain("node --import tsx");
    expect(imageHelper).not.toContain('node --import tsx "$entrypoint"');
    expect(kitchenSinkRunner).not.toContain("node --import tsx");
    expect(releaseUpgradeScenario).not.toContain("node --import tsx");
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
    expect(unsetIndex).toBeLessThan(script.indexOf("docker_e2e_run_with_harness"));
  });

  it("wraps centralized Docker builds with the timeout helper", () => {
    const workDir = tempDirs.make("openclaw-docker-build-timeout-");
    writeExecutables(join(workDir, "bin"), {
      timeout: `#!/bin/bash
set -euo pipefail
if [[ "$1" = "--kill-after=1s" ]]; then
  exit 0
fi
printf '%s %s|%s\\n' "$1" "$2" "\${*:3}" >>"$TMPDIR/timeout-seen"
shift 2
"$@"
`,
      docker: `#!/bin/sh
printf "%s\\n" "$*" >>"$TMPDIR/docker-seen"
`,
    });

    const script = repoShell(workDir)`
export PATH="$TMPDIR/bin:$PATH"
export OPENCLAW_DOCKER_BUILD_TIMEOUT=17s

source "$ROOT_DIR/scripts/lib/docker-build.sh"

docker_build_run e2e-build -t demo-image .

grep -q '^--kill-after=30s 17s|env DOCKER_BUILDKIT=1 docker build -t demo-image .$' "$TMPDIR/timeout-seen"
grep -q '^build -t demo-image .$' "$TMPDIR/docker-seen"
`;

    execFileSync("bash", ["-lc", script], { encoding: "utf8" });
  });

  it("prints heartbeat progress for long successful centralized Docker builds", () => {
    const workDir = tempDirs.make("openclaw-docker-build-heartbeat-");
    const script = repoShell(workDir)`
source "$ROOT_DIR/scripts/lib/docker-build.sh"

printf "captured docker build log\\n" >"$TMPDIR/build.log"
output="$(docker_build_maybe_print_heartbeat e2e-build 1 1 "$TMPDIR/build.log")"
[[ "$output" = *"Docker build e2e-build still running ("* ]]
[[ "$output" = *"log bytes captured"* ]]
[[ "$output" != *"captured docker build log"* ]]
`;

    execFileSync("bash", ["-lc", script], { encoding: "utf8" });
  });

  it("stops the tracked build command without retrying when interrupted", async () => {
    const workDir = tempDirs.make("openclaw-docker-build-signal-");
    writeExecutables(join(workDir, "bin"), {
      docker: `#!/bin/bash
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
    });

    writeExecutables(workDir, {
      "runner.sh": `#!/bin/bash
set -euo pipefail
ROOT_DIR=${shellQuote(process.cwd())}
TMPDIR=${shellQuote(workDir)}
export ROOT_DIR TMPDIR
export PATH="$TMPDIR/bin:$PATH"
export OPENCLAW_DOCKER_BUILD_RETRIES=3
source "$ROOT_DIR/scripts/lib/docker-build.sh"
docker_build_run e2e-build -t demo-image .
`,
    });

    const waitForFile = async (filePath: string) => {
      for (let attempt = 0; attempt < 500; attempt += 1) {
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
      for (let attempt = 0; attempt < 500; attempt += 1) {
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
  });

  it("does not delay fast successful centralized Docker builds until the next heartbeat", () => {
    const workDir = tempDirs.make("openclaw-docker-build-fast-heartbeat-");
    writeExecutables(join(workDir, "bin"), {
      timeout: `#!/bin/bash
set -euo pipefail
if [[ "$1" = "--kill-after=1s" ]]; then
  exit 0
fi
shift 2
"$@"
`,
      docker: `#!/bin/sh
printf "quick docker build log\\n"
`,
    });

    const script = repoShell(workDir)`
export PATH="$TMPDIR/bin:$PATH"
export OPENCLAW_DOCKER_BUILD_HEARTBEAT_SECONDS=30

source "$ROOT_DIR/scripts/lib/docker-build.sh"

output="$(docker_build_run e2e-build -t demo-image .)"
[[ -z "$output" ]]
`;
    const startedAt = Date.now();

    execFileSync("bash", ["-lc", script], { encoding: "utf8" });

    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("normalizes zero-padded centralized Docker build heartbeat intervals", () => {
    const script = repoRootShell`
export ROOT_DIR
export OPENCLAW_DOCKER_BUILD_HEARTBEAT_SECONDS=08

source "$ROOT_DIR/scripts/lib/docker-build.sh"

[[ "$(docker_build_heartbeat_seconds)" = "8" ]]
`;

    execFileSync("bash", ["-lc", script], { encoding: "utf8" });
  });

  it("normalizes zero-padded centralized Docker build retry counts", () => {
    const script = repoRootShell`
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
      const workDir = tempDirs.make("openclaw-docker-build-config-");
      const markerPath = join(workDir, "docker-invoked");

      writeExecutables(join(workDir, "bin"), {
        docker: `#!/bin/bash
printf invoked >${shellQuote(markerPath)}
exit 0
`,
      });

      const script = repoRootShell`
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
    },
  );

  it("fails centralized Docker builds fast when timeout is unavailable", () => {
    const workDir = tempDirs.make("openclaw-docker-build-timeout-required-");
    mkdirSync(join(workDir, "bin"));
    const script = repoShell(workDir)`
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
  });

  it("keeps setup-style Docker builds compatible when timeout is unavailable", () => {
    const workDir = tempDirs.make("openclaw-docker-build-timeout-optional-");
    writeExecutables(join(workDir, "bin"), {
      env: `#!/bin/sh
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
      docker: `#!/bin/sh
printf "%s\\n" "$*" >"$TMPDIR/docker-seen"
`,
    });

    const script = repoShell(workDir)`
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
  });

  it.each([
    {
      title: "keeps reused Docker image probes behind the timeout-aware helper",
      tempPrefix: "openclaw-docker-image-reuse-timeout-",
      scriptSource: (workDir: string) => repoShell(workDir)`
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
`,
    },
    {
      title: "explains how to opt out when Docker rejects default resource limits",
      tempPrefix: "openclaw-docker-resource-diagnostic-",
      scriptSource: (workDir: string) => repoShell(workDir)`
export OPENCLAW_DOCKER_E2E_AVAILABLE_CPUS=8
unset OPENCLAW_DOCKER_E2E_DISABLE_RESOURCE_LIMITS
unset OPENCLAW_DOCKER_E2E_MEMORY OPENCLAW_DOCKER_E2E_CPUS OPENCLAW_DOCKER_E2E_PIDS_LIMIT

docker() {
  printf "%s\\n" "$*" >>"$TMPDIR/docker-seen"
  echo "docker: Error response from daemon: NanoCPUs can not be set, as the cgroup is not mounted" >&2
  return 125
}

mktemp() {
  local dir=""
  dir="$(/usr/bin/mktemp "$@")" || return
  printf "%s\\n" "$*" >"$TMPDIR/mktemp-seen"
  printf "%s\\n" "$dir" >"$TMPDIR/diagnostic-dir"
  printf "%s\\n" "$dir"
}

tail() {
  [[ "$#" = "3" && "$1" = "-c" && "$2" = "65536" && -p "$3" ]] || return 1
  printf "%s %s\\n" "$1" "$2" >"$TMPDIR/tail-seen"
  /usr/bin/tail "$@"
}

source "$ROOT_DIR/scripts/lib/docker-e2e-container.sh"
docker_e2e_timeout_cmd() {
  shift
  "$@"
}

set +e
printf "before Docker\\n" >"$TMPDIR/stderr"
docker_e2e_docker_cmd run demo 2>>"$TMPDIR/stderr"
status="$?"
set -e

stderr="$(<"$TMPDIR/stderr")"
[[ "$status" = "125" ]] || exit 1
[[ "$stderr" = before\\ Docker* ]] || exit 1
[[ "$stderr" = *"NanoCPUs can not be set"* ]] || exit 1
[[ "$stderr" = *"Docker E2E resource limits are incompatible with this Docker runtime"* ]] || exit 1
[[ "$stderr" = *"OPENCLAW_DOCKER_E2E_DISABLE_RESOURCE_LIMITS=1"* ]] || exit 1
[[ "$(grep -c '^run ' "$TMPDIR/docker-seen")" = "1" ]] || exit 1
test "$(<"$TMPDIR/tail-seen")" = "-c 65536"
[[ "$(<"$TMPDIR/mktemp-seen")" = -d* ]] || exit 1
[[ ! -e "$(<"$TMPDIR/diagnostic-dir")" ]] || exit 1
`,
    },
    {
      title: "does not suggest resource opt-out for other Docker failures",
      tempPrefix: "openclaw-docker-resource-unrelated-",
      scriptSource: (workDir: string) => repoShell(workDir)`
export OPENCLAW_DOCKER_E2E_AVAILABLE_CPUS=8
unset OPENCLAW_DOCKER_E2E_DISABLE_RESOURCE_LIMITS
unset OPENCLAW_DOCKER_E2E_MEMORY OPENCLAW_DOCKER_E2E_CPUS OPENCLAW_DOCKER_E2E_PIDS_LIMIT

docker() {
  printf "%s\\n" "$*" >>"$TMPDIR/docker-seen"
  echo "docker: Error response from daemon: No such image: cgroup-helper" >&2
  return 125
}

source "$ROOT_DIR/scripts/lib/docker-e2e-container.sh"
docker_e2e_timeout_cmd() {
  shift
  "$@"
}

set +e
docker_e2e_docker_cmd run demo 2>"$TMPDIR/stderr"
status="$?"
set -e

stderr="$(<"$TMPDIR/stderr")"
[[ "$status" = "125" ]] || exit 1
[[ "$stderr" = *"No such image: cgroup-helper"* ]] || exit 1
[[ "$stderr" != *"OPENCLAW_DOCKER_E2E_DISABLE_RESOURCE_LIMITS"* ]] || exit 1
[[ "$(grep -c '^run ' "$TMPDIR/docker-seen")" = "1" ]] || exit 1
`,
    },
    {
      title: "rejects invalid Docker run pids limits before invoking docker",
      tempPrefix: "openclaw-docker-resource-pids-",
      scriptSource: (workDir: string) => repoShell(workDir)`

docker() {
  printf invoked >"$TMPDIR/docker-seen"
}
export -f docker

source "$ROOT_DIR/scripts/lib/docker-e2e-container.sh"

set +e
OPENCLAW_DOCKER_E2E_PIDS_LIMIT=many docker_e2e_docker_cmd run demo 2>"$TMPDIR/stderr"
status="$?"
set -e

[[ "$status" = "2" ]] || exit 1
[[ "$(<"$TMPDIR/stderr")" = *"invalid OPENCLAW_DOCKER_E2E_PIDS_LIMIT: many"* ]] || exit 1
[[ ! -e "$TMPDIR/docker-seen" ]] || exit 1
`,
    },
    {
      title: "rejects invalid package-backed Docker run pids limits before invoking docker",
      tempPrefix: "openclaw-docker-package-pids-",
      scriptSource: (workDir: string) => repoShell(workDir)`

dirname() {
  /usr/bin/dirname "$@"
}

docker() {
  printf invoked >"$TMPDIR/docker-seen"
}
export -f docker

source "$ROOT_DIR/scripts/lib/docker-e2e-package.sh"

set +e
OPENCLAW_DOCKER_E2E_PIDS_LIMIT=many docker_e2e_docker_run_cmd run demo 2>"$TMPDIR/stderr"
status="$?"
set -e

[[ "$status" = "2" ]] || exit 1
[[ "$(<"$TMPDIR/stderr")" = *"invalid OPENCLAW_DOCKER_E2E_PIDS_LIMIT: many"* ]] || exit 1
[[ ! -e "$TMPDIR/docker-seen" ]] || exit 1
`,
    },
    {
      title: "diagnoses rejected resource limits through the canonical package helper",
      tempPrefix: "openclaw-docker-package-diagnostic-",
      scriptSource: (workDir: string) => repoShell(workDir)`
export OPENCLAW_DOCKER_E2E_AVAILABLE_CPUS=8
unset OPENCLAW_DOCKER_E2E_DISABLE_RESOURCE_LIMITS
unset OPENCLAW_DOCKER_E2E_MEMORY OPENCLAW_DOCKER_E2E_CPUS OPENCLAW_DOCKER_E2E_PIDS_LIMIT

timeout() {
  if [[ "$1" = "--kill-after=1s" ]]; then
    return 0
  fi
  shift 2
  "$@"
}

docker() {
  printf "%s\\n" "$*" >>"$TMPDIR/docker-seen"
  echo "OCI runtime create failed: crun: controller pids is not available" >&2
  return 125
}

source "$ROOT_DIR/scripts/lib/docker-e2e-package.sh"

set +e
docker_e2e_docker_run_cmd run demo 2>"$TMPDIR/stderr"
status="$?"
set -e

stderr="$(<"$TMPDIR/stderr")"
[[ "$status" = "125" ]] || exit 1
[[ "$stderr" = *"controller pids is not available"* ]] || exit 1
[[ "$stderr" = *"Docker E2E resource limits are incompatible with this Docker runtime"* ]] || exit 1
[[ "$stderr" = *"OPENCLAW_DOCKER_E2E_DISABLE_RESOURCE_LIMITS=1"* ]] || exit 1
[[ "$(grep -c '^run ' "$TMPDIR/docker-seen")" = "1" ]] || exit 1
`,
    },
    {
      title: "removes functional Docker build package inputs after the build",
      tempPrefix: "openclaw-docker-build-cleanup-",
      scriptSource: (workDir: string) => repoShell(workDir)`

node() {
  local script="$1"
  shift
  if [[ "$script" != "$DOCKER_E2E_PACKAGE_LIB_DIR/../package-openclaw-for-docker.mjs" ]]; then
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
`,
    },
    {
      title: "keeps caller-provided functional Docker build packages",
      tempPrefix: "openclaw-docker-build-external-package-",
      scriptSource: (workDir: string) => repoShell(workDir)`

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
`,
    },
    {
      title: "cleans generated package mounts after harness Docker runs",
      tempPrefix: "openclaw-docker-package-mount-cleanup-",
      scriptSource: (workDir: string) => repoShell(workDir)`
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
  if [[ "$script" != "$DOCKER_E2E_PACKAGE_LIB_DIR/../package-openclaw-for-docker.mjs" ]]; then
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
  local last_arg=""
  local arg
  for arg in "$@"; do
    last_arg="$arg"
  done
  if [[ "$1" == "rm" ]]; then
    shift
    test "$1" = "-f"
    shift
    printf "rm %s\\n" "$1" >>"$TMPDIR/docker-lifecycle"
    printf "%s\\n" "$1" >>"$TMPDIR/docker-rm-seen"
    return 0
  fi
  if [[ "$1" == "inspect" ]]; then
    printf "inspect %s\\n" "$last_arg" >>"$TMPDIR/docker-lifecycle"
    if [[ "\${DOCKER_STUB_INSPECT_STATUS:-0}" != "0" ]]; then
      printf "%s\\n" "\${DOCKER_STUB_INSPECT_ERROR:-inspect failed}" >&2
      return "$DOCKER_STUB_INSPECT_STATUS"
    fi
    printf "ExitCode=%s\\nOOMKilled=%s\\nError=%s\\n" \\
      "\${DOCKER_STUB_EXIT_CODE:-0}" \\
      "\${DOCKER_STUB_OOM:-false}" \\
      "\${DOCKER_STUB_ERROR:-}"
    return 0
  fi

  local cidfile=""
  local mount_path=""
  local expect_volume_path=0
  local expect_cidfile=0
  for arg in "$@"; do
    test "$arg" != "--rm"
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
  printf "container-%s\\n" "\${DOCKER_STUB_STATUS:-0}" >"$cidfile"
  printf "run container-%s\\n" "\${DOCKER_STUB_STATUS:-0}" >>"$TMPDIR/docker-lifecycle"
  test -n "$mount_path"
  test -f "$mount_path"
  printf "%s\\n" "$mount_path" >"$TMPDIR/package-mount-seen"
  return "\${DOCKER_STUB_STATUS:-0}"
}
export -f docker

package_tgz="$(docker_e2e_prepare_package_tgz mount-cleanup)"
pack_dir="$(dirname "$package_tgz")"
docker_e2e_package_mount_args "$package_tgz"
export DOCKER_STUB_STATUS=7
export DOCKER_STUB_EXIT_CODE=137
export DOCKER_STUB_OOM=true
DOCKER_STUB_ERROR="$(printf '%05000d' 0)"
export DOCKER_STUB_ERROR
docker_e2e_run_with_harness image-name bash -lc true 2>"$TMPDIR/failure-stderr" || run_status="$?"
test "\${run_status:-0}" = "7"
test "$(cat "$TMPDIR/docker-timeout-seen")" = "--kill-after=30s 3s"
grep -qx "container-7" "$TMPDIR/docker-rm-seen"
test "$(sed -n '1p' "$TMPDIR/docker-lifecycle")" = "run container-7"
test "$(sed -n '2p' "$TMPDIR/docker-lifecycle")" = "inspect container-7"
test "$(sed -n '3p' "$TMPDIR/docker-lifecycle")" = "rm container-7"
grep -q '^Docker container state:$' "$TMPDIR/failure-stderr"
grep -q '^ExitCode=137$' "$TMPDIR/failure-stderr"
grep -q '^OOMKilled=true$' "$TMPDIR/failure-stderr"
test "$(wc -c <"$TMPDIR/failure-stderr")" -lt 5000
test -f "$TMPDIR/package-mount-seen"
test ! -e "$pack_dir"
test -z "$(find "$TMPDIR" -maxdepth 1 -name 'openclaw-docker-e2e-container.*' -print)"

external_dir="$TMPDIR/external-package"
mkdir -p "$external_dir"
printf fixture >"$external_dir/openclaw-current.tgz"
docker_e2e_package_mount_args "$external_dir/openclaw-current.tgz"
export DOCKER_STUB_STATUS=23
export DOCKER_STUB_INSPECT_STATUS=9
export DOCKER_STUB_INSPECT_ERROR="daemon unavailable"
docker_e2e_run_with_harness image-name bash -lc true 2>"$TMPDIR/inspect-failure-stderr" || inspect_failure_status="$?"
test "\${inspect_failure_status:-0}" = "23"
grep -q "Docker container state unavailable (inspect exit 9): daemon unavailable" "$TMPDIR/inspect-failure-stderr"
tail -n 3 "$TMPDIR/docker-lifecycle" >"$TMPDIR/inspect-failure-lifecycle"
printf "run container-23\\ninspect container-23\\nrm container-23\\n" >"$TMPDIR/expected-inspect-failure-lifecycle"
cmp "$TMPDIR/expected-inspect-failure-lifecycle" "$TMPDIR/inspect-failure-lifecycle"

unset DOCKER_STUB_STATUS DOCKER_STUB_EXIT_CODE DOCKER_STUB_OOM DOCKER_STUB_ERROR
unset DOCKER_STUB_INSPECT_STATUS DOCKER_STUB_INSPECT_ERROR
unset DOCKER_COMMAND_TIMEOUT
rm -f "$TMPDIR/docker-timeout-seen"
docker_e2e_run_with_harness image-name bash -lc true 2>"$TMPDIR/success-stderr"
test "$(cat "$TMPDIR/docker-timeout-seen")" = "--kill-after=30s 3600s"
grep -qx "container-0" "$TMPDIR/docker-rm-seen"
test "$(tail -n 2 "$TMPDIR/docker-lifecycle")" = $'run container-0\\nrm container-0'
test ! -s "$TMPDIR/success-stderr"
test -f "$external_dir/openclaw-current.tgz"
`,
    },
    {
      title: "propagates shared E2E command timeouts into package-backed containers",
      tempPrefix: "openclaw-docker-package-timeout-env-",
      scriptSource: (workDir: string) => repoShell(workDir)`
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
`,
    },
    {
      title:
        "keeps both harness run wrappers available when the package helper is sourced directly",
      tempPrefix: "openclaw-docker-package-helper-guard-",
      scriptSource: (workDir: string) => repoShell(workDir)`

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

docker() {
  printf "%s\\n" "$*" >>"$TMPDIR/docker-run-seen"
}
export -f docker

source "$ROOT_DIR/scripts/lib/docker-e2e-package.sh"

docker_e2e_run_with_harness image-name bash -lc true
docker_e2e_run_detached_with_harness image-name
[[ $(wc -l <"$TMPDIR/docker-run-seen") -eq 2 ]]
`,
    },
    {
      title: "forwards harness stdin to backgrounded Docker runs",
      tempPrefix: "openclaw-docker-harness-stdin-",
      scriptSource: (workDir: string) => repoShell(workDir)`

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
`,
    },
    {
      title: "bounds printed Docker E2E logs to the configured tail",
      tempPrefix: "openclaw-docker-e2e-log-print-tail-",
      scriptSource: (workDir: string) => repoShell(workDir)`
export OPENCLAW_DOCKER_E2E_LOG_PRINT_BYTES=64

source "$ROOT_DIR/scripts/lib/docker-e2e-logs.sh"

output="$(run_logged_print_heartbeat plugins-run 30 bash -c 'printf "DO_NOT_PRINT_OLD_LOG_START"; printf "%0200d" 0; printf "recent container log tail\\\\n"')"
[[ "$output" = *"truncated: showing last 64"* ]]
[[ "$output" = *"recent container log tail"* ]]
[[ "$output" != *"DO_NOT_PRINT_OLD_LOG_START"* ]]
`,
    },
    {
      title: "prints heartbeat progress for long successful Docker E2E log captures",
      tempPrefix: "openclaw-docker-e2e-log-heartbeat-",
      scriptSource: (workDir: string) => repoShell(workDir)`

source "$ROOT_DIR/scripts/lib/docker-e2e-logs.sh"

printf "captured container log\\n" >"$TMPDIR/run.log"
output="$(docker_e2e_maybe_print_log_heartbeat plugins-run 1 1 "$TMPDIR/run.log")"
[[ "$output" = *"still running plugins-run ("* ]]
[[ "$output" = *"log bytes captured"* ]]
[[ "$output" != *"captured container log"* ]]
`,
    },
    {
      title: "cleans the heartbeat command when the wrapper is terminated",
      tempPrefix: "openclaw-docker-e2e-log-term-cleanup-",
      scriptSource: (workDir: string) => repoShell(workDir)`
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
`,
    },
    {
      title: "cleans harness containers when heartbeat-wrapped Docker runs are terminated",
      tempPrefix: "openclaw-docker-e2e-harness-term-cleanup-",
      scriptSource: (workDir: string) => repoShell(workDir)`

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
`,
    },
    {
      title: "normalizes zero-padded Docker E2E stats heartbeat intervals",
      tempPrefix: "openclaw-docker-e2e-stats-zero-heartbeat-",
      scriptSource: (workDir: string) => repoShell(workDir)`

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
`,
    },
  ])("$title", ({ tempPrefix, scriptSource }) => {
    const workDir = tempDirs.make(tempPrefix);
    const script = scriptSource(workDir);

    execFileSync("bash", ["-lc", script], { encoding: "utf8" });
  });

  it("derives the browser CDP image from the shared functional image", () => {
    const workDir = tempDirs.make("openclaw-browser-cdp-shared-image-");
    writeExecutables(join(workDir, "bin"), {
      docker: `#!/usr/bin/env bash
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
      node: `#!/usr/bin/env bash
printf "echo state\\n"
`,
      timeout: `#!/usr/bin/env bash
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
    });

    const script = repoRootShell`
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
    const workDir = tempDirs.make("openclaw-docker-timeout-required-");
    mkdirSync(join(workDir, "bin"));
    const script = repoShell(workDir)`
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
  });

  it("uses a Node watchdog for Docker commands when timeout is unavailable", () => {
    const workDir = tempDirs.make("openclaw-docker-node-timeout-");
    writeExecutables(join(workDir, "bin"), {
      node: `#!/bin/bash\nexec ${shellQuote(process.execPath)} "$@"\n`,
      docker: `#!/bin/bash\ninput="$(/bin/cat)"\nprintf "%s|%s\\n" "$*" "$input" >"$TMPDIR/docker-seen"\nexit 13\n`,
    });

    const script = repoShell(workDir)`
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
[[ "$(<"$TMPDIR/docker-seen")" = "run -e OPENCLAW_NO_AUTO_UPDATE=1 --memory 8g --cpus 16 --pids-limit 2048 -i demo|payload" ]]
`;

    execFileSync("bash", ["-lc", script], { encoding: "utf8" });
  });

  it("adds default Docker run resource limits without overriding explicit limits", () => {
    const workDir = tempDirs.make("openclaw-docker-resource-limits-");
    writeExecutables(join(workDir, "bin"), {
      timeout: `#!/bin/bash
set -euo pipefail
if [[ "$1" = "--kill-after=1s" ]]; then
  exit 0
fi
shift 2
"$@"
`,
    });

    const script = repoShell(workDir)`
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

[[ "$(sed -n '1p' "$TMPDIR/docker-seen")" = "run -e OPENCLAW_NO_AUTO_UPDATE=1 --memory 8g --cpus 16 --pids-limit 2048 demo" ]]
[[ "$(sed -n '2p' "$TMPDIR/docker-seen")" = "run -e OPENCLAW_NO_AUTO_UPDATE=1 --memory 12g --cpus 4 --pids-limit 512 demo" ]]
[[ "$(sed -n '3p' "$TMPDIR/docker-seen")" = "run -e OPENCLAW_NO_AUTO_UPDATE=1 --memory 12g --cpus 8 --pids-limit 512 demo" ]]
[[ "$(sed -n '4p' "$TMPDIR/docker-seen")" = "run -e OPENCLAW_NO_AUTO_UPDATE=1 --memory 2g --cpus 3 --pids-limit 99 demo" ]]
[[ "$(sed -n '5p' "$TMPDIR/docker-seen")" = "run -e OPENCLAW_NO_AUTO_UPDATE=1 demo" ]]
`;

    execFileSync("bash", ["-lc", script], { encoding: "utf8" });
  });

  it("runs Docker when resource diagnostic capture is unavailable", () => {
    const workDir = tempDirs.make("openclaw-docker-resource-no-temp-");
    const missingTmpDir = join(workDir, "missing");
    const script = repoRootShell`
TMPDIR=${shellQuote(missingTmpDir)}
export ROOT_DIR TMPDIR
export OPENCLAW_DOCKER_E2E_AVAILABLE_CPUS=8
unset OPENCLAW_DOCKER_E2E_DISABLE_RESOURCE_LIMITS
unset OPENCLAW_DOCKER_E2E_MEMORY OPENCLAW_DOCKER_E2E_CPUS OPENCLAW_DOCKER_E2E_PIDS_LIMIT

docker() {
  printf "%s\\n" "$*" >>${shellQuote(join(workDir, "docker-seen"))}
  return 7
}

source "$ROOT_DIR/scripts/lib/docker-e2e-container.sh"
docker_e2e_timeout_cmd() {
  shift
  "$@"
}

set +e
docker_e2e_docker_cmd run demo 2>/dev/null
status="$?"
set -e

[[ "$status" = "7" ]]
[[ "$(grep -c '^run ' ${shellQuote(join(workDir, "docker-seen"))})" = "1" ]]
`;

    execFileSync("bash", ["-lc", script], { encoding: "utf8" });
  });

  for (const [shellSignal, expectedStatus] of [
    ["TERM", "143"],
    ["HUP", "129"],
  ] as const) {
    it(`escalates Docker watchdog children that ignore parent SIG${shellSignal}`, () => {
      const workDir = tempDirs.make("openclaw-docker-node-signal-");
      writeExecutables(join(workDir, "bin"), {
        node: `#!/bin/bash\nexec ${shellQuote(process.execPath)} "$@"\n`,
        docker: `#!/bin/bash
printf "%s\\n" "$$" >"$TMPDIR/docker-pid"
printf "%s\\n" "$PPID" >"$TMPDIR/watchdog-pid"
trap "" TERM HUP
while true; do /bin/sleep 1; done
`,
      });

      const script = repoRootShell`
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
    });
  }

  it("uses plain timeout when kill-after is unsupported", () => {
    const workDir = tempDirs.make("openclaw-docker-plain-timeout-");
    writeExecutables(join(workDir, "bin"), {
      timeout: `#!/bin/bash
set -euo pipefail
if [[ "$1" = "--kill-after=1s" ]]; then
  exit 1
fi
printf 'plain:%s|%s\\n' "$1" "\${*:2}" >>"$TMPDIR/timeout-seen"
shift
"$@"
`,
    });

    const script = repoShell(workDir)`
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
  });

  it("uses gtimeout when timeout is unavailable", () => {
    const workDir = tempDirs.make("openclaw-docker-gtimeout-");
    writeExecutables(join(workDir, "bin"), {
      gtimeout: `#!/bin/bash
set -euo pipefail
if [[ "$1" = "--kill-after=1s" ]]; then
  exit 0
fi
printf 'gtimeout:%s %s|%s\\n' "$1" "$2" "\${*:3}" >>"$TMPDIR/timeout-seen"
shift 2
"$@"
`,
    });

    const script = repoShell(workDir)`
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

[[ "$(<"$TMPDIR/timeout-seen")" = "gtimeout:--kill-after=30s 13s|docker run -e OPENCLAW_NO_AUTO_UPDATE=1 --memory 8g --cpus 8 --pids-limit 2048 demo" ]]
[[ "$(<"$TMPDIR/docker-seen")" = "run -e OPENCLAW_NO_AUTO_UPDATE=1 --memory 8g --cpus 8 --pids-limit 2048 demo" ]]
`;

    execFileSync("bash", ["-lc", script], { encoding: "utf8" });
  });

  it("keeps package-backed Docker runs bounded when the package helper is sourced directly", () => {
    const workDir = tempDirs.make("openclaw-docker-package-timeout-required-");
    mkdirSync(join(workDir, "bin"));
    const script = repoShell(workDir)`
export PATH="$TMPDIR/bin"
export OPENCLAW_DOCKER_E2E_RUN_TIMEOUT=11s

dirname() {
  /usr/bin/dirname "$@"
}

docker() {
  printf "%s\\n" "$*" >"$TMPDIR/docker-seen"
}
export -f docker

source "$ROOT_DIR/scripts/lib/docker-e2e-package.sh"

set +e
docker_e2e_docker_run_cmd run demo 2>"$TMPDIR/stderr"
status="$?"
set -e

stderr="$(<"$TMPDIR/stderr")"
[[ "$status" = "127" ]]
[[ "$stderr" = *"timeout command not found; cannot bound Docker command after 11s"* ]]
[[ ! -e "$TMPDIR/docker-seen" ]]
`;

    execFileSync("bash", ["-lc", script], { encoding: "utf8" });
  });

  it("uses gtimeout for package-backed Docker runs sourced through the package helper", () => {
    const workDir = tempDirs.make("openclaw-docker-package-gtimeout-");
    writeExecutables(join(workDir, "bin"), {
      gtimeout: `#!/bin/bash
set -euo pipefail
if [[ "$1" = "--kill-after=1s" ]]; then
  exit 0
fi
printf 'gtimeout:%s %s|%s\\n' "$1" "$2" "\${*:3}" >>"$TMPDIR/timeout-seen"
shift 2
"$@"
`,
    });

    const script = repoShell(workDir)`
export PATH="$TMPDIR/bin"
export OPENCLAW_DOCKER_E2E_RUN_TIMEOUT=15s
export OPENCLAW_DOCKER_E2E_AVAILABLE_CPUS=8
unset OPENCLAW_DOCKER_E2E_DISABLE_RESOURCE_LIMITS
unset OPENCLAW_DOCKER_E2E_MEMORY OPENCLAW_DOCKER_E2E_CPUS OPENCLAW_DOCKER_E2E_PIDS_LIMIT

dirname() {
  /usr/bin/dirname "$@"
}

docker() {
  printf "%s\\n" "$*" >>"$TMPDIR/docker-seen"
}
export -f docker

source "$ROOT_DIR/scripts/lib/docker-e2e-package.sh"

docker_e2e_docker_run_cmd run demo

[[ "$(<"$TMPDIR/timeout-seen")" = "gtimeout:--kill-after=30s 15s|docker run -e OPENCLAW_NO_AUTO_UPDATE=1 --memory 8g --cpus 8 --pids-limit 2048 demo" ]]
[[ "$(<"$TMPDIR/docker-seen")" = "run -e OPENCLAW_NO_AUTO_UPDATE=1 --memory 8g --cpus 8 --pids-limit 2048 demo" ]]
`;

    execFileSync("bash", ["-lc", script], { encoding: "utf8" });
  });

  it("passes plugin lifecycle sampler timeout overrides into Docker", () => {
    const runner = readFileSync(PLUGIN_LIFECYCLE_MATRIX_DOCKER_E2E_PATH, "utf8");
    expectTextToIncludeAll(runner, [
      "append_positive_int_env()",
      "append_positive_number_env()",
      "append_positive_int_env OPENCLAW_PLUGIN_LIFECYCLE_PHASE_TIMEOUT_MS",
      "append_positive_int_env OPENCLAW_PLUGIN_LIFECYCLE_TIMEOUT_KILL_GRACE_MS",
      "append_positive_int_env OPENCLAW_PLUGIN_LIFECYCLE_METRIC_POLL_MS",
      "append_positive_int_env OPENCLAW_PLUGIN_LIFECYCLE_MAX_RSS_KB",
      "append_positive_int_env OPENCLAW_PLUGIN_LIFECYCLE_MAX_WALL_MS",
      "append_positive_number_env OPENCLAW_PLUGIN_LIFECYCLE_MAX_CPU_CORE_RATIO",
      'docker_e2e_run_with_harness \\\n  "${DOCKER_ENV_ARGS[@]}"',
    ]);
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
    expectTextToIncludeAll(updateChannel, [
      'openclaw_e2e_maybe_timeout "${OPENCLAW_E2E_NPM_INSTALL_TIMEOUT:-600s}" npm install --omit=dev --no-fund --no-audit',
      'openclaw_e2e_maybe_timeout "${OPENCLAW_E2E_NPM_INSTALL_TIMEOUT:-600s}" npm install -g --prefix /tmp/npm-prefix --omit=optional "$pkg_tgz_path"',
      "openclaw_e2e_print_log /tmp/openclaw-git-install.log",
      'openclaw_e2e_print_log "$package_install_log"',
    ]);

    expect(updateChannel).not.toContain("cat /tmp/openclaw-git-install.log");
    expect(updateChannel).not.toContain('cat "$package_install_log"');
    expectTextToIncludeAll(doctorSwitch, [
      'openclaw_e2e_maybe_timeout "${OPENCLAW_E2E_NPM_INSTALL_TIMEOUT:-600s}" npm install --omit=dev --no-fund --no-audit',
      'openclaw_e2e_maybe_timeout "${OPENCLAW_E2E_NPM_INSTALL_TIMEOUT:-600s}" npm install -g --prefix /tmp/npm-prefix --omit=optional "$package_tgz"',
      "openclaw_e2e_print_log /tmp/openclaw-git-install.log",
    ]);
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
      expectTextToIncludeAll(script, [
        "openclaw-upgrade-survivor-runtime",
        "OPENCLAW_UPGRADE_SURVIVOR_TMPDIR",
        "OPENCLAW_UPGRADE_SURVIVOR_TEST_STATE_TMPDIR",
        'export npm_config_cache="${OPENCLAW_UPGRADE_SURVIVOR_NPM_CACHE:-$OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT/npm-cache}"',
        'export NPM_CONFIG_CACHE="$npm_config_cache"',
        'chmod 700 "$npm_config_cache" || true',
      ]);

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
    const registryHelper = readFileSync(PREPUBLISH_PLUGIN_REGISTRY_HELPER_PATH, "utf8");

    for (const script of [runner, publishedRunner]) {
      expect(script).toContain("source scripts/e2e/lib/prepublish-plugin-registry.sh");
      expect(script).toContain("openclaw_prepublish_plugin_registry_start");
    }
    expectTextToIncludeAll(registryHelper, [
      'OPENCLAW_NPM_REGISTRY_UPSTREAM="${OPENCLAW_NPM_REGISTRY_UPSTREAM:-https://registry.npmjs.org}"',
      '[[ "$candidate_version" =~ -(alpha|beta)\\.[1-9][0-9]*$ ]]',
      'dist_tags="latest=0.0.0,$dist_tags"',
      'OPENCLAW_NPM_REGISTRY_DIST_TAGS="$dist_tags"',
      'export NPM_CONFIG_REGISTRY="http://127.0.0.1:$(cat "$port_file")"',
      'export npm_config_registry="$NPM_CONFIG_REGISTRY"',
    ]);
    expect(runner).not.toContain("PREPUBLISH_PLUGIN_REGISTRY_MANIFEST=");
    expect(publishedRunner).not.toContain("PREPUBLISH_PLUGIN_REGISTRY_MANIFEST=");
  });

  it("starts the upgrade survivor plugin registry before updates with scenario-owned config", () => {
    const runner = readFileSync(UPGRADE_SURVIVOR_DOCKER_E2E_PATH, "utf8");
    const publishedRunner = readFileSync(UPGRADE_SURVIVOR_RUN_SCRIPT, "utf8");
    const updateRestartAuth = readFileSync(UPGRADE_SURVIVOR_UPDATE_RESTART_AUTH_PATH, "utf8");

    const runnerPluginRegistryIndex = runner.indexOf("\nconfigure_plugin_registry\n");
    const runnerCompanionInstallIndex = runner.indexOf("\ninstall_companion_plugins\n");
    const runnerUpdateIndex = runner.indexOf(
      '\necho "Running package update against the mounted tarball..."\n',
    );
    expect(runnerPluginRegistryIndex).toBeLessThan(runnerCompanionInstallIndex);
    expect(runnerCompanionInstallIndex).toBeLessThan(runnerUpdateIndex);
    expect(
      publishedRunner.indexOf("phase configure-plugin-registry configure_plugin_registry"),
    ).toBeLessThan(publishedRunner.indexOf("phase update-candidate update_candidate"));
    const runnerClawHubIndex = runner.indexOf("\nconfigure_clawhub_fixture\n");
    const runnerPrepareIndex = runner.indexOf(
      'prepare_update_restart_probe_current_install "$PORT" "$GATEWAY_LOG"',
    );
    expect(runnerClawHubIndex).toBeGreaterThan(-1);
    expect(runnerClawHubIndex).toBeLessThan(runnerPluginRegistryIndex);
    expect(runnerPluginRegistryIndex).toBeLessThan(runnerCompanionInstallIndex);
    expect(runnerCompanionInstallIndex).toBeLessThan(runnerPrepareIndex);
    expect(runnerPrepareIndex).toBeLessThan(runnerUpdateIndex);
    const publishedClawHubIndex = publishedRunner.indexOf(
      "phase configure-clawhub-fixture configure_clawhub_fixture",
    );
    const publishedPrepareIndex = publishedRunner.indexOf(
      "phase prepare-update-restart-probe prepare_update_restart_probe",
    );
    const publishedPluginRegistryIndex = publishedRunner.indexOf(
      "phase configure-plugin-registry configure_plugin_registry",
    );
    expect(publishedClawHubIndex).toBeGreaterThan(-1);
    expect(publishedClawHubIndex).toBeLessThan(publishedPrepareIndex);
    expect(publishedPrepareIndex).toBeLessThan(publishedPluginRegistryIndex);
    expect(publishedPluginRegistryIndex).toBeLessThan(
      publishedRunner.indexOf("phase update-candidate update_candidate"),
    );
    expect(publishedRunner.indexOf("phase update-candidate update_candidate")).toBeLessThan(
      publishedRunner.indexOf("phase assert-prepublish-requests assert_prepublish_plugin_install"),
    );
    expect(publishedRunner).toContain(
      "run_plugin_fixture_phase assert-prepublish-requests assert_prepublish_plugin_install 1",
    );
    expect(publishedRunner).toContain(
      "phase assert-prepublish-recovery-requests assert_prepublish_plugin_install",
    );
    expect(publishedRunner).not.toContain("assert-prepublish-idle");
    expect(publishedRunner).not.toContain("assert-prepublish-recovery-idle");
    expect(publishedRunner).not.toContain('if [ "$candidate_version" = "2026.6.35" ]; then');
    expect(publishedRunner).toContain(
      'local tarball="$fixture_root/openclaw-brave-plugin-${candidate_version}.tgz"',
    );
    expect(publishedRunner).toContain('FIXTURE_PACKAGE_VERSION="$candidate_version"');
    expect(publishedRunner).toContain("version,");
    expect(publishedRunner).toContain(
      'registry_args+=("@openclaw/brave-plugin" "$candidate_version" "$tarball")',
    );
    expect(
      publishedRunner.indexOf("phase assert-prepublish-requests assert_prepublish_plugin_install"),
    ).toBeLessThan(publishedRunner.indexOf("phase doctor run_doctor"));
    const discordInstallIndex = runner.indexOf(
      'openclaw_e2e_fixture_plugin_command openclaw -- \\\n    plugins install "npm:@openclaw/discord@$package_version" --pin',
    );
    const whatsappInstallIndex = runner.indexOf(
      'openclaw_e2e_fixture_plugin_command openclaw -- \\\n      plugins install "clawhub:@openclaw/whatsapp@$package_version"',
    );
    const clawhubRequestIndex = runner.indexOf(
      'assert-prepublish-requests "$OPENCLAW_CLAWHUB_URL" "@openclaw/whatsapp" "$package_version"',
    );
    const codexInstallIndex = runner.indexOf(
      'openclaw_e2e_fixture_plugin_command openclaw -- \\\n      plugins install "npm:@openclaw/codex@$package_version" --pin',
    );
    expect(discordInstallIndex).toBeGreaterThan(-1);
    expect(discordInstallIndex).toBeLessThan(whatsappInstallIndex);
    expect(whatsappInstallIndex).toBeLessThan(clawhubRequestIndex);
    expect(clawhubRequestIndex).toBeLessThan(codexInstallIndex);
    expect(
      runner.match(/openclaw_e2e_fixture_plugin_command openclaw -- \\\n\s+plugins install/gu),
    ).toHaveLength(3);
    expect(runner).not.toContain("--accept-capabilities");
    expect(runner).toContain('park-companion-install "$OPENCLAW_CONFIG_PATH" "$authored_config"');
    expectTextToIncludeAll(runner, [
      "install_status=$?",
      "restore_status=$?",
      'if [ "$install_status" -ne 0 ]; then',
      'return "$install_status"',
      'if [ "$restore_status" -ne 0 ]; then',
      'return "$restore_status"',
    ]);
    expect(runner).toContain('if [ "$SCENARIO" = "feishu-channel" ]; then');
    expect(publishedRunner).toContain('if [ "$SCENARIO" = "feishu-channel" ]; then');
    expect(publishedRunner).toContain(
      [
        'if [ "$SCENARIO" = "configured-plugin-installs" ] || [ "$SCENARIO" = "sqlite-volume" ]; then',
        '  export MATRIX_ACCESS_TOKEN="upgrade-survivor-matrix-token"',
        '  export BRAVE_API_KEY="BSA_upgrade_survivor_brave_key"',
        "fi",
      ].join("\n"),
    );
    expect(publishedRunner).toContain(
      [
        'if [ "$SCENARIO" = "watchos-direct-node" ] || [ "$SCENARIO" = "mobile-pairing-reconnect" ]; then',
        "  unset OPENAI_API_KEY DISCORD_BOT_TOKEN TELEGRAM_BOT_TOKEN",
        "else",
        '  export OPENAI_API_KEY="sk-openclaw-upgrade-survivor"',
        '  export DISCORD_BOT_TOKEN="upgrade-survivor-discord-token"',
        '  export TELEGRAM_BOT_TOKEN="123456:upgrade-survivor-telegram-token"',
        "fi",
      ].join("\n"),
    );
    expect(runner).toContain(
      [
        'if [ "$SCENARIO" = "configured-plugin-installs" ] || [ "$SCENARIO" = "sqlite-volume" ]; then',
        '  export BRAVE_API_KEY="BSA_upgrade_survivor_brave_key"',
        "fi",
      ].join("\n"),
    );
    for (const script of [runner, publishedRunner]) {
      expectTextToIncludeAll(script, [
        "prepublish-artifacts",
        "prepublish-plugin-registry.json",
        "unset OPENCLAW_CLAWHUB_URL CLAWHUB_URL",
        'export OPENCLAW_CLAWHUB_URL="http://127.0.0.1:$(cat "$port_file")"',
        'openclaw_e2e_stop_process "${clawhub_fixture_pid:-}"',
      ]);
      expect(script).not.toContain("CLAWHUB_EXPECTED_VERSION");
      expect(script).not.toContain("/__fixture__/requests");
      expect(script).not.toContain("https://clawhub.ai");
      const fixtureDirectoryIndex = script.indexOf('mkdir -p "$fixture_root"');
      const registryStartIndex = script.indexOf("openclaw_prepublish_plugin_registry_start");
      expect(fixtureDirectoryIndex).toBeGreaterThanOrEqual(0);
      expect(registryStartIndex).toBeGreaterThanOrEqual(0);
      expect(fixtureDirectoryIndex).toBeLessThan(registryStartIndex);
      expect(script).not.toContain('\nexport FEISHU_APP_SECRET="upgrade-survivor-feishu-secret"\n');
    }
    expectTextToIncludeAll(publishedRunner, [
      "park-restart-probe",
      "assert_prepublish_fixture_idle",
      "assert-no-requests",
      "config-parking.mjs",
      "'^(GATEWAY_AUTH_TOKEN_REF|OPENCLAW_CLAWHUB_URL)='",
      "OPENCLAW_CLAWHUB_URL=%s",
    ]);
    for (const script of [runner, updateRestartAuth]) {
      expect(script).not.toContain("assert-no-requests");
    }
    expect(updateRestartAuth).toContain("park-restart-probe");
    expect(updateRestartAuth).toContain('"$OPENCLAW_CONFIG_PATH"');
    expect(publishedRunner).not.toContain(
      '\nexport MATRIX_ACCESS_TOKEN="upgrade-survivor-matrix-token"\n',
    );
    expect(publishedRunner).not.toContain(
      '\nexport BRAVE_API_KEY="BSA_upgrade_survivor_brave_key"\n',
    );
    expect(runner).not.toContain('\nexport BRAVE_API_KEY="BSA_upgrade_survivor_brave_key"\n');
    expect(runner).toContain(
      'source "$HARNESS_ROOT_DIR/scripts/e2e/lib/prepublish-plugin-registry.sh"',
    );
    expect(runner).toContain("openclaw_prepublish_plugin_registry_configure_docker_args");
    expect(runner).not.toContain("configure_prepublish_plugin_registry()");
    expect(
      runner.match(
        /-v "\$HARNESS_ROOT_DIR\/scripts\/e2e\/lib\/clawhub-fixture-server\.cjs:\/tmp\/openclaw-clawhub-fixture-server\.cjs:ro"/gu,
      ),
    ).toHaveLength(2);
    expect(
      runner.match(
        /-e OPENCLAW_UPGRADE_SURVIVOR_CLAWHUB_FIXTURE_SERVER=\/tmp\/openclaw-clawhub-fixture-server\.cjs/gu,
      ),
    ).toHaveLength(2);
    expect(
      runner.match(
        /-v "\$HARNESS_ROOT_DIR\/scripts\/e2e\/lib\/upgrade-survivor\/config-parking\.mjs:\/tmp\/openclaw-config-parking\.mjs:ro"/gu,
      ),
    ).toHaveLength(2);
    expect(
      runner.match(
        /-e OPENCLAW_UPGRADE_SURVIVOR_CONFIG_PARKING_HELPER=\/tmp\/openclaw-config-parking\.mjs/gu,
      ),
    ).toHaveLength(2);
  });

  it("keeps upgrade survivor wrappers and the embedded payload valid bash", () => {
    for (const path of [UPGRADE_SURVIVOR_DOCKER_E2E_PATH, UPGRADE_SURVIVOR_RUN_SCRIPT]) {
      const result = spawnSync("bash", ["-n", path], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
    }
    const wrapper = readFileSync(UPGRADE_SURVIVOR_DOCKER_E2E_PATH, "utf8");
    const inner = spawnSync("bash", ["-n"], {
      input: extractUpgradeSurvivorPayload(wrapper),
      encoding: "utf8",
    });
    expect(inner.status, inner.stderr).toBe(0);
  });

  it("routes staged live suites through the candidate entrypoint resolver", () => {
    for (const scriptPath of [
      "scripts/test-live-acp-bind-docker.sh",
      "scripts/test-live-cli-backend-docker.sh",
      "scripts/test-live-codex-harness-docker.sh",
      "scripts/test-live-gateway-models-docker.sh",
      "scripts/test-live-models-docker.sh",
      "scripts/test-live-subagent-announce-docker.sh",
    ]) {
      const script = readFileSync(scriptPath, "utf8");

      expect(script).toContain("openclaw_live_run_staged_script scripts/test-live --");
      expect(script).not.toContain("node --import tsx scripts/test-live.mts --");
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

  it("preserves actionable, secret-safe typed onboarding failure diagnostics", () => {
    const script = readFileSync(RELEASE_TYPED_ONBOARDING_SCENARIO_PATH, "utf8");
    expect(script).toContain("set -Eeuo pipefail");
    expect(script).toContain("{ exec 3>&-; } 2>/dev/null || true");
    expect(script).toContain("--suppress-gateway-token-output");
    expect(script).not.toContain("exec 3>&- 2>/dev/null || true");
    expect(script).not.toContain('"$HOME/.openclaw/agents/main/agent/auth-profiles.json"');
  });

  it("prints channel-add failures through the shared E2E logger", () => {
    const script = readFileSync(NPM_ONBOARD_CHANNEL_AGENT_DOCKER_E2E_PATH, "utf8");
    expect(script).toContain(
      'openclaw_e2e_run_logged channel-add "$OPENCLAW_E2E_CLI_BIN" channels add --channel "$CHANNEL" "${CHANNEL_ADD_ARGS[@]}"',
    );
    expect(script).not.toContain("/tmp/openclaw-channel-add.log");
  });

  it("runs an authorized frozen target's shipped typed-onboarding journey", () => {
    const runner = readFileSync(RELEASE_TYPED_ONBOARDING_DOCKER_E2E_PATH, "utf8");

    expectTextToIncludeAll(runner, [
      'openclaw_resolve_frozen_core_harness_capabilities "$TARGET_ROOT_DIR"',
      'openclaw_resolve_frozen_target_file "$TARGET_ROOT_DIR"',
      "scripts/e2e/lib/release-typed-onboarding/scenario.sh",
      '-v "$SCENARIO_PATH:/app/scripts/e2e/lib/release-typed-onboarding/scenario.sh:ro"',
    ]);
  });

  it("keeps real-TTY onboarding drivers aligned with the guided prompt sequence", () => {
    expectOrderedScriptFragments(readFileSync(RELEASE_TYPED_ONBOARDING_SCENARIO_PATH, "utf8"), [
      'wait_for_log "Continue?"',
      "send $'y\\r'",
      'wait_for_log "Help make OpenClaw better?"',
      "send $'\\r'",
      'wait_for_log "What should we call your first agent?"',
      "send $'\\r'",
      'wait_for_log "to search"',
      "send $'ollama\\r'",
    ]);
    expectOrderedScriptFragments(readFileSync(ONBOARD_SCENARIO_PATH, "utf8"), [
      'wait_for_log "Help make OpenClaw better?"',
      "send $'\\r'",
      'wait_for_log "What should we call your first agent?"',
      "send $'\\r'",
      'wait_for_log "How should I set things up?"',
      "send $'\\r'",
      'wait_for_log "Model/auth provider"',
      "send $'\\r'",
      'wait_for_log "Use which detected AI?"',
      "send $'\\r'",
    ]);
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
      'ROOT_DIR="$(cd "${OPENCLAW_DOCKER_E2E_REPO_ROOT:-$HARNESS_ROOT_DIR}" && pwd)"',
    );
    expect(upgradeSurvivor).toContain('DOCKER_E2E_HARNESS_ROOT_DIR="$HARNESS_ROOT_DIR"');
    expect(upgradeSurvivor).toContain(
      '-v "$HARNESS_ROOT_DIR/scripts/e2e/lib/upgrade-survivor/run.sh:/tmp/openclaw-upgrade-survivor-run.sh:ro"',
    );
    expect(upgradeSurvivor).toContain(
      'timeout --kill-after=30s "$DOCKER_RUN_TIMEOUT" bash /tmp/openclaw-upgrade-survivor-run.sh',
    );
    expect(upgradeSurvivor).toContain('timeout --kill-after=30s "$DOCKER_RUN_TIMEOUT" bash -lc');
    for (const script of [multiNode, upgradeSurvivor]) {
      expect(script).not.toContain('timeout "$DOCKER_RUN_TIMEOUT"');
    }
  });

  it("propagates HTTP probe failures through command substitution", () => {
    const source = readFileSync(UPGRADE_SURVIVOR_RUN_SCRIPT, "utf8");
    const probeStart = source.indexOf("probe_gateway_endpoint() {");
    const probe = source.slice(probeStart, source.indexOf("\nstart_gateway()", probeStart));
    for (const exitCode of [0, 43]) {
      const result = spawnSync(
        "bash",
        [
          "-c",
          `set -eu
node() {
  if [ "$1" = scripts/e2e/lib/upgrade-survivor/probe-gateway.mjs ]; then
    return "$SURVIVOR_TEST_PROBE_EXIT"
  fi
  command "$SURVIVOR_TEST_NODE" "$@"
}
${probe}
seconds="$(probe_gateway_endpoint /healthz live unused.json)"
printf '%s\\n' "$seconds"
`,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            SURVIVOR_TEST_NODE: process.execPath,
            SURVIVOR_TEST_PROBE_EXIT: String(exitCode),
          },
        },
      );
      expect(result.status, result.stderr).toBe(exitCode);
      if (exitCode === 0) {
        expect(result.stdout).toMatch(/^\d+\n$/);
      } else {
        expect(result.stdout).toBe("");
      }
    }
  });

  it("records an interrupted upgrade survivor phase as failed", async () => {
    const workDir = tempDirs.make("openclaw-upgrade-survivor-signal-");
    const binDir = join(workDir, "bin");
    const markerPath = join(workDir, "npm-started");
    const summaryPath = join(workDir, "artifacts", "summary.json");
    writeExecutables(binDir, {
      npm: `#!/bin/sh
touch "$FAKE_NPM_MARKER"
exec sleep 300
`,
      timeout: `#!/bin/sh
while [ "\${1#--}" != "$1" ]; do shift; done
shift
exec "$@"
`,
    });

    const child = spawn("bash", [UPGRADE_SURVIVOR_RUN_SCRIPT], {
      detached: true,
      env: {
        ...process.env,
        FAKE_NPM_MARKER: markerPath,
        OPENCLAW_TEST_STATE_FUNCTION_B64: Buffer.from(
          "openclaw_test_state_create() { :; }",
        ).toString("base64"),
        OPENCLAW_UPGRADE_SURVIVOR_BASELINE: "openclaw@2026.7.1-2",
        OPENCLAW_UPGRADE_SURVIVOR_CANDIDATE_SPEC: join(workDir, "unused.tgz"),
        OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT: join(workDir, "runtime"),
        OPENCLAW_UPGRADE_SURVIVOR_STATE_HOME_ROOT: join(workDir, "state-home"),
        OPENCLAW_UPGRADE_SURVIVOR_SUMMARY_JSON: summaryPath,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
      stdio: "ignore",
    });
    const childPid = child.pid;
    if (!childPid) {
      throw new Error("upgrade survivor process did not start");
    }
    const exitPromise = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });

    try {
      for (let attempt = 0; attempt < 500 && !existsSync(markerPath); attempt += 1) {
        await delay(10);
      }
      expect(existsSync(markerPath)).toBe(true);
      process.kill(-childPid, "SIGTERM");
      const exit = await exitPromise;

      expect(exit).toEqual({ code: 143, signal: null });
      const diagnostics = JSON.parse(
        readFileSync(join(workDir, "artifacts", "diagnostics", "raw.json"), "utf8"),
      );
      expect(diagnostics).toMatchObject({
        phase: "install-baseline",
        exitStatus: 143,
        signal: "SIGTERM",
      });
      const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
      expect(summary).toMatchObject({
        failure: {
          message: "phase install-baseline interrupted by SIGTERM",
          phase: "install-baseline",
        },
        status: "failed",
      });
      expect(summary.phases.at(-1)).toMatchObject({
        phase: "install-baseline",
        status: "started",
      });
      expect(
        readFileSync(join(workDir, "artifacts", "baseline-install.log"), "utf8"),
      ).not.toContain("Upgrade survivor summary:");
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        process.kill(-childPid, "SIGKILL");
      }
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
    const workDir = tempDirs.make("openclaw-multi-node-shared-image-");
    writeFileSync(join(workDir, "openclaw-current.tgz"), "fake package");
    writeExecutables(join(workDir, "bin"), {
      docker: `#!/usr/bin/env bash
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
      timeout: `#!/usr/bin/env bash
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
    });

    const script = repoRootShell`
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
  });

  it("bounds upgrade survivor foreground OpenClaw CLI calls", () => {
    const runner = readFileSync(UPGRADE_SURVIVOR_DOCKER_E2E_PATH, "utf8");
    const publishedRunner = readFileSync(UPGRADE_SURVIVOR_RUN_SCRIPT, "utf8");
    const updateRestartAuth = readFileSync(UPGRADE_SURVIVOR_UPDATE_RESTART_AUTH_PATH, "utf8");

    expectTextToIncludeAll(runner, [
      'source "$HARNESS_ROOT_DIR/scripts/lib/openclaw-e2e-instance.sh"',
      'START_BUDGET_SECONDS="$(openclaw_e2e_read_positive_int_env OPENCLAW_UPGRADE_SURVIVOR_START_BUDGET_SECONDS 90)"',
      'STATUS_BUDGET_SECONDS="$(openclaw_e2e_read_positive_int_env OPENCLAW_UPGRADE_SURVIVOR_STATUS_BUDGET_SECONDS 30)"',
      '-e OPENCLAW_UPGRADE_SURVIVOR_START_BUDGET_SECONDS="$START_BUDGET_SECONDS"',
      '-e OPENCLAW_UPGRADE_SURVIVOR_STATUS_BUDGET_SECONDS="$STATUS_BUDGET_SECONDS"',
      'START_BUDGET="$(openclaw_e2e_read_positive_int_env OPENCLAW_UPGRADE_SURVIVOR_START_BUDGET_SECONDS 90)"',
      'STATUS_BUDGET="$(openclaw_e2e_read_positive_int_env OPENCLAW_UPGRADE_SURVIVOR_STATUS_BUDGET_SECONDS 30)"',
      'COMMAND_TIMEOUT="${OPENCLAW_UPGRADE_SURVIVOR_COMMAND_TIMEOUT:-900s}"',
      '-e OPENCLAW_UPGRADE_SURVIVOR_COMMAND_TIMEOUT="$COMMAND_TIMEOUT"',
      'command_timeout="${OPENCLAW_UPGRADE_SURVIVOR_COMMAND_TIMEOUT:-900s}"',
      'openclaw_e2e_maybe_timeout "$command_timeout" env -u OPENCLAW_GATEWAY_TOKEN',
      'openclaw_e2e_maybe_timeout "$command_timeout" openclaw doctor --fix --non-interactive',
      'openclaw_e2e_maybe_timeout "$command_timeout" openclaw config validate',
      'openclaw_e2e_maybe_timeout "$command_timeout" openclaw gateway status',
      'openclaw gateway --port "$PORT" --bind loopback --allow-unconfigured',
      'PROBE_TIMEOUT_MS="$(openclaw_e2e_read_nonnegative_int_env OPENCLAW_UPGRADE_SURVIVOR_PROBE_TIMEOUT_MS 60000)"',
      "openclaw_e2e_read_positive_int_env OPENCLAW_UPGRADE_SURVIVOR_PROBE_ATTEMPT_TIMEOUT_MS 5000",
      "openclaw_e2e_read_positive_int_env OPENCLAW_UPGRADE_SURVIVOR_PROBE_MAX_BODY_BYTES 1048576",
      '-e OPENCLAW_UPGRADE_SURVIVOR_PROBE_TIMEOUT_MS="$PROBE_TIMEOUT_MS"',
      '-e OPENCLAW_UPGRADE_SURVIVOR_PROBE_ATTEMPT_TIMEOUT_MS="$PROBE_ATTEMPT_TIMEOUT_MS"',
      '-e OPENCLAW_UPGRADE_SURVIVOR_PROBE_MAX_BODY_BYTES="$PROBE_MAX_BODY_BYTES"',
      "readyz_probe_args=(",
      'readyz_probe_args+=(--allow-failing "$OPENCLAW_UPGRADE_SURVIVOR_READYZ_ALLOW_FAILING")',
      "readyz_probe_args+=(--allow-degraded-ready)",
      'node scripts/e2e/lib/upgrade-survivor/probe-gateway.mjs "${readyz_probe_args[@]}"',
      "OPENCLAW_UPGRADE_SURVIVOR_READYZ_ALLOW_FAILING",
      "OPENCLAW_UPGRADE_SURVIVOR_READYZ_ALLOW_DEGRADED",
    ]);

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
      'openclaw_e2e_maybe_timeout "$COMMAND_TIMEOUT" openclaw update repair',
    );
    expect(publishedRunner).toContain("--accept-capabilities --yes --no-restart --json");
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
    expectTextToIncludeAll(updateRestartAuth, [
      "command=(env -u OPENCLAW_GATEWAY_TOKEN -u OPENCLAW_GATEWAY_PASSWORD openclaw gateway install --force --json)",
      'openclaw_e2e_maybe_timeout "$command_timeout" "${command[@]}"',
    ]);
  });

  it.skipIf(process.platform !== "linux").each(["published", "current"])(
    "starts the %s auth probe under the manager that owns its restart and stop",
    async (lane) => {
      const workDir = tempDirs.make("survivor-managed-probe-");
      const artifacts = join(workDir, "artifacts");
      const stateDir = join(workDir, "state");
      mkdirSync(artifacts);
      mkdirSync(stateDir);
      const configPath = join(stateDir, "openclaw.json");
      const authored = '{"gateway":{"mode":"local","port":18789},"channels":{"whatsapp":{}}}\n';
      writeFileSync(configPath, authored);
      const childPath = join(workDir, "listener.mjs");
      const startsPath = join(workDir, "starts.jsonl");
      const portPath = join(workDir, "port");
      writeFileSync(
        childPath,
        `import fs from "node:fs";
import http from "node:http";
const identity = { pid: process.pid, managed: process.env.OPENCLAW_SYSTEMD_UNIT === "openclaw-gateway.service" };
const server = http.createServer((_req, res) => res.end(JSON.stringify(identity)));
const port = fs.existsSync(process.env.PORT_FILE) ? Number(fs.readFileSync(process.env.PORT_FILE, "utf8")) : 0;
server.listen(port, "127.0.0.1", () => {
  fs.writeFileSync(process.env.PORT_FILE, String(server.address().port));
  fs.appendFileSync(process.env.STARTS_FILE, JSON.stringify(identity) + "\\n");
  console.log("[gateway] ready on 127.0.0.1:" + server.address().port);
});
`,
      );
      const executable = join(workDir, "bin", "openclaw");
      const stagedUnit = join(workDir, "staged.service");
      writeFileSync(
        stagedUnit,
        buildSystemdUnit({
          programArguments: [process.execPath, executable, "gateway"],
          environment: { OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway.service" },
        }),
      );
      writeExecutables(join(workDir, "bin"), {
        openclaw: `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path"), { spawn, spawnSync } = require("node:child_process");
if (process.argv[2] === "doctor") process.exit(0);
if (process.argv[3] === "install") {
  const unit = path.join(process.env.HOME, ".config/systemd/user/openclaw-gateway.service");
  fs.mkdirSync(path.dirname(unit), { recursive: true });
  fs.copyFileSync(process.env.STAGED_UNIT, unit);
  for (const args of [["daemon-reload"], ["enable", "openclaw-gateway.service"], ["restart", "openclaw-gateway.service"]]) {
    const result = spawnSync("systemctl", ["--user", ...args], { stdio: "inherit" });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  process.exit(0);
}
const child = spawn(process.execPath, [process.env.LISTENER_SCRIPT], { stdio: "inherit" });
child.once("exit", () => process.exit(0));
// A wrapper exit must not strand the listening child outside its service owner.
process.on("SIGTERM", () => {
  if (!process.env.OPENCLAW_SYSTEMD_UNIT) process.exit(0);
});
`,
      });
      const env = {
        ...process.env,
        HOME: workDir,
        PATH: `${join(workDir, "bin")}:${process.env.PATH}`,
        npm_config_prefix: workDir,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_UPGRADE_SURVIVOR_BASELINE: "openclaw@2026.3.13",
        OPENCLAW_UPGRADE_SURVIVOR_UPDATE_RESTART_MODE: "auto-auth",
        OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT: join(workDir, "runtime"),
        OPENCLAW_UPGRADE_SURVIVOR_SUMMARY_JSON: join(artifacts, "summary.json"),
        OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE: join(artifacts, "systemctl-shim.pid"),
        OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_LOG: join(artifacts, "systemctl-shim.log"),
        OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_DAEMON_LOG: join(
          artifacts,
          "systemctl-shim-gateway.log",
        ),
        OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SERVICE_INSTALL_JSON: join(artifacts, "install.json"),
        OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SERVICE_INSTALL_ERR: join(artifacts, "install.err"),
        OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR: join(workDir, "registry"),
        GATEWAY_AUTH_TOKEN_REF: "survivor-fixture-token",
        STAGED_UNIT: stagedUnit,
        LISTENER_SCRIPT: childPath,
        STARTS_FILE: startsPath,
        PORT_FILE: portPath,
      };
      const source = readFileSync(UPGRADE_SURVIVOR_RUN_SCRIPT, "utf8");
      const setup =
        lane === "published"
          ? source.slice(0, source.indexOf("phase storage-preflight"))
          : `source ${shellQuote(OPENCLAW_E2E_INSTANCE_HELPER_PATH)}\nsource ${shellQuote(UPGRADE_SURVIVOR_UPDATE_RESTART_AUTH_PATH)}`;
      const script = `${setup}
trap - EXIT ERR INT TERM
assert_prepublish_fixture_idle() { :; }
assert_baseline_state() { :; }
check_gateway_status() { :; }
# This fixture chooses an ephemeral port; retain the actual readiness implementation.
eval "$(declare -f openclaw_e2e_wait_gateway_ready | sed '1s/openclaw_e2e_wait_gateway_ready/fixture_wait_gateway_ready/')"
openclaw_e2e_wait_gateway_ready() {
  for _ in {1..200}; do [ -s "$PORT_FILE" ] && break; sleep 0.01; done
  fixture_wait_gateway_ready "$1" "$2" 20 "$(cat "$PORT_FILE")" "\${5:-strict}"
}
${lane === "published" ? "prepare_update_restart_probe" : 'prepare_update_restart_probe_current_install 18789 "$OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_DAEMON_LOG"'}
`;
      const systemctlPath = join(
        lane === "published" ? join(artifacts, "npm-prefix") : workDir,
        "bin",
        "systemctl",
      );
      const systemctl = (...args: string[]) =>
        spawnSync(systemctlPath, ["--user", ...args], {
          env,
          encoding: "utf8",
          timeout: 40_000,
        });
      const records = (): Array<{ pid: number; managed: boolean }> =>
        existsSync(startsPath)
          ? readFileSync(startsPath, "utf8")
              .split("\n")
              .slice(0, -1)
              .filter(Boolean)
              .map((line) => JSON.parse(line))
          : [];
      try {
        const result = spawnSync("bash", ["-c", script], {
          env,
          encoding: "utf8",
          timeout: 45_000,
        });
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(readFileSync(configPath, "utf8")).toBe(authored);
        const url = `http://127.0.0.1:${readFileSync(portPath, "utf8")}/readyz`;
        if (lane === "published") {
          expect(systemctl("is-active", "openclaw-gateway.service").status).toBe(3);
          expect(records()).toHaveLength(1);
          expect(isProcessRunning(records()[0]!.pid)).toBe(false);
          await expect(fetch(url, { signal: AbortSignal.timeout(1_000) })).rejects.toThrow();
          expect(systemctl("start", "openclaw-gateway.service").status).toBe(0);
          for (let attempt = 0; attempt < 200 && records().length < 2; attempt++) {
            await delay(10);
          }
          expect(records()).toHaveLength(2);
        }
        const initial = (await (
          await fetch(url, { signal: AbortSignal.timeout(1_000) })
        ).json()) as { pid: number; managed: boolean };
        expect(initial.managed).toBe(true);
        expect(systemctl("restart", "openclaw-gateway.service").status).toBe(0);
        const expectedStarts = lane === "published" ? 3 : 2;
        for (let attempt = 0; attempt < 200 && records().length < expectedStarts; attempt++) {
          await delay(10);
        }
        expect(records()).toHaveLength(expectedStarts);
        const replacement = (await (
          await fetch(url, { signal: AbortSignal.timeout(1_000) })
        ).json()) as { pid: number; managed: boolean };
        expect(replacement.managed).toBe(true);
        expect(replacement.pid).not.toBe(initial.pid);
        expect(isProcessRunning(initial.pid)).toBe(false);
        expect(systemctl("stop", "openclaw-gateway.service").status).toBe(0);
        await expect(fetch(url, { signal: AbortSignal.timeout(1_000) })).rejects.toThrow();
      } finally {
        systemctl("stop", "openclaw-gateway.service");
        for (const { pid } of records()) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        }
      }
    },
    60_000,
  );

  it("returns the gateway readiness failure when startup is called conditionally", () => {
    const workDir = tempDirs.make("survivor-start-failure-");
    writeExecutables(join(workDir, "bin"), { openclaw: "#!/bin/sh\nexit 17\n" });
    const source = readFileSync(UPGRADE_SURVIVOR_RUN_SCRIPT, "utf8");
    const start = source.slice(
      source.indexOf("start_gateway() {"),
      source.indexOf("\nensure_gateway_started()"),
    );
    const result = spawnSync(
      "bash",
      [
        "-c",
        repoShell(workDir)`
export PATH="$TMPDIR/bin:$PATH"
source "$ROOT_DIR/${OPENCLAW_E2E_INSTANCE_HELPER_PATH}"
GATEWAY_LOG="$TMPDIR/gateway.log"
UPDATE_RESTART_MODE=manual
${start}
trap 'kill "$gateway_pid" 2>/dev/null || true; wait "$gateway_pid" 2>/dev/null || true' EXIT
start_status=0
start_gateway || start_status=$?
exit "$start_status"
`,
      ],
      { encoding: "utf8" },
    );
    expect(result.status, result.stdout + result.stderr).toBe(1);
  });

  it("scopes candidate setup Doctor markers without creating legacy device identities", () => {
    const workDir = tempDirs.make("openclaw-upgrade-survivor-doctor-env-");
    writeExecutables(join(workDir, "bin"), {
      openclaw: `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$@" >"$CAPTURE_DIR/doctor-argv"
{
  printf 'OPENCLAW_UPDATE_IN_PROGRESS=%s\\n' "\${OPENCLAW_UPDATE_IN_PROGRESS-unset}"
  printf 'OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR=%s\\n' "\${OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR-unset}"
  printf 'OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE=%s\\n' "\${OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE-unset}"
} >"$CAPTURE_DIR/doctor-env"
exit 23
`,
    });

    const script = repoShell(workDir)`
export PATH="$TMPDIR/bin:$PATH"
export CAPTURE_DIR="$TMPDIR"
export OPENCLAW_STATE_DIR="$TMPDIR/state"
export OPENCLAW_CONFIG_PATH="$OPENCLAW_STATE_DIR/openclaw.json"
export OPENCLAW_UPGRADE_SURVIVOR_CONFIG_PARKING_HELPER="$ROOT_DIR/${UPGRADE_SURVIVOR_CONFIG_PARKING_PATH}"
mkdir -p "$OPENCLAW_STATE_DIR"
printf '%s\n' '{"gateway":{"mode":"local"}}' >"$OPENCLAW_CONFIG_PATH"
unset OPENCLAW_UPDATE_IN_PROGRESS
unset OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR
unset OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE
source "$ROOT_DIR/${OPENCLAW_E2E_INSTANCE_HELPER_PATH}"
source "$ROOT_DIR/${UPGRADE_SURVIVOR_UPDATE_RESTART_AUTH_PATH}"
install_update_restart_systemctl_shim() { :; }
openclaw_e2e_maybe_timeout() {
  shift
  "$@"
}
if prepare_update_restart_probe_current_install 18789 "$TMPDIR/gateway.log" >/dev/null 2>&1; then
  echo "doctor unexpectedly succeeded" >&2
  exit 3
fi
{
  printf 'OPENCLAW_UPDATE_IN_PROGRESS=%s\\n' "\${OPENCLAW_UPDATE_IN_PROGRESS-unset}"
  printf 'OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR=%s\\n' "\${OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR-unset}"
  printf 'OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE=%s\\n' "\${OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE-unset}"
} >"$CAPTURE_DIR/parent-env"
`;

    const result = spawnSync("bash", ["-lc", script], { encoding: "utf8" });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    for (const file of [
      "identity/device.json",
      "identity/device-auth.json",
      "devices/paired.json",
      "devices/pending.json",
    ]) {
      expect(existsSync(join(workDir, "state", file)), file).toBe(false);
    }
    expect(readFileSync(join(workDir, "doctor-argv"), "utf8").trimEnd().split("\n")).toEqual([
      "doctor",
      "--fix",
      "--non-interactive",
    ]);
    expect(readFileSync(join(workDir, "doctor-env"), "utf8")).toBe(
      [
        "OPENCLAW_UPDATE_IN_PROGRESS=1",
        "OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR=1",
        "OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE=1",
        "",
      ].join("\n"),
    );
    expect(readFileSync(join(workDir, "parent-env"), "utf8")).toBe(
      [
        "OPENCLAW_UPDATE_IN_PROGRESS=unset",
        "OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR=unset",
        "OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE=unset",
        "",
      ].join("\n"),
    );
  });

  it.each([
    ["doctor", 41],
    ["readiness", 42],
    ["service-env", 43],
    ["install", 44],
  ] as const)(
    "restores the canonical authored config after %s failure",
    (failureStage, expectedStatus) => {
      const workDir = tempDirs.make(`openclaw-upgrade-survivor-${failureStage}-failure-`);
      writeExecutables(join(workDir, "bin"), {
        openclaw: `#!/usr/bin/env bash
set -euo pipefail
printf '%s %s\n' "$OPENCLAW_CONFIG_PATH" "$*" >>"$CAPTURE_DIR/openclaw-calls"
if [ "\${1:-}" = doctor ]; then
  [ "$FAILURE_STAGE" != doctor ] || exit 41
  exit 0
fi
if [ "\${1:-}" = gateway ] && [ "\${2:-}" = install ]; then
  [ "$FAILURE_STAGE" != install ] || exit 44
  sleep 30 >/dev/null 2>&1 &
  printf '%s\\n' "$!" >"$OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE"
  exit 0
fi
exec sleep 30
`,
      });

      const script = repoShell(workDir)`
export PATH="$TMPDIR/bin:$PATH"
export CAPTURE_DIR="$TMPDIR"
export FAILURE_STAGE="${failureStage}"
export OPENCLAW_STATE_DIR="$TMPDIR/state"
export OPENCLAW_CONFIG_PATH="$OPENCLAW_STATE_DIR/openclaw.json"
export OPENCLAW_UPGRADE_SURVIVOR_CONFIG_PARKING_HELPER="$ROOT_DIR/${UPGRADE_SURVIVOR_CONFIG_PARKING_PATH}"
export OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE="$TMPDIR/gateway.pid"
export OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_DAEMON_LOG="$TMPDIR/service.log"
export OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SERVICE_INSTALL_JSON="$TMPDIR/install.json"
export OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SERVICE_INSTALL_ERR="$TMPDIR/install.err"
export GATEWAY_AUTH_TOKEN_REF=upgrade-survivor-token
mkdir -p "$OPENCLAW_STATE_DIR"
authored_config='{"channels":{"discord":{"dm":{"policy":"allowlist","allowFrom":["123"]}}}}'
printf '%s\n' "$authored_config" >"$OPENCLAW_CONFIG_PATH"
source "$ROOT_DIR/${OPENCLAW_E2E_INSTANCE_HELPER_PATH}"
source "$ROOT_DIR/${UPGRADE_SURVIVOR_UPDATE_RESTART_AUTH_PATH}"
install_update_restart_systemctl_shim() { :; }
openclaw_e2e_maybe_timeout() {
  shift
  "$@"
}
openclaw_e2e_wait_gateway_ready() {
  [ "$FAILURE_STAGE" != readiness ] || return 42
}
write_update_restart_service_auth_env() {
  [ "$FAILURE_STAGE" != service-env ] || return 43
}
status=0
prepare_update_restart_probe_current_install 18789 "$TMPDIR/gateway.log" >/dev/null 2>&1 || status=$?
printf '%s\n' "$status" >"$CAPTURE_DIR/status"
cmp -s "$OPENCLAW_CONFIG_PATH" <(printf '%s\n' "$authored_config")
[ ! -e "$TMPDIR/gateway.log.authored-config" ]
if [ -n "\${gateway_pid:-}" ]; then
  kill "$gateway_pid" >/dev/null 2>&1 || true
  wait "$gateway_pid" >/dev/null 2>&1 || true
fi
`;

      const result = spawnSync("bash", ["-lc", script], { encoding: "utf8" });

      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(join(workDir, "status"), "utf8")).toBe(`${expectedStatus}\n`);
      const calls = readFileSync(join(workDir, "openclaw-calls"), "utf8");
      expect(calls).toContain(join(workDir, "state", "openclaw.json"));
      expect(calls).not.toContain("OPENCLAW_CONFIG_PATH=");
    },
  );

  it("prefers restore failure and retains the authored config snapshot", () => {
    const workDir = tempDirs.make("openclaw-upgrade-survivor-restore-failure-");
    writeExecutables(join(workDir, "bin"), {
      openclaw: `#!/usr/bin/env bash
set -euo pipefail
exit 41
`,
      "config-parking-wrapper.mjs": `import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
if (args[0] === "restore") {
  process.exit(57);
}
const result = spawnSync(
  process.execPath,
  [process.env.REAL_CONFIG_PARKING_HELPER, ...args],
  { stdio: "inherit", env: process.env },
);
process.exit(result.status ?? 1);
`,
    });

    const script = repoShell(workDir)`
export PATH="$TMPDIR/bin:$PATH"
export OPENCLAW_STATE_DIR="$TMPDIR/state"
export OPENCLAW_CONFIG_PATH="$OPENCLAW_STATE_DIR/openclaw.json"
export REAL_CONFIG_PARKING_HELPER="$ROOT_DIR/${UPGRADE_SURVIVOR_CONFIG_PARKING_PATH}"
export OPENCLAW_UPGRADE_SURVIVOR_CONFIG_PARKING_HELPER="$TMPDIR/bin/config-parking-wrapper.mjs"
mkdir -p "$OPENCLAW_STATE_DIR"
printf '%s\n' '{"channels":{"discord":{"dm":{"policy":"allowlist"}}}}' >"$OPENCLAW_CONFIG_PATH"
source "$ROOT_DIR/${OPENCLAW_E2E_INSTANCE_HELPER_PATH}"
source "$ROOT_DIR/${UPGRADE_SURVIVOR_UPDATE_RESTART_AUTH_PATH}"
install_update_restart_systemctl_shim() { :; }
openclaw_e2e_maybe_timeout() {
  shift
  "$@"
}
status=0
prepare_update_restart_probe_current_install 18789 "$TMPDIR/gateway.log" >/dev/null 2>&1 || status=$?
printf '%s\n' "$status" >"$TMPDIR/status"
`;

    const result = spawnSync("bash", ["-lc", script], { encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(workDir, "status"), "utf8")).toBe("57\n");
    expect(existsSync(join(workDir, "gateway.log.authored-config"))).toBe(true);
    expect(JSON.parse(readFileSync(join(workDir, "state", "openclaw.json"), "utf8"))).toEqual({
      plugins: { enabled: false },
      gateway: expect.objectContaining({ reload: { mode: "off" } }),
    });
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

  it("models systemd restart supervision in update-restart auth fixtures", () => {
    const runner = readFileSync(UPGRADE_SURVIVOR_DOCKER_E2E_PATH, "utf8");
    const publishedRunner = readFileSync(UPGRADE_SURVIVOR_RUN_SCRIPT, "utf8");
    const updateRestartAuth = readFileSync(UPGRADE_SURVIVOR_UPDATE_RESTART_AUTH_PATH, "utf8");

    for (const script of [updateRestartAuth]) {
      expectTextToIncludeAll(script, [
        'supervisor_script="${pid_file}.supervisor.mjs"',
        'OPENCLAW_SYSTEMCTL_SHIM_EXEC_START="$exec_start"',
        'if (key.startsWith("OPENCLAW_UPDATE_")) {',
        "delete childEnv.OPENCLAW_COMPATIBILITY_HOST_VERSION;",
        'process.on("SIGTERM", stop);',
        "const stopTimeoutMs = 30_000;",
        "process.kill(-pid, signal);",
        'signalProcessGroup(pid, "SIGTERM");',
        'signalProcessGroup(pid, "SIGKILL");',
        "drainProcessGroup(childGroupPid, () => {",
        "detached: true,",
        "if (code === 78) return finish();",
        "const restartDelayMs = 5_000;",
        "const restartWindowMs = 60_000;",
        "const restartBurst = 5;",
        "if (starts.length >= restartBurst) {",
        "setTimeout(start, restartDelayMs);",
        "for _ in $(seq 1 350)",
      ]);
    }
    for (const script of [runner, publishedRunner]) {
      expect(script).toContain("systemctl --user stop openclaw-gateway.service");
    }
  });

  it.skipIf(process.platform === "win32")(
    "stops promptly when the systemctl target is a zombie with spaces and parentheses in comm",
    async () => {
      await forEachUpgradeSurvivorSystemctlShim(({ pid, run, scriptPath }) => {
        const procTail = Array.from({ length: 49 }, (_, field) => field + 1).join(" ");
        expect(run("stop", `${pid} (gateway (old) worker) Z ${procTail}`), scriptPath).toBe(0);
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps a killable systemctl target active when proc stat is unreadable or malformed",
    async () => {
      await forEachUpgradeSurvivorSystemctlShim(({ pid, run, scriptPath }) => {
        for (const procStat of [undefined, `${pid} (gateway) Z`]) {
          expect(run("is-active", procStat), `${scriptPath}: ${procStat ?? "unreadable"}`).toBe(0);
        }
      }, process.pid);
    },
  );

  it.each([
    ["warning", 0],
    ["error", 0],
    ["error", 78],
  ] as const)(
    "retains the original post-core %s result separately from exit %i",
    (status, code) => {
      const { workDir, artifacts, resultDir, env, preloadOptions } = survivorPostCoreFixture();
      const result = {
        status,
        changed: false,
        sync: {
          changed: false,
          switchedToBundled: [],
          switchedToNpm: [],
          warnings: [],
          errors: [],
        },
        npm: {
          changed: false,
          outcomes: [
            {
              pluginId: "example",
              status: "error",
              message: "review required token=POST_CORE_SECRET",
              currentVersion: "1.0.0",
              nextVersion: "2.0.0",
            },
          ],
        },
        warnings: [
          {
            pluginId: "example",
            reason: "review required",
            message: "token=POST_CORE_SECRET",
            guidance: [],
          },
        ],
        integrityDrifts: [],
        credentials: "PRIVATE_RESULT_EXTRA",
      };
      const childPath = join(workDir, "cli.mjs");
      writeFileSync(
        childPath,
        `import fs from "node:fs";
fs.writeFileSync(process.env.OPENCLAW_UPDATE_POST_CORE_RESULT_PATH, ${JSON.stringify(JSON.stringify(result))});
process.stdout.write("original stdout\\n");
process.exit(${code});
`,
      );
      const child = spawnSync(process.execPath, [childPath, "update", "--json"], {
        env: { ...env, NODE_OPTIONS: preloadOptions },
        encoding: "utf8",
      });
      expect(child.status, child.stderr).toBe(code);
      expect(child.stdout).toBe("original stdout\n");
      // The historical parent removes the handoff directory before attempting restart.
      rmSync(resultDir, { recursive: true });
      expect(existsSync(join(artifacts, "diagnostics", "post-core.json"))).toBe(true);
      expect(
        JSON.parse(readFileSync(join(artifacts, "diagnostics", "post-core.json"), "utf8")),
      ).toMatchObject({ artifactRoot: realpathSync(artifacts), childExitCode: code });
      const captured = runSurvivorDiagnostics("capture", artifacts, ["update-candidate", "1"], env);
      expect(captured.status, captured.stderr).toBe(0);
      const uploaded = join(workDir, "public");
      const published = runSurvivorDiagnostics("publish", artifacts, [uploaded], env);
      expect(published.status, published.stderr).toBe(0);
      const text = readFileSync(join(uploaded, "failure.json"), "utf8");
      expect(text).not.toContain("POST_CORE_SECRET");
      expect(text).not.toContain("PRIVATE_RESULT_EXTRA");
      expect(JSON.parse(text).postCore).toMatchObject({
        availability: "captured",
        childExitCode: code,
        result: {
          status,
          npm: {
            outcomes: [{ pluginId: "example", currentVersion: "1.0.0", nextVersion: "2.0.0" }],
          },
        },
      });
    },
  );

  it.each([
    "doctor",
    "worker",
    "missing-context",
    "missing",
    "invalid",
    "wrong-file",
    "outside-tmp",
    "symlink",
    "hardlink",
    "oversize",
    "blocked-output",
    "sigterm",
  ])(
    "leaves post-core capture unavailable for %s without changing the child outcome",
    (scenario) => {
      const { workDir, artifacts, resultPath, env, preloadOptions } = survivorPostCoreFixture();
      const complete = JSON.stringify({
        status: "error",
        changed: false,
        sync: {
          changed: false,
          switchedToBundled: [],
          switchedToNpm: [],
          warnings: [],
          errors: [],
        },
        npm: { changed: false, outcomes: [] },
        integrityDrifts: [],
      });
      writeFileSync(
        resultPath,
        scenario === "invalid"
          ? "{"
          : scenario === "oversize"
            ? complete + " ".repeat(256 * 1024)
            : complete,
      );
      if (scenario === "missing") {
        rmSync(resultPath);
      }
      if (scenario === "missing-context") {
        env.OPENCLAW_UPDATE_POST_CORE = "";
      }
      if (scenario === "wrong-file") {
        env.OPENCLAW_UPDATE_POST_CORE_RESULT_PATH = join(dirname(resultPath), "source-config.json");
      }
      if (scenario === "outside-tmp") {
        env.TMPDIR = artifacts;
      }
      if (scenario === "symlink" || scenario === "hardlink") {
        const outside = join(workDir, "private-result.json");
        writeFileSync(outside, complete);
        rmSync(resultPath);
        (scenario === "symlink" ? symlinkSync : linkSync)(outside, resultPath);
      }
      if (scenario === "blocked-output") {
        symlinkSync(workDir, join(artifacts, "diagnostics"));
      }
      const childPath = join(workDir, "child.mjs");
      writeFileSync(
        childPath,
        scenario === "worker"
          ? `
import { isMainThread, Worker } from "node:worker_threads";
if (isMainThread) await new Promise((resolve) => new Worker(new URL(import.meta.url), { argv: ["update"] }).once("exit", resolve));
process.exit(78);
`
          : scenario === "sigterm"
            ? 'process.kill(process.pid, "SIGTERM");'
            : "process.exit(78);",
      );
      const child = spawnSync(
        process.execPath,
        [childPath, ["doctor", "worker"].includes(scenario) ? "doctor" : "update"],
        { env: { ...env, NODE_OPTIONS: preloadOptions }, encoding: "utf8" },
      );
      expect(child.status, child.stderr).toBe(scenario === "sigterm" ? null : 78);
      expect(child.signal).toBe(scenario === "sigterm" ? "SIGTERM" : null);
      expect(child.stdout).toBe("");
      expect(existsSync(join(artifacts, "diagnostics", "post-core.json"))).toBe(false);
      if (scenario === "blocked-output") {
        rmSync(join(artifacts, "diagnostics"));
      }
      // An ordinary CLI respawn with no result must not consume the complete slot.
      if (scenario === "missing") {
        writeFileSync(resultPath, complete);
        expect(
          spawnSync(process.execPath, [childPath, "update"], {
            env: { ...env, NODE_OPTIONS: preloadOptions },
          }).status,
        ).toBe(78);
        expect(existsSync(join(artifacts, "diagnostics", "post-core.json"))).toBe(true);
        return;
      }
      const capture = runSurvivorDiagnostics("capture", artifacts, ["update-candidate", "1"], env);
      expect(capture.status, capture.stderr).toBe(0);
      const published = runSurvivorDiagnostics(
        "publish",
        artifacts,
        [join(workDir, "public")],
        env,
      );
      expect(published.status, published.stderr).toBe(0);
      const report = JSON.parse(readFileSync(join(workDir, "public", "failure.json"), "utf8"));
      expect(report.postCore).toEqual({
        availability: "unavailable",
        reason: "No complete exit snapshot; original outcome unknown",
      });
    },
  );

  it.each([UPGRADE_SURVIVOR_RUN_SCRIPT, UPGRADE_SURVIVOR_DOCKER_E2E_PATH])(
    "scopes the passive preload to the original update invocation in %s",
    (scriptPath) => {
      const { workDir, artifacts, env } = survivorPostCoreFixture();
      const source = readFileSync(scriptPath, "utf8");
      const published = scriptPath === UPGRADE_SURVIVOR_RUN_SCRIPT;
      const artifactSetup = published
        ? source.slice(
            source.indexOf("ARTIFACT_ROOT="),
            source.indexOf("export OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT="),
          )
        : 'ARTIFACT_ROOT="$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT"';
      const update = published
        ? source.slice(
            source.indexOf("update_candidate() {"),
            source.indexOf("\nassert_root_managed_vps_cli_usable()"),
          ) + "\nupdate_candidate\nlane_exit=$?"
        : extractUpgradeSurvivorPayload(source)
            .split('echo "Running package update against the mounted tarball..."')[1]!
            .split('if [ "$update_status" -ne 0 ]; then')[0]! + "\nlane_exit=$update_status";
      const bin = join(workDir, "bin");
      writeExecutables(bin, {
        openclaw: `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path"), { spawnSync } = require("node:child_process");
fs.appendFileSync(path.join(process.env.TMPDIR,"invocations.jsonl"), JSON.stringify({argv:process.argv.slice(2), options:process.env.NODE_OPTIONS, artifactRoot:process.env.OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT})+"\\n");
if (process.env.OPENCLAW_UPDATE_POST_CORE === "1") {
  fs.writeFileSync(process.env.OPENCLAW_UPDATE_POST_CORE_RESULT_PATH, JSON.stringify({status:"error",changed:false,sync:{changed:false,switchedToBundled:[],switchedToNpm:[],warnings:[],errors:[]},npm:{changed:false,outcomes:[]},integrityDrifts:[]}));
  process.exit(0);
}
if (process.argv[2] !== "update") process.exit(0);
const resultDir = fs.mkdtempSync(path.join(process.env.TMPDIR,"openclaw-update-post-core-"));
const child = spawnSync(process.execPath, [__filename,"update","--json"], {env:{...process.env, OPENCLAW_UPDATE_POST_CORE:"1",OPENCLAW_UPDATE_POST_CORE_RESULT_PATH:path.join(resultDir,"plugins.json")}});
if (child.status !== 0) process.exit(90);
fs.rmSync(resultDir,{recursive:true});
process.exit(78);
`,
      });
      const result = spawnSync(
        "bash",
        [
          "-c",
          `
${artifactSetup}
openclaw_e2e_maybe_timeout() { shift; "$@"; }
openclaw_e2e_print_log() { :; }
candidate_update_spec() { printf "%s" "$OPENCLAW_CURRENT_PACKAGE_TGZ"; }
COMMAND_TIMEOUT=900s
command_timeout=900s
ROOT_MANAGED_VPS=0
UPDATE_RESTART_MODE=auto-auth
baseline_spec=openclaw@2026.7.1-2
candidate_version=2026.8.1
CANDIDATE_KIND=tarball
UPDATE_JSON="$ARTIFACT_ROOT/update.json"
UPDATE_ERR="$ARTIFACT_ROOT/update.err"
POST_UPDATE_VALIDATE_JSON="$ARTIFACT_ROOT/post-update-validate.json"
POST_UPDATE_VALIDATE_ERR="$ARTIFACT_ROOT/post-update-validate.err"
${update}
test "$NODE_OPTIONS" = --no-warnings || exit 91
exit "$lane_exit"
`,
        ],
        {
          encoding: "utf8",
          env: {
            ...env,
            OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT: published ? undefined : artifacts,
            OPENCLAW_UPGRADE_SURVIVOR_SUMMARY_JSON: join(artifacts, "summary.json"),
            PATH: `${bin}:${process.env.PATH}`,
            OPENCLAW_UPDATE_POST_CORE: "",
            OPENCLAW_CURRENT_PACKAGE_TGZ: join(workDir, "candidate.tgz"),
          },
        },
      );
      expect(result.status, result.stdout + result.stderr).toBe(78);
      const calls = readFileSync(join(workDir, "invocations.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const observationRoot = calls[0].artifactRoot;
      expect(observationRoot).toEqual(
        published ? expect.stringMatching(`${artifacts}/update-observation\\.[^/]+$`) : artifacts,
      );
      const snapshot = JSON.parse(
        readFileSync(join(observationRoot, "diagnostics", "post-core.json"), "utf8"),
      );
      expect(snapshot).toMatchObject({
        artifactRoot: realpathSync(observationRoot),
        childExitCode: 0,
        result: { status: "error" },
      });
      expect(calls[0].argv).toEqual([
        "update",
        "--tag",
        join(workDir, "candidate.tgz"),
        "--yes",
        "--json",
        ...(published ? ["--no-restart"] : []),
      ]);
      expect(calls[1].options).toBe(calls[0].options);
      expect(calls[0].options).toContain("--no-warnings --import=");
      expect(calls[1].artifactRoot).toBe(observationRoot);
      for (const call of calls.slice(2)) {
        expect(call.options).toBe("--no-warnings");
        expect(call.artifactRoot).toBe(artifacts);
      }
    },
  );

  it("exposes the published survivor service through the manager fixture", () => {
    const workDir = tempDirs.make("openclaw-published-survivor-manager-");
    const unitDir = join(workDir, ".config", "systemd", "user");
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(
      join(unitDir, "openclaw-gateway.service"),
      "[Service]\nExecStart=/usr/bin/node /fixture/gateway.mjs\n",
    );
    const source = readFileSync(UPGRADE_SURVIVOR_RUN_SCRIPT, "utf8");
    const definitions = source.slice(0, source.indexOf("phase storage-preflight"));
    const result = spawnSync(
      "bash",
      [
        "-c",
        `${definitions}
trap - EXIT ERR INT TERM
install_update_restart_systemctl_shim
test -x "$npm_config_prefix/bin/busctl"
"$npm_config_prefix/bin/busctl" --user --json=short call org.freedesktop.systemd1 /org/freedesktop/systemd1 org.freedesktop.systemd1.Manager LoadUnit s openclaw-gateway.service
`,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: workDir,
          OPENCLAW_UPGRADE_SURVIVOR_BASELINE: "openclaw@2026.4.15",
          OPENCLAW_UPGRADE_SURVIVOR_SUMMARY_JSON: join(workDir, "artifacts", "summary.json"),
          OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT: join(workDir, "runtime"),
        },
      },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      type: "o",
      data: ["/org/freedesktop/systemd1/unit/openclaw_2dgateway_2eservice"],
    });
  });

  it.each(["unchanged", "pid-only", "request-only", "replaced"])(
    "requires an update-owned service replacement after consent recovery (%s)",
    (mode) => {
      const workDir = tempDirs.make("openclaw-survivor-recovery-restart-");
      const artifacts = join(workDir, "artifacts");
      const bin = join(workDir, "bin");
      mkdirSync(artifacts);
      const pidFile = join(artifacts, "supervisor.pid");
      const logFile = join(artifacts, "systemctl.log");
      const invocation = join(artifacts, "update-invoked");
      writeFileSync(pidFile, "12345\n");
      // An earlier baseline restart must not count for the recovery invocation.
      writeFileSync(logFile, "--user restart openclaw-gateway.service\n");
      writeExecutables(bin, {
        systemctl: "#!/usr/bin/env bash\nexit 0\n",
        openclaw: `#!${process.execPath}
const fs = require("node:fs");
if (process.argv[2] !== "update") throw new Error("expected updater invocation");
fs.writeFileSync(${JSON.stringify(invocation)}, "update\\n");
if (["pid-only", "replaced"].includes(process.env.RESTART_TEST_MODE)) fs.writeFileSync(process.env.OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE, "23456\\n");
if (["request-only", "replaced"].includes(process.env.RESTART_TEST_MODE)) fs.appendFileSync(process.env.OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_LOG, "--user restart openclaw-gateway.service\\n");
console.log(JSON.stringify({status:"ok",after:{version:"2026.8.1"},steps:[{name:"global update",exitCode:0}]}));
`,
      });
      const source = readFileSync(UPGRADE_SURVIVOR_RUN_SCRIPT, "utf8");
      const update = source.slice(
        source.indexOf("update_candidate() {"),
        source.indexOf("\nassert_root_managed_vps_cli_usable()"),
      );
      const result = spawnSync(
        "bash",
        [
          "-c",
          `set -eu
source ${shellQuote(UPGRADE_SURVIVOR_UPDATE_RESTART_AUTH_PATH)}
openclaw_e2e_maybe_timeout() { shift; "$@"; }
candidate_update_spec() { printf '%s' fixture.tgz; }
read_installed_version() { printf '%s' 2026.8.1; }
ARTIFACT_ROOT=${shellQuote(artifacts)}
SYSTEMCTL_SHIM_PID_FILE=${shellQuote(pidFile)}
SYSTEMCTL_SHIM_LOG=${shellQuote(logFile)}
UPDATE_JSON="$ARTIFACT_ROOT/update.json"
UPDATE_ERR="$ARTIFACT_ROOT/update.err"
COMMAND_TIMEOUT=900s
ROOT_MANAGED_VPS=0
UPDATE_RESTART_MODE=auto-auth
SCENARIO=base
update_repair_required=1
baseline_spec=openclaw@2026.4.15
candidate_version=2026.8.1
CANDIDATE_KIND=tarball
${update}
update_candidate 1
`,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ""}`,
            RESTART_TEST_MODE: mode,
            OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE: pidFile,
            OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_LOG: logFile,
          },
        },
      );
      expect(result.status, result.stdout + result.stderr).toBe(mode === "replaced" ? 0 : 1);
      expect(readFileSync(invocation, "utf8")).toBe("update\n");
    },
  );

  it.each(["sqlite", "wal", "historical"])(
    "captures persisted plugin identity without changing application data (%s)",
    (storage) => {
      const { workDir, artifacts, env } = survivorPostCoreFixture();
      const state = join(workDir, "state-root");
      const root = join(state, "npm", "example");
      mkdirSync(join(root, "dist"), { recursive: true });
      const doctorBytes = Buffer.from([0x2f, 0x2f, 0xff, 0x0a]);
      writeFileSync(join(root, "dist", "doctor-contract-api.js"), doctorBytes);
      writeFileSync(join(root, "doctor-contract-api.ts"), "PRIVATE_CODE_PAYLOAD");
      writeFileSync(join(root, "contract-api.js"), "throw new Error('must not execute')");
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          name: "@example/plugin",
          version: "1.0.0",
          credentials: "PRIVATE_PACKAGE_FIELD",
        }),
      );
      writeFileSync(
        join(root, "openclaw.plugin.json"),
        JSON.stringify({
          id: "example",
          version: "1.0.0",
          configSchema: { secret: "PRIVATE_MANIFEST_FIELD" },
        }),
      );
      writeFileSync(
        join(state, "openclaw.json"),
        JSON.stringify({
          credentials: "PRIVATE_CONFIG_FIELD",
          plugins: { installs: { secret: "PRIVATE_CONFIG_RECORD" } },
        }),
      );
      const missingRoot = join(state, "npm", "missing");
      mkdirSync(missingRoot);
      const index = {
        installRecords: {
          example: {
            resolvedVersion: "2.0.0",
            integrity: "sha512-recorded",
            credentials: "PRIVATE_RECORD_FIELD",
          },
        },
        plugins: [
          {
            pluginId: "example",
            rootDir: root,
            packageVersion: "2.0.0",
            enabled: true,
            origin: "global",
            doctorContractHash: "a".repeat(64),
            credentials: "PRIVATE_INDEX_FIELD",
          },
          { pluginId: "missing", rootDir: missingRoot, doctorContractHash: "b".repeat(64) },
        ],
        credentials: "PRIVATE_INDEX_TOP_LEVEL",
      };
      if (storage !== "historical") {
        const dbPath = join(state, "state", "openclaw.sqlite");
        mkdirSync(dirname(dbPath), { recursive: true });
        const writer = spawnSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `import { DatabaseSync } from "node:sqlite";
import { writePluginInstallIndexForE2E } from "./scripts/e2e/lib/plugin-index-sqlite.mjs";
${
  storage === "wal"
    ? `writePluginInstallIndexForE2E({}, { stateDir: ${JSON.stringify(state)} });
const db = new DatabaseSync(${JSON.stringify(dbPath)});
db.exec("PRAGMA journal_mode=WAL; BEGIN; SELECT value_json FROM config_machine_state;");`
    : ""
}
writePluginInstallIndexForE2E(${JSON.stringify(index)}, { stateDir: ${JSON.stringify(state)} });
${storage === "wal" ? 'process.kill(process.pid, "SIGKILL");' : ""}`,
          ],
          { encoding: "utf8" },
        );
        expect(writer.status, writer.stderr).toBe(storage === "wal" ? null : 0);
        expect(writer.signal).toBe(storage === "wal" ? "SIGKILL" : null);
        if (storage === "wal") {
          expect(existsSync(`${dbPath}-wal`)).toBe(true);
          expect(existsSync(`${dbPath}-shm`)).toBe(true);
        }
      } else {
        mkdirSync(join(state, "plugins"));
        writeFileSync(join(state, "plugins", "installs.json"), JSON.stringify(index));
      }
      const stateFiles = () =>
        readdirSync(state, { recursive: true, withFileTypes: true })
          .filter((entry) => entry.isFile() && entry.name !== "openclaw.sqlite-shm")
          .map((entry) => {
            const file = join(entry.parentPath, entry.name);
            const stat = statSync(file);
            return [
              file,
              stat.mtimeMs,
              stat.ctimeMs,
              stat.size,
              createHash("sha256").update(readFileSync(file)).digest("hex"),
            ];
          });
      const before = stateFiles();
      const shmIdentity = () => {
        const stat = statSync(join(state, "state", "openclaw.sqlite-shm"));
        return [stat.dev, stat.ino, stat.size, stat.nlink];
      };
      const shmBefore = storage === "wal" ? shmIdentity() : undefined;
      const capturePath = copySurvivorCaptureClosure(workDir);
      const captured = spawnSync(
        process.execPath,
        [capturePath, "capture", artifacts, "update-candidate", "1"],
        {
          env: {
            ...env,
            OPENCLAW_STATE_DIR: state,
            OPENCLAW_CONFIG_PATH: join(state, "openclaw.json"),
          },
          encoding: "utf8",
          cwd: workDir,
        },
      );
      expect(captured.status, captured.stderr).toBe(0);
      expect(stateFiles()).toEqual(before);
      if (storage === "wal") {
        expect(shmIdentity()).toEqual(shmBefore);
      }
      const published = runSurvivorDiagnostics("publish", artifacts, [join(workDir, "public")]);
      expect(published.status, published.stderr).toBe(0);
      const text = readFileSync(join(workDir, "public", "failure.json"), "utf8");
      expect(text).not.toContain("PRIVATE_");
      const identity = JSON.parse(text).pluginIdentity;
      expect(identity.availability).toBe("observed");
      expect(identity.reader).toContain("historical fallback");
      expect(identity.evidence).toContain("not observed loaded modules");
      expect(identity.plugins[0]).toMatchObject({
        pluginId: "example",
        packageVersion: "2.0.0",
        enabled: true,
        origin: "global",
        package: { version: "1.0.0" },
        manifest: { id: "example", version: "1.0.0" },
        recorded: { resolvedVersion: "2.0.0", integrity: "sha512-recorded" },
        versionMatchesIndex: false,
        versionMatchesRecord: false,
        doctor: {
          path: "dist/doctor-contract-api.js",
          sha256: createHash("sha256").update(doctorBytes).digest("hex"),
          matchesRecorded: false,
        },
      });
      expect(identity.plugins[1].doctor).toMatchObject({
        path: null,
        sha256: null,
        observation: "no current artifact found",
      });
      expect(readdirSync(join(workDir, "public"))).toEqual(["failure.json"]);
    },
  );

  it.each([
    "index-symlink",
    "index-hardlink",
    "index-oversize",
    "index-cap",
    "root-symlink",
    "doctor-symlink",
    "doctor-hardlink",
    "doctor-oversize",
  ])("refuses unsafe plugin identity input (%s)", (scenario) => {
    const { workDir, artifacts, env } = survivorPostCoreFixture();
    const state = join(workDir, "state-root");
    const root = join(state, "plugin");
    mkdirSync(root, { recursive: true });
    mkdirSync(join(state, "plugins"));
    const indexPath = join(state, "plugins", "installs.json");
    const doctorPath = join(root, "doctor-contract-api.js");
    const outside = join(workDir, "private-source");
    writeFileSync(outside, "PRIVATE_UNSAFE_PLUGIN_SENTINEL");
    writeFileSync(
      indexPath,
      JSON.stringify({
        installRecords: {},
        plugins: Array.from({ length: scenario === "index-cap" ? 129 : 1 }, () => ({
          pluginId: "example",
          rootDir: root,
          doctorContractHash: "a".repeat(64),
        })),
      }),
    );
    if (scenario.startsWith("index-") && scenario !== "index-cap") {
      rmSync(indexPath);
      if (scenario === "index-oversize") {
        writeFileSync(indexPath, " ".repeat(1024 * 1024 + 1));
      } else {
        (scenario === "index-symlink" ? symlinkSync : linkSync)(outside, indexPath);
      }
    } else if (scenario === "root-symlink") {
      rmSync(root, { recursive: true });
      symlinkSync(workDir, root);
    } else if (scenario.startsWith("doctor-")) {
      if (scenario === "doctor-oversize") {
        writeFileSync(doctorPath, " ".repeat(256 * 1024 + 1) + "PRIVATE_OVERSIZE_PLUGIN");
      } else {
        (scenario === "doctor-symlink" ? symlinkSync : linkSync)(outside, doctorPath);
      }
    }
    const captured = runSurvivorDiagnostics("capture", artifacts, ["update-candidate", "1"], {
      ...env,
      OPENCLAW_STATE_DIR: state,
    });
    expect(captured.status, captured.stderr).toBe(0);
    const published = runSurvivorDiagnostics("publish", artifacts, [join(workDir, "public")]);
    expect(published.status, published.stderr).toBe(0);
    const text = readFileSync(join(workDir, "public", "failure.json"), "utf8");
    expect(text).not.toContain("PRIVATE_");
    const report = JSON.parse(text);
    if (scenario.startsWith("index-")) {
      expect(report.pluginIdentity.availability).toBe("unknown");
      expect(report.omissions["plugin identity"]).toBeDefined();
    } else {
      expect(report.pluginIdentity.plugins[0].doctor.sha256).toBeNull();
      expect(report.pluginIdentity.plugins[0].doctor.observation).toContain("unsafe");
    }
  });

  it.each([false, true])(
    "retains a failed service child and only sanitized diagnostics (candidate redactor: %s)",
    async (candidateRedactorPresent) => {
      const workDir = tempDirs.make("openclaw-survivor-diagnostics-");
      const artifacts = join(workDir, "artifacts");
      const state = join(workDir, "home", ".openclaw");
      const unitDir = join(workDir, "home", ".config", "systemd", "user");
      mkdirSync(artifacts);
      mkdirSync(join(state, "logs"), { recursive: true });
      mkdirSync(unitDir, { recursive: true });
      mkdirSync(join(artifacts, "npm-prefix"));
      const secret = "sk-survivor-secret-should-never-be-uploaded";
      const privateSentinel = "PRIVATE_CONFIG_AND_NPM_PREFIX_SENTINEL";
      writeFileSync(join(state, "openclaw.json"), JSON.stringify({ privateSentinel }));
      writeFileSync(join(state, "auth-profiles.json"), privateSentinel);
      writeFileSync(join(artifacts, "npm-prefix", "credential"), privateSentinel);
      writeFileSync(join(artifacts, "config-recipe.json"), privateSentinel);
      writeFileSync(join(state, "gateway.systemd.env"), `API_KEY=${secret}\n`);
      writeFileSync(join(state, "logs", "gateway-restart.log"), `restart: token=${secret}\n`);
      writeFileSync(
        join(unitDir, "openclaw-gateway.service"),
        `[Service]\nExecStart=${process.execPath} gateway --token ${secret}\nWorkingDirectory=/safe/service\nEnvironment="API_KEY=${secret}"\n`,
      );
      writeFileSync(join(artifacts, "doctor.log"), `doctor: token=${secret}\n`);
      writeFileSync(join(artifacts, "update.err"), `post-core failure: token=${secret}\n`);
      const logPath = join(artifacts, "systemctl-shim-gateway.log");
      writeFileSync(`${logPath}.bootstrap.log`, `bootstrap: token=${secret}\n`);
      const childPath = join(workDir, "child.mjs");
      writeFileSync(
        childPath,
        `console.error("first startup boundary failure"); process.exit(78);\n`,
      );
      const supervisorPath = join(workDir, "supervisor.mjs");
      writeFileSync(
        supervisorPath,
        extractUpgradeSurvivorSupervisor(
          readFileSync(UPGRADE_SURVIVOR_UPDATE_RESTART_AUTH_PATH, "utf8"),
        ),
      );
      const supervisor = spawn(process.execPath, [supervisorPath], {
        env: {
          ...process.env,
          OPENCLAW_SYSTEMCTL_SHIM_DAEMON_LOG: logPath,
          OPENCLAW_SYSTEMCTL_SHIM_MANAGER_ENV: "{}",
          OPENCLAW_SYSTEMCTL_SHIM_EXEC_START: `${shellQuote(process.execPath)} ${shellQuote(childPath)}`,
        },
        stdio: "ignore",
      });
      expect(await waitForProcessExit(supervisor)).toBe(0);
      const observation = JSON.parse(readFileSync(`${logPath}.exit.json`, "utf8"));
      expect(observation.last).toMatchObject({ code: 78, signal: null });
      const managerEnv = {
        HOME: join(workDir, "home"),
        OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_DAEMON_LOG: logPath,
        OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_LOG: join(artifacts, "systemctl-shim.log"),
        OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE: join(workDir, "missing.pid"),
      };
      const shimPath = installUpgradeSurvivorSystemctlShim(workDir, managerEnv);
      const shown = spawnSync("bash", [shimPath, ...SURVIVOR_SERVICE_SHOW_ARGS], {
        encoding: "utf8",
        env: {
          ...process.env,
          ...managerEnv,
        },
      });
      expect(shown.status, shown.stderr).toBe(0);
      expect(shown.stdout).toContain("ExecMainStatus=78");
      const fixtureEnv = {
        HOME: join(workDir, "home"),
        OPENCLAW_STATE_DIR: state,
        OPENCLAW_CONFIG_PATH: join(state, "openclaw.json"),
        npm_config_prefix: join(artifacts, "npm-prefix"),
      };
      // One candidate is absent; the other has a redactor that must never execute.
      if (candidateRedactorPresent) {
        const candidate = join(artifacts, "npm-prefix", "lib", "node_modules", "openclaw");
        mkdirSync(join(candidate, "dist", "plugin-sdk"), { recursive: true });
        writeFileSync(join(candidate, "package.json"), '{"type":"module"}');
        writeFileSync(
          join(candidate, "dist", "plugin-sdk", "logging-core.js"),
          'throw new Error("candidate redactor must not execute");',
        );
      }
      const result = runSurvivorDiagnostics(
        "capture",
        artifacts,
        ["update-candidate", "1"],
        fixtureEnv,
      );
      expect(result.status, result.stderr).toBe(0);
      const rawPath = join(artifacts, "diagnostics", "raw.json");
      const raw = readFileSync(rawPath, "utf8");
      expect(raw).toContain(secret);
      expect(raw).not.toContain(privateSentinel);
      const snapshot = JSON.parse(raw);
      snapshot.config.contents = privateSentinel;
      snapshot.logs["auth-profiles.json"] = privateSentinel;
      snapshot.omissions["doctor.log"] = privateSentinel;
      snapshot.extra = privateSentinel;
      writeFileSync(rawPath, JSON.stringify(snapshot));
      const uploaded = join(workDir, "public");
      const published = runSurvivorDiagnostics("publish", artifacts, [uploaded], fixtureEnv);
      expect(published.status, published.stderr).toBe(0);
      expect(readdirSync(uploaded)).toEqual(["failure.json"]);
      const text = readFileSync(join(uploaded, "failure.json"), "utf8");
      expect(text).not.toContain(secret);
      expect(text).not.toContain(privateSentinel);
      const report = JSON.parse(text);
      expect(report).toMatchObject({
        phase: "update-candidate",
        outcome: "failed",
        exitStatus: 1,
        signal: null,
      });
      expect(report.logs["systemctl-shim-gateway.log"]).toContain("first startup boundary failure");
      expect(report.logs["systemctl-shim-gateway.log.bootstrap.log"]).toContain("bootstrap:");
      expect(report.logs["doctor.log"]).toContain("doctor:");
      expect(report.logs["update.err"]).toContain("post-core failure:");
      expect(report.logs["gateway-restart.log"]).toContain("restart:");
      expect(report.service.childExits).toEqual([
        expect.objectContaining({ code: 78, signal: null }),
        expect.objectContaining({ code: 78, signal: null }),
      ]);
      expect(report.service).toMatchObject({
        WorkingDirectory: "/safe/service",
        environmentKeys: ["API_KEY"],
        environmentFileKeys: ["API_KEY"],
      });
      expect(report.service.ExecStart).toContain("node gateway --token");
      expect(report.config.sha256).toMatch(/^[a-f0-9]{64}$/);
    },
  );

  it.each([UPGRADE_SURVIVOR_UPDATE_RESTART_AUTH_PATH])(
    "retains supervisor bootstrap stderr without inventing a child exit in %s",
    async (scriptPath) => {
      const workDir = tempDirs.make("openclaw-survivor-bootstrap-");
      const unitDir = join(workDir, ".config", "systemd", "user");
      mkdirSync(unitDir, { recursive: true });
      writeFileSync(
        join(unitDir, "openclaw-gateway.service"),
        `[Service]\nExecStart="${process.execPath}" unused\n`,
      );
      const binDir = join(workDir, "bin");
      writeExecutables(binDir, {
        node: `#!/bin/sh
case "$1" in
  *.supervisor.mjs) echo supervisor-bootstrap-failure >&2; exit 17 ;;
esac
exec ${shellQuote(process.execPath)} "$@"
`,
      });
      const logPath = join(workDir, "gateway.log");
      const fixtureEnv = {
        ...process.env,
        HOME: workDir,
        OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_DAEMON_LOG: logPath,
        OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_LOG: join(workDir, "systemctl.log"),
        OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE: join(workDir, "supervisor.pid"),
      };
      const shimPath = installUpgradeSurvivorSystemctlShim(workDir, fixtureEnv, scriptPath);
      const started = spawnSync("bash", [shimPath, "--user", "start", "openclaw-gateway.service"], {
        encoding: "utf8",
        env: { ...fixtureEnv, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      });
      expect(started.status, started.stderr).toBe(0);
      const bootstrapPath = `${logPath}.bootstrap.log`;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (
          existsSync(bootstrapPath) &&
          readFileSync(bootstrapPath, "utf8").includes("supervisor-bootstrap-failure")
        ) {
          break;
        }
        await delay(10);
      }
      expect(readFileSync(bootstrapPath, "utf8")).toContain("supervisor-bootstrap-failure");
      expect(existsSync(`${logPath}.exit.json`)).toBe(false);
      const shown = spawnSync("bash", [shimPath, ...SURVIVOR_SERVICE_SHOW_ARGS], {
        encoding: "utf8",
        env: fixtureEnv,
      });
      expect(shown.status, shown.stderr).toBe(0);
      expect(shown.stdout).not.toContain("ExecMainStatus=");
    },
  );

  it("refuses unsafe private inputs before host publication", () => {
    const workDir = tempDirs.make("openclaw-survivor-unsafe-diagnostics-");
    const artifacts = join(workDir, "artifacts");
    mkdirSync(artifacts);
    const privatePath = join(workDir, "private");
    writeFileSync(privatePath, "PRIVATE_SYMLINK_SENTINEL");
    symlinkSync(privatePath, join(artifacts, "doctor.log"));
    writeFileSync(join(artifacts, "gateway.log"), `token=${"x".repeat(256 * 1024)}SECRET_TAIL\n`);
    writeFileSync(join(artifacts, "update.err"), "token=DO_NOT_UPLOAD_RAW");
    writeFileSync(
      join(artifacts, "baseline-doctor.log"),
      "safe diagnostic\n".repeat(2000) + "token=TRUNCATION_SECRET\n",
    );
    // Mirror the container's dependency closure: this copy has no app source,
    // package, loader, or node_modules beside it.
    const capturePath = copySurvivorCaptureClosure(workDir);
    const fixtureEnv = {
      ...process.env,
      HOME: workDir,
      OPENCLAW_STATE_DIR: workDir,
      OPENCLAW_CONFIG_PATH: join(workDir, "absent"),
    };
    const result = spawnSync(
      process.execPath,
      [capturePath, "capture", artifacts, "update-candidate", "42"],
      { encoding: "utf8", cwd: workDir, env: fixtureEnv },
    );
    expect(result.status, result.stderr).toBe(0);
    const uploaded = join(workDir, "public");
    const published = runSurvivorDiagnostics("publish", artifacts, [uploaded], fixtureEnv);
    expect(published.status, published.stderr).toBe(0);
    const text = readFileSync(join(uploaded, "failure.json"), "utf8");
    expect(text).not.toContain("PRIVATE_SYMLINK_SENTINEL");
    expect(text).not.toContain("SECRET_TAIL");
    expect(text).not.toContain("DO_NOT_UPLOAD_RAW");
    expect(text).not.toContain("TRUNCATION_SECRET");
    const report = JSON.parse(text);
    expect(report.omissions["doctor.log"]).toBe("missing or unsafe file");
    expect(report.omissions["gateway.log"]).toContain("omitted whole");
    expect(report.omissions["baseline-doctor.log"]).toContain("complete line");
  });

  it.each([UPGRADE_SURVIVOR_RUN_SCRIPT, UPGRADE_SURVIVOR_DOCKER_E2E_PATH])(
    "collects before cleanup without masking failure or breaking success in %s",
    (scriptPath) => {
      const source = readFileSync(scriptPath, "utf8");
      const setup =
        scriptPath === UPGRADE_SURVIVOR_RUN_SCRIPT
          ? source.split("\nphase storage-preflight storage_preflight")[0]
          : extractUpgradeSurvivorPayload(source).split(
              "\nopenclaw_e2e_eval_test_state_from_b64",
            )[0];
      for (const [exitCode, blocked, completed] of [
        [78, false, true],
        [78, true, true],
        [0, true, true],
        [0, false, false],
      ] as const) {
        const workDir = tempDirs.make("openclaw-survivor-exit-diagnostics-");
        const artifacts = join(workDir, "artifacts");
        mkdirSync(artifacts);
        if (blocked) {
          writeFileSync(join(artifacts, "diagnostics"), "not a directory");
        }
        const result = spawnSync(
          "bash",
          [
            "-c",
            `${setup}
CURRENT_PHASE=update-candidate
run_completed=${completed ? 1 : 0}
printf "original startup error\\n" >"$npm_config_prefix/../update.err"
cleanup() { printf "cleanup replacement\\n" >"$npm_config_prefix/../update.err"; }
exit ${exitCode}
`,
          ],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              HOME: workDir,
              OPENCLAW_STATE_DIR: workDir,
              OPENCLAW_CONFIG_PATH: join(workDir, "absent"),
              OPENCLAW_UPGRADE_SURVIVOR_BASELINE: "openclaw@2026.7.1-2",
              OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT: join(workDir, "runtime"),
              OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT: artifacts,
              OPENCLAW_UPGRADE_SURVIVOR_SUMMARY_JSON: join(artifacts, "summary.json"),
            },
          },
        );
        const expectedStatus = exitCode || (completed ? 0 : 1);
        expect(result.status, result.stderr).toBe(expectedStatus);
        expect(readFileSync(join(artifacts, "update.err"), "utf8")).toContain(
          "cleanup replacement",
        );
        if (!blocked) {
          const report = JSON.parse(
            readFileSync(join(artifacts, "diagnostics", "raw.json"), "utf8"),
          );
          expect(report.exitStatus).toBe(expectedStatus);
          expect(report.logs["update.err"]).toContain("original startup error");
        } else if (exitCode) {
          expect(result.stdout + result.stderr).toContain("diagnostics missing");
        } else {
          expect(result.stdout + result.stderr).not.toContain("diagnostics missing");
        }
      }
    },
  );

  it.each([
    ["target overlap", "busy", 0],
    ["target settlement", "busy", 0],
    ["target overlap", "legacy", 1],
    ["target settlement", "other-detail", 1],
    ["target overlap", "not-retryable", 1],
    ["target overlap", "wrong-type", 1],
    ["target overlap", "success", 1],
    ["source overlap", "legacy", 0],
    ["source overlap", "legacy-stderr", 0],
  ] as const)(
    "checks self-upgrade %s against its package contract: %s",
    (phase, fixture, exitCode) => {
      const workDir = tempDirs.make("openclaw-self-upgrade-wizard-");
      const source = readFileSync(
        "scripts/e2e/lib/upgrade-survivor/update-run-package-self-upgrade.sh",
        "utf8",
      );
      const assertions = source.slice(
        source.indexOf("assert_gateway_call_error_message() {"),
        source.indexOf("\ngateway_call channels.status"),
      );
      const targetStart = source.indexOf("CURRENT_PHASE=target-wizard");
      const waitStart = source.indexOf("wait_for_target_wizard_start() {", targetStart);
      const waitEnd = source.indexOf("\n}\n", waitStart) + 3;
      const overlapStart = source.indexOf(
        "if gateway_call wizard.start",
        phase === "source overlap" ? 0 : waitEnd,
      );
      const overlapEnd = source.indexOf("\ngateway_call wizard.cancel", overlapStart);
      const invocation =
        phase === "target settlement"
          ? 'wait_for_target_wizard_start "$OUTPUT" "$ERROR_OUTPUT" "target settlement"'
          : source.slice(overlapStart, overlapEnd);
      const error = fixture.startsWith("legacy")
        ? { type: "gateway_request_error", code: "UNAVAILABLE", message: "wizard already running" }
        : {
            type: fixture === "wrong-type" ? "transport_error" : "gateway_request_error",
            code: "UNAVAILABLE",
            message: "Setup admission is busy.",
            details: {
              code: fixture === "other-detail" ? "OTHER_FAILURE" : "SETUP_ADMISSION_BUSY",
            },
            retryable: fixture !== "not-retryable",
          };
      writeFileSync(
        join(workDir, "response.json"),
        JSON.stringify({ ok: fixture === "success", error }),
      );
      writeFileSync(join(workDir, "calls"), "");
      const result = spawnSync(
        "bash",
        [
          "-c",
          `set -euo pipefail
${assertions}
${source.slice(targetStart, waitEnd)}
openclaw_e2e_print_log() { cat "$1"; }
gateway_call() {
  printf '%s\\n' "$1" >>"$PROBE_CALLS"
  : >"$4"
  if [ "$(wc -l <"$PROBE_CALLS")" -eq 1 ]; then
    if [ "$PROBE_FIXTURE" = legacy-stderr ]; then
      : >"$3"
      printf 'wizard already running\\n' >"$4"
    else
      cat "$PROBE_RESPONSE" >"$3"
    fi
    [ "$PROBE_FIXTURE" = success ]
  else
    printf '{"sessionId":"replacement","done":false,"status":"running","step":{"id":"ready"}}\\n' >"$3"
  fi
}
${invocation}
`,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PROBE_CALLS: join(workDir, "calls"),
            PROBE_RESPONSE: join(workDir, "response.json"),
            PROBE_FIXTURE: fixture,
            OUTPUT: join(workDir, "output.json"),
            ERROR_OUTPUT: join(workDir, "error.txt"),
            TARGET_WIZARD_DUPLICATE_JSON: join(workDir, "output.json"),
            TARGET_WIZARD_DUPLICATE_ERR: join(workDir, "error.txt"),
            WIZARD_DUPLICATE_JSON: join(workDir, "output.json"),
            WIZARD_DUPLICATE_ERR: join(workDir, "error.txt"),
          },
        },
      );
      expect(result.status, result.stdout + result.stderr).toBe(exitCode);
      const expectedCalls = phase === "target settlement" && exitCode === 0 ? 2 : 1;
      expect(readFileSync(join(workDir, "calls"), "utf8").trim().split("\n")).toEqual(
        Array(expectedCalls).fill("wizard.start"),
      );
      if (phase === "target settlement" && exitCode === 0) {
        expect(result.stdout).toMatch(/replacement\t2\s*$/u);
      }
    },
  );

  it.each([
    ["direct failure", 42, false],
    ["substitution failure", 42, false],
    ["assertion after success", 43, false],
    ["signal after success", 143, false],
    ["expected negative", 0, false],
    ["direct failure", 42, true],
  ] as const)(
    "retains self-upgrade RPC evidence through the actual launcher: %s (exit %s, blocked publication: %s)",
    (scenario, expectedStatus, blockedPublication) => {
      const workDir = tempDirs.make("openclaw-self-upgrade-diagnostics-");
      const artifacts = join(workDir, "private");
      const publicRoot = join(workDir, "public");
      const fixtureRoot = join(workDir, "historical");
      const pluginRoot = join(fixtureRoot, "dist/extensions/qa-channel");
      mkdirSync(join(fixtureRoot, "extensions/qa-channel"), { recursive: true });
      mkdirSync(pluginRoot, { recursive: true });
      writeFileSync(
        join(fixtureRoot, "extensions/qa-channel/package.json"),
        '{"version":"2026.4.25"}',
      );
      for (const file of ["package.json", "openclaw.plugin.json", "index.js", "setup-entry.js"]) {
        writeFileSync(join(pluginRoot, file), "{}");
      }
      if (blockedPublication) {
        writeFileSync(publicRoot, "not a directory");
      }
      const source = readFileSync(
        "scripts/e2e/lib/upgrade-survivor/update-run-package-self-upgrade.sh",
        "utf8",
      );
      const setup = source.split('\necho "Installing declared source package')[0];
      const rpcStart = source.indexOf("gateway_call() {");
      const rpcEnd = source.indexOf("\n}\n", rpcStart);
      expect(rpcStart).toBeGreaterThan(0);
      expect(rpcEnd).toBeGreaterThan(rpcStart);
      const rpc = source.slice(rpcStart, rpcEnd + 3);
      const call = 'gateway_call wizard.start \'{}\' "$WIZARD_START_JSON" "$WIZARD_START_ERR"';
      const invocation =
        scenario === "expected negative"
          ? `if ${call}; then exit 99; fi\nprintf continued >"$ARTIFACT_DIR/continued"\nrun_completed=1`
          : scenario === "substitution failure"
            ? `result="$( ${call} )"`
            : `${call}\nCURRENT_PHASE=assert-source-wizard\n${scenario === "signal after success" ? 'kill -TERM "$$"' : "exit 43"}`;
      writeFileSync(
        join(workDir, "inner-probe.sh"),
        `${setup}\n${rpc}\n
cleanup() { printf "cleanup replacement\\n" >"$WIZARD_START_ERR"; }
CURRENT_PHASE=source-wizard
${invocation}
`,
      );
      const rpcStatus = scenario.includes("after success") ? 0 : 42;
      const binDir = join(workDir, "bin");
      writeExecutables(binDir, {
        git: `#!/usr/bin/env bash
case " $* " in
  *" archive "*) exec tar -C "$TEST_FIXTURE_ROOT" -cf - . ;;
  *" rev-parse "*) printf 'be8c24633aaa7ef0425ae1178f096ee8dd6226c0\\n' ;;
esac
`,
        corepack: "#!/bin/sh\nexit 0\n",
        openclaw: `#!/bin/sh
printf '{"ok":${rpcStatus === 0},"fixture":"named RPC response"}\\n'
printf 'controlled RPC stderr token=SELF_UPGRADE_SECRET\\n' >&2
exit ${rpcStatus}
`,
        docker: `#!/usr/bin/env bash
if [ "$1" = run ]; then
  printf '%s\\n' "$@" >"$TMPDIR/docker-args"
  cd "$TEST_REPO_ROOT"
  exec bash "$TMPDIR/inner-probe.sh"
fi
exit 0
`,
      });
      const result = spawnSync(
        "bash",
        [join(process.cwd(), "scripts/e2e/update-run-package-self-upgrade-docker.sh")],
        {
          encoding: "utf8",
          cwd: workDir,
          env: {
            ...process.env,
            HOME: workDir,
            TMPDIR: workDir,
            PATH: `${binDir}:${process.env.PATH ?? ""}`,
            TEST_REPO_ROOT: process.cwd(),
            TEST_FIXTURE_ROOT: fixtureRoot,
            OPENCLAW_SKIP_DOCKER_BUILD: "1",
            OPENCLAW_QA_ALLOW_UPDATE_RUN_SELF: "1",
            OPENCLAW_UPDATE_RUN_SELF_UPGRADE_ARTIFACT_DIR: artifacts,
            OPENCLAW_UPDATE_RUN_SELF_UPGRADE_RUNTIME_ROOT: join(workDir, "runtime"),
            OPENCLAW_DOCKER_ALL_LOG_DIR: publicRoot,
          },
        },
      );
      expect(result.status, result.stdout + result.stderr).toBe(expectedStatus);
      expect(readFileSync(join(artifacts, "wizard-start.err"), "utf8")).toBe(
        "cleanup replacement\n",
      );
      expect(readFileSync(join(workDir, "docker-args"), "utf8")).not.toContain(publicRoot);
      if (expectedStatus === 0) {
        expect(readFileSync(join(artifacts, "continued"), "utf8")).toBe("continued");
        expect(existsSync(publicRoot)).toBe(false);
        expect(existsSync(join(artifacts, "diagnostics/raw.json"))).toBe(false);
      } else if (blockedPublication) {
        expect(result.stderr).toContain("diagnostics missing");
      } else {
        expect(existsSync(publicRoot)).toBe(true);
        const directories = readdirSync(publicRoot);
        expect(directories).toHaveLength(1);
        const uploaded = join(publicRoot, directories[0]!);
        expect(readdirSync(uploaded)).toEqual(["failure.json"]);
        const text = readFileSync(join(uploaded, "failure.json"), "utf8");
        expect(text).not.toContain("SELF_UPGRADE_SECRET");
        expect(text).not.toContain("cleanup replacement");
        const report = JSON.parse(text);
        expect(report).toMatchObject({
          phase: scenario.includes("after success") ? "assert-source-wizard" : "source-wizard",
          exitStatus: expectedStatus,
          signal: scenario === "signal after success" ? "SIGTERM" : null,
          lastRpc: {
            name: "wizard-start",
            stdout: expect.stringContaining("named RPC response"),
            stderr: expect.stringContaining("controlled RPC stderr"),
          },
        });
      }
    },
  );

  it.each(["config-recipe", "../config-recipe", "wizard-not-a-declared-rpc"])(
    "rejects candidate-selected private RPC evidence: %s",
    (rpcName) => {
      const workDir = tempDirs.make("openclaw-rpc-diagnostics-contract-");
      const artifacts = join(workDir, "private");
      mkdirSync(join(artifacts, "diagnostics"), { recursive: true });
      writeFileSync(join(artifacts, "diagnostics/last-rpc"), rpcName);
      writeFileSync(join(artifacts, "config-recipe.json"), "PRIVATE_RPC_SELECTION_SENTINEL");
      const captured = runSurvivorDiagnostics("capture", artifacts, ["source-wizard", "42"]);
      expect(captured.status, captured.stderr).toBe(0);
      const rawPath = join(artifacts, "diagnostics/raw.json");
      const raw = readFileSync(rawPath, "utf8");
      expect(raw).not.toContain("PRIVATE_RPC_SELECTION_SENTINEL");
      const snapshot = JSON.parse(raw);
      expect(snapshot.lastRpc).toBeUndefined();
      // Revalidate at publication too: candidate-authored snapshots cannot broaden the contract.
      snapshot.lastRpc = { name: rpcName, stdout: "PRIVATE_RPC_SELECTION_SENTINEL", stderr: "" };
      writeFileSync(rawPath, JSON.stringify(snapshot));
      const uploaded = join(workDir, "public");
      const published = runSurvivorDiagnostics("publish", artifacts, [uploaded]);
      expect(published.status, published.stderr).toBe(0);
      const text = readFileSync(join(uploaded, "failure.json"), "utf8");
      expect(text).not.toContain("PRIVATE_RPC_SELECTION_SENTINEL");
      expect(JSON.parse(text).lastRpc).toBeUndefined();
    },
  );

  it.each([false, true])(
    "publishes only on the host and preserves Docker outcomes (published baseline: %s)",
    (publishedBaseline) => {
      for (const [exitCode, capturePresent] of [
        [42, true],
        [42, false],
        [0, false],
      ] as const) {
        const workDir = tempDirs.make("openclaw-survivor-host-publication-");
        const artifacts = join(workDir, "private");
        const registry = join(workDir, "registry");
        const publicRoot = join(workDir, "public");
        const binDir = join(workDir, "bin");
        mkdirSync(join(artifacts, "diagnostics"), { recursive: true });
        mkdirSync(registry);
        writeFileSync(
          join(artifacts, "diagnostics", "raw.json"),
          '{"stale":"PRIVATE_STALE_SENTINEL"}',
        );
        writeFileSync(
          join(artifacts, "diagnostics", "post-core.json"),
          '{"stale":"PRIVATE_POST_CORE_SENTINEL"}',
        );
        writeFileSync(join(workDir, "candidate.tgz"), "unused by fake Docker");
        writeFileSync(
          join(registry, "prepublish-plugin-registry.json"),
          JSON.stringify({ sourceSha: "a".repeat(40), candidateVersion: "2026.8.1", packages: [] }),
        );
        writeExecutables(binDir, {
          docker: `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = run ]; then
  printf "%s\\n" "$@" >"$TMPDIR/docker-args"
  test ! -e "$TMPDIR/public"
  test ! -e "$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_DIR/diagnostics/raw.json"
  test ! -e "$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_DIR/diagnostics/post-core.json"
  if [ "${capturePresent}" = true ]; then
    printf "startup failure token=HOST_PUBLICATION_SECRET\\n" >"$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_DIR/update.err"
    ${shellQuote(process.execPath)} ${shellQuote(join(process.cwd(), UPGRADE_SURVIVOR_DIAGNOSTICS_PATH))} capture "$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_DIR" update-candidate ${exitCode}
  fi
  exit ${exitCode}
fi
exit 0
`,
        });
        const result = spawnSync("bash", [join(process.cwd(), UPGRADE_SURVIVOR_DOCKER_E2E_PATH)], {
          encoding: "utf8",
          cwd: workDir,
          env: {
            ...process.env,
            HOME: workDir,
            TMPDIR: workDir,
            PATH: `${binDir}:${process.env.PATH ?? ""}`,
            OPENCLAW_CONFIG_PATH: join(workDir, "absent"),
            OPENCLAW_STATE_DIR: workDir,
            OPENCLAW_SKIP_DOCKER_BUILD: "1",
            OPENCLAW_CURRENT_PACKAGE_TGZ: join(workDir, "candidate.tgz"),
            OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR: registry,
            OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_DIR: artifacts,
            OPENCLAW_UPGRADE_SURVIVOR_PUBLISHED_BASELINE: publishedBaseline ? "1" : "0",
            OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC: "openclaw@2026.7.1-2",
            OPENCLAW_DOCKER_ALL_LOG_DIR: "public",
          },
        });
        expect(result.status, result.stdout + result.stderr).toBe(exitCode);
        const dockerArgs = readFileSync(join(workDir, "docker-args"), "utf8");
        expect(dockerArgs).toContain(`${artifacts}:/tmp/openclaw-upgrade-survivor-artifacts`);
        expect(dockerArgs).not.toContain(publicRoot);
        expect(dockerArgs).not.toContain(":/tmp/openclaw-upgrade-survivor-artifacts/diagnostics");
        if (capturePresent) {
          const directories = readdirSync(publicRoot);
          expect(directories).toHaveLength(1);
          const uploaded = join(publicRoot, directories[0]!);
          expect(readdirSync(uploaded)).toEqual(["failure.json"]);
          const text = readFileSync(join(uploaded, "failure.json"), "utf8");
          expect(text).toContain("startup failure");
          expect(text).not.toContain("HOST_PUBLICATION_SECRET");
          expect(JSON.parse(text).exitStatus).toBe(exitCode);
        } else if (exitCode) {
          expect(result.stderr).toContain("diagnostics missing");
          expect(
            readdirSync(publicRoot).flatMap((dir) => readdirSync(join(publicRoot, dir))),
          ).toEqual([]);
        } else {
          expect(existsSync(publicRoot)).toBe(false);
          expect(result.stderr).not.toContain("diagnostics missing");
        }
      }
    },
  );

  it("stops supervised gateway restarts after the systemd burst limit", async () => {
    const workDir = tempDirs.make("openclaw-update-restart-supervisor-");
    const scripts = [readFileSync(UPGRADE_SURVIVOR_UPDATE_RESTART_AUTH_PATH, "utf8")];

    for (const [index, script] of scripts.entries()) {
      const supervisorPath = join(workDir, `supervisor-${index}.mjs`);
      const countPath = join(workDir, `starts-${index}`);
      const logPath = join(workDir, `daemon-${index}.log`);
      const source = extractUpgradeSurvivorSupervisor(script)
        .replace("const restartDelayMs = 5_000;", "const restartDelayMs = 5;")
        .replace("const restartWindowMs = 60_000;", "const restartWindowMs = 5_000;");
      writeFileSync(supervisorPath, source);

      const command =
        'node -e \'require("node:fs").appendFileSync(process.env.COUNT_FILE, "x"); process.exit(1)\'';
      const supervisor = spawn(process.execPath, [supervisorPath], {
        env: {
          ...process.env,
          COUNT_FILE: countPath,
          OPENCLAW_SYSTEMCTL_SHIM_DAEMON_LOG: logPath,
          OPENCLAW_SYSTEMCTL_SHIM_MANAGER_ENV: "{}",
          OPENCLAW_SYSTEMCTL_SHIM_EXEC_START: command,
        },
        stdio: "ignore",
      });
      const exitCode = await waitForProcessExit(supervisor);

      expect(exitCode).toBe(0);
      expect(readFileSync(countPath, "utf8")).toBe("xxxxx");
      expect(readFileSync(logPath, "utf8")).toContain(
        "[systemctl-shim] gateway restart limit reached",
      );
    }
  });

  it("allows a supervised gateway to drain within the systemd stop timeout", async () => {
    const workDir = tempDirs.make("openclaw-update-restart-graceful-stop-");
    const scripts = [readFileSync(UPGRADE_SURVIVOR_UPDATE_RESTART_AUTH_PATH, "utf8")];

    for (const [index, script] of scripts.entries()) {
      const supervisorPath = join(workDir, `graceful-supervisor-${index}.mjs`);
      const statePath = join(workDir, `graceful-state-${index}`);
      const logPath = join(workDir, `graceful-daemon-${index}.log`);
      const source = extractUpgradeSurvivorSupervisor(script).replace(
        "const stopTimeoutMs = 30_000;",
        "const stopTimeoutMs = 200;",
      );
      writeFileSync(supervisorPath, source);

      const command =
        'node -e \'const fs=require("node:fs"); process.on("SIGTERM",()=>setTimeout(()=>{fs.appendFileSync(process.env.STATE_FILE, "-graceful"); process.exit(0)},50)); fs.writeFileSync(process.env.STATE_FILE, "ready"); setInterval(()=>{},1000)\'';
      const supervisor = spawn(process.execPath, [supervisorPath], {
        env: {
          ...process.env,
          OPENCLAW_SYSTEMCTL_SHIM_DAEMON_LOG: logPath,
          OPENCLAW_SYSTEMCTL_SHIM_MANAGER_ENV: "{}",
          OPENCLAW_SYSTEMCTL_SHIM_EXEC_START: command,
          STATE_FILE: statePath,
        },
        stdio: "ignore",
      });
      try {
        for (let attempt = 0; attempt < 100 && !existsSync(statePath); attempt += 1) {
          await delay(10);
        }
        expect(existsSync(statePath)).toBe(true);

        supervisor.kill("SIGTERM");
        expect(await waitForProcessExit(supervisor)).toBe(0);
        expect(readFileSync(statePath, "utf8")).toBe("ready-graceful");
      } finally {
        if (supervisor.exitCode === null && supervisor.signalCode === null) {
          supervisor.kill("SIGTERM");
          await waitForProcessExit(supervisor).catch(() => undefined);
        }
      }
    }
  });

  it("preserves the ClawHub fixture URL across a supervised gateway restart", async () => {
    const workDir = tempDirs.make("openclaw-update-restart-clawhub-env-");
    const gatewayPath = join(workDir, "gateway.mjs");
    writeFileSync(
      gatewayPath,
      `import fs from "node:fs";
fs.appendFileSync(process.env.URLS_FILE, process.env.OPENCLAW_CLAWHUB_URL + "\\n");
const starts = fs.readFileSync(process.env.URLS_FILE, "utf8").trim().split("\\n").length;
process.exit(starts === 1 ? 1 : 78);
`,
    );
    const scripts = [readFileSync(UPGRADE_SURVIVOR_UPDATE_RESTART_AUTH_PATH, "utf8")];

    for (const [index, script] of scripts.entries()) {
      const supervisorPath = join(workDir, `clawhub-env-supervisor-${index}.mjs`);
      const urlsPath = join(workDir, `clawhub-env-urls-${index}`);
      const logPath = join(workDir, `clawhub-env-daemon-${index}.log`);
      const source = extractUpgradeSurvivorSupervisor(script).replace(
        "const restartDelayMs = 5_000;",
        "const restartDelayMs = 5;",
      );
      writeFileSync(supervisorPath, source);

      const supervisor = spawn(process.execPath, [supervisorPath], {
        env: {
          ...process.env,
          OPENCLAW_CLAWHUB_URL: "http://127.0.0.1:43123",
          OPENCLAW_SYSTEMCTL_SHIM_DAEMON_LOG: logPath,
          OPENCLAW_SYSTEMCTL_SHIM_MANAGER_ENV: "{}",
          OPENCLAW_SYSTEMCTL_SHIM_EXEC_START: `${shellQuote(process.execPath)} ${shellQuote(gatewayPath)}`,
          URLS_FILE: urlsPath,
        },
        stdio: "ignore",
      });
      try {
        expect(await waitForProcessExit(supervisor)).toBe(0);
        expect(readFileSync(urlsPath, "utf8").trim().split("\n")).toEqual([
          "http://127.0.0.1:43123",
          "http://127.0.0.1:43123",
        ]);
      } finally {
        if (supervisor.exitCode === null && supervisor.signalCode === null) {
          supervisor.kill("SIGTERM");
          await waitForProcessExit(supervisor).catch(() => undefined);
        }
      }
    }
  });

  it.skipIf(process.platform === "win32")(
    "terminates supervised gateway descendants at the systemd stop timeout",
    async () => {
      const workDir = tempDirs.make("openclaw-update-restart-process-group-");
      const descendantPath = writeTermIgnoringDescendant(workDir);
      const gatewayPath = join(workDir, "gateway.mjs");
      writeFileSync(
        gatewayPath,
        `import fs from "node:fs";
import { spawn } from "node:child_process";
process.on("SIGTERM", () => {
  setTimeout(() => {
    fs.appendFileSync(process.env.STATE_FILE, "-graceful");
    process.exit(0);
  }, 50);
});
spawn(process.execPath, [process.env.DESCENDANT_SCRIPT], { stdio: "ignore" });
const ready = setInterval(() => {
  if (!fs.existsSync(process.env.DESCENDANT_PID_FILE)) return;
  clearInterval(ready);
  fs.writeFileSync(process.env.STATE_FILE, "ready");
}, 5);
setInterval(() => {}, 1_000);
`,
      );
      const scripts = [readFileSync(UPGRADE_SURVIVOR_UPDATE_RESTART_AUTH_PATH, "utf8")];

      for (const [index, script] of scripts.entries()) {
        const supervisorPath = join(workDir, `process-group-supervisor-${index}.mjs`);
        const statePath = join(workDir, `process-group-state-${index}`);
        const descendantPidPath = join(workDir, `process-group-descendant-${index}.pid`);
        const logPath = join(workDir, `process-group-daemon-${index}.log`);
        const source = extractUpgradeSurvivorSupervisor(script).replace(
          "const stopTimeoutMs = 30_000;",
          "const stopTimeoutMs = 200;",
        );
        writeFileSync(supervisorPath, source);

        const supervisor = spawn(process.execPath, [supervisorPath], {
          env: {
            ...process.env,
            DESCENDANT_PID_FILE: descendantPidPath,
            DESCENDANT_SCRIPT: descendantPath,
            OPENCLAW_SYSTEMCTL_SHIM_DAEMON_LOG: logPath,
            OPENCLAW_SYSTEMCTL_SHIM_MANAGER_ENV: "{}",
            OPENCLAW_SYSTEMCTL_SHIM_EXEC_START: `${shellQuote(process.execPath)} ${shellQuote(gatewayPath)}`,
            STATE_FILE: statePath,
          },
          stdio: "ignore",
        });
        try {
          for (let attempt = 0; attempt < 100 && !existsSync(statePath); attempt += 1) {
            await delay(10);
          }
          expect(
            existsSync(statePath),
            `${supervisorPath}: readiness missing (exit=${supervisor.exitCode}, signal=${supervisor.signalCode})`,
          ).toBe(true);
          const descendantPid = Number.parseInt(readFileSync(descendantPidPath, "utf8"), 10);
          expect(descendantPid).toBeGreaterThan(1);
          expect(isProcessRunning(descendantPid)).toBe(true);

          supervisor.kill("SIGTERM");
          expect(await waitForProcessExit(supervisor)).toBe(0);
          expect(readFileSync(statePath, "utf8")).toBe("ready-graceful");
          for (let attempt = 0; attempt < 100 && isProcessRunning(descendantPid); attempt += 1) {
            await delay(10);
          }
          expect(isProcessRunning(descendantPid)).toBe(false);
        } finally {
          await stopUpgradeSurvivorSupervisor(supervisor, descendantPidPath);
        }
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "drains the previous gateway process group before restarting",
    async () => {
      const workDir = tempDirs.make("openclaw-update-restart-process-group-restart-");
      const descendantPath = writeTermIgnoringDescendant(workDir);
      const gatewayPath = join(workDir, "restart-gateway.mjs");
      writeFileSync(
        gatewayPath,
        `import fs from "node:fs";
import { spawn } from "node:child_process";
fs.appendFileSync(process.env.STARTS_FILE, "x");
const starts = fs.readFileSync(process.env.STARTS_FILE, "utf8").length;
if (starts === 1) {
  spawn(process.execPath, [process.env.DESCENDANT_SCRIPT], { stdio: "ignore" });
  const ready = setInterval(() => {
    if (!fs.existsSync(process.env.DESCENDANT_PID_FILE)) return;
    clearInterval(ready);
    process.exit(1);
  }, 5);
  setInterval(() => {}, 1_000);
} else {
  const pid = Number.parseInt(fs.readFileSync(process.env.DESCENDANT_PID_FILE, "utf8"), 10);
  let running = false;
  try {
    process.kill(pid, 0);
    running = true;
    const statPath = "/proc/" + pid + "/stat";
    if (fs.existsSync(statPath)) running = fs.readFileSync(statPath, "utf8").split(" ")[2] !== "Z";
  } catch {}
  fs.writeFileSync(process.env.REPLACEMENT_FILE, running ? "overlap" : "drained");
  process.exit(78);
}
`,
      );
      const scripts = [readFileSync(UPGRADE_SURVIVOR_UPDATE_RESTART_AUTH_PATH, "utf8")];

      for (const [index, script] of scripts.entries()) {
        const supervisorPath = join(workDir, `restart-group-supervisor-${index}.mjs`);
        const startsPath = join(workDir, `restart-group-starts-${index}`);
        const descendantPidPath = join(workDir, `restart-group-descendant-${index}.pid`);
        const replacementPath = join(workDir, `restart-group-replacement-${index}`);
        const logPath = join(workDir, `restart-group-daemon-${index}.log`);
        const source = extractUpgradeSurvivorSupervisor(script)
          .replace("const restartDelayMs = 5_000;", "const restartDelayMs = 5;")
          .replace("const stopTimeoutMs = 30_000;", "const stopTimeoutMs = 200;");
        writeFileSync(supervisorPath, source);

        const supervisor = spawn(process.execPath, [supervisorPath], {
          env: {
            ...process.env,
            DESCENDANT_PID_FILE: descendantPidPath,
            DESCENDANT_SCRIPT: descendantPath,
            OPENCLAW_SYSTEMCTL_SHIM_DAEMON_LOG: logPath,
            OPENCLAW_SYSTEMCTL_SHIM_MANAGER_ENV: "{}",
            OPENCLAW_SYSTEMCTL_SHIM_EXEC_START: `${shellQuote(process.execPath)} ${shellQuote(gatewayPath)}`,
            REPLACEMENT_FILE: replacementPath,
            STARTS_FILE: startsPath,
          },
          stdio: "ignore",
        });
        try {
          expect(await waitForProcessExit(supervisor)).toBe(0);
          const descendantPid = Number.parseInt(readFileSync(descendantPidPath, "utf8"), 10);
          expect(descendantPid).toBeGreaterThan(1);
          expect(readFileSync(startsPath, "utf8")).toBe("xx");
          expect(readFileSync(replacementPath, "utf8")).toBe("drained");
        } finally {
          await stopUpgradeSurvivorSupervisor(supervisor, descendantPidPath);
        }
      }
    },
  );

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
    const updateRestartAuth = readFileSync(UPGRADE_SURVIVOR_UPDATE_RESTART_AUTH_PATH, "utf8");

    expectTextToIncludeInOrder(runner, [
      "update_status=$?",
      'if [ "$update_status" -ne 0 ]; then',
      'echo "openclaw update failed" >&2',
      'openclaw config validate --json >"$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/post-update-validate.json"',
      'echo "post-update config validation probe status=$validate_status" >&2',
      'openclaw_e2e_print_log "$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/post-update-validate.err" >&2 || true',
      'openclaw_e2e_print_log "$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/post-update-validate.json" >&2 || true',
      'openclaw_e2e_print_log "$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/update.err" >&2 || true',
      'openclaw_e2e_print_log "$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/update.json" >&2 || true',
      'exit "$update_status"',
    ]);
    expectTextToIncludeInOrder(publishedRunner, [
      "local update_status=0",
      'openclaw "${update_args[@]}" >"$update_json" 2>"$update_err" || update_status=$?',
      "assert-recoverable-update-json",
      "assert-successful-update-json",
      'echo "openclaw update failed before the recoverable post-core boundary" >&2',
      'openclaw config validate --json >"$POST_UPDATE_VALIDATE_JSON"',
      'echo "post-update config validation probe status=$validate_status" >&2',
      'openclaw_e2e_print_log "$POST_UPDATE_VALIDATE_ERR" >&2 || true',
      'openclaw_e2e_print_log "$POST_UPDATE_VALIDATE_JSON" >&2 || true',
      'openclaw_e2e_print_log "$update_err" >&2 || true',
      'openclaw_e2e_print_log "$update_json" >&2 || true',
      'return "$update_status"',
    ]);
    expect(publishedRunner).not.toContain("update_args+=(--accept-capabilities)");
    expectTextToIncludeInOrder(publishedRunner, [
      "phase doctor run_doctor",
      "phase assert-survival assert_survival",
      "phase fixture-plugin-consent repair_fixture_plugin_consent",
      "phase transcript-export node scripts/e2e/lib/upgrade-survivor/assertions.mjs assert-meeting-transcript-export",
      "phase gateway-start ensure_gateway_started",
    ]);
    expect(publishedRunner).not.toContain("systemctl --user restart openclaw-gateway.service");
    expect(publishedRunner).toContain("phase recovery-update-restart update_candidate 1");

    expectTextToIncludeAll(runner, [
      'openclaw_e2e_print_log "$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/update.err"',
      'openclaw_e2e_print_log "$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/update.json"',
      'openclaw_e2e_print_log "$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/post-update-validate.err"',
      'openclaw_e2e_print_log "$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/post-update-validate.json"',
      'openclaw_e2e_print_log "$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/doctor.log"',
      'openclaw_e2e_print_log "$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/status.err"',
      'openclaw_e2e_print_log "$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/status.json"',
      'openclaw_e2e_print_log "$GATEWAY_LOG"',
      'openclaw_e2e_print_log "$SYSTEMCTL_SHIM_DAEMON_LOG"',
      'openclaw_e2e_print_log "$log_file"',
    ]);

    expect(runner).not.toContain('cat "$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/update.err"');
    expect(runner).not.toContain('cat "$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/update.json"');
    expect(runner).not.toContain(
      'cat "$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/post-update-validate.err"',
    );
    expect(runner).not.toContain(
      'cat "$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/post-update-validate.json"',
    );
    expect(runner).not.toContain('cat "$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/doctor.log"');
    expect(runner).not.toContain('cat "$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/status.err"');
    expect(runner).not.toContain('cat "$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/status.json"');
    expect(runner).not.toContain('cat "$GATEWAY_LOG"');
    expect(runner).not.toContain('cat "$SYSTEMCTL_SHIM_DAEMON_LOG"');
    expect(runner).not.toContain('cat "$log_file"');
    expect(runner).not.toContain('openclaw_e2e_print_log "$SYSTEMCTL_SHIM_LOG"');

    expect(publishedRunner).toContain('openclaw_e2e_print_log "$BASELINE_INSTALL_LOG"');
    expect(publishedRunner).toContain('openclaw_e2e_print_log "$BASELINE_CONFIG_VALIDATE_LOG"');
    expect(updateRestartAuth).toContain('openclaw_e2e_print_log "$result_err"');
    expect(updateRestartAuth).toContain('openclaw_e2e_print_log "$result_out"');
    expect(publishedRunner).toContain('openclaw_e2e_print_log "$update_err"');
    expect(publishedRunner).toContain('openclaw_e2e_print_log "$update_json"');
    expect(publishedRunner).toContain('openclaw_e2e_print_log "$DOCTOR_LOG"');
    expect(publishedRunner).toContain('openclaw_e2e_print_log "$GATEWAY_LOG"');
    expect(publishedRunner).toContain('openclaw_e2e_print_log "$STATUS_ERR"');
    expect(publishedRunner).toContain('openclaw_e2e_print_log "$STATUS_JSON"');
    expect(publishedRunner).toContain('openclaw_e2e_print_log "$log_file"');
    expect(publishedRunner).not.toContain('cat "$BASELINE_INSTALL_LOG"');
    expect(publishedRunner).not.toContain('cat "$BASELINE_CONFIG_VALIDATE_LOG"');
    expect(updateRestartAuth).not.toContain('cat "$result_err"');
    expect(updateRestartAuth).not.toContain('cat "$result_out"');
    expect(publishedRunner).not.toContain('cat "$UPDATE_ERR"');
    expect(publishedRunner).not.toContain('cat "$UPDATE_JSON"');
    expect(publishedRunner).not.toContain('cat "$DOCTOR_LOG"');
    expect(publishedRunner).not.toContain('cat "$GATEWAY_LOG"');
    expect(publishedRunner).not.toContain('cat "$STATUS_ERR"');
    expect(publishedRunner).not.toContain('cat "$STATUS_JSON"');
    expect(publishedRunner).not.toContain('cat "$log_file"');
    expect(publishedRunner).not.toContain('openclaw_e2e_print_log "$SYSTEMCTL_SHIM_LOG"');
    expect(publishedRunner).not.toContain('openclaw_e2e_print_log "$SYSTEMCTL_SHIM_DAEMON_LOG"');
  });

  it("preserves caller-owned file descriptors around harness runs", () => {
    const workDir = tempDirs.make("openclaw-docker-harness-fd-");
    const script = String.raw`
set -euo pipefail
ROOT_DIR=${shellQuote(process.cwd())}
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
  });

  it("cleans Codex npm plugin live package artifacts on every exit path", () => {
    const runner = readFileSync(CODEX_NPM_PLUGIN_LIVE_DOCKER_E2E_PATH, "utf8");
    expectTextToIncludeAll(runner, ['CODEX_PLUGIN_PACK_DIR=""', 'run_log=""', "trap cleanup EXIT"]);

    expect(runner).toMatch(
      /cleanup\(\) \{[\s\S]*rm -rf "\$CODEX_PLUGIN_PACK_DIR"[\s\S]*docker_e2e_cleanup_package_tgz "\$PACKAGE_TGZ"[\s\S]*rm -f "\$run_log"/u,
    );

    expect(runner).not.toContain('rm -f "$run_log"\n  exit 1');
  });

  it("wires the Codex npm plugin live assertion boundary into Docker", () => {
    const runner = readFileSync(CODEX_NPM_PLUGIN_LIVE_DOCKER_E2E_PATH, "utf8");
    expectTextToIncludeAll(runner, [
      "docker_e2e_print_log /tmp/openclaw-codex-plugin-pack.log",
      "scripts/e2e/lib/plugins/npm-registry-server.mjs",
      'CODEX_PLUGIN_SPEC="npm:${CODEX_PLUGIN_REGISTRY_PACKAGE}@${CODEX_PLUGIN_REGISTRY_VERSION}"',
      'export NPM_CONFIG_REGISTRY="http://127.0.0.1:$(cat "$registry_port_file")"',
      "trap cleanup_scenario EXIT",
      'openclaw_e2e_stop_process "${registry_pid:-}"',
      'if [ "$status" -ne 0 ] && [ "$debug_logs_dumped" -eq 0 ]; then',
      "assert-agent-error",
      "assert-followthrough",
      "followthrough-turn.mjs",
      "if openclaw_e2e_run_command node scripts/e2e/lib/codex-npm-plugin-live/followthrough-turn.mjs",
      "docker_e2e_read_positive_int_env OPENCLAW_CODEX_NPM_PLUGIN_AGENT_TIMEOUT_SECONDS 420",
      'docker_e2e_read_positive_int_env OPENCLAW_CODEX_NPM_PLUGIN_AGENT_TIMEOUT_SECONDS "$AGENT_TURN_TIMEOUT_SECONDS"',
      '-e "OPENCLAW_CODEX_NPM_PLUGIN_AGENT_TIMEOUT_SECONDS=$AGENT_TURN_TIMEOUT_SECONDS"',
      '-e "OPENCLAW_E2E_COMMAND_TIMEOUT=$COMMAND_TIMEOUT"',
      '--timeout "$AGENT_TURN_TIMEOUT_SECONDS"',
    ]);
    expect(runner).not.toContain("cat /tmp/openclaw-codex-plugin-pack.log");
    expect(runner).not.toContain('CODEX_PLUGIN_SPEC="npm-pack:$container_path"');
    expect(runner).not.toContain("trap 'openclaw_e2e_stop_process \"${registry_pid:-}\"' EXIT");
    expectTextToIncludeAll(runner, [
      "'continuesSourceReplyProgress'",
      'FOLLOWTHROUGH_PROGRESS_FINAL_MODE="explicit"',
      'FOLLOWTHROUGH_PROGRESS_FINAL_MODE="legacy"',
      'FOLLOWTHROUGH_PROGRESS_INSTRUCTION="with final=false"',
      'FOLLOWTHROUGH_PROGRESS_INSTRUCTION="without passing final"',
      "message(action=send) $FOLLOWTHROUGH_PROGRESS_INSTRUCTION",
      "final=true and send exactly",
    ]);
    expect(runner).not.toContain("--timeout 420");
  });

  it("prints the OpenAI chat-tools gateway log when startup exits early", () => {
    const scenario = readFileSync(OPENAI_CHAT_TOOLS_SCENARIO_PATH, "utf8");
    expectTextToIncludeAll(scenario, [
      'if ! kill -0 "$gateway_pid" 2>/dev/null',
      'echo "gateway exited before listening" >&2',
      'openclaw_e2e_print_log "$GATEWAY_LOG" >&2',
    ]);
  });

  it("writes the packaged Codex follow-through result independently of stdout logs", () => {
    const workDir = tempDirs.make("openclaw-codex-followthrough-");
    const packageRoot = join(workDir, "package");
    const runtimeDir = join(packageRoot, "dist", "plugin-sdk");
    const outputPath = join(workDir, "result.json");
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), '{"type":"module"}\n');
    writeFileSync(
      join(runtimeDir, "agent-runtime.js"),
      [
        "export async function agentCommandFromIngress(opts, runtime) {",
        '  runtime.log("unexpected runtime output");',
        '  console.log("unexpected subsystem output");',
        "  return { captured: opts };",
        "}",
      ].join("\n"),
    );

    const result = spawnSync(
      process.execPath,
      [
        CODEX_NPM_PLUGIN_LIVE_FOLLOWTHROUGH_PATH,
        packageRoot,
        "followthrough-session",
        "openai/gpt-5.4",
        "90",
        outputPath,
        "follow through",
      ],
      { encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("unexpected subsystem output");
    const phases = result.stdout
      .split("\n")
      .filter((line) => line.startsWith('{"phase":"followthrough:'))
      .map((line) => JSON.parse(line).phase);
    expect(phases).toEqual([
      "followthrough:import-start",
      "followthrough:import-complete",
      "followthrough:turn-start",
      "followthrough:turn-and-cleanup-complete",
      "followthrough:result-written",
      "followthrough:before-exit",
    ]);
    expect(JSON.parse(readFileSync(outputPath, "utf8"))).toEqual({
      captured: expect.objectContaining({
        sessionId: "followthrough-session",
        model: "openai/gpt-5.4",
        message: "follow through",
        thinking: "medium",
        timeout: "90",
        json: true,
        sourceReplyDeliveryMode: "message_tool_only",
        allowModelOverride: true,
        cleanupBundleMcpOnRunEnd: true,
        cleanupCliLiveSessionOnRunEnd: true,
        oneShotCliRun: true,
      }),
    });
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

  it("uses each authorized frozen release's shipped scenario assertions", () => {
    for (const [runnerPath, assertionPath] of [
      [CODEX_ON_DEMAND_DOCKER_E2E_PATH, "scripts/e2e/lib/codex-on-demand/assertions.mjs"],
      [
        NPM_ONBOARD_CHANNEL_AGENT_DOCKER_E2E_PATH,
        "scripts/e2e/lib/npm-onboard-channel-agent/assertions.mjs",
      ],
      [UPGRADE_SURVIVOR_DOCKER_E2E_PATH, "scripts/e2e/lib/upgrade-survivor/assertions.mjs"],
      [
        PLUGIN_UPDATE_CORRUPT_DOCKER_E2E_PATH,
        "scripts/e2e/lib/plugin-update/corrupt-update-scenario.sh",
      ],
      [KITCHEN_SINK_PLUGIN_DOCKER_E2E_PATH, "scripts/e2e/lib/kitchen-sink-plugin/assertions.mjs"],
    ] as const) {
      const runner = readFileSync(runnerPath, "utf8");
      expect(runner).toContain(`openclaw_resolve_frozen_target_file`);
      expect(runner).toContain(`${assertionPath}:ro`);
    }
  });

  it("serves the version-matched Codex candidate during package onboarding", () => {
    const runner = readFileSync(CODEX_ON_DEMAND_DOCKER_E2E_PATH, "utf8");
    const registryHelper = readFileSync(PREPUBLISH_PLUGIN_REGISTRY_HELPER_PATH, "utf8");

    expectTextToIncludeAll(runner, [
      "OPENCLAW_DOCKER_ALL_LANES=codex-on-demand",
      "source scripts/e2e/lib/prepublish-plugin-registry.sh",
      'docker_e2e_package_mount_args "$PACKAGE_TGZ"',
      "openclaw_prepublish_plugin_registry_start_mounted",
      "'[\"@openclaw/codex\"]'",
    ]);
    expectTextToIncludeAll(registryHelper, [
      'OPENCLAW_NPM_REGISTRY_DIST_TAGS="$dist_tags"',
      'OPENCLAW_NPM_REGISTRY_UPSTREAM="${OPENCLAW_NPM_REGISTRY_UPSTREAM:-https://registry.npmjs.org}"',
    ]);
    expect(runner.indexOf("openclaw_e2e_install_package")).toBeLessThan(
      runner.indexOf("\nconfigure_plugin_registry\n"),
    );
    expect(runner.indexOf("\nconfigure_plugin_registry\n")).toBeLessThan(
      runner.indexOf("\nopenclaw onboard --non-interactive"),
    );
  });

  it("reuses the candidate registry lifecycle for channel onboarding", () => {
    const runner = readFileSync(NPM_ONBOARD_CHANNEL_AGENT_DOCKER_E2E_PATH, "utf8");

    expectTextToIncludeAll(runner, [
      'source "$ROOT_DIR/scripts/e2e/lib/prepublish-plugin-registry.sh"',
      'docker_e2e_package_mount_args "$PACKAGE_TGZ"',
      "openclaw_prepublish_plugin_registry_start_mounted",
      "'[\"@openclaw/codex\"]'",
    ]);
    expect(runner.indexOf("openclaw_prepublish_plugin_registry_start_mounted")).toBeLessThan(
      runner.indexOf("\nopenclaw_e2e_install_package"),
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
    expectTextToIncludeAll(runner, [
      'source "$ROOT_DIR/scripts/lib/openclaw-e2e-instance.sh"',
      'AGENT_TURN_TIMEOUT_SECONDS="$(openclaw_e2e_read_positive_int_env OPENCLAW_LIVE_PLUGIN_TOOL_TIMEOUT_SECONDS 300)"',
      'AGENT_TURN_TIMEOUT_SECONDS="$(openclaw_e2e_read_positive_int_env OPENCLAW_LIVE_PLUGIN_TOOL_TIMEOUT_SECONDS "$AGENT_TURN_TIMEOUT_SECONDS")"',
      'COMMAND_TIMEOUT="${OPENCLAW_E2E_COMMAND_TIMEOUT:-$((10#$AGENT_TURN_TIMEOUT_SECONDS + 60))s}"',
      'AGENT_OUTPUT_MAX_BYTES="$(openclaw_e2e_read_positive_int_env OPENCLAW_LIVE_PLUGIN_TOOL_AGENT_OUTPUT_MAX_BYTES 1048576)"',
      'AGENT_OUTPUT_DUMP_BYTES="$(openclaw_e2e_read_nonnegative_int_env OPENCLAW_LIVE_PLUGIN_TOOL_AGENT_OUTPUT_DUMP_BYTES 16384)"',
      'SESSION_SCAN_MAX_ENTRIES="$(openclaw_e2e_read_positive_int_env OPENCLAW_LIVE_PLUGIN_TOOL_SESSION_SCAN_MAX_ENTRIES 50000)"',
      '-e "OPENCLAW_LIVE_PLUGIN_TOOL_AGENT_OUTPUT_DUMP_BYTES=$AGENT_OUTPUT_DUMP_BYTES"',
      '-e "OPENCLAW_LIVE_PLUGIN_TOOL_AGENT_OUTPUT_MAX_BYTES=$AGENT_OUTPUT_MAX_BYTES"',
      '-e "OPENCLAW_LIVE_PLUGIN_TOOL_SESSION_SCAN_MAX_ENTRIES=$SESSION_SCAN_MAX_ENTRIES"',
      '-e "OPENCLAW_E2E_COMMAND_TIMEOUT=$COMMAND_TIMEOUT"',
      "OPENCLAW_LIVE_PLUGIN_TOOL_AGENT_OUTPUT_DUMP_BYTES",
      'tail -c "$agent_output_dump_bytes" /tmp/openclaw-agent.json',
    ]);
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

    expect(runner).not.toContain(
      'AGENT_OUTPUT_MAX_BYTES="${OPENCLAW_LIVE_PLUGIN_TOOL_AGENT_OUTPUT_MAX_BYTES:-1048576}"',
    );

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
    expectTextToIncludeAll(runner, [
      'npm pack --pack-destination "$fixture_dir" --silent',
      "/tmp/openclaw-live-plugin-tool-pack.log",
      "find \"$fixture_dir\" -maxdepth 1 -type f -name '*.tgz' | sort",
      "Expected one packed fixture plugin tarball",
      "openclaw_e2e_dump_logs /tmp/openclaw-live-plugin-tool-pack.log",
      'plugin_tgz="${plugin_tgzs[0]}"',
    ]);

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

  it.each([
    ["printed log bytes", "OPENCLAW_DOCKER_E2E_LOG_PRINT_BYTES", "64kb"],
    ["heartbeat termination grace", "OPENCLAW_DOCKER_E2E_HEARTBEAT_TERM_GRACE_SECONDS", "soon"],
  ])("rejects invalid Docker E2E %s before setup", (_label, envName, value) => {
    const workDir = tempDirs.make("openclaw-docker-e2e-log-invalid-");
    const script = repoShell(workDir)`
export ${envName}=${shellQuote(value)}

source "$ROOT_DIR/scripts/lib/docker-e2e-logs.sh"

run_logged_print_heartbeat plugins-run 30 bash -c 'printf "should not print\\\\n"'
`;

    const result = spawnSync("bash", ["-lc", script], { encoding: "utf8" });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`invalid ${envName}: ${value}`);
    expect(result.stdout).toBe("");
  });

  it("rejects invalid Docker E2E log heartbeat env before harness setup", () => {
    const workDir = tempDirs.make("openclaw-docker-e2e-log-heartbeat-invalid-");
    const script = repoShell(workDir)`
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
  });

  it("preserves heredoc stdin through Docker E2E heartbeat logging", () => {
    const workDir = tempDirs.make("openclaw-docker-e2e-log-stdin-");
    const script = repoShell(workDir)`

source "$ROOT_DIR/scripts/lib/docker-e2e-logs.sh"

run_logged_print_heartbeat plugins-run 30 bash -s <<'SH'
printf "first payload line\\nsecond payload line\\n"
SH
`;

    expect(execFileSync("bash", ["-lc", script], { encoding: "utf8" })).toBe(
      "first payload line\nsecond payload line\n",
    );
  });

  it("preserves failing heredoc output and status through Docker E2E heartbeat logging", () => {
    const workDir = tempDirs.make("openclaw-docker-e2e-log-failing-stdin-");
    const script = repoShell(workDir)`

source "$ROOT_DIR/scripts/lib/docker-e2e-logs.sh"

run_logged_print_heartbeat plugins-run 30 bash -s <<'SH'
printf "captured failure output\\n"
exit 37
SH
`;

    const result = spawnSync("bash", ["-lc", script], { encoding: "utf8" });

    expect(result.status).toBe(37);
    expect(result.stdout).toBe("captured failure output\n");
    expect(result.stderr).toBe("");
  });

  it("does not delay fast successful Docker E2E log captures until the next heartbeat", () => {
    const workDir = tempDirs.make("openclaw-docker-e2e-log-fast-heartbeat-");
    const script = repoShell(workDir)`

source "$ROOT_DIR/scripts/lib/docker-e2e-logs.sh"

output="$(run_logged_print_heartbeat plugins-run 30 bash -c 'printf "quick container log\\\\n"')"
[[ "$output" = "quick container log" ]]
`;
    const startedAt = Date.now();

    execFileSync("bash", ["-lc", script], { encoding: "utf8" });

    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("normalizes zero-padded Docker E2E log heartbeat intervals", () => {
    const script = repoRootShell`
export ROOT_DIR

source "$ROOT_DIR/scripts/lib/docker-e2e-logs.sh"

[[ "$(docker_e2e_normalize_positive_int_value 'Docker E2E log heartbeat interval' 08)" = "8" ]]
`;

    execFileSync("bash", ["-lc", script], { encoding: "utf8" });
  });

  it("includes procps in the shared Docker E2E image for process watchdogs", () => {
    const dockerfile = readFileSync("scripts/e2e/Dockerfile", "utf8");
    expect(dockerfile).toContain("procps");
  });

  it("copies the pnpm lockfile into the runtime image before normalizing its permissions", () => {
    const dockerfile = readFileSync("Dockerfile", "utf8");
    const copy = "COPY --from=runtime-assets --chown=node:node /app/pnpm-lock.yaml .";
    const chmod = "chmod a+r /app/pnpm-lock.yaml";

    expect(dockerfile).toContain(copy);
    expect(dockerfile.indexOf(copy)).toBeLessThan(dockerfile.indexOf(chmod));
  });

  it("caches package downloads across prepared Docker E2E image builds", () => {
    const dockerfile = readFileSync("scripts/e2e/Dockerfile", "utf8");
    expect(dockerfile).toContain(
      "--mount=type=cache,target=/home/appuser/.npm,uid=1001,gid=1001,sharing=locked",
    );
  });

  it("proves fs-safe native and fallback behavior across packaged Docker installs", () => {
    const dockerfile = readFileSync("scripts/e2e/Dockerfile", "utf8");
    const packageRunner = readFileSync(DOCKER_PACKAGE_INSTALL_E2E_PATH, "utf8");
    const updateRunner = readFileSync(UPDATE_CHANNEL_SWITCH_DOCKER_E2E_PATH, "utf8");

    expect(dockerfile).toContain("AS musl");
    expect(dockerfile).toContain(
      "node /tmp/verify-fs-safe-native.mjs --package-root /app --mode require",
    );
    expect(packageRunner.match(/verify-fs-safe-native\.mjs[^\n]+--mode require/gu)).toHaveLength(3);
    expect(packageRunner).toContain("bash scripts/e2e/bun-global-install-smoke.sh");
    expect(packageRunner.match(/-e OPENCLAW_FS_SAFE_NATIVE_CONTRACT/g)).toHaveLength(4);
    expectTextToIncludeAll(packageRunner, [
      'MUSL_FS_SAFE_NATIVE_OUTCOME="passed"',
      'MUSL_FS_SAFE_NATIVE_OUTCOME="not-applicable"',
      '--detail "musl:fsSafeNative=$MUSL_FS_SAFE_NATIVE_OUTCOME"',
    ]);
    expect(updateRunner).toContain('mv "$platform_package" "$platform_package.omitted"');
    expect(updateRunner).toContain("--mode fallback");
    expect(updateRunner).toContain("-e OPENCLAW_FS_SAFE_NATIVE_CONTRACT");
  });

  it("verifies fs-safe through a pnpm-style linked package root", () => {
    const root = realpathSync(tempDirs.make("openclaw-linked-package-proof-"));
    const modules = join(root, "node_modules");
    const virtualModules = join(modules, ".pnpm/openclaw@fixture/node_modules");
    const physicalRoot = join(virtualModules, "openclaw");
    const logicalRoot = join(modules, "openclaw");
    const fsSafe = join(virtualModules, "@openclaw/fs-safe");
    mkdirSync(physicalRoot, { recursive: true });
    mkdirSync(fsSafe, { recursive: true });
    writeFileSync(join(physicalRoot, "package.json"), '{"name":"openclaw"}');
    writeFileSync(
      join(physicalRoot, "cli.cjs"),
      'process.stdout.write(require.resolve("@openclaw/fs-safe"));',
    );
    writeFileSync(
      join(fsSafe, "package.json"),
      JSON.stringify({
        name: "@openclaw/fs-safe",
        type: "module",
        exports: {
          ".": "./dist/index.js",
          "./config": "./config.js",
          "./durability": "./durability.js",
        },
      }),
    );
    mkdirSync(join(fsSafe, "dist"), { recursive: true });
    writeFileSync(join(fsSafe, "dist/index.js"), "export {};\n");
    writeFileSync(
      join(fsSafe, "config.js"),
      'export function configureFsSafeNative({ mode }) { if (mode !== "off") throw new Error("fixture requires fallback mode"); }',
    );
    writeFileSync(
      join(fsSafe, "durability.js"),
      `
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
export async function sha256File(file) {
  return { digest: createHash("sha256").update(await readFile(file)).digest("hex") };
}
`,
    );
    symlinkSync(physicalRoot, logicalRoot, process.platform === "win32" ? "junction" : "dir");
    expect(
      execFileSync(process.execPath, [join(logicalRoot, "cli.cjs")], { encoding: "utf8" }),
    ).toBe(join(fsSafe, "dist/index.js"));
    for (const packageRoot of [physicalRoot, logicalRoot]) {
      const result = spawnSync(
        process.execPath,
        [
          "scripts/docker/verify-fs-safe-native.mjs",
          "--package-root",
          packageRoot,
          "--mode",
          "fallback",
        ],
        { encoding: "utf8", timeout: 10_000 },
      );
      expect(result.status, result.stdout + result.stderr).toBe(0);
    }
  });

  it("builds and cleans package-lane images without touching shared image tags", () => {
    const root = realpathSync(tempDirs.make("openclaw-package-image-owner-"));
    for (const file of [
      DOCKER_PACKAGE_INSTALL_E2E_PATH,
      DOCKER_E2E_IMAGE_HELPER_PATH,
      DOCKER_E2E_PACKAGE_HELPER_PATH,
      HELPER_PATH,
      "scripts/lib/docker-e2e-logs.sh",
      "scripts/lib/docker-e2e-container.sh",
      "scripts/lib/docker-e2e-resource-diagnostics.sh",
      PREPUBLISH_PLUGIN_REGISTRY_HELPER_PATH,
    ]) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      copyFileSync(file, join(root, file));
    }
    mkdirSync(join(root, "packages/normalization-core/src"), { recursive: true });
    const tarball = join(root, "candidate.tgz");
    writeFileSync(tarball, "synthetic package admission fixture");
    const registry = join(root, "registry");
    mkdirSync(registry);
    writeFileSync(
      join(registry, "prepublish-plugin-registry.json"),
      JSON.stringify({
        sourceSha: "a".repeat(40),
        candidateVersion: "2026.9.1",
        packages: [],
      }),
    );
    const log = join(root, "docker.jsonl");
    const bin = join(root, "bin");
    writeExecutables(bin, {
      pnpm: '#!/bin/bash\n[[ "$*" == test:docker:package-install ]] || exit 97\nexec bash scripts/e2e/docker-package-install.sh\n',
      docker: `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === 'build') process.exit(0);
if (args[0] === 'image' && args[1] === 'inspect') process.exit(args[2] === 'shared-bare:fixture' ? 0 : 1);
if (args[0] === 'image' && args[1] === 'rm' || args[0] === 'rm') process.exit(0);
// No container body runs. Fail the final creation to exercise the real owner's cleanup.
if (args[0] === 'run' && fs.readFileSync(${JSON.stringify(log)}, 'utf8').trim().split('\\n').map(JSON.parse).filter(call => call[0] === 'run').length < 4) process.exit(0);
process.exit(73);
`,
    });
    const command = mainLanes.find((lane) => lane.name === "docker-package-install")?.command;
    expect(command).toBeDefined();
    const result = spawnSync("bash", ["-c", command!], {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
      env: {
        PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
        TMPDIR: root,
        OPENCLAW_CURRENT_PACKAGE_TGZ: tarball,
        OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR: registry,
        OPENCLAW_DOCKER_E2E_IMAGE: "shared-bare:fixture",
        OPENCLAW_DOCKER_E2E_REQUIRE_LOCAL_IMAGE: "1",
        OPENCLAW_DOCKER_BUILD_ON_MISSING: "0",
      },
    });
    expect(result.status, result.stdout + result.stderr).toBe(73);
    const calls = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const builds = calls.filter((args) => args[0] === "build");
    expect(builds.map((args) => args[args.indexOf("--target") + 1])).toEqual(["bare", "musl"]);
    const tags = builds.map((args) => args[args.indexOf("-t") + 1]);
    expect(new Set(tags).size).toBe(2);
    expect(calls.flat()).not.toContain("shared-bare:fixture");
    expect(
      calls
        .filter((args) => args[0] === "image" && args[1] === "rm")
        .flatMap((args) => args.slice(2)),
    ).toEqual(tags);
    expect(calls.findIndex((args) => args[0] === "run")).toBeGreaterThan(calls.indexOf(builds[1]!));
    const runs = calls.filter((args) => args[0] === "run");
    expect(runs).toHaveLength(4);
    for (const args of runs) {
      expect(args).toContain(`${tarball}:/tmp/openclaw-current.tgz:ro`);
      expect(args).toContain(`${registry}:/tmp/openclaw-prepublish-plugin-registry:ro`);
      expect(args[args.indexOf("--entrypoint") + 1]).toBe(
        "/opt/openclaw-e2e/scripts/e2e/lib/prepublish-plugin-registry.sh",
      );
    }
  });

  it("keeps the shared e2e image on the packaged tarball install path", () => {
    const dockerfile = readFileSync("scripts/e2e/Dockerfile", "utf8");

    expect(dockerfile).not.toContain("pnpm install --frozen-lockfile");
    expect(dockerfile).not.toContain("COPY . .");
    expect(dockerfile).toMatch(
      /^COPY --from=openclaw_package --chown=appuser:appuser openclaw-current\.tgz \/tmp\/openclaw-current\.tgz$/m,
    );
    // Cache registry dependencies by manifest, not by each PR's built tarball.
    expect(dockerfile).toContain(
      "COPY --from=functional-manifest --chown=appuser:appuser /tmp/openclaw-deps /tmp/openclaw-deps",
    );
    expect(dockerfile).toContain("npm install --omit=dev --no-fund --no-audit");
    expect(dockerfile).not.toContain("npm install -g --prefix");
    expect(dockerfile).toContain(
      "COPY --from=functional-deps --chown=appuser:appuser /tmp/openclaw-deps/node_modules /app/node_modules",
    );
    // Complete the lifecycle before the self-link lets pruning cycle back into /app.
    const postinstallIndex = dockerfile.indexOf(
      "node /app/scripts/postinstall-bundled-plugins.mjs",
    );
    const selfLinkIndex = dockerfile.indexOf("ln -sfn /app /app/node_modules/openclaw");
    expect(postinstallIndex).toBeGreaterThan(-1);
    expect(selfLinkIndex).toBeGreaterThan(postinstallIndex);
  });

  it("keeps onboarding Docker E2E resource-guarded", () => {
    const runner = readFileSync(ONBOARD_DOCKER_E2E_PATH, "utf8");
    expectTextToIncludeAll(runner, [
      "OPENCLAW_ONBOARD_MAX_MEMORY_MIB",
      "OPENCLAW_ONBOARD_MAX_CPU_PERCENT",
      'COMMAND_TIMEOUT="${OPENCLAW_ONBOARD_COMMAND_TIMEOUT:-${OPENCLAW_E2E_COMMAND_TIMEOUT:-300s}}"',
      'GATEWAY_WAIT_ATTEMPTS="$(openclaw_e2e_read_positive_int_env OPENCLAW_ONBOARD_GATEWAY_WAIT_ATTEMPTS 20)"',
      'GATEWAY_WAIT_INTERVAL_S="$(docker_e2e_read_nonnegative_decimal_env OPENCLAW_ONBOARD_GATEWAY_WAIT_INTERVAL_S 1)"',
      '-e "OPENCLAW_E2E_COMMAND_TIMEOUT=$COMMAND_TIMEOUT"',
      '-e "OPENCLAW_ONBOARD_GATEWAY_WAIT_ATTEMPTS=$GATEWAY_WAIT_ATTEMPTS"',
      '-e "OPENCLAW_ONBOARD_GATEWAY_WAIT_INTERVAL_S=$GATEWAY_WAIT_INTERVAL_S"',
      '--name "$CONTAINER_NAME"',
      "docker_e2e_sample_stats_until_exit \\",
      '"$STATS_LOG" \\',
      '"$RUN_LOG" \\',
      "assert-resource-ceiling.mjs",
    ]);

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

  it("materializes legacy bundle-MCP client links before its read-only Docker mount", () => {
    const runner = readFileSync(AGENT_BUNDLE_MCP_TOOLS_DOCKER_E2E_PATH, "utf8");

    expectTextToIncludeAll(runner, [
      'ln -s /app/dist "$LEGACY_CLIENT_SOURCE_ROOT/dist"',
      'ln -s /app/node_modules "$LEGACY_CLIENT_SOURCE_ROOT/node_modules"',
      '-v "$LEGACY_CLIENT_SOURCE_ROOT:$LEGACY_CLIENT_ROOT:ro"',
    ]);
    expect(runner).not.toContain("CLIENT_PRELUDE");
  });

  it("keeps Open WebUI Docker E2E resource-guarded", () => {
    const runner = readFileSync(OPENWEBUI_DOCKER_E2E_PATH, "utf8");
    expectTextToIncludeAll(runner, [
      'validate_positive_int OPENCLAW_OPENWEBUI_PROVIDER_TIMEOUT_SECONDS "$PROVIDER_TIMEOUT_SECONDS"',
      'validate_positive_int OPENCLAW_OPENWEBUI_FETCH_TIMEOUT_MS "$PROBE_FETCH_TIMEOUT_MS"',
      "docker_e2e_read_tcp_port_env OPENCLAW_OPENWEBUI_GATEWAY_PORT 18789",
      "docker_e2e_read_tcp_port_env OPENCLAW_OPENWEBUI_PORT 8080",
      "OPENCLAW_OPENWEBUI_MAX_MEMORY_MIB",
      "OPENCLAW_OPENWEBUI_MAX_CPU_PERCENT",
      'STATS_LOG="$(mktemp',
      'PROBE_LOG="$(mktemp',
      'STATS_STOP_FILE="$(mktemp',
      "sample_openwebui_stats_once()",
      "start_openwebui_stats_sampler()",
      "start_openwebui_stats_sampler\n",
      'node "$entry" doctor --fix --yes --force',
      `openclaw_e2e_exec_gateway "$entry" '"$PORT"' lan`,
      'for container_name in "$GW_NAME" "$OW_NAME"; do',
      '"$GW_NAME" \\',
      '"$OW_NAME" \\',
      '"$container_name" >>"$STATS_LOG"',
      "assert_openwebui_stats()",
      'node scripts/e2e/lib/docker-stats/assert-resource-ceiling.mjs "$STATS_LOG" "$MAX_MEMORY_MIB" "$MAX_CPU_PERCENT" openwebui',
      'node /app/scripts/e2e/openwebui-probe.mjs >"$PROBE_LOG" 2>&1 &',
    ]);

    expect(runner).toMatch(
      /cleanup\(\) \{[\s\S]*rm -f "\$STATS_STOP_FILE"[\s\S]*wait "\$stats_pid"/u,
    );
    expect(runner).toMatch(/cleanup\(\) \{[\s\S]*rm -f "\$STATS_LOG" "\$PROBE_LOG"/u);

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
        OPENAI_API_KEY: "",
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

      expectTextToIncludeAll(runner, [
        'CLIENT_TIMEOUT_MS="$(docker_e2e_read_positive_int_env OPENCLAW_MCP_CODE_MODE_CLIENT_TIMEOUT_MS 300000)"',
        'CLIENT_BODY_MAX_BYTES="$(docker_e2e_read_positive_int_env OPENCLAW_MCP_CODE_MODE_CLIENT_BODY_MAX_BYTES 1048576)"',
        '-e "OPENCLAW_MCP_CODE_MODE_CLIENT_TIMEOUT_MS=$CLIENT_TIMEOUT_MS"',
        '-e "OPENCLAW_MCP_CODE_MODE_CLIENT_BODY_MAX_BYTES=$CLIENT_BODY_MAX_BYTES"',
      ]);
    },
  );

  it("passes source-qualified overrides without leaking frozen control-plane identity", () => {
    const runner = readFileSync(MCP_CODE_MODE_GATEWAY_DOCKER_E2E_PATH, "utf8");

    expectTextToIncludeAll(runner, [
      "MCP_CODE_MODE_SEED_ENV_ARGS=()",
      "OPENCLAW_FROZEN_TARGET_MCP_MEMORY_CONFIG_MODE=agent",
      "OPENCLAW_FROZEN_TARGET_MCP_CODE_MODE_CATALOG_MODE=legacy",
      '"${MCP_CODE_MODE_SEED_ENV_ARGS[@]}"',
    ]);
    for (const path of [
      MCP_CODE_MODE_GATEWAY_DOCKER_E2E_PATH,
      ONBOARD_DOCKER_E2E_PATH,
      "scripts/e2e/session-runtime-context-docker.sh",
    ]) {
      const source = readFileSync(path, "utf8");
      expect(source).not.toContain('-e "OPENCLAW_SELECTED_SHA=$OPENCLAW_SELECTED_SHA"');
      expect(source).not.toContain('-e "OPENCLAW_TOOLING_SHA=$OPENCLAW_TOOLING_SHA"');
    }
    const liveGateway = readFileSync("scripts/test-live-gateway-models-docker.sh", "utf8");
    expect(liveGateway).not.toContain("OPENCLAW_SELECTED_SHA");
    expect(liveGateway).not.toContain("OPENCLAW_TOOLING_SHA");
    expectTextToIncludeAll(liveGateway, [
      'openclaw_resolve_frozen_live_cli_backend_package_mode "$ROOT_DIR"',
      "OPENCLAW_FROZEN_TARGET_LIVE_CLI_BACKEND_PACKAGE_MODE=legacy",
    ]);
  });

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
      [...`${client}\n${writer}`.matchAll(/["`](OPENCLAW_OPENAI_CHAT_TOOLS_[A-Z0-9_]+)["`]/gu)]
        .map((match) => match[1])
        .filter((envName): envName is string => envName !== undefined),
    );
    const forwarded = new Set(
      [...runner.matchAll(/-e\s+"(OPENCLAW_OPENAI_CHAT_TOOLS_[A-Z0-9_]+)=/gu)]
        .map((match) => match[1])
        .filter((envName): envName is string => envName !== undefined),
    );
    const missing = [...consumed]
      .filter((envName) => !forwarded.has(envName))
      .toSorted((left, right) => left.localeCompare(right));

    expect(missing).toEqual([]);
  });

  it("forwards every kitchen-sink RPC runtime env knob into Docker", () => {
    const runner = readFileSync(KITCHEN_SINK_RPC_DOCKER_E2E_PATH, "utf8");
    const walk = readFileSync("scripts/e2e/kitchen-sink-rpc-walk.mts", "utf8");
    const consumed = new Set(
      [...walk.matchAll(/\b(?:env|process\.env)\.(OPENCLAW_KITCHEN_SINK_[A-Z0-9_]+)/gu)]
        .map((match) => match[1])
        .filter((envName): envName is string => envName !== undefined),
    );
    const forwarded = new Set(
      [...runner.matchAll(/\b(OPENCLAW_KITCHEN_SINK_[A-Z0-9_]+)\b/gu)]
        .map((match) => match[1])
        .filter((envName): envName is string => envName !== undefined),
    );
    const missing = [...consumed]
      .filter((envName) => !forwarded.has(envName))
      .toSorted((left, right) => left.localeCompare(right));

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

    expectTextToIncludeAll(runner, [
      'KITCHEN_SINK_CLI_TIMEOUT="${OPENCLAW_KITCHEN_SINK_PLUGIN_CLI_TIMEOUT:-${KITCHEN_SINK_CLI_TIMEOUT:-180s}}"',
      "docker_e2e_read_positive_int_env OPENCLAW_DOCKER_E2E_LOG_PRINT_BYTES 65536",
      "docker_e2e_read_positive_int_env OPENCLAW_CLAWHUB_FIXTURE_WAIT_ATTEMPTS 600",
      '-e "OPENCLAW_CLAWHUB_FIXTURE_WAIT_ATTEMPTS=$CLAW_HUB_FIXTURE_WAIT_ATTEMPTS"',
      '-e "OPENCLAW_DOCKER_E2E_LOG_PRINT_BYTES=$OPENCLAW_DOCKER_E2E_LOG_PRINT_BYTES"',
      '-e "KITCHEN_SINK_CLI_TIMEOUT=$KITCHEN_SINK_CLI_TIMEOUT"',
    ]);

    expectTextToIncludeAll(sweep, [
      'KITCHEN_SINK_CLI_TIMEOUT="${KITCHEN_SINK_CLI_TIMEOUT:-180s}"',
      "run_kitchen_sink_openclaw_logged()",
      "run_kitchen_sink_openclaw_capture()",
      'local log_file="${KITCHEN_SINK_TMP_DIR}/${safe_label}.log"',
    ]);

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
    expect(packageRunner).not.toMatch(/(^|\n)\s*docker rm -f/u);
    expect(packageRunner).toContain("docker_e2e_docker_cmd rm -f");
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

  it("copies the complete bun harness closure into the package-install lane", () => {
    const packageRunner = readFileSync(DOCKER_PACKAGE_INSTALL_E2E_PATH, "utf8");
    const listMatch = /for harness_path in \\\n([^;]*); do/u.exec(packageRunner);
    expect(listMatch, "bun harness copy list").toBeTruthy();
    const copiedRoots = [...(listMatch?.[1] ?? "").matchAll(/[^\s\\]+/gu)].map((match) => match[0]);
    expect(copiedRoots.length).toBeGreaterThan(0);
    for (const root of copiedRoots) {
      expect(existsSync(root), `${root} missing from repo`).toBe(true);
    }
    const isCopied = (file: string) =>
      copiedRoots.some((root) => file === root || file.startsWith(`${root}/`));

    // Walk every source/import/spawn reachable from the bun smoke entrypoint.
    // Anything outside the copied roots crashes the bun proof container at
    // runtime on its /repo mount, the way the #129552 e2e-instance drift did.
    const pending = ["scripts/e2e/bun-global-install-smoke.sh"];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const file = pending.pop() ?? "";
      if (visited.has(file)) {
        continue;
      }
      visited.add(file);
      expect(existsSync(file), `${file} referenced by the bun harness is missing`).toBe(true);
      const body = readFileSync(file, "utf8");
      const requirements: string[] = [];
      for (const match of body.matchAll(/source "\$ROOT_DIR\/([^"]+)"/gu)) {
        requirements.push(match[1] ?? "");
      }
      for (const match of body.matchAll(/source "\$[0-9A-Z_]+_LIB_DIR\/([^"]+)"/gu)) {
        requirements.push(join(dirname(file), match[1] ?? ""));
      }
      for (const match of body.matchAll(/from "(\.\.?\/[^"]+)"/gu)) {
        requirements.push(join(dirname(file), match[1] ?? ""));
      }
      for (const match of body.matchAll(/\bnode (scripts\/[^\s"']+\.(?:mjs|ts))/gu)) {
        requirements.push(match[1] ?? "");
      }
      for (const requirement of requirements) {
        expect(
          isCopied(requirement),
          `${file} needs ${requirement} inside the bun harness copy roots`,
        ).toBe(true);
        pending.push(requirement);
      }
    }
    expect(visited.size).toBeGreaterThan(3);
  });

  it("executes each CLI distribution boundary instead of promoting metadata", () => {
    const installerRunner = readFileSync(CLI_INSTALLER_DISTRIBUTION_E2E_PATH, "utf8");
    const packageRunner = readFileSync(DOCKER_PACKAGE_INSTALL_E2E_PATH, "utf8");
    const updateRunner = readFileSync(UPDATE_CHANNEL_SWITCH_DOCKER_E2E_PATH, "utf8");

    expectTextToIncludeAll(packageRunner, [
      "--user root",
      "npm install -g /tmp/openclaw-current.tgz",
      "runuser -u appuser -- openclaw --version",
      "runuser -u appuser -- openclaw --help",
      'corepack prepare "$1" --activate',
      "pnpm list --global --json",
      'test -f "$package_root/package.json"',
      'test "$PNPM_PACKAGE_VERSION" = "$PACKAGE_VERSION"',
      "pnpm add --global openclaw@file:/tmp/openclaw-current.tgz",
      'pnpm approve-builds --global "$artifact_build"',
      "bun@1.4.0",
      'test "$(command -v openclaw)" = "/usr/local/bin/openclaw"',
      'test "$(command -v openclaw)" = "$PNPM_HOME/bin/openclaw"',
      "OPENCLAW_BUN_GLOBAL_SMOKE_PROOF_PATH",
      'PACKAGE_HARNESS_DIR="$(mktemp -d',
      "chmod -R a+rX",
      '-v "$PACKAGE_HARNESS_DIR:/repo:ro"',
      '--container "npm=$NPM_PROOF_CONTAINER"',
      '--container "pnpm=$PNPM_PROOF_CONTAINER"',
      '--container "bun=$BUN_PROOF_CONTAINER"',
    ]);
    expect(packageRunner).not.toContain('-v "$ROOT_DIR:/repo:ro"');
    expectTextToIncludeAll(installerRunner, [
      "bash /tmp/install.sh",
      "--version file:/tmp/openclaw-current.tgz",
      'source "$HOME/.bashrc"',
      "hash -r",
      "bash /tmp/openclaw-source/scripts/install-cli.sh",
      "--install-method git",
      "--prefix /tmp/openclaw-prefix",
      "--node-version 24.19.0",
      "apt-get install -y --no-install-recommends curl",
      "command -v curl >/dev/null",
      'chmod 0555 "$SOURCE_PROOF_SCRIPT"',
      'SOURCE_MEMORY="${OPENCLAW_CLI_INSTALLER_SOURCE_MEMORY:-16g}"',
      '--memory "$SOURCE_MEMORY"',
      "runuser -u appuser",
      'test -r "$0"',
      'test -x "$0"',
      'grep -Fq "/tmp/openclaw-source/dist/entry.js" "$prefix_cli"',
      "openclaw update status --json",
      "expected git install kind",
    ]);
    expect(installerRunner.match(/--memory "\$SOURCE_MEMORY"/gu)).toHaveLength(1);
    expect(installerRunner.indexOf('--memory "$SOURCE_MEMORY"')).toBeGreaterThan(
      installerRunner.indexOf('echo "==> install-cli.sh dedicated-prefix source-checkout proof"'),
    );
    expectTextToIncludeAll(updateRunner, [
      "openclaw update --channel beta",
      'OPENCLAW_NPM_REGISTRY_DIST_TAGS="latest=0.0.0,beta=$package_version"',
      'OPENCLAW_NPM_REGISTRY_UPSTREAM="${OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_URL:-https://registry.npmjs.org}"',
      "assert-update beta",
      "assert-config-channel beta",
      "assert-installed-version",
      "assert-status-kind package",
      "openclaw update --channel stable",
    ]);
    expect(updateRunner).toContain("openclaw update --channel beta --yes --json --no-restart");
    expect(updateRunner).not.toContain("openclaw update --channel beta --tag");
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

  it("uses the selected release's legacy gateway client only after frozen authorization", () => {
    const runner = readFileSync(GATEWAY_NETWORK_DOCKER_E2E_PATH, "utf8");
    expect(runner).toContain('[[ "$FROZEN_CONTEXT" == "1" ]]');
    expect(runner).toContain("scripts/e2e/lib/gateway-network/client.mjs");
    expect(runner).toContain('-v "$LEGACY_GATEWAY_LIB:/tmp/openclaw-selected-e2e-lib:ro"');
    expect(runner).toContain("node /tmp/openclaw-selected-e2e-lib/gateway-network/client.mjs");
    expect(runner).not.toContain("/tmp/openclaw-gateway-network-client.mjs");
  });

  it("proves gateway suspension across a same-container process restart", () => {
    const runner = readFileSync(GATEWAY_NETWORK_DOCKER_E2E_PATH, "utf8");
    expectTextToIncludeAll(runner, [
      'source "$ROOT_DIR/scripts/lib/frozen-target-compat.sh"',
      "plugins enable admin-http-rpc",
      "/tmp/gateway-network-configured",
      'CAPABILITIES_DIR="$(mktemp -d',
      "GW_CAPABILITIES_PATH=$CAPABILITIES_CONTAINER_PATH",
      'CAPABILITIES_HOST_USER="$(id -u)"',
      'CAPABILITIES_HOST_GROUP="$(id -g)"',
      'if [[ ! -O "$CAPABILITIES_DIR" ]]',
      '--user "$CAPABILITIES_HOST_USER:$CAPABILITIES_HOST_GROUP"',
      "trap cleanup EXIT",
      '[[ -z "$CAPABILITIES_PATH" ]] || rm -f "$CAPABILITIES_PATH"',
      '[[ -z "$CAPABILITIES_DIR" ]] || rmdir "$CAPABILITIES_DIR"',
      'if [[ ! -O "$CAPABILITIES_PATH" ]]',
      'rm "$CAPABILITIES_PATH"',
      'rmdir "$CAPABILITIES_DIR"',
      'if [[ "$SUSPENSION_CAPABILITY" == "unsupported" ]]',
      "openclaw_frozen_target_omissions_authorized",
      "run_suspension_phase() {",
      "GW_MODE=suspension-$stage-restart",
      "run_suspension_phase pre",
      "run_suspension_phase post",
      "GW_URL=ws://127.0.0.1:$PORT",
      'SUSPENSION_STATE_PATH="/tmp/gateway-network-suspension.json"',
      'container_id="$(docker_e2e_docker_cmd inspect',
      'docker_e2e_docker_cmd stop "$GW_NAME"',
      'docker_e2e_docker_cmd start "$GW_NAME"',
      'if [[ "$restarted_container_id" != "$container_id" ]]',
      "openclaw_e2e_probe_http http://127.0.0.1:$PORT/readyz ok 400",
      'run_logged_print "gateway-network-suspension-$stage"',
      '"phase":"container-restart","durationMs":%d',
    ]);
    expect(runner).not.toContain('source "$ROOT_DIR/scripts/lib/live-docker-auth.sh"');
    expect(runner).not.toContain("openclaw_live_chown_bind_dirs_for_container_user");
    expect(runner).not.toContain("gateway-network-capabilities-dir");
    expect(runner).not.toContain("IMAGE_USER=");
    expect(runner).not.toContain("--user 0:0");
    expect(runner).not.toContain("chown");
    expect(runner).not.toContain("chmod");
    expect(runner).not.toContain('rm -rf "$CAPABILITIES_DIR"');

    const parseIndex = runner.indexOf('SUSPENSION_CAPABILITY="$(');
    const ownershipIndex = runner.indexOf('if [[ ! -O "$CAPABILITIES_PATH" ]]');
    const unlinkIndex = runner.indexOf('rm "$CAPABILITIES_PATH"', ownershipIndex);
    const rmdirIndex = runner.indexOf('rmdir "$CAPABILITIES_DIR"', ownershipIndex);
    const capabilityBranchIndex = runner.indexOf(
      'if [[ "$SUSPENSION_CAPABILITY" == "unsupported" ]]',
    );
    expect(parseIndex).toBeGreaterThanOrEqual(0);
    expect(ownershipIndex).toBeGreaterThan(parseIndex);
    expect(unlinkIndex).toBeGreaterThan(ownershipIndex);
    expect(rmdirIndex).toBeGreaterThan(unlinkIndex);
    expect(capabilityBranchIndex).toBeGreaterThan(rmdirIndex);
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
    expectTextToIncludeAll(runner, [
      "docker_e2e_read_positive_int_env OPENCLAW_GATEWAY_NETWORK_CLIENT_CONNECT_TIMEOUT_MS 80000",
      "docker_e2e_read_positive_int_env OPENCLAW_GATEWAY_NETWORK_CONNECT_READY_TIMEOUT_MS 80000",
      '-e "OPENCLAW_GATEWAY_NETWORK_CLIENT_CONNECT_TIMEOUT_MS=$CLIENT_CONNECT_TIMEOUT_MS"',
      '-e "OPENCLAW_GATEWAY_NETWORK_CONNECT_READY_TIMEOUT_MS=$CONNECT_READY_TIMEOUT_MS"',
      '"${CLIENT_LIMIT_ENV_ARGS[@]}"',
    ]);
  });

  it("requires TCP readiness for the gateway network runner", () => {
    const runner = readFileSync(GATEWAY_NETWORK_DOCKER_E2E_PATH, "utf8");
    expect(runner).toContain("openclaw_e2e_probe_tcp 127.0.0.1 $PORT");
    expect(runner).not.toMatch(/openclaw_e2e_probe_tcp[^\n]*\|\|[^\n]*gateway-net-e2e\.log/u);
  });

  it.each([
    ["Dockerfile", " AS dependency-inputs\n"],
    [CLEANUP_SMOKE_DOCKERFILE_PATH, "WORKDIR /repo\n"],
  ])("runs root lifecycles from the dependency inputs copied by %s", (file, stageMarker) => {
    const dockerfile = readFileSync(file, "utf8");
    const stageStart = dockerfile.indexOf(stageMarker);
    expect(stageStart).toBeGreaterThanOrEqual(0);
    const installIndex = dockerfile.indexOf("pnpm install --frozen-lockfile", stageStart);
    expect(installIndex).toBeGreaterThan(stageStart);
    const root = tempDirs.make("openclaw-docker-lifecycle-");
    // Execute with the image's explicit file inputs, without the later full-source COPY.
    const copies = dockerfile.slice(stageStart, installIndex).matchAll(/^COPY (.+)$/gm);
    for (const [, instruction] of copies) {
      const paths = instruction!.trim().split(/\s+/);
      if (paths[0]!.startsWith("--")) {
        continue;
      }
      const destination = paths.pop()!;
      for (const source of paths) {
        if (!statSync(source).isFile()) {
          continue;
        }
        const target = join(root, destination, destination.endsWith("/") ? basename(source) : "");
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(source, target);
      }
    }
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    for (const lifecycle of ["preinstall", "postinstall", "prepare"]) {
      const [command, ...args] = manifest.scripts[lifecycle].split(/\s+/);
      expect(command).toBe("node");
      const result = spawnSync(process.execPath, args, {
        cwd: root,
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: join(root, "home"), npm_config_user_agent: "pnpm/12" },
      });
      expect(result.status, `${file} ${lifecycle}: ${result.stderr}`).toBe(0);
    }
  });

  it("mounts root helper modules imported by bare Docker E2E scripts", () => {
    const helper = readFileSync(DOCKER_E2E_PACKAGE_HELPER_PATH, "utf8");
    expectTextToIncludeAll(helper, [
      "--allow-unreleased-changelog",
      'local harness_root="${DOCKER_E2E_HARNESS_ROOT_DIR:-$ROOT_DIR}"',
      '-v "$harness_root/scripts/prepublish-plugin-registry-artifact.mjs:/app/scripts/prepublish-plugin-registry-artifact.mjs:ro"',
      '-v "$harness_root/scripts/windows-cmd-helpers.mjs:/app/scripts/windows-cmd-helpers.mjs:ro"',
      '-v "$harness_root/packages/gateway-client/src:/app/packages/gateway-client/src:ro"',
      '-v "$harness_root/packages/normalization-core/package.json:/app/packages/normalization-core/package.json:ro"',
      '-v "$harness_root/packages/normalization-core/src:/app/packages/normalization-core/src:ro"',
      '-v "$harness_root/tsconfig.json:/app/tsconfig.json:ro"',
      '-v "$harness_root/test/e2e/qa-lab:/app/test/e2e/qa-lab:ro"',
      '-v "$harness_root/test/helpers:/app/test/helpers:ro"',
    ]);

    const script = repoRootShell`
export DOCKER_E2E_HARNESS_ROOT_DIR=/trusted-harness
source "$ROOT_DIR/scripts/lib/docker-e2e-package.sh"
docker_e2e_harness_mount_args
for ((index = 1; index < \${#DOCKER_E2E_HARNESS_ARGS[@]}; index += 2)); do
  printf "%s\\n" "\${DOCKER_E2E_HARNESS_ARGS[$index]}"
done
`;
    const mounts = execFileSync("bash", ["-lc", script], { encoding: "utf8" }).trim().split("\n");

    expect(mounts).toEqual([
      "/trusted-harness/scripts/e2e:/app/scripts/e2e:ro",
      "/trusted-harness/scripts/docker/verify-fs-safe-native.mjs:/app/scripts/docker/verify-fs-safe-native.mjs:ro",
      "/trusted-harness/scripts/lib:/app/scripts/lib:ro",
      "/trusted-harness/packages/gateway-client/src:/app/packages/gateway-client/src:ro",
      "/trusted-harness/packages/normalization-core/package.json:/app/packages/normalization-core/package.json:ro",
      "/trusted-harness/packages/normalization-core/src:/app/packages/normalization-core/src:ro",
      "/trusted-harness/tsconfig.json:/app/tsconfig.json:ro",
      "/trusted-harness/test/e2e/qa-lab:/app/test/e2e/qa-lab:ro",
      "/trusted-harness/test/helpers:/app/test/helpers:ro",
      "/trusted-harness/scripts/prepublish-plugin-registry-artifact.mjs:/app/scripts/prepublish-plugin-registry-artifact.mjs:ro",
      "/trusted-harness/scripts/windows-cmd-helpers.mjs:/app/scripts/windows-cmd-helpers.mjs:ro",
    ]);
  });

  it("preserves pnpm lookup paths for scheduled Docker child lanes", () => {
    const scheduler = readFileSync(DOCKER_ALL_SCHEDULER_PATH, "utf8");
    expect(scheduler).toContain("--allow-unreleased-changelog");
    expect(scheduler).toContain("env.PNPM_HOME");
    expect(scheduler).toContain("env.npm_execpath ? path.dirname(env.npm_execpath)");
    expect(scheduler).toContain("path.dirname(process.execPath)");
    expect(scheduler).toContain("env.PATH = [...new Set(pathEntries)].join(path.delimiter)");
    expect(scheduler).toContain(
      'env.push(["OPENCLAW_DOCKER_ALL_PNPM_COMMAND", baseEnv.OPENCLAW_DOCKER_ALL_PNPM_COMMAND]);',
    );
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

    expectTextToIncludeAll(runner, [
      'AGENT_TURNS_PARALLEL="$(read_boolean_env OPENCLAW_INSTALL_E2E_AGENT_TURNS_PARALLEL 1)"',
      'AGENT_TOOL_SMOKE="$(read_boolean_env OPENCLAW_INSTALL_E2E_AGENT_TOOL_SMOKE 1)"',
      "time_phase",
      "phase_mark_start",
      "run_agent_turn_bg",
      "wait_agent_turn_batch",
      "agent_turn_outputs_include_billing_drift",
      "SKIP: Anthropic billing drift during installer agent tool smoke",
      'run_agent_turn_bg "image write"',
      'run_agent_turn_logged_or_skip_profile "read proof copy"',
      "OPENCLAW_INSTALL_E2E_OPENAI_MODEL",
      "OPENCLAW_INSTALL_E2E_OPENAI_PROVIDER_TIMEOUT_SECONDS",
      'AGENT_TURN_TIMEOUT_SECONDS="$(read_positive_int_env OPENCLAW_INSTALL_E2E_AGENT_TURN_TIMEOUT_SECONDS 300)"',
    ]);

    expect(runner).not.toContain('run_agent_turn_bg "read proof"');

    expectTextToIncludeAll(wrapper, [
      "OPENCLAW_INSTALL_E2E_AGENT_TURNS_PARALLEL",
      "OPENCLAW_INSTALL_E2E_AGENT_TOOL_SMOKE",
      "OPENCLAW_INSTALL_E2E_OPENAI_MODEL",
      "OPENCLAW_INSTALL_E2E_OPENAI_PROVIDER_TIMEOUT_SECONDS",
      "docker_e2e_read_positive_int_env OPENCLAW_INSTALL_E2E_AGENT_TURN_TIMEOUT_SECONDS 300",
      'docker_e2e_read_positive_int_env OPENCLAW_INSTALL_E2E_OPENAI_PROVIDER_TIMEOUT_SECONDS "$AGENT_TURN_TIMEOUT_SECONDS"',
      '-e OPENCLAW_INSTALL_E2E_AGENT_TURN_TIMEOUT_SECONDS="$AGENT_TURN_TIMEOUT_SECONDS"',
      "OPENCLAW_INSTALL_E2E_PROFILE_FILE",
      "OPENCLAW_PROFILE_FILE",
      "OPENCLAW_TESTBOX_PROFILE_FILE",
      "read_profile_env_value",
      'source "$PROFILE_FILE"',
      'export "$key"',
      "Profile file: $PROFILE_STATUS",
    ]);

    expect(wrapper).not.toContain("set -a");
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
    expectTextToIncludeAll(runner, [
      "UPDATE_FAILED=0",
      "GATEWAY_START_FAILED=0",
      "GATEWAY_HEALTH_FAILED=0",
      'if [ "$UPDATE_FAILED" -ne 0 ]; then',
      'if [ "$GATEWAY_START_FAILED" -ne 0 ]; then',
      'if [ "$GATEWAY_HEALTH_FAILED" -ne 0 ]; then',
      'status.service?.runtime?.status !== "running"',
      "FAIL: gateway service was not running before update",
      "/healthz",
      "FAIL: gateway install failed before update",
    ]);

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

    const doctorRunner = readFileSync(DOCTOR_SWITCH_DOCKER_E2E_PATH, "utf8");
    expect(doctorRunner).toContain("scripts/e2e/lib/doctor-install-switch/scenario.sh");
    expectTextToIncludeAll(doctorRunner, [
      'TARGET_ROOT_DIR="$(cd "${OPENCLAW_DOCKER_E2E_REPO_ROOT:-$ROOT_DIR}" && pwd)"',
      'TARGET_CONTRACT_DIR="$TARGET_ROOT_DIR/scripts/e2e/lib/doctor-install-switch"',
      'source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"',
      '"$TARGET_CONTRACT_DIR:/app/scripts/e2e/lib/doctor-install-switch:ro"',
    ]);
    expectTextToIncludeAll(doctorScenario, [
      "OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR=1",
      "scripts/e2e/lib/package-compat.mjs",
    ]);

    expect(doctorLoginctlShim).toContain("Linger=yes");
    expect(doctorSystemctlShim).toContain("ActiveState=inactive");
    expect(doctorSystemctlShim).toContain('unit_path="$HOME/.config/systemd/user/${unit}"');

    expect(readFileSync(PLUGINS_DOCKER_E2E_PATH, "utf8")).toContain(
      "scripts/e2e/lib/plugins/sweep.sh",
    );
    expect(readFileSync(PLUGIN_UPDATE_DOCKER_E2E_PATH, "utf8")).toContain(
      "scripts/e2e/lib/plugin-update/unchanged-scenario.sh",
    );
    expect(packageCompat).toContain("day <= 25");

    expect(pluginsSweep).toContain("scripts/e2e/lib/package-compat.mjs");
    expect(pluginUpdateProbe).toContain("../package-compat.mjs");
    expect(scripts.join("\n")).toContain("OPENCLAW_PACKAGE_ACCEPTANCE_LEGACY_COMPAT");
    expect(scripts.join("\n")).toContain(
      "Package $package_version must support gateway install --wrapper.",
    );
    expect(updateChannel).toContain("assert-config-channel dev");
    expect(updateChannel).toContain("assert-config-channel beta");
    expect(updateChannelAssertions).toContain("expected persisted update.channel ${channel}");
    expect(pluginsAssertions).toContain("expected modern installRecords in installed plugin index");
  });

  it("keeps the doctor switch systemctl shim system scope empty", () => {
    const home = tempDirs.make("openclaw-doctor-systemctl-shim-");
    const env = { ...process.env, HOME: home };
    const loadState = spawnSync(
      DOCTOR_SWITCH_SYSTEMCTL_SHIM_PATH,
      ["show", "--property=LoadState", "--value", "openclaw-gateway.service"],
      { encoding: "utf8", env },
    );
    const unitPath = spawnSync(
      DOCTOR_SWITCH_SYSTEMCTL_SHIM_PATH,
      ["show", "--property=UnitPath", "--value"],
      { encoding: "utf8", env },
    );

    expect(loadState.status).toBe(0);
    expect(loadState.stdout.trim()).toBe("not-found");
    expect(unitPath.status).toBe(0);
    expect(unitPath.stdout).toContain("/etc/systemd/system");
  });

  it("reports the installed doctor switch unit through the systemd manager", async () => {
    const home = tempDirs.make("openclaw-doctor-busctl-shim-");
    const serviceName = "openclaw-gateway.service";
    const unitPath = join(home, ".config", "systemd", "user", serviceName);
    mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
    writeFileSync(
      unitPath,
      [
        "[Service]",
        'ExecStart=/usr/bin/node "/opt/openclaw git/dist/index.js" gateway --port 18789',
        'WorkingDirectory="/opt/openclaw git"',
        'Environment="GREETING=hello world" OPENCLAW_PROFILE=fixture',
        "EnvironmentFile=-%h/.openclaw/gateway.systemd.env",
        "UnsetEnvironment=STALE_FLAG",
      ].join("\n"),
    );

    const manager = "org.freedesktop.systemd1";
    const objectPath = "/org/freedesktop/systemd1/unit/openclaw_2dgateway_2eservice";
    const programArguments = [
      "/usr/bin/node",
      "/opt/openclaw git/dist/index.js",
      "gateway",
      "--port",
      "18789",
    ];
    const runBusctl = (args: string[]) => {
      const result = spawnSync(
        DOCTOR_SWITCH_BUSCTL_SHIM_PATH,
        ["--user", "--json=short", ...args],
        {
          encoding: "utf8",
          env: { ...process.env, HOME: home },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      return result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    };

    expect(
      runBusctl([
        "call",
        manager,
        "/org/freedesktop/systemd1",
        `${manager}.Manager`,
        "LoadUnit",
        "s",
        serviceName,
      ]),
    ).toEqual([{ type: "o", data: [objectPath] }]);
    expect(
      runBusctl([
        "get-property",
        manager,
        objectPath,
        `${manager}.Service`,
        "ExecStart",
        "WorkingDirectory",
        "Environment",
        "EnvironmentFiles",
        "UnsetEnvironment",
      ]),
    ).toEqual([
      {
        type: "a(sasbttttuii)",
        data: [[programArguments[0], programArguments, false, ...Array(7).fill(0)]],
      },
      { type: "s", data: "/opt/openclaw git" },
      { type: "as", data: ["GREETING=hello world", "OPENCLAW_PROFILE=fixture"] },
      { type: "a(sb)", data: [[join(home, ".openclaw", "gateway.systemd.env"), true]] },
      { type: "as", data: ["STALE_FLAG"] },
    ]);
    expect(
      runBusctl([
        "get-property",
        manager,
        objectPath,
        `${manager}.Unit`,
        "FragmentPath",
        "DropInPaths",
        "NeedDaemonReload",
        "LoadState",
      ]),
    ).toEqual([
      { type: "s", data: unitPath },
      { type: "as", data: [] },
      { type: "b", data: false },
      { type: "s", data: "loaded" },
    ]);

    const binDir = join(home, "bin");
    writeExecutables(binDir, {
      busctl: readFileSync(DOCTOR_SWITCH_BUSCTL_SHIM_PATH, "utf8"),
      "systemd-exec-start.mjs": readFileSync(DOCTOR_SWITCH_SYSTEMD_EXEC_START_PATH, "utf8"),
    });
    const { readSystemdServiceExecStart } =
      await import("../../src/daemon/systemd-service-files.js");
    expect(
      await readSystemdServiceExecStart(
        { HOME: home, PATH: `${binDir}:${process.env.PATH}`, OPENCLAW_SYSTEMD_UNIT: serviceName },
        { requireEffective: true },
      ),
    ).toMatchObject({
      programArguments,
      workingDirectory: "/opt/openclaw git",
      sourcePath: unitPath,
      definitionPaths: [unitPath],
      environment: { GREETING: "hello world", OPENCLAW_PROFILE: "fixture" },
    });

    const unexpected = spawnSync(
      DOCTOR_SWITCH_BUSCTL_SHIM_PATH,
      ["--user", "--json=short", "list"],
      {
        encoding: "utf8",
        env: { ...process.env, HOME: home },
      },
    );
    expect(unexpected.status).toBe(1);
    expect(unexpected.stderr).toContain("unexpected invocation");
  });

  it("distinguishes a missing named doctor switch unit from failed or unsupported inspection", async () => {
    const home = tempDirs.make("openclaw-doctor-busctl-absence-");
    const binDir = join(home, "bin");
    const serviceName = "openclaw-gateway-fixture.service";
    const unitPath = join(home, ".config/systemd/user", serviceName);
    writeExecutables(binDir, {
      // Bind fixture identity here: native manager children do not inherit OpenClaw selectors.
      busctl: readFileSync(DOCTOR_SWITCH_BUSCTL_SHIM_PATH, "utf8").replace(
        "process.env.OPENCLAW_SYSTEMD_UNIT",
        JSON.stringify(serviceName),
      ),
      "systemd-exec-start.mjs": readFileSync(DOCTOR_SWITCH_SYSTEMD_EXEC_START_PATH, "utf8"),
    });
    const env = {
      HOME: home,
      PATH: `${binDir}:${process.env.PATH}`,
      OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway-fixture",
    };
    const { readSystemdServiceExecStart } =
      await import("../../src/daemon/systemd-service-files.js");
    expect(await readSystemdServiceExecStart(env, { requireEffective: true })).toBeNull();
    const loadArgs = [
      "--user",
      "--json=short",
      "call",
      "org.freedesktop.systemd1",
      "/org/freedesktop/systemd1",
      "org.freedesktop.systemd1.Manager",
      "LoadUnit",
      "s",
      serviceName,
    ];
    const invoke = (args: string[]) =>
      spawnSync(join(binDir, "busctl"), args, { env, encoding: "utf8" });
    const missing = invoke(loadArgs);
    expect(missing.status).toBe(1);
    expect(missing.stderr.trim()).toBe(`Call failed: Unit ${serviceName} not found.`);
    for (const args of [
      [...loadArgs, "extra"],
      [...loadArgs.slice(0, -1), "../missing.service"],
      [...loadArgs.slice(0, -1), "unrelated.service"],
      ["--user", "--json=short", "list"],
    ]) {
      const unsupported = invoke(args);
      expect(unsupported.status).toBe(1);
      expect(unsupported.stderr).not.toContain("not found.");
    }
    mkdirSync(dirname(unitPath), { recursive: true });
    writeFileSync(
      unitPath,
      "[Service]\nExecStart=/usr/bin/node /opt/profile/openclaw.mjs gateway\nEnvironment=OLD=stale\nEnvironment=\nEnvironment=KEEP=current REMOVE=value\nUnsetEnvironment=KEEP\nUnsetEnvironment=\nUnsetEnvironment=REMOVE\nEnvironmentFile=/missing/required.env\nEnvironmentFile=\n",
    );
    const command = await readSystemdServiceExecStart(env, { requireEffective: true });
    expect(command?.sourcePath).toBe(unitPath);
    expect(command?.environment).toEqual({ KEEP: "current" });
    rmSync(unitPath);
    mkdirSync(unitPath);
    const unreadable = invoke(loadArgs);
    expect(unreadable.status).toBe(1);
    expect(unreadable.stderr).not.toContain("not found.");
    const staleObject = invoke([
      "--user",
      "--json=short",
      "get-property",
      "org.freedesktop.systemd1",
      "/org/freedesktop/systemd1/unit/openclaw_2dgateway_2dfixture_2eservice",
      "org.freedesktop.systemd1.Unit",
      "FragmentPath",
      "DropInPaths",
      "NeedDaemonReload",
      "LoadState",
    ]);
    expect(staleObject.status).toBe(1);
    expect(staleObject.stdout).not.toContain('"loaded"');
  });

  it("routes doctor install switch commands through the E2E timeout helper", () => {
    const runner = readFileSync(DOCTOR_SWITCH_DOCKER_E2E_PATH, "utf8");
    const scenario = readFileSync(DOCTOR_SWITCH_SCENARIO_PATH, "utf8");

    expectTextToIncludeAll(runner, [
      'NPM_INSTALL_TIMEOUT="${OPENCLAW_E2E_NPM_INSTALL_TIMEOUT:-600s}"',
      'COMMAND_TIMEOUT="${OPENCLAW_DOCKER_DOCTOR_SWITCH_COMMAND_TIMEOUT:-900s}"',
      '-e "OPENCLAW_E2E_NPM_INSTALL_TIMEOUT=$NPM_INSTALL_TIMEOUT"',
      '-e "OPENCLAW_DOCKER_DOCTOR_SWITCH_COMMAND_TIMEOUT=$COMMAND_TIMEOUT"',
    ]);

    expectTextToIncludeAll(scenario, [
      'command_timeout="${OPENCLAW_DOCKER_DOCTOR_SWITCH_COMMAND_TIMEOUT:-900s}"',
      "use_default_service_identity() {",
      "local account_home",
      'account_home="$(node -p \'require("node:os").userInfo().homedir\')"',
      'export HOME="$account_home"',
      'export USERPROFILE="$account_home"',
      "unset OPENCLAW_HOME OPENCLAW_STATE_DIR OPENCLAW_CONFIG_PATH",
      'openclaw_test_state_create "switch-${name}" empty\n  use_default_service_identity',
      'openclaw_e2e_maybe_timeout "$command_timeout" bash -c "$install_cmd"',
      'openclaw_e2e_maybe_timeout "$command_timeout" bash -c "$doctor_cmd"',
      'openclaw_e2e_maybe_timeout "$command_timeout" "$npm_bin" gateway install --wrapper "$wrapper" --force',
    ]);

    expect(
      scenario.match(/unset OPENCLAW_HOME OPENCLAW_STATE_DIR OPENCLAW_CONFIG_PATH/gu),
    ).toHaveLength(1);
    expect(scenario.match(/export USERPROFILE="\$account_home"/gu)).toHaveLength(1);
    expect(scenario.match(/^ {2}use_default_service_identity$/gmu)).toHaveLength(3);
    expect(scenario).not.toMatch(/^\s*if ! timeout "\$command_timeout"/mu);
  });

  it("uses the account home for upgrade survivor auto-auth state", () => {
    const publishedRunner = readFileSync(UPGRADE_SURVIVOR_RUN_SCRIPT, "utf8");
    const wrapper = readFileSync(UPGRADE_SURVIVOR_DOCKER_E2E_PATH, "utf8");
    const directRunner = extractUpgradeSurvivorPayload(wrapper);

    expectTextToIncludeAll(wrapper, [
      'OPENCLAW_TEST_STATE_FUNCTION_B64="$(docker_e2e_test_state_function_b64)"',
      '-e OPENCLAW_TEST_STATE_FUNCTION_B64="$OPENCLAW_TEST_STATE_FUNCTION_B64"',
    ]);
    expect(wrapper).not.toContain("OPENCLAW_TEST_STATE_SCRIPT_B64");
    expectTextToIncludeAll(publishedRunner, [
      'if [ "$UPDATE_RESTART_MODE" = "auto-auth" ]; then',
      'account_home="$(getent passwd "$(id -u)" | cut -d: -f6)"',
      'if [ -z "$account_home" ]; then',
      'export HOME="$account_home"',
      'export USERPROFILE="$account_home"',
      "unset OPENCLAW_HOME",
      'export OPENCLAW_STATE_DIR="$account_home/.openclaw"',
      'export OPENCLAW_CONFIG_PATH="$OPENCLAW_STATE_DIR/openclaw.json"',
    ]);

    expect(publishedRunner.indexOf("unset OPENCLAW_HOME")).toBeLessThan(
      publishedRunner.indexOf('export OPENCLAW_STATE_DIR="$account_home/.openclaw"'),
    );
    expect(
      publishedRunner.indexOf('export OPENCLAW_CONFIG_PATH="$OPENCLAW_STATE_DIR/openclaw.json"'),
    ).toBeLessThan(
      publishedRunner.indexOf("node scripts/e2e/lib/upgrade-survivor/assertions.mjs seed"),
    );

    expectTextToIncludeAll(directRunner, [
      'openclaw_e2e_eval_test_state_from_b64 "${OPENCLAW_TEST_STATE_FUNCTION_B64:?missing OPENCLAW_TEST_STATE_FUNCTION_B64}"',
      'if [ "$UPDATE_RESTART_MODE" = "auto-auth" ]; then',
      'account_home="$(getent passwd "$(id -u)" | cut -d: -f6)"',
      'openclaw_test_state_create "$account_home" upgrade-survivor',
      'export HOME="$account_home"',
      'export USERPROFILE="$account_home"',
      'export OPENCLAW_STATE_DIR="$account_home/.openclaw"',
      'export OPENCLAW_CONFIG_PATH="$OPENCLAW_STATE_DIR/openclaw.json"',
      "unset OPENCLAW_HOME",
      "else",
      "openclaw_test_state_create upgrade-survivor upgrade-survivor",
    ]);
    expect(directRunner.indexOf('openclaw_test_state_create "$account_home"')).toBeLessThan(
      directRunner.indexOf("unset OPENCLAW_HOME"),
    );
    expect(directRunner.indexOf("unset OPENCLAW_HOME")).toBeLessThan(
      directRunner.indexOf("prepare_update_restart_probe_current_install"),
    );
    expect(
      directRunner.indexOf('export OPENCLAW_CONFIG_PATH="$OPENCLAW_STATE_DIR/openclaw.json"'),
    ).toBeLessThan(
      directRunner.indexOf("node scripts/e2e/lib/upgrade-survivor/assertions.mjs seed"),
    );
  });

  it("bounds doctor install switch command log diagnostics", () => {
    const scenario = readFileSync(DOCTOR_SWITCH_SCENARIO_PATH, "utf8");
    expectTextToIncludeAll(scenario, [
      'openclaw_e2e_print_log "$npm_log"',
      'openclaw_e2e_print_log "$install_log"',
      'openclaw_e2e_print_log "$doctor_log"',
      'openclaw_e2e_print_log "$reinstall_log"',
      'openclaw_e2e_print_log "$env_repair_log"',
      'openclaw_e2e_print_log "$clear_log"',
    ]);

    expect(scenario).not.toContain('cat "$npm_log"');
    expect(scenario).not.toContain('cat "$install_log"');
    expect(scenario).not.toContain('cat "$doctor_log"');
    expect(scenario).not.toContain('cat "$reinstall_log"');
    expect(scenario).not.toContain('cat "$env_repair_log"');
    expect(scenario).not.toContain('cat "$clear_log"');
  });

  it("prepares pnpm workspace package fixtures without package dependencies", () => {
    const root = tempDirs.make("openclaw-update-channel-fixture-");
    mkdirSync(join(root, "patches"));
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist/build-info.json"), JSON.stringify({ version: "2026.5.6" }));
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

    expectTextToIncludeAll(runner, [
      "OPENCLAW_BUNDLED_PLUGIN_SWEEP_TOTAL",
      "OPENCLAW_BUNDLED_PLUGIN_SWEEP_INDEX",
      "OPENCLAW_BUNDLED_PLUGIN_SWEEP_COMMAND_TIMEOUT",
      "OPENCLAW_PLUGIN_LIFECYCLE_TRACE",
      "docker_e2e_read_tcp_port_env OPENCLAW_BUNDLED_PLUGIN_RUNTIME_PORT_BASE 19000",
      '-e "OPENCLAW_BUNDLED_PLUGIN_RUNTIME_PORT_BASE=$RUNTIME_PORT_BASE"',
      "scripts/e2e/lib/bundled-plugin-install-uninstall/sweep.sh",
      'tee "$RUN_LOG"',
    ]);

    for (const envName of forwardedRuntimeEnv) {
      expect(runner, `${envName} forwarded by Docker wrapper`).toContain(envName);
      expect(probe + runtimeSmoke, `${envName} consumed by probe/runtime smoke`).toContain(envName);
    }

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

    expect(runner).not.toContain('cat "$RUN_LOG"');
    expect(probe).toContain('"openclaw.plugin.json"');
    expect(runtimeSmoke).toContain(
      'readPositiveIntEnv("OPENCLAW_BUNDLED_PLUGIN_RUNTIME_READY_MS", 900000)',
    );
    expectTextToIncludeAll(sweep, [
      "read -r plugin_id plugin_dir requires_config",
      'node "$OPENCLAW_ENTRY" plugins install "$plugin_id"',
      'node "$OPENCLAW_ENTRY" plugins uninstall "$plugin_id" --force',
      "now_ms()",
      "lifecycle_trace_enabled()",
      "if lifecycle_trace_enabled; then",
      "install_ms=",
      "runtime_ms=",
      "uninstall_ms=",
      "assert-installed",
      "assert-uninstalled",
    ]);
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
    expectTextToIncludeAll(runner, [
      'SESSION_ID_PREFIX="e2e-tools-${profile}"',
      'TURN2B_SESSION_ID="${SESSION_ID_PREFIX}-read-copy"',
      'TURN3_SESSION_ID="${SESSION_ID_PREFIX}-exec-hostname"',
      'TURN4_SESSION_ID="${SESSION_ID_PREFIX}-image-write"',
    ]);
  });

  it("bounds installer E2E session transcript tool scans", () => {
    const runner = readFileSync(INSTALL_E2E_RUNNER_PATH, "utf8");
    const start = runner.indexOf("assert_session_used_tools() {");
    const end = runner.indexOf("\nsession_jsonl_path()", start);
    const helper = runner.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expectTextToIncludeAll(helper, [
      "OPENCLAW_INSTALL_E2E_SESSION_SCAN_BYTES",
      "OPENCLAW_INSTALL_E2E_SESSION_LINE_BYTES",
      "OPENCLAW_INSTALL_E2E_SESSION_SCAN_DEPTH",
      "OPENCLAW_INSTALL_E2E_SESSION_SCAN_NODES",
      "fs.createReadStream",
      "Buffer.concat",
      "skippedOversizedLines",
    ]);

    expect(helper).not.toContain('require("node:readline")');
    expect(helper).not.toContain("fs.readFileSync");
    expect(helper).not.toContain('.split("\\n")');
  });

  it("accepts the image compatibility alias in installer E2E transcripts", () => {
    const runner = readFileSync(INSTALL_E2E_RUNNER_PATH, "utf8");
    const start = runner.indexOf("assert_session_used_tools() {");
    const end = runner.indexOf("\nsession_jsonl_path()", start);
    const helper = runner.slice(start, end);

    expect(helper).toContain('spec.split("|").filter(Boolean)');
    expect(helper).toContain("group.some((tool) => seen.has(tool))");
    expect(runner).toContain(
      'assert_session_used_tools "$profile" "$TURN4_SESSION_ID" "image|view_image" write',
    );
  });

  it("exports SQLite-backed installer E2E sessions before scanning tools", () => {
    const runner = readFileSync(INSTALL_E2E_RUNNER_PATH, "utf8");
    const start = runner.indexOf("assert_session_used_tools() {");
    const end = runner.indexOf("\nsession_jsonl_path()", start);
    const helper = runner.slice(start, end);

    expectTextToIncludeAll(helper, [
      'jsonl="$(session_jsonl_path "$profile" "$session_id")"',
      'if [[ ! -f "$jsonl" ]]',
      'openclaw --profile "$profile" sessions export-trajectory',
      '--session-key "agent:main:explicit:${session_id}"',
      '--workspace "$export_workspace"',
      'jsonl="$export_workspace/.openclaw/trajectory-exports/scan/events.jsonl"',
      'rm -rf "$export_workspace"',
    ]);
  });

  it("keeps OpenAI web search smoke on one gateway agent connection", () => {
    const runner = readFileSync(OPENAI_WEB_SEARCH_MINIMAL_E2E_PATH, "utf8");
    const scenario = readFileSync(OPENAI_WEB_SEARCH_MINIMAL_SCENARIO_PATH, "utf8");
    const client = readFileSync(OPENAI_WEB_SEARCH_MINIMAL_CLIENT_PATH, "utf8");

    expectTextToIncludeAll(runner, [
      'PORT="$(docker_e2e_read_tcp_port_env OPENCLAW_OPENAI_WEB_SEARCH_MINIMAL_PORT 18789)"',
      'MOCK_PORT="443"',
      '-e "PORT=$PORT"',
      '-e "MOCK_PORT=$MOCK_PORT"',
      "scripts/e2e/lib/openai-web-search-minimal/scenario.sh",
    ]);

    expect(runner).not.toContain("OPENCLAW_OPENAI_WEB_SEARCH_MINIMAL_MOCK_PORT");

    expectTextToIncludeAll(scenario, [
      'export NODE_EXTRA_CA_CERTS="$TLS_CA_CERT"',
      'MOCK_TLS_CERT="$TLS_SERVER_CERT"',
      'MOCK_TLS_KEY="$TLS_SERVER_KEY"',
      'openclaw_e2e_wait_mock_openai "$MOCK_PORT" 80 400 "https://api.openai.com:$MOCK_PORT"',
      "scripts/e2e/lib/openai-web-search-minimal/client.mjs",
    ]);

    expectTextToIncludeAll(client, [
      "const callGateway = await loadCallGateway();",
      'method: "agent"',
      "expectFinal: true",
      'scopes: ["operator.write"]',
    ]);

    expect(client).not.toContain('"agent.wait"');
  });

  it("cleans OpenAI web search smoke processes through the E2E helpers", () => {
    const scenario = readFileSync(OPENAI_WEB_SEARCH_MINIMAL_SCENARIO_PATH, "utf8");
    expectTextToIncludeAll(scenario, [
      'openclaw_e2e_terminate_gateways "${gateway_pid:-}"',
      'openclaw_e2e_stop_process "${mock_pid:-}"',
      'gateway_pid="$(openclaw_e2e_start_gateway "$entry" "$PORT" "$GATEWAY_LOG")"',
      'openclaw_e2e_wait_mock_openai "$MOCK_PORT" 80 400 "https://api.openai.com:$MOCK_PORT"',
      'openclaw_e2e_wait_gateway_ready "$gateway_pid" "$GATEWAY_LOG" 360 "$PORT"',
    ]);

    expect(scenario).not.toContain("fetch('http://127.0.0.1:${MOCK_PORT}/health')");
    expect(scenario).not.toContain('kill "$gateway_pid"');
    expect(scenario).not.toContain('kill "$mock_pid"');
    expect(scenario).not.toContain('node "$entry" gateway --port "$PORT"');
  });

  it("runs agents delete shared workspace smoke through one managed gateway", () => {
    const runner = readFileSync(AGENTS_DELETE_SHARED_WORKSPACE_DOCKER_E2E_PATH, "utf8");
    expectTextToIncludeAll(runner, [
      'entry="$(openclaw_e2e_resolve_entrypoint)"',
      'node "$entry" agents add alpha --workspace "$SHARED_WORKSPACE" --non-interactive',
      'node "$entry" agents add ops --workspace "$SHARED_WORKSPACE" --non-interactive',
      'gateway_pid="$(openclaw_e2e_start_gateway "$entry" 18789 "$gateway_log")"',
      'openclaw_e2e_wait_gateway_ready "$gateway_pid" "$gateway_log" 300 18789',
      'node "$entry" agents delete ops --force --json > "$output_file"',
      'node "$entry" agents list --json > "$agents_file"',
      'node scripts/e2e/lib/fixture.mjs agents-delete-assert "$output_file" "$agents_file"',
      'openclaw_e2e_terminate_gateways "${gateway_pid:-}"',
      'openclaw_e2e_print_log "$gateway_log" >&2',
      "trap cleanup EXIT",
      "trap dump_logs_on_error ERR",
    ]);

    expect(runner.match(/openclaw_e2e_start_gateway/gu)).toHaveLength(1);
    expect(runner.match(/openclaw_e2e_wait_gateway_ready/gu)).toHaveLength(1);
    expect(runner).not.toContain("run_openclaw()");
    expect(runner).not.toContain("for _ in");
  });

  it("keeps OpenAI web search smoke logs isolated per run", () => {
    const scenario = readFileSync(OPENAI_WEB_SEARCH_MINIMAL_SCENARIO_PATH, "utf8");
    expectTextToIncludeAll(scenario, [
      'scenario_tmp="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-openai-web-search-minimal.XXXXXX")"',
      'MOCK_REQUEST_LOG="$scenario_tmp/requests.jsonl"',
      'GATEWAY_LOG="$scenario_tmp/gateway.log"',
      'MOCK_LOG="$scenario_tmp/mock.log"',
      'CLIENT_SUCCESS_LOG="$scenario_tmp/client-success.log"',
      'CLIENT_REJECT_LOG="$scenario_tmp/client-reject.log"',
      'openclaw_e2e_print_log "$file"',
      'rm -rf "$scenario_tmp"',
    ]);

    expect(scenario).not.toContain("sed -n '1,260p'");
    expect(scenario).not.toContain("/tmp/openclaw-openai-web-search-minimal-requests.jsonl");
    expect(scenario).not.toContain("/tmp/openclaw-openai-web-search-minimal-client-success.log");
    expect(scenario).not.toContain("/tmp/openclaw-openai-web-search-minimal-client-reject.log");
  });

  it("keeps ClawHub plugin Docker smoke hermetic by default", () => {
    const runner = readFileSync(PLUGINS_DOCKER_E2E_PATH, "utf8");
    const sweep = readFileSync(PLUGINS_DOCKER_SWEEP_PATH, "utf8");
    const clawhub = readFileSync(PLUGINS_DOCKER_CLAWHUB_PATH, "utf8");

    expectTextToIncludeAll(runner, [
      "scripts/e2e/lib/plugins/sweep.sh",
      "OPENCLAW_PLUGINS_E2E_LIVE_CLAWHUB",
      "OPENCLAW_PLUGINS_E2E_LIVE_NPM_REGISTRY",
    ]);

    expect(sweep).toContain("scripts/e2e/lib/plugins/clawhub.sh");
    expectTextToIncludeAll(clawhub, [
      "start_clawhub_fixture_server()",
      'OPENCLAW_CLAWHUB_URL="http://127.0.0.1:',
      "OPENCLAW_PLUGINS_E2E_LIVE_CLAWHUB",
      "OPENCLAW_PLUGINS_E2E_LIVE_NPM_REGISTRY",
      "live ClawHub can rate-limit CI",
      '[[ -n "${OPENCLAW_CLAWHUB_URL:-}" || -n "${CLAWHUB_URL:-}" ]]',
      "Ignoring ambient ClawHub URL for fixture-mode plugin E2E",
      "unset OPENCLAW_CLAWHUB_URL CLAWHUB_URL",
    ]);
  });

  it("keeps the plugin binding command escape Docker smoke focused", () => {
    const runner = readFileSync(PLUGIN_BINDING_COMMAND_ESCAPE_DOCKER_E2E_PATH, "utf8");
    const dockerfile = readFileSync(PLUGIN_BINDING_COMMAND_ESCAPE_DOCKERFILE_PATH, "utf8");

    expectTextToIncludeAll(runner, [
      "--reporter=verbose -t",
      'DOCKER_RUN_TIMEOUT="${OPENCLAW_PLUGIN_BINDING_COMMAND_ESCAPE_DOCKER_RUN_TIMEOUT:-900s}"',
      'DOCKER_COMMAND_TIMEOUT="$DOCKER_RUN_TIMEOUT" docker_e2e_docker_run_cmd run --rm',
      'docker_e2e_docker_cmd rm -f "$CONTAINER_NAME"',
      "lets authorized (plugin-owned binding commands fall through to command processing|gateway-style plugin commands escape plugin-owned bindings)",
      "keeps unauthorized plugin-owned binding slash replies suppressed while routed to the bound plugin",
      "expected focused Vitest summary for exactly 3 passed tests",
    ]);
    expect(runner).not.toContain("-- --reporter=verbose");

    expect(runner).not.toMatch(/(^|\n)docker run --rm/u);

    expect(runner).not.toContain(
      "keeps unauthorized plugin-owned binding slash text routed to the bound plugin",
    );

    expect(dockerfile).toContain("OPENCLAW_DISABLE_BUNDLED_PLUGIN_POSTINSTALL=1");
    expect(dockerfile).toContain("pnpm install --frozen-lockfile --ignore-scripts\n");
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

    expectTextToIncludeAll(sweep, [
      'OPENCLAW_PLUGINS_CLI_TIMEOUT="${OPENCLAW_PLUGINS_CLI_TIMEOUT:-180s}"',
      "run_plugins_openclaw_capture()",
      'openclaw_e2e_maybe_timeout "$OPENCLAW_PLUGINS_CLI_TIMEOUT" node "$OPENCLAW_ENTRY" "$@" >"$output_file"',
      "plugins_lifecycle_trace_enabled()",
      "print_plugins_stderr_log()",
      "Plugin sweep command timed out after %s: %s",
      "Plugin sweep command failed with status %s: %s",
      "Plugin sweep capture timed out after %s: %s",
      "Plugin sweep capture failed with status %s: %s",
      'plugins install "$dir_plugin" --force',
      "plugins update demo-plugin-dir",
      "start_npm_fixture_registry",
      'plugins install "npm:@openclaw/demo-plugin-npm@0.0.1" --force',
      "plugins update demo-plugin-npm",
      'plugins install "git:$git_update_repo_url@main" --force',
      "plugins update demo-plugin-git-update",
    ]);
    expect(runner).toContain('PLUGINS_CLI_TIMEOUT="${OPENCLAW_PLUGINS_CLI_TIMEOUT:-180s}"');
    expect(runner).toContain('-e "OPENCLAW_PLUGINS_CLI_TIMEOUT=$PLUGINS_CLI_TIMEOUT"');
    expect(runner).toContain("OPENCLAW_PLUGIN_LIFECYCLE_TRACE");
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

    expectTextToIncludeAll(assertions, [
      'Skipping "demo-plugin-dir" (source: path).',
      "demo-plugin-npm is up to date (0.0.1).",
      "demo.git.update.v2",
      "clawhub-updated",
      "record.clawpackSha256",
      "record.artifactKind",
      "record.npmIntegrity",
    ]);

    expectTextToIncludeAll(npmRegistry, [
      "OPENCLAW_NPM_REGISTRY_DIST_TAGS",
      "Object.fromEntries(distTagOverrides)",
      "existing.latestVersion = version",
      "packageArgs.length % 3",
    ]);

    expectTextToIncludeAll(clawhub, [
      'plugins install "$CLAWHUB_PLUGIN_SPEC"',
      'plugins update "$CLAWHUB_PLUGIN_ID"',
      'openclaw_e2e_maybe_timeout "$OPENCLAW_PLUGINS_CLI_TIMEOUT"',
      "clawhub:@openclaw/kitchen-sink",
    ]);
  });
});
