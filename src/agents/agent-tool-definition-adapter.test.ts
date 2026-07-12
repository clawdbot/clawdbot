/**
 * Unit coverage for adapting runtime and client-hosted tools.
 * Exercises result coercion, error wrapping, client delegation, and conflict
 * detection at the ToolDefinition boundary.
 */
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import type { AgentTool } from "openclaw/plugin-sdk/agent-core";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import {
  createClientToolNameConflictError,
  findClientToolNameConflicts,
  isClientToolNameConflictError,
  toClientToolDefinitions,
  toToolDefinitions,
} from "./agent-tool-definition-adapter.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.js";
import { createExecTool } from "./bash-tools.exec.js";
import type { ClientToolDefinition } from "./embedded-agent-runner/run/params.js";

type ToolExecute = ReturnType<typeof toToolDefinitions>[number]["execute"];
const extensionContext = {} as Parameters<ToolExecute>[4];
const CLIENT_TOOL_NAME_CONFLICT_PREFIX = "client tool name conflict:";

async function executeThrowingTool(name: string, callId: string) {
  const tool = {
    name,
    label: name === "bash" ? "Bash" : "Boom",
    description: "throws",
    parameters: Type.Object({}),
    execute: async () => {
      throw new Error("nope");
    },
  } satisfies AgentTool;

  const defs = toToolDefinitions([tool]);
  const def = defs[0];
  if (!def) {
    throw new Error("missing tool definition");
  }
  return await def.execute(callId, {}, undefined, undefined, extensionContext);
}

async function executeTool(tool: AgentTool, callId: string) {
  const defs = toToolDefinitions([tool]);
  const def = defs[0];
  if (!def) {
    throw new Error("missing tool definition");
  }
  return await def.execute(callId, {}, undefined, undefined, extensionContext);
}

