import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import {
  assertOwnedPath,
  chromeProductRoots,
  type ChromeProduct,
  type ChromeProductRoot,
  discoverChromeExtensionIds,
  type DiscoveredChromeExtension,
  type DiscoveredChromeStoreExtension,
  ensurePrivateDirectory,
  type ExtensionInstallDeps,
  generateChromeExtensionIdForPath,
  inspectInstalledCopy,
  installStableChromeExtension,
  pathInfo,
  stableChromeExtensionDir,
} from "./extension-install-layout.js";
import { BROWSER_NATIVE_HOST_NAME } from "./extension-native-host.js";

const OWNED_LAUNCHER_MARKER = "# OpenClaw native messaging bootstrap v1";
const BROWSER_EXTENSION_INSTALL_WAIT_DEFAULT_MS = 30_000;
const BROWSER_EXTENSION_INSTALL_WAIT_MIN_MS = 1_000;
const BROWSER_EXTENSION_INSTALL_WAIT_MAX_MS = 120_000;
const NATIVE_HOST_DESCRIPTION = "OpenClaw browser extension bootstrap";
// This exact Foundation Store identity is trusted as a caller, never as proof
// that an arbitrary extension path is OpenClaw-owned.
const FOUNDATION_CHROME_WEB_STORE_EXTENSION_ID = "kcdjddhmeafeomebliikmbpblkmkfoig";
export const FOUNDATION_CHROME_WEB_STORE_URL = `https://chromewebstore.google.com/detail/openclaw/${FOUNDATION_CHROME_WEB_STORE_EXTENSION_ID}`;

type NativeHostRegistrationStatus = {
  product: ChromeProduct;
  browser: string;
  manifestPath: string;
  extensionIds: string[];
  state: "missing" | "owned" | "foreign" | "invalid";
  issue?: string;
};

type BrowserExtensionStatus = {
  platform: NodeJS.Platform;
  platformSupport: "automatic" | "manual_required";
  installedCopy: { path: string; present: boolean; owned: boolean };
  bundledPath: string;
  approvedPaths: string[];
  discovered: DiscoveredChromeExtension[];
  storeDiscovered: DiscoveredChromeStoreExtension[];
  registrations: NativeHostRegistrationStatus[];
  manualSetupRequired: boolean;
  issues: string[];
};

function nativeMessagingRoot(deps: ExtensionInstallDeps = {}): string {
  return path.join(resolveInstallStateDir(deps), "browser", "native-messaging");
}

function resolveInstallStateDir(deps: ExtensionInstallDeps): string {
  return path.resolve(deps.stateDir ?? resolveStateDir(deps.env));
}

