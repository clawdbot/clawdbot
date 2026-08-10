import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  evaluateWrapperShadowing,
  type WrapperShadowingViolation,
} from "../../scripts/check-wrapper-shadowing.mts";
import { withTempDir } from "../../src/test-utils/temp-dir.js";

const guardScriptPath = fileURLToPath(
  new URL("../../scripts/check-wrapper-shadowing.mts", import.meta.url),
);

type GuardFixture = {
  baseline?: WrapperShadowingViolation[];
  files: Record<string, string>;
};

async function runFixture(fixture: GuardFixture) {
  return await withTempDir("openclaw-wrapper-shadowing-", async (repoRoot) => {
    await Promise.all(
      Object.entries(fixture.files).map(async ([repoPath, content]) => {
        const filePath = path.join(repoRoot, repoPath);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, content);
      }),
    );
    const baselinePath = path.join(repoRoot, "scripts/lib/wrapper-shadowing-baseline.json");
    await fs.mkdir(path.dirname(baselinePath), { recursive: true });
    await fs.writeFile(baselinePath, `${JSON.stringify(fixture.baseline ?? [], null, 2)}\n`);
    return await evaluateWrapperShadowing(repoRoot);
  });
}

const directViolation: GuardFixture["files"] = {
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
    const result = await runFixture({ files: directViolation });

    expect(result.regressions).toEqual([
      { name: "runTask", wrapped: "src/inner.ts", wrapper: "src/outer.ts" },
    ]);
  });

  it("passes for a pure re-export", async () => {
    const result = await runFixture({
      files: {
        "src/inner.ts": "export function runTask() { return 'inner'; }\n",
        "src/outer.ts": 'export { runTask } from "./inner.js";\n',
      },
    });

    expect(result.current).toEqual([]);
    expect(result.regressions).toEqual([]);
  });

  it("passes for a baselined violation", async () => {
    const violation = { name: "runTask", wrapped: "src/inner.ts", wrapper: "src/outer.ts" };
    const result = await runFixture({
      baseline: [
        violation,
        { name: "removedTask", wrapped: "src/old-inner.ts", wrapper: "src/old-outer.ts" },
      ],
      files: directViolation,
    });

    expect(result.current).toEqual([violation]);
    expect(result.regressions).toEqual([]);
  });

  it("fails for a new violation on top of the baseline", async () => {
    const baseline = { name: "runTask", wrapped: "src/inner.ts", wrapper: "src/outer.ts" };
    const result = await runFixture({
      baseline: [baseline],
      files: {
        ...directViolation,
        "src/barrel.ts": 'export { sendTask } from "./sender.js";\n',
        "src/sender.ts": "export const sendTask = () => 'sent';\n",
        "src/send-wrapper.ts": [
          'import { sendTask as sendTaskInner } from "./barrel.js";',
          "export const sendTask = (...args: unknown[]) => {",
          "  recordSend();",
          "  return sendTaskInner(...args);",
          "};",
        ].join("\n"),
      },
    });

    expect(result.regressions).toEqual([
      {
        name: "sendTask",
        wrapped: "src/sender.ts",
        wrapper: "src/send-wrapper.ts",
        via: "src/barrel.ts",
      },
    ]);
  });

  it("ends failures with the wrapper trailer", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", guardScriptPath, "--invalid"], {
      encoding: "utf8",
    });

    expect(result.status).toBe(2);
    expect(result.stderr.trimEnd().split("\n").at(-1)).toBe(
      "[check-wrapper-shadowing] FAILED (exit 2)",
    );
  });
});
