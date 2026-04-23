import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  logDebug: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  logDebug: mocks.logDebug,
  logError: mocks.logError,
}));

let toToolDefinitions: typeof import("./pi-tool-definition-adapter.js").toToolDefinitions;
let wrapToolParamValidation: typeof import("./pi-tools.params.js").wrapToolParamValidation;
let REQUIRED_PARAM_GROUPS: typeof import("./pi-tools.params.js").REQUIRED_PARAM_GROUPS;
let logError: typeof import("../logger.js").logError;

type ToolExecute = ReturnType<
  typeof import("./pi-tool-definition-adapter.js").toToolDefinitions
>[number]["execute"];
const extensionContext = {} as Parameters<ToolExecute>[4];

describe("pi tool definition adapter logging", () => {
  beforeAll(async () => {
    ({ toToolDefinitions } = await import("./pi-tool-definition-adapter.js"));
    ({ wrapToolParamValidation, REQUIRED_PARAM_GROUPS } = await import("./pi-tools.params.js"));
    ({ logError } = await import("../logger.js"));
  });

  beforeEach(() => {
    vi.mocked(logError).mockReset();
    mocks.logDebug.mockReset();
  });

  it("logs raw malformed edit params when required aliases are missing", async () => {
    const baseTool = {
      name: "edit",
      label: "Edit",
      description: "edits files",
      parameters: Type.Object({
        path: Type.String(),
        edits: Type.Array(
          Type.Object({
            oldText: Type.String(),
            newText: Type.String(),
          }),
        ),
      }),
      execute: async () => ({
        content: [{ type: "text" as const, text: "ok" }],
        details: { ok: true },
      }),
    } satisfies AgentTool;

    const tool = wrapToolParamValidation(baseTool, REQUIRED_PARAM_GROUPS.edit);
    const [def] = toToolDefinitions([tool]);
    if (!def) {
      throw new Error("missing tool definition");
    }

    await def.execute("call-edit-1", { path: "notes.txt" }, undefined, undefined, extensionContext);

    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining(
        '[tools] edit failed: Missing required parameter: edits (received: path). Supply correct parameters before retrying. raw_params={"path":"notes.txt"}',
      ),
    );
  });

  it("accepts nested edits arrays for the current edit schema", async () => {
    const execute = vi.fn(async (_toolCallId: string, params: unknown) => ({
      content: [{ type: "text" as const, text: JSON.stringify(params) }],
      details: { ok: true },
    }));
    const baseTool = {
      name: "edit",
      label: "Edit",
      description: "edits files",
      parameters: Type.Object({
        path: Type.String(),
        edits: Type.Array(
          Type.Object({
            oldText: Type.String(),
            newText: Type.String(),
          }),
        ),
      }),
      execute,
    } satisfies AgentTool;

    const tool = wrapToolParamValidation(baseTool, REQUIRED_PARAM_GROUPS.edit);
    const [def] = toToolDefinitions([tool]);
    if (!def) {
      throw new Error("missing tool definition");
    }

    const payload = {
      path: "notes.txt",
      edits: [
        { oldText: "alpha", newText: "beta" },
        { oldText: "gamma", newText: "" },
      ],
    };

    await def.execute("call-edit-batch", payload, undefined, undefined, extensionContext);

    expect(execute).toHaveBeenCalledWith("call-edit-batch", payload, undefined, undefined);
    expect(logError).not.toHaveBeenCalled();
  });
});
