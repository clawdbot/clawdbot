import crypto from "node:crypto";
import { constants as fsConstants, type Dirent } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";

const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;
const UNPACKED_MANIFEST_LOCATION = 4;
const OWNED_COPY_MARKER = ".openclaw-owned.json";
const PREFERENCES_MAX_BYTES = 32 * 1024 * 1024;

export type ChromeProduct = "chrome" | "chrome-for-testing" | "chromium";
export type ChromeProductRoot = {
  product: ChromeProduct;
  label: string;
  userDataDir: string;
  nativeManifestDir: string;
};
export type DiscoveredChromeExtension = {
  product: ChromeProduct;
  browser: string;
  userDataDir: string;
  profile: string;
  /** Source backing file, either Preferences or Secure Preferences. */
  securePreferencesPath: string;
  extensionId: string;
  extensionPath: string;
};
export type DiscoveredChromeStoreExtension = Omit<DiscoveredChromeExtension, "extensionPath"> & {
  /** Chrome's recorded state is not proof of an authenticated relay connection. */
  enabled: boolean;
  awaitingApproval: boolean;
};
export type ExtensionInstallDeps = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  homeDir?: string;
  nodePath?: string;
  nativeHostPath?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/** Chromium crx_file::id_util::GenerateIdForPath for a canonical absolute path. */
export function generateChromeExtensionIdForPath(
  canonicalPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const isAbsolute =
    platform === "win32" ? path.win32.isAbsolute(canonicalPath) : path.isAbsolute(canonicalPath);
  if (!isAbsolute) {
    throw new Error("Chrome extension ID paths must be canonical absolute paths");
  }
  let nativePath = canonicalPath;
  if (platform === "win32" && /^[a-z]:/u.test(nativePath)) {
    nativePath = `${nativePath[0]?.toUpperCase()}${nativePath.slice(1)}`;
  }
  const bytes = Buffer.from(nativePath, platform === "win32" ? "utf16le" : "utf8");
  const hexadecimal = crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 32);
  return hexadecimal.replace(/[0-9a-f]/gu, (nibble) =>
    String.fromCharCode("a".charCodeAt(0) + Number.parseInt(nibble, 16)),
  );
}

function homeDirectory(deps: ExtensionInstallDeps): string {
  const value = deps.homeDir ?? deps.env?.HOME ?? deps.env?.USERPROFILE ?? os.homedir();
  if (!value.trim()) {
    throw new Error("Could not resolve the user home directory.");
  }
  return path.resolve(value);
}

/** Chromium-derived default user-data and user native-host roots. */
export function chromeProductRoots(deps: ExtensionInstallDeps = {}): ChromeProductRoot[] {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const home = homeDirectory({ ...deps, env });
  if (platform === "darwin") {
    const appSupport = path.join(home, "Library", "Application Support");
    const testingData = path.join(appSupport, "Google", "Chrome for Testing");
    return [
      {
        product: "chrome",
        label: "Google Chrome",
        userDataDir: path.join(appSupport, "Google", "Chrome"),
        nativeManifestDir: path.join(appSupport, "Google", "Chrome", "NativeMessagingHosts"),
      },
      {
        product: "chrome-for-testing",
        label: "Google Chrome for Testing",
        userDataDir: testingData,
        nativeManifestDir: path.join(testingData, "NativeMessagingHosts"),
      },
      // Chromium derives this root from user data; Chrome's public table
      // currently documents the no-space spelling. Cover both until aligned.
      {
        product: "chrome-for-testing",
        label: "Google Chrome for Testing (documented host root)",
        userDataDir: testingData,
        nativeManifestDir: path.join(
          appSupport,
          "Google",
          "ChromeForTesting",
          "NativeMessagingHosts",
        ),
      },
      {
        product: "chromium",
        label: "Chromium",
        userDataDir: path.join(appSupport, "Chromium"),
        nativeManifestDir: path.join(appSupport, "Chromium", "NativeMessagingHosts"),
      },
    ];
  }
  if (platform === "linux") {
    const configHome = path.resolve(
      env.CHROME_CONFIG_HOME?.trim() || env.XDG_CONFIG_HOME?.trim() || path.join(home, ".config"),
    );
    const roots: Array<[ChromeProduct, string, string]> = [
      ["chrome", "Google Chrome", "google-chrome"],
      ["chrome-for-testing", "Google Chrome for Testing", "google-chrome-for-testing"],
      ["chromium", "Chromium", "chromium"],
    ];
    return roots.map(([product, label, basename]) => ({
      product: product as ChromeProduct,
      label,
      userDataDir: path.join(configHome, basename),
      nativeManifestDir: path.join(configHome, basename, "NativeMessagingHosts"),
    }));
  }
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim();
    if (!localAppData) {
      return [];
    }
    const roots: Array<[ChromeProduct, string, string]> = [
      ["chrome", "Google Chrome", path.join("Google", "Chrome", "User Data")],
      [
        "chrome-for-testing",
        "Google Chrome for Testing",
        path.join("Google", "Chrome for Testing", "User Data"),
      ],
      ["chromium", "Chromium", path.join("Chromium", "User Data")],
    ];
    return roots.map(([product, label, suffix]) => ({
      product: product as ChromeProduct,
      label,
      userDataDir: path.join(localAppData, suffix),
      nativeManifestDir: "",
    }));
  }
  return [];
}

