/**
 * sessions.list resolves row owners through the session SQLite target path.
 * That owner read must reuse a process-held handle instead of opening per row.
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "../..");

test.runIf(process.platform !== "win32")(
  "sessions.list owner reads reuse the process-held connection",
  async () => {
    const probePath = path.join(import.meta.dirname, "test", "session-connection-reuse.probe.ts");
    const result = await execFileAsync(process.execPath, ["--import", "tsx", probePath], {
      cwd: repoRoot,
      maxBuffer: 1024 * 1024,
    });

    expect(JSON.parse(result.stdout) as unknown).toEqual({ inspections: 40 });
  },
);
