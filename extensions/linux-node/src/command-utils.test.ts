import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import { describe, expect, it } from "vitest";
import { assertToolResult, formatToolError } from "./command-utils.js";

const UNPAIRED_SURROGATE_RE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

function failedCommand(stderr: string): SpawnResult {
  return {
    stdout: "",
    stderr,
    code: 1,
    signal: null,
    killed: false,
    termination: "exit",
  };
}

describe("linux-node command utilities", () => {
  it("keeps truncated tool errors within the limit without splitting surrogate pairs", () => {
    const result = failedCommand(`${"x".repeat(299)}\u{1f600}tail`);
    const detail = formatToolError(result);

    expect(detail).toBe("x".repeat(299));
    expect(detail.length).toBeLessThanOrEqual(300);
    expect(UNPAIRED_SURROGATE_RE.test(detail)).toBe(false);
    expect(() => assertToolResult(result, "TOOL_UNAVAILABLE")).toThrow(
      `TOOL_UNAVAILABLE: ${detail}`,
    );
  });
});
