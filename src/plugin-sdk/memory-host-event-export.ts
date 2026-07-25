import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { sameFileIdentity, type FileIdentityStat } from "../infra/fs-safe-advanced.js";
import { FsSafeError, root as createFsSafeRoot } from "../infra/fs-safe.js";
import { syncDirectoryBestEffort } from "../infra/sqlite-snapshot.js";

export type MemoryHostEventExportOwner = {
  queueKey: string;
  lockTarget: string;
  relativePath: string;
  ownerRelativePath: string;
  stateHash: string;
  workspaceHash: string;
};

type MemoryHostWorkspaceRoot = Awaited<ReturnType<typeof createFsSafeRoot>>;

export function isMissingPathError(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return (
    code === "ENOENT" ||
    code === "ENOTDIR" ||
    (error instanceof FsSafeError && code === "not-found")
  );
}

export function isRejectedWorkspaceArtifactPath(error: unknown): boolean {
  if (!(error instanceof FsSafeError)) {
    return false;
  }
  return (
    error.code === "hardlink" ||
    error.code === "not-file" ||
    error.code === "outside-workspace" ||
    error.code === "path-alias" ||
    error.code === "path-mismatch" ||
    error.code === "symlink"
  );
}

export function memoryHostEventExportOwnerContent(
  owner: MemoryHostEventExportOwner,
  content: {
    currentSha256?: string;
    pendingSha256?: string;
    identity?: FileIdentityStat;
  },
): string {
  return `${JSON.stringify({
    schemaVersion: 3,
    kind: "openclaw-memory-host-events-export",
    stateHash: owner.stateHash,
    workspaceHash: owner.workspaceHash,
    ...(content.identity
      ? { fileDev: String(content.identity.dev), fileIno: String(content.identity.ino) }
      : {}),
    ...(content.currentSha256 ? { contentSha256: content.currentSha256 } : {}),
    ...(content.pendingSha256 ? { pendingContentSha256: content.pendingSha256 } : {}),
  })}\n`;
}

async function writePinnedMemoryHostEventArtifact(
  handle: FileHandle,
  content: string,
): Promise<void> {
  const bytes = Buffer.from(content, "utf8");
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.write(bytes, offset, bytes.length - offset, offset);
    if (result.bytesWritten === 0) {
      throw new Error("event export write made no progress");
    }
    offset += result.bytesWritten;
  }
  await handle.truncate(bytes.length);
  await handle.chmod(0o600);
  await handle.sync();
}

export async function rewriteMemoryHostEventArtifactIfUnchanged(params: {
  workspaceRoot: MemoryHostWorkspaceRoot;
  relativePath: string;
  expectedContent?: string;
  expectedIdentity?: FileIdentityStat;
  nextContent: string;
}): Promise<boolean> {
  let observed: Awaited<ReturnType<typeof params.workspaceRoot.open>>;
  try {
    observed = await params.workspaceRoot.open(params.relativePath);
  } catch (error) {
    if (isMissingPathError(error) || isRejectedWorkspaceArtifactPath(error)) {
      return false;
    }
    throw error;
  }
  try {
    if (
      params.expectedIdentity
        ? !sameFileIdentity(params.expectedIdentity, observed.stat)
        : (await observed.handle.readFile({ encoding: "utf8" })) !== params.expectedContent
    ) {
      return false;
    }
    let writable: Awaited<ReturnType<typeof params.workspaceRoot.openWritable>>;
    try {
      writable = await params.workspaceRoot.openWritable(params.relativePath, {
        mode: 0o600,
        writeMode: "update",
      });
    } catch (error) {
      if (isMissingPathError(error) || isRejectedWorkspaceArtifactPath(error)) {
        return false;
      }
      throw error;
    }
    try {
      // The matching marker/content snapshot owns this generated artifact inode for
      // the locked update. A distinct workspace file can take the path only by
      // replacing that inode; direct writes still target the owned export itself.
      if (!sameFileIdentity(observed.stat, writable.stat)) {
        return false;
      }
      await writable.handle.writeFile(params.nextContent, { encoding: "utf8" });
      await writable.handle.truncate(Buffer.byteLength(params.nextContent, "utf8"));
      await writable.handle.chmod(0o600);
      await writable.handle.sync();
    } finally {
      await writable.handle.close().catch(() => undefined);
    }
    let verified: Awaited<ReturnType<typeof params.workspaceRoot.open>>;
    try {
      verified = await params.workspaceRoot.open(params.relativePath);
    } catch (error) {
      if (isMissingPathError(error) || isRejectedWorkspaceArtifactPath(error)) {
        return false;
      }
      throw error;
    }
    try {
      return (
        sameFileIdentity(observed.stat, verified.stat) &&
        (await verified.handle.readFile({ encoding: "utf8" })) === params.nextContent
      );
    } finally {
      await verified.handle.close().catch(() => undefined);
    }
  } finally {
    await observed.handle.close().catch(() => undefined);
  }
}

