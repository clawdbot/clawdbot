import { constants as fsConstants } from "node:fs";
import type { Stats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { sameFileIdentity } from "./fs-safe-advanced.js";

type SqliteDirectorySyncOutcome = "synced" | "unsupported";

export type SqlitePathIdentityReceipt = {
  path: string;
  identity: Stats;
};

export type DurableSqliteDirectoryReceipt = SqlitePathIdentityReceipt & {
  parentSync: SqliteDirectorySyncOutcome | "not-needed";
};

type OpenSqliteDirectoryReceipt = {
  handle: FileHandle;
  receipt: SqlitePathIdentityReceipt;
};

function sqliteDirectoryOpenFlags(): string | number {
  if (process.platform === "win32") {
    return "r";
  }
  // The identity checks close ordinary rename races after open. These flags
  // also prevent a substituted symlink or FIFO from redirecting or blocking it.
  return (
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK
  );
}

async function openDirectoryHandle(directoryPath: string): Promise<FileHandle> {
  return await fs.open(directoryPath, sqliteDirectoryOpenFlags());
}

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

export async function openSqliteDirectoryForDurability(
  receipt: SqlitePathIdentityReceipt,
  label: string,
): Promise<FileHandle> {
  const handle = await openDirectoryHandle(receipt.path);
  try {
    await assertOpenDirectoryCurrent(handle, receipt, label);
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function openDirectoryPath(
  directoryPath: string,
  label: string,
): Promise<OpenSqliteDirectoryReceipt> {
  const handle = await openDirectoryHandle(directoryPath);
  try {
    const identity = await handle.stat();
    const receipt = { path: directoryPath, identity };
    await assertOpenDirectoryCurrent(handle, receipt, label);
    return { handle, receipt };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function syncOpenDirectoryForDurability(
  handle: FileHandle,
  receipt: SqlitePathIdentityReceipt,
): Promise<SqliteDirectorySyncOutcome> {
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
    handle = await openDirectoryHandle(receipt.path);
  } catch (error) {
    if (!isWindowsDirectorySyncUnsupported(error)) {
      throw error;
    }
    await assertDirectoryReceiptCurrent(receipt, "SQLite durability directory");
    return "unsupported";
  }

  try {
    return await syncOpenDirectoryForDurability(handle, receipt);
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
  expectedExistingIdentity?: Stats;
  create: (directoryPath: string) => Promise<void>;
}): Promise<DurableSqliteDirectoryReceipt> {
  const directoryPath = path.resolve(params.directoryPath);
  const ancestor = await findExistingAncestorReceipt(directoryPath, params.label);
  const targetExists = ancestor.path === directoryPath;
  if (
    params.expectedExistingIdentity &&
    (!targetExists || !sameFileIdentity(params.expectedExistingIdentity, ancestor.identity))
  ) {
    throw new Error(`${params.label} changed before durable directory pinning: ${directoryPath}`);
  }
  // Keep the preexisting anchor open while the creator runs. Otherwise a
  // remove/recreate race can recycle its inode and hide an unsynced new edge.
  const ancestorHandle = await openSqliteDirectoryForDurability(ancestor, params.label);
  const openedReceipts: OpenSqliteDirectoryReceipt[] = [
    { handle: ancestorHandle, receipt: ancestor },
  ];
  try {
    await assertOpenDirectoryCurrent(ancestorHandle, ancestor, params.label);
    if (!targetExists) {
      await params.create(directoryPath);
    }
    await assertOpenDirectoryCurrent(ancestorHandle, ancestor, params.label);

    let currentPath = ancestor.path;
    for (const segment of path
      .relative(ancestor.path, directoryPath)
      .split(path.sep)
      .filter(Boolean)) {
      currentPath = path.join(currentPath, segment);
      openedReceipts.push(await openDirectoryPath(currentPath, params.label));
    }

    let parentSync: DurableSqliteDirectoryReceipt["parentSync"] = "not-needed";
    for (let index = openedReceipts.length - 1; index > 0; index -= 1) {
      const parent = openedReceipts[index - 1];
      const child = openedReceipts[index];
      if (!parent || !child) {
        throw new Error(`${params.label} directory receipt chain is incomplete.`);
      }
      await assertOpenDirectoryCurrent(parent.handle, parent.receipt, params.label);
      await assertOpenDirectoryCurrent(child.handle, child.receipt, params.label);
      try {
        const outcome = await syncOpenDirectoryForDurability(parent.handle, parent.receipt);
        if (outcome === "unsupported") {
          parentSync = "unsupported";
        } else if (parentSync === "not-needed") {
          parentSync = "synced";
        }
      } catch (error) {
        throw new Error(
          `${params.label} could not sync created directory edge ${child.receipt.path} through ${parent.receipt.path}`,
          { cause: error },
        );
      }
      await assertOpenDirectoryCurrent(parent.handle, parent.receipt, params.label);
      await assertOpenDirectoryCurrent(child.handle, child.receipt, params.label);
    }

    const finalReceipt = openedReceipts.at(-1)?.receipt;
    if (!finalReceipt) {
      throw new Error(`${params.label} directory receipt is missing.`);
    }
    await assertOpenDirectoryCurrent(ancestorHandle, ancestor, params.label);
    await assertDirectoryReceiptCurrent(finalReceipt, params.label);
    return { ...finalReceipt, parentSync };
  } finally {
    await Promise.all(openedReceipts.toReversed().map(({ handle }) => handle.close()));
  }
}
