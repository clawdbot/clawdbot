// Workspace test helpers build isolated workspace directories for tests.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Workspace fixture helpers for tests that need a real cwd with small files.
export async function makeTempWorkspace(prefix = "openclaw-workspace-"): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

// Write a file under a temp workspace and return its absolute path for callers
// that pass fixture files into CLI/runtime APIs.
export async function writeWorkspaceFile(params: {
  dir: string;
  name: string;
  content: string;
}): Promise<string> {
  const filePath = path.join(params.dir, params.name);
  await fs.writeFile(filePath, params.content, "utf-8");
  return filePath;
}
