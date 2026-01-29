import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  detectStateDirConflict,
  resolveDefaultConfigCandidates,
  resolveConfigPath,
  resolveOAuthDir,
  resolveOAuthPath,
  resolveStateDir,
} from "./paths.js";

describe("oauth paths", () => {
  it("prefers CLAWDBOT_OAUTH_DIR over CLAWDBOT_STATE_DIR", () => {
    const env = {
      CLAWDBOT_OAUTH_DIR: "/custom/oauth",
      CLAWDBOT_STATE_DIR: "/custom/state",
    } as NodeJS.ProcessEnv;

    expect(resolveOAuthDir(env, "/custom/state")).toBe(path.resolve("/custom/oauth"));
    expect(resolveOAuthPath(env, "/custom/state")).toBe(
      path.join(path.resolve("/custom/oauth"), "oauth.json"),
    );
  });

  it("derives oauth path from CLAWDBOT_STATE_DIR when unset", () => {
    const env = {
      CLAWDBOT_STATE_DIR: "/custom/state",
    } as NodeJS.ProcessEnv;

    expect(resolveOAuthDir(env, "/custom/state")).toBe(path.join("/custom/state", "credentials"));
    expect(resolveOAuthPath(env, "/custom/state")).toBe(
      path.join("/custom/state", "credentials", "oauth.json"),
    );
  });
});

