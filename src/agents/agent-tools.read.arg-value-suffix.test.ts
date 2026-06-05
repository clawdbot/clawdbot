/**
 * Tests malformed XML arg_value suffix cleanup for read paths.
 * The wrapper should repair path params without touching unrelated payloads.
 */
import { describe, expect, it, vi } from "vitest";
import { createOpenClawReadTool } from "./agent-tools.read.js";
import type { AnyAgentTool } from "./agent-tools.types.js";

describe("createOpenClawReadTool malformed XML arg-value suffix handling", () => {
  it("strips the suffix from read paths before invoking the base tool", async () => {
    const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }] }));
    const base = {
      name: "read",
      label: "read",
      description: "read a file",
      parameters: {},
      execute,
    } as unknown as AnyAgentTool;
    const tool = createOpenClawReadTool(base);

    await tool.execute("read-1", { path: "notes.txt</arg_value>>" });

    expect(execute).toHaveBeenCalledWith(
      "read-1",
      {
        path: "notes.txt",
        offset: 1,
      },
      undefined,
    );
  });

  it("rejects read paths that become empty after suffix stripping", async () => {
    const execute = vi.fn();
    const base = {
      name: "read",
      label: "read",
      description: "read a file",
      parameters: {},
      execute,
    } as unknown as AnyAgentTool;
    const tool = createOpenClawReadTool(base);

    await expect(tool.execute("read-1", { path: "</arg_value>>" })).rejects.toThrow(
      /Missing required parameter: path/,
    );
    expect(execute).not.toHaveBeenCalled();
  });
});
