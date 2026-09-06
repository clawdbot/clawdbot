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

  it("captures the canonical authority implied by Codex native code mode", async () => {
    const projection = await import("./codex-mcp-projection.js");
    const tools: Array<string | { name: string; pluginId?: string }> = [];
    const captureRef: { value?: { version: 1; source: "final-executable-surface" } } = {};

    await projection.captureFinalCodexCronCreatorToolAllowlist(tools, captureRef, [], {
      nativeToolSurfaceEnabled: true,
    });

    expect(tools).toEqual([{ name: "read" }, { name: "exec" }]);
  });

  it("never projects conditionally available write, edit, apply_patch, or process from native mode", async () => {
    const projection = await import("./codex-mcp-projection.js");
    const tools: Array<string | { name: string; pluginId?: string }> = [];
    const captureRef: { value?: { version: 1; source: "final-executable-surface" } } = {};

    await projection.captureFinalCodexCronCreatorToolAllowlist(tools, captureRef, [], {
      nativeToolSurfaceEnabled: true,
    });

    const names = tools.map((tool) => (typeof tool === "string" ? tool : tool.name));
    for (const conditional of ["write", "edit", "apply_patch", "process"]) {
      expect(names).not.toContain(conditional);
    }
  });

  it("captures apply_patch and process only when the bridged tool surface carries them", async () => {
    const projection = await import("./codex-mcp-projection.js");
    const tools: Array<string | { name: string; pluginId?: string }> = [];
    const captureRef: { value?: { version: 1; source: "final-executable-surface" } } = {};
    const applyPatchTool = {
      name: "apply_patch",
      label: "apply_patch",
      description: "OpenClaw-owned apply_patch bridged into the Codex session.",
      parameters: Type.Object({}),
      execute: async () => ({ content: [], details: {} }),
    } satisfies AnyAgentTool;

    const processTool = { ...applyPatchTool, name: "process", label: "process" };

    await projection.captureFinalCodexCronCreatorToolAllowlist(
      tools,
      captureRef,
      [applyPatchTool, processTool],
      { nativeToolSurfaceEnabled: true },
    );

    const names = tools.map((tool) => (typeof tool === "string" ? tool : tool.name));
    expect(names).toEqual(["apply_patch", "process", "read", "exec"]);
  });

  it("does not invent native authority when Codex code mode is disabled", async () => {
    const projection = await import("./codex-mcp-projection.js");
    const tools: Array<string | { name: string; pluginId?: string }> = [];
    const captureRef: { value?: { version: 1; source: "final-executable-surface" } } = {};

    await projection.captureFinalCodexCronCreatorToolAllowlist(tools, captureRef, [], {
      nativeToolSurfaceEnabled: false,
    });

    expect(tools).toEqual([]);
  });
});
