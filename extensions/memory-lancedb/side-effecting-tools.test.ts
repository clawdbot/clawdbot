import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("memory-lancedb durable tool metadata", () => {
  it.each(["memory_store", "memory_forget"])(
    "declares %s as owner-backed side effect",
    async (toolName) => {
      const manifest = JSON.parse(
        await readFile(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
      ) as { toolMetadata?: Record<string, { sideEffecting?: boolean }> };

      expect(manifest.toolMetadata?.[toolName]?.sideEffecting).toBe(true);
    },
  );
});
