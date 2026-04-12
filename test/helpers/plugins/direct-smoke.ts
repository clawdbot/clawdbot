import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const SHARED_IMPORT_ENV = {
  HOME: process.env.HOME,
  NODE_OPTIONS: process.env.NODE_OPTIONS,
  NODE_PATH: process.env.NODE_PATH,
  PATH: process.env.PATH,
  TERM: process.env.TERM,
} satisfies NodeJS.ProcessEnv;

export async function runDirectImportSmoke(code: string): Promise<string> {
  const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", "-e", code], {
    cwd: repoRoot,
    env: SHARED_IMPORT_ENV,
    timeout: 40_000,
  });

  return stdout;
}
