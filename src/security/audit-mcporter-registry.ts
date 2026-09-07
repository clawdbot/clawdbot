// Bounded read of the global MCP registry for security audit.
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const MAX_MCPORTER_REGISTRY_BYTES = 16 * 1024 * 1024;
const READ_CHUNK_SIZE = 64 * 1024;

export type McporterRegistryRejectReason = "oversized" | "unreadable" | "non-regular" | "malformed";

// Missing means no registry exists (non-actionable); rejected means a registry
// exists but could not be safely inspected, so the audit must warn instead of
// silently dropping the MCP boundary input.
export type McporterRegistryReadOutcome =
  | { status: "ok"; value: unknown }
  | { status: "missing" }
  | { status: "rejected"; reason: McporterRegistryRejectReason };

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

export async function readBoundedMcporterRegistry(
  stateDir: string,
): Promise<McporterRegistryReadOutcome> {
  const registryPath = path.join(stateDir, "skills", "config", "mcporter.json");
  let handle: fs.FileHandle | undefined;
  try {
    // Open without O_NOFOLLOW so valid symlinked registries are followed,
    // while still bounding the read to avoid audit OOM on oversized targets.
    handle = await fs.open(registryPath, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    // ENOENT (including a dangling symlink) means no registry; anything else
    // means one exists but cannot be inspected.
    return isEnoent(error) ? { status: "missing" } : { status: "rejected", reason: "unreadable" };
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      return { status: "rejected", reason: "non-regular" };
    }
    if (stat.size > MAX_MCPORTER_REGISTRY_BYTES) {
      return { status: "rejected", reason: "oversized" };
    }
    const chunks: Buffer[] = [];
    const scratch = Buffer.allocUnsafe(Math.min(READ_CHUNK_SIZE, MAX_MCPORTER_REGISTRY_BYTES + 1));
    let total = 0;
    while (true) {
      const { bytesRead } = await handle.read(scratch, 0, scratch.length, null);
      if (bytesRead === 0) {
        break;
      }
      total += bytesRead;
      if (total > MAX_MCPORTER_REGISTRY_BYTES) {
        return { status: "rejected", reason: "oversized" };
      }
      chunks.push(Buffer.from(scratch.subarray(0, bytesRead)));
    }
    let value: unknown;
    try {
      value = JSON.parse(Buffer.concat(chunks, total).toString("utf-8"));
    } catch {
      return { status: "rejected", reason: "malformed" };
    }
    return { status: "ok", value };
  } catch {
    return { status: "rejected", reason: "unreadable" };
  } finally {
    await handle.close();
  }
}
