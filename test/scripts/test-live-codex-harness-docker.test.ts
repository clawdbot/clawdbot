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
});
