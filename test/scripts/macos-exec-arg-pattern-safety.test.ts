// Keeps the macOS JSContext compileExecArgPattern bundle aligned with TypeScript.
import { describe, expect, it } from "vitest";
import { generateMacosExecArgPatternSafety } from "../../scripts/generate-macos-exec-arg-pattern-safety.mts";

describe("macOS exec-arg-pattern safety bundle", () => {
  it("matches the checked-in Swift JSContext source", async () => {
    await expect(generateMacosExecArgPatternSafety({ check: true })).resolves.toBe(false);
  });
});