function resolveInstallConfigPath(deps: ExtensionInstallDeps): string | undefined {
  const env = deps.env ?? process.env;
  const explicit = env.OPENCLAW_CONFIG_PATH?.trim();
  return explicit ? resolveStateDir({ ...env, OPENCLAW_STATE_DIR: explicit }) : undefined;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function resolveNativeHostPath(pluginRoot: string, explicit?: string): Promise<string> {
  if (explicit) {
    return await fs.realpath(explicit);
  }
  const resolvedPluginRoot = path.resolve(pluginRoot);
  const candidates = [path.join(resolvedPluginRoot, "native-host-entry.js")];
  let cursor = resolvedPluginRoot;
  for (;;) {
    candidates.push(path.join(cursor, "dist", "extensions", "browser", "native-host-entry.js"));
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }
  for (const candidate of candidates) {
    if (await pathInfo(candidate)) {
      return await fs.realpath(candidate);
    }
  }
  throw new Error("Could not resolve the built browser native-host entrypoint; run pnpm build.");
}

function launcherPathForManifest(manifestPath: string, deps: ExtensionInstallDeps): string {
  const suffix = crypto.createHash("sha256").update(manifestPath).digest("hex").slice(0, 16);
  return path.join(nativeMessagingRoot(deps), `${BROWSER_NATIVE_HOST_NAME}.${suffix}.sh`);
}

function expectedExtensionIds(extensionIds: string[]): string[] {
  return [...new Set([...extensionIds, FOUNDATION_CHROME_WEB_STORE_EXTENSION_ID])].toSorted();
}

function expectedOriginsForExtensionIds(extensionIds: string[]): string[] {
  return expectedExtensionIds(extensionIds).map(
    (extensionId) => `chrome-extension://${extensionId}/`,
  );
}

function pathDerivedExtensionIds(extensionIds: string[]): string[] {
  return extensionIds.filter(
    (extensionId) => extensionId !== FOUNDATION_CHROME_WEB_STORE_EXTENSION_ID,
  );
}

function isSafeOriginMigration(existingIds: string[], desiredPathIds: string[]): boolean {
  const existingPathIds = pathDerivedExtensionIds(existingIds).toSorted();
  const desiredIds = [...new Set(desiredPathIds)].toSorted();
  if (JSON.stringify(existingPathIds) === JSON.stringify(desiredIds)) {
    return true;
  }
  const removed = existingPathIds.filter((id) => !desiredIds.includes(id));
  const added = desiredIds.filter((id) => !existingPathIds.includes(id));
  const overlap = existingPathIds.some((id) => desiredIds.includes(id));
  return (
    existingPathIds.length === desiredIds.length &&
    removed.length === 1 &&
    added.length === 1 &&
    overlap
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function launcherMatchesOrigins(params: {
  content: string;
  manifestPath: string;
  launcherPath: string;
  origins: string[];
}): boolean {
  const quotedValue = String.raw`'(?:[^'\r\n]|'"'"')*'`;
  const command = [
    quotedValue,
    quotedValue,
    escapeRegExp(shellQuote("--manifest")),
    escapeRegExp(shellQuote(params.manifestPath)),
    escapeRegExp(shellQuote("--launcher")),
    escapeRegExp(shellQuote(params.launcherPath)),
    ...params.origins.flatMap((origin) => [
      escapeRegExp(shellQuote("--expected-origin")),
      escapeRegExp(shellQuote(origin)),
    ]),
  ].join(" ");
  const pattern = new RegExp(
    `^#!/bin/sh\\n${escapeRegExp(OWNED_LAUNCHER_MARKER)}\\nexport OPENCLAW_STATE_DIR=${quotedValue}\\n(?:export OPENCLAW_CONFIG_PATH=${quotedValue}\\n)?exec ${command} "\\$@"\\n$`,
    "u",
  );
  return pattern.test(params.content);
}

async function assertPrivateNativeHostFile(
  target: string,
  executable: boolean,
  platform: NodeJS.Platform,
): Promise<void> {
  await assertOwnedPath(target, "file");
  if (platform === "win32") {
    return;
  }
  const mode = (await fs.lstat(target)).mode & 0o777;
  if ((mode & 0o077) !== 0 || (executable && (mode & 0o100) === 0)) {
    throw new Error("native host file has unsafe mode");
  }
}

async function resolveLauncherInstall(params: {
  manifestPath: string;
  pluginRoot: string;
  extensionIds: string[];
  deps: ExtensionInstallDeps;
}): Promise<{ path: string; content: string }> {
  const launcherPath = launcherPathForManifest(params.manifestPath, params.deps);
  const nodePath = await fs.realpath(params.deps.nodePath ?? process.execPath);
  const nativeHostPath = await resolveNativeHostPath(params.pluginRoot, params.deps.nativeHostPath);
  await assertOwnedPath(nodePath, "file", { allowRootOwner: true });
  await assertOwnedPath(nativeHostPath, "file", { allowRootOwner: true });
  const command = [
    nodePath,
    nativeHostPath,
    "--manifest",
    params.manifestPath,
    "--launcher",
    launcherPath,
    ...expectedOriginsForExtensionIds(params.extensionIds).flatMap((origin) => [
      "--expected-origin",
      origin,
    ]),
  ];
  const configPath = resolveInstallConfigPath(params.deps);
  return {
    path: launcherPath,
    content: [
      "#!/bin/sh",
      OWNED_LAUNCHER_MARKER,
      `export OPENCLAW_STATE_DIR=${shellQuote(resolveInstallStateDir(params.deps))}`,
      ...(configPath ? [`export OPENCLAW_CONFIG_PATH=${shellQuote(configPath)}`] : []),
      `exec ${command.map(shellQuote).join(" ")} "$@"`,
      "",
    ].join("\n"),
  };
}

async function inspectRegistration(
  root: ChromeProductRoot,
  deps: ExtensionInstallDeps,
  expectedPathExtensionIds?: string[],
): Promise<NativeHostRegistrationStatus> {
  const manifestPath = path.join(root.nativeManifestDir, `${BROWSER_NATIVE_HOST_NAME}.json`);
  if (!(await pathInfo(manifestPath))) {
    return {
      product: root.product,
      browser: root.label,
      manifestPath,
      extensionIds: [],
      state: "missing",
    };
  }
  try {
    await assertPrivateNativeHostFile(manifestPath, false, deps.platform ?? process.platform);
    const parsed: unknown = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("manifest is not an object");
    }
    const manifest = parsed as { name?: unknown; path?: unknown; allowed_origins?: unknown };
    const expectedLauncher = launcherPathForManifest(manifestPath, deps);
    const origins = Array.isArray(manifest.allowed_origins) ? manifest.allowed_origins : [];
    const ids = origins.flatMap((origin) => {
      const match = /^chrome-extension:\/\/([a-p]{32})\/$/.exec(String(origin));
      return match?.[1] ? [match[1]] : [];
    });
    if (manifest.name !== BROWSER_NATIVE_HOST_NAME || manifest.path !== expectedLauncher) {
      return {
        product: root.product,
        browser: root.label,
        manifestPath,
        extensionIds: ids,
        state: "foreign",
        issue: "same host name is registered to a foreign manifest or launcher",
      };
    }
    const exactKeys = ["name", "description", "path", "type", "allowed_origins"];
    const stringOrigins = origins.filter((origin): origin is string => typeof origin === "string");
    const validOrigins =
      origins.length > 0 &&
      origins.length === stringOrigins.length &&
      stringOrigins.every((origin) => /^chrome-extension:\/\/[a-p]{32}\/$/u.test(origin)) &&
      new Set(origins).size === origins.length;
    const canonicalOrigins = [...stringOrigins].toSorted();
    const expectedOrigins = expectedPathExtensionIds
      ? expectedOriginsForExtensionIds(expectedPathExtensionIds)
      : null;
    if (
      Object.keys(manifest).length !== exactKeys.length ||
      !exactKeys.every((key) => Object.hasOwn(manifest, key)) ||
      (manifest as { description?: unknown }).description !== NATIVE_HOST_DESCRIPTION ||
      (manifest as { type?: unknown }).type !== "stdio" ||
      !validOrigins ||
      JSON.stringify(origins) !== JSON.stringify(canonicalOrigins) ||
      (expectedOrigins !== null && JSON.stringify(origins) !== JSON.stringify(expectedOrigins))
    ) {
      throw new Error("native host manifest does not contain exact allowed origins");
    }
    await assertPrivateNativeHostFile(expectedLauncher, true, deps.platform ?? process.platform);
    const launcherMatches = launcherMatchesOrigins({
      content: await fs.readFile(expectedLauncher, "utf8"),
      manifestPath,
      launcherPath: expectedLauncher,
      origins: stringOrigins,
    });
    if (!launcherMatches) {
      throw new Error("native host launcher and manifest origins do not match");
    }
    return {
      product: root.product,
      browser: root.label,
      manifestPath,
      extensionIds: ids.toSorted(),
      state: "owned",
    };
  } catch (error) {
    return {
      product: root.product,
      browser: root.label,
      manifestPath,
      extensionIds: [],
      state: "invalid",
      issue: error instanceof Error ? error.message : String(error),
    };
  }
}

async function installRegistration(params: {
  root: ChromeProductRoot;
  extensionIds: string[];
  pluginRoot: string;
  deps: ExtensionInstallDeps;
}): Promise<NativeHostRegistrationStatus> {
  const { root, extensionIds, deps } = params;
  const manifestPath = path.join(root.nativeManifestDir, `${BROWSER_NATIVE_HOST_NAME}.json`);
  const existing = await inspectRegistration(root, deps);
  if (existing.state === "foreign" || existing.state === "invalid") {
    throw new Error(`Refusing to overwrite ${existing.state} native host: ${manifestPath}`);
  }
  const desiredOrigins = expectedOriginsForExtensionIds(extensionIds);
  if (
    existing.state === "owned" &&
    JSON.stringify(existing.extensionIds.map((id) => `chrome-extension://${id}/`)) !==
      JSON.stringify(desiredOrigins) &&
    !isSafeOriginMigration(existing.extensionIds, extensionIds)
  ) {
    throw new Error(`Refusing to overwrite owned native host with unexpected allowed origins`);
  }
  await ensurePrivateDirectory(nativeMessagingRoot(deps));
  await ensurePrivateDirectory(root.nativeManifestDir);
  const launcher = await resolveLauncherInstall({
    manifestPath,
    pluginRoot: params.pluginRoot,
    extensionIds,
    deps,
  });
  const launcherPath = launcher.path;
  if (await pathInfo(launcherPath)) {
    await assertOwnedPath(launcherPath, "file");
    const existingLauncher = await fs.readFile(launcherPath, "utf8");
    if (!existingLauncher.includes(OWNED_LAUNCHER_MARKER)) {
      throw new Error(`Refusing to overwrite foreign native host launcher: ${launcherPath}`);
    }
    if (existingLauncher !== launcher.content) {
      const replacement = `${launcherPath}.tmp-${process.pid}`;
      await fs.writeFile(replacement, launcher.content, { mode: 0o700, flag: "wx" });
      await fs.rename(replacement, launcherPath);
    }
  } else {
    await fs.writeFile(launcherPath, launcher.content, { mode: 0o700, flag: "wx" });
  }
  if (process.platform !== "win32") {
    await fs.chmod(launcherPath, 0o700);
  }
  const manifest = {
    name: BROWSER_NATIVE_HOST_NAME,
    description: NATIVE_HOST_DESCRIPTION,
    path: launcherPath,
    type: "stdio",
    allowed_origins: expectedOriginsForExtensionIds(extensionIds),
  };
  const temporary = `${manifestPath}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  await fs.writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  await fs.rename(temporary, manifestPath);
  if (process.platform !== "win32") {
    await fs.chmod(manifestPath, 0o600);
  }
  return await inspectRegistration(root, deps, extensionIds);
}

async function approvedInstallRealpaths(installed: string, bundled: string): Promise<string[]> {
  const installedPath = await fs.realpath(installed);
  const bundledPath = await fs.realpath(bundled);
  await assertOwnedPath(installedPath, "directory");
  await assertOwnedPath(bundledPath, "directory", { allowRootOwner: true });
  return [...new Set([installedPath, bundledPath])];
}

export function normalizeExtensionInstallWaitMs(value: unknown): number {
  if (value === undefined) {
    return BROWSER_EXTENSION_INSTALL_WAIT_DEFAULT_MS;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (
    !Number.isInteger(parsed) ||
    parsed < BROWSER_EXTENSION_INSTALL_WAIT_MIN_MS ||
    parsed > BROWSER_EXTENSION_INSTALL_WAIT_MAX_MS
  ) {
    throw new Error(
      `--wait-ms must be an integer from ${BROWSER_EXTENSION_INSTALL_WAIT_MIN_MS} to ${BROWSER_EXTENSION_INSTALL_WAIT_MAX_MS}`,
    );
  }
  return parsed;
}

/** Copy, pre-register Store plus deterministic IDs, then verify Chrome's recorded identity. */
export async function installChromeExtensionBootstrap(params: {
  bundledDir: string;
  pluginRoot: string;
  waitMs?: number;
  deps?: ExtensionInstallDeps;
  onProgress?: (message: string) => void;
}): Promise<BrowserExtensionStatus> {
  const deps = params.deps ?? {};
  const platform = deps.platform ?? process.platform;
  const installed = await installStableChromeExtension(params.bundledDir, deps);
  if (platform === "win32") {
    return await browserExtensionStatus({ bundledDir: params.bundledDir, deps });
  }
  const approvedPaths = await approvedInstallRealpaths(installed, params.bundledDir);
  const predictedIds = [
    ...new Set(
      approvedPaths.map((candidate) => generateChromeExtensionIdForPath(candidate, platform)),
    ),
  ].toSorted();
  const preRegistrationIssues: string[] = [];
  let preRegisteredRoots = 0;
  for (const root of chromeProductRoots(deps)) {
    if (!(await pathInfo(root.userDataDir))) {
      continue;
    }
    try {
      await assertOwnedPath(root.userDataDir, "directory");
      await installRegistration({
        root,
        extensionIds: predictedIds,
        pluginRoot: params.pluginRoot,
        deps,
      });
      preRegisteredRoots += 1;
      params.onProgress?.(`Pre-registered the native host for ${root.label}.`);
    } catch (error) {
      preRegistrationIssues.push(
        `${root.label}: native host pre-registration refused (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
  if (preRegisteredRoots > 0) {
    params.onProgress?.(
      `Native bootstrap is ready. Add OpenClaw from the Chrome Web Store: ${FOUNDATION_CHROME_WEB_STORE_URL}. For development, load unpacked from ${installed}.`,
    );
  } else {
    preRegistrationIssues.push(
      "No existing Chrome-family user-data directory was available for native host pre-registration. Launch Chrome, then run install again before loading the extension.",
    );
  }
  const waitMs = normalizeExtensionInstallWaitMs(params.waitMs);
  const now = deps.now ?? Date.now;
  const sleep =
    deps.sleep ??
    ((ms: number) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      }));
  const deadline = now() + waitMs;
  let discovery = await discoverChromeExtensionIds({
    approvedDirs: approvedPaths,
    storeExtensionId: FOUNDATION_CHROME_WEB_STORE_EXTENSION_ID,
    deps,
  });
  let announcedWait = false;
  while (
    discovery.discovered.length === 0 &&
    discovery.storeDiscovered.length === 0 &&
    now() < deadline
  ) {
    if (!announcedWait) {
      params.onProgress?.("Waiting for Chrome to verify the OpenClaw extension…");
      announcedWait = true;
    }
    await sleep(Math.min(500, Math.max(1, deadline - now())));
    discovery = await discoverChromeExtensionIds({
      approvedDirs: approvedPaths,
      storeExtensionId: FOUNDATION_CHROME_WEB_STORE_EXTENSION_ID,
      deps,
    });
  }
  const status = await browserExtensionStatus({ bundledDir: params.bundledDir, deps });
  return {
    ...status,
    issues: [...new Set([...preRegistrationIssues, ...status.issues])],
  };
}

/** Read-only extension copy, profile discovery, and native registration report. */
export async function browserExtensionStatus(params: {
  bundledDir: string;
  deps?: ExtensionInstallDeps;
}): Promise<BrowserExtensionStatus> {
  const deps = params.deps ?? {};
  const platform = deps.platform ?? process.platform;
  const installedPath = stableChromeExtensionDir(deps);
  const installedCopy = await inspectInstalledCopy(installedPath);
  const bundledPath = await fs.realpath(params.bundledDir);
  await assertOwnedPath(bundledPath, "directory", { allowRootOwner: true });
  const approvedPaths = installedCopy.owned
    ? await approvedInstallRealpaths(installedPath, bundledPath)
    : [bundledPath];
  const discovery = await discoverChromeExtensionIds({
    approvedDirs: approvedPaths,
    storeExtensionId: FOUNDATION_CHROME_WEB_STORE_EXTENSION_ID,
    deps,
  });
  const predictedIds = [
    ...new Set(
      approvedPaths.map((candidate) => generateChromeExtensionIdForPath(candidate, platform)),
    ),
  ].toSorted();
  const registrations =
    platform === "win32"
      ? []
      : await Promise.all(
          chromeProductRoots(deps).map((root) => inspectRegistration(root, deps, predictedIds)),
        );
  const missingRegistration = chromeProductRoots(deps).some((root) => {
    const productWasDiscovered =
      discovery.discovered.some((entry) => entry.product === root.product) ||
      discovery.storeDiscovered.some((entry) => entry.product === root.product);
    if (!productWasDiscovered) {
      return false;
    }
    const manifestPath = path.join(root.nativeManifestDir, `${BROWSER_NATIVE_HOST_NAME}.json`);
    const registration = registrations.find((entry) => entry.manifestPath === manifestPath);
    return (
      registration?.state !== "owned" ||
      JSON.stringify(registration.extensionIds) !==
        JSON.stringify(expectedExtensionIds(predictedIds))
    );
  });
  return {
    platform,
    platformSupport: platform === "win32" ? "manual_required" : "automatic",
    installedCopy: { path: installedPath, ...installedCopy },
    bundledPath: path.resolve(params.bundledDir),
    approvedPaths,
    discovered: discovery.discovered,
    storeDiscovered: discovery.storeDiscovered,
    registrations,
    manualSetupRequired:
      platform === "win32" ||
      (installedCopy.present && !installedCopy.owned) ||
      (discovery.discovered.length === 0 && discovery.storeDiscovered.length === 0) ||
      discovery.identityMismatches.length > 0 ||
      missingRegistration,
    issues: [
      ...(installedCopy.present && !installedCopy.owned
        ? [`Chrome extension copy is not OpenClaw-owned: ${installedPath}`]
        : []),
      ...discovery.issues,
      ...registrations.flatMap((entry) =>
        entry.issue ? [`${entry.browser}: ${entry.issue}`] : [],
      ),
    ],
  };
}

/** Remove only registrations and launchers that carry OpenClaw ownership. */
export async function uninstallChromeExtensionNativeHosts(
  params: { deps?: ExtensionInstallDeps } = {},
): Promise<{ removed: string[]; refused: string[]; manualRequired: boolean }> {
  const deps = params.deps ?? {};
  if ((deps.platform ?? process.platform) === "win32") {
    return { removed: [], refused: [], manualRequired: true };
  }
  const removed: string[] = [];
  const refused: string[] = [];
  for (const root of chromeProductRoots(deps)) {
    const status = await inspectRegistration(root, deps);
    if (status.state === "missing") {
      continue;
    }
    if (status.state !== "owned") {
      refused.push(status.manifestPath);
      continue;
    }
    const launcherPath = launcherPathForManifest(status.manifestPath, deps);
    const launcher = await pathInfo(launcherPath);
    if (launcher) {
      await assertOwnedPath(launcherPath, "file");
      if (!(await fs.readFile(launcherPath, "utf8")).includes(OWNED_LAUNCHER_MARKER)) {
        refused.push(launcherPath);
        continue;
      }
    }
    await fs.unlink(status.manifestPath);
    removed.push(status.manifestPath);
    if (launcher) {
      await fs.unlink(launcherPath);
      removed.push(launcherPath);
    }
  }
  return { removed, refused, manualRequired: false };
}

/** Resolve the installed stable copy when present, bundled source otherwise. */
export async function resolveChromeExtensionLoadPath(
  bundledDir: string,
  deps: ExtensionInstallDeps = {},
): Promise<string> {
  const installedPath = stableChromeExtensionDir(deps);
  const installed = await inspectInstalledCopy(installedPath);
  if (installed.present) {
    if (!installed.owned) {
      throw new Error(`Refusing foreign Chrome extension directory: ${installedPath}`);
    }
    return await fs.realpath(installedPath);
  }
  const bundledPath = await fs.realpath(path.resolve(bundledDir));
  await assertOwnedPath(bundledPath, "directory", { allowRootOwner: true });
  return bundledPath;
}

/** Repair drift only when both the copy and existing registration are already owned. */
export async function repairOwnedChromeExtensionNativeHosts(params: {
  bundledDir: string;
  pluginRoot: string;
  deps?: ExtensionInstallDeps;
}): Promise<{ changes: string[]; warnings: string[] }> {
  const deps = params.deps ?? {};
  if ((deps.platform ?? process.platform) === "win32") {
    return { changes: [], warnings: [] };
  }
  const before = await browserExtensionStatus({ bundledDir: params.bundledDir, deps });
  if (
    !before.installedCopy.owned ||
    (before.discovered.length === 0 && before.storeDiscovered.length === 0)
  ) {
    return { changes: [], warnings: [] };
  }
  const changes: string[] = [];
  const warnings: string[] = [];
  const predictedIds = before.approvedPaths
    .map((candidate) =>
      generateChromeExtensionIdForPath(candidate, deps.platform ?? process.platform),
    )
    .toSorted();
  for (const root of chromeProductRoots(deps)) {
    const manifestPath = path.join(root.nativeManifestDir, `${BROWSER_NATIVE_HOST_NAME}.json`);
    const registration = await inspectRegistration(root, deps);
    const productWasDiscovered =
      before.discovered.some((entry) => entry.product === root.product) ||
      before.storeDiscovered.some((entry) => entry.product === root.product);
    if (!productWasDiscovered) {
      continue;
    }
    if (registration?.state === "foreign" || registration?.state === "invalid") {
      warnings.push(
        `${root.label} native host repair refused: ${registration.issue ?? registration.state}`,
      );
      continue;
    }
    if (registration?.state !== "owned") {
      continue;
    }
    try {
      const idsAreCurrent =
        JSON.stringify(registration.extensionIds) ===
        JSON.stringify(expectedExtensionIds(predictedIds));
      if (!idsAreCurrent && !isSafeOriginMigration(registration.extensionIds, predictedIds)) {
        warnings.push(`${root.label} native host repair refused: unexpected allowed origins`);
        continue;
      }
      const launcher = await resolveLauncherInstall({
        manifestPath,
        pluginRoot: params.pluginRoot,
        extensionIds: predictedIds,
        deps,
      });
      await assertOwnedPath(launcher.path, "file");
      const launcherIsCurrent = (await fs.readFile(launcher.path, "utf8")) === launcher.content;
      if (idsAreCurrent && launcherIsCurrent) {
        continue;
      }
      await installRegistration({
        root,
        extensionIds: predictedIds,
        pluginRoot: params.pluginRoot,
        deps,
      });
      changes.push(`Repaired ${root.label} OpenClaw native messaging registration.`);
    } catch (error) {
      warnings.push(`${root.label} native host repair failed: ${String(error)}`);
    }
  }
  return { changes, warnings };
}
