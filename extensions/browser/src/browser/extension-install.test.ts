import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { relayTestKey } from "../../chrome-extension/relay-key.test-support.js";
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
  normalizeExtensionInstallWaitMs,
  repairOwnedChromeExtensionNativeHosts,
  resolveChromeExtensionLoadPath,
  uninstallChromeExtensionNativeHosts,
} from "./extension-install.js";

const ID_A = "abcdefghijklmnopabcdefghijklmnop";
// Changed-file CI runs source tests without dist; full-build lanes exercise the real native host.
const BUILT_NATIVE_HOST_PATH = path.resolve("dist/extensions/browser/native-host-entry.js");
const tempRoots: string[] = [];
const fileModesToRestore: Array<{ target: string; mode: number }> = [];

async function predictedId(candidate: string, platform: NodeJS.Platform = process.platform) {
  return generateChromeExtensionIdForPath(await fs.realpath(candidate), platform);
}

async function fixture(platform: NodeJS.Platform = "linux") {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-extension-install-")),
  );
  tempRoots.push(root);
  const homeDir = path.join(root, "home");
  const stateDir = path.join(homeDir, ".openclaw");
  const bundledDir = path.join(root, "package", "extensions", "browser", "chrome-extension");
  const pluginRoot = path.dirname(bundledDir);
  const nativeHostPath = path.join(root, "package", "native-host-entry.js");
  await fs.mkdir(path.join(bundledDir, "modules"), { recursive: true, mode: 0o700 });
  await fs.mkdir(homeDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(bundledDir, "manifest.json"), '{"manifest_version":3}\n');
  await fs.writeFile(path.join(bundledDir, "background.js"), "export {};\n");
  await fs.writeFile(path.join(bundledDir, "modules", "runtime.js"), "export {};\n");
  await fs.writeFile(path.join(bundledDir, "modules", "runtime.test.ts"), "throw new Error();\n");
  await fs.writeFile(path.join(bundledDir, "sidepanel.html"), "must not ship\n");
  await fs.writeFile(nativeHostPath, "export {};\n", { mode: 0o600 });
  const deps = {
    platform,
    homeDir,
    stateDir,
    env: {
      HOME: homeDir,
      LOCALAPPDATA: path.join(homeDir, "AppData", "Local"),
    },
    nativeHostPath,
    nodePath: process.execPath,
  };
  return { root, homeDir, stateDir, bundledDir, pluginRoot, nativeHostPath, deps };
}

async function writeSecurePreferences(params: {
  userDataDir: string;
  profile: string;
  entries: Record<string, unknown>;
}) {
  const profileDir = path.join(params.userDataDir, params.profile);
  await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
  const file = path.join(profileDir, "Secure Preferences");
  await fs.writeFile(file, JSON.stringify({ extensions: { settings: params.entries } }), {
    mode: 0o600,
  });
  return file;
}

