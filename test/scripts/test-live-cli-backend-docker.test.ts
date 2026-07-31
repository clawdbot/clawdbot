// Test Live Cli Backend Docker tests cover test live cli backend docker script behavior.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT_PATH = path.resolve(
  import.meta.dirname,
  "../../scripts/test-live-cli-backend-docker.sh",
);

function readForwardedDockerEnvVars(): string[] {
  const script = fs.readFileSync(SCRIPT_PATH, "utf8");
  return Array.from(script.matchAll(/-e\s+([A-Z0-9_]+)=/g), (match) => match[1] ?? "");
}

describe("scripts/test-live-cli-backend-docker.sh", () => {
  it("runs the staged live test without invoking pnpm inside Docker", () => {
    const script = fs.readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain(
      "node scripts/test-live.mjs -- src/gateway/gateway-cli-backend.live.test.ts",
    );
    expect(script).not.toContain("pnpm test:live src/gateway/gateway-cli-backend.live.test.ts");
  });

  it("forwards both fresh and resume CLI arg overrides into the Docker container", () => {
    const forwardedVars = readForwardedDockerEnvVars();

    expect(forwardedVars).toContain("OPENCLAW_LIVE_CLI_BACKEND_ARGS");
    expect(forwardedVars).toContain("OPENCLAW_LIVE_CLI_BACKEND_RESUME_ARGS");
    expect(forwardedVars).toContain("OPENCLAW_TEST_CONSOLE");
  });

  it("forwards advisory provider-skip controls into the Docker container", () => {
    const forwardedVars = readForwardedDockerEnvVars();

    expect(forwardedVars).toContain("OPENCLAW_LIVE_CLI_BACKEND_ADVISORY");
    expect(forwardedVars).toContain("OPENCLAW_LIVE_CLI_BACKEND_ALLOW_PROVIDER_SKIP");
  });

  it("rejects invalid setup timeout values before metadata or Docker setup", () => {
    const result = spawnSync("bash", [SCRIPT_PATH], {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_LIVE_CLI_BACKEND_SETUP_TIMEOUT_SECONDS: "180s",
      },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "invalid OPENCLAW_LIVE_CLI_BACKEND_SETUP_TIMEOUT_SECONDS: 180s",
    );
    expect(result.stderr).not.toContain("Cannot find package 'tsx'");
    expect(result.stderr).not.toContain("docker");
  });

  it("prints redacted Claude subscription probe failures", () => {
    const script = fs.readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain('direct_probe_log="$(mktemp)"');
    expect(script).toContain("This is a local CLI smoke test.");
    expect(script).toContain("What is two plus two?");
    expect(script).toContain("(4|four)");
    expect(script).not.toContain("direct_token=");
    expect(script).not.toContain("expected token");
    expect(script).not.toContain("OPENCLAW-CLAUDE-SUBSCRIPTION-DIRECT");
    expect(script).toContain("direct Claude subscription probe exited with status");
    expect(script).toContain("<redacted-email>");
    expect(script).toContain("<redacted-secret>");
  });

  it("prefers explicit Claude setup tokens over staged credentials", () => {
    const script = fs.readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toMatch(
      /if \[\[ -n "\$\{CLAUDE_CODE_OAUTH_TOKEN:-\}" \]\]; then[\s\S]*?CLAUDE_SUBSCRIPTION_AUTH_SOURCE="env-token"[\s\S]*?elif \[\[ -f "\$CLAUDE_CREDS_FILE" \]\]; then/,
    );
    expect(script).toContain(".claude.json | .claude/.credentials.json) ;;");
  });
});
