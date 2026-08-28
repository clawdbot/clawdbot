import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateChromeExtensionIdForPath } from "./extension-install-layout.js";

export const FOUNDATION_STORE_ID = "kcdjddhmeafeomebliikmbpblkmkfoig";

export async function predictedId(candidate: string, platform: NodeJS.Platform = process.platform) {
  return generateChromeExtensionIdForPath(await fs.realpath(candidate), platform);
}

export function createExtensionInstallFixtures() {
  const tempRoots: string[] = [];

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
    const nodePath = path.join(root, "bin", "node");
    await fs.mkdir(path.dirname(nodePath), { recursive: true, mode: 0o700 });
    await fs.writeFile(nodePath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const deps = {
      platform,
      homeDir,
      stateDir,
      env: {
        HOME: homeDir,
        LOCALAPPDATA: path.join(homeDir, "AppData", "Local"),
      },
      nativeHostPath,
      // A fixture-owned interpreter keeps assertOwnedPath hermetic: the host's
      // process.execPath can be group/world-writable (GitHub hostedtoolcache),
      // which install correctly refuses and every registration test then fails.
      nodePath,
    };
    return { root, homeDir, stateDir, bundledDir, pluginRoot, nativeHostPath, deps };
  }

  async function cleanup() {
    await Promise.all(
      tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
    );
  }

  return { fixture, cleanup };
}

export async function writeSecurePreferences(params: {
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