describe("agent tool definition adapter", () => {
  it("preserves argument preparation and execution mode contracts", () => {
    const prepareArguments = vi.fn((args: unknown) => args as Record<string, never>);
    const tool = {
      name: "serial_tool",
      label: "Serial Tool",
      description: "runs sequentially",
      parameters: Type.Object({}),
      prepareArguments,
      executionMode: "sequential",
      execute: async () => ({
        content: [{ type: "text", text: "done" }],
        details: {},
      }),
    } satisfies AgentTool;

    const [definition] = toToolDefinitions([tool]);

    expect(definition?.prepareArguments).toBe(prepareArguments);
    expect(definition?.executionMode).toBe("sequential");
  });

  it("wraps tool errors into a tool result", async () => {
    const result = await executeThrowingTool("boom", "call1");

    const details = result.details as
      | { status?: string; tool?: string; error?: string }
      | undefined;
    expect(details?.status).toBe("error");
    expect(details?.tool).toBe("boom");
    expect(details?.error).toBe("nope");
    expect(JSON.stringify(result.details)).not.toContain("\n    at ");
  });

  it("normalizes exec tool aliases in error results", async () => {
    const result = await executeThrowingTool("bash", "call2");

    const details = result.details as
      | { status?: string; tool?: string; error?: string }
      | undefined;
    expect(details?.status).toBe("error");
    expect(details?.tool).toBe("exec");
    expect(details?.error).toBe("nope");
  });

  it("preserves exec deny before prepared workdir failures", async () => {
    const tool = createExecTool({
      security: "deny",
      ask: "off",
    });
    const [definition] = toToolDefinitions([tool]);
    const missingWorkdir = path.join(os.tmpdir(), `openclaw-missing-denied-cwd-${Date.now()}`);

    const existing = await expectDefined(definition, "definition test invariant").execute(
      "call-denied-existing-cwd",
      {
        command: "echo denied",
        workdir: process.cwd(),
      },
      undefined,
      undefined,
      extensionContext,
    );
    const missing = await expectDefined(definition, "definition test invariant").execute(
      "call-denied-missing-cwd",
      {
        command: "echo denied",
        workdir: missingWorkdir,
      },
      undefined,
      undefined,
      extensionContext,
    );

    const expected = {
      status: "error",
      error: "exec denied: host=gateway security=deny",
    };
    expect(existing.details).toMatchObject(expected);
    expect(missing.details).toMatchObject(expected);
    expect(JSON.stringify(missing)).not.toContain("unavailable or not a directory");
  });

  it("does not validate backend sandbox workdirs before exec deny", async () => {
    const validateWorkdir = vi.fn(async (workdir: string) => workdir);
    const tool = createExecTool({
      host: "sandbox",
      security: "deny",
      ask: "off",
      sandbox: {
        containerName: "remote-sandbox-workdir-test",
        workspaceDir: process.cwd(),
        containerWorkdir: "/remote/workspace",
        workdirValidation: "backend",
        validateWorkdir,
      },
    });
    const [definition] = toToolDefinitions([tool]);

    const result = await expectDefined(definition, "definition test invariant").execute(
      "call-denied-backend-cwd",
      {
        command: "echo denied",
        workdir: "/remote/workspace/generated",
      },
      undefined,
      undefined,
      extensionContext,
    );

    expect(result.details).toMatchObject({
      status: "error",
      error: "exec denied: host=sandbox security=deny",
    });
    expect(validateWorkdir).not.toHaveBeenCalled();
  });

  it("does not throw WeakMap errors when preparing malformed exec params", async () => {
    const tool = createExecTool({
      security: "full",
      ask: "off",
    });
    const [definition] = toToolDefinitions([tool]);

    const result = await expectDefined(definition, "definition test invariant").execute(
      "call-malformed-exec-params",
      "not-an-object",
      undefined,
      undefined,
      extensionContext,
    );

    expect(result.details).toMatchObject({
      status: "error",
      error: "Provide a command to start.",
    });
  });

  it("does not throw WeakMap errors when preparing malformed backend sandbox exec params", async () => {
    const validateWorkdir = vi.fn(async (workdir: string) => workdir);
    const tool = createExecTool({
      host: "sandbox",
      security: "full",
      ask: "off",
      sandbox: {
        containerName: "remote-sandbox-workdir-test",
        workspaceDir: process.cwd(),
        containerWorkdir: "/remote/workspace",
        workdirValidation: "backend",
        validateWorkdir,
      },
    });
    const [definition] = toToolDefinitions([tool]);

    const result = await expectDefined(definition, "definition test invariant").execute(
      "call-malformed-backend-sandbox-exec-params",
      "not-an-object",
      undefined,
      undefined,
      extensionContext,
    );

    expect(result.details).toMatchObject({
      status: "error",
      error: "Provide a command to start.",
    });
    expect(JSON.stringify(result)).not.toContain("WeakMap");
    expect(validateWorkdir).not.toHaveBeenCalled();
  });

  it("reports malformed exec params when elevated logging is enabled", async () => {
    const tool = createExecTool({
      security: "full",
      ask: "off",
      elevated: { enabled: true, allowed: true, defaultLevel: "on" },
    });
    const [definition] = toToolDefinitions([tool]);

    const result = await expectDefined(definition, "definition test invariant").execute(
      "call-malformed-elevated-exec-params",
      {},
      undefined,
      undefined,
      extensionContext,
    );

    expect(result.details).toMatchObject({
      status: "error",
      error: "Provide a command to start.",
    });
  });

  it("does not validate backend sandbox workdirs before malformed exec params fail", async () => {
    const validateWorkdir = vi.fn(async (workdir: string) => workdir);
    const tool = createExecTool({
      host: "sandbox",
      security: "full",
      ask: "off",
      sandbox: {
        containerName: "remote-sandbox-workdir-test",
        workspaceDir: process.cwd(),
        containerWorkdir: "/remote/workspace",
        workdirValidation: "backend",
        validateWorkdir,
      },
    });
    const [definition] = toToolDefinitions([tool]);

    const result = await expectDefined(definition, "definition test invariant").execute(
      "call-malformed-backend-sandbox-exec-params",
      {
        workdir: "/remote/workspace/generated",
      },
      undefined,
      undefined,
      extensionContext,
    );

    expect(result.details).toMatchObject({
      status: "error",
      error: "Provide a command to start.",
    });
    expect(validateWorkdir).not.toHaveBeenCalled();
  });

  it("coerces details-only tool results to include content", async () => {
    const tool = {
      name: "memory_query",
      label: "Memory Query",
      description: "returns details only",
      parameters: Type.Object({}),
      execute: (async () => ({
        details: {
          hits: [{ id: "a1", score: 0.9 }],
        },
      })) as unknown as AgentTool["execute"],
    } satisfies AgentTool;

    const result = await executeTool(tool, "call3");
    expect(result.details).toEqual({
      hits: [{ id: "a1", score: 0.9 }],
    });
    expect(result.content[0]?.type).toBe("text");
    expect((result.content[0] as { text?: string }).text).toContain('"hits"');
  });

  it("coerces non-standard object results to include content", async () => {
    const tool = {
      name: "memory_query_raw",
      label: "Memory Query Raw",
      description: "returns plain object",
      parameters: Type.Object({}),
      execute: (async () => ({
        count: 2,
        ids: ["m1", "m2"],
      })) as unknown as AgentTool["execute"],
    } satisfies AgentTool;

    const result = await executeTool(tool, "call4");
    expect(result.details).toEqual({
      count: 2,
      ids: ["m1", "m2"],
    });
    expect(result.content[0]?.type).toBe("text");
    expect((result.content[0] as { text?: string }).text).toContain('"count"');
  });

  it("does not re-run hook preparation for an already wrapped tool", async () => {
    const prepareBeforeToolCallParams = vi.fn((params: unknown) => params);
    const execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "done" }],
      details: {},
    }));
    const tool = {
      name: "wrapped_tool",
      label: "Wrapped Tool",
      description: "already owns hook execution",
      parameters: Type.Object({}),
      prepareBeforeToolCallParams,
      execute,
    } as AgentTool & {
      prepareBeforeToolCallParams: typeof prepareBeforeToolCallParams;
    };
    const hookContext = { agentId: "agent-main", sessionId: "session-wrapped-tool" };
    const wrappedTool = wrapToolWithBeforeToolCallHook(tool, hookContext);
    const [definition] = toToolDefinitions([wrappedTool], hookContext);
    if (!definition) {
      throw new Error("missing wrapped tool definition");
    }

    await definition.execute("call-wrapped", {}, undefined, undefined, extensionContext);

    expect(prepareBeforeToolCallParams).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// toClientToolDefinitions – streaming tool-call argument coercion (#57009)
