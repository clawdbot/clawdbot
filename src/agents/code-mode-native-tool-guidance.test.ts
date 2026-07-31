import { describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { wrapNativeCodeModeToolWithGuidance } from "./code-mode-native-tool-guidance.js";

function fakeTool(name: string): AnyAgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: { type: "object" },
    execute: vi.fn(async () => ({
      content: [{ type: "text" as const, text: `${name} result` }],
      details: { name },
      terminate: false,
    })),
  } as AnyAgentTool;
}

describe("wrapNativeCodeModeToolWithGuidance", () => {
  it("adds next-step guidance to the read description without changing its result", async () => {
    const tool = wrapNativeCodeModeToolWithGuidance(fakeTool("read"));

    const result = await tool.execute("call-1", { path: "facts.txt" });

    expect(tool.description).toContain("finish every explicitly requested file read");
    expect(tool.description).toContain("user's requested final format");
    expect(result.content).toEqual([{ type: "text", text: "read result" }]);
    expect(result.details).toEqual({ name: "read" });
    expect(result.terminate).toBe(false);
  });

  it("does not change failed mutation results", async () => {
    const original = fakeTool("write");
    original.execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "write failed" }],
      details: { status: "failed", error: "permission denied" },
    }));
    const tool = wrapNativeCodeModeToolWithGuidance(original);

    const result = await tool.execute("call-1", { path: "result.txt", content: "done" });

    expect(result).toEqual({
      content: [{ type: "text", text: "write failed" }],
      details: { status: "failed", error: "permission denied" },
    });
  });

  it("tells mutation tools to verify instead of repeating the mutation", async () => {
    const tool = wrapNativeCodeModeToolWithGuidance(fakeTool("write"));

    const result = await tool.execute("call-1", { path: "result.txt", content: "done" });

    expect(tool.description).toContain("This mutation is not verification");
    expect(result.content).toEqual([{ type: "text", text: "write result" }]);
    expect(result.details).toEqual({ name: "write" });
    expect(result.terminate).toBe(false);
  });

  it("leaves unrelated native tools unchanged", () => {
    const tool = fakeTool("grep");

    expect(wrapNativeCodeModeToolWithGuidance(tool)).toBe(tool);
  });
});
