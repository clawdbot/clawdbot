import type { AgentTool } from "@earendil-works/pi-agent-core";
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
let BeforeToolCallBlockedError: typeof import("./pi-tools.before-tool-call.js").BeforeToolCallBlockedError;
let wrapToolParamValidation: typeof import("./pi-tools.params.js").wrapToolParamValidation;
let REQUIRED_PARAM_GROUPS: typeof import("./pi-tools.params.js").REQUIRED_PARAM_GROUPS;
let logError: typeof import("../logger.js").logError;

type ToolExecute = ReturnType<
  typeof import("./pi-tool-definition-adapter.js").toToolDefinitions
>[number]["execute"];
const extensionContext = {} as Parameters<ToolExecute>[4];

function firstLogErrorMessage(): unknown {
  return vi.mocked(logError).mock.calls[0]?.[0];
}

describe("pi tool definition adapter logging", () => {
  beforeAll(async () => {
    ({ toToolDefinitions } = await import("./pi-tool-definition-adapter.js"));
    ({ BeforeToolCallBlockedError } = await import("./pi-tools.before-tool-call.js"));
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

    expect(firstLogErrorMessage()).toContain(
      '[tools] edit failed: Missing required parameter: edits (received: path). Supply correct parameters before retrying. raw_params={"path":"notes.txt"}',
    );
  });

  it("does not log raw params for intentional before_tool_call blocks", async () => {
    const baseTool = {
      name: "bash",
      label: "Bash",
      description: "runs commands",
      parameters: Type.Object({
        command: Type.String(),
      }),
      execute: async () => {
        throw new BeforeToolCallBlockedError("blocked by policy");
      },
    } satisfies AgentTool;
    const [def] = toToolDefinitions([baseTool]);
    if (!def) {
      throw new Error("missing tool definition");
    }

    const result = await def.execute(
      "call-blocked-1",
      { command: "secret-value" },
      undefined,
      undefined,
      extensionContext,
    );

    const details = result.details as
      | { status?: string; deniedReason?: string; reason?: string }
      | undefined;
    expect(details?.status).toBe("blocked");
    expect(details?.deniedReason).toBe("plugin-before-tool-call");
    expect(details?.reason).toBe("blocked by policy");
    expect(logError).not.toHaveBeenCalled();
    expect(mocks.logDebug).toHaveBeenCalledWith(
      "tools: exec blocked by before_tool_call: blocked by policy",
    );
  });

  it("logs provider AbortError failures when the agent run was not aborted", async () => {
    const baseTool = {
      name: "web_search",
      label: "Web Search",
      description: "searches",
      parameters: Type.Object({
        query: Type.String(),
      }),
      execute: async () => {
        const error = new Error("This operation was aborted");
        error.name = "AbortError";
        throw error;
      },
    } satisfies AgentTool;
    const [def] = toToolDefinitions([baseTool]);
    if (!def) {
      throw new Error("missing tool definition");
    }

    const result = await def.execute(
      "call-web-search-abort",
      { query: "OpenClaw" },
      undefined,
      undefined,
      extensionContext,
    );

    const details = result.details as
      | { status?: string; tool?: string; error?: string }
      | undefined;
    expect(details?.status).toBe("error");
    expect(details?.tool).toBe("web_search");
    expect(details?.error).toBe("This operation was aborted");
    expect(firstLogErrorMessage()).toContain(
      "[tools] web_search failed: This operation was aborted",
    );
  });

  it("rethrows AbortError failures when the agent run signal was aborted", async () => {
    const baseTool = {
      name: "web_search",
      label: "Web Search",
      description: "searches",
      parameters: Type.Object({
        query: Type.String(),
      }),
      execute: async () => {
        const error = new Error("This operation was aborted");
        error.name = "AbortError";
        throw error;
      },
    } satisfies AgentTool;
    const [def] = toToolDefinitions([baseTool]);
    if (!def) {
      throw new Error("missing tool definition");
    }
    const controller = new AbortController();
    controller.abort();

    let thrown: unknown;
    try {
      await def.execute(
        "call-web-search-agent-abort",
        { query: "OpenClaw" },
        controller.signal,
        undefined,
        extensionContext,
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).toBe("AbortError");
    expect((thrown as Error).message).toBe("This operation was aborted");
    expect(logError).not.toHaveBeenCalled();
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
