import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeNewWindowsBatchContent } from "../../infra/windows-batch.js";

export async function writeRestartScriptFile(filename: string, content: string): Promise<string> {
  const scriptDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restart-"));
  const scriptPath = path.join(scriptDir, filename);
  try {
    await fs.writeFile(scriptPath, normalizeNewWindowsBatchContent(filename, content), {
      mode: 0o755,
      flag: "wx",
    });
  } catch (error) {
    await fs.rm(scriptDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return scriptPath;
}
