import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("telegram state migration import boundary", () => {
  it("keeps the runtime message cache off the doctor discovery path", async () => {
    const source = await readFile(new URL("./state-migrations.ts", import.meta.url), "utf8");

    expect(source).toContain('from "./message-cache-persistence.js"');
    expect(source).not.toContain('from "./message-cache.js"');
  });
});
