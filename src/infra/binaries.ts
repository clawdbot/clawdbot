import { runExec } from "../process/exec.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";

export async function ensureBinary(
  name: string,
  exec: typeof runExec = runExec,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  // Abort early if a required CLI tool is missing.
  // Use `where` on Windows, `which` elsewhere.
  const cmd = process.platform === "win32" ? "where" : "which";
  await exec(cmd, [name]).catch(() => {
    runtime.error(`Missing required binary: ${name}. Please install it.`);
    runtime.exit(1);
  });
}
