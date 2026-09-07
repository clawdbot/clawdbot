/** Tests Code Mode catalog and model-visible surface. */

import { expectDefined } from "@openclaw/normalization-core";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as codeModeExecution from "./code-mode-execution.js";
import {
  addClientToolsToCodeModeCatalog,
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
import { readToolInputSchema } from "./sessions/tools/read-tool-contract.js";
import { ToolSearchRuntime } from "./tool-search-runtime.js";
import {
  createToolSearchCatalogRef,
  TOOL_CALL_RAW_TOOL_NAME,
  TOOL_DESCRIBE_RAW_TOOL_NAME,
  TOOL_SEARCH_CODE_MODE_TOOL_NAME,
  TOOL_SEARCH_RAW_TOOL_NAME,
  resolveToolSearchConfig,
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
      code: "return await terminal_action({});",
    });

    expect(result.details).toMatchObject({ status: "completed" });
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
    expect(compacted.tools[0]?.description).toContain(
      "Use the shell tool `exec` for heavier computation",
    );
  });

  it("removes shell-computation guidance when a client shadows the shell tool", () => {
    const { ctx, tools } = createCodeModeHarness();
    const compacted = applyCodeModeCatalog({
      ...ctx,
      tools: [...tools, fakeTool("exec", "Run shell command")],
    });
    const execTool = expectDefined(compacted.tools[0], "exec tool test invariant");
    expect(execTool.description).toContain("Use the shell tool `exec` for heavier computation");

    addClientToolsToCodeModeCatalog({
      ...ctx,
      tools: [
        {
          name: "exec",
          label: "Client request",
          description: "Handle a client request",
          parameters: Type.Object({ request: Type.String() }),
          execute: async () => jsonResult({ accepted: true }),
        },
      ],
    });

    expect(execTool.description).toContain("- exec unknown -> ?");
    expect(execTool.description).not.toContain("heavier computation");
    expect(execTool.description).toContain("10000 ms wall-clock budget");
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
    expect(execTool?.description).toContain("Return the final value");
  });

  it("hides normal tools when only the active agent enables code mode", () => {
    const catalogRef = createToolSearchCatalogRef();
    const config: OpenClawConfig = {
      agents: {
        entries: { ops: { tools: { codeMode: true } } },
      },
    };
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
    expect(parameters.properties?.title).toMatchObject({
      type: "string",
      maxLength: 120,
      description: expect.stringContaining("never claim success"),
    });

    expect(execTool.description).toContain("Node.js modules");
    expect(execTool.description).toContain("`require`/`import` are NOT available");
    expect(execTool.description).toContain("Enabled tools are async global functions");
    expect(execTool.description).toContain("Await dependent calls in order");
    expect(execTool.description).toContain("independent calls may run with Promise.all");
    expect(execTool.description).toContain(
      "Declared output fields may feed later calls in the same program",
    );
    expect(execTool.description).toContain(
      'const [tool] = await catalog.search("..."); return await tool({...});',
    );
    expect(execTool.description).toContain("normal tool policy and approvals");
    expect(execTool.description).toContain("`catalog.search(query)`");
    expect(execTool.description).toContain("results are callable");
    expect(execTool.description).toContain("`-> ?` means unknown output");
    expect(execTool.description).toContain("do not feed it into guessed field-dependent logic");
    expect(execTool.description).toContain("use a later `exec` for dependent composition");
    expect(execTool.description).not.toContain("ALL_TOOLS");
    expect(execTool.description).not.toContain("tools.call");
    expect(execTool.description).not.toContain("exact id");
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
      "a trailing expression yields `null`",
    );
    expect(parameters.properties?.code?.description).toContain(
      "Call enabled async globals directly",
    );
    expect(parameters.properties?.code?.description).toContain(
      "independent calls may use Promise.all",
    );
    expect(parameters.properties?.code?.description).toContain(
      "Declared output fields may feed later calls in the same program",
    );
    expect(parameters.properties?.code?.description).toContain(
      'const [tool] = await catalog.search("..."); return await tool({...});',
    );
    expect(parameters.properties?.code?.description).toContain("`catalog.search(query)`");
    expect(parameters.properties?.code?.description).toContain(
      "cannot feed guessed dependent logic in the same program",
    );
    expect(parameters.properties?.code?.description).toContain("use a later `exec`");
    expect(parameters.properties?.code?.description).not.toContain("ALL_TOOLS");
    expect(parameters.properties?.code?.description).not.toContain("tools.call");
    expect(parameters.properties?.code?.description).toContain("`require`, or `import`");
    expect(parameters.properties?.restartSafe?.description).toContain("Do not set on a new exec");
    expect(parameters.properties?.restartSafe?.description).toContain(
      "only when OpenClaw explicitly requests replay after a gateway restart",
    );
    expect(parameters.properties?.restartSafe?.description).toContain(
      "never for write, edit, exec, or any mutation",
    );
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

  it.each([
    {
      name: "default budget",
      config: { tools: { codeMode: true } },
      expectedBudgetMs: 10_000,
      pluginName: "fake_noop",
    },
    {
      name: "configured budget with a plugin named exec",
      config: { tools: { codeMode: { enabled: true, timeoutMs: 2_750 } } },
      expectedBudgetMs: 2_750,
      pluginName: "exec",
    },
    {
      name: "agent budget override",
      config: {
        tools: { codeMode: { enabled: true, timeoutMs: 2_750 } },
        agents: { entries: { ops: { tools: { codeMode: { timeoutMs: 4_250 } } } } },
      },
      expectedBudgetMs: 4_250,
      pluginName: "fake_noop",
    },
    {
      name: "clamped effective budget",
      config: { tools: { codeMode: { enabled: true, timeoutMs: 90_000 } } },
      expectedBudgetMs: 60_000,
      pluginName: "fake_noop",
    },
  ] satisfies {
    name: string;
    config: OpenClawConfig;
    expectedBudgetMs: number;
    pluginName: string;
  }[])(
    "keeps exec guidance compact and scoped to $name",
    ({ config, expectedBudgetMs, pluginName }) => {
      const catalogRef = createToolSearchCatalogRef();
      const ctx = {
        config,
        agentId: "ops",
        sessionId: "session-code-mode",
        sessionKey: "agent:ops:main",
        runId: "run-code-mode",
        catalogRef,
      };
      const tools = createCodeModeTools({ ...ctx, runtimeConfig: config });
      const compacted = applyCodeModeCatalog({
        ...ctx,
        tools: [...tools, pluginTool(pluginName, "Noop")],
      });

      const execTool = expectDefined(compacted.tools[0], "exec tool test invariant");
      const parameters = execTool.parameters as {
        properties?: Record<string, Record<string, unknown>>;
      };
      const codeDescription = parameters.properties?.code?.description;

      expect(execTool.description.length).toBeLessThan(2_400);
      expect(execTool.description).toContain("independent calls may run with Promise.all");
      expect(execTool.description).toContain("`setTimeout` and `clearTimeout`");
      expect(execTool.description).toContain("65536 bytes");
      expect(execTool.description).toContain("rerun with narrower args");
      expect(execTool.description).toContain(`${expectedBudgetMs} ms wall-clock budget`);
      expect(execTool.description).toContain("per `exec`/`wait`");
      expect(execTool.description).toContain("approvals pause");
      expect(execTool.description).toContain("Guest computation over this budget times out");
      expect(execTool.description).toContain("`waiting` for `wait`");
      expect(execTool.description).not.toContain("heavier computation");
      expect(codeDescription).toEqual(expect.any(String));
      expect(String(codeDescription).length).toBeLessThan(620);
      expect(codeDescription).not.toContain("MCP namespace globals");
      expect(codeDescription).not.toContain("`API` virtual declaration files");
    },
  );

  it("primes the exec schema with callable names and compact contracts", () => {
    const { config, catalogRef, tools } = createCodeModeHarness();
    const alpha = pluginTool("alpha_tool", "Another deferred description.");
    const read = { ...fakeTool("read", "Read file"), parameters: readToolInputSchema };
    alpha.outputSchema = Type.Array(
      Type.Object({ id: Type.String(), score: Type.Number() }, { additionalProperties: false }),
    );
    const compacted = applyCodeModeCatalog({
      tools: [...tools, pluginTool("zeta_tool", "Description stays deferred."), alpha, read],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const description = compacted.tools[0]?.description ?? "";
    expect(description).toContain("descriptions are intentionally deferred");
    expect(description).toContain(
      "- alpha_tool { value?: string } -> Array<{ id: string; score: number }>",
    );
    expect(description).toContain("- zeta_tool { value?: string } -> ?");
    expect(description).toContain(
      "- read { path: string; cursor?: number /* integer, >= 0 */; limit?: number; offset?: number /* integer, >= 1 */; optional?: true } -> ?",
    );
    expect(description).not.toContain("openclaw:fake-code-mode");
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
    expect(description).toContain("tool_071");
    expect(description).not.toContain("additional tools omitted");
  });

  it("keeps declared-output tools indexed when truncation drops unknown-output lines", () => {
    const { config, catalogRef, tools } = createCodeModeHarness();
    const pluginId = `fake-${"x".repeat(120)}`;
    const catalogTools = Array.from({ length: 500 }, (_, index) =>
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
    const indexStart = description.indexOf("Enabled async tool globals");
    const index = indexStart >= 0 ? description.slice(indexStart) : "";
    expect(index).toContain("additional tools omitted");
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
    const indexStart = description.indexOf("Enabled async tool globals");
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
      const catalogTools = Array.from({ length: 500 }, (_, index) =>
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
      const start = description.indexOf("Enabled async tool globals");
      return start >= 0 ? description.slice(start) : "";
    };
    const first = build();
    for (let i = 0; i < 5; i += 1) {
      expect(build()).toBe(first);
    }
    expect(first).toContain("additional tools omitted");
  });

  it("bounds the model-visible native tool index", () => {
    const { config, catalogRef, tools } = createCodeModeHarness();
    const pluginId = `fake-${"x".repeat(120)}`;
    const catalogTools = Array.from({ length: 500 }, (_, index) =>
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
    const indexStart = description.indexOf("Enabled async tool globals");
    const index = indexStart >= 0 ? description.slice(indexStart) : "";
    expect(index.length).toBeLessThanOrEqual(8_000);
    expect(index).toContain("additional tools omitted");
    expect(index).not.toContain("fake_499");
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
    const indexStart = description.indexOf("Enabled async tool globals");
    const index = indexStart >= 0 ? description.slice(indexStart) : "";

    expect(index.length).toBeLessThanOrEqual(8_000);
    expect(index).toContain("tool_0000");
    expect(index).toContain("additional tools omitted");
    expect(index).not.toContain("tool_1023");
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
    expect(description).toContain("`catalog.search(query)`");
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
    expect(description).toContain("- fake_noop ");
    expect(description).not.toContain("openclaw:fake-code-mode");
    expect(description).not.toContain("github__create_issue");
    expect(description).not.toContain("malicious_prompt");
  });

  it("uses the canonical normalized callable names in the prompt index", () => {
    const { config, catalogRef, tools } = createCodeModeHarness();
    const compacted = applyCodeModeCatalog({
      tools: [
        ...tools,
        pluginTool("sessions_spawn", "Spawn a session"),
        pluginTool("llm-task", "Run an LLM task"),
        pluginTool("llm_task", "Run the exact-name task"),
        pluginTool("catalog", "Collide with discovery"),
        pluginTool("MCP", "Collide with the namespace global"),
        pluginTool("class", "Use a reserved word"),
        pluginTool("9patch", "Start with a digit"),
      ],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const description = compacted.tools[0]?.description ?? "";
    expect(description).toContain("- sessions_spawn ");
    expect(description).toContain("- llm_task ");
    expect(description).toMatch(/- llm_task_[a-f0-9]{8} /u);
    expect(description).toMatch(/- catalog_[a-f0-9]{8} /u);
    expect(description).toMatch(/- MCP_[a-f0-9]{8} /u);
    expect(description).toMatch(/- class_[a-f0-9]{8} /u);
    expect(description).toContain("- tool_9patch ");
    expect(description).not.toContain("openclaw:fake-code-mode");
  });

  it("normalizes a lone llm-task tool to llm_task", () => {
    const { config, catalogRef, tools } = createCodeModeHarness();
    const compacted = applyCodeModeCatalog({
      tools: [...tools, pluginTool("llm-task", "Run an LLM task")],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    expect(compacted.tools[0]?.description).toContain("- llm_task ");
    expect(compacted.tools[0]?.description).not.toMatch(/llm_task_[a-f0-9]{8}/u);
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
