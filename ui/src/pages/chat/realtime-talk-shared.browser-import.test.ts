// @vitest-environment node
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("realtime talk shared browser imports", () => {
  it("keeps embedded run-control runtime out of the Control UI import path", async () => {
    const source = await readFile(new URL("./realtime-talk-shared.ts", import.meta.url), "utf8");

    expect(source).not.toMatch(/\bfrom\s+["'][^"']*\/agent-run-control\.js["']/u);
  });
});
