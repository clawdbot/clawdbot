import { truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { readA2UIJsonlFile } from "./a2ui-jsonl-file.js";

const FILE_BYTE_LIMIT = 16 * 1024 * 1024;

describe("readA2UIJsonlFile", () => {
  it("reads a valid A2UI payload above the former 8 MiB limit", async () => {
    await withTempDir("openclaw-canvas-jsonl-", async (tempRoot) => {
      const filePath = path.join(tempRoot, "large.jsonl");
      const jsonl = JSON.stringify({
        surfaceUpdate: {
          surfaceId: "main",
          components: [
            {
              id: "text",
              component: {
                Text: {
                  text: { literalString: "x".repeat(9 * 1024 * 1024) },
                },
              },
            },
          ],
        },
      });
      expect(Buffer.byteLength(jsonl)).toBeGreaterThan(8 * 1024 * 1024);
      expect(Buffer.byteLength(jsonl)).toBeLessThan(FILE_BYTE_LIMIT);
      await writeFile(filePath, jsonl);

      await expect(readA2UIJsonlFile(filePath)).resolves.toBe(jsonl);
    });
  });

  it("rejects an oversized file before reading it into memory", async () => {
    await withTempDir("openclaw-canvas-jsonl-", async (tempRoot) => {
      const filePath = path.join(tempRoot, "oversized.jsonl");
      await writeFile(filePath, "");
      await truncate(filePath, FILE_BYTE_LIMIT + 1);

      await expect(readA2UIJsonlFile(filePath)).rejects.toThrow(
        `File exceeds ${FILE_BYTE_LIMIT} bytes`,
      );
    });
  });
});
