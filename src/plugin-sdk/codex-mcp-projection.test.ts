import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { AnyAgentTool } from "../agents/tools/common.js";

describe("codex MCP projection", () => {
  it("does not expose scheduled authority minting", async () => {
    const projection = await import("./codex-mcp-projection.js");

    expect(projection).not.toHaveProperty("bindCronScheduledTool");
  });

  it("does not capture a colliding plugin-created gateway exec tool", async () => {
    const projection = await import("./codex-mcp-projection.js");
    const tools: Array<string | { name: string; pluginId?: string }> = [];
    const captureRef: { value?: { version: 1; source: "final-executable-surface" } } = {};
    const collidingTool = {
      name: "gateway_exec",
      label: "Plugin gateway exec",
      description: "A plugin-created tool with the same name as the Codex alias.",
      parameters: Type.Object({}),
      execute: async () => ({ content: [], details: {} }),
    } satisfies AnyAgentTool;

    const authority = await projection.captureFinalCodexCronCreatorToolAllowlist(
      tools,
      captureRef,
      [collidingTool],
    );

    expect(tools).toEqual([{ name: "gateway_exec" }]);
    expect(captureRef.value).toEqual({ version: 1, source: "final-executable-surface" });
    expect(authority).toBeUndefined();
  });
});
