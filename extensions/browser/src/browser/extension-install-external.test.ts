import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { chromeProductRoots } from "./extension-install-layout.js";
import {
  installChromeExtensionBootstrap,
  removeChromeStoreInstallRequests,
  uninstallChromeExtensionNativeHosts,
} from "./extension-install.js";
import {
  FOUNDATION_STORE_ID,
  useExtensionInstallFixture,
  writeChromePreferences,
} from "./extension-install.test-support.js";

const fixture = useExtensionInstallFixture();

async function setup(platform: NodeJS.Platform = "darwin") {
  const value = await fixture(platform);
  const chrome = chromeProductRoots(value.deps).find((root) => root.product === "chrome");
  if (!chrome) {
    throw new Error("missing Chrome fixture root");
  }
  const preferences = await writeChromePreferences({
    userDataDir: chrome.userDataDir,
    profile: "Default",
    entries: {
      [FOUNDATION_STORE_ID]: { location: 6, from_webstore: true, disable_reasons: [8_192] },
    },
  });
  const requestPath = path.join(
    chrome.userDataDir,
    "External Extensions",
    `${FOUNDATION_STORE_ID}.json`,
  );
  const install = (requestStoreInstall?: boolean) =>
    installChromeExtensionBootstrap({
      bundledDir: value.bundledDir,
      pluginRoot: value.pluginRoot,
      waitMs: 1_000,
      deps: value.deps,
      requestStoreInstall,
    });
  return { ...value, chrome, preferences, requestPath, install };
}

describe("Chrome Store installation request", () => {
  it("requests the official Store install idempotently without approving Chrome's recorded extension", async () => {
    const value = await setup();
    const preferencesBefore = await fs.readFile(value.preferences, "utf8");
    const status = await value.install();
    const request = await fs.readFile(value.requestPath, "utf8");
    expect(JSON.parse(request)).toMatchObject({
      external_update_url: "https://clients2.google.com/service/update2/crx",
    });
    expect(status.storeInstallRequests).toEqual([
      expect.objectContaining({ path: value.requestPath, state: "requested" }),
    ]);
    expect(status.storeDiscovered).toEqual([
      expect.objectContaining({ enabled: false, awaitingApproval: true }),
    ]);
    expect(status.manualSetupRequired).toBe(true);
    expect(status.registrations.find((entry) => entry.product === "chrome")?.state).toBe("owned");
    const before = await fs.stat(value.requestPath);
    await value.install();
    expect((await fs.stat(value.requestPath)).mtimeMs).toBe(before.mtimeMs);
    expect(await fs.readFile(value.preferences, "utf8")).toBe(preferencesBefore);

    await uninstallChromeExtensionNativeHosts({ deps: value.deps });
    expect(await fs.readFile(value.requestPath, "utf8")).toBe(request);
    expect(await removeChromeStoreInstallRequests(value.deps)).toEqual({
      removed: [value.requestPath],
      refused: [],
    });
    expect(await removeChromeStoreInstallRequests(value.deps)).toEqual({
      removed: [],
      refused: [],
    });
    expect(await fs.readFile(value.preferences, "utf8")).toBe(preferencesBefore);
  });

  it.each(["foreign", "malformed", "symlink"] as const)(
    "preserves a %s external registration on install and cleanup",
    async (kind) => {
      const value = await setup();
      await fs.mkdir(path.dirname(value.requestPath), { recursive: true, mode: 0o700 });
      const content =
        kind === "malformed"
          ? "{"
          : JSON.stringify({
              external_update_url: "https://clients2.google.com/service/update2/crx",
            });
      const target =
        kind === "symlink" ? path.join(value.root, "foreign-request.json") : value.requestPath;
      await fs.writeFile(target, content, { mode: 0o600 });
      if (kind === "symlink") {
        await fs.symlink(target, value.requestPath);
      }
      const status = await value.install();
      expect(status.storeInstallRequests[0]?.state).toBe(
        kind === "foreign" ? "foreign" : "invalid",
      );
      expect(status.issues.join("\n")).toContain("Store installation request refused");
      expect(await removeChromeStoreInstallRequests(value.deps)).toEqual({
        removed: [],
        refused: [value.requestPath],
      });
      expect(await fs.readFile(target, "utf8")).toBe(content);
    },
  );

  it("does not request installation when the native host cannot be registered", async () => {
    const value = await setup();
    await fs.mkdir(value.chrome.nativeManifestDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      path.join(value.chrome.nativeManifestDir, "ai.openclaw.browser_bootstrap.json"),
      "{}",
      { mode: 0o600 },
    );
    const status = await value.install();
    expect(status.issues.join("\n")).toContain("native host pre-registration refused");
    expect(status.storeInstallRequests[0]?.state).toBe("missing");
    await expect(fs.access(value.requestPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["linux", "win32"] as const)(
    "leaves %s external installation unchanged",
    async (platform) => {
      const value = await setup(platform);
      expect((await value.install()).storeInstallRequests).toEqual([]);
      await expect(fs.access(value.requestPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("allows native-bootstrap-only setup without registering a Store installation", async () => {
    const value = await setup();
    const status = await value.install(false);
    expect(status.registrations.find((entry) => entry.product === "chrome")?.state).toBe("owned");
    expect(status.storeInstallRequests[0]?.state).toBe("missing");
  });
});
