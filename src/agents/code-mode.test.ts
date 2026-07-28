/** Tests Code Mode tool registration, namespace filtering, and run lifecycle. */

import { expectDefined } from "@openclaw/normalization-core";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWithAgentToolExecutionContext } from "../../packages/agent-core/src/tool-execution-context.js";
import { setPluginToolMeta } from "../plugins/tools.js";
import type { Skill } from "../skills/loading/skill-contract.js";
import { resolveSkillsPromptForRun } from "../skills/loading/workspace.js";
import { createFixtureSkillEntry } from "../skills/test-support/test-helpers.js";
import { buildBlockedToolResult } from "./agent-tools.before-tool-call.js";
import { createOpenClawReadTool } from "./agent-tools.read.js";
import { resolveCodeModeSkills, type CodeModeSkill } from "./code-mode-skills.js";
import {
  applyCodeModeCatalog,
  CODE_MODE_EXEC_TOOL_NAME,
  CODE_MODE_WAIT_TOOL_NAME,
  createCodeModeTools,
  resolveCodeModeConfig,
} from "./code-mode.js";
import { testing } from "./code-mode.test-support.js";
import { createReadTool } from "./sessions/index.js";
import { createToolSearchCatalogRef, type ToolSearchCatalogRef } from "./tool-search.js";
import {
  TOOL_CALL_RAW_TOOL_NAME,
  TOOL_DESCRIBE_RAW_TOOL_NAME,
  TOOL_SEARCH_CODE_MODE_TOOL_NAME,
  TOOL_SEARCH_RAW_TOOL_NAME,
} from "./tool-search.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";

function skillCandidate(params: {
  name: string;
  description: string;
  filePath: string;
  readContent?: string;
}): Skill {
  return {
    ...params,
    baseDir: params.filePath.replace(/\/[^/]+$/u, ""),
    sourceInfo: {
      path: params.filePath,
      source: "test",
      scope: "temporary",
      origin: "top-level",
    },
    disableModelInvocation: false,
    source: "test",
  };
}

function fakeTool(name: string, description: string): AnyAgentTool {
  // Minimal tool shape keeps Code Mode catalog tests runtime-free.
  return {
    name,
    label: name,
    description,
    parameters: {
      type: "object",
      properties: {
        value: { type: "string" },
      },
    },
    execute: vi.fn(async (_toolCallId, input) => jsonResult({ name, input })),
  };
}

function pluginTool(name: string, description: string, pluginId = "fake-code-mode"): AnyAgentTool {
  const tool = fakeTool(name, description);
  setPluginToolMeta(tool, {
    pluginId,
    optional: true,
  });
  return tool;
}

function pluginToolWithExecute(
  name: string,
  description: string,
  execute: AnyAgentTool["execute"],
): AnyAgentTool {
  const tool = pluginTool(name, description);
  tool.execute = vi.fn(execute) as AnyAgentTool["execute"];
  return tool;
}

function mcpTool(params: {
  name: string;
  serverName: string;
  safeServerName?: string;
  toolName: string;
  description?: string;
  parameters?: AnyAgentTool["parameters"];
  operation?: "tool" | "resources_list" | "resources_read" | "prompts_list" | "prompts_get";
  execute?: AnyAgentTool["execute"];
}): AnyAgentTool {
  // MCP metadata drives Code Mode grouping and raw tool routing.
  const tool: AnyAgentTool = {
    name: params.name,
    label: params.toolName,
    description: params.description ?? `MCP ${params.toolName}`,
    parameters: params.parameters ?? {
      type: "object",
      properties: {},
    },
    execute:
      params.execute ??
      vi.fn(async (_toolCallId, input) =>
        jsonResult({
          serverName: params.serverName,
          toolName: params.toolName,
          input,
        }),
      ),
  };
  setPluginToolMeta(tool, {
    pluginId: "bundle-mcp",
    optional: false,
    mcp: {
      serverName: params.serverName,
      safeServerName: params.safeServerName ?? params.serverName,
      toolName: params.toolName,
      operation: params.operation ?? "tool",
    },
  });
  return tool;
}

function resultDetails(result: { details?: unknown }): Record<string, unknown> {
  expect(result.details).toBeDefined();
  expect(typeof result.details).toBe("object");
  return result.details as Record<string, unknown>;
}

function createCodeModeHarness(
  params: {
    agentId?: string;
    catalogRef?: ToolSearchCatalogRef;
    codeModeSkills?: readonly CodeModeSkill[];
    forceRestartSafeTools?: boolean;
  } = {},
) {
  const catalogRef = params.catalogRef ?? createToolSearchCatalogRef();
  const config = { tools: { codeMode: true } } as never;
  const ctx = {
    config,
    runtimeConfig: config,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionId: "session-code-mode",
    sessionKey: params.agentId ? `agent:${params.agentId}:main` : "agent:main:main",
    runId: "run-code-mode",
    catalogRef,
    forceRestartSafeTools: params.forceRestartSafeTools,
    codeModeSkills: params.codeModeSkills,
  };
  const tools = createCodeModeTools(ctx);
  return { catalogRef, config, ctx, tools };
}

async function runUntilCompleted(params: {
  execTool: AnyAgentTool;
  waitTool: AnyAgentTool;
  code: string;
  language?: "javascript" | "typescript";
  restartSafe?: boolean;
}) {
  // Code Mode may return a waiting state before completion; tests poll through
  // the public wait tool instead of reaching into activeRuns.
  let details = resultDetails(
    await params.execTool.execute("code-call-1", {
      code: params.code,
      language: params.language,
      restartSafe: params.restartSafe,
    }),
  );
  for (let index = 0; index < 8 && details.status === "waiting"; index += 1) {
    const runId = details.runId;
    expect(typeof runId).toBe("string");
    details = resultDetails(await params.waitTool.execute(`code-wait-${index}`, { runId }));
  }
  return details;
}

