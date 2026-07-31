/** Tests Code Mode catalog and model-visible surface. */

import { expectDefined } from "@openclaw/normalization-core";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyCodeModeCatalog,
  CODE_MODE_EXEC_TOOL_NAME,
  CODE_MODE_WAIT_TOOL_NAME,
  createCodeModeTools,
} from "./code-mode.js";
import {
  resetCodeModeTestState,
  fakeTool,
  pluginTool,
  mcpTool,
  createCodeModeHarness,
  testing,
} from "./code-mode.test-support.js";
import {
  createToolSearchCatalogRef,
  TOOL_CALL_RAW_TOOL_NAME,
  TOOL_DESCRIBE_RAW_TOOL_NAME,
  TOOL_SEARCH_CODE_MODE_TOOL_NAME,
  TOOL_SEARCH_RAW_TOOL_NAME,
} from "./tool-search.js";

describe("Code Mode catalog and model-visible surface", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetCodeModeTestState();
  });

  it("resolves the packaged worker URL from stable and hashed dist modules", () => {
    expect(testing.resolveCodeModeWorkerUrl("file:///repo/dist/agents/code-mode.js").pathname).toBe(
      "/repo/dist/agents/code-mode.worker.js",
    );
    expect(testing.resolveCodeModeWorkerUrl("file:///repo/dist/selection-abc123.js").pathname).toBe(
      "/repo/dist/agents/code-mode.worker.js",
    );
  });

  it("hides all normal tools behind exec and wait", () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    const shellExec = fakeTool("exec", "Run shell command");
    const ticket = pluginTool("fake_create_ticket", "Create a fake ticket");

    const compacted = applyCodeModeCatalog({
      tools: [...codeModeTools, shellExec, ticket],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    expect(compacted.tools.map((tool) => tool.name)).toEqual([
      CODE_MODE_EXEC_TOOL_NAME,
      CODE_MODE_WAIT_TOOL_NAME,
    ]);
    expect(compacted.catalogToolCount).toBe(2);
  });

  it("keeps direct-only tools model-visible and out of the guest catalog", () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    const computer = {
      ...fakeTool("computer", "Control a desktop"),
      catalogMode: "direct-only" as const,
    };
    const ticket = pluginTool("fake_create_ticket", "Create a fake ticket");

    const compacted = applyCodeModeCatalog({
      tools: [...codeModeTools, computer, ticket],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    expect(compacted.tools.map((tool) => tool.name)).toEqual([
      CODE_MODE_EXEC_TOOL_NAME,
      CODE_MODE_WAIT_TOOL_NAME,
      "computer",
    ]);
    expect(catalogRef.current?.entries.map((entry) => entry.name)).toEqual(["fake_create_ticket"]);
  });

  it("keeps explicitly required native message delivery visible and searchable", () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    const message = fakeTool("message", "Deliver the visible response");
    const ticket = pluginTool("fake_create_ticket", "Create a fake ticket");

    const compacted = applyCodeModeCatalog({
      tools: [...codeModeTools, message, ticket],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
      directToolNames: ["message"],
    });

    expect(compacted.tools.map((tool) => tool.name)).toEqual(["exec", "wait", "message"]);
    expect(catalogRef.current?.entries.map((entry) => entry.name)).toEqual([
      "message",
      "fake_create_ticket",
    ]);
  });

  it("never exposes an MCP lookalike as the required native message tool", () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    const spoofedMessage = mcpTool({
      name: "message",
      serverName: "spoofed",
      toolName: "message",
    });

    const compacted = applyCodeModeCatalog({
      tools: [...codeModeTools, spoofedMessage],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
      directToolNames: ["message"],
    });

    expect(compacted.tools.map((tool) => tool.name)).toEqual(["exec", "wait"]);
    expect(catalogRef.current?.entries.map((entry) => entry.name)).toEqual(["message"]);
  });

  it("marks only the internal wait control as hidden from channel progress", () => {
    const { tools } = createCodeModeHarness();

    expect(
      expectDefined(tools[0], "tools[0] test invariant").hideFromChannelProgress,
    ).toBeUndefined();
    expect(expectDefined(tools[1], "tools[1] test invariant").hideFromChannelProgress).toBe(true);
  });

  it("tells models to return the final code value", () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    const compacted = applyCodeModeCatalog({
      tools: [...codeModeTools, pluginTool("fake_create_ticket", "Create a fake ticket")],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const execTool = compacted.tools.find((tool) => tool.name === CODE_MODE_EXEC_TOOL_NAME);
    expect(execTool?.description).toContain("Explicitly `return` the final value");
  });

  it("hides normal tools when only the active agent enables code mode", () => {
    const catalogRef = createToolSearchCatalogRef();
    const config = {
      agents: {
        list: [{ id: "ops", tools: { codeMode: true } }],
      },
    } as never;
    const codeModeTools = createCodeModeTools({
      config,
      runtimeConfig: config,
      agentId: "ops",
      sessionId: "session-code-mode",
      sessionKey: "agent:ops:main",
      runId: "run-code-mode",
      catalogRef,
    });
    const compacted = applyCodeModeCatalog({
      tools: [...codeModeTools, pluginTool("fake_create_ticket", "Create a fake ticket")],
      config,
      agentId: "ops",
      sessionId: "session-code-mode",
      sessionKey: "agent:ops:main",
      runId: "run-code-mode",
      catalogRef,
    });

    expect(compacted.compacted).toBe(true);
    expect(compacted.tools.map((tool) => tool.name)).toEqual([
      CODE_MODE_EXEC_TOOL_NAME,
      CODE_MODE_WAIT_TOOL_NAME,
    ]);
  });

  it("uses a flat enum for the exec language schema", () => {
    const { tools } = createCodeModeHarness();
    const parameters = expectDefined(tools[0], "tools[0] test invariant").parameters as {
      properties?: Record<string, Record<string, unknown>>;
    };
    const language = parameters.properties?.language;

    expect(language).toMatchObject({
      type: "string",
      enum: ["javascript", "typescript"],
    });
    expect(language).not.toHaveProperty("anyOf");
    expect(language).not.toHaveProperty("oneOf");
  });

  it("describes code-mode runtime constraints in the model-visible exec schema", () => {
    const { tools } = createCodeModeHarness();
    const execTool = expectDefined(tools[0], "tools[0] test invariant");
    const parameters = execTool.parameters as {
      properties?: Record<string, Record<string, unknown>>;
    };

    expect(execTool.description).toContain("Node.js modules");
    expect(execTool.description).toContain(
      "`require`, `import`, `process`, and `fs` are unavailable",
    );
    expect(execTool.description).toContain("Prefer enabled direct methods on `tools`");
    expect(execTool.description).toContain(
      "a trailing guest tool call or local result expression is auto-returned",
    );
    expect(execTool.description).toContain(
      "A requested verification is incomplete until its verification tool call runs",
    );
    expect(execTool.description).toContain("never add `state/workspaces` or `/workspace` prefixes");
    expect(execTool.description).not.toContain("include write and read in one cell");
    expect(execTool.description).not.toContain('tools.read({ path: "notes.txt" })');
    expect(execTool.description).toContain("Use the requested workspace-relative path exactly");
    expect(execTool.description).toContain("Await dependent calls in order");
    expect(execTool.description).toContain("normal policy and approvals");
    expect(execTool.description).toContain("ALL_TOOLS");
    expect(execTool.description).toContain("`await tools.search(query)`");
    expect(execTool.description).toContain("`tools.callValue(id, args)`");
    expect(execTool.description).toContain("Never invent or transform ids");
    expect(execTool.description).toContain("Return unknown result shapes raw");
    expect(parameters.properties?.code?.description).not.toContain("tools.read");
    expect(parameters.properties?.code?.description).toContain("Obey every step");
    expect(parameters.properties?.code?.description).toContain("No imports/process/fs");
    expect(parameters.properties?.language?.description).toContain("Defaults to javascript");
    expect(parameters).toMatchObject({ required: ["code"] });
    expect(parameters.properties).not.toHaveProperty("command");
    expect(parameters.properties).not.toHaveProperty("restartSafe");
  });

  it("describes host-enforced read-only recovery without repeating mutations", () => {
    const { config, catalogRef, tools } = createCodeModeHarness({
      forceReadOnlyTools: true,
    });
    const compacted = applyCodeModeCatalog({
      tools: [
        ...tools,
        fakeTool("read", "Read a file"),
        fakeTool("write", "Write a file"),
        fakeTool("edit", "Edit a file"),
        fakeTool("apply_patch", "Apply a patch"),
        pluginTool("search", "Search a plugin"),
      ],
      config,
      catalogRef,
      directToolNames: ["read", "write", "edit", "apply_patch", "search"],
      forceReadOnlyTools: true,
    });
    const exec = compacted.tools.find((tool) => tool.name === CODE_MODE_EXEC_TOOL_NAME);
    const parameters = exec?.parameters as {
      properties?: { code?: { description?: string } };
    };

    expect(compacted.tools.map((tool) => tool.name)).toEqual([
      CODE_MODE_EXEC_TOOL_NAME,
      CODE_MODE_WAIT_TOOL_NAME,
    ]);
    expect(exec?.description).toContain("read-only recovery");
    expect(exec?.description).toContain("- tools.read(");
    expect(exec?.description).not.toContain("- tools.write(");
    expect(exec?.description).not.toContain("- tools.edit(");
    expect(exec?.description).not.toContain("- tools.apply_patch(");
    expect(exec?.description).not.toContain("- tools.search(");
    expect(exec?.description).not.toContain("For write verification");
    expect(exec?.description).not.toContain("tools.edit({");
    expect(parameters.properties?.code?.description).toMatch(
      /Read-only recovery.*Do not repeat mutations.*verify existing state/,
    );
    expect(parameters.properties?.code?.description).toContain("Multiple reads:");
    expect(parameters.properties?.code?.description).not.toContain("await tools.write");
    expect(parameters.properties?.code?.description).not.toContain("await tools.edit");
  });

  it("advertises concrete read/write patterns only when both methods exist", () => {
    const { config, catalogRef, tools } = createCodeModeHarness();
    const edit = fakeTool("edit", "Edit a file");
    edit.parameters = Type.Object({
      path: Type.String(),
      edits: Type.Array(
        Type.Object({
          oldText: Type.String(),
          newText: Type.String(),
        }),
      ),
    });
    const compacted = applyCodeModeCatalog({
      tools: [
        ...tools,
        fakeTool("read", "Read a file"),
        fakeTool("write", "Write a file"),
        edit,
        fakeTool("nodes", "Use paired nodes"),
      ],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });
    const execTool = expectDefined(compacted.tools[0], "exec tool test invariant");
    const parameters = execTool.parameters as {
      properties?: Record<string, Record<string, unknown>>;
    };
    const nodesGuidance =
      "- nodes: paired Gateway nodes; nodes.list(), (await nodes.get(id)).invoke(command, params)";

    expect(execTool.description).toContain("include write and read in one cell");
    expect(execTool.description).toContain(
      'tools.edit({ path: "file.txt", edits: [{ oldText: "old", newText: "new" }] })',
    );
    expect(execTool.description).toContain(
      "`oldText` is the exact text being removed and `newText` is its replacement",
    );
    expect(execTool.description).toContain("use its result; never use the key name as the value");
    expect(execTool.description).toContain("never substitute `tools.write`");
    expect(execTool.description).toContain('tools.read({ path: "notes.txt" })');
    expect(execTool.description).toContain("call every read in the same exec");
    expect(execTool.description).toContain(
      "- tools.edit({ edits: Array<{ newText: string; oldText: string }>; path: string })",
    );
    expect(execTool.description).toContain(nodesGuidance);
    expect(execTool.description.indexOf(nodesGuidance)).toBe(
      execTool.description.lastIndexOf(nodesGuidance),
    );
    expect(parameters.properties?.code?.description).toContain("Read -> write -> verify");
    expect(parameters.properties?.code?.description).toContain(
      'tools.edit({path:"file.txt",edits:[{oldText:"exact old",newText:"exact new"}]})',
    );
    expect(parameters.properties?.code?.description).toContain(
      'const a=await tools.read({path:"first.txt"})',
    );
    expect(parameters.properties?.code?.description).toContain(
      "code ending at the mutation is invalid",
    );
    expect(parameters.properties?.code?.description).toContain(
      'const value=source.field("requested_key")',
    );
    expect(parameters.properties?.code?.description).toContain(
      'await tools.write({path:"output.txt",content:value})',
    );
    expect(parameters.properties?.code?.description).toContain(
      'return (await tools.read({path:"output.txt"})).content',
    );
    expect(parameters.properties?.code?.description).toContain(
      "Use the extracted value, never the key name",
    );
    expect(parameters.properties?.code?.description).toContain(
      "do not use Number/parseInt/parseFloat",
    );
  });

  it("keeps core coding methods visible when the direct-method index is truncated", () => {
    const { config, catalogRef, tools } = createCodeModeHarness();
    const edit = fakeTool("edit", "Edit a file");
    edit.parameters = Type.Object({
      path: Type.String(),
      edits: Type.Array(
        Type.Object({
          oldText: Type.String(),
          newText: Type.String(),
        }),
      ),
    });
    const fillers = Array.from({ length: 80 }, (_, index) =>
      fakeTool(`tool_${index}`, "Short filler tool"),
    );
    const compacted = applyCodeModeCatalog({
      tools: [
        ...tools,
        ...fillers,
        fakeTool("read", "Read a file"),
        fakeTool("write", "Write a file"),
        edit,
      ],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const description = compacted.tools[0]?.description ?? "";
    expect(description).toContain("- tools.read(");
    expect(description).toContain("- tools.write(");
    expect(description).toContain("- tools.edit(");
    expect(description.match(/^- tools\./gmu)).toHaveLength(12);
    expect(description).toContain("more direct methods omitted");
  });

  it("keeps code-mode exec guidance compact without advertising unavailable namespaces", () => {
    const { config, catalogRef, tools } = createCodeModeHarness();
    const compacted = applyCodeModeCatalog({
      tools: [...tools, pluginTool("fake_noop", "Noop")],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const execTool = expectDefined(compacted.tools[0], "exec tool test invariant");
    const parameters = execTool.parameters as {
      properties?: Record<string, Record<string, unknown>>;
    };
    const codeDescription = parameters.properties?.code?.description;

    expect(execTool.description.length).toBeLessThan(1_200);
    expect(execTool.description).toContain("`Promise.all` only for independent work");
    expect(codeDescription).toEqual(expect.any(String));
    expect(String(codeDescription).length).toBeLessThan(140);
    expect(codeDescription).not.toContain("MCP namespace globals");
    expect(codeDescription).not.toContain("`API` virtual declaration files");
  });

  it("primes exec with direct native tool signatures and compact contracts", () => {
    const { config, catalogRef, tools } = createCodeModeHarness();
    const alpha = pluginTool("alpha_tool", "Another deferred description.");
    alpha.outputSchema = Type.Array(
      Type.Object({ id: Type.String(), score: Type.Number() }, { additionalProperties: false }),
    );
    const compacted = applyCodeModeCatalog({
      tools: [...tools, pluginTool("zeta_tool", "Description stays deferred."), alpha],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const description = compacted.tools[0]?.description ?? "";
    expect(description).toContain(
      "- tools.alpha_tool({ value?: string }) -> Array<{ id: string; score: number }>",
    );
    expect(description).toContain("- tools.zeta_tool({ value?: string })");
    expect(description).not.toContain("Description stays deferred.");
    expect(description).not.toContain("Another deferred description.");
    expect(description).not.toContain("openclaw:fake-code-mode:");
  });

  it("omits direct methods that the guest cannot expose unambiguously", () => {
    const { config, catalogRef, tools } = createCodeModeHarness();
    const compacted = applyCodeModeCatalog({
      tools: [
        ...tools,
        pluginTool("shared_name", "First", "first"),
        pluginTool("shared_name", "Second", "second"),
        pluginTool("bad-name", "Invalid identifier"),
        pluginTool("search", "Reserved method"),
        pluginTool("exec", "Reserved control name"),
        pluginTool("wait", "Reserved control name"),
        pluginTool("safe_name", "Usable method"),
      ],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const description = compacted.tools[0]?.description ?? "";
    expect(description).toContain("tools.safe_name");
    expect(description).not.toContain("tools.shared_name");
    expect(description).not.toContain("tools.bad-name");
    expect(description).not.toContain("tools.search(input:");
    expect(description).not.toContain("tools.exec(input:");
    expect(description).not.toContain("tools.wait(input:");
  });

  it("keeps short methods when verbose contracts exceed the signature budget", () => {
    const { config, catalogRef, tools } = createCodeModeHarness();
    const pluginId = `fake-${"x".repeat(120)}`;
    const catalogTools = Array.from({ length: 100 }, (_, index) =>
      pluginTool(`fake_${index.toString().padStart(3, "0")}`, "Deferred", pluginId),
    );
    // Alphabetically last, but carries a declared output contract.
    const contracted = pluginTool("zzz_contracted_tool", "Deferred", pluginId);
    (contracted as { outputSchema?: unknown }).outputSchema = Type.Object(
      { ok: Type.Boolean() },
      { additionalProperties: false },
    );
    const compacted = applyCodeModeCatalog({
      tools: [...tools, ...catalogTools, contracted],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const description = compacted.tools[0]?.description ?? "";
    const indexStart = description.indexOf("Enabled direct methods inside code");
    const index = indexStart >= 0 ? description.slice(indexStart) : "";
    expect(index).toContain("more direct methods omitted");
    expect(index).toContain("tools.fake_011");
    expect(index).not.toContain("tools.zzz_contracted_tool");
    expect(index).not.toContain("tools.fake_012");
  });

  it("skips one oversized method signature without blanking the index", () => {
    const { config, catalogRef, tools } = createCodeModeHarness();
    const oversized = pluginTool(`a_${"z".repeat(9_000)}`, "Deferred");
    (oversized as { outputSchema?: unknown }).outputSchema = Type.Object(
      { ok: Type.Boolean() },
      { additionalProperties: false },
    );
    const shortContracted = Array.from({ length: 4 }, (_, index) => {
      const tool = pluginTool(`b_short_${index}`, "Deferred");
      (tool as { outputSchema?: unknown }).outputSchema = Type.Object(
        { ok: Type.Boolean() },
        { additionalProperties: false },
      );
      return tool;
    });
    const compacted = applyCodeModeCatalog({
      tools: [...tools, oversized, ...shortContracted],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const description = compacted.tools[0]?.description ?? "";
    const indexStart = description.indexOf("Enabled direct methods inside code");
    const index = indexStart >= 0 ? description.slice(indexStart) : "";
    expect(index.length).toBeLessThanOrEqual(1_600);
    expect(index).not.toContain("z".repeat(9_000));
    for (let i = 0; i < 4; i += 1) {
      expect(index).toContain(`b_short_${i}`);
    }
  });

  it("keeps a thousand-tool method index deterministic and bounded", () => {
    const build = () => {
      const { config, catalogRef, tools } = createCodeModeHarness();
      const catalogTools = Array.from({ length: 1_024 }, (_, index) =>
        pluginTool(`tool_${index.toString().padStart(4, "0")}`, "Deferred", "catalog-owner"),
      );
      const compacted = applyCodeModeCatalog({
        tools: [...tools, ...catalogTools],
        config,
        sessionId: "session-code-mode",
        sessionKey: "agent:main:main",
        runId: "run-code-mode",
        catalogRef,
      });
      const description = compacted.tools[0]?.description ?? "";
      const start = description.indexOf("Enabled direct methods inside code");
      return start >= 0 ? description.slice(start) : "";
    };
    const first = build();
    for (let i = 0; i < 5; i += 1) {
      expect(build()).toBe(first);
    }
    expect(first.length).toBeLessThanOrEqual(1_600);
    expect(first).toContain("tools.tool_0000");
    expect(first).toContain("more direct methods omitted");
    expect(first).not.toContain("tools.tool_1023");
  });

  it("omits MCP and namespace guidance from the exec schema when the run catalog has neither", () => {
    const { config, catalogRef, tools } = createCodeModeHarness();
    const compacted = applyCodeModeCatalog({
      tools: [...tools, pluginTool("fake_noop", "Noop")],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const description = compacted.tools[0]?.description ?? "";
    // Base tool guidance always stays; MCP/API and namespace guidance drop out so
    // the model never probes an empty virtual API surface.
    expect(description).toContain("`await tools.search(query)`");
    expect(description).not.toContain("API.list");
    expect(description).not.toContain("MCP tools are available only through");
    expect(description).not.toContain("MCP namespace globals");
  });

  it("keeps MCP guidance in the exec schema when the run catalog has MCP tools", () => {
    const { config, catalogRef, tools } = createCodeModeHarness();
    const compacted = applyCodeModeCatalog({
      tools: [
        ...tools,
        pluginTool("fake_noop", "Noop"),
        mcpTool({
          name: "github__create_issue",
          serverName: "github",
          toolName: "create_issue",
          parameters: {
            type: "object",
            properties: { malicious_prompt: { type: "string" } },
          },
        }),
      ],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const description = compacted.tools[0]?.description ?? "";
    expect(description).toContain("API.list(prefix?)");
    expect(description).toContain("MCP tools are available only through");
    expect(description).toContain("tools.fake_noop");
    expect(description).not.toContain("github__create_issue");
    expect(description).not.toContain("malicious_prompt");
  });

  it("removes legacy Tool Search controls from the visible code mode surface", () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    const compacted = applyCodeModeCatalog({
      tools: [
        ...codeModeTools,
        fakeTool(TOOL_SEARCH_CODE_MODE_TOOL_NAME, "legacy code surface"),
        fakeTool(TOOL_SEARCH_RAW_TOOL_NAME, "legacy search"),
        fakeTool(TOOL_DESCRIBE_RAW_TOOL_NAME, "legacy describe"),
        fakeTool(TOOL_CALL_RAW_TOOL_NAME, "legacy call"),
        pluginTool("fake_create_ticket", "Create a fake ticket"),
      ],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    expect(compacted.tools.map((tool) => tool.name)).toEqual([
      CODE_MODE_EXEC_TOOL_NAME,
      CODE_MODE_WAIT_TOOL_NAME,
    ]);
    expect(compacted.catalogToolCount).toBe(1);
  });
});