// ---------------------------------------------------------------------------

function makeClientTool(name: string): ClientToolDefinition {
  return {
    type: "function",
    function: {
      name,
      description: `${name} tool`,
      parameters: { type: "object", properties: { query: { type: "string" } } },
    },
  };
}

async function executeClientTool(params: unknown): Promise<{
  calledWith: Record<string, unknown> | undefined;
  result: Awaited<ReturnType<ToolExecute>>;
}> {
  let captured: Record<string, unknown> | undefined;
  const [def] = toClientToolDefinitions([makeClientTool("search")], (_name, p) => {
    captured = p;
  });
  if (!def) {
    throw new Error("missing client tool definition");
  }
  const result = await def.execute("call-c1", params, undefined, undefined, extensionContext);
  return { calledWith: captured, result };
}

describe("toClientToolDefinitions – param coercion", () => {
  it("returns terminal pending results for each client tool in a batch", async () => {
    const completed: Array<{ id: string; name: string; params: Record<string, unknown> }> = [];
    const defs = toClientToolDefinitions([makeClientTool("search"), makeClientTool("lookup")], {
      complete: (id, name, params) => {
        completed.push({ id, name, params });
      },
    });
    const [search, lookup] = defs;
    if (!search || !lookup) {
      throw new Error("missing client tool definition");
    }

    const [searchResult, lookupResult] = await Promise.all([
      search.execute("call-search", { query: "first" }, undefined, undefined, extensionContext),
      lookup.execute("call-lookup", { query: "second" }, undefined, undefined, extensionContext),
    ]);

    expect(searchResult.terminate).toBe(true);
    expect(lookupResult.terminate).toBe(true);
    expect(completed).toEqual([
      { id: "call-search", name: "search", params: { query: "first" } },
      { id: "call-lookup", name: "lookup", params: { query: "second" } },
    ]);
  });

  it("passes plain object params through unchanged", async () => {
    const { calledWith, result } = await executeClientTool({ query: "hello" });
    expect(calledWith).toEqual({ query: "hello" });
    expect(result.terminate).toBe(true);
  });

  it("parses a JSON string into an object (streaming delta accumulation)", async () => {
    const { calledWith } = await executeClientTool('{"query":"hello","limit":10}');
    expect(calledWith).toEqual({ query: "hello", limit: 10 });
  });

  it("parses a JSON string with surrounding whitespace", async () => {
    const { calledWith } = await executeClientTool('  {"query":"hello"}  ');
    expect(calledWith).toEqual({ query: "hello" });
  });

  it("falls back to empty object for invalid JSON string", async () => {
    const { calledWith } = await executeClientTool("not-json");
    expect(calledWith).toStrictEqual({});
  });

  it("falls back to empty object for empty string", async () => {
    const { calledWith } = await executeClientTool("");
    expect(calledWith).toStrictEqual({});
  });

  it("falls back to empty object for null", async () => {
    const { calledWith } = await executeClientTool(null);
    expect(calledWith).toStrictEqual({});
  });

  it("falls back to empty object for undefined", async () => {
    const { calledWith } = await executeClientTool(undefined);
    expect(calledWith).toStrictEqual({});
  });

  it("falls back to empty object for a JSON array string", async () => {
    const { calledWith } = await executeClientTool("[1,2,3]");
    expect(calledWith).toStrictEqual({});
  });

  it("handles nested JSON string correctly", async () => {
    const { calledWith } = await executeClientTool(
      '{"action":"search","params":{"q":"test","page":1}}',
    );
    expect(calledWith).toEqual({ action: "search", params: { q: "test", page: 1 } });
  });
});

