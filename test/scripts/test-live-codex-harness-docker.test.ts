import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT_PATH = path.resolve(
  import.meta.dirname,
  "../../scripts/test-live-codex-harness-docker.sh",
);

describe("scripts/test-live-codex-harness-docker.sh", () => {
  it("mounts cache and npm tool dirs outside the bind-mounted Docker home", () => {
    const script = fs.readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain('DOCKER_CACHE_CONTAINER_DIR="/tmp/openclaw-cache"');
    expect(script).toContain('DOCKER_CLI_TOOLS_CONTAINER_DIR="/tmp/openclaw-npm-global"');
    expect(script).toContain("openclaw_live_codex_harness_is_ci()");
    expect(script).toContain('[[ -n "${CI:-}" && "${CI:-}" != "false" ]]');
    expect(script).toContain('-e XDG_CACHE_HOME="$DOCKER_CACHE_CONTAINER_DIR"');
    expect(script).toContain('-e NPM_CONFIG_PREFIX="$DOCKER_CLI_TOOLS_CONTAINER_DIR"');
    expect(script).toContain('chmod 0777 "$CLI_TOOLS_DIR" "$CACHE_HOME_DIR" || true');
    expect(script).toContain('-v "$CACHE_HOME_DIR":"$DOCKER_CACHE_CONTAINER_DIR"');
    expect(script).toContain('-v "$CLI_TOOLS_DIR":"$DOCKER_CLI_TOOLS_CONTAINER_DIR"');
    expect(script).not.toContain('-v "$CACHE_HOME_DIR":/home/node/.cache');
    expect(script).not.toContain('-v "$CLI_TOOLS_DIR":/home/node/.npm-global');
  });

  it("fails before Docker build when codex-auth has no host auth file", () => {
    const script = fs.readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain(
      "OPENCLAW_LIVE_CODEX_HARNESS_AUTH=codex-auth requires ~/.codex/auth.json before building the live Docker image",
    );
    expect(script).toContain(
      "If this is a Testbox/API-key run, set OPENCLAW_LIVE_CODEX_HARNESS_AUTH=api-key and run through openclaw-testbox-env.",
    );
    expect(script.indexOf("requires ~/.codex/auth.json before building")).toBeLessThan(
      script.indexOf('OPENCLAW_LIVE_DOCKER_REPO_ROOT="$ROOT_DIR"'),
    );
  });

  it("forwards API-key auth through both OpenAI and Codex env names", () => {
    const script = fs.readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain('printf \'OPENAI_API_KEY=%s\\n\' "${OPENAI_API_KEY}"');
    expect(script).toContain('printf \'CODEX_API_KEY=%s\\n\' "${CODEX_API_KEY:-$OPENAI_API_KEY}"');
    expect(script.indexOf("OPENAI_API_KEY=%s")).toBeLessThan(
      script.indexOf("CODEX_API_KEY=%s"),
    );
  });

  it("keeps API-key runs on the ephemeral Docker home", () => {
    const script = fs.readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain('DOCKER_USER="$(id -u):$(id -g)"');
    expect(script).toContain(
      'if [[ "$CODEX_HARNESS_AUTH_MODE" == "api-key" ]]; then',
    );
    expect(script).toContain(
      'if [[ -z "${DOCKER_HOME_DIR:-}" ]]; then',
    );
    expect(script).not.toContain('DOCKER_USER="0:0"');
    expect(script).toContain(
      'DOCKER_HOME_DIR="$(mktemp -d "${RUNNER_TEMP:-/tmp}/openclaw-docker-home.XXXXXX")"',
    );
    expect(script).toContain(
      'CONFIG_DIR="$(mktemp -d "${RUNNER_TEMP:-/tmp}/openclaw-docker-config.XXXXXX")"',
    );
    expect(script).toContain(
      'WORKSPACE_DIR="$(mktemp -d "${RUNNER_TEMP:-/tmp}/openclaw-docker-workspace.XXXXXX")"',
    );
    expect(script).toContain('DOCKER_CACHE_CONTAINER_DIR="/home/node/.cache"');
    expect(script).toContain('DOCKER_CLI_TOOLS_CONTAINER_DIR="/home/node/.npm-global"');
    expect(script).toContain('PROFILE_STATUS="api-key-env"');
    expect(script).toContain(
      'chmod 0777 "$DOCKER_HOME_DIR" "$CONFIG_DIR" "$WORKSPACE_DIR" || true',
    );
    expect(script).toContain(
      'if [[ "$CODEX_HARNESS_AUTH_MODE" != "api-key" ]]; then',
    );
    expect(script.indexOf('PROFILE_STATUS="api-key-env"')).toBeLessThan(
      script.indexOf("openclaw_live_append_array DOCKER_RUN_ARGS PROFILE_MOUNT"),
    );
    expect(script).toContain("cleanup_codex_live_mounts() {");
    expect(script).toContain(
      'chmod -R a+rwX "$HOME" "$NPM_CONFIG_PREFIX" "$XDG_CACHE_HOME" 2>/dev/null || true',
    );
    expect(script).toContain("trap cleanup_codex_live_mounts EXIT");
    expect(script.indexOf("cleanup_codex_live_mounts()")).toBeLessThan(
      script.indexOf('mkdir -p "$NPM_CONFIG_PREFIX" "$XDG_CACHE_HOME"'),
    );
  });

  it("forwards the live Codex bind provider override into Docker", () => {
    const script = fs.readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain(
      '-e OPENCLAW_LIVE_CODEX_BIND_PROVIDER="${OPENCLAW_LIVE_CODEX_BIND_PROVIDER:-}"',
    );
  });
});
