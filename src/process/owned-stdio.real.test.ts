import { expect, it } from "vitest";
import { closeOwnedStdioProcess, createOwnedStdioProcess } from "./owned-stdio.js";

it.skipIf(process.platform === "win32")(
  "drains protocol output and shutdown diagnostics before confirming real stdio cleanup",
  async () => {
    const diagnostic = "shutdown: 🌊\n".repeat(8192);
    const child = await createOwnedStdioProcess({
      argv: [
        process.execPath,
        "-e",
        `process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write("done\\n", () => {
    process.stderr.write("shutdown: 🌊\\n".repeat(8192), () => process.exit(0));
  });
});`,
      ],
      env: {},
      exactEnv: true,
    });
    let stdout = "";
    let stderr = "";
    child.onStdout((chunk) => {
      stdout += chunk;
    });
    child.onStderr((chunk) => {
      stderr += chunk;
    });
    const result = child.wait();
    try {
      await closeOwnedStdioProcess(child);
      await expect(result).resolves.toEqual({ code: 0, signal: null });
      expect(stdout).toBe("done\n");
      expect(stderr).toBe(diagnostic);
    } finally {
      await closeOwnedStdioProcess(child, { force: true }).catch(() => undefined);
    }
  },
);