describe("client tool name conflict checks", () => {
  it("detects collisions with existing built-in names after normalization", () => {
    expect(
      findClientToolNameConflicts({
        tools: [makeClientTool("Web_Search"), makeClientTool("exec")],
        existingToolNames: ["web_search", "read"],
      }),
    ).toEqual(["Web_Search"]);
  });

  it("detects duplicate client tool names after normalization", () => {
    expect(
      findClientToolNameConflicts({
        tools: [makeClientTool("Weather"), makeClientTool("weather")],
      }),
    ).toEqual(["Weather", "weather"]);
  });

  it("detects collisions with reserved OpenClaw built-in tool names", () => {
    expect(
      findClientToolNameConflicts({
        tools: [makeClientTool("Bash"), makeClientTool("grep")],
        existingToolNames: ["bash", "edit", "find", "grep", "ls", "read", "write"],
      }),
    ).toEqual(["Bash", "grep"]);
  });

  it("wraps conflict errors with a stable prefix", () => {
    const err = createClientToolNameConflictError(["exec", "Web_Search"]);
    expect(err.message).toBe(`${CLIENT_TOOL_NAME_CONFLICT_PREFIX} exec, Web_Search`);
    expect(isClientToolNameConflictError(err)).toBe(true);
    expect(isClientToolNameConflictError(new Error("other failure"))).toBe(false);
  });
});
