import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { collectRepositoryWrapperShadowing } from "../../scripts/check-wrapper-shadowing.mts";
import { withTempDir } from "../../src/test-utils/temp-dir.js";

const guardScriptPath = fileURLToPath(
  new URL("../../scripts/check-wrapper-shadowing.mts", import.meta.url),
);

type GuardFixture = Record<string, string>;

async function runFixture(files: GuardFixture) {
  return await withTempDir("openclaw-wrapper-shadowing-", async (repoRoot) => {
    await Promise.all(
      Object.entries(files).map(async ([repoPath, content]) => {
        const filePath = path.join(repoRoot, repoPath);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, content);
      }),
    );
    return await collectRepositoryWrapperShadowing(repoRoot);
  });
}

const directViolation: GuardFixture = {
  "src/inner.ts": "export function runTask() { return 'inner'; }\n",
  "src/outer.ts": [
    'import { runTask as runTaskInner } from "./inner.js";',
    "export function runTask() {",
    "  prepareTask();",
    "  return runTaskInner();",
    "}",
  ].join("\n"),
};

describe("wrapper shadowing guard", () => {
  it("fails for a same-name wrapper around an imported implementation", async () => {
    const result = await runFixture(directViolation);

    expect(result).toEqual([{ name: "runTask", wrapped: "src/inner.ts", wrapper: "src/outer.ts" }]);
  });

  it("passes for a pure re-export", async () => {
    const result = await runFixture({
      "src/inner.ts": "export function runTask() { return 'inner'; }\n",
      "src/outer.ts": 'export { runTask } from "./inner.js";\n',
    });

    expect(result).toEqual([]);
  });

  it("rejects debt-baseline updates with the wrapper trailer", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", guardScriptPath, "--update-debt-baseline"],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(2);
    expect(result.stderr.trimEnd().split("\n").at(-1)).toBe(
      "[check-wrapper-shadowing] FAILED (exit 2)",
    );
  });
});
