import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { workspaceStatIdentity } from "../gateway/worker-environments/workspace-hash-memo.js";
import { resolveOpenedFileRealPathForHandle } from "../infra/fs-safe.js";
import { isPathInside } from "../infra/path-guards.js";
import { tempWorkspace } from "../infra/private-temp-workspace.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";

type UploadSource = { path: string; size: number; sha256: string };

async function stageUploadSource(params: {
  source: UploadSource;
  workspaceDir: string;
  destination: string;
  signal?: AbortSignal;
}): Promise<void> {
  const source = await fsp.open(
    params.source.path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  const destination = await fsp
    .open(params.destination, "wx", 0o600)
    .catch(async (error: unknown) => {
      await source.close();
      throw error;
    });
  try {
    const before = await source.stat({ bigint: true });
    const realPath = await resolveOpenedFileRealPathForHandle(source, params.source.path);
    if (!before.isFile() || !isPathInside(params.workspaceDir, realPath)) {
      throw new Error("workspace changed while preparing its transfer snapshot");
    }
    const identity = workspaceStatIdentity("worker", before);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    for (;;) {
      params.signal?.throwIfAborted();
      const { bytesRead } = await source.read(buffer, 0, buffer.length, offset);
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
      if (offset > params.source.size) {
        throw new Error("workspace changed while preparing its transfer snapshot");
      }
      hash.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const { bytesWritten } = await destination.write(
          buffer,
          written,
          bytesRead - written,
          offset - bytesRead + written,
        );
        if (bytesWritten === 0) {
          throw new Error("workspace transfer snapshot write made no progress");
        }
        written += bytesWritten;
      }
    }
    const after = await source.stat({ bigint: true });
    if (
      offset !== params.source.size ||
      workspaceStatIdentity("worker", after) !== identity ||
      hash.digest("hex") !== params.source.sha256
    ) {
      throw new Error("workspace changed while preparing its transfer snapshot");
    }
  } finally {
    await Promise.allSettled([source.close(), destination.close()]);
  }
}

/** Freezes changed workspace bytes before the transfer request can observe later writes. */
export async function createNodeWorkerUploadSnapshot(params: {
  workspaceDir: string;
  sources: UploadSource[];
  signal?: AbortSignal;
}) {
  const workspace = await tempWorkspace({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "worker-workspace-upload-",
  });
  try {
    const workspaceDir = await fsp.realpath(params.workspaceDir);
    const files: Array<{ path: string; size: number }> = [];
    for (const [index, source] of params.sources.entries()) {
      const stagedPath = path.join(workspace.dir, String(index));
      await stageUploadSource({
        source,
        workspaceDir,
        destination: stagedPath,
        signal: params.signal,
      });
      files.push({ path: stagedPath, size: source.size });
    }
    return {
      files,
      cleanup: async () => await workspace.cleanup(),
      stream: async (file: (typeof files)[number], write: (chunk: Buffer) => Promise<void>) => {
        const handle = await fsp.open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          for await (const value of handle.createReadStream({ autoClose: false })) {
            await write(Buffer.isBuffer(value) ? value : Buffer.from(value));
          }
        } finally {
          await handle.close();
        }
      },
    };
  } catch (error) {
    await workspace.cleanup();
    throw error;
  }
}
