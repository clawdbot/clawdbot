import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type RestoreEntry = { key: string; value: string | undefined };

function restoreEnv(entries: RestoreEntry[]): void {
  for (const { key, value } of entries) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function loadProfileEnv(): void {
  const profilePath = path.join(os.homedir(), ".profile");
  if (!fs.existsSync(profilePath)) return;
  try {
    const output = execFileSync(
      "/bin/bash",
      ["-lc", `set -a; source "${profilePath}" >/dev/null 2>&1; env -0`],
      { encoding: "utf8" },
    );
    const entries = output.split("\0");
    let applied = 0;
    for (const entry of entries) {
      if (!entry) continue;
      const idx = entry.indexOf("=");
      if (idx <= 0) continue;
      const key = entry.slice(0, idx);
      if (!key || (process.env[key] ?? "") !== "") continue;
      process.env[key] = entry.slice(idx + 1);
      applied += 1;
    }
    if (applied > 0) {
      console.log(`[live] loaded ${applied} env vars from ~/.profile`);
    }
  } catch {
    // ignore profile load failures
  }
}

export function installTestEnv(): { cleanup: () => void; tempHome: string } {
  const live =
    process.env.LIVE === "1" ||
    process.env.CLAWDBOT_LIVE_TEST === "1" ||
    process.env.CLAWDBOT_LIVE_GATEWAY === "1";

  // Live tests must use the real user environment (keys, profiles, config).
  // The default test env isolates HOME to avoid touching real state.
  if (live) {
    loadProfileEnv();
    return { cleanup: () => {}, tempHome: process.env.HOME ?? "" };
  }

  const restore: RestoreEntry[] = [
    { key: "CLAWDBOT_TEST_FAST", value: process.env.CLAWDBOT_TEST_FAST },
    { key: "HOME", value: process.env.HOME },
    { key: "USERPROFILE", value: process.env.USERPROFILE },
    { key: "XDG_CONFIG_HOME", value: process.env.XDG_CONFIG_HOME },
    { key: "XDG_DATA_HOME", value: process.env.XDG_DATA_HOME },
    { key: "XDG_STATE_HOME", value: process.env.XDG_STATE_HOME },
    { key: "XDG_CACHE_HOME", value: process.env.XDG_CACHE_HOME },
    { key: "CLAWDBOT_STATE_DIR", value: process.env.CLAWDBOT_STATE_DIR },
    { key: "CLAWDBOT_CONFIG_PATH", value: process.env.CLAWDBOT_CONFIG_PATH },
    { key: "CLAWDBOT_GATEWAY_PORT", value: process.env.CLAWDBOT_GATEWAY_PORT },
    { key: "CLAWDBOT_BRIDGE_ENABLED", value: process.env.CLAWDBOT_BRIDGE_ENABLED },
    { key: "CLAWDBOT_BRIDGE_HOST", value: process.env.CLAWDBOT_BRIDGE_HOST },
    { key: "CLAWDBOT_BRIDGE_PORT", value: process.env.CLAWDBOT_BRIDGE_PORT },
    { key: "CLAWDBOT_CANVAS_HOST_PORT", value: process.env.CLAWDBOT_CANVAS_HOST_PORT },
    { key: "CLAWDBOT_TEST_HOME", value: process.env.CLAWDBOT_TEST_HOME },
    { key: "TELEGRAM_BOT_TOKEN", value: process.env.TELEGRAM_BOT_TOKEN },
    { key: "DISCORD_BOT_TOKEN", value: process.env.DISCORD_BOT_TOKEN },
    { key: "SLACK_BOT_TOKEN", value: process.env.SLACK_BOT_TOKEN },
    { key: "SLACK_APP_TOKEN", value: process.env.SLACK_APP_TOKEN },
    { key: "SLACK_USER_TOKEN", value: process.env.SLACK_USER_TOKEN },
    { key: "COPILOT_GITHUB_TOKEN", value: process.env.COPILOT_GITHUB_TOKEN },
    { key: "GH_TOKEN", value: process.env.GH_TOKEN },
    { key: "GITHUB_TOKEN", value: process.env.GITHUB_TOKEN },
    { key: "NODE_OPTIONS", value: process.env.NODE_OPTIONS },
  ];

  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "moltbot-test-home-"));

  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  process.env.CLAWDBOT_TEST_HOME = tempHome;
  process.env.CLAWDBOT_TEST_FAST = "1";

  // Ensure test runs never touch the developer's real config/state, even if they have overrides set.
  delete process.env.CLAWDBOT_CONFIG_PATH;
  // Prefer deriving state dir from HOME so nested tests that change HOME also isolate correctly.
  delete process.env.CLAWDBOT_STATE_DIR;
  // Prefer test-controlled ports over developer overrides (avoid port collisions across tests/workers).
  delete process.env.CLAWDBOT_GATEWAY_PORT;
  delete process.env.CLAWDBOT_BRIDGE_ENABLED;
  delete process.env.CLAWDBOT_BRIDGE_HOST;
  delete process.env.CLAWDBOT_BRIDGE_PORT;
  delete process.env.CLAWDBOT_CANVAS_HOST_PORT;
  // Avoid leaking real GitHub/Copilot tokens into non-live test runs.
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.DISCORD_BOT_TOKEN;
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_APP_TOKEN;
  delete process.env.SLACK_USER_TOKEN;
  delete process.env.COPILOT_GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  // Avoid leaking local dev tooling flags into tests (e.g. --inspect).
  delete process.env.NODE_OPTIONS;

  // Windows: prefer the legacy default state dir so auth/profile tests match real paths.
  if (process.platform === "win32") {
    process.env.CLAWDBOT_STATE_DIR = path.join(tempHome, ".clawdbot");
  }

  process.env.XDG_CONFIG_HOME = path.join(tempHome, ".config");
  process.env.XDG_DATA_HOME = path.join(tempHome, ".local", "share");
  process.env.XDG_STATE_HOME = path.join(tempHome, ".local", "state");
  process.env.XDG_CACHE_HOME = path.join(tempHome, ".cache");

  const cleanup = () => {
    restoreEnv(restore);
    try {
      fs.rmSync(tempHome, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  };

  return { cleanup, tempHome };
}

export function withIsolatedTestHome(): { cleanup: () => void; tempHome: string } {
  return installTestEnv();
}
