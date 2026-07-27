import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-fixtures.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.js";
import { readToolSearchCallArgs } from "./tool-search-runtime.js";
import type { ToolSearchCatalogEntry } from "./tool-search-types.js";
import {
  createToolSearchCatalogRef,
  createToolSearchTools,
  registerHeadlessToolSearchCatalog,
  resolveToolSearchConfig,
  TOOL_CALL_RAW_TOOL_NAME,
  TOOL_SEARCH_CODE_MODE_TOOL_NAME,
  ToolSearchRuntime,
} from "./tool-search.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";

afterEach(() => {
  resetGlobalHookRunner();
});

function fakeTool(name: string, parameters = Type.Object({})): AnyAgentTool {
  return {
    name,
    label: name,
    description: `Run ${name}`,
    parameters,
    execute: vi.fn(async (_toolCallId, input) => jsonResult({ input })),
  };
}

function createRuntime(tools: AnyAgentTool[]) {
  const catalogRef = createToolSearchCatalogRef();
  registerHeadlessToolSearchCatalog({ catalogRef, tools });
  const config = { tools: { toolSearch: { enabled: true, mode: "tools" } } } as never;
  return {
    catalogRef,
    config,
    runtime: new ToolSearchRuntime({ catalogRef }, resolveToolSearchConfig(config), {
      validateInput: true,
    }),
  };
}

