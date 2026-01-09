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

export function installTestEnv(): { cleanup: () => void; tempHome: string } {
  const restore: RestoreEntry[] = [
    { key: "HOME", value: process.env.HOME },
    { key: "USERPROFILE", value: process.env.USERPROFILE },
    { key: "XDG_CONFIG_HOME", value: process.env.XDG_CONFIG_HOME },
    { key: "XDG_DATA_HOME", value: process.env.XDG_DATA_HOME },
    { key: "XDG_STATE_HOME", value: process.env.XDG_STATE_HOME },
    { key: "XDG_CACHE_HOME", value: process.env.XDG_CACHE_HOME },
    { key: "CLAWDBOT_STATE_DIR", value: process.env.CLAWDBOT_STATE_DIR },
    { key: "CLAWDBOT_TEST_HOME", value: process.env.CLAWDBOT_TEST_HOME },
  ];

  const tempHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "clawdbot-test-home-"),
  );

  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  process.env.CLAWDBOT_TEST_HOME = tempHome;

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
