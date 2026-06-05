// Bash executor tests cover how oversized command output is persisted for
// owner-only inspection after the model-visible result is truncated.
import { rm, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { executeBashWithOperations } from "./bash-executor.js";
import type { BashOperations } from "./tools/bash-operations.js";

describe("executeBashWithOperations", () => {
  it("stores truncated full output in an owner-only temp file", async () => {
    const operations: BashOperations = {
      exec: async (_command, _cwd, options) => {
        options.onData(Buffer.from("secret output\n".repeat(9000)));
        return { exitCode: 0 };
      },
    };

    const result = await executeBashWithOperations("echo secret", "/tmp", operations);

    expect(result.truncated).toBe(true);
    expect(result.fullOutputPath).toBeDefined();
    // Full output can include secrets printed by a command, so the spill file
    // must be unreadable by group/other accounts.
    const mode = (await stat(result.fullOutputPath!)).mode & 0o777;
    expect(mode & 0o077).toBe(0);
    await rm(result.fullOutputPath!, { force: true });
  });
});
