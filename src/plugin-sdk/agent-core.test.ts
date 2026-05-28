import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("plugin-sdk/agent-core", () => {
  it("keeps public declaration imports package-relative", () => {
    const source = readFileSync(resolve(process.cwd(), "src/plugin-sdk/agent-core.ts"), "utf8");

    expect(source).toContain("../../packages/agent-core/src/index.js");
    expect(source).not.toContain("../agents/runtime/index.js");
  });
});
