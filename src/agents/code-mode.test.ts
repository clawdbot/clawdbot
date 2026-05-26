import { afterEach, describe, expect, it, vi } from "vitest";
import { setPluginToolMeta } from "../plugins/tools.js";
import {
  applyCodeModeCatalog,
  CODE_MODE_EXEC_TOOL_NAME,
  CODE_MODE_WAIT_TOOL_NAME,
  createCodeModeTools,
  resolveCodeModeConfig,
  testing,
} from "./code-mode.js";
import { createToolSearchCatalogRef, type ToolSearchCatalogRef } from "./tool-search.js";
import {
  TOOL_CALL_RAW_TOOL_NAME,
  TOOL_DESCRIBE_RAW_TOOL_NAME,
  TOOL_SEARCH_CODE_MODE_TOOL_NAME,
  TOOL_SEARCH_RAW_TOOL_NAME,
} from "./tool-search.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";

function fakeTool(name: string, description: string): AnyAgentTool {
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

function resultDetails(result: { details?: unknown }): Record<string, unknown> {
  expect(result.details).toBeDefined();
  expect(typeof result.details).toBe("object");
  return result.details as Record<string, unknown>;
}

function createCodeModeHarness(params: { catalogRef?: ToolSearchCatalogRef } = {}) {
  const catalogRef = params.catalogRef ?? createToolSearchCatalogRef();
  const config = { tools: { codeMode: true } } as never;
  const ctx = {
    config,
    runtimeConfig: config,
    sessionId: "session-code-mode",
    sessionKey: "agent:main:main",
    runId: "run-code-mode",
    catalogRef,
  };
  const tools = createCodeModeTools(ctx);
  return { catalogRef, config, ctx, tools };
}

async function runUntilCompleted(params: {
  execTool: AnyAgentTool;
  waitTool: AnyAgentTool;
  code: string;
  language?: "javascript" | "typescript";
}) {
  let details = resultDetails(
    await params.execTool.execute("code-call-1", {
      code: params.code,
      language: params.language,
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
  afterEach(() => {
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
    expect(resolved.enabled).toBe(false);
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
    const parameters = tools[0].parameters as {
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
    const execTool = tools[0];
    const parameters = execTool.parameters as {
      properties?: Record<string, Record<string, unknown>>;
    };

    expect(execTool.description).toContain("Node.js modules");
    expect(execTool.description).toContain("`require`/`import` are NOT available");
    expect(execTool.description).toContain("`tools.search(query)`");
    expect(execTool.description).toContain("enabled catalog tools allowed by policy");
    expect(execTool.description).toContain("`tools.describe(entry.id)`");
    expect(execTool.description).toContain("`tools.call(entry.id, args)`");
    expect(execTool.description).toContain('"javascript" or "typescript"');

    expect(parameters.properties?.code?.description).toContain("`tools` object");
    expect(parameters.properties?.code?.description).toContain("`ALL_TOOLS`");
    expect(parameters.properties?.code?.description).toContain("Node built-in modules are not");
    expect(parameters.properties?.language?.description).toContain(
      'Must be "javascript" or "typescript"',
    );
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
      await tools[0].execute("code-call-command-alias", {
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
      tools[0].execute("code-call-divergent-alias", {
        code: "return 1;",
        command: "return 2;",
      }),
    ).rejects.toThrow("code and command must match when both are provided");
  });

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
      execTool: codeModeTools[0],
      waitTool: codeModeTools[1],
      code: `
        const hits = await tools.search("ticket", { limit: 1 });
        const described = await tools.describe(hits[0].id);
        const called = await tools.call(described.id, { value: "ship" });
        text("created");
        return called.result.details;
      `,
    });

    expect(details.status).toBe("completed");
    expect(details.value).toEqual({
      name: "fake_create_ticket",
      input: { value: "ship" },
    });
    expect(details.output).toEqual([{ type: "text", text: "created" }]);
    expect(ticket.execute).toHaveBeenCalledTimes(1);
  });

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
      await codeModeTools[0].execute("code-call-yield", {
        code: `
          text("before");
          await yield_control("pause");
          text("after");
          return "done";
        `,
      }),
    );

    expect(first.status).toBe("waiting");
    expect(first.reason).toBe("yield");
    expect(first.output).toEqual([{ type: "text", text: "before" }]);

    const runId = first.runId;
    expect(typeof runId).toBe("string");
    const resumed = resultDetails(await codeModeTools[1].execute("code-wait-yield", { runId }));

    expect(resumed.status).toBe("completed");
    expect(resumed.value).toBe("done");
    expect(resumed.output).toEqual([
      { type: "text", text: "before" },
      { type: "text", text: "after" },
    ]);
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
      await codeModeTools[0].execute("code-call-wrong-session", {
        code: 'await yield_control("pause"); return "done";',
      }),
    );
    expect(first.status).toBe("waiting");
    const otherWaitTool = createCodeModeTools({
      config,
      runtimeConfig: config,
      sessionId: "other-session",
      sessionKey: "agent:other:main",
      runId: "run-code-mode",
      catalogRef,
    })[1];

    await expect(
      otherWaitTool.execute("code-wait-wrong-session", { runId: first.runId }),
    ).rejects.toThrow("different session");
  });

  it("rejects concurrent waits for the same suspended run", async () => {
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
    const codeModeTools = createCodeModeTools(ctx);
    applyCodeModeCatalog({
      tools: [
        ...codeModeTools,
        pluginToolWithExecute(
          "fake_slow",
          "Slow helper",
          async () => await new Promise<never>(() => undefined),
        ),
      ],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const first = resultDetails(
      await codeModeTools[0].execute("code-call-concurrent-wait", {
        code: "await tools.fake_slow({}); return 'done';",
      }),
    );
    expect(first.status).toBe("waiting");

    const firstWait = codeModeTools[1].execute("code-wait-concurrent-a", {
      runId: first.runId,
    });
    await expect(
      codeModeTools[1].execute("code-wait-concurrent-b", { runId: first.runId }),
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
    const codeModeTools = createCodeModeTools(ctx);
    applyCodeModeCatalog({
      tools: [
        ...codeModeTools,
        pluginTool("fake_fast", "Fast helper"),
        pluginToolWithExecute(
          "fake_slow",
          "Slow helper",
          async () => await new Promise<never>(() => undefined),
        ),
      ],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const first = resultDetails(
      await codeModeTools[0].execute("code-call-timeout", {
        code: `
          const fast = tools.fake_fast({});
          const slow = tools.fake_slow({});
          await fast;
          await slow;
          return "done";
        `,
      }),
    );
    expect(first.status).toBe("waiting");
    expect(first.pendingToolCalls).toHaveLength(2);

    const second = resultDetails(
      await codeModeTools[1].execute("code-wait-timeout", { runId: first.runId }),
    );

    expect(second.status).toBe("waiting");
    expect(second.pendingToolCalls).toEqual([expect.objectContaining({ method: "call" })]);
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
      execTool: codeModeTools[0],
      waitTool: codeModeTools[1],
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
      execTool: codeModeTools[0],
      waitTool: codeModeTools[1],
      code: `
        const important = 41;
        const message = "import docs later";
        return important + (message.includes("import") ? 1 : 0);
      `,
    });

    expect(details.status).toBe("completed");
    expect(details.value).toBe(42);
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
      await codeModeTools[0].execute("code-call-empty-wait", {
        code: "await new Promise(() => undefined); return 'never';",
      }),
    );

    expect(details.status).toBe("failed");
    expect(String(details.error)).toContain("pending without host work");
    expect(testing.activeRuns.size).toBe(beforeRunCount);
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
      execTool: codeModeTools[0],
      waitTool: codeModeTools[1],
      code: 'const hits = await tools.search("ticket"); return hits.length;',
    });

    expect(details.status).toBe("completed");
    expect(details.value).toBe(3);
  });

  it("supports TypeScript source transform", async () => {
    testing.setTypescriptRuntimeForTest({
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
      execTool: codeModeTools[0],
      waitTool: codeModeTools[1],
      language: "typescript",
      code: `
        const value: number = 40 + 2;
        return { value };
      `,
    });

    expect(details.status).toBe("completed");
    expect(details.value).toEqual({ value: 42 });
  });

  it.each([
    "const fs = require('node:fs'); return fs;",
    "return import('node:fs');",
    "return import.meta.url;",
    "return `${import('node:fs')}`;",
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
      await codeModeTools[0].execute("code-call-import", {
        code,
      }),
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
      await tools[0].execute("code-call-large", {
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
      await tools[0].execute("code-call-large-suspend", {
        code: "text('x'.repeat(2048)); await yield_control('pause'); return 1;",
      }),
    );

    expect(details.status).toBe("failed");
    expect(String(details.error)).toContain("output limit exceeded");
    expect(details.code).toBe("output_limit_exceeded");
    expect(testing.activeRuns.size).toBe(beforeRunCount);
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
      await tools[0].execute("code-call-output-before-error", {
        code: 'text("before"); throw new Error("boom");',
      }),
    );

    expect(details.status).toBe("failed");
    expect(details.error).toBe("boom");
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
      1000,
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
      await tools[0].execute("code-call-loop", {
        code: "while (true) {}",
      }),
    );

    await expect(heartbeat).resolves.toBe("main-event-loop-alive");
    expect(details.status).toBe("failed");
    expect(String(details.error)).toContain("timeout exceeded");
    expect(details.code).toBe("timeout");
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

  it("does not classify guest interrupted errors as timeouts", async () => {
    const config = resolveCodeModeConfig({ tools: { codeMode: true } } as never);

    const result = await testing.runCodeModeWorker(
      {
        kind: "exec",
        source: 'throw new Error("interrupted");',
        config,
        catalog: [],
      },
      500,
    );

    expect(result.status).toBe("failed");
    expect(result).toMatchObject({
      code: "internal_error",
      error: "interrupted",
    });
  });
});
