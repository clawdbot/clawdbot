import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import JSON5 from "json5";

type RestoreEntry = { key: string; value: string | undefined };

const LIVE_EXTERNAL_AUTH_DIRS = [".claude/backups", ".gemini", ".minimax"] as const;
const LIVE_EXTERNAL_AUTH_FILES = [
  ".claude.json",
  ".claude/.credentials.json",
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".codex/auth.json",
  ".codex/config.toml",
] as const;
const requireFromHere = createRequire(import.meta.url);

type LegacyConfigCompatApi = typeof import("../src/commands/doctor/shared/legacy-config-compat.js");
type ConfigValidationApi = typeof import("../src/config/validation.js");

let cachedLegacyConfigCompatApi: LegacyConfigCompatApi | undefined;
let cachedConfigValidationApi: ConfigValidationApi | undefined;

function isTruthyEnvValue(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  switch (value.trim().toLowerCase()) {
    case "":
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      return true;
  }
}

function restoreEnv(entries: RestoreEntry[]): void {
  for (const { key, value } of entries) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function loadLegacyConfigCompatApi(): LegacyConfigCompatApi {
  cachedLegacyConfigCompatApi ??= requireFromHere(
    "../src/commands/doctor/shared/legacy-config-compat.js",
  ) as LegacyConfigCompatApi;
  return cachedLegacyConfigCompatApi;
}

function loadConfigValidationApi(): ConfigValidationApi {
  cachedConfigValidationApi ??= requireFromHere(
    "../src/config/validation.js",
  ) as ConfigValidationApi;
  return cachedConfigValidationApi;
}

function resolveHomeRelativePath(input: string, homeDir: string): string {
  const trimmed = input.trim();
  if (trimmed === "~") {
    return homeDir;
  }
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.join(homeDir, trimmed.slice(2));
  }
  return path.resolve(trimmed);
}

function loadProfileEnv(homeDir = os.homedir()): void {
  const profilePath = path.join(homeDir, ".profile");
  if (!fs.existsSync(profilePath)) {
    return;
  }
  const applyEntry = (entry: string) => {
    const idx = entry.indexOf("=");
    if (idx <= 0) {
      return false;
    }
    const key = entry.slice(0, idx).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || (process.env[key] ?? "") !== "") {
      return false;
    }
    process.env[key] = entry.slice(idx + 1);
    return true;
  };
  const countAppliedEntries = (entries: Iterable<string>) => {
    let applied = 0;
    for (const entry of entries) {
      if (applyEntry(entry)) {
        applied += 1;
      }
    }
    return applied;
  };
  try {
    const output = execFileSync(
      "/bin/bash",
      ["-lc", `set -a; source "${profilePath}" >/dev/null 2>&1; env -0`],
      { encoding: "utf8" },
    );
    const applied = countAppliedEntries(output.split("\0").filter(Boolean));
    if (applied > 0 && !isTruthyEnvValue(process.env.OPENCLAW_LIVE_TEST_QUIET)) {
      console.log(`[live] loaded ${applied} env vars from ~/.profile`);
    }
  } catch {
    try {
      const fallbackEntries = fs
        .readFileSync(profilePath, "utf8")
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
        .map((line) => line.replace(/^export\s+/u, ""))
        .map((line) => {
          const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u);
          if (!match) {
            return "";
          }
          let value = match[2].trim();
          if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
          ) {
            value = value.slice(1, -1);
          }
          return `${match[1]}=${value}`;
        })
        .filter(Boolean);
      const applied = countAppliedEntries(fallbackEntries);
      if (applied > 0 && !isTruthyEnvValue(process.env.OPENCLAW_LIVE_TEST_QUIET)) {
        console.log(`[live] loaded ${applied} env vars from ~/.profile`);
      }
    } catch {
      // ignore profile load failures
    }
  }
}

