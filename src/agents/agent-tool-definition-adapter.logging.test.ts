/**
 * Logging tests for tool adapter failures.
 * Verifies retryable parameter errors expose useful context while intentional
 * hook blocks and exec secrets stay out of raw logs.
 */
import type { AgentTool } from "openclaw/plugin-sdk/agent-core";
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

let toToolDefinitions: typeof import("./agent-tool-definition-adapter.js").toToolDefinitions;
let createBeforeToolCallBlockedError: typeof import("./agent-tools.before-tool-call.test-support.js").createBeforeToolCallBlockedError;
let wrapToolParamValidation: typeof import("./agent-tools.params.js").wrapToolParamValidation;
let REQUIRED_PARAM_GROUPS: typeof import("./agent-tools.params.js").REQUIRED_PARAM_GROUPS;
let logError: typeof import("../logger.js").logError;

type ToolExecute = ReturnType<
  typeof import("./agent-tool-definition-adapter.js").toToolDefinitions
>[number]["execute"];
const extensionContext = {} as Parameters<ToolExecute>[4];

function firstLogErrorMessage(): unknown {
  return vi.mocked(logError).mock.calls[0]?.[0];
}

describe("agent tool definition adapter logging", () => {
  beforeAll(async () => {
    ({ toToolDefinitions } = await import("./agent-tool-definition-adapter.js"));
    ({ createBeforeToolCallBlockedError } =
      await import("./agent-tools.before-tool-call.test-support.js"));
    ({ wrapToolParamValidation, REQUIRED_PARAM_GROUPS } = await import("./agent-tools.params.js"));
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
        throw createBeforeToolCallBlockedError("blocked by policy");
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

  it("omits raw exec commands and env values from failure logs", async () => {
    const commandSecret = "issue85049-xai-cleartext-token-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
    const envSecret = "issue85049-env-cleartext-token-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
    const baseTool = {
      name: "exec",
      label: "exec",
      description: "runs commands",
      parameters: Type.Object({
        command: Type.String(),
        env: Type.Optional(Type.Record(Type.String(), Type.String())),
        timeout: Type.Optional(Type.Number()),
      }),
      execute: async () => {
        throw new Error("exec denied: allowlist miss");
      },
    } satisfies AgentTool;
    const [def] = toToolDefinitions([baseTool]);
    if (!def) {
      throw new Error("missing tool definition");
    }

    await def.execute(
      "call-exec-denied",
      {
        command: `export XAI_API_KEY=\\"${commandSecret}\\" && echo blocked`,
        env: {
          OPENAI_API_KEY: envSecret,
        },
        timeout: 5,
      },
      undefined,
      undefined,
      extensionContext,
    );

    const message = String(firstLogErrorMessage());
    expect(message).toContain("[tools] exec failed: exec denied: allowlist miss");
    expect(message).toContain('"command":{"omitted":true');
    expect(message).toContain('"reason":"exec command may contain credentials"');
    expect(message).toContain('"chars":');
    expect(message).toMatch(/"sha256":"[a-f0-9]{16}"/u);
    expect(message).toContain('"env":{"OPENAI_API_KEY":"[omitted exec env value]"}');
    expect(message).toContain('"timeout":5');
    expect(message).not.toContain(commandSecret);
    expect(message).not.toContain(envSecret);
    expect(message).not.toContain("export XAI_API_KEY");
  });

  it("omits raw exec commands from JSON-string failure params", async () => {
    const commandSecret = "issue85049-json-cleartext-token-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
    const baseTool = {
      name: "exec",
      label: "exec",
      description: "runs commands",
      parameters: Type.Any(),
      execute: async () => {
        throw new Error("exec denied: allowlist miss");
      },
    } satisfies AgentTool;
    const [def] = toToolDefinitions([baseTool]);
    if (!def) {
      throw new Error("missing tool definition");
    }

    await def.execute(
      "call-exec-denied-json-string",
      JSON.stringify({
        command: `export XAI_API_KEY=\\"${commandSecret}\\" && echo blocked`,
        timeout: 5,
      }),
      undefined,
      undefined,
      extensionContext,
    );

    const message = String(firstLogErrorMessage());
    expect(message).toContain('"command":{"omitted":true');
    expect(message).toContain('"reason":"exec command may contain credentials"');
    expect(message).toContain('"timeout":5');
    expect(message).not.toContain(commandSecret);
    expect(message).not.toContain("export XAI_API_KEY");
  });

  it("omits malformed exec command and env values from failure logs", async () => {
    const commandSecret =
      "issue85049-malformed-command-cleartext-token-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
    const envSecret =
      "issue85049-malformed-env-cleartext-token-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
    const baseTool = {
      name: "exec",
      label: "exec",
      description: "runs commands",
      parameters: Type.Any(),
      execute: async () => {
        throw new Error("exec denied: allowlist miss");
      },
    } satisfies AgentTool;
    const [def] = toToolDefinitions([baseTool]);
    if (!def) {
      throw new Error("missing tool definition");
    }

    await def.execute(
      "call-exec-denied-malformed",
      {
        command: [`export XAI_API_KEY=\\"${commandSecret}\\" && echo blocked`],
        env: `OPENAI_API_KEY=${envSecret}`,
      },
      undefined,
      undefined,
      extensionContext,
    );

    const message = String(firstLogErrorMessage());
    expect(message).toContain('"command":{"omitted":true');
    expect(message).toContain('"type":"array"');
    expect(message).toContain('"env":"[omitted exec env]"');
    expect(message).not.toContain(commandSecret);
    expect(message).not.toContain(envSecret);
    expect(message).not.toContain("export XAI_API_KEY");
  });

  it("omits cmd-style exec payloads from normalized bash failure logs", async () => {
    const commandSecret =
      "issue85049-cmd-alias-cleartext-token-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
    const baseTool = {
      name: "bash",
      label: "Bash",
      description: "runs commands",
      parameters: Type.Any(),
      execute: async () => {
        throw new Error("exec denied: allowlist miss");
      },
    } satisfies AgentTool;
    const [def] = toToolDefinitions([baseTool]);
    if (!def) {
      throw new Error("missing tool definition");
    }

    await def.execute(
      "call-bash-denied-cmd-alias",
      {
        cmd: `export XAI_API_KEY=\\"${commandSecret}\\" && echo blocked`,
        timeout: 5,
      },
      undefined,
      undefined,
      extensionContext,
    );

    const message = String(firstLogErrorMessage());
    expect(message).toContain("[tools] exec failed: exec denied: allowlist miss");
    expect(message).toContain('"cmd":{"omitted":true');
    expect(message).toContain('"reason":"exec command may contain credentials"');
    expect(message).toContain('"timeout":5');
    expect(message).not.toContain(commandSecret);
    expect(message).not.toContain("export XAI_API_KEY");
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