export function stableChromeExtensionDir(deps: ExtensionInstallDeps = {}): string {
  return path.join(
    path.resolve(deps.stateDir ?? resolveStateDir(deps.env)),
    "browser",
    "chrome-extension",
  );
}

export async function pathInfo(
  target: string,
): Promise<Awaited<ReturnType<typeof fs.lstat>> | null> {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function assertOwnedPath(
  target: string,
  kind: "file" | "directory",
  policy: { allowRootOwner?: boolean } = {},
): Promise<void> {
  const info = await fs.lstat(target);
  if (info.isSymbolicLink() || (kind === "file" ? !info.isFile() : !info.isDirectory())) {
    throw new Error(`Unsafe ${kind} at ${target}`);
  }
  if (process.platform !== "win32") {
    const uid = process.getuid?.();
    const ownerAllowed =
      uid === undefined || info.uid === uid || (policy.allowRootOwner === true && info.uid === 0);
    if (!ownerAllowed) {
      throw new Error(`Refusing foreign owner at ${target}`);
    }
    if ((info.mode & 0o022) !== 0) {
      throw new Error(`Refusing group/world-writable path at ${target}`);
    }
  }
  if ((await fs.realpath(target)) !== path.resolve(target)) {
    throw new Error(`Refusing non-canonical path at ${target}`);
  }
}

export async function ensurePrivateDirectory(target: string): Promise<void> {
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  await assertOwnedPath(target, "directory");
  if (process.platform !== "win32") {
    await fs.chmod(target, 0o700);
  }
}

export async function inspectInstalledCopy(
  target: string,
): Promise<{ present: boolean; owned: boolean }> {
  if (!(await pathInfo(target))) {
    return { present: false, owned: false };
  }
  await assertOwnedPath(target, "directory");
  const markerPath = path.join(target, OWNED_COPY_MARKER);
  try {
    await assertOwnedPath(markerPath, "file");
    const marker: unknown = JSON.parse(await fs.readFile(markerPath, "utf8"));
    return {
      present: true,
      owned:
        Boolean(marker) &&
        typeof marker === "object" &&
        !Array.isArray(marker) &&
        (marker as { v?: unknown }).v === 1,
    };
  } catch {
    return { present: true, owned: false };
  }
}

async function copyRuntimeTree(source: string, target: string): Promise<void> {
  await ensurePrivateDirectory(target);
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const skipped =
      /(?:sidepanel|copilot|page-share)/iu.test(entry.name) ||
      entry.name.endsWith(".test.ts") ||
      entry.name.endsWith(".test-support.ts") ||
      entry.name.endsWith(".test-harness.ts") ||
      entry.name.endsWith(".d.ts");
    if (skipped) {
      continue;
    }
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Refusing symlink in bundled Chrome extension: ${sourcePath}`);
    }
    if (entry.isDirectory()) {
      await copyRuntimeTree(sourcePath, targetPath);
    } else if (entry.isFile()) {
      await fs.copyFile(sourcePath, targetPath, fsConstants.COPYFILE_EXCL);
      if (process.platform !== "win32") {
        await fs.chmod(targetPath, 0o600);
      }
    }
  }
}

/** Copy/update the bundled extension with rollback-safe same-directory renames. */
export async function installStableChromeExtension(
  bundledDir: string,
  deps: ExtensionInstallDeps = {},
): Promise<string> {
  const source = await fs.realpath(path.resolve(bundledDir));
  await assertOwnedPath(source, "directory", { allowRootOwner: true });
  const target = stableChromeExtensionDir(deps);
  await ensurePrivateDirectory(path.resolve(deps.stateDir ?? resolveStateDir(deps.env)));
  await ensurePrivateDirectory(path.dirname(target));
  const existing = await inspectInstalledCopy(target);
  if (existing.present && !existing.owned) {
    throw new Error(`Refusing to overwrite foreign Chrome extension directory: ${target}`);
  }
  const suffix = `${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  const temporary = `${target}.tmp-${suffix}`;
  const previous = `${target}.previous-${suffix}`;
  try {
    await copyRuntimeTree(source, temporary);
    await fs.writeFile(
      path.join(temporary, OWNED_COPY_MARKER),
      `${JSON.stringify({ v: 1, owner: "openclaw" })}\n`,
      { mode: 0o600, flag: "wx" },
    );
    if (existing.present) {
      await fs.rename(target, previous);
    }
    try {
      await fs.rename(temporary, target);
    } catch (error) {
      if (existing.present) {
        await fs.rename(previous, target).catch(() => undefined);
      }
      throw error;
    }
    if (existing.present) {
      await fs.rm(previous, { recursive: true, force: true });
    }
    return await fs.realpath(target);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
  }
}

function comparablePath(value: string, platform: NodeJS.Platform): string {
  const resolved = path.resolve(value);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function approvedRealpaths(paths: readonly string[]): Promise<string[]> {
  const resolved = await Promise.all(
    paths.map(async (candidate) => await fs.realpath(candidate).catch(() => null)),
  );
  return [...new Set(resolved.filter((value): value is string => value !== null))];
}

/** Discover exact Store identity separately from approved unpacked path records. */
export async function discoverChromeExtensionIds(params: {
  approvedDirs: readonly string[];
  storeExtensionId?: string;
  deps?: ExtensionInstallDeps;
}): Promise<{
  discovered: DiscoveredChromeExtension[];
  storeDiscovered: DiscoveredChromeStoreExtension[];
  issues: string[];
  identityMismatches: string[];
}> {
  const deps = params.deps ?? {};
  const platform = deps.platform ?? process.platform;
  const approved = new Set(
    (await approvedRealpaths(params.approvedDirs)).map((value) => comparablePath(value, platform)),
  );
  const discovered: DiscoveredChromeExtension[] = [];
  const storeDiscovered: DiscoveredChromeStoreExtension[] = [];
  const issues: string[] = [];
  const identityMismatches: string[] = [];
  for (const root of chromeProductRoots(deps)) {
    if (!(await pathInfo(root.userDataDir))) {
      continue;
    }
    try {
      await assertOwnedPath(root.userDataDir, "directory");
    } catch (error) {
      issues.push(`${root.label}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    let profiles: Dirent[];
    try {
      profiles = await fs.readdir(root.userDataDir, { withFileTypes: true });
    } catch (error) {
      issues.push(`${root.label}: could not list profiles (${String(error)})`);
      continue;
    }
    for (const profileEntry of profiles) {
      if (!profileEntry.isDirectory() || profileEntry.isSymbolicLink()) {
        continue;
      }
      const profileDir = path.join(root.userDataDir, profileEntry.name);
      // Chromium partitions extension settings by enforcement policy across both stores.
      for (const filename of ["Preferences", "Secure Preferences"]) {
        const preferencesPath = path.join(profileDir, filename);
        const preferencesInfo = await pathInfo(preferencesPath);
        if (!preferencesInfo) {
          continue;
        }
        try {
          await assertOwnedPath(profileDir, "directory");
          await assertOwnedPath(preferencesPath, "file");
          if (preferencesInfo.size > PREFERENCES_MAX_BYTES) {
            throw new Error(`${filename} exceeds the 32 MiB inspection limit`);
          }
          const preferences: unknown = JSON.parse(await fs.readFile(preferencesPath, "utf8"));
          const settings = (preferences as { extensions?: { settings?: unknown } })?.extensions
            ?.settings;
          if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
            continue;
          }
          for (const [extensionId, rawEntry] of Object.entries(settings)) {
            if (
              !EXTENSION_ID_PATTERN.test(extensionId) ||
              !rawEntry ||
              typeof rawEntry !== "object"
            ) {
              continue;
            }
            const entry = rawEntry as {
              from_webstore?: unknown;
              location?: unknown;
              path?: unknown;
              state?: unknown;
              disable_reasons?: unknown;
            };
            if (
              extensionId === params.storeExtensionId &&
              entry.from_webstore === true &&
              entry.location !== UNPACKED_MANIFEST_LOCATION
            ) {
              // Current Chrome stores a reason list; older profiles used a bitmask
              // plus state (ENABLED = 1). External-install approval is bit 13.
              const reasons = entry.disable_reasons;
              const enabled =
                (entry.state === undefined || entry.state === 1) &&
                (reasons === undefined ||
                  reasons === 0 ||
                  (Array.isArray(reasons) && reasons.length === 0));
              const awaitingApproval = Array.isArray(reasons)
                ? reasons.includes(8_192)
                : typeof reasons === "number" && (reasons & 8_192) !== 0;
              storeDiscovered.push({
                product: root.product,
                browser: root.label,
                userDataDir: root.userDataDir,
                profile: profileEntry.name,
                securePreferencesPath: preferencesPath,
                extensionId,
                enabled,
                awaitingApproval,
              });
              continue;
            }
            if (entry.location !== UNPACKED_MANIFEST_LOCATION || typeof entry.path !== "string") {
              continue;
            }
            const recordedPath = path.isAbsolute(entry.path)
              ? entry.path
              : path.join(profileDir, "Extensions", entry.path);
            const canonicalPath = await fs.realpath(recordedPath).catch(() => null);
            if (!canonicalPath || !approved.has(comparablePath(canonicalPath, platform))) {
              continue;
            }
            const predictedId = generateChromeExtensionIdForPath(canonicalPath, platform);
            if (extensionId !== predictedId) {
              const issue = `${root.label} profile ${profileEntry.name}: unpacked extension ID ${extensionId} does not match predicted ID ${predictedId} for ${canonicalPath}`;
              issues.push(issue);
              identityMismatches.push(issue);
              continue;
            }
            discovered.push({
              product: root.product,
              browser: root.label,
              userDataDir: root.userDataDir,
              profile: profileEntry.name,
              securePreferencesPath: preferencesPath,
              extensionId,
              extensionPath: canonicalPath,
            });
          }
        } catch (error) {
          issues.push(
            `${root.label} profile ${profileEntry.name} (${filename}): ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  }
  const unique = new Map(
    discovered.map((entry) => [
      `${entry.product}\0${entry.profile}\0${entry.extensionId}\0${entry.extensionPath}`,
      entry,
    ]),
  );
  const uniqueStore = new Map(
    storeDiscovered.map((entry) => [
      `${entry.product}\0${entry.profile}\0${entry.extensionId}`,
      entry,
    ]),
  );
  return {
    discovered: [...unique.values()].toSorted((a, b) =>
      `${a.product}/${a.profile}/${a.extensionId}`.localeCompare(
        `${b.product}/${b.profile}/${b.extensionId}`,
      ),
    ),
    storeDiscovered: [...uniqueStore.values()].toSorted((a, b) =>
      `${a.product}/${a.profile}/${a.extensionId}`.localeCompare(
        `${b.product}/${b.profile}/${b.extensionId}`,
      ),
    ),
    issues,
    identityMismatches,
  };
}
