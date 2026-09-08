import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chromeProductRoots,
  generateChromeExtensionIdForPath,
  installStableChromeExtension,
  stableChromeExtensionDir,
} from "./extension-install-layout.js";
import {
  browserExtensionStatus,
  installChromeExtensionBootstrap,
  normalizeExtensionInstallWaitMs,
  uninstallChromeExtensionNativeHosts,
} from "./extension-install.js";
import {
  FOUNDATION_STORE_ID,
  predictedId,
  useExtensionInstallFixture,
  writeChromePreferences,
} from "./extension-install.test-support.js";

const fixture = useExtensionInstallFixture();

async function rewriteRegistrationOrigins(manifestPath: string, origins: string[]) {
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
    path: string;
    allowed_origins: string[];
  };
  const launcher = await fs.readFile(manifest.path, "utf8");
  const replacement = origins.map((origin) => ` '--expected-origin' '${origin}'`).join("");
  const nextLauncher = launcher.replace(
    /(?: '--expected-origin' 'chrome-extension:\/\/[a-p]{32}\/')+ "\$@"/u,
    `${replacement} "$@"`,
  );
  if (nextLauncher === launcher) {
    throw new Error("launcher origins were not replaced");
  }
  await fs.writeFile(manifest.path, nextLauncher, { mode: 0o700 });
  await fs.writeFile(
    manifestPath,
    `${JSON.stringify({ ...manifest, allowed_origins: origins })}\n`,
    { mode: 0o600 },
  );
  return manifest;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("native host registration", () => {
  it("guides first-time setup when no browser user-data directory exists", async () => {
    const value = await fixture();
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

    expect(status.manualSetupRequired).toBe(true);
    expect(status.registrations.every((entry) => entry.state === "missing")).toBe(true);
    expect(status.issues).toEqual([expect.stringContaining("No native host was pre-registered.")]);
    expect(status.issues[0]).toContain("if Chrome has not been launched yet, launch it first");
  });

  it.each(["Preferences", "Secure Preferences"] as const)(
    "pre-registers predicted IDs before waiting, then verifies Chrome's recorded ID in %s",
    async (filename) => {
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
      await writeChromePreferences({
        userDataDir: chromium.userDataDir,
        profile: "Default",
        filename: filename === "Preferences" ? "Secure Preferences" : "Preferences",
        entries: {},
      });
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
                [installedId, bundledId, FOUNDATION_STORE_ID]
                  .toSorted()
                  .map((id) => `chrome-extension://${id}/`),
              );
              wroteProfile = true;
              await writeChromePreferences({
                filename,
                userDataDir: chromium.userDataDir,
                profile: "Default",
                entries: {
                  [installedId]: { location: 4, path: installed, disable_reasons: [] },
                },
              });
            }
          },
        },
      });

      expect(status.issues).toEqual([]);
      expect(status.discovered).toEqual([
        expect.objectContaining({
          extensionId: installedId,
          extensionPath: installed,
          securePreferencesPath: path.join(chromium.userDataDir, "Default", filename),
        }),
      ]);
      expect(status.manualSetupRequired).toBe(false);
      await expect(
        browserExtensionStatus({ bundledDir: value.bundledDir, deps: value.deps }),
      ).resolves.toEqual(status);
      const registration = status.registrations.find((entry) => entry.product === "chromium");
      expect(registration).toMatchObject({
        state: "owned",
        extensionIds: [installedId, bundledId, FOUNDATION_STORE_ID].toSorted(),
      });
      const manifest = await fs.readFile(registration?.manifestPath ?? "", "utf8");
      expect(manifest).toContain(`chrome-extension://${installedId}/`);
      expect(manifest).toContain(`chrome-extension://${FOUNDATION_STORE_ID}/`);
      expect(manifest).not.toMatch(/[0-9a-f]{64}/u);
      expect(JSON.stringify(status)).not.toMatch(/pairingString|token|Bearer/u);
      if (process.platform !== "win32") {
        expect((await fs.stat(registration?.manifestPath ?? "")).mode & 0o777).toBe(0o600);
        const launcherPath = (JSON.parse(manifest) as { path: string }).path;
        expect((await fs.stat(launcherPath)).mode & 0o777).toBe(0o700);
        const launcher = await fs.readFile(launcherPath, "utf8");
        const expectedOrigins = [installedId, bundledId, FOUNDATION_STORE_ID]
          .toSorted()
          .map((id) => `chrome-extension://${id}/`);
        expect(launcher.match(/chrome-extension:\/\/[a-p]{32}\//gu)?.toSorted()).toEqual(
          expectedOrigins,
        );
        expect(launcher).not.toMatch(/pairingString|Bearer|#[A-Za-z0-9_-]{20}/u);
      }
    },
  );

  it.each([
    {
      label: "current enabled",
      recorded: { disable_reasons: [] },
      enabled: true,
      awaitingApproval: false,
    },
    {
      label: "current enabled with reasons omitted",
      recorded: {},
      enabled: true,
      awaitingApproval: false,
    },
    {
      label: "pending approval",
      recorded: { disable_reasons: [8_192] },
      enabled: false,
      awaitingApproval: true,
    },
    {
      label: "disabled by user",
      recorded: { disable_reasons: [1] },
      enabled: false,
      awaitingApproval: false,
    },
    {
      label: "legacy enabled",
      recorded: { state: 1, disable_reasons: 0 },
      enabled: true,
      awaitingApproval: false,
    },
    {
      label: "legacy pending approval",
      recorded: { state: 0, disable_reasons: 8_192 },
      enabled: false,
      awaitingApproval: true,
    },
    {
      label: "invalid reasons",
      recorded: { disable_reasons: "invalid" },
      enabled: false,
      awaitingApproval: false,
    },
  ])(
    "reports $label Store state without approving its recorded path",
    async ({ recorded, enabled, awaitingApproval }) => {
      const value = await fixture();
      const chrome = chromeProductRoots(value.deps).find((root) => root.product === "chrome");
      if (!chrome) {
        throw new Error("missing Chrome fixture root");
      }
      const arbitraryPath = path.join(value.root, "not-an-owned-extension-path");
      await writeChromePreferences({
        userDataDir: chrome.userDataDir,
        profile: "Default",
        entries: {
          [FOUNDATION_STORE_ID]: {
            location: 1,
            from_webstore: true,
            path: arbitraryPath,
            ...recorded,
          },
        },
      });

      const status = await installChromeExtensionBootstrap({
        bundledDir: value.bundledDir,
        pluginRoot: value.pluginRoot,
        waitMs: 1_000,
        deps: value.deps,
      });

      expect(status.discovered).toEqual([]);
      expect(status.storeDiscovered).toEqual([
        expect.objectContaining({
          extensionId: FOUNDATION_STORE_ID,
          profile: "Default",
          enabled,
          awaitingApproval,
        }),
      ]);
      expect(status.approvedPaths).not.toContain(arbitraryPath);
      expect(status.manualSetupRequired).toBe(!enabled);
    },
  );

  it("refuses to overwrite or remove a foreign manifest with the same host name", async () => {
    const value = await fixture();
    const installed = await installStableChromeExtension(value.bundledDir, value.deps);
    const extensionId = await predictedId(installed, value.deps.platform);
    const chrome = chromeProductRoots(value.deps).find((root) => root.product === "chrome");
    if (!chrome) {
      throw new Error("missing Chrome fixture root");
    }
    await writeChromePreferences({
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
    expect(status.issues.join("\n")).toContain("No native host was pre-registered.");
    expect(status.issues.join("\n")).not.toContain("No existing Chrome-family user-data directory");
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
    await writeChromePreferences({
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
    await writeChromePreferences({
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
    await rewriteRegistrationOrigins(
      manifestPath,
      [...manifest.allowed_origins, extraOrigin].toSorted(),
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
    const removal = await uninstallChromeExtensionNativeHosts({ deps: value.deps });
    expect(removal.refused).toEqual([]);
    expect(removal.removed).toHaveLength(2);
  });

  it("refuses malformed and unsafe owned launchers", async () => {
    const mutations =
      process.platform === "win32"
        ? (["malformed"] as const)
        : (["malformed", "unsafe-mode"] as const);
    for (const mutation of mutations) {
      const value = await fixture();
      const installed = await installStableChromeExtension(value.bundledDir, value.deps);
      const installedId = await predictedId(installed, value.deps.platform);
      const chrome = chromeProductRoots(value.deps).find((root) => root.product === "chrome");
      if (!chrome) {
        throw new Error("missing Chrome fixture root");
      }
      await writeChromePreferences({
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
      const manifestPath =
        status.registrations.find((entry) => entry.product === "chrome")?.manifestPath ?? "";
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as { path: string };
      if (mutation === "malformed") {
        await fs.appendFile(manifest.path, "# unexpected launcher content\n");
      } else {
        await fs.chmod(manifest.path, 0o744);
      }

      const repair = await installChromeExtensionBootstrap({
        bundledDir: value.bundledDir,
        pluginRoot: value.pluginRoot,
        waitMs: 1_000,
        deps: value.deps,
      });
      expect(repair.manualSetupRequired, mutation).toBe(true);
      expect(repair.issues.join("\n"), mutation).toContain("pre-registration refused");
    }
  });

  it("uninstalls owned registrations and reports Windows as manual_required", async () => {
    const value = await fixture();
    const installed = await installStableChromeExtension(value.bundledDir, value.deps);
    const extensionId = await predictedId(installed, value.deps.platform);
    const chrome = chromeProductRoots(value.deps).find((root) => root.product === "chrome");
    if (!chrome) {
      throw new Error("missing Chrome fixture root");
    }
    await writeChromePreferences({
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

  it("migrates one stale path-derived slot while adding the Store origin", async () => {
    const value = await fixture();
    const installed = await installStableChromeExtension(value.bundledDir, value.deps);
    const installedId = await predictedId(installed, value.deps.platform);
    const bundledId = await predictedId(value.bundledDir, value.deps.platform);
    const chrome = chromeProductRoots(value.deps).find((root) => root.product === "chrome");
    if (!chrome) {
      throw new Error("missing Chrome fixture root");
    }
    await writeChromePreferences({
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
    const manifestPath =
      status.registrations.find((entry) => entry.product === "chrome")?.manifestPath ?? "";
    const staleId = "o".repeat(32);
    await rewriteRegistrationOrigins(
      manifestPath,
      [installedId, staleId].toSorted().map((id) => `chrome-extension://${id}/`),
    );

    const repair = await installChromeExtensionBootstrap({
      bundledDir: value.bundledDir,
      pluginRoot: value.pluginRoot,
      waitMs: 1_000,
      deps: value.deps,
    });

    expect(repair.manualSetupRequired).toBe(false);
    expect(repair.issues).toEqual([]);
    const repaired = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
      path: string;
      allowed_origins: string[];
    };
    const expectedOrigins = [installedId, bundledId, FOUNDATION_STORE_ID]
      .toSorted()
      .map((id) => `chrome-extension://${id}/`);
    expect(repaired.allowed_origins).toEqual(expectedOrigins);
    expect(
      (await fs.readFile(repaired.path, "utf8"))
        .match(/chrome-extension:\/\/[a-p]{32}\//gu)
        ?.toSorted(),
    ).toEqual(expectedOrigins);
  });

  it("refuses path-origin cardinality and no-overlap drift", async () => {
    const value = await fixture();
    const installed = await installStableChromeExtension(value.bundledDir, value.deps);
    const installedId = await predictedId(installed, value.deps.platform);
    const chrome = chromeProductRoots(value.deps).find((root) => root.product === "chrome");
    if (!chrome) {
      throw new Error("missing Chrome fixture root");
    }
    await writeChromePreferences({
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
    await rewriteRegistrationOrigins(manifestPath, [`chrome-extension://${installedId}/`]);
    const movedNativeHost = path.join(value.root, "moved", "native-host-entry.js");
    await fs.mkdir(path.dirname(movedNativeHost), { recursive: true });
    await fs.writeFile(movedNativeHost, "export {};\n", { mode: 0o600 });
    const repair = await installChromeExtensionBootstrap({
      bundledDir: value.bundledDir,
      pluginRoot: value.pluginRoot,
      waitMs: 1_000,
      deps: { ...value.deps, nativeHostPath: movedNativeHost },
    });
    expect(repair.manualSetupRequired).toBe(true);
    expect(repair.issues.join("\n")).toContain("unexpected allowed origins");
    await expect(fs.readFile(firstManifest.path, "utf8")).resolves.not.toContain(movedNativeHost);
    await rewriteRegistrationOrigins(
      manifestPath,
      ["o".repeat(32), "p".repeat(32)].toSorted().map((id) => `chrome-extension://${id}/`),
    );
    const noOverlapRepair = await installChromeExtensionBootstrap({
      bundledDir: value.bundledDir,
      pluginRoot: value.pluginRoot,
      waitMs: 1_000,
      deps: { ...value.deps, nativeHostPath: movedNativeHost },
    });
    expect(noOverlapRepair.manualSetupRequired).toBe(true);
    expect(noOverlapRepair.issues.join("\n")).toContain("unexpected allowed origins");
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
    await writeChromePreferences({
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

    const movedNativeHost = path.join(value.root, "moved", "native-host-entry.js");
    await fs.mkdir(path.dirname(movedNativeHost), { recursive: true });
    await fs.writeFile(movedNativeHost, "export {};\n", { mode: 0o600 });
    const repair = await installChromeExtensionBootstrap({
      bundledDir: value.bundledDir,
      pluginRoot: value.pluginRoot,
      waitMs: 1_000,
      deps: { ...value.deps, nativeHostPath: movedNativeHost },
    });

    expect(repair.manualSetupRequired).toBe(false);
    expect(repair.issues).toEqual([]);
    await expect(fs.readFile(manifest.path, "utf8")).resolves.toContain(movedNativeHost);
  });

  it.for([
    { target: "nodePath", failure: "missing", recovery: "install" },
    { target: "nativeHostPath", failure: "missing", recovery: "install" },
    { target: "nodePath", failure: "missing", recovery: "uninstall" },
    { target: "nodePath", failure: "non-executable", recovery: "install" },
    {
      target: "nativeHostPath",
      failure: "unreadable",
      recovery: "install",
    },
    { target: "nativeHostPath", failure: "directory", recovery: "install" },
    { target: "nodePath", failure: "symlink", recovery: "install" },
    { target: "nativeHostPath", failure: "unsafe-mode", recovery: "install" },
    { target: "nodePath", failure: "relative", recovery: "install" },
  ] as const)(
    "keeps an owned $failure $target non-ready and allows $recovery",
    async ({ target, failure, recovery }, { skip }) => {
      if (process.platform === "win32" || (failure === "unreadable" && process.getuid?.() === 0)) {
        skip();
      }
      const value = await fixture();
      const versionDir = path.join(value.root, "runtime's version '1");
      await fs.mkdir(versionDir, { mode: 0o700 });
      const registeredDeps = {
        ...value.deps,
        nodePath: path.join(versionDir, "node"),
        nativeHostPath: path.join(versionDir, "native-host-entry.js"),
        env: {
          ...value.deps.env,
          OPENCLAW_CONFIG_PATH: path.join(value.root, "config's dir", "openclaw.json"),
        },
      };
      const executed = path.join(value.root, "target-executed");
      await fs.writeFile(value.deps.nodePath, `#!/bin/sh\n: > '${executed}'\nexit 1\n`);
      await fs.writeFile(
        value.nativeHostPath,
        `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(executed)}, 'executed');\n`,
      );
      // Both replacement paths stay available while the registered version disappears.
      await fs.copyFile(value.deps.nodePath, registeredDeps.nodePath);
      await fs.copyFile(value.nativeHostPath, registeredDeps.nativeHostPath);
      const chromium = chromeProductRoots(value.deps).find((root) => root.product === "chromium");
      if (!chromium) {
        throw new Error("missing Chromium fixture root");
      }
      await writeChromePreferences({
        userDataDir: chromium.userDataDir,
        profile: "Default",
        entries: { [FOUNDATION_STORE_ID]: { location: 1, from_webstore: true } },
      });
      const params = { bundledDir: value.bundledDir, pluginRoot: value.pluginRoot, waitMs: 1_000 };
      const before = await installChromeExtensionBootstrap({ ...params, deps: registeredDeps });
      expect(before.manualSetupRequired, before.issues.join("\n")).toBe(false);
      const registration = before.registrations.find((entry) => entry.product === "chromium");
      if (!registration) {
        throw new Error("missing Chromium fixture registration");
      }
      const manifestBytes = await fs.readFile(registration.manifestPath, "utf8");
      const manifest = JSON.parse(manifestBytes) as { path: string };
      let launcherBytes = await fs.readFile(manifest.path, "utf8");
      const deps = {
        ...registeredDeps,
        nodePath: value.deps.nodePath,
        nativeHostPath: value.nativeHostPath,
      };
      await expect(browserExtensionStatus({ ...params, deps })).resolves.toMatchObject({
        manualSetupRequired: false,
        issues: [],
      });
      const registeredTarget = registeredDeps[target];
      if (failure === "relative") {
        const relativeTarget = path.relative(process.cwd(), registeredTarget);
        await fs.access(relativeTarget, fs.constants.X_OK);
        const quoteTarget = (launcherTarget: string) =>
          `'${launcherTarget.replaceAll("'", `'"'"'`)}'`;
        const relativeLauncher = launcherBytes.replace(
          quoteTarget(registeredTarget),
          quoteTarget(relativeTarget),
        );
        expect(relativeLauncher).not.toBe(launcherBytes);
        launcherBytes = relativeLauncher;
        await fs.writeFile(manifest.path, launcherBytes);
      } else if (failure === "missing" || failure === "directory" || failure === "symlink") {
        await fs.rename(registeredTarget, `${registeredTarget}.removed`);
        if (failure === "directory") {
          await fs.mkdir(registeredTarget, { mode: 0o700 });
        } else if (failure === "symlink") {
          await fs.symlink(deps[target], registeredTarget);
        }
      } else {
        await fs.chmod(
          registeredTarget,
          failure === "non-executable" ? 0o600 : failure === "unreadable" ? 0o000 : 0o664,
        );
      }

      const broken = await browserExtensionStatus({ ...params, deps });
      expect(broken.manualSetupRequired).toBe(true);
      const brokenRegistration = broken.registrations.find((entry) => entry.product === "chromium");
      if (!brokenRegistration?.issue) {
        throw new Error("missing Chromium fixture registration issue");
      }
      expect(brokenRegistration).toMatchObject({
        state: "owned",
        extensionIds: registration.extensionIds,
      });
      expect(brokenRegistration.issue).toContain("openclaw browser extension install");
      expect(brokenRegistration.issue.length).toBeLessThan(200);
      expect(broken.issues).toEqual([`Chromium: ${brokenRegistration.issue}`]);
      expect(JSON.stringify(broken)).not.toMatch(/pairingString|token|Bearer|runtime's version/u);
      expect(brokenRegistration.issue).not.toContain(value.root);
      expect(await fs.readFile(registration.manifestPath, "utf8")).toBe(manifestBytes);
      expect(await fs.readFile(manifest.path, "utf8")).toBe(launcherBytes);
      expect(existsSync(executed)).toBe(false);

      if (failure === "non-executable" || failure === "unreadable" || failure === "unsafe-mode") {
        const onProgress = vi.fn();
        const reinstall = await installChromeExtensionBootstrap({
          ...params,
          deps: registeredDeps,
          onProgress,
        });
        expect(reinstall.manualSetupRequired).toBe(true);
        expect(onProgress).not.toHaveBeenCalledWith(
          expect.stringContaining("Native bootstrap is ready"),
        );
        expect(reinstall.issues.join("\n")).toContain("pre-registration refused");
        expect(reinstall.issues.join("\n")).toContain("No native host was pre-registered.");
        expect(reinstall.issues.join("\n")).not.toContain(
          "No existing Chrome-family user-data directory",
        );
        expect(await fs.readFile(registration.manifestPath, "utf8")).toBe(manifestBytes);
        expect(await fs.readFile(manifest.path, "utf8")).toBe(launcherBytes);
      }

      if (recovery === "uninstall") {
        await expect(uninstallChromeExtensionNativeHosts({ deps })).resolves.toEqual({
          removed: [registration.manifestPath, manifest.path],
          refused: [],
          manualRequired: false,
        });
        expect(existsSync(registration.manifestPath)).toBe(false);
        expect(existsSync(manifest.path)).toBe(false);
        return;
      }
      expect((await installChromeExtensionBootstrap({ ...params, deps })).manualSetupRequired).toBe(
        false,
      );
      const repaired = await browserExtensionStatus({ ...params, deps });
      expect(repaired.manualSetupRequired).toBe(false);
      expect(repaired.issues).toEqual([]);
      expect(repaired.registrations).toEqual(before.registrations);
      expect(await fs.readFile(registration.manifestPath, "utf8")).toBe(manifestBytes);
      expect((await fs.stat(registration.manifestPath)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(manifest.path)).mode & 0o777).toBe(0o700);
      expect(existsSync(executed)).toBe(false);
    },
  );

  it("repairs owned hosts even for a product without a discovered extension", async () => {
    const value = await fixture();
    const roots = chromeProductRoots(value.deps);
    const chrome = roots.find((root) => root.product === "chrome");
    const chromium = roots.find((root) => root.product === "chromium");
    if (!chrome || !chromium) {
      throw new Error("missing browser fixture roots");
    }
    await fs.mkdir(chrome.userDataDir, { recursive: true, mode: 0o700 });
    const installed = await installStableChromeExtension(value.bundledDir, value.deps);
    await writeChromePreferences({
      userDataDir: chromium.userDataDir,
      profile: "Default",
      entries: {
        [await predictedId(installed, value.deps.platform)]: { location: 4, path: installed },
      },
    });
    const params = { bundledDir: value.bundledDir, pluginRoot: value.pluginRoot, waitMs: 1_000 };
    const before = await installChromeExtensionBootstrap({ ...params, deps: value.deps });
    expect(before.manualSetupRequired).toBe(false);
    expect(before.registrations.filter((entry) => entry.state === "owned")).toHaveLength(2);
    const nodePath = `${value.deps.nodePath}-replacement`;
    await fs.rename(value.deps.nodePath, nodePath);
    const deps = { ...value.deps, nodePath };
    const broken = await browserExtensionStatus({ ...params, deps });
    expect(broken.manualSetupRequired).toBe(true);
    expect((await installChromeExtensionBootstrap({ ...params, deps })).manualSetupRequired).toBe(
      false,
    );
    const repaired = await browserExtensionStatus({ ...params, deps });
    expect(repaired.manualSetupRequired).toBe(false);
    expect(repaired.registrations).toEqual(before.registrations);
    expect(repaired.issues).toEqual([]);
  });
});

describe("installer option bounds", () => {
  it("accepts bounded waits and rejects unbounded waits", () => {
    expect(normalizeExtensionInstallWaitMs(undefined)).toBe(30_000);
    expect(normalizeExtensionInstallWaitMs("1000")).toBe(1_000);
    expect(normalizeExtensionInstallWaitMs(10_000)).toBe(10_000);
    expect(normalizeExtensionInstallWaitMs("120000")).toBe(120_000);
    expect(() => normalizeExtensionInstallWaitMs(999)).toThrow("--wait-ms");
    expect(() => normalizeExtensionInstallWaitMs(120_001)).toThrow("--wait-ms");
  });

  it.each(["0x1000", "1e4", "+50000", " 50000", "50000 ", "50000\t"])(
    "rejects non-decimal --wait-ms string %j",
    (value) => {
      expect(() => normalizeExtensionInstallWaitMs(value)).toThrow("--wait-ms");
    },
  );

  it("accepts ordinary decimal strings", () => {
    expect(normalizeExtensionInstallWaitMs("10000")).toBe(10_000);
  });
});