function resolveRestoreEntries(): RestoreEntry[] {
  return [
    { key: "OPENCLAW_TEST_FAST", value: process.env.OPENCLAW_TEST_FAST },
    {
      key: "OPENCLAW_STRICT_FAST_REPLY_CONFIG",
      value: process.env.OPENCLAW_STRICT_FAST_REPLY_CONFIG,
    },
    {
      key: "OPENCLAW_ALLOW_SLOW_REPLY_TESTS",
      value: process.env.OPENCLAW_ALLOW_SLOW_REPLY_TESTS,
    },
    {
      key: "OPENCLAW_LIVE_TEST_NORMALIZE_CONFIG",
      value: process.env.OPENCLAW_LIVE_TEST_NORMALIZE_CONFIG,
    },
    { key: "HOME", value: process.env.HOME },
    { key: "USERPROFILE", value: process.env.USERPROFILE },
    { key: "XDG_CONFIG_HOME", value: process.env.XDG_CONFIG_HOME },
    { key: "XDG_DATA_HOME", value: process.env.XDG_DATA_HOME },
    { key: "XDG_STATE_HOME", value: process.env.XDG_STATE_HOME },
    { key: "XDG_CACHE_HOME", value: process.env.XDG_CACHE_HOME },
    { key: "OPENCLAW_STATE_DIR", value: process.env.OPENCLAW_STATE_DIR },
    { key: "OPENCLAW_CONFIG_PATH", value: process.env.OPENCLAW_CONFIG_PATH },
    { key: "OPENCLAW_GATEWAY_PORT", value: process.env.OPENCLAW_GATEWAY_PORT },
    { key: "OPENCLAW_BRIDGE_ENABLED", value: process.env.OPENCLAW_BRIDGE_ENABLED },
    { key: "OPENCLAW_BRIDGE_HOST", value: process.env.OPENCLAW_BRIDGE_HOST },
    { key: "OPENCLAW_BRIDGE_PORT", value: process.env.OPENCLAW_BRIDGE_PORT },
    { key: "OPENCLAW_CANVAS_HOST_PORT", value: process.env.OPENCLAW_CANVAS_HOST_PORT },
    { key: "OPENCLAW_TEST_HOME", value: process.env.OPENCLAW_TEST_HOME },
    { key: "OPENCLAW_AGENT_DIR", value: process.env.OPENCLAW_AGENT_DIR },
    { key: "PI_CODING_AGENT_DIR", value: process.env.PI_CODING_AGENT_DIR },
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
}

function createIsolatedTestHome(restore: RestoreEntry[]): {
  cleanup: () => void;
  tempHome: string;
} {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-test-home-"));

  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  process.env.OPENCLAW_TEST_HOME = tempHome;
  process.env.OPENCLAW_TEST_FAST = "1";
  process.env.OPENCLAW_STRICT_FAST_REPLY_CONFIG = "1";
  delete process.env.OPENCLAW_ALLOW_SLOW_REPLY_TESTS;

  // Ensure test runs never touch the developer's real config/state, even if they have overrides set.
  delete process.env.OPENCLAW_CONFIG_PATH;
  // Prefer deriving state dir from HOME so nested tests that change HOME also isolate correctly.
  delete process.env.OPENCLAW_STATE_DIR;
  delete process.env.OPENCLAW_AGENT_DIR;
  delete process.env.PI_CODING_AGENT_DIR;
  // Prefer test-controlled ports over developer overrides (avoid port collisions across tests/workers).
  delete process.env.OPENCLAW_GATEWAY_PORT;
  delete process.env.OPENCLAW_BRIDGE_ENABLED;
  delete process.env.OPENCLAW_BRIDGE_HOST;
  delete process.env.OPENCLAW_BRIDGE_PORT;
  delete process.env.OPENCLAW_CANVAS_HOST_PORT;
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

  // Windows: prefer the default state dir so auth/profile tests match real paths.
  if (process.platform === "win32") {
    process.env.OPENCLAW_STATE_DIR = path.join(tempHome, ".openclaw");
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

function ensureParentDir(targetPath: string): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
}

function copyDirIfExists(sourcePath: string, targetPath: string): void {
  if (!fs.existsSync(sourcePath)) {
    return;
  }
  fs.mkdirSync(targetPath, { recursive: true });
  fs.cpSync(sourcePath, targetPath, {
    recursive: true,
    force: true,
  });
}

function copyFileIfExists(sourcePath: string, targetPath: string): void {
  if (!fs.existsSync(sourcePath)) {
    return;
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(sourcePath);
  } catch {
    return;
  }
  if (!stat.isFile()) {
    return;
  }
  ensureParentDir(targetPath);
  fs.copyFileSync(sourcePath, targetPath);
}

function restoreClaudeConfigFromBackupIfNeeded(tempHome: string): void {
  const targetPath = path.join(tempHome, ".claude.json");
  if (fs.existsSync(targetPath)) {
    return;
  }
  const backupsDir = path.join(tempHome, ".claude", "backups");
  if (!fs.existsSync(backupsDir)) {
    return;
  }
  const latestBackup = fs
    .readdirSync(backupsDir)
    .filter((entry) => entry.startsWith(".claude.json.backup."))
    .toSorted()
    .at(-1);
  if (!latestBackup) {
    return;
  }
  copyFileIfExists(path.join(backupsDir, latestBackup), targetPath);
}

function sanitizeLiveConfig(raw: string): string {
  try {
    const parsed: {
      agents?: {
        defaults?: Record<string, unknown>;
        list?: Array<Record<string, unknown>>;
      };
    } = JSON5.parse(raw);

    if (!parsed || typeof parsed !== "object") {
      return raw;
    }

    if (parsed.agents?.defaults && typeof parsed.agents.defaults === "object") {
      delete parsed.agents.defaults.workspace;
      delete parsed.agents.defaults.agentDir;
    }

    if (Array.isArray(parsed.agents?.list)) {
      parsed.agents.list = parsed.agents.list.map((entry) => {
        if (!entry || typeof entry !== "object") {
          return entry;
        }
        const nextEntry = { ...entry };
        delete nextEntry.workspace;
        delete nextEntry.agentDir;
        return nextEntry;
      });
    }

    if (!isTruthyEnvValue(process.env.OPENCLAW_LIVE_TEST_NORMALIZE_CONFIG)) {
      return `${JSON.stringify(parsed, null, 2)}\n`;
    }

    const { applyLegacyDoctorMigrations } = loadLegacyConfigCompatApi();
    const migrated = applyLegacyDoctorMigrations(parsed);
    if (!migrated.next) {
      return `${JSON.stringify(parsed, null, 2)}\n`;
    }

    const { validateConfigObjectWithPlugins } = loadConfigValidationApi();
    const validated = validateConfigObjectWithPlugins(migrated.next);
    return `${JSON.stringify(validated.ok ? validated.config : migrated.next, null, 2)}\n`;
  } catch {
    return raw;
  }
}

function copyLiveAuthProfiles(realStateDir: string, tempStateDir: string): void {
  const agentsDir = path.join(realStateDir, "agents");
  if (!fs.existsSync(agentsDir)) {
    return;
  }
  for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const sourcePath = path.join(agentsDir, entry.name, "agent", "auth-profiles.json");
    const targetPath = path.join(tempStateDir, "agents", entry.name, "agent", "auth-profiles.json");
    copyFileIfExists(sourcePath, targetPath);
  }
}

function stageLiveTestState(params: {
  env: NodeJS.ProcessEnv;
  realHome: string;
  tempHome: string;
}): void {
  const rawStateDir = params.env.OPENCLAW_STATE_DIR?.trim();
  let realStateDir = rawStateDir
    ? resolveHomeRelativePath(rawStateDir, params.realHome)
    : path.join(params.realHome, ".openclaw");
  const priorIsolatedHome = params.env.OPENCLAW_TEST_HOME?.trim();
  const snapshotHome = params.env.HOME?.trim();
  if (
    priorIsolatedHome &&
    snapshotHome &&
    snapshotHome !== priorIsolatedHome &&
    realStateDir === path.join(priorIsolatedHome, ".openclaw")
  ) {
    realStateDir = path.join(params.realHome, ".openclaw");
  }
  const tempStateDir = path.join(params.tempHome, ".openclaw");
  fs.mkdirSync(tempStateDir, { recursive: true });
  fs.mkdirSync(path.join(params.tempHome, ".gemini"), { recursive: true });

  const realConfigPath = params.env.OPENCLAW_CONFIG_PATH?.trim()
    ? resolveHomeRelativePath(params.env.OPENCLAW_CONFIG_PATH, params.realHome)
    : path.join(realStateDir, "openclaw.json");
  if (fs.existsSync(realConfigPath)) {
    const rawConfig = fs.readFileSync(realConfigPath, "utf8");
    fs.writeFileSync(
      path.join(tempStateDir, "openclaw.json"),
      sanitizeLiveConfig(rawConfig),
      "utf8",
    );
  }

  copyDirIfExists(path.join(realStateDir, "credentials"), path.join(tempStateDir, "credentials"));
  copyDirIfExists(
    path.join(realStateDir, "external-plugins"),
    path.join(tempStateDir, "external-plugins"),
  );
  copyLiveAuthProfiles(realStateDir, tempStateDir);

  for (const authDir of LIVE_EXTERNAL_AUTH_DIRS) {
    copyDirIfExists(path.join(params.realHome, authDir), path.join(params.tempHome, authDir));
  }
  for (const authFile of LIVE_EXTERNAL_AUTH_FILES) {
    copyFileIfExists(path.join(params.realHome, authFile), path.join(params.tempHome, authFile));
  }
  restoreClaudeConfigFromBackupIfNeeded(params.tempHome);
}

export function installTestEnv(options?: { loadProfileEnv?: boolean }): {
  cleanup: () => void;
  tempHome: string;
} {
  const live =
    process.env.LIVE === "1" ||
    process.env.OPENCLAW_LIVE_TEST === "1" ||
    process.env.OPENCLAW_LIVE_GATEWAY === "1";
  const allowRealHome = isTruthyEnvValue(process.env.OPENCLAW_LIVE_USE_REAL_HOME);
  const realHome = process.env.HOME ?? os.homedir();
  const liveEnvSnapshot = { ...process.env };

  const shouldLoadProfileEnv = options?.loadProfileEnv ?? (live || allowRealHome);
  if (shouldLoadProfileEnv) {
    loadProfileEnv(realHome);
  }

  if (live && allowRealHome) {
    return { cleanup: () => {}, tempHome: realHome };
  }

  const restore = resolveRestoreEntries();
  const testEnv = createIsolatedTestHome(restore);

  if (live) {
    stageLiveTestState({ env: liveEnvSnapshot, realHome, tempHome: testEnv.tempHome });
  }

  return testEnv;
}

export function withIsolatedTestHome(options?: { loadProfileEnv?: boolean }): {
  cleanup: () => void;
  tempHome: string;
} {
  return installTestEnv(options);
}
