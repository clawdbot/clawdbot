/** Tests Code Mode catalog and model-visible surface. */

import { expectDefined } from "@openclaw/normalization-core";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isCodeModeExecControlTool } from "./code-mode-control-tools.js";
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

  it("rewrites only the marked Code Mode exec when a raw exec stays direct", () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    const rawExec = {
      ...fakeTool("exec", "Run a raw shell command"),
      catalogMode: "direct-only" as const,
    };

    const compacted = applyCodeModeCatalog({
      tools: [...codeModeTools, rawExec],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });
    const markedExec = compacted.tools.find(isCodeModeExecControlTool);
    const visibleRawExec = compacted.tools.find((tool) => tool === rawExec);

    expect(markedExec?.description).toContain("OpenClaw Code Mode");
    expect(visibleRawExec?.description).toBe("Run a raw shell command");
    expect(isCodeModeExecControlTool(rawExec)).toBe(false);
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
    expect(execTool?.description).toContain("`return` sets final value");
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

  it("describes deterministic OpenClaw Code Mode composition in the exec schema", () => {
    const { tools } = createCodeModeHarness();
    const execTool = expectDefined(tools[0], "tools[0] test invariant");
    const parameters = execTool.parameters as {
      properties?: Record<string, Record<string, unknown>>;
    };

    expect(execTool.description).toContain("Run JavaScript or TypeScript in OpenClaw Code Mode");
    expect(execTool.description).toContain(
      "Declared fields support deterministic one-cell composition",
    );
    expect(execTool.description).toContain("`tools.search` catalog lookup stays inline");
    expect(execTool.description).toContain(
      "Stable target IDs from the request or trusted prior context",
    );
    expect(execTool.description).toContain(
      "List-derived conversation IDs require a complete owner snapshot",
    );
    expect(execTool.description).toContain("singleton output is insufficient");
    expect(execTool.description).toContain(
      "Return incomplete, duplicate, stale, or conflicting target evidence",
    );
    expect(execTool.description).not.toContain(
      "Application target identity discovered from tool data returns candidates",
    );
    expect(execTool.description).not.toContain(
      "Mutate application state inline only when the request or trusted prior context supplies",
    );
    expect(execTool.description).toContain("Compose dependent calls in order");
    expect(execTool.description).toContain("Nested calls enforce normal policy and approvals");
    expect(execTool.description).toContain("`ALL_TOOLS` is the complete compact catalog");
    expect(execTool.description).toContain("`tools.search(query: string, options?)`");
    expect(execTool.description).toContain("`tools.describe(id: string)`");
    expect(execTool.description).toContain("`tools.callValue(id: string, args?)`");
    expect(execTool.description).toContain("`tools.call(id: string, args?)`");
    expect(execTool.description).toContain("keep IDs unchanged");
    expect(execTool.description).toContain("Quick-index arrows are output hints");
    expect(execTool.description).toContain("`-> ?` marks unknown output");
    expect(execTool.description).toContain("stays raw for observation");
    expect(execTool.description).toContain("transform it later");
    expect(execTool.description).toContain("returns JSON");
    expect(execTool.description).toContain(
      "Use enabled catalog tools for shell, file, network, and external actions",
    );
    expect(execTool.description).toContain(
      "raw shell commands and Node.js `require`/`import` are unavailable",
    );
    expect(execTool.description).toContain('"javascript" or "typescript"');
    const nodesGuidance =
      "- nodes: paired Gateway nodes; nodes.list(), (await nodes.get(id)).invoke(command, params)";
    expect(execTool.description).toContain(nodesGuidance);
    expect(execTool.description.indexOf(nodesGuidance)).toBe(
      execTool.description.lastIndexOf(nodesGuidance),
    );

    expect(parameters.properties?.code?.description).toContain(
      "Run JavaScript or TypeScript in OpenClaw Code Mode",
    );
    expect(parameters.properties?.code?.description).toContain(
      "Declared fields enable deterministic transforms/dependent calls",
    );
    expect(parameters.properties?.code?.description).toContain(
      "`tools.search` resolves catalog IDs inline",
    );
    expect(parameters.properties?.code?.description).toContain(
      "Stable target IDs from request/trusted prior context",
    );
    expect(parameters.properties?.code?.description).toContain(
      "List-derived conversation IDs require one complete owner snapshot",
    );
    expect(parameters.properties?.code?.description).toContain(
      "one unique exact normalized address",
    );
    expect(parameters.properties?.code?.description).not.toContain(
      "Application target identity discovered from tool data",
    );
    expect(parameters.properties?.code?.description).toContain("stale, or conflicting evidence");
    expect(parameters.properties?.code?.description).toContain("`-> ?`: return raw, inspect later");
    expect(parameters.properties?.code?.description).toContain(
      "Use exact enabled catalog tools for shell/file/network/external actions",
    );
    expect(parameters.properties?.code?.description).toContain(
      "raw shell commands and Node `require`/`import` are unavailable",
    );
    expect(parameters.properties).not.toHaveProperty("restartSafe");
    expect(parameters.properties?.language?.description).toContain(
      'Must be "javascript" or "typescript"',
    );
    expect(parameters).toMatchObject({ required: ["code"] });
    expect(parameters.properties).not.toHaveProperty("command");
  });

  it("rebuilds the model-visible exec guidance deterministically", () => {
    const build = () => {
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
      return {
        description: execTool.description,
        parameters: execTool.parameters,
      };
    };

    expect(build()).toEqual(build());
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
    expect(execTool.description).toContain("parallelize independent work");
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
    expect(description).toContain("deterministic transforms and dependent calls");
    expect(description).toContain("`tools.search` catalog lookup stays inline");
    expect(description).toContain("Stable IDs supplied by the request/trusted prior context");
    expect(description).toContain(
      "List-derived conversation IDs require one complete owner snapshot",
    );
    expect(description).toContain("singleton output alone is insufficient");
    expect(description).toContain(
      "Return candidates/evidence when target identity remains ambiguous",
    );
    expect(description).not.toContain(
      "application target identity discovered from tool data returns candidates/evidence first",
    );
    expect(description).toContain("normal tool policy authorizes mutation");
    expect(description).toContain("unknown output shape is schema ambiguity");
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
