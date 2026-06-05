/** Child-process wrapper used by daemon installers to preserve stdout/stderr on failure. */
import { execFile, type ExecFileOptionsWithStringEncoding } from "node:child_process";

type ExecResult = { stdout: string; stderr: string; code: number };

/** Runs a child process as UTF-8 and returns exit data instead of throwing on nonzero exit. */
export async function execFileUtf8(
  command: string,
  args: string[],
  options: Omit<ExecFileOptionsWithStringEncoding, "encoding"> = {},
): Promise<ExecResult> {
  return await new Promise<ExecResult>((resolve) => {
    execFile(command, args, { ...options, encoding: "utf8" }, (error, stdout, stderr) => {
      if (!error) {
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          code: 0,
        });
        return;
      }

      const e = error as { code?: unknown; message?: unknown };
      const stderrText = stderr ?? "";
      resolve({
        stdout: stdout ?? "",
        stderr:
          stderrText ||
          (typeof e.message === "string" ? e.message : typeof error === "string" ? error : ""),
        code: typeof e.code === "number" ? e.code : 1,
      });
    });
  });
}
