/** Filesystem ownership guards for isolated Computer Use service provisioning. */
import fs from "node:fs/promises";
import path from "node:path";
import { assertNoSymlinkParents } from "openclaw/plugin-sdk/security-runtime";

type OwnedServiceParent = {
  logicalPath: string;
  realPath: string;
  dev: number;
  ino: number;
};

export async function assertOwnedServicePath(params: {
  ownershipRoot: string;
  codexHome: string;
  targetParent: string;
  targetPath: string;
}): Promise<void> {
  await assertOwnedCodexHomePath({
    ownershipRoot: params.ownershipRoot,
    codexHome: params.codexHome,
    allowMissing: true,
  });
  assertPathAtOrInside(params.ownershipRoot, params.targetParent, "Computer Use service parent");
  await assertNoSymlinkParents({
    rootDir: params.ownershipRoot,
    targetPath: params.targetParent,
    allowMissing: true,
    requireDirectories: true,
    messagePrefix: "Computer Use service path",
  });
  await assertNotSymlink(params.targetPath, "Computer Use service target");
}

export async function ensureOwnedCodexHome(
  codexHomeInput: string,
  ownershipRootInput = path.dirname(path.resolve(codexHomeInput)),
): Promise<void> {
  const codexHome = path.resolve(codexHomeInput);
  const ownershipRoot = path.resolve(ownershipRootInput);
  await fs.mkdir(ownershipRoot, { recursive: true, mode: 0o700 });
  await assertOwnedCodexHomePath({ ownershipRoot, codexHome, allowMissing: true });
  await ensureRealDirectoryTree(ownershipRoot, codexHome, "isolated Codex home");
  await assertOwnedCodexHomePath({ ownershipRoot, codexHome, allowMissing: false });
}

export async function prepareOwnedServiceParent(params: {
  ownershipRoot: string;
  codexHome: string;
  targetParent: string;
}): Promise<OwnedServiceParent> {
  await ensureOwnedCodexHome(params.codexHome, params.ownershipRoot);
  await ensureRealDirectoryTree(
    params.ownershipRoot,
    params.targetParent,
    "Computer Use service parent",
  );
  await assertNoSymlinkParents({
    rootDir: params.ownershipRoot,
    targetPath: params.targetParent,
    allowMissing: false,
    requireDirectories: true,
    messagePrefix: "Computer Use service path",
  });
  const [rootIdentity, parentIdentity] = await Promise.all([
    readRealDirectoryIdentity(params.ownershipRoot, "Computer Use ownership root"),
    readRealDirectoryIdentity(params.targetParent, "Computer Use service parent"),
  ]);
  assertPathAtOrInside(
    rootIdentity.realPath,
    parentIdentity.realPath,
    "canonical Computer Use service parent",
  );
  return parentIdentity;
}

async function assertOwnedCodexHomePath(params: {
  ownershipRoot: string;
  codexHome: string;
  allowMissing: boolean;
}): Promise<void> {
  await readRealDirectoryIdentity(params.ownershipRoot, "Computer Use ownership root");
  assertPathAtOrInside(params.ownershipRoot, params.codexHome, "isolated Codex home");
  await assertNoSymlinkParents({
    rootDir: params.ownershipRoot,
    targetPath: params.codexHome,
    allowMissing: params.allowMissing,
    requireDirectories: true,
    messagePrefix: "Computer Use service path",
  });
}

export async function readRealDirectoryIdentity(
  directoryPath: string,
  label: string,
): Promise<OwnedServiceParent> {
  const logicalPath = path.resolve(directoryPath);
  const before = await fs.lstat(logicalPath);
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new Error(`${label} must be a real directory: ${logicalPath}`);
  }
  const realPath = await fs.realpath(logicalPath);
  const [after, resolved] = await Promise.all([fs.lstat(logicalPath), fs.lstat(realPath)]);
  if (
    after.isSymbolicLink() ||
    !after.isDirectory() ||
    !resolved.isDirectory() ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    after.dev !== resolved.dev ||
    after.ino !== resolved.ino
  ) {
    throw new Error(`${label} changed while its ownership boundary was being established.`);
  }
  return { logicalPath, realPath, dev: after.dev, ino: after.ino };
}

export async function assertOwnedServiceParentStable(parent: OwnedServiceParent): Promise<void> {
  await assertDirectoryIdentityStable(parent, "Computer Use service parent");
}

export async function assertDirectoryIdentityStable(
  expected: OwnedServiceParent,
  label: string,
): Promise<void> {
  if (!(await directoryIdentityIsStable(expected))) {
    throw new Error(`${label} changed during refresh; refusing to mutate the replacement path.`);
  }
}

export async function ownedServiceParentIsStable(parent: OwnedServiceParent): Promise<boolean> {
  return await directoryIdentityIsStable(parent);
}

export async function directoryIdentityIsStable(expected: OwnedServiceParent): Promise<boolean> {
  try {
    const current = await fs.lstat(expected.logicalPath);
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      current.dev !== expected.dev ||
      current.ino !== expected.ino
    ) {
      return false;
    }
    return (await fs.realpath(expected.logicalPath)) === expected.realPath;
  } catch {
    return false;
  }
}

export async function assertNotSymlink(filePath: string, label: string): Promise<void> {
  try {
    if ((await fs.lstat(filePath)).isSymbolicLink()) {
      throw new Error(`${label} must not be a symbolic link: ${filePath}`);
    }
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
}

async function ensureRealDirectoryTree(
  ownershipRoot: string,
  directoryPath: string,
  label: string,
): Promise<void> {
  const root = path.resolve(ownershipRoot);
  const target = path.resolve(directoryPath);
  assertPathAtOrInside(root, target, label);
  const relative = path.relative(root, target);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const existing = await fs.lstat(current).catch((error: unknown) => {
      if (hasNodeErrorCode(error, "ENOENT")) {
        return undefined;
      }
      throw error;
    });
    if (!existing) {
      try {
        await fs.mkdir(current, { mode: 0o700 });
      } catch (error) {
        if (!hasNodeErrorCode(error, "EEXIST")) {
          throw error;
        }
      }
      const created = await fs.lstat(current);
      if (created.isSymbolicLink() || !created.isDirectory()) {
        throw new Error(`${label} changed while its directory tree was being created: ${current}`);
      }
    } else if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error(`${label} must traverse real directories: ${current}`);
    }
  }
  await assertNoSymlinkParents({
    rootDir: root,
    targetPath: target,
    allowMissing: false,
    requireDirectories: true,
    messagePrefix: "Computer Use service path",
  });
  await readRealDirectoryIdentity(target, label);
}

function assertPathAtOrInside(rootPath: string, candidatePath: string, label: string): void {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must remain inside ${path.resolve(rootPath)}.`);
  }
}

function hasNodeErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