describe("state + config path candidates", () => {
  it("prefers MOLTBOT_STATE_DIR over legacy state dir env", () => {
    const env = {
      MOLTBOT_STATE_DIR: "/new/state",
      CLAWDBOT_STATE_DIR: "/legacy/state",
    } as NodeJS.ProcessEnv;

    expect(resolveStateDir(env, () => "/home/test")).toBe(path.resolve("/new/state"));
  });

  it("orders default config candidates as new then legacy", () => {
    const home = "/home/test";
    const candidates = resolveDefaultConfigCandidates({} as NodeJS.ProcessEnv, () => home);
    expect(candidates[0]).toBe(path.join(home, ".moltbot", "moltbot.json"));
    expect(candidates[1]).toBe(path.join(home, ".moltbot", "clawdbot.json"));
    expect(candidates[2]).toBe(path.join(home, ".clawdbot", "moltbot.json"));
    expect(candidates[3]).toBe(path.join(home, ".clawdbot", "clawdbot.json"));
  });

  it("prefers ~/.moltbot when it exists and legacy dir is missing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-state-"));
    try {
      const newDir = path.join(root, ".moltbot");
      await fs.mkdir(newDir, { recursive: true });
      const resolved = resolveStateDir({} as NodeJS.ProcessEnv, () => root);
      expect(resolved).toBe(newDir);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("CONFIG_PATH prefers existing legacy filename when present", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-config-"));
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    const previousHomeDrive = process.env.HOMEDRIVE;
    const previousHomePath = process.env.HOMEPATH;
    const previousMoltbotConfig = process.env.MOLTBOT_CONFIG_PATH;
    const previousClawdbotConfig = process.env.CLAWDBOT_CONFIG_PATH;
    const previousMoltbotState = process.env.MOLTBOT_STATE_DIR;
    const previousClawdbotState = process.env.CLAWDBOT_STATE_DIR;
    try {
      const legacyDir = path.join(root, ".clawdbot");
      await fs.mkdir(legacyDir, { recursive: true });
      const legacyPath = path.join(legacyDir, "clawdbot.json");
      await fs.writeFile(legacyPath, "{}", "utf-8");

      process.env.HOME = root;
      if (process.platform === "win32") {
        process.env.USERPROFILE = root;
        const parsed = path.win32.parse(root);
        process.env.HOMEDRIVE = parsed.root.replace(/\\$/, "");
        process.env.HOMEPATH = root.slice(parsed.root.length - 1);
      }
      delete process.env.MOLTBOT_CONFIG_PATH;
      delete process.env.CLAWDBOT_CONFIG_PATH;
      delete process.env.MOLTBOT_STATE_DIR;
      delete process.env.CLAWDBOT_STATE_DIR;

      vi.resetModules();
      const { CONFIG_PATH } = await import("./paths.js");
      expect(CONFIG_PATH).toBe(legacyPath);
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
      if (previousHomeDrive === undefined) delete process.env.HOMEDRIVE;
      else process.env.HOMEDRIVE = previousHomeDrive;
      if (previousHomePath === undefined) delete process.env.HOMEPATH;
      else process.env.HOMEPATH = previousHomePath;
      if (previousMoltbotConfig === undefined) delete process.env.MOLTBOT_CONFIG_PATH;
      else process.env.MOLTBOT_CONFIG_PATH = previousMoltbotConfig;
      if (previousClawdbotConfig === undefined) delete process.env.CLAWDBOT_CONFIG_PATH;
      else process.env.CLAWDBOT_CONFIG_PATH = previousClawdbotConfig;
      if (previousMoltbotState === undefined) delete process.env.MOLTBOT_STATE_DIR;
      else process.env.MOLTBOT_STATE_DIR = previousMoltbotState;
      if (previousClawdbotState === undefined) delete process.env.CLAWDBOT_STATE_DIR;
      else process.env.CLAWDBOT_STATE_DIR = previousClawdbotState;
      await fs.rm(root, { recursive: true, force: true });
      vi.resetModules();
    }
  });

  it("respects state dir overrides when config is missing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-config-override-"));
    try {
      const legacyDir = path.join(root, ".clawdbot");
      await fs.mkdir(legacyDir, { recursive: true });
      const legacyConfig = path.join(legacyDir, "moltbot.json");
      await fs.writeFile(legacyConfig, "{}", "utf-8");

      const overrideDir = path.join(root, "override");
      const env = { MOLTBOT_STATE_DIR: overrideDir } as NodeJS.ProcessEnv;
      const resolved = resolveConfigPath(env, overrideDir, () => root);
      expect(resolved).toBe(path.join(overrideDir, "moltbot.json"));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("detectStateDirConflict", () => {
  it("returns hasConflict: true when both legacy and new dirs exist", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-conflict-"));
    try {
      const legacyDir = path.join(root, ".clawdbot");
      const newDir = path.join(root, ".moltbot");
      await fs.mkdir(legacyDir, { recursive: true });
      await fs.mkdir(newDir, { recursive: true });

      const result = detectStateDirConflict({} as NodeJS.ProcessEnv, () => root);
      expect(result.hasConflict).toBe(true);
      if (result.hasConflict) {
        expect(result.legacyDir).toBe(legacyDir);
        expect(result.newDir).toBe(newDir);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("returns hasConflict: false when only legacy dir exists", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-conflict-"));
    try {
      const legacyDir = path.join(root, ".clawdbot");
      await fs.mkdir(legacyDir, { recursive: true });

      const result = detectStateDirConflict({} as NodeJS.ProcessEnv, () => root);
      expect(result.hasConflict).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("returns hasConflict: false when only new dir exists", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-conflict-"));
    try {
      const newDir = path.join(root, ".moltbot");
      await fs.mkdir(newDir, { recursive: true });

      const result = detectStateDirConflict({} as NodeJS.ProcessEnv, () => root);
      expect(result.hasConflict).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("returns hasConflict: false when neither dir exists", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-conflict-"));
    try {
      const result = detectStateDirConflict({} as NodeJS.ProcessEnv, () => root);
      expect(result.hasConflict).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("returns hasConflict: false when env override is set", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-conflict-"));
    try {
      const legacyDir = path.join(root, ".clawdbot");
      const newDir = path.join(root, ".moltbot");
      await fs.mkdir(legacyDir, { recursive: true });
      await fs.mkdir(newDir, { recursive: true });

      const env = { MOLTBOT_STATE_DIR: "/custom/path" } as NodeJS.ProcessEnv;
      const result = detectStateDirConflict(env, () => root);
      expect(result.hasConflict).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("returns hasConflict: false when legacy is symlink to new", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-conflict-"));
    try {
      const legacyDir = path.join(root, ".clawdbot");
      const newDir = path.join(root, ".moltbot");
      await fs.mkdir(newDir, { recursive: true });
      // On Windows, use 'junction' which doesn't require admin privileges
      const symlinkType = process.platform === "win32" ? "junction" : "dir";
      await fs.symlink(newDir, legacyDir, symlinkType);

      const result = detectStateDirConflict({} as NodeJS.ProcessEnv, () => root);
      expect(result.hasConflict).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
