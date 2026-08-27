/** Managed local wrapper for Codex's reserved bundled marketplace. */
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  assertDirectoryIdentityStable,
  assertNotSymlink,
  directoryIdentityIsStable,
  prepareOwnedServiceParent,
} from "./computer-use-service-path.js";
import {
  resolveMacOSDesktopCodexAppPathCandidates,
  type MacOSDesktopCodexAppPathCandidate,
} from "./desktop-app-paths.js";

const MARKETPLACE_NAME = "openai-bundled";
const activeInstalls = new Map<
  string,
  { sourcePath: string; promise: Promise<string | undefined> }
>();

export function resolveCodexManagedBundledMarketplacePath(codexHome: string): string {
  return path.join(codexHome, ".tmp", "bundled-marketplaces", MARKETPLACE_NAME);
}

export async function ensureCodexManagedBundledMarketplace(params: {
  codexHome: string;
  ownershipRoot: string;
  appServerCommand?: string;
  candidates?: readonly MacOSDesktopCodexAppPathCandidate[];
  ownershipCandidates?: readonly MacOSDesktopCodexAppPathCandidate[];
  assertCurrent?: () => void;
}): Promise<string | undefined> {
  const candidates = params.candidates ?? resolveMacOSDesktopCodexAppPathCandidates();
  const source = await resolveCodexManagedBundledMarketplaceSource({ ...params, candidates });
  if (!source) {
    return undefined;
  }
  const parentPath = path.dirname(resolveCodexManagedBundledMarketplacePath(params.codexHome));
  const targetPath = path.join(parentPath, MARKETPLACE_NAME);
  const parent = await prepareOwnedServiceParent({
    ownershipRoot: params.ownershipRoot,
    codexHome: params.codexHome,
    targetParent: parentPath,
  });
  const physicalTargetPath = path.join(parent.realPath, MARKETPLACE_NAME);
  await assertNotSymlink(physicalTargetPath, "managed bundled marketplace");
  const active = activeInstalls.get(physicalTargetPath);
  if (active) {
    if (active.sourcePath === source.bundledMarketplacePath) {
      return await active.promise;
    }
    await active.promise.catch(() => undefined);
    return await ensureCodexManagedBundledMarketplace(params);
  }
  const install = reconcileManagedWrapper({
    parent,
    physicalTargetPath,
    targetPath,
    source,
    ownershipCandidates: params.ownershipCandidates ?? candidates,
    assertCurrent: params.assertCurrent,
  });
  const activeEntry = { sourcePath: source.bundledMarketplacePath, promise: install };
  activeInstalls.set(physicalTargetPath, activeEntry);
  const clearActive = () => {
    if (activeInstalls.get(physicalTargetPath) === activeEntry) {
      activeInstalls.delete(physicalTargetPath);
    }
  };
  void install.then(clearActive, clearActive);
  return await install;
}

async function reconcileManagedWrapper(
  params: Parameters<typeof publishManagedWrapper>[0],
): Promise<string> {
  if (await wrapperMatches(params.physicalTargetPath, params.source.bundledMarketplacePath)) {
    return params.targetPath;
  }
  return await publishManagedWrapper(params);
}

