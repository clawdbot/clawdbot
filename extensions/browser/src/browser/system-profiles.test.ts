import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserRouteContext } from "./server-context.js";
import {
  importSystemProfileCookies,
  listSystemProfiles,
  resolveSystemBrowserRoot,
  resolveSystemCookiesFile,
  snapshotCookieDatabase,
} from "./system-profiles.js";

const tempDirs: string[] = [];

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-system-profile-test-"));
  tempDirs.push(home);
  return home;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("system profiles", () => {
  it("enumerates profile display names from Local State", () => {
    const homeDir = makeHome();
    const root = resolveSystemBrowserRoot("chrome", homeDir);
    fs.mkdirSync(path.join(root, "Default", "Network"), { recursive: true });
    fs.mkdirSync(path.join(root, "Profile 1"), { recursive: true });
    fs.writeFileSync(path.join(root, "Default", "Network", "Cookies"), "fixture");
    fs.writeFileSync(
      path.join(root, "Local State"),
      JSON.stringify({
        profile: {
          info_cache: {
            Default: { name: "Personal" },
            "Profile 1": { name: "Work" },
          },
        },
      }),
    );

    expect(listSystemProfiles("chrome", { homeDir })).toEqual([
      { browser: "chrome", id: "Default", name: "Personal", hasCookies: true },
      { browser: "chrome", id: "Profile 1", name: "Work", hasCookies: false },
    ]);
  });

  it("enumerates every supported browser when none is specified", () => {
    const homeDir = makeHome();
    for (const [browser, displayName] of [
      ["chrome", "Personal"],
      ["brave", "BraveMain"],
    ] as const) {
      const root = resolveSystemBrowserRoot(browser, homeDir);
      fs.mkdirSync(path.join(root, "Default", "Network"), { recursive: true });
      fs.writeFileSync(path.join(root, "Default", "Network", "Cookies"), "fixture");
      fs.writeFileSync(
        path.join(root, "Local State"),
        JSON.stringify({ profile: { info_cache: { Default: { name: displayName } } } }),
      );
    }

    const all = listSystemProfiles(undefined, { homeDir });
    expect(all).toContainEqual({
      browser: "chrome",
      id: "Default",
      name: "Personal",
      hasCookies: true,
    });
    expect(all).toContainEqual({
      browser: "brave",
      id: "Default",
      name: "BraveMain",
      hasCookies: true,
    });
    // Uninstalled browsers contribute nothing.
    expect(all.filter((p) => p.browser === "edge")).toHaveLength(0);
    // A specific browser still narrows to just that browser.
    expect(listSystemProfiles("brave", { homeDir }).every((p) => p.browser === "brave")).toBe(true);
  });

  it("prefers Network/Cookies over the legacy Cookies path", () => {
    const root = makeHome();
    const profileDir = path.join(root, "Default");
    fs.mkdirSync(path.join(profileDir, "Network"), { recursive: true });
    fs.writeFileSync(path.join(profileDir, "Cookies"), "legacy");
    fs.writeFileSync(path.join(profileDir, "Network", "Cookies"), "current");

    expect(resolveSystemCookiesFile(root, "Default")).toBe(
      path.join(profileDir, "Network", "Cookies"),
    );
  });

  it("creates a coherent snapshot while the source database uses WAL", () => {
    const root = makeHome();
    const sourcePath = path.join(root, "Cookies");
    const source = new DatabaseSync(sourcePath);
    source.exec(
      "PRAGMA journal_mode = WAL; CREATE TABLE cookies(name TEXT); INSERT INTO cookies VALUES ('current')",
    );
    const snapshot = snapshotCookieDatabase(sourcePath);
    try {
      const copied = new DatabaseSync(snapshot.databasePath, { readOnly: true });
      try {
        expect(copied.prepare("SELECT name FROM cookies").get()).toEqual({ name: "current" });
      } finally {
        copied.close();
      }
    } finally {
      snapshot.cleanup();
      source.close();
    }
  });

  it("rejects import outside macOS before touching runtime state", async () => {
    const state = vi.fn();
    const runtime = {
      ctx: { state } as unknown as BrowserRouteContext,
      createProfile: vi.fn(),
    };

    await expect(importSystemProfileCookies({}, runtime, { platform: "linux" })).rejects.toThrow(
      "system profile import is only supported on macOS in this release",
    );
    expect(state).not.toHaveBeenCalled();
  });

  it("honors the kill switch before keychain or runtime access", async () => {
    const state = vi.fn();
    const readSecret = vi.fn(async () => Buffer.from("must-not-run"));
    const runtime = {
      ctx: { state } as unknown as BrowserRouteContext,
      createProfile: vi.fn(),
    };

    await expect(
      importSystemProfileCookies({}, runtime, {
        platform: "darwin",
        cfg: { browser: { allowSystemProfileImport: false } },
        readSecret,
      }),
    ).rejects.toThrow("system profile import is disabled (browser.allowSystemProfileImport=false)");
    expect(readSecret).not.toHaveBeenCalled();
    expect(state).not.toHaveBeenCalled();
  });

  it("rejects a remote destination before reading the keychain", async () => {
    const homeDir = makeHome();
    const root = resolveSystemBrowserRoot("chrome", homeDir);
    fs.mkdirSync(path.join(root, "Default", "Network"), { recursive: true });
    fs.writeFileSync(path.join(root, "Default", "Network", "Cookies"), "fixture");
    fs.writeFileSync(
      path.join(root, "Local State"),
      JSON.stringify({ profile: { info_cache: { Default: { name: "Personal" } } } }),
    );
    const readSecret = vi.fn(async () => Buffer.from("must-not-run"));
    const remoteProfile = {
      name: "imported",
      driver: "openclaw" as const,
      cdpPort: 443,
      cdpUrl: "https://browser.example.com",
      cdpHost: "browser.example.com",
      cdpIsLoopback: false,
      color: "#FF4500",
      attachOnly: false,
    };
    const runtime = {
      ctx: {
        state: () => ({ resolved: { profiles: { imported: remoteProfile } } }),
        forProfile: () => ({ profile: remoteProfile }),
      } as unknown as BrowserRouteContext,
      createProfile: vi.fn(),
    };

    await expect(
      importSystemProfileCookies({}, runtime, { platform: "darwin", homeDir, readSecret }),
    ).rejects.toThrow('profile "imported" is not a locally managed OpenClaw profile');
    expect(readSecret).not.toHaveBeenCalled();
  });
});
