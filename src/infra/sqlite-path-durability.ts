import { type Stats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { sameFileIdentity } from "./fs-safe-advanced.js";

export type SqliteDirectorySyncOutcome = "synced" | "unsupported";

export type SqlitePathIdentityReceipt = {
  path: string;
  identity: Stats;
};

export type DurableSqliteDirectoryReceipt = SqlitePathIdentityReceipt & {
  parentSync: SqliteDirectorySyncOutcome | "not-needed";
};

function isWindowsDirectorySyncUnsupported(error: unknown): boolean {
  if (process.platform !== "win32") {
    return false;
  }
  // Node can open Windows directories for metadata, but directory handles are
  // not guaranteed to support FlushFileBuffers. Keep real I/O failures strict.
  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === "EACCES" ||
    code === "EINVAL" ||
    code === "EISDIR" ||
    code === "ENOSYS" ||
    code === "ENOTSUP" ||
    code === "EPERM"
  );
}

function assertDirectory(identity: Stats, pathname: string, label: string): void {
  if (identity.isSymbolicLink() || !identity.isDirectory()) {
    throw new Error(`${label} must be a real directory: ${pathname}`);
  }
}

async function assertDirectoryReceiptCurrent(
  receipt: SqlitePathIdentityReceipt,
  label: string,
): Promise<void> {
  const currentIdentity = await fs.lstat(receipt.path);
  assertDirectory(currentIdentity, receipt.path, label);
  if (!sameFileIdentity(receipt.identity, currentIdentity)) {
    throw new Error(`${label} changed during durable directory operation: ${receipt.path}`);
  }
}

async function assertOpenDirectoryCurrent(
  handle: FileHandle,
  receipt: SqlitePathIdentityReceipt,
  label: string,
): Promise<void> {
  const openedIdentity = await handle.stat();
  assertDirectory(openedIdentity, receipt.path, label);
  if (!sameFileIdentity(receipt.identity, openedIdentity)) {
    throw new Error(`${label} handle changed during directory sync: ${receipt.path}`);
  }
  await assertDirectoryReceiptCurrent(receipt, label);
}

export async function syncSqliteDirectoryForDurability(
  directory: string | SqlitePathIdentityReceipt,
): Promise<SqliteDirectorySyncOutcome> {
  let receipt: SqlitePathIdentityReceipt;
  if (typeof directory === "string") {
    const directoryPath = path.resolve(directory);
    receipt = { path: directoryPath, identity: await fs.lstat(directoryPath) };
  } else {
    receipt = { path: path.resolve(directory.path), identity: directory.identity };
  }
  await assertDirectoryReceiptCurrent(receipt, "SQLite durability directory");

  let handle: FileHandle;
  try {
    handle = await fs.open(receipt.path, "r");
  } catch (error) {
    if (!isWindowsDirectorySyncUnsupported(error)) {
      throw error;
    }
    await assertDirectoryReceiptCurrent(receipt, "SQLite durability directory");
    return "unsupported";
  }

  try {
    await assertOpenDirectoryCurrent(handle, receipt, "SQLite durability directory");
    try {
      await handle.sync();
    } catch (error) {
      if (!isWindowsDirectorySyncUnsupported(error)) {
        throw error;
      }
      await assertOpenDirectoryCurrent(handle, receipt, "SQLite durability directory");
      return "unsupported";
    }
    await assertOpenDirectoryCurrent(handle, receipt, "SQLite durability directory");
    return "synced";
  } finally {
    await handle.close();
  }
}

async function findExistingAncestorReceipt(
  targetPath: string,
  label: string,
): Promise<SqlitePathIdentityReceipt> {
  let currentPath = path.resolve(targetPath);
  while (true) {
    try {
      const identity = await fs.lstat(currentPath);
      assertDirectory(identity, currentPath, label);
      return { path: currentPath, identity };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      throw new Error(`${label} has no existing directory ancestor: ${targetPath}`);
    }
    currentPath = parentPath;
  }
}

export async function ensureDurableSqliteDirectory(params: {
  directoryPath: string;
  label: string;
  create: (directoryPath: string) => Promise<void>;
}): Promise<DurableSqliteDirectoryReceipt> {
  const directoryPath = path.resolve(params.directoryPath);
  const ancestor = await findExistingAncestorReceipt(directoryPath, params.label);
  await params.create(directoryPath);

  const receipts = [ancestor];
  let currentPath = ancestor.path;
  for (const segment of path
    .relative(ancestor.path, directoryPath)
    .split(path.sep)
    .filter(Boolean)) {
    currentPath = path.join(currentPath, segment);
    const identity = await fs.lstat(currentPath);
    assertDirectory(identity, currentPath, params.label);
    receipts.push({ path: currentPath, identity });
  }

  let parentSync: DurableSqliteDirectoryReceipt["parentSync"] = "not-needed";
  for (let index = receipts.length - 1; index > 0; index -= 1) {
    const parent = receipts[index - 1];
    const child = receipts[index];
    if (!parent || !child) {
      throw new Error(`${params.label} directory receipt chain is incomplete.`);
    }
    await assertDirectoryReceiptCurrent(parent, params.label);
    await assertDirectoryReceiptCurrent(child, params.label);
    try {
      const outcome = await syncSqliteDirectoryForDurability(parent);
      if (outcome === "unsupported") {
        parentSync = "unsupported";
      } else if (parentSync === "not-needed") {
        parentSync = "synced";
      }
    } catch (error) {
      throw new Error(
        `${params.label} could not sync created directory edge ${child.path} through ${parent.path}`,
        { cause: error },
      );
    }
    await assertDirectoryReceiptCurrent(parent, params.label);
    await assertDirectoryReceiptCurrent(child, params.label);
  }

  const finalReceipt = receipts.at(-1);
  if (!finalReceipt) {
    throw new Error(`${params.label} directory receipt is missing.`);
  }
  await assertDirectoryReceiptCurrent(finalReceipt, params.label);
  return { ...finalReceipt, parentSync };
}
