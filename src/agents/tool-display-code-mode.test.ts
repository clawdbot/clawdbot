import { describe, expect, it } from "vitest";
import { formatToolDetail, isCommandBearingToolCall, resolveToolDisplay } from "./tool-display.js";

describe("Code Mode tool display", () => {
  it("does not present JavaScript as a shell command", () => {
    const args = {
      code: 'return await read({ path: "src/agents/code-mode.ts" });',
      command: 'return await read({ path: "src/agents/code-mode.ts" });',
      language: "javascript",
    };

    expect(isCommandBearingToolCall("exec", args)).toBe(false);
    expect(formatToolDetail(resolveToolDisplay({ name: "exec", args }))).toBe(
      "run JavaScript workflow",
    );
  });
});
