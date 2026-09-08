// Doctor state integrity cloud-storage tests cover macOS and Windows cloud-synced state directory detection.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  detectMacCloudSyncedStateDir,
  detectWindowsCloudSyncedStateDir,
  formatWindowsCloudSyncedStateDirWarning,
} from "./doctor-state-integrity.js";

const tempDirs = createTempDirTracker();

afterEach(() => {
  tempDirs.cleanup();
});

describe("detectMacCloudSyncedStateDir", () => {
  const home = "/Users/tester";

  it("detects state dir under iCloud Drive", () => {
    const stateDir = path.join(
      home,
      "Library",
      "Mobile Documents",
      "com~apple~CloudDocs",
      "OpenClaw",
      ".openclaw",
    );

    const result = detectMacCloudSyncedStateDir(stateDir, {
      platform: "darwin",
      homedir: home,
    });

    expect(result).toEqual({
      path: path.resolve(stateDir),
      storage: "iCloud Drive",
    });
  });

  it("detects state dir under Library/CloudStorage", () => {
    const stateDir = path.join(home, "Library", "CloudStorage", "Dropbox", "OpenClaw", ".openclaw");

    const result = detectMacCloudSyncedStateDir(stateDir, {
      platform: "darwin",
      homedir: home,
    });

    expect(result).toEqual({
      path: path.resolve(stateDir),
      storage: "CloudStorage provider",
    });
  });

  it("detects cloud-synced target when state dir resolves via symlink", () => {
    const symlinkPath = "/tmp/openclaw-state";
    const resolvedCloudPath = path.join(
      home,
      "Library",
      "CloudStorage",
      "OneDrive-Personal",
      "OpenClaw",
      ".openclaw",
    );

    const result = detectMacCloudSyncedStateDir(symlinkPath, {
      platform: "darwin",
      homedir: home,
      resolveRealPath: () => resolvedCloudPath,
    });

    expect(result).toEqual({
      path: path.resolve(resolvedCloudPath),
      storage: "CloudStorage provider",
    });
  });

  it("ignores cloud-synced symlink prefix when resolved target is local", () => {
    const symlinkPath = path.join(
      home,
      "Library",
      "CloudStorage",
      "OneDrive-Personal",
      "OpenClaw",
      ".openclaw",
    );
    const resolvedLocalPath = path.join(home, ".openclaw");

    const result = detectMacCloudSyncedStateDir(symlinkPath, {
      platform: "darwin",
      homedir: home,
      resolveRealPath: () => resolvedLocalPath,
    });

    expect(result).toBeNull();
  });

  it("follows a real symlink out of the sync root when the state dir leaf is absent", () => {
    const sandbox = fs.realpathSync(tempDirs.make("openclaw-cloud-storage-symlink-"));
    const realHome = path.join(sandbox, "home");
    const cloudStorage = path.join(realHome, "Library", "CloudStorage");
    const localTarget = path.join(sandbox, "local-openclaw");
    fs.mkdirSync(cloudStorage, { recursive: true });
    fs.mkdirSync(localTarget, { recursive: true });
    const syncedLink = path.join(cloudStorage, "OneDrive-Personal");
    fs.symlinkSync(localTarget, syncedLink, process.platform === "win32" ? "junction" : "dir");

    const stateDir = path.join(syncedLink, "OpenClaw", ".openclaw");
    expect(fs.existsSync(stateDir)).toBe(false);

    expect(
      detectMacCloudSyncedStateDir(stateDir, {
        platform: "darwin",
        homedir: realHome,
      }),
    ).toBeNull();
  });

  it("still warns for a real absent leaf that stays inside the sync root", () => {
    const sandbox = fs.realpathSync(tempDirs.make("openclaw-cloud-storage-real-"));
    const realHome = path.join(sandbox, "home");
    const syncedDir = path.join(
      realHome,
      "Library",
      "CloudStorage",
      "OneDrive-Personal",
      "OpenClaw",
    );
    fs.mkdirSync(syncedDir, { recursive: true });

    const stateDir = path.join(syncedDir, ".openclaw");
    expect(fs.existsSync(stateDir)).toBe(false);

    expect(
      detectMacCloudSyncedStateDir(stateDir, {
        platform: "darwin",
        homedir: realHome,
      }),
    ).toEqual({
      path: path.resolve(stateDir),
      storage: "CloudStorage provider",
    });
  });

  it("anchors cloud detection to OS homedir when OPENCLAW_HOME is overridden", () => {
    const stateDir = path.join(home, "Library", "CloudStorage", "iCloud Drive", ".openclaw");
    const originalOpenClawHome = process.env.OPENCLAW_HOME;
    process.env.OPENCLAW_HOME = "/tmp/openclaw-home-override";
    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(home);
    try {
      const result = detectMacCloudSyncedStateDir(stateDir, {
        platform: "darwin",
      });

      expect(result).toEqual({
        path: path.resolve(stateDir),
        storage: "CloudStorage provider",
      });
    } finally {
      homedirSpy.mockRestore();
      if (originalOpenClawHome === undefined) {
        delete process.env.OPENCLAW_HOME;
      } else {
        process.env.OPENCLAW_HOME = originalOpenClawHome;
      }
    }
  });

  it("returns null outside darwin", () => {
    const stateDir = path.join(
      home,
      "Library",
      "Mobile Documents",
      "com~apple~CloudDocs",
      "OpenClaw",
      ".openclaw",
    );

    const result = detectMacCloudSyncedStateDir(stateDir, {
      platform: "linux",
      homedir: home,
    });

    expect(result).toBeNull();
  });
});

