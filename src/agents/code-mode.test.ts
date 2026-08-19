/** Tests Code Mode catalog and model-visible surface. */

import { expectDefined } from "@openclaw/normalization-core";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as codeModeExecution from "./code-mode-execution.js";
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
  pluginToolWithExecute,
  mcpTool,
  createCodeModeHarness,
} from "./code-mode.test-support.js";
import {
  createToolSearchCatalogRef,
  TOOL_CALL_RAW_TOOL_NAME,
  TOOL_DESCRIBE_RAW_TOOL_NAME,
  TOOL_SEARCH_CODE_MODE_TOOL_NAME,
  TOOL_SEARCH_RAW_TOOL_NAME,
  resolveToolSearchConfig,
  ToolSearchRuntime,
} from "./tool-search.js";
import { jsonResult } from "./tools/common.js";

describe("Code Mode catalog and model-visible surface", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetCodeModeTestState();
  });

  const runTerminalNestedCall = async (
    params: Pick<
      Parameters<typeof codeModeExecution.runCodeModeExec>[0],
      "toolCallId" | "ctx" | "onRuntime"
    >,
  ) => {
    const runtime = new ToolSearchRuntime(params.ctx, resolveToolSearchConfig({} as never));
    params.onRuntime?.(runtime);
    await runtime.call("terminal_action", {}, { parentToolCallId: params.toolCallId });
    return {
      status: "completed" as const,
      value: null,
      output: [],
      replaySafe: false,
      telemetry: {
        ...runtime.telemetry(),
        visibleTools: [CODE_MODE_EXEC_TOOL_NAME, CODE_MODE_WAIT_TOOL_NAME],
      },
    };
  };

  it("projects a nested terminal result from exec", async () => {
    const { config, catalogRef, tools } = createCodeModeHarness();
    vi.spyOn(codeModeExecution, "runCodeModeExec").mockImplementation(runTerminalNestedCall);
    const terminal = pluginToolWithExecute("terminal_action", "Terminal action", async () => ({
      ...jsonResult({ terminal: true }),
      terminate: true,
    }));
    applyCodeModeCatalog({
      tools: [...tools, terminal],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const result = await expectDefined(tools[0], "exec tool").execute("exec-terminal", {
      code: 'return await tools.call("terminal_action", {});',
    });

    expect(result.details).toMatchObject({ status: "completed" });
    expect(result.terminate).toBe(true);
  });

  it("projects a terminal result reached through wait", async () => {
    const { config, catalogRef, tools } = createCodeModeHarness();
    vi.spyOn(codeModeExecution, "runCodeModeExec").mockImplementation(async (params) => {
      const runtime = new ToolSearchRuntime(params.ctx, resolveToolSearchConfig({} as never));
      return {
        status: "waiting",
        runId: "terminal-run",
        reason: "yield",
        pendingToolCalls: [],
        output: [],
        replaySafe: false,
        telemetry: {
          ...runtime.telemetry(),
          visibleTools: [CODE_MODE_EXEC_TOOL_NAME, CODE_MODE_WAIT_TOOL_NAME],
        },
      };
    });
    vi.spyOn(codeModeExecution, "runWait").mockImplementation(runTerminalNestedCall);
    const terminal = pluginToolWithExecute("terminal_action", "Terminal action", async () => ({
      ...jsonResult({ terminal: true }),
      terminate: true,
    }));
    applyCodeModeCatalog({
      tools: [...tools, terminal],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const suspended = await expectDefined(tools[0], "exec tool").execute("exec-wait-terminal", {
      code: 'await yield_control("pause"); return await tools.call("terminal_action", {});',
    });
    expect(suspended.details).toMatchObject({ status: "waiting", reason: "yield" });
    const result = await expectDefined(tools[1], "wait tool").execute("wait-terminal", {
      runId: (suspended.details as { runId: string }).runId,
    });

    expect(result.terminate).toBe(true);
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
    expect(execTool?.description).toContain("Use `return` to pass the final value back");
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
    expect(execTool.description).toContain("`require`/`import` are NOT available");
    expect(execTool.description).toContain("process them in the first exec");
    expect(execTool.description).toContain("do not spend another exec inspecting");
    expect(execTool.description).toContain("dependent reads, checks, and follow-up calls in order");
    expect(execTool.description).toContain("normal tool policy and approvals");
    expect(execTool.description).toContain("`ALL_TOOLS` is the complete compact catalog");
    expect(execTool.description).toContain("`tools.search(query: string, options?)`");
    expect(execTool.description).toContain("enabled catalog tools allowed by policy");
    expect(execTool.description).toContain("`tools.describe(id: string)`");
    expect(execTool.description).toContain("`tools.callValue(id: string, args?)`");
    expect(execTool.description).toContain("`tools.call(id: string, args?)`");
    expect(execTool.description).toContain("Never invent or transform a tool id");
    expect(execTool.description).toContain("Quick-index arrows show trusted declared output hints");
    expect(execTool.description).toContain("`-> ?` means never guess result field names");
    expect(execTool.description).toContain("never guess result field names");
    expect(execTool.description).toContain("return the raw tool value unchanged");
    expect(execTool.description).toContain("final dependent call after declared-output calls");
    expect(execTool.description).toContain("do not wrap it in the requested answer shape");
    expect(execTool.description).toContain("filter or map it only in a later exec");
    expect(execTool.description).toContain("returns its JSON value directly");
    expect(execTool.description).toContain("const hit = ALL_TOOLS.find");
    expect(execTool.description).toContain('"javascript" or "typescript"');
    expect(execTool.description).toContain("never a shell command");
    expect(execTool.description).toContain("do not retry failed shell source");
    const nodesGuidance =
      "- nodes: paired Gateway nodes; nodes.list(), (await nodes.get(id)).invoke(command, params)";
    expect(execTool.description).toContain(nodesGuidance);
    expect(execTool.description.indexOf(nodesGuidance)).toBe(
      execTool.description.lastIndexOf(nodesGuidance),
    );

    expect(parameters.properties?.code?.description).toContain("no Python, shell");
    expect(parameters.properties?.code?.description).toContain(
      "a trailing expression is discarded and yields `null`",
    );
    expect(parameters.properties?.code?.description).toContain(
      'tools.callValue("openclaw:core:read", { path: "notes.txt" })',
    );
    expect(parameters.properties?.code?.description).toContain("Use `callValue`, not `call`");
    expect(parameters.properties?.code?.description).toContain("return file.content");
    expect(parameters.properties?.code?.description).toContain(
      "return it first, then parse it in a later exec",
    );
    expect(parameters.properties?.code?.description).toContain(
      "exact ids from `ALL_TOOLS` or `tools.search(query)`",
    );
    expect(parameters.properties?.code?.description).toContain("`ALL_TOOLS`");
    expect(parameters.properties?.code?.description).toContain("`require`, `import`");
    expect(parameters.properties?.restartSafe?.description).toContain(
      "Leave unset for ordinary calls",
    );
    expect(parameters.properties?.restartSafe?.description).toContain("not proven replay-safe");
    expect(parameters.properties?.language?.description).toContain(
      'Must be "javascript" or "typescript"',
    );
    expect(parameters).toMatchObject({ required: ["code"] });
    expect(parameters.properties).not.toHaveProperty("command");
  });

  it("drops the nodes namespace hint when the run catalog cannot resolve it", () => {
    const { config, catalogRef, tools } = createCodeModeHarness();
    const compacted = applyCodeModeCatalog({
      tools: [...tools, pluginTool("fake_noop", "Noop")],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    // The compacted catalog is known and holds no openclaw:core:nodes entry
    // (owner-only surfaces filter it); advertising the namespace anyway sends
    // the model into guaranteed unknown-tool failures.
    const execTool = expectDefined(compacted.tools[0], "exec tool test invariant");
    expect(catalogRef.current?.entries.some((entry) => entry.id === "openclaw:core:nodes")).toBe(
      false,
    );
    expect(execTool.description).not.toContain("paired Gateway nodes");
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

    expect(execTool.description.length).toBeLessThan(2_400);
    expect(execTool.description).toContain("parallelize independent work only");
    expect(execTool.description).toContain("`setTimeout` and `clearTimeout`");
    expect(execTool.description).toContain("65536 bytes");
    expect(execTool.description).toContain("rerun with narrower args");
    expect(codeDescription).toEqual(expect.any(String));
    expect(String(codeDescription).length).toBeLessThan(620);
    expect(codeDescription).not.toContain("MCP namespace globals");
    expect(codeDescription).not.toContain("`API` virtual declaration files");
  });

  it("primes the exec schema with exact native tool ids and compact contracts", () => {
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
    expect(description).toContain("descriptions are intentionally deferred");
    expect(description).toContain("OUTPUT DECLARED RULE");
    expect(description).toContain(
      '- "openclaw:fake-code-mode:alpha_tool" { value?: string } -> Array<{ id: string; score: number }>',
    );
    expect(description).toContain('- "openclaw:fake-code-mode:zeta_tool" { value?: string } -> ?');
    expect(description.indexOf("alpha_tool")).toBeLessThan(description.indexOf("zeta_tool"));
    expect(description).not.toContain("Description stays deferred.");
    expect(description).not.toContain("Another deferred description.");
  });

  it("keeps a typical 72-tool catalog fully indexed", () => {
    const { config, catalogRef, tools } = createCodeModeHarness();
    const catalogTools = Array.from({ length: 72 }, (_, index) =>
      pluginTool(`tool_${index.toString().padStart(3, "0")}`, "Deferred", "catalog-owner"),
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
    expect(description).toContain('"openclaw:catalog-owner:tool_071"');
    expect(description).not.toContain("additional OpenClaw/plugin tools omitted");
  });

  it("keeps declared-output tools indexed when truncation drops unknown-output lines", () => {
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
    const indexStart = description.indexOf("OpenClaw/plugin tool quick index");
    const index = indexStart >= 0 ? description.slice(indexStart) : "";
    expect(index).toContain("additional OpenClaw/plugin tools omitted");
    expect(index).toContain("zzz_contracted_tool");
    expect(index).toContain("-> { ok: boolean }");
  });

  it("skips a single oversized entry instead of blanking the whole index", () => {
    const { config, catalogRef, tools } = createCodeModeHarness();
    // One declared tool whose line alone blows the 8000-char budget; it sorts
    // first among declared tools, so a prefix cut would zero the entire index.
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
    const indexStart = description.indexOf("OpenClaw/plugin tool quick index");
    const index = indexStart >= 0 ? description.slice(indexStart) : "";
    expect(index.length).toBeLessThanOrEqual(8_000);
    // The oversized line is skipped, but every short declared contract survives.
    expect(index).not.toContain("z".repeat(9_000));
    for (let i = 0; i < 4; i += 1) {
      expect(index).toContain(`b_short_${i}`);
    }
  });

  it("renders a deterministic truncated index across rebuilds", () => {
    const build = () => {
      const { config, catalogRef, tools } = createCodeModeHarness();
      const catalogTools = Array.from({ length: 100 }, (_, index) =>
        pluginTool(
          `fake_${index.toString().padStart(3, "0")}`,
          "Deferred",
          `fake-${"x".repeat(120)}`,
        ),
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
      const start = description.indexOf("OpenClaw/plugin tool quick index");
      return start >= 0 ? description.slice(start) : "";
    };
    const first = build();
    for (let i = 0; i < 5; i += 1) {
      expect(build()).toBe(first);
    }
    expect(first).toContain("additional OpenClaw/plugin tools omitted");
  });

  it("bounds the model-visible native tool index", () => {
    const { config, catalogRef, tools } = createCodeModeHarness();
    const pluginId = `fake-${"x".repeat(120)}`;
    const catalogTools = Array.from({ length: 100 }, (_, index) =>
      pluginTool(`fake_${index.toString().padStart(3, "0")}`, "Deferred", pluginId),
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
    const indexStart = description.indexOf("OpenClaw/plugin tool quick index");
    const index = indexStart >= 0 ? description.slice(indexStart) : "";
    expect(index.length).toBeLessThanOrEqual(8_000);
    expect(index).toContain("additional OpenClaw/plugin tools omitted");
    expect(index).not.toContain("fake_099");
  });

  it("keeps a thousand-tool catalog index deterministic and within its character budget", () => {
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
    const indexStart = description.indexOf("OpenClaw/plugin tool quick index");
    const index = indexStart >= 0 ? description.slice(indexStart) : "";

    expect(index.length).toBeLessThanOrEqual(8_000);
    expect(index).toContain('"openclaw:catalog-owner:tool_0000"');
    expect(index).toContain("additional OpenClaw/plugin tools omitted");
    expect(index).not.toContain('"openclaw:catalog-owner:tool_1023"');
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
    expect(description).toContain("`tools.search(query: string, options?)`");
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
    expect(description).toContain('"openclaw:fake-code-mode:fake_noop"');
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
