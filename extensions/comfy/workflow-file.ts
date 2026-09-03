// Comfy workflow file helpers preserve the direct UTF-8 read for unconfigured
// workflowPath files and bound local reads when the operator configures an
// explicit workflowFileMaxBytes limit.
import fs from "node:fs/promises";
import { FsSafeError, readRegularFile } from "openclaw/plugin-sdk/security-runtime";

export async function readComfyWorkflowFile(
  filePath: string,
  maxBytes: number | undefined,
): Promise<string> {
  if (maxBytes === undefined) {
    return fs.readFile(filePath, "utf8");
  }
  try {
    // Preserve configured symlink paths while still rejecting FIFOs and other special files.
    return (
      await readRegularFile({ filePath: await fs.realpath(filePath), maxBytes })
    ).buffer.toString("utf8");
  } catch (error) {
    if (error instanceof FsSafeError && error.code === "too-large") {
      throw workflowFileTooLargeError(filePath, maxBytes, error);
    }
    throw error;
  }
}

function workflowFileTooLargeError(filePath: string, maxBytes: number, cause?: unknown): Error {
  return new Error(
    `Comfy workflow at ${filePath} exceeds ${maxBytes} bytes; raise the plugins.entries.comfy.config.workflowFileMaxBytes setting only when the downstream Comfy service accepts the larger serialized prompt request`,
    { cause },
  );
}
