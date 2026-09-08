import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach } from "vitest";
import { generateChromeExtensionIdForPath } from "./extension-install-layout.js";

export const FOUNDATION_STORE_ID = "kcdjddhmeafeomebliikmbpblkmkfoig";

export async function predictedId(candidate: string, platform: NodeJS.Platform = process.platform) {
  return generateChromeExtensionIdForPath(await fs.realpath(candidate), platform);
}

export async function writeChromePreferences(params: {
  userDataDir: string;
  profile: string;
  entries: Record<string, unknown>;
  filename?: "Preferences" | "Secure Preferences";
}) {
  const profileDir = path.join(params.userDataDir, params.profile);
  await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
  const file = path.join(profileDir, params.filename ?? "Preferences");
  await fs.writeFile(file, JSON.stringify({ extensions: { settings: params.entries } }), {
    mode: 0o600,
  });
  return file;
}

export function useNativeHostLaunchFixture() {
  const modesToRestore: Array<{ target: string; mode: number }> = [];
  afterEach(async () => {
    for (const { target, mode } of modesToRestore.splice(0).toReversed()) {
      await fs.chmod(target, mode);
    }
  });
  return async (root: string, nativeHostEntry: string) => {
    const nativeHostPath = await fs.realpath(nativeHostEntry);
    const mode = (await fs.stat(nativeHostPath)).mode & 0o777;
    modesToRestore.push({ target: nativeHostPath, mode });
    await fs.chmod(nativeHostPath, mode & ~0o022);

    // Built entries can inherit group-write permissions, and hosted Node can
    // be shared-library linked. Keep the real interpreter in place behind a
    // private launcher; never loosen the installer's target-permission guard.
    const nodePath = path.join(root, "native-host-node");
    const nodeExecutable = `'${process.execPath.replaceAll("'", `'"'"'`)}'`;
    await fs.writeFile(nodePath, `#!/bin/sh\nexec ${nodeExecutable} "$@"\n`, { mode: 0o700 });
    return { nativeHostPath, nodePath };
  };
}

export function useExtensionInstallFixture() {
  // Register before caller cleanup hooks so Vitest restores mocks before deleting fixtures.
  const tempRoots = useAutoCleanupTempDirTracker(afterEach);
  async function fixture(platform: NodeJS.Platform = "linux") {
    const root = tempRoots.make("openclaw-extension-install-");
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

  return fixture;
}
