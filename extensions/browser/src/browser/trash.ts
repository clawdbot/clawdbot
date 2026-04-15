import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateSecureToken } from "../infra/secure-random.js";
import { runExec } from "../process/exec.js";

export async function movePathToTrash(targetPath: string): Promise<string> {
  try {
    await runExec("trash", [targetPath], { timeoutMs: 10_000 });
    return targetPath;
  } catch {
    const trashDir = path.join(os.homedir(), ".Trash");
    fs.mkdirSync(trashDir, { recursive: true });
    const base = path.basename(targetPath);
    let dest = path.join(trashDir, `${base}-${Date.now()}`);
    if (fs.existsSync(dest)) {
      dest = path.join(trashDir, `${base}-${Date.now()}-${generateSecureToken(6)}`);
    }
    fs.renameSync(targetPath, dest);
    return dest;
  }
}