describe("detectWindowsCloudSyncedStateDir", () => {
  // Host-native absolute paths keep these assertions portable across POSIX
  // and Windows test hosts; the sync client's env vars are the detection
  // contract, not path shape.
  const home = path.resolve("/Users/tester");
  const oneDriveRoot = path.join(home, "OneDrive");
  const oneDriveBusinessRoot = path.join(home, "OneDrive - Contoso");

  it("detects state dir under the OneDrive sync root", () => {
    const stateDir = path.join(oneDriveRoot, "OpenClaw", ".openclaw");

    const result = detectWindowsCloudSyncedStateDir(stateDir, {
      platform: "win32",
      env: { OneDrive: oneDriveRoot },
    });

    expect(result).toEqual({
      path: path.resolve(stateDir),
      storage: "OneDrive",
    });
  });

  it("detects state dir under the OneDrive for Business sync root", () => {
    const stateDir = path.join(oneDriveBusinessRoot, "OpenClaw", ".openclaw");

    const result = detectWindowsCloudSyncedStateDir(stateDir, {
      platform: "win32",
      env: { OneDriveCommercial: oneDriveBusinessRoot },
    });

    expect(result).toEqual({
      path: path.resolve(stateDir),
      storage: "OneDrive for Business",
    });
  });

  it("matches sync roots case-insensitively", () => {
    const stateDir = path.join(oneDriveRoot, "OpenClaw", ".openclaw").toUpperCase();

    const result = detectWindowsCloudSyncedStateDir(stateDir, {
      platform: "win32",
      env: { OneDrive: oneDriveRoot.toLowerCase() },
    });

    expect(result).toEqual({
      path: path.resolve(stateDir),
      storage: "OneDrive",
    });
  });

  it("ignores cloud-synced junction prefix when resolved target is local", () => {
    const junctionPath = path.join(oneDriveRoot, "OpenClaw", ".openclaw");
    const resolvedLocalPath = path.join(home, ".openclaw");

    const result = detectWindowsCloudSyncedStateDir(junctionPath, {
      platform: "win32",
      env: { OneDrive: oneDriveRoot },
      resolveRealPath: () => resolvedLocalPath,
    });

    expect(result).toBeNull();
  });

  it("ignores a junction prefix when the state dir leaf does not exist yet", () => {
    // A fresh install has not created the leaf, so realpath on the state dir
    // itself fails. Resolving only the existing ancestor still follows the
    // junction out of OneDrive, so no warning should fire.
    const junctionRoot = path.join(oneDriveRoot, "OpenClaw");
    const stateDir = path.join(junctionRoot, ".openclaw");
    const resolvedLocalRoot = path.join(home, "local-openclaw");

    const result = detectWindowsCloudSyncedStateDir(stateDir, {
      platform: "win32",
      env: { OneDrive: oneDriveRoot },
      resolveRealPath: (target) => (target === junctionRoot ? resolvedLocalRoot : null),
    });

    expect(result).toBeNull();
  });

  it("still warns when a missing leaf resolves to a path inside OneDrive", () => {
    const junctionRoot = path.join(oneDriveRoot, "OpenClaw");
    const stateDir = path.join(junctionRoot, ".openclaw");

    const result = detectWindowsCloudSyncedStateDir(stateDir, {
      platform: "win32",
      env: { OneDrive: oneDriveRoot },
      resolveRealPath: (target) => (target === junctionRoot ? junctionRoot : null),
    });

    expect(result).toEqual({
      path: path.resolve(stateDir),
      storage: "OneDrive",
    });
  });

  it("returns null when no OneDrive environment variables are set", () => {
    const stateDir = path.join(oneDriveRoot, "OpenClaw", ".openclaw");

    const result = detectWindowsCloudSyncedStateDir(stateDir, {
      platform: "win32",
      env: {},
    });

    expect(result).toBeNull();
  });

  it("returns null outside win32", () => {
    const stateDir = path.join(oneDriveRoot, "OpenClaw", ".openclaw");

    const result = detectWindowsCloudSyncedStateDir(stateDir, {
      platform: "linux",
      env: { OneDrive: oneDriveRoot },
    });

    expect(result).toBeNull();
  });
});

describe("formatWindowsCloudSyncedStateDirWarning", () => {
  const warning = () =>
    formatWindowsCloudSyncedStateDirWarning("%USERPROFILE%\\OneDrive\\OpenClaw\\.openclaw", {
      path: "C:\\Users\\tester\\OneDrive\\OpenClaw\\.openclaw",
      storage: "OneDrive",
    });

  it("names the detected sync root", () => {
    expect(warning()).toContain("Windows cloud-synced storage");
    expect(warning()).toContain("OneDrive");
  });

  // The warning is only shown on Windows, where `VAR=value command` is not a
  // valid way to set an environment variable for the command that follows.
  // cmd.exe reports "'VAR' is not recognized as an internal or external
  // command" and PowerShell reports "The term 'VAR=value' is not recognized",
  // so a POSIX-shaped hint here sends every reader down a failing recovery path.
  it("does not emit POSIX inline environment assignment", () => {
    expect(warning()).not.toMatch(/(?:^|\s)OPENCLAW_STATE_DIR=\S+\s+\S*openclaw\b/m);
  });

  // A one-shot env assignment retargets only the doctor process; the managed
  // Gateway keeps using the synced directory, so such a hint reads as a fix
  // without being one.
  it("does not emit a one-shot doctor retarget command", () => {
    expect(warning()).not.toContain("$env:OPENCLAW_STATE_DIR");
    expect(warning()).not.toContain('set "OPENCLAW_STATE_DIR=');
  });

  it("describes relocation for the Gateway service, not just one shell", () => {
    expect(warning()).toContain("stop the Gateway");
    expect(warning()).toContain("for the Gateway service");
    expect(warning()).toContain("re-run doctor");
  });
});