describe("Tool Search flattened call arguments", () => {
  it.each([
    {
      label: "canonical id",
      arguments: { id: "inspect_resource", command: "list", timeout_ms: 5_000 },
      expected: { command: "list", timeout_ms: 5_000 },
    },
    {
      label: "toolId selector with a target id",
      arguments: { toolId: "inspect_resource", id: "record-7" },
      expected: { id: "record-7" },
    },
    {
      label: "canonical id with a target name",
      arguments: { id: "inspect_resource", name: "record-name" },
      expected: { name: "record-name" },
    },
    {
      label: "name selector with a target id",
      arguments: { name: "inspect_resource", id: "record-7" },
      expected: { id: "record-7" },
    },
    {
      label: "explicit args precedence",
      arguments: {
        id: "inspect_resource",
        args: { command: "nested" },
        command: "flattened",
      },
      expected: { command: "nested" },
    },
    {
      label: "explicit input precedence",
      arguments: {
        id: "inspect_resource",
        input: { command: "nested" },
        command: "flattened",
      },
      expected: { command: "nested" },
    },
    {
      label: "null wrapper arguments",
      arguments: { id: "inspect_resource", args: null, input: null, command: "flattened" },
      expected: { command: "flattened" },
    },
    {
      label: "bare selector",
      arguments: { id: "inspect_resource" },
      expected: {},
    },
    {
      label: "redundant matching selectors",
      arguments: { id: "inspect_resource", toolId: "inspect_resource", name: "inspect_resource" },
      expected: {},
    },
  ])("preserves target arguments for $label", ({ arguments: args, expected }) => {
    const { catalogRef } = createRuntime([fakeTool("inspect_resource")]);

    expect(readToolSearchCallArgs(args, catalogRef.current)).toEqual({
      id: "inspect_resource",
      input: expected,
    });
  });

  it.each([
    {
      label: "toolId selector with a required target id",
      arguments: { toolId: "inspect_resource", id: "record-7" },
      parameters: Type.Object({ id: Type.String() }, { additionalProperties: false }),
      expected: { id: "record-7" },
    },
    {
      label: "id selector with a required target name",
      arguments: { id: "inspect_resource", name: "record-name" },
      parameters: Type.Object({ name: Type.String() }, { additionalProperties: false }),
      expected: { name: "record-name" },
    },
    {
      label: "name selector with a required target id",
      arguments: { name: "inspect_resource", id: "record-7" },
      parameters: Type.Object({ id: Type.String() }, { additionalProperties: false }),
      expected: { id: "record-7" },
    },
    {
      label: "redundant selectors for a strict no-argument tool",
      arguments: { id: "inspect_resource", toolId: "inspect_resource", name: "inspect_resource" },
      parameters: Type.Object({}, { additionalProperties: false }),
      expected: {},
    },
  ])(
    "dispatches $label through the real structured tool",
    async ({ arguments: args, parameters, expected }) => {
      const target = fakeTool("inspect_resource", parameters);
      const { catalogRef, config } = createRuntime([target]);
      const callTool = createToolSearchTools({ catalogRef, config }).find(
        (tool) => tool.name === TOOL_CALL_RAW_TOOL_NAME,
      );

      expect(callTool).toBeDefined();
      await callTool!.execute("structured-call", args);

      expect(target.execute).toHaveBeenCalledOnce();
      expect(vi.mocked(target.execute).mock.calls[0]?.[1]).toEqual(expected);
    },
  );

  it("rejects flattened selectors that identify different catalog tools", async () => {
    const intended = fakeTool("inspect_resource");
    const colliding = fakeTool("search");
    const { catalogRef, config } = createRuntime([intended, colliding]);
    const callTool = createToolSearchTools({ catalogRef, config }).find(
      (tool) => tool.name === TOOL_CALL_RAW_TOOL_NAME,
    );

    expect(callTool).toBeDefined();
    await expect(
      callTool!.execute("ambiguous-call", { name: "inspect_resource", id: "search" }),
    ).rejects.toThrow("Ambiguous tool selectors");
    expect(intended.execute).not.toHaveBeenCalled();
    expect(colliding.execute).not.toHaveBeenCalled();
  });

  it("rejects a single selector shared by multiple catalog tools", async () => {
    const first = fakeTool("shared_search");
    const second = fakeTool("shared_search");
    const { catalogRef, config } = createRuntime([first]);
    const baseEntry = catalogRef.current?.entries[0];
    expect(baseEntry).toBeDefined();
    catalogRef.current!.entries = [
      { ...baseEntry!, id: "openclaw:first:shared_search", tool: first },
      { ...baseEntry!, id: "openclaw:second:shared_search", tool: second },
    ];
    const callTool = createToolSearchTools({ catalogRef, config }).find(
      (tool) => tool.name === TOOL_CALL_RAW_TOOL_NAME,
    );

    expect(callTool).toBeDefined();
    await expect(
      callTool!.execute("duplicate-name-call", { name: "shared_search" }),
    ).rejects.toThrow("Ambiguous tool selectors");
    expect(first.execute).not.toHaveBeenCalled();
    expect(second.execute).not.toHaveBeenCalled();
  });

  it("keeps explicit nested arguments ahead of flattened selector aliases", async () => {
    const intended = fakeTool(
      "inspect_resource",
      Type.Object({ instruction: Type.String() }, { additionalProperties: false }),
    );
    const colliding = fakeTool("search");
    const { catalogRef, config } = createRuntime([intended, colliding]);
    const callTool = createToolSearchTools({ catalogRef, config }).find(
      (tool) => tool.name === TOOL_CALL_RAW_TOOL_NAME,
    );

    expect(callTool).toBeDefined();
    await callTool!.execute("nested-call", {
      id: "inspect_resource",
      name: "search",
      args: { instruction: "run" },
    });

    expect(intended.execute).toHaveBeenCalledOnce();
    expect(vi.mocked(intended.execute).mock.calls[0]?.[1]).toEqual({ instruction: "run" });
    expect(colliding.execute).not.toHaveBeenCalled();
  });
});

