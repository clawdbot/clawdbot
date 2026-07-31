import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-fixtures.js";
import { setPluginToolMeta } from "../plugins/tools.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.js";
import { readToolSearchCallArgs } from "./tool-search-runtime.js";
import type { ToolSearchCatalogEntry } from "./tool-search-types.js";
import {
  addClientToolsToToolSearchCatalog,
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
  it("records cumulative calls while keeping last-call evidence runtime-local", async () => {
    const read = fakeTool("read", Type.Object({ path: Type.String() }));
    const write = fakeTool("write", Type.Object({ path: Type.String(), content: Type.String() }));
    const { catalogRef, config, runtime } = createRuntime([read, write]);

    await runtime.call("read", { path: "facts.txt" });
    await runtime.call("write", { path: "result.txt", content: "done" });
    await runtime.call("read", { path: "result.txt" });
    addClientToolsToToolSearchCatalog({
      tools: [fakeTool("client_followup")],
      config,
      catalogRef,
    });

    expect(catalogRef.current?.callSequence).toEqual(["read", "write", "read"]);
    expect(catalogRef.current?.callSideEffectFreeSequence).toEqual([true, false, true]);
    expect(runtime.telemetry()).toMatchObject({
      lastCallSideEffectFree: true,
      hadTargetlessSideEffects: false,
      successfulObservationFileTargets: [{ path: "facts.txt" }, { path: "result.txt" }],
      unverifiedMutationFileTargets: [],
    });

    const nextRuntime = new ToolSearchRuntime({ catalogRef }, resolveToolSearchConfig(config), {
      validateInput: true,
    });
    expect(nextRuntime.telemetry()).not.toHaveProperty("lastCallSideEffectFree");
    await nextRuntime.call("write", { path: "next.txt", content: "done" });
    expect(nextRuntime.telemetry()).toMatchObject({
      lastCallSideEffectFree: false,
      successfulObservationFileTargets: [],
      unverifiedMutationFileTargets: [{ path: "next.txt" }],
    });
  });

  it("clears an edited target after an ordered readback", async () => {
    const edit = fakeTool(
      "edit",
      Type.Object({
        path: Type.String(),
        oldText: Type.String(),
        newText: Type.String(),
      }),
    );
    const read = fakeTool("read", Type.Object({ path: Type.String() }));
    const { runtime } = createRuntime([edit, read]);

    await runtime.call("edit", {
      path: "editable.txt",
      oldText: "status=pending",
      newText: "status=verified",
    });
    await runtime.call("read", { path: "editable.txt" });

    expect(runtime.telemetry()).toMatchObject({
      callSequence: ["edit", "read"],
      lastCallSideEffectFree: true,
      successfulObservationFileTargets: [{ path: "editable.txt" }],
      unverifiedMutationFileTargets: [],
    });
  });

  it("keeps a mutation unverified when a nested read returns an error result", async () => {
    const read = fakeTool("read", Type.Object({ path: Type.String() }));
    read.execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "read failed" }],
      details: { status: "failed", error: "read failed" },
    }));
    const write = fakeTool("write", Type.Object({ path: Type.String(), content: Type.String() }));
    const { runtime } = createRuntime([read, write]);

    await runtime.call("write", { path: "result.txt", content: "done" });
    await runtime.call("read", { path: "result.txt" });

    expect(runtime.telemetry()).toMatchObject({
      failures: 1,
      lastCallSideEffectFree: true,
      successfulObservationFileTargets: [],
      unverifiedMutationFileTargets: [{ path: "result.txt" }],
    });
  });

  it("preserves apply_patch targets reported after a bridged failure", async () => {
    const applyPatch = fakeTool("apply_patch", Type.Object({ input: Type.String() }));
    applyPatch.execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "patch failed" }],
      details: {
        status: "failed",
        summary: {
          added: ["a.ts"],
          modified: ["b.ts"],
          deleted: ["old.ts"],
        },
      },
    }));
    const { runtime } = createRuntime([applyPatch]);

    await runtime.call("apply_patch", {
      input: [
        "*** Begin Patch",
        "*** Delete File: old.ts",
        "*** Add File: a.ts",
        "+export {};",
        "*** Update File: b.ts",
        "@@",
        "-old",
        "+new",
        "*** End Patch",
      ].join("\n"),
    });

    expect(runtime.telemetry()).toMatchObject({
      failures: 1,
      unverifiedMutationFileTargets: [
        { path: "a.ts", expected: "unknown" },
        { path: "b.ts", expected: "unknown" },
        { path: "old.ts", expected: "unknown" },
      ],
    });
  });

  it("treats successful read contents mentioning ENOENT as presence evidence", async () => {
    const read = fakeTool("read", Type.Object({ path: Type.String() }));
    read.execute = vi.fn(async () => jsonResult({ content: "handle ENOENT: file not found" }));
    const write = fakeTool("write", Type.Object({ path: Type.String(), content: Type.String() }));
    const { runtime } = createRuntime([read, write]);

    await runtime.call("write", { path: "result.txt", content: "done" });
    await runtime.call("read", { path: "result.txt" });

    expect(runtime.telemetry()).toMatchObject({
      successfulObservationFileTargets: [{ path: "result.txt" }],
      successfulAbsenceObservationFileTargets: [],
      unverifiedMutationFileTargets: [],
    });
  });

  it("preserves apply_patch input targets when bridged execution rejects", async () => {
    const applyPatch = fakeTool("apply_patch", Type.Object({ input: Type.String() }));
    applyPatch.execute = vi.fn(async () => {
      throw new Error("patch crashed after applying an earlier hunk");
    });
    const { runtime } = createRuntime([applyPatch]);

    await expect(
      runtime.call("apply_patch", {
        input: [
          "*** Begin Patch",
          "*** Add File: a.ts",
          "+export {};",
          "*** Update File: b.ts",
          "@@",
          "-old",
          "+next",
          "*** End Patch",
        ].join("\n"),
      }),
    ).rejects.toThrow("patch crashed");

    expect(runtime.telemetry()).toMatchObject({
      failures: 1,
      unverifiedMutationFileTargets: [
        { path: "a.ts", expected: "unknown" },
        { path: "b.ts", expected: "unknown" },
      ],
    });
  });

  it("verifies moved apply_patch targets with presence and absence reads", async () => {
    const applyPatch = fakeTool("apply_patch", Type.Object({ input: Type.String() }));
    applyPatch.execute = vi.fn(async () => {
      throw new Error("patch crashed after moving the file");
    });
    const read = fakeTool("read", Type.Object({ path: Type.String() }));
    read.execute = vi.fn(async (_toolCallId, input) =>
      (input as { path?: string }).path === "old.ts"
        ? {
            content: [{ type: "text" as const, text: "File not found: old.ts" }],
            details: { status: "failed", code: "ENOENT", error: "file not found" },
          }
        : jsonResult({ content: "moved" }),
    );
    const { runtime } = createRuntime([applyPatch, read]);

    await expect(
      runtime.call("apply_patch", {
        input: [
          "*** Begin Patch",
          "*** Update File: old.ts",
          "*** Move to: new.ts",
          "@@",
          "-old",
          "+new",
          "*** End Patch",
        ].join("\n"),
      }),
    ).rejects.toThrow("patch crashed");
    expect(runtime.telemetry()).toMatchObject({
      unverifiedMutationFileTargets: [
        { path: "old.ts", expected: "unknown" },
        { path: "new.ts", expected: "unknown" },
      ],
    });

    await runtime.call("read", { path: "old.ts" });
    expect(runtime.telemetry()).toMatchObject({
      successfulAbsenceObservationFileTargets: [{ path: "old.ts" }],
      unverifiedMutationFileTargets: [{ path: "new.ts", expected: "unknown" }],
    });

    await runtime.call("read", { path: "new.ts" });
    expect(runtime.telemetry()).toMatchObject({
      unverifiedMutationFileTargets: [],
    });
  });

  it("counts nested tool executions that reject", async () => {
    const failingRead = fakeTool("read", Type.Object({ path: Type.String() }));
    failingRead.execute = vi.fn(async () => {
      throw new Error("read crashed");
    });
    const { runtime } = createRuntime([failingRead]);

    await expect(runtime.call("read", { path: "result.txt" })).rejects.toThrow("read crashed");

    expect(runtime.telemetry()).toMatchObject({
      failures: 1,
      successfulObservationFileTargets: [],
    });
  });

  it("keeps an executed mutation unverified when result acceptance rejects", async () => {
    const write = fakeTool("write", Type.Object({ path: Type.String(), content: Type.String() }));
    write.outputSchema = Type.Object({ status: Type.Literal("written") });
    write.execute = vi.fn(async () => jsonResult({ status: "invalid" }));
    const { catalogRef, config } = createRuntime([write]);
    const runtime = new ToolSearchRuntime(
      {
        catalogRef,
        executeTool: async (params) =>
          await params.tool.execute(
            params.toolCallId,
            params.input,
            params.signal,
            params.onUpdate,
            undefined as never,
          ),
      },
      resolveToolSearchConfig(config),
      { validateInput: true },
    );

    await expect(runtime.call("write", { path: "result.txt", content: "done" })).rejects.toThrow(
      "declared outputSchema",
    );

    expect(write.execute).toHaveBeenCalledOnce();
    expect(runtime.telemetry()).toMatchObject({
      failures: 1,
      unverifiedMutationFileTargets: [{ path: "result.txt", expected: "unknown" }],
    });
  });

  it("preserves apply_patch input targets when result acceptance rejects", async () => {
    const applyPatch = fakeTool("apply_patch", Type.Object({ input: Type.String() }));
    applyPatch.outputSchema = Type.Object({ status: Type.Literal("patched") });
    applyPatch.execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "patched" }],
      details: {
        summary: {
          added: ["a.ts"],
          modified: [],
          deleted: [],
        },
      },
    }));
    const { catalogRef, config } = createRuntime([applyPatch]);
    const runtime = new ToolSearchRuntime(
      {
        catalogRef,
        executeTool: async (params) =>
          await params.tool.execute(
            params.toolCallId,
            params.input,
            params.signal,
            params.onUpdate,
            undefined as never,
          ),
      },
      resolveToolSearchConfig(config),
      { validateInput: true },
    );

    await expect(
      runtime.call("apply_patch", {
        input: ["*** Begin Patch", "*** Add File: a.ts", "+export {};", "*** End Patch"].join("\n"),
      }),
    ).rejects.toThrow("declared outputSchema");

    expect(runtime.telemetry()).toMatchObject({
      failures: 1,
      unverifiedMutationFileTargets: [{ path: "a.ts", expected: "unknown" }],
    });
  });

  it("does not let an observation before a mutation verify the later write", async () => {
    const read = fakeTool("read", Type.Object({ path: Type.String() }));
    const write = fakeTool("write", Type.Object({ path: Type.String(), content: Type.String() }));
    const { runtime } = createRuntime([read, write]);

    await runtime.call("read", { path: "result.txt" });
    await runtime.call("write", { path: "result.txt", content: "done" });

    expect(runtime.telemetry()).toMatchObject({
      lastCallSideEffectFree: false,
      successfulObservationFileTargets: [{ path: "result.txt" }],
      unverifiedMutationFileTargets: [{ path: "result.txt" }],
    });
  });

  it("does not let an overlapping read verify an in-flight write", async () => {
    const read = fakeTool("read", Type.Object({ path: Type.String() }));
    const write = fakeTool("write", Type.Object({ path: Type.String(), content: Type.String() }));
    let finishRead: ((value: ReturnType<typeof jsonResult>) => void) | undefined;
    let finishWrite: ((value: ReturnType<typeof jsonResult>) => void) | undefined;
    read.execute = vi.fn(
      async () =>
        await new Promise<ReturnType<typeof jsonResult>>((resolve) => {
          finishRead = resolve;
        }),
    );
    write.execute = vi.fn(
      async () =>
        await new Promise<ReturnType<typeof jsonResult>>((resolve) => {
          finishWrite = resolve;
        }),
    );
    const { runtime } = createRuntime([read, write]);

    const writeCall = runtime.call("write", { path: "result.txt", content: "done" });
    await vi.waitFor(() => expect(write.execute).toHaveBeenCalledOnce());
    const readCall = runtime.call("read", { path: "./result.txt" });
    await vi.waitFor(() => expect(read.execute).toHaveBeenCalledOnce());
    finishWrite?.(jsonResult({ status: "written" }));
    await writeCall;
    finishRead?.(jsonResult({ content: "done" }));
    await readCall;

    expect(runtime.telemetry()).toMatchObject({
      successfulObservationFileTargets: [{ path: "./result.txt" }],
      unverifiedMutationFileTargets: [{ path: "result.txt" }],
    });

    read.execute = vi.fn(async () => jsonResult({ content: "done" }));
    await runtime.call("read", { path: "./result.txt" });
    expect(runtime.telemetry()).toMatchObject({
      unverifiedMutationFileTargets: [],
    });
  });

  it("matches absolute read-back paths against relative mutation targets", async () => {
    const read = fakeTool("read", Type.Object({ path: Type.String() }));
    const write = fakeTool("write", Type.Object({ path: Type.String(), content: Type.String() }));
    const catalogRef = createToolSearchCatalogRef();
    registerHeadlessToolSearchCatalog({ catalogRef, tools: [read, write] });
    const runtime = new ToolSearchRuntime(
      { catalogRef, cwd: "/workspace" },
      resolveToolSearchConfig({ tools: { toolSearch: { mode: "tools" } } } as never),
      { validateInput: true },
    );

    await runtime.call("write", { path: "result.txt", content: "done" });
    await runtime.call("read", { path: "/workspace/result.txt" });

    expect(runtime.telemetry()).toMatchObject({
      successfulObservationFileTargets: [{ path: "/workspace/result.txt" }],
      unverifiedMutationFileTargets: [],
    });
  });

  it("does not convert plugin replay uncertainty into mutation evidence", async () => {
    const pluginRead = fakeTool("plugin_read", Type.Object({ id: Type.String() }));
    setPluginToolMeta(pluginRead, { pluginId: "example", optional: false });
    const { runtime } = createRuntime([pluginRead]);

    await runtime.call("plugin_read", { id: "record-1" });

    expect(runtime.telemetry()).toMatchObject({
      lastCallSideEffectFree: false,
      hadTargetlessSideEffects: true,
      successfulObservationFileTargets: [],
      unverifiedMutationFileTargets: [],
    });
  });

  it("tracks and verifies every file changed by a nested apply_patch call", async () => {
    const applyPatch = fakeTool("apply_patch", Type.Object({ input: Type.String() }));
    applyPatch.execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "patched" }],
      details: {
        summary: {
          added: ["a.ts"],
          modified: ["b.ts"],
          deleted: [],
        },
      },
    }));
    const read = fakeTool("read", Type.Object({ path: Type.String() }));
    const { runtime } = createRuntime([applyPatch, read]);

    await runtime.call("apply_patch", { input: "*** Begin Patch\n*** End Patch" });
    expect(runtime.telemetry()).toMatchObject({
      unverifiedMutationFileTargets: [{ path: "a.ts" }, { path: "b.ts" }],
    });

    await runtime.call("read", { path: "a.ts" });
    expect(runtime.telemetry()).toMatchObject({
      unverifiedMutationFileTargets: [{ path: "b.ts" }],
    });

    await runtime.call("read", { path: "b.ts" });
    expect(runtime.telemetry()).toMatchObject({
      unverifiedMutationFileTargets: [],
    });
  });

  it("publishes successful nested apply_patch deletions as authoritative absence", async () => {
    const write = fakeTool("write", Type.Object({ path: Type.String(), content: Type.String() }));
    const applyPatch = fakeTool("apply_patch", Type.Object({ input: Type.String() }));
    applyPatch.execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "deleted" }],
      details: {
        summary: {
          added: [],
          modified: [],
          deleted: ["temporary.ts"],
        },
      },
    }));
    const { runtime } = createRuntime([write, applyPatch]);

    await runtime.call("write", { path: "temporary.ts", content: "temporary" });
    expect(runtime.telemetry()).toMatchObject({
      unverifiedMutationFileTargets: [{ path: "temporary.ts" }],
    });

    await runtime.call("apply_patch", { input: "*** Begin Patch\n*** End Patch" });
    expect(runtime.telemetry()).toMatchObject({
      successfulAbsenceObservationFileTargets: [{ path: "temporary.ts" }],
      unverifiedMutationFileTargets: [],
    });
  });

  it("repairs schema-bounded Code Mode scalar and optional-null drift", async () => {
    const target = fakeTool(
      "small_model_input",
      Type.Object(
        {
          enabled: Type.Optional(Type.Boolean()),
          limit: Type.Optional(Type.Number()),
          nullable: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          rows: Type.Optional(Type.Array(Type.Object({ line: Type.Number() }))),
        },
        { additionalProperties: false },
      ),
    );
    const { catalogRef, config } = createRuntime([target]);
    const runtime = new ToolSearchRuntime({ catalogRef }, resolveToolSearchConfig(config), {
      repairInput: true,
      validateInput: true,
    });

    await expect(
      runtime.call("small_model_input", {
        enabled: "false",
        limit: null,
        nullable: null,
        rows: '[{"line":"2"}]',
      }),
    ).resolves.toMatchObject({
      result: {
        details: {
          input: {
            enabled: false,
            nullable: null,
            rows: [{ line: 2 }],
          },
        },
      },
    });
    expect(vi.mocked(target.execute).mock.calls[0]?.[1]).toEqual({
      enabled: false,
      nullable: null,
      rows: [{ line: 2 }],
    });
  });

  it("preserves relative Code Mode paths even when they resemble the cwd suffix", async () => {
    const target = fakeTool("read", Type.Object({ path: Type.String() }));
    const { catalogRef, config } = createRuntime([target]);
    const runtime = new ToolSearchRuntime(
      {
        catalogRef,
        cwd: "/tmp/openclaw/state/workspaces/cell",
      },
      resolveToolSearchConfig(config),
      {
        repairInput: true,
        validateInput: true,
      },
    );

    await runtime.call("read", { path: "state/workspaces/cell/facts.txt" });
    await runtime.call("read", { path: "fixtures/facts.txt" });
    await runtime.call("read", { path: "../facts.txt" });

    expect(vi.mocked(target.execute).mock.calls.map((call) => call[1])).toEqual([
      { path: "state/workspaces/cell/facts.txt" },
      { path: "fixtures/facts.txt" },
      { path: "../facts.txt" },
    ]);
  });

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
    expect(runtime.telemetry()).toMatchObject({ failures: 1 });
  });

  it("rechecks read-only safety after a policy hook adjusts arguments", async () => {
    const hook = vi.fn(async () => ({ params: { action: "add" } }));
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: hook }]),
    );
    const target = fakeTool(
      "cron",
      Type.Object({ action: Type.String() }, { additionalProperties: false }),
    );
    const { catalogRef, config } = createRuntime([target]);
    const runtime = new ToolSearchRuntime({ catalogRef }, resolveToolSearchConfig(config), {
      validateInput: true,
      enforceSideEffectFree: true,
    });

    await expect(runtime.call("cron", { action: "list" })).rejects.toThrow(
      "read-only Code Mode policy",
    );
    expect(hook).toHaveBeenCalledOnce();
    expect(target.execute).not.toHaveBeenCalled();
    expect(runtime.telemetry()).toMatchObject({ failures: 1 });
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
