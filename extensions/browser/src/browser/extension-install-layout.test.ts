import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertOwnedPath,
  chromeProductRoots,
  discoverChromeExtensionIds,
  generateChromeExtensionIdForPath,
  installStableChromeExtension,
  stableChromeExtensionDir,
} from "./extension-install-layout.js";
import {
  browserExtensionStatus,
  installChromeExtensionBootstrap,
  resolveChromeExtensionLoadPath,
} from "./extension-install.js";
import {
  FOUNDATION_STORE_ID,
  predictedId,
  useExtensionInstallFixture,
  writeChromePreferences,
} from "./extension-install.test-support.js";

const ID_A = "abcdefghijklmnopabcdefghijklmnop";
const fixture = useExtensionInstallFixture();

afterEach(() => {
  vi.restoreAllMocks();
});

function statsWithUid<T extends Awaited<ReturnType<typeof fs.lstat>>>(info: T, uid: number): T {
  return new Proxy(info, {
    get(target, property) {
      if (property === "uid") {
        return uid;
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe.runIf(process.platform !== "win32")("extension install ownership policy", () => {
  it("allows only explicit read-only root-owned inputs", async () => {
    const target = "/opt/openclaw/native-host-entry.js";
    const getuidSpy = vi.spyOn(process, "getuid").mockReturnValue(1000);
    const lstatSpy = vi.spyOn(fs, "lstat").mockResolvedValue({
      isDirectory: () => false,
      isFile: () => true,
      isSymbolicLink: () => false,
      mode: 0o100644,
      uid: 0,
    } as Awaited<ReturnType<typeof fs.lstat>>);
    const realpathSpy = vi.spyOn(fs, "realpath").mockResolvedValue(target);
    try {
      await expect(
        assertOwnedPath(target, "file", { allowRootOwner: true }),
      ).resolves.toBeUndefined();
      await expect(assertOwnedPath(target, "file")).rejects.toThrow("foreign owner");
    } finally {
      realpathSpy.mockRestore();
      lstatSpy.mockRestore();
      getuidSpy.mockRestore();
    }
  });

  it.each([
    { label: "root-owned state", uid: 0, mode: 0o100600, allowRootOwner: false },
    { label: "foreign-owned input", uid: 2000, mode: 0o100600, allowRootOwner: true },
    { label: "root-owned group-writable input", uid: 0, mode: 0o100660, allowRootOwner: true },
    { label: "user-owned world-writable input", uid: 1000, mode: 0o100602, allowRootOwner: false },
  ])("rejects $label", async ({ uid, mode, allowRootOwner }) => {
    const target = "/opt/openclaw/unsafe";
    const getuidSpy = vi.spyOn(process, "getuid").mockReturnValue(1000);
    const lstatSpy = vi.spyOn(fs, "lstat").mockResolvedValue({
      isDirectory: () => false,
      isFile: () => true,
      isSymbolicLink: () => false,
      mode,
      uid,
    } as Awaited<ReturnType<typeof fs.lstat>>);
    const realpathSpy = vi.spyOn(fs, "realpath").mockResolvedValue(target);
    try {
      await expect(assertOwnedPath(target, "file", { allowRootOwner })).rejects.toThrow(
        uid !== 1000 && !(allowRootOwner && uid === 0) ? "foreign owner" : "group/world-writable",
      );
    } finally {
      realpathSpy.mockRestore();
      lstatSpy.mockRestore();
      getuidSpy.mockRestore();
    }
  });

  it("installs from a package-shaped root-owned tree into user-owned state", async () => {
    const value = await fixture();
    const chromium = chromeProductRoots(value.deps).find((root) => root.product === "chromium");
    if (!chromium) {
      throw new Error("missing Chromium fixture root");
    }
    await fs.mkdir(chromium.userDataDir, { recursive: true, mode: 0o700 });
    const userUid = process.getuid?.() ?? 1000;
    const packageRoot = path.join(value.root, "package");
    const canonicalNodePath = await fs.realpath(value.deps.nodePath);
    const realLstat = fs.lstat.bind(fs);
    const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (target) => {
      const info = await realLstat(target);
      const resolved = path.resolve(String(target));
      const rootOwned =
        resolved.startsWith(`${packageRoot}${path.sep}`) || resolved === canonicalNodePath;
      return statsWithUid(info, rootOwned ? 0 : userUid);
    });
    try {
      let now = 0;
      const status = await installChromeExtensionBootstrap({
        bundledDir: value.bundledDir,
        pluginRoot: value.pluginRoot,
        waitMs: 1_000,
        deps: {
          ...value.deps,
          now: () => now,
          sleep: async (ms) => {
            now += ms;
          },
        },
      });

      expect(status.installedCopy).toMatchObject({ present: true, owned: true });
      expect(status.registrations.find((entry) => entry.product === "chromium")?.state).toBe(
        "owned",
      );
    } finally {
      lstatSpy.mockRestore();
    }
  });
});

describe("stable extension copy", () => {
  it("atomically replaces only its owned runtime copy with private modes", async () => {
    const value = await fixture();
    const installed = await installStableChromeExtension(value.bundledDir, value.deps);
    await fs.writeFile(
      path.join(value.bundledDir, "background.js"),
      "export const updated = true;\n",
    );
    await installStableChromeExtension(value.bundledDir, value.deps);

    expect(await fs.readFile(path.join(installed, "background.js"), "utf8")).toContain("updated");
    expect(await fs.readFile(path.join(installed, ".openclaw-owned.json"), "utf8")).toContain(
      '"owner":"openclaw"',
    );
    expect(await fs.readdir(path.join(installed, "modules"))).toEqual(["runtime.js"]);
    expect(await fs.readdir(installed)).not.toContain("sidepanel.html");
    if (process.platform !== "win32") {
      expect((await fs.stat(installed)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(path.join(installed, "background.js"))).mode & 0o777).toBe(0o600);
    }
  });

  it("refuses a foreign target and symlinked source content", async () => {
    const value = await fixture();
    const target = stableChromeExtensionDir(value.deps);
    await fs.mkdir(target, { recursive: true, mode: 0o700 });
    await expect(installStableChromeExtension(value.bundledDir, value.deps)).rejects.toThrow(
      "foreign Chrome extension directory",
    );

    await fs.rm(target, { recursive: true, force: true });
    await fs.symlink(
      path.join(value.bundledDir, "background.js"),
      path.join(value.bundledDir, "link.js"),
    );
    await expect(installStableChromeExtension(value.bundledDir, value.deps)).rejects.toThrow(
      "Refusing symlink",
    );
  });

  it("keeps path read-only and prefers the installed copy", async () => {
    const value = await fixture();
    await expect(resolveChromeExtensionLoadPath(value.bundledDir, value.deps)).resolves.toBe(
      await fs.realpath(value.bundledDir),
    );
    expect(await fs.stat(value.stateDir).catch(() => null)).toBeNull();
    const installed = await installStableChromeExtension(value.bundledDir, value.deps);
    await expect(resolveChromeExtensionLoadPath(value.bundledDir, value.deps)).resolves.toBe(
      installed,
    );
  });
});

describe("deterministic unpacked extension ID", () => {
  it("matches Chromium's published POSIX and Windows path vectors", () => {
    expect(generateChromeExtensionIdForPath("/path/to/file.ext", "linux")).toBe(
      "lnkgfdknojmdambfcanadbhmfjfljobb",
    );
    expect(generateChromeExtensionIdForPath("/path/to/file.ext", "win32")).toBe(
      "jjlkojfgbeklddcpckipekckcmgcbfjn",
    );
  });

  it("normalizes only a lowercase Windows drive letter", () => {
    expect(generateChromeExtensionIdForPath("c:\\OpenClaw\\extension", "win32")).toBe(
      generateChromeExtensionIdForPath("C:\\OpenClaw\\extension", "win32"),
    );
  });
});

describe.each(["Preferences", "Secure Preferences"] as const)("%s discovery", (filename) => {
  it("discovers multiple exact unpacked IDs and ignores name, location, and path lookalikes", async () => {
    const value = await fixture();
    const installed = await installStableChromeExtension(value.bundledDir, value.deps);
    const chrome = chromeProductRoots(value.deps).find((root) => root.product === "chrome");
    if (!chrome) {
      throw new Error("missing Chrome fixture root");
    }
    const installedId = await predictedId(installed, value.deps.platform);
    const bundledId = await predictedId(value.bundledDir, value.deps.platform);
    await writeChromePreferences({
      filename,
      userDataDir: chrome.userDataDir,
      profile: "Default",
      entries: {
        [installedId]: { location: 4, path: installed, manifest: { name: "Not OpenClaw" } },
        [FOUNDATION_STORE_ID]: {
          location: 1,
          from_webstore: true,
          path: path.join(value.root, "foreign-store-lookalike"),
        },
        ["p".repeat(32)]: { location: 1, path: installed, manifest: { name: "OpenClaw" } },
      },
    });
    await writeChromePreferences({
      filename,
      userDataDir: chrome.userDataDir,
      profile: "Profile 1",
      entries: {
        [bundledId]: { location: 4, path: value.bundledDir },
        [FOUNDATION_STORE_ID]: { location: 1, from_webstore: false },
        ["o".repeat(32)]: { location: 4, path: path.join(value.root, "lookalike") },
      },
    });

    const result = await discoverChromeExtensionIds({
      approvedDirs: [installed, value.bundledDir],
      storeExtensionId: FOUNDATION_STORE_ID,
      deps: value.deps,
    });

    expect(result.discovered.map((entry) => [entry.profile, entry.extensionId])).toEqual([
      ["Default", installedId],
      ["Profile 1", bundledId],
    ]);
    await fs.symlink(
      path.join(chrome.userDataDir, "Default"),
      path.join(chrome.userDataDir, "Profile 2"),
    );
    const otherFilename = filename === "Preferences" ? "Secure Preferences" : "Preferences";
    for (const profile of ["Default", "Profile 1"]) {
      const profileDir = path.join(chrome.userDataDir, profile);
      await fs.copyFile(path.join(profileDir, filename), path.join(profileDir, otherFilename));
    }
    const duplicated = await discoverChromeExtensionIds({
      approvedDirs: [installed, value.bundledDir],
      storeExtensionId: FOUNDATION_STORE_ID,
      deps: value.deps,
    });
    expect(duplicated).toEqual({
      ...result,
      discovered: result.discovered.map((entry) => ({
        ...entry,
        securePreferencesPath: path.join(chrome.userDataDir, entry.profile, "Secure Preferences"),
      })),
      storeDiscovered: result.storeDiscovered.map((entry) => ({
        ...entry,
        securePreferencesPath: path.join(chrome.userDataDir, entry.profile, "Secure Preferences"),
      })),
    });
    for (const entry of result.discovered) {
      expect(entry.extensionId).toBe(
        generateChromeExtensionIdForPath(entry.extensionPath, value.deps.platform),
      );
    }
    expect(result.storeDiscovered).toEqual([
      expect.objectContaining({
        profile: "Default",
        extensionId: FOUNDATION_STORE_ID,
      }),
    ]);
    expect(result.discovered.map((entry) => entry.extensionId)).not.toContain(FOUNDATION_STORE_ID);
  });

  it("rejects a recorded ID that does not match the canonical approved path", async () => {
    const value = await fixture();
    const installed = await installStableChromeExtension(value.bundledDir, value.deps);
    const chrome = chromeProductRoots(value.deps).find((root) => root.product === "chrome");
    if (!chrome) {
      throw new Error("missing Chrome fixture root");
    }
    const expected = await predictedId(installed, value.deps.platform);
    await writeChromePreferences({
      filename,
      userDataDir: chrome.userDataDir,
      profile: "Default",
      entries: { [ID_A]: { location: 4, path: installed } },
    });

    const result = await discoverChromeExtensionIds({
      approvedDirs: [installed],
      deps: value.deps,
    });

    expect(result.discovered).toEqual([]);
    expect(result.identityMismatches).toHaveLength(1);
    expect(result.issues[0]).toContain(`does not match predicted ID ${expected}`);
  });

  it.for([
    { failure: "malformed", issue: "JSON" },
    { failure: "oversized", issue: "32 MiB inspection limit" },
    { failure: "locked", issue: "EACCES" },
    { failure: "symlink", issue: "Unsafe file" },
    { failure: "directory", issue: "Unsafe file" },
    { failure: "unsafe-mode", issue: "group/world-writable" },
    { failure: "foreign-owner", issue: "foreign owner" },
  ])(
    "rejects $failure metadata even when the other store contains a valid identity",
    async ({ failure, issue }, { skip }) => {
      if (
        (process.platform === "win32" &&
          ["locked", "unsafe-mode", "foreign-owner"].includes(failure)) ||
        (failure === "locked" && process.getuid?.() === 0)
      ) {
        skip();
      }
      const value = await fixture();
      const chrome = chromeProductRoots(value.deps).find((root) => root.product === "chrome");
      if (!chrome) {
        throw new Error("missing Chrome fixture root");
      }
      const extensionId = await predictedId(value.bundledDir, value.deps.platform);
      const entries = { [extensionId]: { location: 4, path: value.bundledDir } };
      const unsafe = await writeChromePreferences({
        filename,
        userDataDir: chrome.userDataDir,
        profile: "Default",
        entries,
      });
      const valid = await writeChromePreferences({
        filename: filename === "Preferences" ? "Secure Preferences" : "Preferences",
        userDataDir: chrome.userDataDir,
        profile: "Default",
        entries,
      });
      if (failure === "malformed") {
        await fs.writeFile(unsafe, "{partial");
      } else if (failure === "oversized") {
        await fs.truncate(unsafe, 32 * 1024 * 1024 + 1);
      } else if (failure === "locked" || failure === "unsafe-mode") {
        await fs.chmod(unsafe, failure === "locked" ? 0o000 : 0o662);
      } else if (failure === "foreign-owner") {
        const realLstat = fs.lstat.bind(fs);
        vi.spyOn(fs, "lstat").mockImplementation(async (target) => {
          const info = await realLstat(target);
          return String(target) === unsafe
            ? statsWithUid(info, (process.getuid?.() ?? 0) + 1)
            : info;
        });
      } else {
        await fs.unlink(unsafe);
        if (failure === "symlink") {
          await fs.symlink(valid, unsafe);
        } else {
          await fs.mkdir(unsafe);
        }
      }
      const result = await discoverChromeExtensionIds({
        approvedDirs: [value.bundledDir],
        deps: value.deps,
      });
      expect(result.discovered).toEqual([
        expect.objectContaining({ extensionId, securePreferencesPath: valid }),
      ]);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]).toContain("Default");
      expect(result.issues[0]).toContain(filename);
      expect(result.issues[0]).toContain(issue);
    },
  );

  it("does not approve a foreign stable copy in status discovery", async () => {
    const value = await fixture();
    const target = stableChromeExtensionDir(value.deps);
    await fs.mkdir(target, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(target, "manifest.json"), "{}\n", { mode: 0o600 });
    const chrome = chromeProductRoots(value.deps).find((root) => root.product === "chrome");
    if (!chrome) {
      throw new Error("missing Chrome fixture root");
    }
    await writeChromePreferences({
      filename,
      userDataDir: chrome.userDataDir,
      profile: "Default",
      entries: { [await predictedId(target, value.deps.platform)]: { location: 4, path: target } },
    });

    const status = await browserExtensionStatus({
      bundledDir: value.bundledDir,
      deps: value.deps,
    });

    expect(status.discovered).toEqual([]);
    expect(status.manualSetupRequired).toBe(true);
    expect(status.issues.join("\n")).toContain("not OpenClaw-owned");
  });
});

describe("platform roots", () => {
  it("maps Chrome, Chrome for Testing, and Chromium profile roots on every supported OS", async () => {
    const linux = await fixture("linux");
    expect(chromeProductRoots(linux.deps).map((entry) => entry.product)).toEqual([
      "chrome",
      "chrome-for-testing",
      "chromium",
    ]);
    const mac = await fixture("darwin");
    expect(chromeProductRoots(mac.deps).map((entry) => entry.product)).toEqual([
      "chrome",
      "chrome-for-testing",
      "chrome-for-testing",
      "chromium",
    ]);
    const windows = await fixture("win32");
    expect(chromeProductRoots(windows.deps).map((entry) => entry.userDataDir)).toEqual([
      path.join(windows.deps.env.LOCALAPPDATA, "Google", "Chrome", "User Data"),
      path.join(windows.deps.env.LOCALAPPDATA, "Google", "Chrome for Testing", "User Data"),
      path.join(windows.deps.env.LOCALAPPDATA, "Chromium", "User Data"),
    ]);
  });
});