afterEach(async () => {
  await Promise.all(
    fileModesToRestore
      .splice(0)
      .map(({ target, mode }) => fs.chmod(target, mode).catch(() => undefined)),
  );
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function makeTestFilePrivate(target: string): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  const mode = (await fs.stat(target)).mode & 0o777;
  fileModesToRestore.push({ target, mode });
  await fs.chmod(target, mode & ~0o022);
}

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
    const userUid = 1000;
    const packageRoot = path.join(value.root, "package");
    const canonicalNodePath = await fs.realpath(value.deps.nodePath);
    const realLstat = fs.lstat.bind(fs);
    const getuidSpy = vi.spyOn(process, "getuid").mockReturnValue(userUid);
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
      getuidSpy.mockRestore();
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

describe("Secure Preferences discovery", () => {
  it("discovers multiple exact unpacked IDs and ignores name, location, and path lookalikes", async () => {
    const value = await fixture();
    const installed = await installStableChromeExtension(value.bundledDir, value.deps);
    const chrome = chromeProductRoots(value.deps).find((root) => root.product === "chrome");
    if (!chrome) {
      throw new Error("missing Chrome fixture root");
    }
    const installedId = await predictedId(installed, value.deps.platform);
    const bundledId = await predictedId(value.bundledDir, value.deps.platform);
    await writeSecurePreferences({
      userDataDir: chrome.userDataDir,
      profile: "Default",
      entries: {
        [installedId]: { location: 4, path: installed, manifest: { name: "Not OpenClaw" } },
        ["p".repeat(32)]: { location: 1, path: installed, manifest: { name: "OpenClaw" } },
      },
    });
    await writeSecurePreferences({
      userDataDir: chrome.userDataDir,
      profile: "Profile 1",
      entries: {
        [bundledId]: { location: 4, path: value.bundledDir },
        ["o".repeat(32)]: { location: 4, path: path.join(value.root, "lookalike") },
      },
    });

    const result = await discoverChromeExtensionIds({
      approvedDirs: [installed, value.bundledDir],
      deps: value.deps,
    });

    expect(result.discovered.map((entry) => [entry.profile, entry.extensionId])).toEqual([
      ["Default", installedId],
      ["Profile 1", bundledId],
    ]);
    for (const entry of result.discovered) {
      expect(entry.extensionId).toBe(
        generateChromeExtensionIdForPath(entry.extensionPath, value.deps.platform),
      );
    }
  });

  it("rejects a recorded ID that does not match the canonical approved path", async () => {
    const value = await fixture();
    const installed = await installStableChromeExtension(value.bundledDir, value.deps);
    const chrome = chromeProductRoots(value.deps).find((root) => root.product === "chrome");
    if (!chrome) {
      throw new Error("missing Chrome fixture root");
    }
    const expected = await predictedId(installed, value.deps.platform);
    await writeSecurePreferences({
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

  it("fails closed on malformed, oversized, locked, and symlinked profile metadata", async () => {
    const value = await fixture();
    const chrome = chromeProductRoots(value.deps).find((root) => root.product === "chrome");
    if (!chrome) {
      throw new Error("missing Chrome fixture root");
    }
    const malformed = await writeSecurePreferences({
      userDataDir: chrome.userDataDir,
      profile: "Default",
      entries: {},
    });
    await fs.writeFile(malformed, "{partial", { mode: 0o600 });
    const profileLink = path.join(chrome.userDataDir, "Profile 2");
    await fs.symlink(path.join(chrome.userDataDir, "Default"), profileLink);
    const oversized = await writeSecurePreferences({
      userDataDir: chrome.userDataDir,
      profile: "Profile 3",
      entries: {},
    });
    await fs.truncate(oversized, 32 * 1024 * 1024 + 1);
    const canLockFile = process.platform !== "win32" && process.getuid?.() !== 0;
    if (canLockFile) {
      const locked = await writeSecurePreferences({
        userDataDir: chrome.userDataDir,
        profile: "Profile 4",
        entries: {},
      });
      await fs.chmod(locked, 0o000);
    }

    const result = await discoverChromeExtensionIds({
      approvedDirs: [value.bundledDir],
      deps: value.deps,
    });
    expect(result.discovered).toEqual([]);
    expect(result.issues.join("\n")).toContain("Default");
    expect(result.issues.join("\n")).toContain("Profile 3");
    if (canLockFile) {
      expect(result.issues.join("\n")).toContain("Profile 4");
    }
  });

  it("does not approve a foreign stable copy in status discovery", async () => {
    const value = await fixture();
    const target = stableChromeExtensionDir(value.deps);
    await fs.mkdir(target, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(target, "manifest.json"), "{}\n", { mode: 0o600 });
    const chrome = chromeProductRoots(value.deps).find((root) => root.product === "chrome");
    if (!chrome) {
      throw new Error("missing Chrome fixture root");
    }
    await writeSecurePreferences({
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

describe("native host registration", () => {
  it.runIf(existsSync(BUILT_NATIVE_HOST_PATH))(
    "launches with the exact custom installation context when Chrome has no selectors",
    async () => {
      const value = await fixture();
      const stateDir = path.join(value.root, "custom state's dir");
      const configPath = path.join(value.root, "custom config's dir", "openclaw.json");
      const nativeHostPath = BUILT_NATIVE_HOST_PATH;
      await makeTestFilePrivate(nativeHostPath);
      const relayPort = 19_031;
      const token = relayTestKey(4);
      const deps = {
        ...value.deps,
        stateDir,
        nativeHostPath,
        env: {
          ...value.deps.env,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: configPath,
        },
      };
      await fs.mkdir(path.join(stateDir, "credentials"), { recursive: true, mode: 0o700 });
      await fs.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
      await fs.writeFile(
        path.join(stateDir, "credentials", "browser-extension-relay.secret"),
        `${token}\n`,
        { mode: 0o600 },
      );
      await fs.writeFile(
        configPath,
        `${JSON.stringify({ browser: { profiles: { e2e: { driver: "extension", cdpPort: relayPort } } } })}\n`,
        { mode: 0o600 },
      );
      const installed = await installStableChromeExtension(value.bundledDir, deps);
      const chromium = chromeProductRoots(deps).find((root) => root.product === "chromium");
      if (!chromium) {
        throw new Error("missing Chromium fixture root");
      }
      const extensionId = await predictedId(installed, deps.platform);
      await writeSecurePreferences({
        userDataDir: chromium.userDataDir,
        profile: "Default",
        entries: { [extensionId]: { location: 4, path: installed } },
      });
      const status = await installChromeExtensionBootstrap({
        bundledDir: value.bundledDir,
        pluginRoot: value.pluginRoot,
        waitMs: 1_000,
        deps,
      });
      const registration = status.registrations.find((entry) => entry.product === "chromium");
      expect(registration, status.issues.join("\n")).toMatchObject({ state: "owned" });
      const manifest = JSON.parse(await fs.readFile(registration?.manifestPath ?? "", "utf8")) as {
        path: string;
      };

      const nonce = Buffer.alloc(16, 7).toString("base64url");
      const requestBody = Buffer.from(JSON.stringify({ v: 1, op: "bootstrap", nonce }));
      const requestFrame = Buffer.alloc(requestBody.length + 4);
      if (os.endianness() === "LE") {
        requestFrame.writeUInt32LE(requestBody.length);
      } else {
        requestFrame.writeUInt32BE(requestBody.length);
      }
      requestBody.copy(requestFrame, 4);
      const host = spawnSync(manifest.path, [`chrome-extension://${extensionId}/`], {
        input: requestFrame,
        env: { HOME: value.homeDir },
        timeout: 10_000,
      });
      expect(host.status, host.stderr.toString("utf8")).toBe(0);
      const frameLength =
        os.endianness() === "LE" ? host.stdout.readUInt32LE() : host.stdout.readUInt32BE();
      expect(host.stdout).toHaveLength(frameLength + 4);
      expect(JSON.parse(host.stdout.subarray(4).toString("utf8"))).toEqual({
        v: 1,
        ok: true,
        nonce,
        pairingString: `ws://127.0.0.1:18789/browser/extension?gateway=ws%3A%2F%2F127.0.0.1%3A18789#${token}`,
      });
    },
  );

  it("pre-registers predicted IDs before waiting, then verifies Chrome's recorded ID", async () => {
    const value = await fixture();
    const installed = stableChromeExtensionDir(value.deps);
    const chromium = chromeProductRoots(value.deps).find((root) => root.product === "chromium");
    if (!chromium) {
      throw new Error("missing Chromium fixture root");
    }
    await fs.mkdir(chromium.userDataDir, { recursive: true, mode: 0o700 });
    const installedId = generateChromeExtensionIdForPath(installed, value.deps.platform);
    const bundledId = await predictedId(value.bundledDir, value.deps.platform);
    let now = 0;
    let wroteProfile = false;
    const status = await installChromeExtensionBootstrap({
      bundledDir: value.bundledDir,
      pluginRoot: value.pluginRoot,
      waitMs: 1_000,
      deps: {
        ...value.deps,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
          if (!wroteProfile) {
            const manifestPath = path.join(
              chromium.nativeManifestDir,
              "ai.openclaw.browser_bootstrap.json",
            );
            const preRegistration = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
              allowed_origins: string[];
            };
            expect(preRegistration.allowed_origins).toEqual(
              [installedId, bundledId].toSorted().map((id) => `chrome-extension://${id}/`),
            );
            wroteProfile = true;
            await writeSecurePreferences({
              userDataDir: chromium.userDataDir,
              profile: "Default",
              entries: {
                [installedId]: { location: 4, path: installed },
              },
            });
          }
        },
      },
    });

    expect(status.manualSetupRequired).toBe(false);
    const registration = status.registrations.find((entry) => entry.product === "chromium");
    expect(registration).toMatchObject({
      state: "owned",
      extensionIds: [installedId, bundledId].toSorted(),
    });
    const manifest = await fs.readFile(registration?.manifestPath ?? "", "utf8");
    expect(manifest).toContain(`chrome-extension://${installedId}/`);
    expect(manifest).not.toMatch(/[0-9a-f]{64}/u);
    expect(JSON.stringify(status)).not.toMatch(/pairingString|token|Bearer/u);
    if (process.platform !== "win32") {
      expect((await fs.stat(registration?.manifestPath ?? "")).mode & 0o777).toBe(0o600);
      const launcherPath = (JSON.parse(manifest) as { path: string }).path;
      expect((await fs.stat(launcherPath)).mode & 0o777).toBe(0o700);
      const launcher = await fs.readFile(launcherPath, "utf8");
      const expectedOrigins = [installedId, bundledId]
        .toSorted()
        .map((id) => `chrome-extension://${id}/`);
      expect(launcher.match(/chrome-extension:\/\/[a-p]{32}\//gu)?.toSorted()).toEqual(
        expectedOrigins,
      );
      expect(launcher).not.toMatch(/pairingString|Bearer|#[A-Za-z0-9_-]{20}/u);
    }
  });

  it("refuses to overwrite or remove a foreign manifest with the same host name", async () => {
    const value = await fixture();
    const installed = await installStableChromeExtension(value.bundledDir, value.deps);
    const extensionId = await predictedId(installed, value.deps.platform);
    const chrome = chromeProductRoots(value.deps).find((root) => root.product === "chrome");
    if (!chrome) {
      throw new Error("missing Chrome fixture root");
    }
    await writeSecurePreferences({
      userDataDir: chrome.userDataDir,
      profile: "Default",
      entries: { [extensionId]: { location: 4, path: installed } },
    });
    await fs.mkdir(chrome.nativeManifestDir, { recursive: true, mode: 0o700 });
    const manifestPath = path.join(chrome.nativeManifestDir, "ai.openclaw.browser_bootstrap.json");
    await fs.writeFile(
      manifestPath,
      JSON.stringify({
        name: "ai.openclaw.browser_bootstrap",
        path: "/foreign/host",
        allowed_origins: [`chrome-extension://${extensionId}/`],
      }),
      { mode: 0o600 },
    );

    const status = await installChromeExtensionBootstrap({
      bundledDir: value.bundledDir,
      pluginRoot: value.pluginRoot,
      waitMs: 1_000,
      deps: value.deps,
    });
    expect(status.manualSetupRequired).toBe(true);
    expect(status.issues.join("\n")).toContain("pre-registration refused");
    const repair = await repairOwnedChromeExtensionNativeHosts({
      bundledDir: value.bundledDir,
      pluginRoot: value.pluginRoot,
      deps: value.deps,
    });
    expect(repair.changes).toEqual([]);
    expect(repair.warnings.join("\n")).toContain("native host repair refused");
    const removal = await uninstallChromeExtensionNativeHosts({ deps: value.deps });
    expect(removal.refused).toContain(manifestPath);
    await expect(fs.readFile(manifestPath, "utf8")).resolves.toContain("/foreign/host");
  });

  it("warns about an unused product's foreign manifest without blocking the discovered product", async () => {
    const value = await fixture();
    const installed = await installStableChromeExtension(value.bundledDir, value.deps);
    const extensionId = await predictedId(installed, value.deps.platform);
    const roots = chromeProductRoots(value.deps);
    const chrome = roots.find((root) => root.product === "chrome");
    const chromium = roots.find((root) => root.product === "chromium");
    if (!chrome || !chromium) {
      throw new Error("missing browser fixture roots");
    }
    await fs.mkdir(chrome.userDataDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(chrome.nativeManifestDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      path.join(chrome.nativeManifestDir, "ai.openclaw.browser_bootstrap.json"),
      JSON.stringify({ name: "foreign", path: "/foreign/host", allowed_origins: [] }),
      { mode: 0o600 },
    );
    await writeSecurePreferences({
      userDataDir: chromium.userDataDir,
      profile: "Default",
      entries: { [extensionId]: { location: 4, path: installed } },
    });

    const status = await installChromeExtensionBootstrap({
      bundledDir: value.bundledDir,
      pluginRoot: value.pluginRoot,
      waitMs: 1_000,
      deps: value.deps,
    });

    expect(status.manualSetupRequired).toBe(false);
    expect(status.issues.join("\n")).toContain("Google Chrome");
    expect(status.registrations.find((entry) => entry.product === "chromium")?.state).toBe("owned");
  });

  it("rejects and removes an owned-path manifest with an extra valid origin", async () => {
    const value = await fixture();
    const installed = await installStableChromeExtension(value.bundledDir, value.deps);
    const installedId = await predictedId(installed, value.deps.platform);
    const chrome = chromeProductRoots(value.deps).find((root) => root.product === "chrome");
    if (!chrome) {
      throw new Error("missing Chrome fixture root");
    }
    await writeSecurePreferences({
      userDataDir: chrome.userDataDir,
      profile: "Default",
      entries: { [installedId]: { location: 4, path: installed } },
    });
    let status = await installChromeExtensionBootstrap({
      bundledDir: value.bundledDir,
      pluginRoot: value.pluginRoot,
      waitMs: 1_000,
      deps: value.deps,
    });
    const registration = status.registrations.find((entry) => entry.product === "chrome");
    const manifestPath = registration?.manifestPath ?? "";
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
      allowed_origins: string[];
    };
    const extraOrigin = `chrome-extension://${"p".repeat(32)}/`;
    await fs.writeFile(
      manifestPath,
      `${JSON.stringify({
        ...manifest,
        allowed_origins: [...manifest.allowed_origins, extraOrigin].toSorted(),
      })}\n`,
      { mode: 0o600 },
    );

    status = await browserExtensionStatus({ bundledDir: value.bundledDir, deps: value.deps });
    expect(status.manualSetupRequired).toBe(true);
    expect(status.registrations.find((entry) => entry.product === "chrome")?.state).toBe("invalid");
    const install = await installChromeExtensionBootstrap({
      bundledDir: value.bundledDir,
      pluginRoot: value.pluginRoot,
      waitMs: 1_000,
      deps: value.deps,
    });
    expect(install.issues.join("\n")).toContain("pre-registration refused");
    await expect(fs.readFile(manifestPath, "utf8")).resolves.toContain(extraOrigin);
    const repair = await repairOwnedChromeExtensionNativeHosts({
      bundledDir: value.bundledDir,
      pluginRoot: value.pluginRoot,
      deps: value.deps,
    });
    expect(repair.changes).toEqual([]);
    expect(repair.warnings.join("\n")).toContain("native host repair refused");
    const removal = await uninstallChromeExtensionNativeHosts({ deps: value.deps });
    expect(removal.refused).toEqual([]);
    expect(removal.removed).toHaveLength(2);
  });

  it("uninstalls owned registrations and reports Windows as manual_required", async () => {
    const value = await fixture();
    const installed = await installStableChromeExtension(value.bundledDir, value.deps);
    const extensionId = await predictedId(installed, value.deps.platform);
    const chrome = chromeProductRoots(value.deps).find((root) => root.product === "chrome");
    if (!chrome) {
      throw new Error("missing Chrome fixture root");
    }
    await writeSecurePreferences({
      userDataDir: chrome.userDataDir,
      profile: "Default",
      entries: { [extensionId]: { location: 4, path: installed } },
    });
    await installChromeExtensionBootstrap({
      bundledDir: value.bundledDir,
      pluginRoot: value.pluginRoot,
      waitMs: 1_000,
      deps: value.deps,
    });
    const result = await uninstallChromeExtensionNativeHosts({ deps: value.deps });
    expect(result.refused).toEqual([]);
    expect(result.removed).toHaveLength(2);

    const windows = await fixture("win32");
    await installStableChromeExtension(windows.bundledDir, windows.deps);
    const status = await browserExtensionStatus({
      bundledDir: windows.bundledDir,
      deps: windows.deps,
    });
    expect(status.platformSupport).toBe("manual_required");
    await expect(uninstallChromeExtensionNativeHosts({ deps: windows.deps })).resolves.toEqual({
      removed: [],
      refused: [],
      manualRequired: true,
    });
  });

  it("refuses owned-path ID drift even when the native host moved", async () => {
    const value = await fixture();
    const installed = await installStableChromeExtension(value.bundledDir, value.deps);
    const installedId = await predictedId(installed, value.deps.platform);
    const chrome = chromeProductRoots(value.deps).find((root) => root.product === "chrome");
    if (!chrome) {
      throw new Error("missing Chrome fixture root");
    }
    await writeSecurePreferences({
      userDataDir: chrome.userDataDir,
      profile: "Default",
      entries: { [installedId]: { location: 4, path: installed } },
    });
    let status = await installChromeExtensionBootstrap({
      bundledDir: value.bundledDir,
      pluginRoot: value.pluginRoot,
      waitMs: 1_000,
      deps: value.deps,
    });
    const registration = status.registrations.find((entry) => entry.product === "chrome");
    const manifestPath = registration?.manifestPath ?? "";
    const firstManifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
      path: string;
      allowed_origins: string[];
    };
    await fs.writeFile(
      manifestPath,
      `${JSON.stringify({
        ...firstManifest,
        allowed_origins: [`chrome-extension://${installedId}/`],
      })}\n`,
      { mode: 0o600 },
    );
    const movedNativeHost = path.join(value.root, "moved", "native-host-entry.js");
    await fs.mkdir(path.dirname(movedNativeHost), { recursive: true });
    await fs.writeFile(movedNativeHost, "export {};\n", { mode: 0o600 });
    const repair = await repairOwnedChromeExtensionNativeHosts({
      bundledDir: value.bundledDir,
      pluginRoot: value.pluginRoot,
      deps: { ...value.deps, nativeHostPath: movedNativeHost },
    });
    expect(repair.changes).toEqual([]);
    expect(repair.warnings.join("\n")).toContain("native host repair refused");
    status = await browserExtensionStatus({
      bundledDir: value.bundledDir,
      deps: { ...value.deps, nativeHostPath: movedNativeHost },
    });
    expect(status.manualSetupRequired).toBe(true);
    expect(status.registrations.find((entry) => entry.product === "chrome")?.state).toBe("invalid");
    await expect(fs.readFile(firstManifest.path, "utf8")).resolves.not.toContain(movedNativeHost);
  });

  it("repairs a stale owned launcher when the registered IDs are already exact", async () => {
    const value = await fixture();
    const installed = await installStableChromeExtension(value.bundledDir, value.deps);
    const installedId = await predictedId(installed, value.deps.platform);
    const chrome = chromeProductRoots(value.deps).find((root) => root.product === "chrome");
    if (!chrome) {
      throw new Error("missing Chrome fixture root");
    }
    await writeSecurePreferences({
      userDataDir: chrome.userDataDir,
      profile: "Default",
      entries: { [installedId]: { location: 4, path: installed } },
    });
    const status = await installChromeExtensionBootstrap({
      bundledDir: value.bundledDir,
      pluginRoot: value.pluginRoot,
      waitMs: 1_000,
      deps: value.deps,
    });
    const registration = status.registrations.find((entry) => entry.product === "chrome");
    const manifest = JSON.parse(await fs.readFile(registration?.manifestPath ?? "", "utf8")) as {
      path: string;
    };

    await expect(
      repairOwnedChromeExtensionNativeHosts({
        bundledDir: value.bundledDir,
        pluginRoot: value.pluginRoot,
        deps: value.deps,
      }),
    ).resolves.toEqual({ changes: [], warnings: [] });

    const movedNativeHost = path.join(value.root, "moved", "native-host-entry.js");
    await fs.mkdir(path.dirname(movedNativeHost), { recursive: true });
    await fs.writeFile(movedNativeHost, "export {};\n", { mode: 0o600 });
    const repair = await repairOwnedChromeExtensionNativeHosts({
      bundledDir: value.bundledDir,
      pluginRoot: value.pluginRoot,
      deps: { ...value.deps, nativeHostPath: movedNativeHost },
    });

    expect(repair).toEqual({
      changes: ["Repaired Google Chrome OpenClaw native messaging registration."],
      warnings: [],
    });
    await expect(fs.readFile(manifest.path, "utf8")).resolves.toContain(movedNativeHost);
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

describe("installer option bounds", () => {
  it("accepts bounded waits and rejects unbounded waits", () => {
    expect(normalizeExtensionInstallWaitMs(undefined)).toBe(30_000);
    expect(normalizeExtensionInstallWaitMs("1000")).toBe(1_000);
    expect(() => normalizeExtensionInstallWaitMs(999)).toThrow("--wait-ms");
    expect(() => normalizeExtensionInstallWaitMs(120_001)).toThrow("--wait-ms");
  });
});
