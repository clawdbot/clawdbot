// Test Live Codex Harness Docker tests cover test live codex harness docker script behavior.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT_PATH = path.resolve(
  import.meta.dirname,
  "../../scripts/test-live-codex-harness-docker.sh",
);

describe("scripts/test-live-codex-harness-docker.sh", () => {
  it("retains the Codex auth, isolation, forwarding, and diagnostic contracts", () => {
    const script = fs.readFileSync(SCRIPT_PATH, "utf8");
    const authHelper = fs.readFileSync(
      path.resolve(import.meta.dirname, "../../scripts/lib/live-docker-auth.sh"),
      "utf8",
    );

    for (const required of [
      'DOCKER_CACHE_CONTAINER_DIR="/tmp/openclaw-cache"',
      'DOCKER_CLI_TOOLS_CONTAINER_DIR="/tmp/openclaw-npm-global"',
      "openclaw_live_init_cli_tools_dir",
      "openclaw_live_init_cache_home_dir",
      '-e XDG_CACHE_HOME="$DOCKER_CACHE_CONTAINER_DIR"',
      '-e NPM_CONFIG_PREFIX="$DOCKER_CLI_TOOLS_CONTAINER_DIR"',
      "if openclaw_live_uses_managed_bind_dirs; then",
      '-v "$CACHE_HOME_DIR":"$DOCKER_CACHE_CONTAINER_DIR"',
      '-v "$CLI_TOOLS_DIR":"$DOCKER_CLI_TOOLS_CONTAINER_DIR"',
      "OPENCLAW_LIVE_CODEX_HARNESS_AUTH=codex-auth requires ~/.codex/auth.json before building the live Docker image",
      "If this is a Testbox/API-key run, set OPENCLAW_LIVE_CODEX_HARNESS_AUTH=api-key and run through openclaw-testbox-env.",
      "printf 'OPENAI_API_KEY=%s\\n' \"${OPENAI_API_KEY}\"",
      "printf 'CODEX_API_KEY=%s\\n' \"${CODEX_API_KEY:-$OPENAI_API_KEY}\"",
      "openclaw_live_init_managed_home",
      'if [[ "$CODEX_HARNESS_AUTH_MODE" == "api-key" ]]; then',
      'if [[ -z "${DOCKER_HOME_DIR:-}" ]]; then',
      'DOCKER_HOME_DIR="$(mktemp -d "${RUNNER_TEMP:-/tmp}/openclaw-docker-home.XXXXXX")"',
      'CONFIG_DIR="$(mktemp -d "${RUNNER_TEMP:-/tmp}/openclaw-docker-config.XXXXXX")"',
      'WORKSPACE_DIR="$(mktemp -d "${RUNNER_TEMP:-/tmp}/openclaw-docker-workspace.XXXXXX")"',
      'DOCKER_CACHE_CONTAINER_DIR="/home/node/.cache"',
      'DOCKER_CLI_TOOLS_CONTAINER_DIR="/home/node/.npm-global"',
      'PROFILE_STATUS="api-key-env"',
      'chmod 0777 "$DOCKER_HOME_DIR" "$CONFIG_DIR" "$WORKSPACE_DIR" || true',
      'if [[ "$CODEX_HARNESS_AUTH_MODE" != "api-key" ]]; then',
      "cleanup_codex_live_mounts() {",
      'chmod -R a+rwX "$HOME" "$NPM_CONFIG_PREFIX" "$XDG_CACHE_HOME" 2>/dev/null || true',
      "trap cleanup_codex_live_mounts EXIT",
      '"$ROOT_DIR/extensions/codex/package.json"',
      "process.stdout.write(`@openai/codex@${version}`);",
      '-e OPENCLAW_LIVE_CODEX_CLI_PACKAGE_SPEC="$CODEX_CLI_PACKAGE_SPEC"',
      'run_setup_command npm install -g "$OPENCLAW_LIVE_CODEX_CLI_PACKAGE_SPEC"',
      "Failed to extract accountId from token",
      "ERROR: Codex auth cannot extract accountId from the available token; refresh OPENCLAW_CODEX_AUTH_JSON or use OPENCLAW_LIVE_CODEX_HARNESS_AUTH=api-key.",
      'tail -c 262144 "$codex_preflight_log"',
    ]) {
      expect(script).toContain(required);
    }

    for (const dockerArg of [
      '-e OPENCLAW_LIVE_CODEX_BIND_PROVIDER="${OPENCLAW_LIVE_CODEX_BIND_PROVIDER:-}"',
      '-e OPENCLAW_LIVE_CODEX_BIND_REQUEST_TIMEOUT_MS="${OPENCLAW_LIVE_CODEX_BIND_REQUEST_TIMEOUT_MS:-}"',
      '-e OPENCLAW_LIVE_CODEX_BIND_TIMEOUT_MS="${OPENCLAW_LIVE_CODEX_BIND_TIMEOUT_MS:-}"',
      '-e OPENCLAW_LIVE_CODEX_HARNESS_MULTI_SESSION_PROBE="${OPENCLAW_LIVE_CODEX_HARNESS_MULTI_SESSION_PROBE:-0}"',
      '-e OPENCLAW_LIVE_CODEX_HARNESS_RESUME_STRESS="${OPENCLAW_LIVE_CODEX_HARNESS_RESUME_STRESS:-0}"',
      '-e OPENCLAW_LIVE_CODEX_HARNESS_EXPECTED_EFFORT="${OPENCLAW_LIVE_CODEX_HARNESS_EXPECTED_EFFORT:-}"',
      '-e OPENCLAW_LIVE_CODEX_HARNESS_RESUME_STRESS_HISTORY_TURNS="${OPENCLAW_LIVE_CODEX_HARNESS_RESUME_STRESS_HISTORY_TURNS:-4}"',
      '-e OPENCLAW_LIVE_CODEX_HARNESS_RESUME_STRESS_RESTARTS="${OPENCLAW_LIVE_CODEX_HARNESS_RESUME_STRESS_RESTARTS:-3}"',
      '-e OPENCLAW_LIVE_CODEX_HARNESS_SUBAGENT_COUNT="${OPENCLAW_LIVE_CODEX_HARNESS_SUBAGENT_COUNT:-1}"',
      '-e OPENCLAW_LIVE_CODEX_HARNESS_COMPACTION_STRESS="${OPENCLAW_LIVE_CODEX_HARNESS_COMPACTION_STRESS:-0}"',
      '-e OPENCLAW_LIVE_CODEX_HARNESS_COMPACTION_STRESS_TURNS="${OPENCLAW_LIVE_CODEX_HARNESS_COMPACTION_STRESS_TURNS:-4}"',
      '-e OPENCLAW_LIVE_CODEX_HARNESS_LARGE_OUTPUT_BYTES="${OPENCLAW_LIVE_CODEX_HARNESS_LARGE_OUTPUT_BYTES:-300000}"',
      '-e OPENCLAW_LIVE_CODEX_HARNESS_CODE_MODE_ONLY="${OPENCLAW_LIVE_CODEX_HARNESS_CODE_MODE_ONLY:-0}"',
      '-e OPENCLAW_LIVE_CODEX_HARNESS_DISABLE_LOOP_RELAY="${OPENCLAW_LIVE_CODEX_HARNESS_DISABLE_LOOP_RELAY:-0}"',
    ]) {
      expect(script).toContain(dockerArg);
    }

    expect(authHelper).toContain("openclaw_live_is_ci");
    expect(authHelper).toContain('DOCKER_USER="$(id -u):$(id -g)"');
    expect(authHelper).toContain(
      'openclaw_live_prepare_bind_dir_for_container_user "$CLI_TOOLS_DIR"',
    );
    expect(authHelper).toContain(
      'openclaw_live_prepare_bind_dir_for_container_user "$CACHE_HOME_DIR"',
    );
    for (const forbidden of [
      '-v "$CACHE_HOME_DIR":/home/node/.cache',
      '-v "$CLI_TOOLS_DIR":/home/node/.npm-global',
      'DOCKER_USER="0:0"',
      "run_setup_command npm install -g @openai/codex",
      "SKIP: Codex auth cannot extract accountId",
      'cat "$codex_preflight_log"',
    ]) {
      expect(script).not.toContain(forbidden);
    }
    for (const [before, after] of [
      ["requires ~/.codex/auth.json before building", 'OPENCLAW_LIVE_DOCKER_REPO_ROOT="$ROOT_DIR"'],
      ["OPENAI_API_KEY=%s", "CODEX_API_KEY=%s"],
      ['PROFILE_STATUS="api-key-env"', "openclaw_live_append_array DOCKER_RUN_ARGS PROFILE_MOUNT"],
      ["cleanup_codex_live_mounts()", 'mkdir -p "$NPM_CONFIG_PREFIX" "$XDG_CACHE_HOME"'],
    ] as const) {
      expect(script.indexOf(before)).toBeLessThan(script.indexOf(after));
    }
    expect(script).not.toMatch(/Failed to extract accountId from token[\s\S]{0,180}exit 0/u);
  });

  it("keeps the staged Gateway and Codex plugin on the same source module graph", () => {
    const script = fs.readFileSync(SCRIPT_PATH, "utf8");
    const selection = script
      .split('openclaw_live_link_runtime_tree "$tmp_dir"\n')[1]
      ?.split('openclaw_live_stage_state_dir "$tmp_dir/.openclaw-state"')[0];
    expect(selection).toBeDefined();

    const root = fs.mkdtempSync(
      path.join(process.env.TMPDIR ?? "/tmp", "openclaw-codex-plugin-roots-"),
    );
    try {
      const stagedRoot = path.join(root, "staged");
      const stagedPlugin = path.join(stagedRoot, "extensions", "codex");
      fs.mkdirSync(stagedPlugin, { recursive: true });
      fs.writeFileSync(path.join(stagedPlugin, "openclaw.plugin.json"), "{}");
      fs.mkdirSync(path.join(root, "dist-runtime", "extensions", "codex"), {
        recursive: true,
      });
      const executableSelection = selection!
        .replaceAll("/app/dist-runtime", path.join(root, "dist-runtime"))
        .replaceAll("/app/dist", path.join(root, "dist"));
      const result = spawnSync(
        "bash",
        ["-c", `${executableSelection}\nprintf '%s' "$OPENCLAW_BUNDLED_PLUGINS_DIR"`],
        {
          encoding: "utf8",
          env: { ...process.env, tmp_dir: stagedRoot },
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toBe(path.join(stagedRoot, "extensions"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects invalid setup timeout values before auth or Docker setup", () => {
    const result = spawnSync("bash", [SCRIPT_PATH], {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_LIVE_CODEX_HARNESS_SETUP_TIMEOUT_SECONDS: "180s",
      },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "invalid OPENCLAW_LIVE_CODEX_HARNESS_SETUP_TIMEOUT_SECONDS: 180s",
    );
    expect(result.stderr).not.toContain("requires ~/.codex/auth.json");
    expect(result.stderr).not.toContain("docker");
  });
});