describe("Code Mode", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    testing.activeRuns.clear();
    testing.resumingRunIds.clear();
    testing.setTypescriptRuntimeForTest(null);
  });

  it("resolves object config defaults", () => {
    expect(resolveCodeModeConfig({ tools: { codeMode: true } } as never).enabled).toBe(true);
    const resolved = resolveCodeModeConfig({
      tools: {
        codeMode: {
          timeoutMs: 1234,
          languages: ["typescript"],
        },
      },
    } as never);
    expect(resolved.enabled).toBe("auto");
    expect(resolveCodeModeConfig({ tools: { codeMode: { enabled: true } } } as never).enabled).toBe(
      true,
    );
    expect(resolved.runtime).toBe("quickjs-wasi");
    expect(resolved.mode).toBe("only");
    expect(resolved.timeoutMs).toBe(1234);
    expect(resolved.languages).toEqual(["typescript"]);
    const limitedSearch = resolveCodeModeConfig({
      tools: {
        codeMode: {
          enabled: true,
          maxSearchLimit: 3,
        },
      },
    } as never);
    expect(limitedSearch.searchDefaultLimit).toBe(3);
    expect(limitedSearch.maxSearchLimit).toBe(3);
  });

  it("resolves active-agent code mode over the runtime default", () => {
    const config = {
      tools: {
        codeMode: {
          enabled: false,
          timeoutMs: 1234,
          searchDefaultLimit: 6,
        },
      },
      agents: {
        list: [
          {
            id: "ops",
            tools: {
              codeMode: {
                enabled: true,
                searchDefaultLimit: 4,
              },
            },
          },
          {
            id: "chat",
            tools: {
              codeMode: false,
            },
          },
        ],
      },
    } as never;

    const ops = resolveCodeModeConfig(config, "ops");
    expect(ops.enabled).toBe(true);
    expect(ops.timeoutMs).toBe(1234);
    expect(ops.searchDefaultLimit).toBe(4);

    expect(resolveCodeModeConfig(config, "chat").enabled).toBe(false);
    expect(resolveCodeModeConfig(config, "missing").enabled).toBe(false);
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

    expect(parameters.properties?.code?.description).toContain(
      "`tools.search` takes a query string, not an object",
    );
    expect(parameters.properties?.command?.description).toContain("Not a shell command");
    expect(parameters.properties?.code?.description).toContain(
      "Select exact ids from `ALL_TOOLS` or `tools.search`",
    );
    expect(parameters.properties?.code?.description).toContain(
      "never put dependent calls in Promise.all",
    );
    expect(parameters.properties?.code?.description).toContain("`ALL_TOOLS`");
    expect(parameters.properties?.code?.description).toContain("Node built-in modules are not");
    expect(parameters.properties?.restartSafe?.description).toContain(
      "Leave unset for ordinary calls",
    );
    expect(parameters.properties?.language?.description).toContain(
      'Must be "javascript" or "typescript"',
    );
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
    expect(codeDescription).toEqual(expect.any(String));
    expect(String(codeDescription).length).toBeLessThan(320);
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

  it("accepts command as an exec-compatible code alias", async () => {
    const { config, catalogRef, tools } = createCodeModeHarness();
    applyCodeModeCatalog({
      tools: [...tools, pluginTool("fake_noop", "Noop")],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });
    const result = resultDetails(
      await expectDefined(tools[0], "tools[0] test invariant").execute("code-call-command-alias", {
        command: "return 7;",
      }),
    );

    expect(result.status).toBe("completed");
    expect(result.value).toBe(7);
  });

  it("rejects divergent code and command aliases", async () => {
    const { config, catalogRef, tools } = createCodeModeHarness();
    applyCodeModeCatalog({
      tools: [...tools, pluginTool("fake_noop", "Noop")],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    await expect(
      expectDefined(tools[0], "tools[0] test invariant").execute("code-call-divergent-alias", {
        code: "return 1;",
        command: "return 2;",
      }),
    ).rejects.toThrow("code and command must match when both are provided");
  });

  it("drains a nested combinator after its outer race wins", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    let nestedAborted = false;
    const never = pluginToolWithExecute(
      "fake_nested_race_never",
      "Never-settling nested race helper",
      async (_toolCallId, _input, signal) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 25);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              nestedAborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
        return jsonResult({ winner: "nested" });
      },
    );
    const fast = pluginToolWithExecute(
      "fake_nested_race_fast",
      "Fast nested race helper",
      async () => jsonResult({ winner: "fast" }),
    );
    applyCodeModeCatalog({
      tools: [...codeModeTools, never, fast],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = resultDetails(
      await expectDefined(codeModeTools[0], "Code Mode exec test invariant").execute(
        "code-call-nested-combinator-race",
        {
          code: `return await Promise.race([
            Promise.all([tools.callValue("fake_nested_race_never", {})]),
            tools.callValue("fake_nested_race_fast", {}),
          ]);`,
        },
      ),
    );

    expect(details).toMatchObject({ status: "completed", value: { winner: "fast" } });
    expect(never.execute).toHaveBeenCalledOnce();
    expect(fast.execute).toHaveBeenCalledOnce();
    expect(nestedAborted).toBe(false);
    expect(testing.activeRuns.size).toBe(0);
  });

  it.each([
    { code: "ls -la /workspace/" },
    { code: "ls -1" },
    { command: "ls -la /workspace/" },
    { code: "pwd", command: "pwd" },
    { command: "pwd;" },
    { command: "pwd; // inspect the workspace" },
    { code: "# inspect the workspace\npwd" },
    { code: "#!/bin/sh\npwd" },
    { code: "pwd\nls -la /workspace" },
    { command: "pwd;ls -la /workspace" },
    { command: "/bin/ls /workspace/" },
    { command: "./gradlew test" },
    { code: ".\\gradlew.bat test" },
    { command: ".\\script.ps1" },
    { code: "C:\\workspace\\run.cmd /q" },
    { code: "/workspace/run.sh --verbose" },
    { command: "sh -c 'ls /workspace/'" },
    { command: "git status" },
    { command: 'git status; const note = "git";' },
    { command: "ls -1; const metadata = { ls: true };" },
    { code: "ls -1; const note = 'function ls';" },
    { command: "ls -1; let ls = 7;" },
    { command: "npm test" },
    { command: "NODE_ENV=test npm test" },
    { code: "NODE_ENV=test\nnpm test" },
    { code: "FOO=bar ./gradlew test" },
    { command: 'GREETING="hello world" npm test' },
    { command: "whoami" },
    { code: "set -euo pipefail" },
    { command: "exit" },
    { command: "if [ -d /workspace ]; then pwd; fi" },
    { code: "while test -d /workspace; do pwd; done" },
    { command: 'for ((i=0; i<3; i++)); do echo "$i"; done' },
    { code: "function task { pwd; }" },
    { command: "source ./env" },
    { code: "command ls" },
    { command: "go test ./..." },
    { code: "cargo test" },
    { command: "sort /workspace/file" },
    { code: "wc -l file" },
    { command: "jq . file.json" },
    { code: "exec ls" },
    { command: "custom-tool --format=json" },
    { command: "ls > output" },
    { code: "ls>output" },
    { command: "ls >output" },
    { code: "ls >> output" },
    { command: "cat<input" },
    { code: "// inspect the workspace\npwd" },
    { command: "/* inspect the workspace */ pwd;" },
    { code: "rg code-mode src/agents" },
  ])("rejects shell source before starting a guest worker: %j", async (args) => {
    const { config, catalogRef, tools } = createCodeModeHarness();
    applyCodeModeCatalog({
      tools: [...tools, pluginTool("fake_noop", "Noop")],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = resultDetails(
      await expectDefined(tools[0], "tools[0] test invariant").execute(
        "code-call-shell-source",
        args,
      ),
    );

    expect(details.status).toBe("failed");
    expect(details.code).toBe("invalid_input");
    expect(details.error).toMatch(/JavaScript or TypeScript, not shell commands/);
    expect(testing.activeRuns.size).toBe(0);
  });

  it.each([
    { code: "true;", value: null },
    { code: "false;", value: null },
    { code: "return true || false;", value: true },
    { code: "return -1;", value: -1 },
    { code: "return /foo/.test('foo');", value: true },
    { code: "Infinity -1; return 42;", value: 42 },
    { code: "eval; return typeof eval;", value: "function" },
    { code: "if (true) { return -1; }", value: -1 },
    { code: "for (let i = 0; i < 3; i++) { if (i === 2) { return i; } }", value: 2 },
    { code: "function task() { return 7; } return task();", value: 7 },
    { code: "// explain the guest program\nreturn 7;", value: 7 },
    { code: "const ls = 7; return ls;", value: 7 },
    { code: "const echo = (value) => value; return echo('hello');", value: "hello" },
    { code: "test instanceof Function; function test() {}", value: null },
    { code: "ls -1; function ls() {}", value: null },
    { code: "ls -1; function/**/ls() {}", value: null },
    { code: "ls > limit; function ls() {} var limit = 1;", value: null },
    { code: "echo `hello`; function echo(parts) { return parts[0]; }", value: null },
    { code: "pwd; var { pwd } = { pwd: 7 }; return pwd;", value: 7 },
    { code: "pwd; var [pwd] = [7]; return pwd;", value: 7 },
    { code: "pwd; for (var pwd of [7]) {} return pwd;", value: 7 },
    { code: "pwd; var other = 1, pwd = 7; return pwd;", value: 7 },
    { code: "pwd; function* pwd() { yield 7; } return pwd().next().value;", value: 7 },
    { code: "pwd; function/**/pwd() { return 7; } return pwd();", value: 7 },
    { code: "pwd; var/**/{ pwd } = { pwd: 7 }; return pwd;", value: 7 },
    { code: "node -version; function/**/node() {}; var version = 1;", value: null },
  ])(
    "executes valid shell-like JavaScript without false rejection: %j",
    async ({ code, value }) => {
      const { config, catalogRef, tools } = createCodeModeHarness();
      applyCodeModeCatalog({
        tools: [...tools, pluginTool("fake_noop", "Noop")],
        config,
        sessionId: "session-code-mode",
        sessionKey: "agent:main:main",
        runId: "run-code-mode",
        catalogRef,
      });

      const details = resultDetails(
        await expectDefined(tools[0], "tools[0] test invariant").execute(
          "code-call-valid-shell-like-source",
          { code },
        ),
      );

      expect(details.status).toBe("completed");
      expect(details.value).toBe(value);
    },
  );

  it("runs JavaScript through QuickJS-WASI and resumes nested tool calls with wait", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    const ticket = pluginTool("fake_create_ticket", "Create a fake ticket");
    applyCodeModeCatalog({
      tools: [...codeModeTools, ticket],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = await runUntilCompleted({
      execTool: expectDefined(codeModeTools[0], "codeModeTools[0] test invariant"),
      waitTool: expectDefined(codeModeTools[1], "codeModeTools[1] test invariant"),
      code: `
        const hits = await tools.search("ticket", { limit: 1 });
        const called = await tools.callValue(hits[0].id, { value: "ship" });
        text("created");
        return called;
      `,
    });

    expect(details.status).toBe("completed");
    expect(details.value).toEqual({
      name: "fake_create_ticket",
      input: { value: "ship" },
    });
    expect(details.output).toEqual([{ type: "text", text: "created" }]);
    expect(details.telemetry).toMatchObject({ searchCount: 1, describeCount: 0, callCount: 1 });
    expect(ticket.execute).toHaveBeenCalledTimes(1);
  });

  it("returns structured values from named tools while preserving the raw call envelope", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    const ticket = pluginTool("fake_create_ticket", "Create a fake ticket");
    applyCodeModeCatalog({
      tools: [...codeModeTools, ticket],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = await runUntilCompleted({
      execTool: expectDefined(codeModeTools[0], "codeModeTools[0] test invariant"),
      waitTool: expectDefined(codeModeTools[1], "codeModeTools[1] test invariant"),
      code: `
        const id = "openclaw:fake-code-mode:fake_create_ticket";
        const input = { value: "ship" };
        return {
          named: await tools.fake_create_ticket(input),
          value: await tools.callValue(id, input),
          envelope: await tools.call(id, input),
        };
      `,
    });

    const expectedValue = {
      name: "fake_create_ticket",
      input: { value: "ship" },
    };
    expect(details.status).toBe("completed");
    expect(details.value).toEqual({
      named: expectedValue,
      value: expectedValue,
      envelope: {
        tool: expect.objectContaining({
          id: "openclaw:fake-code-mode:fake_create_ticket",
          name: "fake_create_ticket",
        }),
        result: expect.objectContaining({ details: expectedValue }),
      },
    });
    expect(details.telemetry).toMatchObject({ callCount: 3 });
    expect(ticket.execute).toHaveBeenCalledTimes(3);
  });

  it("keeps Code Mode skill parsing aligned with the production prompt renderer", () => {
    const entries = [createFixtureSkillEntry("alpha"), createFixtureSkillEntry("beta")];
    const skillsPrompt = resolveSkillsPromptForRun({
      entries,
      workspaceDir: "/workspace",
    });

    expect(
      resolveCodeModeSkills({
        skillsPrompt,
        candidates: entries.map((entry) => entry.skill),
      }).map(({ name, location }) => ({ name, location })),
    ).toEqual([
      { name: "alpha", location: "/skills/alpha/SKILL.md" },
      { name: "beta", location: "/skills/beta/SKILL.md" },
    ]);
  });

  it("lists and reads only prompt-eligible skills through the worker bridge", async () => {
    const demo = skillCandidate({
      name: "demo",
      description: "Full demo description",
      filePath: "/host/skills/demo/SKILL.md",
    });
    const hidden = skillCandidate({
      name: "hidden",
      description: "Hidden skill",
      filePath: "/host/skills/hidden/SKILL.md",
    });
    const reader = vi.fn(async ({ location }: { location: string }) =>
      location === "/guest/skills/demo/SKILL.md"
        ? "---\nname: demo\n---\n\n# Complete demo instructions\n"
        : "# Hidden\n",
    );
    const codeModeSkills = resolveCodeModeSkills({
      skillsPrompt: [
        "<available_skills>",
        "  <skill>",
        "    <name>demo</name>",
        "    <description>Short prompt description</description>",
        "    <location>/guest/skills/demo/SKILL.md</location>",
        "  </skill>",
        "</available_skills>",
      ].join("\n"),
      candidates: [demo, hidden],
      reader,
    });
    const {
      config,
      catalogRef,
      tools: codeModeTools,
    } = createCodeModeHarness({
      codeModeSkills,
    });
    applyCodeModeCatalog({
      tools: [...codeModeTools, pluginTool("fake_noop", "Noop")],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
      codeModeSkills,
    });

    const details = await runUntilCompleted({
      execTool: expectDefined(codeModeTools[0], "codeModeTools[0] test invariant"),
      waitTool: expectDefined(codeModeTools[1], "codeModeTools[1] test invariant"),
      code: `
        const listed = await skills.list();
        const body = await skills.read("demo");
        let unknown;
        try {
          await skills.read("missing");
        } catch (error) {
          unknown = error.message;
        }
        return { listed, body, unknown };
      `,
    });

    expect(details.status).toBe("completed");
    expect(details.value).toEqual({
      listed: [
        {
          name: "demo",
          description: "Full demo description",
          location: "/guest/skills/demo/SKILL.md",
        },
      ],
      body: "---\nname: demo\n---\n\n# Complete demo instructions\n",
      unknown: 'Unknown skill "missing". Available skills: demo',
    });
    expect(codeModeTools[0]?.description).toContain("`await skills.read(name)`");
    expect(reader).toHaveBeenCalledOnce();
    expect(reader).toHaveBeenCalledWith({
      location: "/guest/skills/demo/SKILL.md",
      signal: expect.any(AbortSignal),
    });
  });

  it("returns ordinary read content through tools.callValue", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    const read = createOpenClawReadTool(
      createReadTool("/workspace", {
        operations: {
          access: async () => {},
          detectImageMimeType: async () => null,
          readFile: async () => Buffer.from("ordinary file content"),
        },
      }) as unknown as Parameters<typeof createOpenClawReadTool>[0],
    );
    applyCodeModeCatalog({
      tools: [...codeModeTools, read],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = await runUntilCompleted({
      execTool: expectDefined(codeModeTools[0], "codeModeTools[0] test invariant"),
      waitTool: expectDefined(codeModeTools[1], "codeModeTools[1] test invariant"),
      code: `return await tools.callValue("openclaw:core:read", { path: "notes.txt" });`,
    });

    expect(details.status).toBe("completed");
    expect(details.value).toEqual({ kind: "text", content: "ordinary file content" });
  });

  it("resolves sequential bridge tool calls inline within one exec instead of a wait per call", async () => {
    const catalogRef = createToolSearchCatalogRef();
    // maxPendingToolCalls stays a per-batch concurrency cap; five sequential
    // awaits must drain inline even with a cap of 2.
    const config = {
      tools: { codeMode: { enabled: true, maxPendingToolCalls: 2 } },
    } as never;
    const ctx = {
      config,
      runtimeConfig: config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    };
    const codeModeTools = createCodeModeTools(ctx);
    const ticket = pluginTool("fake_create_ticket", "Create a fake ticket");
    applyCodeModeCatalog({
      tools: [...codeModeTools, ticket],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    // Five separate awaits would each suspend to the model under a wait-per-call
    // design; inline resumption collapses them into a single completed exec so
    // the model spends one turn instead of six.
    const details = resultDetails(
      await expectDefined(codeModeTools[0], "codeModeTools[0] test invariant").execute(
        "code-call-inline",
        {
          code: `
            const ids = [];
            for (let index = 0; index < 5; index += 1) {
              const called = await tools.callValue("fake_create_ticket", { value: index });
              ids.push(called.input.value);
            }
            return ids;
          `,
        },
      ),
    );

    expect(details.status).toBe("completed");
    expect(details.value).toEqual([0, 1, 2, 3, 4]);
    expect(ticket.execute).toHaveBeenCalledTimes(5);
    expect(testing.activeRuns.size).toBe(0);
  });

  it("keeps the actual winner when the later-started nested tool settles first", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    let firstAborted = false;
    const first = pluginToolWithExecute(
      "fake_first",
      "Earlier slow helper",
      async (_toolCallId, _input, signal) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 25);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              firstAborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
        return jsonResult({ winner: "first" });
      },
    );
    const second = pluginToolWithExecute("fake_second", "Later fast helper", async () =>
      jsonResult({ winner: "second" }),
    );
    applyCodeModeCatalog({
      tools: [...codeModeTools, first, second],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = resultDetails(
      await expectDefined(codeModeTools[0], "Code Mode exec test invariant").execute(
        "code-call-later-winner",
        {
          code: `return await Promise.race([
            tools.callValue("fake_first", {}),
            tools.callValue("fake_second", {}),
          ]);`,
        },
      ),
    );

    expect(details).toMatchObject({ status: "completed", value: { winner: "second" } });
    expect(first.execute).toHaveBeenCalledOnce();
    expect(second.execute).toHaveBeenCalledOnce();
    expect(firstAborted).toBe(false);
    expect(testing.activeRuns.size).toBe(0);
  });

  it.each([
    {
      label: "directly",
      auditCode: 'void tools.callValue("fake_early_audit", {});',
    },
    {
      label: "in a detached already-settled Promise.race",
      auditCode: 'void Promise.race([tools.callValue("fake_early_audit", {}), Promise.resolve()]);',
    },
    {
      label: "in a detached Promise.all",
      auditCode: 'void Promise.all([tools.callValue("fake_early_audit", {})]);',
    },
    {
      label: "in a detached Promise.allSettled",
      auditCode: 'void Promise.allSettled([tools.callValue("fake_early_audit", {})]);',
    },
    {
      label: "in a detached Promise.any",
      auditCode: 'void Promise.any([tools.callValue("fake_early_audit", {})]);',
    },
    {
      label: "in a detached Promise.race",
      auditCode: 'void Promise.race([tools.callValue("fake_early_audit", {})]);',
    },
  ])(
    "drains a detached audit started $label before an awaited nested call",
    async ({ auditCode }) => {
      const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
      let auditCompleted = false;
      let auditAborted = false;
      const audit = pluginToolWithExecute(
        "fake_early_audit",
        "Early detached audit",
        async (_toolCallId, _input, signal) => {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 250);
            signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                auditAborted = true;
                reject(new Error("aborted"));
              },
              { once: true },
            );
          });
          auditCompleted = true;
          return jsonResult({ recorded: true });
        },
      );
      const fast = pluginToolWithExecute("fake_awaited_fast", "Awaited fast helper", async () =>
        jsonResult({ winner: "fast" }),
      );
      applyCodeModeCatalog({
        tools: [...codeModeTools, audit, fast],
        config,
        sessionId: "session-code-mode",
        sessionKey: "agent:main:main",
        runId: "run-code-mode",
        catalogRef,
      });

      const details = resultDetails(
        await expectDefined(codeModeTools[0], "Code Mode exec test invariant").execute(
          "code-call-early-detached-audit",
          {
            code: `${auditCode}
            return await tools.callValue("fake_awaited_fast", {});`,
          },
        ),
      );

      expect(details).toMatchObject({ status: "completed", value: { winner: "fast" } });
      expect(audit.execute).toHaveBeenCalledOnce();
      expect(fast.execute).toHaveBeenCalledOnce();
      expect(auditCompleted).toBe(true);
      expect(auditAborted).toBe(false);
      expect(testing.activeRuns.size).toBe(0);
    },
  );

  it("drains a race winner's detached audit and its slower race branch", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    let loserAborted = false;
    const winner = pluginToolWithExecute("fake_race_winner", "Race winner", async () =>
      jsonResult({ winner: "fast" }),
    );
    const loser = pluginToolWithExecute(
      "fake_race_loser",
      "Race loser",
      async (_toolCallId, _input, signal) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 25);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              loserAborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
        return jsonResult({ winner: "slow" });
      },
    );
    const audit = pluginToolWithExecute("fake_race_audit", "Detached audit", async () =>
      jsonResult({ recorded: true }),
    );
    applyCodeModeCatalog({
      tools: [...codeModeTools, winner, loser, audit],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = resultDetails(
      await expectDefined(codeModeTools[0], "Code Mode exec test invariant").execute(
        "code-call-race-detached-audit",
        {
          code: `return Promise.race([
            tools.callValue("fake_race_winner", {}),
            tools.callValue("fake_race_loser", {}),
          ]).then((value) => {
            void tools.callValue("fake_race_audit", {});
            return value;
          });`,
        },
      ),
    );

    expect(details).toMatchObject({ status: "completed", value: { winner: "fast" } });
    expect(winner.execute).toHaveBeenCalledOnce();
    expect(loser.execute).toHaveBeenCalledOnce();
    expect(audit.execute).toHaveBeenCalledOnce();
    expect(loserAborted).toBe(false);
    expect(testing.activeRuns.size).toBe(0);
  });

  it("drains every detached nested tool before completing the guest", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    const first = pluginToolWithExecute("fake_detached_first", "First detached helper", async () =>
      jsonResult({ name: "first" }),
    );
    const second = pluginToolWithExecute(
      "fake_detached_second",
      "Second detached helper",
      async () => jsonResult({ name: "second" }),
    );
    applyCodeModeCatalog({
      tools: [...codeModeTools, first, second],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = resultDetails(
      await expectDefined(codeModeTools[0], "Code Mode exec test invariant").execute(
        "code-call-detached",
        {
          code: `void tools.callValue("fake_detached_first", {});
            void tools.callValue("fake_detached_second", {});
            return "done";`,
        },
      ),
    );

    expect(details).toMatchObject({ status: "completed", value: "done" });
    expect(first.execute).toHaveBeenCalledOnce();
    expect(second.execute).toHaveBeenCalledOnce();
    expect(testing.activeRuns.size).toBe(0);
  });

  it.each(["race", "any"] as const)(
    "preserves the Promise.%s winner while draining the slower nested tool",
    async (combinator) => {
      const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
      let slowAborted = false;
      let slowCompleted = false;
      const fast = pluginToolWithExecute("fake_fast", "Fast helper", async () =>
        jsonResult({ winner: "fast" }),
      );
      const slow = pluginToolWithExecute(
        "fake_slow",
        "Slow helper",
        async (_toolCallId, _input, signal) => {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 25);
            signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                slowAborted = true;
                reject(new Error("aborted"));
              },
              { once: true },
            );
          });
          slowCompleted = true;
          return jsonResult({ winner: "slow" });
        },
      );
      applyCodeModeCatalog({
        tools: [...codeModeTools, fast, slow],
        config,
        sessionId: "session-code-mode",
        sessionKey: "agent:main:main",
        runId: "run-code-mode",
        catalogRef,
      });

      const details = resultDetails(
        await expectDefined(codeModeTools[0], "Code Mode exec test invariant").execute(
          `code-call-${combinator}-fast`,
          {
            code: `return await Promise.${combinator}([
              tools.callValue("fake_fast", {}),
              tools.callValue("fake_slow", {}),
            ]);`,
          },
        ),
      );

      expect(details).toMatchObject({ status: "completed", value: { winner: "fast" } });
      expect(fast.execute).toHaveBeenCalledOnce();
      expect(slow.execute).toHaveBeenCalledOnce();
      expect(slowCompleted).toBe(true);
      expect(slowAborted).toBe(false);
      expect(testing.activeRuns.size).toBe(0);
    },
  );

  it("preserves fail-fast Promise.all while draining the slower nested tool", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    let slowAborted = false;
    let slowCompleted = false;
    const failed = pluginToolWithExecute("fake_failed", "Failed helper", async () => {
      throw new Error("fast failure");
    });
    const slow = pluginToolWithExecute(
      "fake_slow",
      "Slow helper",
      async (_toolCallId, _input, signal) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 25);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              slowAborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
        slowCompleted = true;
        return jsonResult({ winner: "slow" });
      },
    );
    applyCodeModeCatalog({
      tools: [...codeModeTools, failed, slow],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = resultDetails(
      await expectDefined(codeModeTools[0], "Code Mode exec test invariant").execute(
        "code-call-fail-fast",
        {
          code: `try {
            await Promise.all([
              tools.callValue("fake_failed", {}),
              tools.callValue("fake_slow", {}),
            ]);
            return "unexpected success";
          } catch (error) {
            return error.message;
          }`,
        },
      ),
    );

    expect(details).toMatchObject({ status: "completed", value: "fast failure" });
    expect(failed.execute).toHaveBeenCalledOnce();
    expect(slow.execute).toHaveBeenCalledOnce();
    expect(slowCompleted).toBe(true);
    expect(slowAborted).toBe(false);
    expect(testing.activeRuns.size).toBe(0);
  });

  it("fails fast without parking a suspended run when the exec call is aborted", async () => {
    const catalogRef = createToolSearchCatalogRef();
    // Long timeout so a missing abort short-circuit would block the whole test.
    const config = {
      tools: { codeMode: { enabled: true, timeoutMs: 30_000 } },
    } as never;
    const ctx = {
      config,
      runtimeConfig: config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    };
    const codeModeTools = createCodeModeTools(ctx);
    applyCodeModeCatalog({
      tools: [
        ...codeModeTools,
        // A tool that never settles and ignores its abort signal; only the
        // host-level abort race can free the cancelled exec.
        pluginToolWithExecute("fake_stuck", "Stuck helper", async () => {
          await new Promise<never>(() => {});
          return null as never;
        }),
      ],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const controller = new AbortController();
    controller.abort();
    const details = resultDetails(
      await expectDefined(codeModeTools[0], "codeModeTools[0] test invariant").execute(
        "code-call-abort",
        { code: "await tools.fake_stuck({}); return 'done';" },
        controller.signal,
      ),
    );

    // Abort drops the run instead of parking it; a cancelled call must not pin
    // one of the process-global suspended-run slots until TTL expiry.
    expect(details.status).toBe("failed");
    expect(details.error).toBe("code mode execution aborted");
    expect(details.code).toBe("aborted");
    expect(testing.activeRuns.size).toBe(0);
  });

  it("terminates a running guest promptly when the exec call is aborted", async () => {
    const catalogRef = createToolSearchCatalogRef();
    // Long timeout so only the abort race can end the hostile loop quickly.
    const config = {
      tools: { codeMode: { enabled: true, timeoutMs: 30_000 } },
    } as never;
    const ctx = {
      config,
      runtimeConfig: config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    };
    const codeModeTools = createCodeModeTools(ctx);
    applyCodeModeCatalog({
      tools: [...codeModeTools, pluginTool("fake_noop", "Noop")],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 200);
    const startedAt = Date.now();
    try {
      const details = resultDetails(
        await expectDefined(codeModeTools[0], "codeModeTools[0] test invariant").execute(
          "code-call-abort-live",
          { code: "while (true) {}" },
          controller.signal,
        ),
      );
      expect(details.status).toBe("failed");
      expect(details.error).toBe("code mode execution aborted");
      expect(details.code).toBe("aborted");
    } finally {
      clearTimeout(abortTimer);
    }
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(testing.activeRuns.size).toBe(0);
  });

  it("uses tools recovery guidance for guessed tool ids", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    const writeTool = pluginTool("write", "Write a file to the workspace");
    applyCodeModeCatalog({
      tools: [...codeModeTools, writeTool],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = await runUntilCompleted({
      execTool: expectDefined(codeModeTools[0], "codeModeTools[0] test invariant"),
      waitTool: expectDefined(codeModeTools[1], "codeModeTools[1] test invariant"),
      code: `
        try {
          await tools.call("file_write", {
            path: "memory/2026-05-22.md",
            content: "remember this",
          });
          return "unexpected success";
        } catch (error) {
          return error.message;
        }
      `,
    });

    expect(details.status).toBe("completed");
    expect(details.value).toBe(
      "Unknown tool id: file_write. Did you mean: write? Use tools.search to find a tool, tools.describe to inspect it, then tools.call with the exact id or name.",
    );
    expect(writeTool.execute).not.toHaveBeenCalled();
  });

  it("uses tools recovery guidance when no generic Code Mode suggestion matches", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    applyCodeModeCatalog({
      tools: codeModeTools,
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = await runUntilCompleted({
      execTool: expectDefined(codeModeTools[0], "codeModeTools[0] test invariant"),
      waitTool: expectDefined(codeModeTools[1], "codeModeTools[1] test invariant"),
      code: `
        try {
          await tools.call("missing_tool", {});
          return "unexpected success";
        } catch (error) {
          return error.message;
        }
      `,
    });

    expect(details.status).toBe("completed");
    expect(details.value).toBe(
      "Unknown tool id: missing_tool. Use tools.search to find a tool, tools.describe to inspect it, then tools.call with the exact id or name.",
    );
  });

  it("surfaces policy blocks as guest call errors for declared outputs", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    const target = pluginTool("fake_policy_block", "Return policy-controlled rows");
    target.outputSchema = Type.Array(
      Type.Object({ id: Type.String() }, { additionalProperties: false }),
    );
    target.execute = vi.fn(async () =>
      buildBlockedToolResult({ reason: "blocked by orchard policy" }),
    );
    applyCodeModeCatalog({
      tools: [...codeModeTools, target],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = await runUntilCompleted({
      execTool: expectDefined(codeModeTools[0], "codeModeTools[0] test invariant"),
      waitTool: expectDefined(codeModeTools[1], "codeModeTools[1] test invariant"),
      code: `
        try {
          const rows = await tools.callValue("fake_policy_block", {});
          return rows.map((row) => row.id);
        } catch (error) {
          return error.message;
        }
      `,
    });

    expect(details.status).toBe("completed");
    expect(details.value).toContain("was blocked before execution: blocked by orchard policy");
  });

  it("exposes MCP tools only through the MCP namespace", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    const githubCreate = mcpTool({
      name: "github__create_issue",
      serverName: "github",
      toolName: "create_issue",
      parameters: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string", description: "Repository 名称" },
          title: { type: "string", description: "Issue title\nShown in tracker" },
          body: { type: "string", default: "" },
        },
        required: ["owner", "repo", "title"],
      },
    });
    const compacted = applyCodeModeCatalog({
      tools: [...codeModeTools, githubCreate],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    expect(compacted.tools[0]?.description).toContain("MCP: MCP server tools grouped by server.");
    expect(compacted.tools[0]?.description).toContain("visible servers: github");

    const details = await runUntilCompleted({
      execTool: expectDefined(codeModeTools[0], "codeModeTools[0] test invariant"),
      waitTool: expectDefined(codeModeTools[1], "codeModeTools[1] test invariant"),
      code: `
        const rootApi = await MCP.$api();
        const api = await MCP.github.$api("createIssue", { schema: true });
        const apiFiles = await API.list("mcp");
        const apiFilesTrailingSlash = await API.list("mcp/");
        const rootFile = await API.read("mcp/index.d.ts");
        const serverFile = await API.read("mcp/github.d.ts");
        const created = await MCP.github.createIssue({
          owner: "openclaw",
          repo: "openclaw",
          title: "Ship it",
        });
        const createdPayload = JSON.parse(created.content[0].text);
        const searchHits = await tools.search("github create issue", { limit: 5 });
        const allHasMcp = ALL_TOOLS.some((tool) => tool.source === "mcp");
        let directCall;
        let directDescribe;
        try {
          await tools.describe("github__create_issue");
          directDescribe = "unexpected";
        } catch (error) {
          directDescribe = error.message;
        }
        try {
          await tools.call("github__create_issue", { owner: "x", repo: "y", title: "blocked" });
          directCall = "unexpected";
        } catch (error) {
          directCall = error.message;
        }
        return {
          apiHeader: api.header,
          apiFilePaths: apiFiles.files.map((file) => file.path),
          apiFilePathsTrailingSlash: apiFilesTrailingSlash.files.map((file) => file.path),
          listedServerFileBytes: apiFiles.files.find((file) => file.path === "mcp/github.d.ts").bytes,
          serverFileBytes: serverFile.bytes,
          serverFileContent: serverFile.content,
          rootFileHasReference: rootFile.content.includes('./github.d.ts'),
          serverFileHasCreateIssue: serverFile.content.includes('function createIssue('),
          serverFileHasTitleDoc: serverFile.content.includes('@param title Issue title Shown in tracker'),
          apiSchemaTitle: api.schemas.createIssue.type,
          rootServers: rootApi.servers,
          createdPayload,
          createdDetails: created.details,
          searchHits,
          allHasMcp,
          directDescribe,
          directCall,
          hasMcp: "MCP" in namespaces,
        };
      `,
    });

    expect(details.status).toBe("completed");
    expect(details.value).toEqual({
      createdPayload: {
        serverName: "github",
        toolName: "create_issue",
        input: {
          owner: "openclaw",
          repo: "openclaw",
          title: "Ship it",
          body: "",
        },
      },
      createdDetails: {
        serverName: "github",
        toolName: "create_issue",
        input: {
          owner: "openclaw",
          repo: "openclaw",
          title: "Ship it",
          body: "",
        },
      },
      searchHits: [],
      allHasMcp: false,
      directDescribe:
        "Unknown tool id: github__create_issue. Use tools.search to find a tool, tools.describe to inspect it, then tools.call with the exact id or name.",
      directCall:
        "Unknown tool id: github__create_issue. Use tools.search to find a tool, tools.describe to inspect it, then tools.call with the exact id or name.",
      hasMcp: true,
      apiSchemaTitle: "object",
      apiHeader: expect.stringContaining("function createIssue("),
      apiFilePaths: ["mcp/index.d.ts", "mcp/github.d.ts"],
      apiFilePathsTrailingSlash: ["mcp/index.d.ts", "mcp/github.d.ts"],
      listedServerFileBytes: expect.any(Number),
      serverFileBytes: expect.any(Number),
      serverFileContent: expect.stringContaining("Repository 名称"),
      rootFileHasReference: true,
      serverFileHasCreateIssue: true,
      serverFileHasTitleDoc: true,
      rootServers: [{ identifier: "github", serverName: "github", toolCount: 1 }],
    });
    const value = details.value as {
      apiHeader: string;
      listedServerFileBytes: number;
      serverFileBytes: number;
      serverFileContent: string;
    };
    expect(value.listedServerFileBytes).toBe(value.serverFileBytes);
    expect(value.serverFileBytes).toBe(Buffer.byteLength(value.serverFileContent, "utf8"));
    expect(value.serverFileBytes).toBeGreaterThan(value.serverFileContent.length);
    expect(value.apiHeader).toContain("@param title Issue title Shown in tracker");
    expect(value.apiHeader).not.toContain("@param title Issue title\n");
    expect(value.apiHeader).toContain("title: string;");
    expect(githubCreate.execute).toHaveBeenCalledTimes(1);
  });

  it("lets agents inspect MCP declaration files before calling MCP tools", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    const githubCreate = mcpTool({
      name: "github__create_issue",
      serverName: "github",
      toolName: "create_issue",
      parameters: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          title: { type: "string", description: "Issue title" },
        },
        required: ["owner", "repo", "title"],
      },
    });
    applyCodeModeCatalog({
      tools: [...codeModeTools, githubCreate],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = await runUntilCompleted({
      execTool: expectDefined(codeModeTools[0], "codeModeTools[0] test invariant"),
      waitTool: expectDefined(codeModeTools[1], "codeModeTools[1] test invariant"),
      code: `
        const files = await API.list("mcp");
        const api = await API.read("mcp/github.d.ts");
        const created = await MCP.github.createIssue({
          owner: "openclaw",
          repo: "openclaw",
          title: "From file docs",
        });
        return {
          fileCount: files.files.length,
          headerHasSignature: api.content.includes("function createIssue("),
          usedApiCall: api.content.includes("function $api("),
          created: JSON.parse(created.content[0].text),
        };
      `,
    });

    expect(details.status).toBe("completed");
    expect(details.value).toEqual({
      fileCount: 2,
      headerHasSignature: true,
      usedApiCall: true,
      created: {
        serverName: "github",
        toolName: "create_issue",
        input: {
          owner: "openclaw",
          repo: "openclaw",
          title: "From file docs",
        },
      },
    });
    expect(githubCreate.execute).toHaveBeenCalledTimes(1);
  });

  it("groups MCP resources and prompts under server namespaces", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    const resourceRead = mcpTool({
      name: "docs__resources_read",
      serverName: "docs",
      toolName: "resources_read",
      operation: "resources_read",
      parameters: {
        type: "object",
        properties: { uri: { type: "string" } },
        required: ["uri"],
      },
    });
    const promptGet = mcpTool({
      name: "docs__prompts_get",
      serverName: "docs",
      toolName: "prompts_get",
      operation: "prompts_get",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          arguments: { type: "object" },
        },
        required: ["name"],
      },
    });
    applyCodeModeCatalog({
      tools: [...codeModeTools, resourceRead, promptGet],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = await runUntilCompleted({
      execTool: expectDefined(codeModeTools[0], "codeModeTools[0] test invariant"),
      waitTool: expectDefined(codeModeTools[1], "codeModeTools[1] test invariant"),
      code: `
        const api = await MCP.docs.$api();
        const resource = await MCP.docs.resources.read({ uri: "memo://one" });
        const prompt = await MCP.docs.prompts.get({ name: "brief", arguments: { topic: "mcp" } });
        return { header: api.header, resource: resource.details, prompt: prompt.details };
      `,
    });

    expect(details.status).toBe("completed");
    expect(details.value).toEqual({
      resource: {
        serverName: "docs",
        toolName: "resources_read",
        input: { uri: "memo://one" },
      },
      prompt: {
        serverName: "docs",
        toolName: "prompts_get",
        input: { name: "brief", arguments: { topic: "mcp" } },
      },
      header: expect.stringContaining("namespace resources"),
    });
  });

  it("renames MCP namespace identifiers that would be unsafe path segments", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    const dangerous = mcpTool({
      name: "constructor__prototype",
      serverName: "constructor",
      toolName: "prototype",
      parameters: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
      },
    });
    applyCodeModeCatalog({
      tools: [...codeModeTools, dangerous],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = await runUntilCompleted({
      execTool: expectDefined(codeModeTools[0], "codeModeTools[0] test invariant"),
      waitTool: expectDefined(codeModeTools[1], "codeModeTools[1] test invariant"),
      code: 'return (await MCP.constructor2.prototype2({ value: "safe" })).details;',
    });

    expect(details.status).toBe("completed");
    expect(details.value).toEqual({
      serverName: "constructor",
      toolName: "prototype",
      input: { value: "safe" },
    });
  });

  it.each(["delete", "default", "return", "enum", "class"])(
    "renders and executes reserved MCP tool name %s safely",
    async (toolName) => {
      const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
      const target = mcpTool({
        name: `github__${toolName}`,
        serverName: "github",
        toolName,
        parameters: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
        },
      });
      applyCodeModeCatalog({
        tools: [...codeModeTools, target],
        config,
        sessionId: "session-code-mode",
        sessionKey: "agent:main:main",
        runId: "run-code-mode",
        catalogRef,
      });

      const safeName = `${toolName}2`;
      const details = await runUntilCompleted({
        execTool: expectDefined(codeModeTools[0], "Code Mode exec test invariant"),
        waitTool: expectDefined(codeModeTools[1], "Code Mode wait test invariant"),
        code: `
          const file = await API.read("mcp/github.d.ts");
          const api = await MCP.github.$api("${safeName}");
          const result = await MCP.github.${safeName}({ value: "safe" });
          return { file: file.content, header: api.header, result: result.details };
        `,
      });

      expect(details.status).toBe("completed");
      expect(details.value).toEqual({
        file: expect.stringContaining(`function ${safeName}(`),
        header: expect.stringContaining(`function ${safeName}(`),
        result: {
          serverName: "github",
          toolName,
          input: { value: "safe" },
        },
      });
      expect(target.execute).toHaveBeenCalledTimes(1);
    },
  );

  it("marks yield suspensions and resumes the snapshot with wait", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    applyCodeModeCatalog({
      tools: [...codeModeTools, pluginTool("fake_noop", "Noop")],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const first = resultDetails(
      await expectDefined(codeModeTools[0], "codeModeTools[0] test invariant").execute(
        "code-call-yield",
        {
          restartSafe: true,
          code: `
          text("before");
          await yield_control("pause");
          text("after");
          return "done";
        `,
        },
      ),
    );

    expect(first.status).toBe("waiting");
    expect(first.reason).toBe("yield");
    expect(first.replaySafe).toBe(true);
    expect(first.output).toEqual([{ type: "text", text: "before" }]);

    const runId = first.runId;
    expect(typeof runId).toBe("string");
    const resumed = resultDetails(
      await expectDefined(codeModeTools[1], "codeModeTools[1] test invariant").execute(
        "code-wait-yield",
        { runId },
      ),
    );

    expect(resumed.status).toBe("completed");
    expect(resumed.value).toBe("done");
    expect(resumed.output).toEqual([
      { type: "text", text: "before" },
      { type: "text", text: "after" },
    ]);
  });

  it("preserves the original exec identity for tool calls after yield and wait", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    const target = pluginTool("fake_resumed_identity", "Resumed identity helper");
    applyCodeModeCatalog({
      tools: [...codeModeTools, target],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const suspended = resultDetails(
      await expectDefined(codeModeTools[0], "Code Mode exec test invariant").execute(
        "code-call-original-parent",
        {
          code: 'await yield_control("pause"); return await tools.callValue("fake_resumed_identity", {});',
        },
      ),
    );
    expect(suspended.status).toBe("waiting");

    const resumed = resultDetails(
      await expectDefined(codeModeTools[1], "Code Mode wait test invariant").execute(
        "code-wait-different-parent",
        { runId: suspended.runId },
      ),
    );

    expect(resumed.status).toBe("completed");
    expect(target.execute).toHaveBeenCalledOnce();
    expect(vi.mocked(target.execute).mock.calls[0]?.[0]).toContain("code-call-original-parent");
    expect(vi.mocked(target.execute).mock.calls[0]?.[0]).not.toContain(
      "code-wait-different-parent",
    );
  });

  it("allocates distinct replay identities when a later turn reuses a tool-call id", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    applyCodeModeCatalog({
      tools: [...codeModeTools, pluginTool("fake_noop", "Noop")],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });
    const execTool = expectDefined(codeModeTools[0], "codeModeTools[0] test invariant");
    const input = { code: 'await yield_control("pause"); return "done";' };
    const executionContext = (turnId: string) =>
      ({
        assistantMessage: { responseId: " ", turnId },
        toolCall: { type: "toolCall", id: "reused-call-id", name: "exec", arguments: input },
      }) as never;

    const first = resultDetails(
      await runWithAgentToolExecutionContext(executionContext("response-turn-1"), () =>
        execTool.execute("reused-call-id", input),
      ),
    );
    const second = resultDetails(
      await runWithAgentToolExecutionContext(executionContext("response-turn-2"), () =>
        execTool.execute("reused-call-id", input),
      ),
    );

    expect(first.status).toBe("waiting");
    expect(second.status).toBe("waiting");
    expect(second.runId).not.toBe(first.runId);
    expect(testing.activeRuns.size).toBe(2);
    expect(new Set([...testing.activeRuns.values()].map((state) => state.replayId)).size).toBe(2);
  });

  it("keeps restart-safe mode across audited core reads", async () => {
    const targetTool = fakeTool("read", "Read");
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    applyCodeModeCatalog({
      tools: [...codeModeTools, targetTool],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const first = resultDetails(
      await expectDefined(codeModeTools[0], "codeModeTools[0] test invariant").execute(
        "code-call-replay-safety",
        {
          restartSafe: true,
          code: `
          const matches = await tools.search(${JSON.stringify(targetTool.name)});
          return await tools.call(matches[0].id, {});
        `,
        },
      ),
    );
    expect(first.status).toBe("waiting");
    expect(first.replaySafe).toBe(true);

    const second = resultDetails(
      await expectDefined(codeModeTools[1], "codeModeTools[1] test invariant").execute(
        "code-wait-replay-safety",
        { runId: first.runId },
      ),
    );
    expect(second.status).toBe("waiting");
    expect(second.replaySafe).toBe(true);

    const completed = resultDetails(
      await expectDefined(codeModeTools[1], "codeModeTools[1] test invariant").execute(
        "code-wait-replay-safety-complete",
        {
          runId: second.runId,
        },
      ),
    );
    expect(completed.status).toBe("completed");
  });

  it("allows explicitly replay-safe plugin tools by exact catalog id", async () => {
    const targetTool = pluginTool("fake_plugin_read", "Plugin read");
    setPluginToolMeta(targetTool, {
      pluginId: "fake-code-mode",
      optional: true,
      replaySafe: true,
    });
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    applyCodeModeCatalog({
      tools: [...codeModeTools, targetTool],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const completed = await runUntilCompleted({
      execTool: expectDefined(codeModeTools[0], "codeModeTools[0] test invariant"),
      waitTool: expectDefined(codeModeTools[1], "codeModeTools[1] test invariant"),
      restartSafe: true,
      code: `
        const matches = await tools.search("fake_plugin_read");
        return await tools.call(matches[0].id, {});
      `,
    });

    expect(completed.status).toBe("completed");
    expect(completed.replaySafe).toBe(true);
    expect(targetTool.execute).toHaveBeenCalledTimes(1);
  });

  it("rejects MCP tools even when their metadata claims replay safety", async () => {
    const targetTool = mcpTool({
      name: "mcp_github_read_file",
      serverName: "github",
      toolName: "read_file",
    });
    setPluginToolMeta(targetTool, {
      pluginId: "bundle-mcp",
      optional: false,
      replaySafe: true,
      mcp: {
        serverName: "github",
        safeServerName: "github",
        toolName: "read_file",
        operation: "tool",
      },
    });
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    applyCodeModeCatalog({
      tools: [...codeModeTools, targetTool],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const completed = await runUntilCompleted({
      execTool: expectDefined(codeModeTools[0], "codeModeTools[0] test invariant"),
      waitTool: expectDefined(codeModeTools[1], "codeModeTools[1] test invariant"),
      restartSafe: true,
      code: 'return await MCP.github.readFile({ path: "README.md" });',
    });

    expect(completed.status).toBe("failed");
    expect(completed.replaySafe).toBe(true);
    expect(completed.error).toContain("cannot call namespace tools");
    expect(targetTool.execute).not.toHaveBeenCalled();
  });

  it("rejects side-effecting calls before executing them in restart-safe mode", async () => {
    const targetTool = pluginTool("fake_write", "Write");
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    applyCodeModeCatalog({
      tools: [...codeModeTools, targetTool],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const first = resultDetails(
      await expectDefined(codeModeTools[0], "codeModeTools[0] test invariant").execute(
        "code-call-unsafe-restart",
        {
          restartSafe: true,
          code: `
          const matches = await tools.search("fake_write");
          return await tools.call(matches[0].id, {});
        `,
        },
      ),
    );
    expect(first.status).toBe("waiting");
    expect(first.replaySafe).toBe(true);

    const failed = resultDetails(
      await expectDefined(codeModeTools[1], "codeModeTools[1] test invariant").execute(
        "code-wait-unsafe-restart",
        { runId: first.runId },
      ),
    );
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("cannot call side-effecting tools");
    expect(targetTool.execute).not.toHaveBeenCalled();
  });

  it("keeps host-forced restart safety when the model clears the exec flag", async () => {
    const targetTool = pluginTool("fake_forced_write", "Write");
    const {
      config,
      catalogRef,
      tools: codeModeTools,
    } = createCodeModeHarness({
      forceRestartSafeTools: true,
    });
    applyCodeModeCatalog({
      tools: [...codeModeTools, targetTool],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const first = resultDetails(
      await expectDefined(codeModeTools[0], "codeModeTools[0] test invariant").execute(
        "code-call-forced-restart",
        {
          restartSafe: false,
          code: `
          const matches = await tools.search("fake_forced_write");
          return await tools.call(matches[0].id, {});
        `,
        },
      ),
    );
    expect(first.status).toBe("waiting");
    expect(first.replaySafe).toBe(true);

    const failed = resultDetails(
      await expectDefined(codeModeTools[1], "codeModeTools[1] test invariant").execute(
        "code-wait-forced-restart",
        { runId: first.runId },
      ),
    );
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("cannot call side-effecting tools");
    expect(targetTool.execute).not.toHaveBeenCalled();
  });

  it("fails yield suspension when snapshot expiry would exceed the Date range", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    applyCodeModeCatalog({
      tools: [...codeModeTools, pluginTool("fake_noop", "Noop")],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_000);
    let details: Record<string, unknown>;
    try {
      details = resultDetails(
        await expectDefined(codeModeTools[0], "codeModeTools[0] test invariant").execute(
          "code-call-yield-overflow",
          {
            code: 'await yield_control("pause"); return "done";',
          },
        ),
      );
    } finally {
      nowSpy.mockRestore();
    }

    expect(details.status).toBe("failed");
    expect(details.error).toBe("code mode run expiry is unavailable.");
    expect(testing.activeRuns.size).toBe(0);
  });

  it("expires suspended runs with invalid expiry timestamps", async () => {
    const { tools: codeModeTools } = createCodeModeHarness();
    testing.activeRuns.set("invalid-expiry-run", {
      expiresAt: 8_640_000_000_000_001,
    } as never);

    await expect(
      expectDefined(codeModeTools[1], "codeModeTools[1] test invariant").execute(
        "code-wait-invalid-expiry",
        { runId: "invalid-expiry-run" },
      ),
    ).rejects.toThrow("code mode run is unavailable or expired");
    expect(testing.activeRuns.has("invalid-expiry-run")).toBe(false);
  });

  it("rejects wait calls from a different session scope", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    applyCodeModeCatalog({
      tools: [...codeModeTools, pluginTool("fake_noop", "Noop")],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const first = resultDetails(
      await expectDefined(codeModeTools[0], "codeModeTools[0] test invariant").execute(
        "code-call-wrong-session",
        {
          code: 'await yield_control("pause"); return "done";',
        },
      ),
    );
    expect(first.status).toBe("waiting");
    const otherWaitTool = expectDefined(
      createCodeModeTools({
        config,
        runtimeConfig: config,
        sessionId: "other-session",
        sessionKey: "agent:other:main",
        runId: "run-code-mode",
        catalogRef,
      })[1],
      'createCodeModeTools({ config, runtimeConfig: config, sessionId: "othe... test invariant',
    );

    await expect(
      otherWaitTool.execute("code-wait-wrong-session", { runId: first.runId }),
    ).rejects.toThrow("different session");
  });

  it.each(["runId", "sessionId", "sessionKey", "agentId"] as const)(
    "rejects suspended-run callers missing the owner %s",
    async (missingIdentity) => {
      const {
        config,
        catalogRef,
        ctx,
        tools: codeModeTools,
      } = createCodeModeHarness({
        agentId: "owner",
      });
      applyCodeModeCatalog({
        tools: [...codeModeTools, pluginTool("fake_noop", "Noop")],
        config,
        sessionId: ctx.sessionId,
        sessionKey: ctx.sessionKey,
        agentId: ctx.agentId,
        runId: ctx.runId,
        catalogRef,
      });

      const suspended = resultDetails(
        await expectDefined(codeModeTools[0], "Code Mode exec test invariant").execute(
          "code-call-scoped-owner",
          { code: 'await yield_control("pause"); return "owner-secret";' },
        ),
      );
      expect(suspended.status).toBe("waiting");

      const missingIdentityWait = expectDefined(
        createCodeModeTools({
          config,
          runtimeConfig: config,
          catalogRef,
          ...(missingIdentity === "runId" ? {} : { runId: ctx.runId }),
          ...(missingIdentity === "sessionId" ? {} : { sessionId: ctx.sessionId }),
          ...(missingIdentity === "sessionKey" ? {} : { sessionKey: ctx.sessionKey }),
          ...(missingIdentity === "agentId" ? {} : { agentId: ctx.agentId }),
        })[1],
        "Unscoped Code Mode wait test invariant",
      );

      await expect(
        missingIdentityWait.execute("code-wait-missing-owner", { runId: suspended.runId }),
      ).rejects.toThrow(missingIdentity === "runId" ? "different agent run" : "different session");
      expect(testing.activeRuns.has(suspended.runId as string)).toBe(true);

      const rightfulResult = resultDetails(
        await expectDefined(codeModeTools[1], "Owner Code Mode wait test invariant").execute(
          "code-wait-rightful-owner",
          { runId: suspended.runId },
        ),
      );
      expect(rightfulResult.status).toBe("completed");
      expect(rightfulResult.value).toBe("owner-secret");
    },
  );

  it("rejects concurrent waits for the same suspended run", async () => {
    const catalogRef = createToolSearchCatalogRef();
    const config = {
      tools: {
        codeMode: {
          enabled: true,
          timeoutMs: 500,
        },
      },
    } as never;
    const ctx = {
      config,
      runtimeConfig: config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    };
    const codeModeTools = createCodeModeTools(ctx);
    applyCodeModeCatalog({
      tools: [
        ...codeModeTools,
        pluginToolWithExecute(
          "fake_slow",
          "Slow helper",
          async () => await new Promise<never>(() => {}),
        ),
      ],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const first = resultDetails(
      await expectDefined(codeModeTools[0], "codeModeTools[0] test invariant").execute(
        "code-call-concurrent-wait",
        {
          code: "await tools.fake_slow({}); return 'done';",
        },
      ),
    );
    expect(first.status).toBe("waiting");

    const firstWait = expectDefined(codeModeTools[1], "codeModeTools[1] test invariant").execute(
      "code-wait-concurrent-a",
      {
        runId: first.runId,
      },
    );
    await expect(
      expectDefined(codeModeTools[1], "codeModeTools[1] test invariant").execute(
        "code-wait-concurrent-b",
        { runId: first.runId },
      ),
    ).rejects.toThrow("already being resumed");
    const stillWaiting = resultDetails(await firstWait);

    expect(stillWaiting.status).toBe("waiting");
    expect(stillWaiting.runId).toBe(first.runId);
  });

  it("reports only unsettled pending tool calls when wait times out", async () => {
    const catalogRef = createToolSearchCatalogRef();
    const config = {
      tools: {
        codeMode: {
          enabled: true,
          timeoutMs: 500,
        },
      },
    } as never;
    const ctx = {
      config,
      runtimeConfig: config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    };
    const codeModeTools = createCodeModeTools(ctx);
    applyCodeModeCatalog({
      tools: [
        ...codeModeTools,
        pluginTool("fake_fast", "Fast helper"),
        pluginToolWithExecute(
          "fake_slow",
          "Slow helper",
          async () => await new Promise<never>(() => {}),
        ),
      ],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const first = resultDetails(
      await expectDefined(codeModeTools[0], "codeModeTools[0] test invariant").execute(
        "code-call-timeout",
        {
          code: `
          const fast = tools.fake_fast({});
          const slow = tools.fake_slow({});
          await fast;
          await slow;
          return "done";
        `,
        },
      ),
    );
    expect(first.status).toBe("waiting");
    expect(first.pendingToolCalls).toEqual([expect.objectContaining({ method: "callValue" })]);
    const runId = first.runId;
    expect(typeof runId).toBe("string");
    if (typeof runId !== "string") {
      throw new Error("expected code mode run id");
    }

    const activeRun = testing.activeRuns.get(runId);
    expect(activeRun).toBeDefined();
    activeRun!.config.timeoutMs = 100;

    const second = resultDetails(
      await expectDefined(codeModeTools[1], "codeModeTools[1] test invariant").execute(
        "code-wait-timeout",
        { runId },
      ),
    );

    expect(second.status).toBe("waiting");
    expect(second.pendingToolCalls).toEqual([expect.objectContaining({ method: "callValue" })]);
  });

  it("does not load TypeScript for plain JavaScript code mode runs", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    applyCodeModeCatalog({
      tools: [...codeModeTools, pluginTool("fake_noop", "Noop")],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = await runUntilCompleted({
      execTool: expectDefined(codeModeTools[0], "codeModeTools[0] test invariant"),
      waitTool: expectDefined(codeModeTools[1], "codeModeTools[1] test invariant"),
      code: "return 42;",
    });

    expect(details.status).toBe("completed");
    expect(details.value).toBe(42);
    expect(testing.getTypescriptRuntimePromise()).toBeNull();
  });

  it("allows identifiers and strings that contain import without module access", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    applyCodeModeCatalog({
      tools: [...codeModeTools, pluginTool("fake_noop", "Noop")],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = await runUntilCompleted({
      execTool: expectDefined(codeModeTools[0], "codeModeTools[0] test invariant"),
      waitTool: expectDefined(codeModeTools[1], "codeModeTools[1] test invariant"),
      code: `
        const important = 41;
        const message = "import docs later";
        return important + (message.includes("import") ? 1 : 0);
      `,
    });

    expect(details.status).toBe("completed");
    expect(details.value).toBe(42);
  });

  it.each([
    {
      name: "template-literal import text",
      code: "return `import('node:fs')`;",
      value: "import('node:fs')",
    },
    {
      name: "template-literal require text",
      code: "return `require('node:fs')`;",
      value: "require('node:fs')",
    },
    {
      name: "nested template-literal module text",
      code: "return `outer ${`require('node:fs')`}`;",
      value: "outer require('node:fs')",
    },
    {
      name: "regular-expression module text",
      code: 'return /import.meta/.test("import.meta");',
      value: true,
    },
    {
      name: "regular-expression module text inside interpolation",
      code: 'return `${/import.meta/.test("import.meta")}`;',
      value: "true",
    },
    {
      name: "ordinary import method",
      code: "const api = { import(value) { return value; } }; return api.import(42);",
      value: 42,
    },
    {
      name: "ordinary require method",
      code: "const api = { require(value) { return value; } }; return api.require(42);",
      value: 42,
    },
    {
      name: "optional ordinary import method",
      code: "const api = { import(value) { return value; } }; return api?.import?.(42);",
      value: 42,
    },
    {
      name: "computed ordinary require method",
      code: 'const api = { require(value) { return value; } }; return api["require"](42);',
      value: 42,
    },
    {
      name: "ordinary import metadata property",
      code: "const api = { import: { meta: 42 } }; return api.import.meta;",
      value: 42,
    },
  ])("executes harmless $name in the real guest worker", async ({ code, value }) => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    applyCodeModeCatalog({
      tools: [...codeModeTools, pluginTool("fake_noop", "Noop")],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = await runUntilCompleted({
      execTool: expectDefined(codeModeTools[0], "codeModeTools[0] test invariant"),
      waitTool: expectDefined(codeModeTools[1], "codeModeTools[1] test invariant"),
      code,
    });

    expect(details).toMatchObject({ status: "completed", value });
    expect(testing.activeRuns.size).toBe(0);
  });

  it("never exposes Node module-loader globals to the real guest worker", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    applyCodeModeCatalog({
      tools: [...codeModeTools, pluginTool("fake_noop", "Noop")],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = await runUntilCompleted({
      execTool: expectDefined(codeModeTools[0], "codeModeTools[0] test invariant"),
      waitTool: expectDefined(codeModeTools[1], "codeModeTools[1] test invariant"),
      code: "return [typeof process, typeof module, typeof require];",
    });

    expect(details).toMatchObject({
      status: "completed",
      value: ["undefined", "undefined", "undefined"],
    });
    expect(testing.activeRuns.size).toBe(0);
  });

  it("isolates and cleans up 12 concurrent real guest workers", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    applyCodeModeCatalog({
      tools: [...codeModeTools, pluginTool("fake_noop", "Noop")],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });
    const execTool = expectDefined(codeModeTools[0], "codeModeTools[0] test invariant");

    const results = await Promise.all(
      Array.from({ length: 12 }, async (_, index) =>
        resultDetails(
          await execTool.execute(`code-call-concurrent-worker-${index}`, {
            code: `return { index: ${index}, message: \`require('node:fs')\` };`,
          }),
        ),
      ),
    );

    expect(results).toEqual(
      Array.from({ length: 12 }, (_, index) =>
        expect.objectContaining({
          status: "completed",
          value: { index, message: "require('node:fs')" },
        }),
      ),
    );
    expect(testing.activeRuns.size).toBe(0);
    expect(testing.resumingRunIds.size).toBe(0);
  });

  it("fails pending promises that have no host bridge work", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    applyCodeModeCatalog({
      tools: [...codeModeTools, pluginTool("fake_noop", "Noop")],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const beforeRunCount = testing.activeRuns.size;
    const details = resultDetails(
      await expectDefined(codeModeTools[0], "codeModeTools[0] test invariant").execute(
        "code-call-empty-wait",
        {
          code: "await new Promise(() => undefined); return 'never';",
        },
      ),
    );

    expect(details.status).toBe("failed");
    expect(String(details.error)).toContain("pending without host work");
    expect(testing.activeRuns.size).toBe(beforeRunCount);
  });

  it("surfaces the QuickJS error name and message for guest syntax errors", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    applyCodeModeCatalog({
      tools: [...codeModeTools, pluginTool("fake_noop", "Noop")],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = resultDetails(
      await expectDefined(codeModeTools[0], "codeModeTools[0] test invariant").execute(
        "code-call-syntax",
        { code: "const x = ;" },
      ),
    );

    expect(details.status).toBe("failed");
    const error = String(details.error);
    // Regression guard: QuickJS stacks are frames only, so the error used to
    // collapse to a bare "at openclaw-code-mode:user.js:..." location with the
    // actual cause dropped. The model now sees the name and message.
    expect(error).toContain("SyntaxError");
    expect(error).toContain("unexpected token");
    expect(error.startsWith("at ")).toBe(false);
  });

  it("surfaces the QuickJS error name and message for guest runtime errors", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    applyCodeModeCatalog({
      tools: [...codeModeTools, pluginTool("fake_noop", "Noop")],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = resultDetails(
      await expectDefined(codeModeTools[0], "codeModeTools[0] test invariant").execute(
        "code-call-runtime",
        { code: "return missingFn();" },
      ),
    );

    expect(details.status).toBe("failed");
    const error = String(details.error);
    expect(error).toContain("ReferenceError");
    expect(error).toContain("missingFn is not defined");
    expect(error.startsWith("at ")).toBe(false);
  });

  it("does not expose the raw host request callback", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    applyCodeModeCatalog({
      tools: [...codeModeTools, pluginTool("fake_noop", "Noop")],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = resultDetails(
      await expectDefined(codeModeTools[0], "codeModeTools[0] test invariant").execute(
        "code-hidden-host-request",
        { code: "return typeof globalThis.__openclawHostRequest;" },
      ),
    );

    expect(details).toMatchObject({
      status: "completed",
      value: "undefined",
    });
  });

  it("clamps omitted code-mode catalog search limits to maxSearchLimit", async () => {
    const catalogRef = createToolSearchCatalogRef();
    const config = {
      tools: {
        codeMode: {
          enabled: true,
          maxSearchLimit: 3,
        },
      },
    } as never;
    const ctx = {
      config,
      runtimeConfig: config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    };
    const codeModeTools = createCodeModeTools(ctx);
    applyCodeModeCatalog({
      tools: [
        ...codeModeTools,
        pluginTool("fake_ticket_one", "ticket helper"),
        pluginTool("fake_ticket_two", "ticket helper"),
        pluginTool("fake_ticket_three", "ticket helper"),
        pluginTool("fake_ticket_four", "ticket helper"),
        pluginTool("fake_ticket_five", "ticket helper"),
      ],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = await runUntilCompleted({
      execTool: expectDefined(codeModeTools[0], "codeModeTools[0] test invariant"),
      waitTool: expectDefined(codeModeTools[1], "codeModeTools[1] test invariant"),
      code: 'const hits = await tools.search("ticket"); return hits.length;',
    });

    expect(details.status).toBe("completed");
    expect(details.value).toBe(3);
  });

  it("supports TypeScript source transform", async () => {
    testing.setTypescriptRuntimeForTest({
      ...(await import("typescript")),
      transpileModule: vi.fn((code: string) => ({
        outputText: code.replace(": number", ""),
        diagnostics: [],
      })),
      ScriptTarget: { ES2022: 9 },
      ModuleKind: { ESNext: 99 },
      ImportsNotUsedAsValues: { Remove: 0 },
      DiagnosticCategory: { Error: 1 },
      flattenDiagnosticMessageText: (message: unknown) => String(message),
    } as never);
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    applyCodeModeCatalog({
      tools: [...codeModeTools, pluginTool("fake_noop", "Noop")],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = await runUntilCompleted({
      execTool: expectDefined(codeModeTools[0], "codeModeTools[0] test invariant"),
      waitTool: expectDefined(codeModeTools[1], "codeModeTools[1] test invariant"),
      language: "typescript",
      code: `
        const value: number = 40 + 2;
        return { value };
      `,
    });

    expect(details.status).toBe("completed");
    expect(details.value).toEqual({ value: 42 });

    const moduleShapedTypeScript = await runUntilCompleted({
      execTool: expectDefined(codeModeTools[0], "codeModeTools[0] test invariant"),
      waitTool: expectDefined(codeModeTools[1], "codeModeTools[1] test invariant"),
      language: "typescript",
      code: "const value: number = 42; return `import('node:fs') ${value}`;",
    });

    expect(moduleShapedTypeScript.status).toBe("completed");
    expect(moduleShapedTypeScript.value).toBe("import('node:fs') 42");

    const moduleShapedTypeScriptRegex = await runUntilCompleted({
      execTool: expectDefined(codeModeTools[0], "codeModeTools[0] test invariant"),
      waitTool: expectDefined(codeModeTools[1], "codeModeTools[1] test invariant"),
      language: "typescript",
      code: 'const value: number = 42; return /import.meta/.test("import.meta");',
    });

    expect(moduleShapedTypeScriptRegex.status).toBe("completed");
    expect(moduleShapedTypeScriptRegex.value).toBe(true);

    for (const moduleAccess of ["import('node:fs')", "require('node:fs')"]) {
      const unicodeModuleAccess = resultDetails(
        await expectDefined(codeModeTools[0], "codeModeTools[0] test invariant").execute(
          `code-call-typescript-unicode-${moduleAccess.startsWith("import") ? "import" : "require"}`,
          {
            language: "typescript",
            code: `const value: number = 1; const padding = "${"😀".repeat(96)}"; return ${moduleAccess};`,
          },
        ),
      );

      expect(unicodeModuleAccess.status).toBe("failed");
      expect(unicodeModuleAccess.code).toBe("invalid_input");
      expect(unicodeModuleAccess.error).toContain("module access is disabled");
    }

    const commandLikeTypeScript = await runUntilCompleted({
      execTool: expectDefined(codeModeTools[0], "codeModeTools[0] test invariant"),
      waitTool: expectDefined(codeModeTools[1], "codeModeTools[1] test invariant"),
      language: "typescript",
      code: "node -1; var node: number = 7; return node;",
    });

    expect(commandLikeTypeScript.status).toBe("completed");
    expect(commandLikeTypeScript.value).toBe(7);

    const typedShell = resultDetails(
      await expectDefined(codeModeTools[0], "codeModeTools[0] test invariant").execute(
        "code-call-typescript-shell-source",
        { code: "pwd", language: "typescript" },
      ),
    );

    expect(typedShell.status).toBe("failed");
    expect(typedShell.code).toBe("invalid_input");
    expect(typedShell.error).toMatch(/JavaScript or TypeScript, not shell commands/);
    expect(testing.activeRuns.size).toBe(0);
  });

  it.each([
    "const fs = require('node:fs'); return fs;",
    String.raw`return r\u0065quire('node:fs');`,
    "return require?.('node:fs');",
    "return (require)('node:fs');",
    "return (0, require)('node:fs');",
    "const load = require; return load('node:fs');",
    "return module.require('node:fs');",
    "return process.getBuiltinModule('node:fs');",
    "return import('node:fs');",
    "return import.meta.url;",
    "return `${import('node:fs')}`;",
    "return `${require('node:fs')}`;",
    "return `${`nested ${import('node:fs')}`}`;",
    "return `${`nested ${require('node:fs')}`}`;",
    "return `${({ value: import('node:fs') }).value}`;",
    "const message = `import('node:fs')`; return require('node:fs');",
    "const pattern = /import.meta/; return import('node:fs');",
    "let value = 1; return value++ / import('node:fs');",
    "let value = 1; return value-- / import('node:fs');",
    "const value = { of: 1 }; return value.of / import('node:fs');",
    "const value = { return: 1 }; return value.return / import('node:fs');",
    "const value = { if() { return 1; } }; return value.if() / import('node:fs');",
    "const value = { return: 1 }; return value?.return / import('node:fs') / 1;",
    "const value = { return: 1 }; return value?.return / require('node:fs') / 1;",
    "const value = { if() { return 1; } }; return value?.if() / import('node:fs');",
    "function run() { const await = 1; return await / (globalThis.pending = import('node:fs')); } run(); return globalThis.pending;",
    "class Guest { #return = 1; run() { return this.#return / (globalThis.pending = import('node:fs')); } } new Guest().run(); return globalThis.pending;",
  ])("rejects module access: %s", async (code) => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    applyCodeModeCatalog({
      tools: [...codeModeTools, pluginTool("fake_noop", "Noop")],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = resultDetails(
      await expectDefined(codeModeTools[0], "codeModeTools[0] test invariant").execute(
        "code-call-import",
        {
          code,
        },
      ),
    );

    expect(details.status).toBe("failed");
    expect(String(details.error)).toContain("module access is disabled");
  });

  it("enforces output limits on completed exec calls", async () => {
    const catalogRef = createToolSearchCatalogRef();
    const config = {
      tools: {
        codeMode: {
          enabled: true,
          maxOutputBytes: 1024,
        },
      },
    } as never;
    const ctx = {
      config,
      runtimeConfig: config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    };
    const tools = createCodeModeTools(ctx);
    applyCodeModeCatalog({
      tools: [...tools, pluginTool("fake_noop", "Noop")],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = resultDetails(
      await expectDefined(tools[0], "tools[0] test invariant").execute("code-call-large", {
        code: "return 'x'.repeat(2048);",
      }),
    );

    expect(details.status).toBe("failed");
    expect(String(details.error)).toContain("output limit exceeded");
    expect(details.code).toBe("output_limit_exceeded");
  });

  it("enforces output limits before suspending runs", async () => {
    const catalogRef = createToolSearchCatalogRef();
    const config = {
      tools: {
        codeMode: {
          enabled: true,
          maxOutputBytes: 1024,
        },
      },
    } as never;
    const ctx = {
      config,
      runtimeConfig: config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    };
    const tools = createCodeModeTools(ctx);
    applyCodeModeCatalog({
      tools: [...tools, pluginTool("fake_noop", "Noop")],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const beforeRunCount = testing.activeRuns.size;
    const details = resultDetails(
      await expectDefined(tools[0], "tools[0] test invariant").execute("code-call-large-suspend", {
        code: "text('x'.repeat(2048)); await yield_control('pause'); return 1;",
      }),
    );

    expect(details.status).toBe("failed");
    expect(String(details.error)).toContain("output limit exceeded");
    expect(details.code).toBe("output_limit_exceeded");
    expect(testing.activeRuns.size).toBe(beforeRunCount);
  });

  it("enforces output limits before auto-draining namespace calls", async () => {
    const catalogRef = createToolSearchCatalogRef();
    const config = {
      tools: {
        codeMode: {
          enabled: true,
          maxOutputBytes: 1024,
        },
      },
    } as never;
    const ctx = {
      config,
      runtimeConfig: config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    };
    const tools = createCodeModeTools(ctx);
    const executeListIssues = vi.fn(async () => jsonResult({ ok: true }));
    const listIssues = mcpTool({
      name: "tickets__list",
      serverName: "tickets",
      toolName: "list",
      execute: executeListIssues,
    });
    applyCodeModeCatalog({
      tools: [...tools, listIssues],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = resultDetails(
      await expectDefined(tools[0], "tools[0] test invariant").execute(
        "code-call-large-namespace",
        {
          code: 'text("x".repeat(2048)); await MCP.tickets.list({ state: "open" }); return 1;',
        },
      ),
    );

    expect(details.status).toBe("failed");
    expect(String(details.error)).toContain("output limit exceeded");
    expect(details.code).toBe("output_limit_exceeded");
    expect(executeListIssues).not.toHaveBeenCalled();
  });

  it("preserves guest output when a run fails", async () => {
    const { config, catalogRef, tools } = createCodeModeHarness();
    applyCodeModeCatalog({
      tools: [...tools, pluginTool("fake_noop", "Noop")],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = resultDetails(
      await expectDefined(tools[0], "tools[0] test invariant").execute(
        "code-call-output-before-error",
        {
          code: 'text("before"); throw new Error("boom");',
        },
      ),
    );

    expect(details.status).toBe("failed");
    expect(String(details.error)).toContain("Error: boom");
    expect(details.output).toEqual([{ type: "text", text: "before" }]);
  });

  it("classifies snapshot limit failures", async () => {
    const config = resolveCodeModeConfig({
      tools: { codeMode: { enabled: true, maxSnapshotBytes: 1024 } },
    } as never);

    const result = await testing.runCodeModeWorker(
      {
        kind: "exec",
        source: 'const value = "x".repeat(100000); await yield_control("pause"); return value;',
        config,
        catalog: [],
      },
      5000,
    );

    expect(result.status).toBe("failed");
    expect(result).toMatchObject({
      code: "snapshot_limit_exceeded",
      error: "code mode snapshot limit exceeded",
    });
  });

  it("terminates hostile infinite loops outside the main event loop", async () => {
    const catalogRef = createToolSearchCatalogRef();
    const config = {
      tools: {
        codeMode: {
          enabled: true,
          timeoutMs: 100,
        },
      },
    } as never;
    const ctx = {
      config,
      runtimeConfig: config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    };
    const tools = createCodeModeTools(ctx);
    applyCodeModeCatalog({
      tools: [...tools, pluginTool("fake_noop", "Noop")],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const heartbeat = Promise.resolve("main-event-loop-alive");
    const details = resultDetails(
      await expectDefined(tools[0], "tools[0] test invariant").execute("code-call-loop", {
        code: "while (true) {}",
      }),
    );

    await expect(heartbeat).resolves.toBe("main-event-loop-alive");
    expect(details.status).toBe("failed");
    expect(String(details.error)).toContain("timeout exceeded");
    expect(details.code).toBe("timeout");
  });

  it("normalizes QuickJS interrupt timeout errors", () => {
    expect(
      testing.normalizeCodeModeWorkerResult({
        status: "failed",
        code: "timeout",
        error: "interrupted",
        output: [],
      }),
    ).toMatchObject({
      code: "timeout",
      error: "code mode timeout exceeded",
    });

    expect(
      testing.normalizeCodeModeWorkerResult({
        status: "failed",
        code: "internal_error",
        error: "interrupted",
        output: [],
      }),
    ).toMatchObject({
      code: "internal_error",
      error: "interrupted",
    });
  });

  it("classifies missing worker runtime as unavailable", async () => {
    const config = resolveCodeModeConfig({ tools: { codeMode: true } } as never);
    const missingWorkerUrl = new URL("./missing-code-mode.worker.js", import.meta.url);

    const result = await testing.runCodeModeWorker(
      {
        kind: "exec",
        source: "return 1;",
        config,
        catalog: [],
      },
      500,
      missingWorkerUrl,
    );

    expect(result.status).toBe("failed");
    expect(result).toMatchObject({
      code: "runtime_unavailable",
    });
  });

  it("classifies nonzero worker exits as unavailable", async () => {
    const config = resolveCodeModeConfig({ tools: { codeMode: true } } as never);
    const exitingWorkerUrl = new URL("data:text/javascript,process.exit(1)");

    const result = await testing.runCodeModeWorker(
      {
        kind: "exec",
        source: "return 1;",
        config,
        catalog: [],
      },
      500,
      exitingWorkerUrl,
    );

    expect(result.status).toBe("failed");
    expect(result).toMatchObject({
      code: "runtime_unavailable",
    });
  });

  it("classifies clean worker exits without a result as unavailable", async () => {
    const config = resolveCodeModeConfig({ tools: { codeMode: true } } as never);
    const exitingWorkerUrl = new URL("data:text/javascript,");

    const result = await testing.runCodeModeWorker(
      {
        kind: "exec",
        source: "return 1;",
        config,
        catalog: [],
      },
      5_000,
      exitingWorkerUrl,
    );

    expect(result).toMatchObject({
      status: "failed",
      code: "runtime_unavailable",
      error: "code mode worker exited with code 0 before returning a result",
    });
  });

  it("does not classify guest interrupted errors as timeouts", async () => {
    const config = resolveCodeModeConfig({ tools: { codeMode: true } } as never);

    const result = await testing.runCodeModeWorker(
      {
        kind: "exec",
        source: 'throw new Error("interrupted");',
        config,
        catalog: [],
      },
      10_000,
    );

    expect(result.status).toBe("failed");
    // A guest error whose message happens to be "interrupted" must stay
    // internal_error and not be misclassified as a QuickJS interrupt/timeout.
    expect(result).toMatchObject({ code: "internal_error" });
    if (result.status === "failed") {
      expect(result.error).toContain("interrupted");
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
