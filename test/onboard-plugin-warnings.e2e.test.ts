// Built-CLI onboarding regression for candidate-scoped plugin validation.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function runBuiltCli(stateDir: string, homeDir: string, args: string[]) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    OPENAI_API_KEY: "sk-fake-openclaw-onboard-regression",
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_STATE_DIR: stateDir,
    NO_COLOR: "1",
  };
  for (const key of [
    "DISCORD_BOT_TOKEN",
    "NODE_ENV",
    "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
    "OPENCLAW_HOME",
    "OPENCLAW_PROFILE",
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_FROM_NUMBER",
    "VITEST",
    "VITEST_POOL_ID",
    "VITEST_WORKER_ID",
  ]) {
    delete env[key];
  }
  return spawnSync(process.execPath, [path.resolve("openclaw.mjs"), ...args], {
    cwd: path.resolve("."),
    encoding: "utf8",
    env,
    maxBuffer: 4 * 1024 * 1024,
    timeout: 60_000,
  });
}

describe("non-interactive onboarding plugin validation", () => {
  it("does not warn about bundled plugins enabled by the documented OpenAI setup", () => {
    const rootDir = tempDirs.make("openclaw-onboard-plugin-warnings-", "/tmp");
    const homeDir = path.join(rootDir, "home");
    const stateDir = path.join(rootDir, "state");
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });

    const onboard = runBuiltCli(stateDir, homeDir, [
      "onboard",
      "--non-interactive",
      "--accept-risk",
      "--skip-health",
      "--mode",
      "local",
      "--auth-choice",
      "openai-api-key",
      "--secret-input-mode",
      "ref",
      "--gateway-port",
      "19091",
      "--skip-bootstrap",
      "--skip-skills",
    ]);

    expect(onboard.error, onboard.stderr).toBeUndefined();
    expect(onboard.status, onboard.stderr).toBe(0);
    expect(onboard.stderr).not.toContain("plugin not found: openai");
    expect(onboard.stderr).not.toContain("plugin not installed: codex");

    const config = JSON.parse(fs.readFileSync(path.join(stateDir, "openclaw.json"), "utf8")) as {
      plugins?: { entries?: Record<string, { enabled?: boolean }> };
    };
    expect(config.plugins?.entries?.openai?.enabled).toBe(true);
    expect(config.plugins?.entries?.codex?.enabled).toBe(true);

    const list = runBuiltCli(stateDir, homeDir, ["plugins", "list", "--json"]);
    expect(list.error, list.stderr).toBeUndefined();
    expect(list.status, list.stderr).toBe(0);
    expect(list.stderr).toBe("");
    const inventory = JSON.parse(list.stdout) as {
      plugins: Array<{ id: string; enabled: boolean; status: string }>;
    };
    expect(inventory.plugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "openai", enabled: true, status: "loaded" }),
        expect.objectContaining({ id: "codex", enabled: true, status: "loaded" }),
      ]),
    );
  }, 75_000);
});
