import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { hasNodeErrorCode } from "../../infra/path-guards.js";
import {
  createWorkspaceGitTransferList,
  runWorkspaceInventoryCommandToFile,
} from "./workspace-sync-inventory.js";

function validateGitRelativePath(file: string): string {
  if (
    !file ||
    path.posix.isAbsolute(file) ||
    path.posix.normalize(file) !== file ||
    file === ".." ||
    file.startsWith("../")
  ) {
    throw new Error("Worker workspace git file list contains an unsafe path");
  }
  return file;
}

async function* readNulFile(filePath: string): AsyncGenerator<string> {
  let pending = Buffer.alloc(0);
  for await (const value of createReadStream(filePath)) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const buffer = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    let offset = 0;
    for (;;) {
      const separator = buffer.indexOf(0, offset);
      if (separator < 0) {
        break;
      }
      yield validateGitRelativePath(buffer.subarray(offset, separator).toString("utf8"));
      offset = separator + 1;
    }
    pending = Buffer.from(buffer.subarray(offset));
  }
  if (pending.length > 0) {
    throw new Error("Worker workspace git file list is not NUL terminated");
  }
}

export async function runLocalCommandToFile(params: {
  argv: string[];
  inputPath?: string;
  outputPath: string;
  signal: AbortSignal;
  timeoutMs: number;
}): Promise<void> {
  await runWorkspaceInventoryCommandToFile(params);
}

export async function createGitTransferList(params: {
  gitRoot: string;
  temporaryDirectory: string;
  signal: AbortSignal;
  timeoutMs: number;
}): Promise<string> {
  return await createWorkspaceGitTransferList(params);
}

export async function filterExistingGitTransferList(params: {
  gitRoot: string;
  preparedListPath: string;
  outputPath: string;
}): Promise<string> {
  const output = await fs.open(params.outputPath, "wx", 0o600);
  try {
    for await (const file of readNulFile(params.preparedListPath)) {
      const stats = await fs.lstat(path.join(params.gitRoot, file)).catch((error: unknown) => {
        if (hasNodeErrorCode(error, "ENOENT")) {
          return undefined;
        }
        throw error;
      });
      if (stats?.isFile() || stats?.isSymbolicLink()) {
        await output.write(`${file}\0`);
      }
    }
  } finally {
    await output.close();
  }
  return params.outputPath;
}
