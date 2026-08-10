import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyMergePatch } from "../../config/merge-patch.js";
import { writeJson } from "../../infra/json-files.js";
import type { CliBackendConfig } from "../../plugins/cli-backend.types.js";
import { isRecord } from "../bundle-mcp-adapter.js";

export function injectBundleMcpBackendArgs(
  backend: CliBackendConfig,
  inject: (args: string[] | undefined) => string[],
): CliBackendConfig {
  return {
    ...backend,
    args: inject(backend.args),
    resumeArgs: inject(backend.resumeArgs ?? backend.args ?? []),
  };
}

export async function writeTemporaryBundleMcpJson(
  prefix: string,
  value: unknown,
  fileName = "settings.json",
  atomic = true,
  options?: {
    /**
     * Also open a read descriptor on the written file and return it, for the
     * caller to hand to the child it is about to spawn. The child inherits it
     * at `fork`, so from that instant the descriptor is durable evidence that
     * the directory is claimed — visible in `/proc/<pid>/fd` even while the
     * child is still pre-`exec` and its argv says nothing about this path.
     * `cleanup` closes the parent's copy; the child's survives independently.
     */
    openOwnershipFd?: boolean;
  },
): Promise<{ filePath: string; cleanup: () => Promise<void>; ownershipFd?: number }> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  let ownershipHandle: fs.FileHandle | undefined;
  try {
    const filePath = path.join(tempDir, fileName);
    if (atomic) {
      await writeJson(filePath, value, { trailingNewline: true });
    } else {
      await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
    }
    if (options?.openOwnershipFd) {
      ownershipHandle = await fs.open(filePath, "r");
    }
    const handle = ownershipHandle;
    return {
      filePath,
      ...(handle ? { ownershipFd: handle.fd } : {}),
      cleanup: async () => {
        // Close before removing: the parent must not keep a descriptor into a
        // directory it has just reclaimed. A close failure (already closed)
        // must not stop the removal.
        await handle?.close().catch(() => {});
        await fs.rm(tempDir, { recursive: true, force: true });
      },
    };
  } catch (err) {
    await ownershipHandle?.close().catch(() => {});
    // Roll the temp dir back if the write fails, so a failed prepare never leaks
    // a dir (the returned cleanup callback is not registered until we return).
    // Swallow a rollback failure so it cannot mask the original error.
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

export function withOpenClawMcpCaptureHeader(
  config: Record<string, unknown>,
  captureKey: string,
  missingServerError?: string,
): Record<string, unknown> {
  const mcpServers = isRecord(config.mcpServers) ? config.mcpServers : {};
  const openclaw = isRecord(mcpServers.openclaw) ? mcpServers.openclaw : undefined;
  if (!openclaw && missingServerError) {
    throw new Error(missingServerError);
  }
  return applyMergePatch(config, {
    mcpServers: {
      openclaw: {
        headers: {
          "x-openclaw-cli-capture-key": captureKey,
        },
      },
    },
  }) as Record<string, unknown>;
}
