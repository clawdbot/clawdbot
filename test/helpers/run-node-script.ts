import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import { createBoundedChildOutput } from "./bounded-child-output.js";

export async function runNodeScript(
  scriptPathOrArgs: string | string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  { cwd }: { cwd?: string } = {},
) {
  const stdout = createBoundedChildOutput();
  const stderr = createBoundedChildOutput();
  let status: number | null = null;
  let error: unknown;
  try {
    status = await runManagedCommand({
      bin: process.execPath,
      args: typeof scriptPathOrArgs === "string" ? [scriptPathOrArgs] : scriptPathOrArgs,
      cwd,
      env,
      timeoutMs,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      onReady(child) {
        child.stdout!.on("data", stdout.append);
        child.stderr!.on("data", stderr.append);
      },
    });
  } catch (cause) {
    error = cause;
  }
  return { error, status, stderr: stderr.text(), stdout: stdout.text() };
}