export async function isMemoryHostEventArtifactAtIdentity(params: {
  workspaceRoot: MemoryHostWorkspaceRoot;
  relativePath: string;
  expectedIdentity: FileIdentityStat;
  expectedContent?: string;
}): Promise<boolean> {
  let opened: Awaited<ReturnType<typeof params.workspaceRoot.open>>;
  try {
    opened = await params.workspaceRoot.open(params.relativePath);
  } catch (error) {
    if (isMissingPathError(error) || isRejectedWorkspaceArtifactPath(error)) {
      return false;
    }
    throw error;
  }
  try {
    if (!sameFileIdentity(params.expectedIdentity, opened.stat)) {
      return false;
    }
    return (
      params.expectedContent === undefined ||
      (await opened.handle.readFile()).equals(Buffer.from(params.expectedContent, "utf8"))
    );
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

export async function publishMemoryHostEventArtifact(params: {
  workspaceRoot: MemoryHostWorkspaceRoot;
  owner: MemoryHostEventExportOwner;
  absolutePath: string;
  expectedOwnerContent: string;
  content: string;
  contentSha256: string;
}): Promise<FileIdentityStat | undefined> {
  let writable: Awaited<ReturnType<typeof params.workspaceRoot.openWritable>>;
  try {
    writable = await params.workspaceRoot.openWritable(params.owner.relativePath, {
      mode: 0o600,
      writeMode: "replace",
    });
  } catch (error) {
    if (isMissingPathError(error) || isRejectedWorkspaceArtifactPath(error)) {
      return undefined;
    }
    throw error;
  }
  try {
    // `createdForWrite` is the exclusive-create proof. Keep its handle pinned
    // through publication so a replacement path is never opened for mutation.
    if (!writable.createdForWrite) {
      return undefined;
    }
    const publishedIdentity = { dev: writable.stat.dev, ino: writable.stat.ino };
    await syncDirectoryBestEffort(path.dirname(params.absolutePath));

    const identityPendingOwnerContent = memoryHostEventExportOwnerContent(params.owner, {
      pendingSha256: params.contentSha256,
      identity: publishedIdentity,
    });
    if (
      !(await rewriteMemoryHostEventArtifactIfUnchanged({
        workspaceRoot: params.workspaceRoot,
        relativePath: params.owner.ownerRelativePath,
        expectedContent: params.expectedOwnerContent,
        nextContent: identityPendingOwnerContent,
      }))
    ) {
      return undefined;
    }
    await syncDirectoryBestEffort(path.dirname(params.absolutePath));

    await writePinnedMemoryHostEventArtifact(writable.handle, params.content);
    // Workspace actors can mutate this inode without replacing the path. Verify
    // bytes before finalizing the marker so foreign content never gains ownership.
    if (
      !(await isMemoryHostEventArtifactAtIdentity({
        workspaceRoot: params.workspaceRoot,
        relativePath: params.owner.relativePath,
        expectedIdentity: publishedIdentity,
        expectedContent: params.content,
      }))
    ) {
      return undefined;
    }
    await syncDirectoryBestEffort(path.dirname(params.absolutePath));

    if (
      !(await rewriteMemoryHostEventArtifactIfUnchanged({
        workspaceRoot: params.workspaceRoot,
        relativePath: params.owner.ownerRelativePath,
        expectedContent: identityPendingOwnerContent,
        nextContent: memoryHostEventExportOwnerContent(params.owner, {
          currentSha256: params.contentSha256,
          identity: publishedIdentity,
        }),
      }))
    ) {
      return undefined;
    }
    await syncDirectoryBestEffort(path.dirname(params.absolutePath));
    if (
      !(await isMemoryHostEventArtifactAtIdentity({
        workspaceRoot: params.workspaceRoot,
        relativePath: params.owner.relativePath,
        expectedIdentity: publishedIdentity,
        expectedContent: params.content,
      }))
    ) {
      return undefined;
    }
    return publishedIdentity;
  } finally {
    await writable.handle.close().catch(() => undefined);
  }
}
