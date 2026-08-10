import { readRegularFile } from "openclaw/plugin-sdk/security-runtime";

// Keep both Canvas file entry points on the same allocation ceiling. GatewayClient
// separately enforces the exact encoded frame against the negotiated maxPayload.
const MAX_A2UI_JSONL_FILE_BYTES = 16 * 1024 * 1024;

/** Reads an A2UI JSONL file without unbounded buffering. */
export async function readA2UIJsonlFile(filePath: string): Promise<string> {
  const { buffer } = await readRegularFile({
    filePath,
    maxBytes: MAX_A2UI_JSONL_FILE_BYTES,
  });
  return buffer.toString("utf8");
}
