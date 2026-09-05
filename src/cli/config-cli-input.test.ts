import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readConfigPatchOperations } from "./config-cli-input.js";

const DEEP_CONFIG_DEPTH = 20_000;

function nestedConfigRaw(leaf: string): string {
  return '{"a":'.repeat(DEEP_CONFIG_DEPTH) + leaf + "}".repeat(DEEP_CONFIG_DEPTH);
}

async function withPatchFile<T>(
  contents: string,
  run: (patchPath: string) => Promise<T>,
): Promise<T> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-cli-input-"));
  const patchPath = path.join(tempDir, "patch.json5");
  fs.writeFileSync(patchPath, contents, "utf8");
  try {
    return await run(patchPath);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

describe("readConfigPatchOperations", () => {
  it.each(['{ "channels": { "custom": { "timeout": 1e999 } } }', nestedConfigRaw("1e999")])(
    "rejects patch files containing non-finite numbers",
    async (contents) => {
      await withPatchFile(contents, async (patchPath) => {
        await expect(readConfigPatchOperations({ file: patchPath })).rejects.toThrow(
          "Value must be a finite number",
        );
      });
    },
  );

  it("builds operations from deeply nested input without an engine failure", async () => {
    await withPatchFile(nestedConfigRaw("1"), async (patchPath) => {
      const operations = await readConfigPatchOperations({ file: patchPath });

      expect(operations).toHaveLength(1);
      expect(operations[0]?.setPath).toHaveLength(DEEP_CONFIG_DEPTH);
      expect(operations[0]?.value).toBe(1);
    });
  });
});