async function publishManagedWrapper(params: {
  parent: Awaited<ReturnType<typeof prepareOwnedServiceParent>>;
  physicalTargetPath: string;
  targetPath: string;
  source: MacOSDesktopCodexAppPathCandidate;
  ownershipCandidates: readonly MacOSDesktopCodexAppPathCandidate[];
  assertCurrent?: () => void;
}): Promise<string> {
  const { parent, physicalTargetPath, targetPath, source, ownershipCandidates, assertCurrent } =
    params;

  const stagingPath = await fs.mkdtemp(path.join(parent.realPath, `.${MARKETPLACE_NAME}.staging-`));
  const backupPath = path.join(
    parent.realPath,
    `.${MARKETPLACE_NAME}.backup-${process.pid}-${Date.now()}`,
  );
  let backupCreated = false;
  try {
    const manifestParent = path.join(stagingPath, ".agents", "plugins");
    await fs.mkdir(manifestParent, { recursive: true, mode: 0o700 });
    await Promise.all([
      fs.symlink(
        path.join(source.bundledMarketplacePath, ".agents", "plugins", "marketplace.json"),
        path.join(manifestParent, "marketplace.json"),
      ),
      fs.symlink(
        path.join(source.bundledMarketplacePath, "plugins"),
        path.join(stagingPath, "plugins"),
      ),
    ]);
    await assertDirectoryIdentityStable(parent, "managed bundled marketplace parent");
    const existing = await fs.lstat(physicalTargetPath).catch((error: unknown) => {
      if (hasNodeErrorCode(error, "ENOENT")) {
        return undefined;
      }
      throw error;
    });
    if (existing && !existing.isDirectory()) {
      throw new Error(`Managed bundled marketplace must be a real directory: ${targetPath}`);
    }
    if (existing && !(await wrapperMatchesAnySource(physicalTargetPath, ownershipCandidates))) {
      throw new Error(
        `Refusing to replace an unowned bundled marketplace directory: ${targetPath}`,
      );
    }
    if (existing) {
      assertCurrent?.();
      await fs.rename(physicalTargetPath, backupPath);
      backupCreated = true;
      await assertDirectoryIdentityStable(parent, "managed bundled marketplace parent");
    }
    assertCurrent?.();
    await fs.rename(stagingPath, physicalTargetPath);
    await assertDirectoryIdentityStable(parent, "managed bundled marketplace parent");
    if (backupCreated) {
      await fs.rm(backupPath, { recursive: true });
      backupCreated = false;
    }
    return targetPath;
  } catch (error) {
    if (backupCreated) {
      try {
        await assertDirectoryIdentityStable(parent, "managed bundled marketplace parent");
        const replacement = await fs.lstat(physicalTargetPath).catch(() => undefined);
        if (replacement) {
          if (!(await wrapperMatches(physicalTargetPath, source.bundledMarketplacePath))) {
            throw new Error("managed bundled marketplace replacement is no longer owned", {
              cause: error,
            });
          }
          await fs.rm(physicalTargetPath, { recursive: true });
        }
        await fs.rename(backupPath, physicalTargetPath);
        backupCreated = false;
      } catch (restoreError) {
        throw new Error(
          `Failed to restore the prior managed bundled marketplace: ${String(error)}`,
          {
            cause: restoreError,
          },
        );
      }
    }
    throw error;
  } finally {
    if (await directoryIdentityIsStable(parent)) {
      await fs.rm(stagingPath, { recursive: true, force: true });
    }
  }
}

export async function resolveCodexManagedBundledMarketplaceSource(params: {
  appServerCommand?: string;
  candidates?: readonly MacOSDesktopCodexAppPathCandidate[];
}): Promise<MacOSDesktopCodexAppPathCandidate | undefined> {
  const candidates = params.candidates ?? resolveMacOSDesktopCodexAppPathCandidates();
  const command = params.appServerCommand && path.resolve(params.appServerCommand);
  const ordered = command
    ? candidates.filter((candidate) => path.resolve(candidate.appServerCommandPath) === command)
    : candidates;
  for (const candidate of ordered) {
    if (await isExpectedMarketplace(candidate.bundledMarketplacePath)) {
      return candidate;
    }
  }
  return undefined;
}

async function isExpectedMarketplace(root: string): Promise<boolean> {
  try {
    const manifest: unknown = JSON.parse(
      await fs.readFile(path.join(root, ".agents", "plugins", "marketplace.json"), "utf8"),
    );
    await fs.access(path.join(root, "plugins", "computer-use", ".codex-plugin", "plugin.json"));
    return (
      isRecord(manifest) &&
      manifest.name === MARKETPLACE_NAME &&
      Array.isArray(manifest.plugins) &&
      manifest.plugins.some((plugin) => isRecord(plugin) && plugin.name === "computer-use")
    );
  } catch {
    return false;
  }
}

async function wrapperMatches(targetPath: string, sourcePath: string): Promise<boolean> {
  try {
    const target = await fs.lstat(targetPath);
    if (!target.isDirectory() || target.isSymbolicLink()) {
      return false;
    }
    const [manifest, plugins] = await Promise.all([
      fs.readlink(path.join(targetPath, ".agents", "plugins", "marketplace.json")),
      fs.readlink(path.join(targetPath, "plugins")),
    ]);
    return (
      manifest === path.join(sourcePath, ".agents", "plugins", "marketplace.json") &&
      plugins === path.join(sourcePath, "plugins")
    );
  } catch {
    return false;
  }
}

async function wrapperMatchesAnySource(
  targetPath: string,
  candidates: readonly MacOSDesktopCodexAppPathCandidate[],
): Promise<boolean> {
  for (const candidate of candidates) {
    if (await wrapperMatches(targetPath, candidate.bundledMarketplacePath)) {
      return true;
    }
  }
  return false;
}

function hasNodeErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
