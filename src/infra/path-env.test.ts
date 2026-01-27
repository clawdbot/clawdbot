import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ensureMoltbotCliOnPath } from "./path-env.js";

describe("ensureMoltbotCliOnPath", () => {
  it("prepends the bundled app bin dir when a sibling moltbot exists", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-path-"));
    try {
      const appBinDir = path.join(tmp, "AppBin");
      await fs.mkdir(appBinDir, { recursive: true });
      const cliPath = path.join(appBinDir, "moltbot");
      await fs.writeFile(cliPath, "#!/bin/sh\necho ok\n", "utf-8");
      await fs.chmod(cliPath, 0o755);

      const originalPath = process.env.PATH;
      const originalFlag = process.env.CLAWDBOT_PATH_BOOTSTRAPPED;
      process.env.PATH = "/usr/bin";
      delete process.env.CLAWDBOT_PATH_BOOTSTRAPPED;
      try {
        ensureMoltbotCliOnPath({
          execPath: cliPath,
          cwd: tmp,
          homeDir: tmp,
          platform: "darwin",
        });
        const updated = process.env.PATH ?? "";
        expect(updated.split(path.delimiter)[0]).toBe(appBinDir);
      } finally {
        process.env.PATH = originalPath;
        if (originalFlag === undefined) delete process.env.CLAWDBOT_PATH_BOOTSTRAPPED;
        else process.env.CLAWDBOT_PATH_BOOTSTRAPPED = originalFlag;
      }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("is idempotent", () => {
    const originalPath = process.env.PATH;
    const originalFlag = process.env.CLAWDBOT_PATH_BOOTSTRAPPED;
    process.env.PATH = "/bin";
    process.env.CLAWDBOT_PATH_BOOTSTRAPPED = "1";
    try {
      ensureMoltbotCliOnPath({
        execPath: "/tmp/does-not-matter",
        cwd: "/tmp",
        homeDir: "/tmp",
        platform: "darwin",
      });
      expect(process.env.PATH).toBe("/bin");
    } finally {
      process.env.PATH = originalPath;
      if (originalFlag === undefined) delete process.env.CLAWDBOT_PATH_BOOTSTRAPPED;
      else process.env.CLAWDBOT_PATH_BOOTSTRAPPED = originalFlag;
    }
  });

  it("prepends mise shims when available", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-path-"));
    const originalPath = process.env.PATH;
    const originalFlag = process.env.CLAWDBOT_PATH_BOOTSTRAPPED;
    const originalMiseDataDir = process.env.MISE_DATA_DIR;
    try {
      const appBinDir = path.join(tmp, "AppBin");
      await fs.mkdir(appBinDir, { recursive: true });
      const appCli = path.join(appBinDir, "moltbot");
      await fs.writeFile(appCli, "#!/bin/sh\necho ok\n", "utf-8");
      await fs.chmod(appCli, 0o755);

      const localBinDir = path.join(tmp, "node_modules", ".bin");
      await fs.mkdir(localBinDir, { recursive: true });
      const localCli = path.join(localBinDir, "moltbot");
      await fs.writeFile(localCli, "#!/bin/sh\necho ok\n", "utf-8");
      await fs.chmod(localCli, 0o755);

      const miseDataDir = path.join(tmp, "mise");
      const shimsDir = path.join(miseDataDir, "shims");
      await fs.mkdir(shimsDir, { recursive: true });
      process.env.MISE_DATA_DIR = miseDataDir;
      process.env.PATH = "/usr/bin";
      delete process.env.CLAWDBOT_PATH_BOOTSTRAPPED;

      ensureMoltbotCliOnPath({
        execPath: appCli,
        cwd: tmp,
        homeDir: tmp,
        platform: "darwin",
      });

      const updated = process.env.PATH ?? "";
      const parts = updated.split(path.delimiter);
      const appBinIndex = parts.indexOf(appBinDir);
      const localIndex = parts.indexOf(localBinDir);
      const shimsIndex = parts.indexOf(shimsDir);
      expect(appBinIndex).toBeGreaterThanOrEqual(0);
      expect(localIndex).toBeGreaterThan(appBinIndex);
      expect(shimsIndex).toBeGreaterThan(localIndex);
    } finally {
      process.env.PATH = originalPath;
      if (originalFlag === undefined) delete process.env.CLAWDBOT_PATH_BOOTSTRAPPED;
      else process.env.CLAWDBOT_PATH_BOOTSTRAPPED = originalFlag;
      if (originalMiseDataDir === undefined) delete process.env.MISE_DATA_DIR;
      else process.env.MISE_DATA_DIR = originalMiseDataDir;
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("prepends Linuxbrew dirs when present", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-path-"));
    const originalPath = process.env.PATH;
    const originalFlag = process.env.CLAWDBOT_PATH_BOOTSTRAPPED;
    const originalHomebrewPrefix = process.env.HOMEBREW_PREFIX;
    const originalHomebrewBrewFile = process.env.HOMEBREW_BREW_FILE;
    const originalXdgBinHome = process.env.XDG_BIN_HOME;
    try {
      const execDir = path.join(tmp, "exec");
      await fs.mkdir(execDir, { recursive: true });

      const linuxbrewBin = path.join(tmp, ".linuxbrew", "bin");
      const linuxbrewSbin = path.join(tmp, ".linuxbrew", "sbin");
      await fs.mkdir(linuxbrewBin, { recursive: true });
      await fs.mkdir(linuxbrewSbin, { recursive: true });

      process.env.PATH = "/usr/bin";
      delete process.env.CLAWDBOT_PATH_BOOTSTRAPPED;
      delete process.env.HOMEBREW_PREFIX;
      delete process.env.HOMEBREW_BREW_FILE;
      delete process.env.XDG_BIN_HOME;

      ensureMoltbotCliOnPath({
        execPath: path.join(execDir, "node"),
        cwd: tmp,
        homeDir: tmp,
        platform: "linux",
      });

      const updated = process.env.PATH ?? "";
      const parts = updated.split(path.delimiter);
      expect(parts[0]).toBe(linuxbrewBin);
      expect(parts[1]).toBe(linuxbrewSbin);
    } finally {
      process.env.PATH = originalPath;
      if (originalFlag === undefined) delete process.env.CLAWDBOT_PATH_BOOTSTRAPPED;
      else process.env.CLAWDBOT_PATH_BOOTSTRAPPED = originalFlag;
      if (originalHomebrewPrefix === undefined) delete process.env.HOMEBREW_PREFIX;
      else process.env.HOMEBREW_PREFIX = originalHomebrewPrefix;
      if (originalHomebrewBrewFile === undefined) delete process.env.HOMEBREW_BREW_FILE;
      else process.env.HOMEBREW_BREW_FILE = originalHomebrewBrewFile;
      if (originalXdgBinHome === undefined) delete process.env.XDG_BIN_HOME;
      else process.env.XDG_BIN_HOME = originalXdgBinHome;
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