describe("Tool Search input schemas", () => {
  it("validates arguments after a policy hook repairs them", async () => {
    const hook = vi.fn(async () => ({ params: { instruction: "repaired" } }));
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: hook }]),
    );
    const target = fakeTool(
      "strict_instruction",
      Type.Object({ instruction: Type.String() }, { additionalProperties: false }),
    );
    const { runtime } = createRuntime([target]);

    await expect(runtime.call("strict_instruction", {})).resolves.toMatchObject({
      result: { details: { input: { instruction: "repaired" } } },
    });
    expect(hook).toHaveBeenCalledOnce();
    expect(target.execute).toHaveBeenCalledOnce();
    expect(vi.mocked(target.execute).mock.calls[0]?.[1]).toEqual({ instruction: "repaired" });
  });

  it("rejects invalid hook-adjusted arguments before target execution", async () => {
    const hook = vi.fn(async () => ({ params: { instruction: 42 } }));
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: hook }]),
    );
    const target = fakeTool(
      "strict_instruction",
      Type.Object({ instruction: Type.String() }, { additionalProperties: false }),
    );
    const { runtime } = createRuntime([target]);

    await expect(runtime.call("strict_instruction", { instruction: "valid" })).rejects.toThrow(
      "instruction",
    );
    expect(hook).toHaveBeenCalledOnce();
    expect(target.execute).not.toHaveBeenCalled();
  });

  it("lets policy hooks block invalid arguments before schema validation", async () => {
    const hook = vi.fn(async () => ({ block: true, blockReason: "blocked by policy" }));
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: hook }]),
    );
    const target = fakeTool(
      "strict_instruction",
      Type.Object({ instruction: Type.String() }, { additionalProperties: false }),
    );
    const { runtime } = createRuntime([target]);

    await expect(runtime.call("strict_instruction", {})).resolves.toMatchObject({
      result: { details: { status: "blocked", reason: "blocked by policy" } },
    });
    expect(hook).toHaveBeenCalledOnce();
    expect(target.execute).not.toHaveBeenCalled();
  });

  it("does not apply a parent tool's schema to nested wrapped tool calls", async () => {
    const nested = fakeTool(
      "nested_instruction",
      Type.Object({ marker: Type.String() }, { additionalProperties: false }),
    );
    const wrappedNested = wrapToolWithBeforeToolCallHook(nested);
    const target = fakeTool(
      "strict_instruction",
      Type.Object({ instruction: Type.String() }, { additionalProperties: false }),
    );
    target.execute = vi.fn(async () =>
      wrappedNested.execute("nested-policy-call", { marker: "nested" }),
    );
    const { runtime } = createRuntime([target]);

    await expect(runtime.call("strict_instruction", { instruction: "run" })).resolves.toMatchObject(
      {
        result: { details: { input: { marker: "nested" } } },
      },
    );
    expect(target.execute).toHaveBeenCalledOnce();
    expect(nested.execute).toHaveBeenCalledOnce();
    expect(vi.mocked(nested.execute).mock.calls[0]?.[1]).toEqual({ marker: "nested" });
  });

  it.each([
    {
      label: "missing required argument",
      input: {},
      expected: "instruction",
    },
    {
      label: "wrong argument type",
      input: { instruction: 42 },
      expected: "instruction",
    },
    {
      label: "unexpected argument",
      input: { instruction: "run", unexpected: true },
      expected: "unexpected",
    },
  ])("rejects a trusted tool's $label before execution", async ({ input, expected }) => {
    const target = fakeTool(
      "strict_instruction",
      Type.Object({ instruction: Type.String() }, { additionalProperties: false }),
    );
    const { runtime } = createRuntime([target]);

    await expect(runtime.call("strict_instruction", input)).rejects.toThrow(expected);
    expect(target.execute).not.toHaveBeenCalled();
  });

  it("suggests a near-miss parameter without executing the tool", async () => {
    const target = fakeTool(
      "strict_instruction",
      Type.Object({ instruction: Type.String() }, { additionalProperties: false }),
    );
    const { runtime } = createRuntime([target]);

    await expect(runtime.call("strict_instruction", { instructions: "run" })).rejects.toThrow(
      "Did you mean: instruction?",
    );
    expect(target.execute).not.toHaveBeenCalled();
  });

  it("fails before side effects when a trusted input schema is invalid", async () => {
    const target = fakeTool("invalid_input", { type: "sting" } as never);
    const { runtime } = createRuntime([target]);

    await expect(runtime.call("invalid_input", {})).rejects.toThrow("invalid inputSchema");
    expect(target.execute).not.toHaveBeenCalled();
  });

  it("does not reuse another catalog's validator for the same tool id", async () => {
    const first = fakeTool(
      "shared_instruction",
      Type.Object({ before: Type.String() }, { additionalProperties: false }),
    );
    const second = fakeTool(
      "shared_instruction",
      Type.Object({ after: Type.String() }, { additionalProperties: false }),
    );
    const firstRuntime = createRuntime([first]).runtime;
    const secondRuntime = createRuntime([second]).runtime;

    await expect(firstRuntime.call("shared_instruction", { before: "run" })).resolves.toBeDefined();
    await expect(secondRuntime.call("shared_instruction", { after: "run" })).resolves.toBeDefined();
    await expect(secondRuntime.call("shared_instruction", { before: "run" })).rejects.toThrow(
      "after",
    );
    expect(first.execute).toHaveBeenCalledOnce();
    expect(second.execute).toHaveBeenCalledOnce();
  });

  it("recompiles a trusted schema after its constraints change in place", async () => {
    const parameters = {
      type: "object",
      properties: { before: { type: "string" } } as Record<string, { type: string }>,
      required: ["before"],
      additionalProperties: false,
    };
    const target = fakeTool("mutable_instruction", parameters as never);
    const { runtime } = createRuntime([target]);

    await expect(runtime.call("mutable_instruction", { before: "run" })).resolves.toBeDefined();
    parameters.properties = { after: { type: "string" } };
    parameters.required = ["after"];

    await expect(runtime.call("mutable_instruction", { after: "run" })).resolves.toBeDefined();
    await expect(runtime.call("mutable_instruction", { before: "run" })).rejects.toThrow("after");
    expect(target.execute).toHaveBeenCalledTimes(2);
  });

  it("returns invalid arguments to isolated Tool Search code without executing them", async () => {
    const target = fakeTool(
      "strict_instruction",
      Type.Object({ instruction: Type.String() }, { additionalProperties: false }),
    );
    const { catalogRef, config } = createRuntime([target]);
    const codeTool = createToolSearchTools({ catalogRef, config }).find(
      (tool) => tool.name === TOOL_SEARCH_CODE_MODE_TOOL_NAME,
    );

    expect(codeTool).toBeDefined();
    const result = await codeTool!.execute("invalid-code-call", {
      code: `
        try {
          await openclaw.tools.call("strict_instruction", { instructions: "run" });
          return { executed: true };
        } catch (error) {
          return { error: error.message };
        }
      `,
    });

    expect(result.details).toMatchObject({
      ok: true,
      value: { error: expect.stringContaining("Did you mean: instruction?") },
    });
    expect(target.execute).not.toHaveBeenCalled();
  });

  it.each(["mcp", "client"] as const)(
    "does not traverse an untrusted %s schema during dispatch",
    async (source) => {
      const target = fakeTool("external_instruction");
      const hostileSchema = new Proxy(
        {},
        {
          get: () => {
            throw new Error("untrusted tool schema must remain deferred");
          },
          ownKeys: () => {
            throw new Error("untrusted tool schema must remain deferred");
          },
        },
      );
      const entry: ToolSearchCatalogEntry = {
        id: `${source}:external:external_instruction`,
        source,
        sourceName: "external",
        name: target.name,
        description: target.description,
        parameters: hostileSchema,
        tool: target,
      };
      const catalogRef = createToolSearchCatalogRef();
      catalogRef.current = {
        entries: [entry],
        searchCount: 0,
        describeCount: 0,
        callCount: 0,
      };
      const runtime = new ToolSearchRuntime(
        { catalogRef },
        resolveToolSearchConfig({ tools: { toolSearch: { mode: "tools" } } } as never),
        { validateInput: true },
      );

      await expect(runtime.call(target.name, { unexpected: true })).resolves.toMatchObject({
        result: { details: { input: { unexpected: true } } },
      });
      expect(target.execute).toHaveBeenCalledOnce();
    },
  );
});

describe("Tool Search catalog indexing", () => {
  it("keeps other ranked results when an exact match allows multiple hits", async () => {
    const { runtime } = createRuntime([fakeTool("orchard"), fakeTool("orchard_records")]);

    await expect(runtime.search("orchard", { limit: 2 })).resolves.toEqual([
      expect.objectContaining({ name: "orchard" }),
      expect.objectContaining({ name: "orchard_records" }),
    ]);
  });

  it("does not traverse a large catalog's schemas during repeated exact searches", async () => {
    const readSchemaDescription = vi.fn((index: number) => `Search record ${index}`);
    const tools = Array.from({ length: 512 }, (_, index) =>
      fakeTool(`stress_tool_${String(index).padStart(3, "0")}`, {
        type: "object",
        get description() {
          return readSchemaDescription(index);
        },
        properties: {},
      } as never),
    );
    const { runtime } = createRuntime(tools);
    readSchemaDescription.mockClear();

    for (let index = 0; index < 64; index += 1) {
      const name = `stress_tool_${String(index).padStart(3, "0")}`;
      await expect(runtime.search(name, { limit: 1 })).resolves.toEqual([
        expect.objectContaining({ name }),
      ]);
    }

    expect(readSchemaDescription).not.toHaveBeenCalled();
  });

  it("rebuilds the search index when the session catalog is replaced", async () => {
    const first = fakeTool("orchard_alpha");
    const second = fakeTool("meteor_beta");
    const { catalogRef, runtime } = createRuntime([first]);

    await expect(runtime.search("orchard_alpha")).resolves.toEqual([
      expect.objectContaining({ name: "orchard_alpha" }),
    ]);
    registerHeadlessToolSearchCatalog({ catalogRef, tools: [second] });

    await expect(runtime.search("meteor_beta")).resolves.toEqual([
      expect.objectContaining({ name: "meteor_beta" }),
    ]);
    await expect(runtime.search("orchard_alpha")).resolves.toEqual([]);
  });

  it("rebuilds the search index when tools are appended to the same catalog", async () => {
    const { catalogRef, runtime } = createRuntime([fakeTool("orchard_alpha")]);
    const added = createRuntime([fakeTool("meteor_beta")]);
    const addedEntry = added.catalogRef.current?.entries[0];

    expect(addedEntry).toBeDefined();
    await expect(runtime.search("meteor_beta")).resolves.toEqual([]);
    catalogRef.current!.entries.push(addedEntry!);

    await expect(runtime.search("meteor_beta")).resolves.toEqual([
      expect.objectContaining({ name: "meteor_beta" }),
    ]);
  });

  it("rebuilds the search index when indexed metadata changes in place", async () => {
    const { catalogRef, runtime } = createRuntime([fakeTool("orchard_alpha")]);
    const entry = catalogRef.current?.entries[0];

    expect(entry).toBeDefined();
    await expect(runtime.search("meteor")).resolves.toEqual([]);
    entry!.description = "Track the current meteor forecast";

    await expect(runtime.search("meteor")).resolves.toEqual([
      expect.objectContaining({ name: "orchard_alpha" }),
    ]);
  });

  it("rebuilds the search index when a parameter description changes in place", async () => {
    const parameters = {
      type: "object",
      description: "Search an orchard",
      properties: {},
    };
    const { runtime } = createRuntime([fakeTool("indexed_resource", parameters as never)]);

    await expect(runtime.search("orchard")).resolves.toEqual([
      expect.objectContaining({ name: "indexed_resource" }),
    ]);
    parameters.description = "Search a meteor";

    await expect(runtime.search("meteor")).resolves.toEqual([
      expect.objectContaining({ name: "indexed_resource" }),
    ]);
    await expect(runtime.search("orchard")).resolves.toEqual([]);
  });
});
