import { access, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
} from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import { wrapToolWithAbortSignal } from "./agent-tools.abort.js";
import { createCodeModePermissionChangeReason } from "./code-mode-permission-change.js";
import type { CodeModeSkill } from "./code-mode-skills.js";
import { createSubscribedCodeModeHarness } from "./code-mode.bridge.lifecycle.test-support.js";
import { applyCodeModeCatalog, createCodeModeTools } from "./code-mode.js";
import {
  createCodeModeHarness,
  fakeTool,
  mcpTool,
  pluginToolWithExecute,
  resetCodeModeTestState,
  resultDetails,
  testing,
} from "./code-mode.test-support.js";
import { Agent } from "./runtime/index.js";
import { createReadTool } from "./sessions/tools/read.js";
import { isToolResultError, readToolResultDetails } from "./tool-result-error.js";
import { jsonResult, ToolInputError, type AnyAgentTool } from "./tools/common.js";

const model: Model = {
  id: "test-model",
  name: "Test Model",
  api: "openai-responses",
  provider: "test-provider",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000,
  maxTokens: 1_000,
};

function createAssistant(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: content.some((entry) => entry.type === "toolCall") ? "toolUse" : "stop",
    timestamp: Date.now(),
  };
}

async function runCodeModeAgent(params: {
  programs: Array<string | { wait: true }>;
  hiddenTools: AnyAgentTool[];
  codeModeSkills?: CodeModeSkill[];
  harness?:
    | ReturnType<typeof createCodeModeHarness>
    | ReturnType<typeof createSubscribedCodeModeHarness>;
  abortSignal?: AbortSignal;
  configureAgent?: (
    agent: Agent,
    harness: { tools: AnyAgentTool[]; ctx: Parameters<typeof createCodeModeTools>[0] },
  ) => void;
}) {
  const harness =
    params.harness ?? createCodeModeHarness({ codeModeSkills: params.codeModeSkills });
  const { config, catalogRef } = harness;
  const ctx = "ctx" in harness ? harness.ctx : harness;
  const tools = params.abortSignal
    ? createCodeModeTools({ ...ctx, abortSignal: params.abortSignal }).map((tool) =>
        wrapToolWithAbortSignal(tool, params.abortSignal),
      )
    : harness.tools;
  const sessionId = "sessionId" in harness ? harness.sessionId : "session-code-mode";
  const sessionKey = "sessionKey" in harness ? harness.sessionKey : "agent:main:main";
  const runId = "runId" in harness ? harness.runId : "run-code-mode";
  applyCodeModeCatalog({
    tools: [...tools, ...params.hiddenTools],
    config,
    sessionId,
    sessionKey,
    runId,
    catalogRef,
    codeModeSkills: params.codeModeSkills,
  });
  const providerContexts: Context[] = [];
  const agent = new Agent({
    initialState: { model, tools },
    afterToolCall: async ({ result, isError }) => ({
      isError: isError || isToolResultError(result),
    }),
    streamFn: (_activeModel, context) => {
      providerContexts.push(context);
      const index = providerContexts.length - 1;
      const code = params.programs[index];
      const waiting = code !== undefined && typeof code !== "string";
      const message = createAssistant(
        code === undefined
          ? [{ type: "text", text: "recovered" }]
          : [
              {
                type: "toolCall",
                id: `code-call-${index}`,
                name: waiting ? "wait" : "exec",
                arguments: waiting
                  ? { runId: readToolResultDetails(context.messages.at(-1))?.runId }
                  : { code },
              },
            ],
      );
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({
          type: "done",
          reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
          message,
        });
        stream.end();
      });
      return stream;
    },
  });
  params.configureAgent?.(agent, { tools, ctx });
  try {
    await agent.prompt("finish the task despite tool errors");
  } finally {
    if ("dispose" in harness) {
      harness.dispose();
    }
  }

  return { agent, providerContexts };
}

type ParkedFailure =
  | "read-only"
  | "earlier mutation"
  | "terminal read"
  | "copied details"
  | "cancel wait"
  | "abort outcome";

async function runParkedReadFailure(scenario: ParkedFailure) {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "code-mode-wait-")));
  const input = join(workspace, "input.txt");
  await writeFile(input, "audited input\n");
  const readStarted = createDeferred();
  const readRelease = createDeferred();
  const readFinished = createDeferred();
  const parked = createDeferred<Record<string, unknown>>();
  const beginWait = createDeferred();
  const outcomeEntered = createDeferred();
  const outcomeRelease = createDeferred();
  const effects: string[] = [];
  const read = createReadTool(workspace, {
    operations: {
      access,
      readFile: async (file) => {
        readStarted.resolve();
        await readRelease.promise;
        try {
          return await readFile(file);
        } finally {
          readFinished.resolve();
        }
      },
    },
  });
  const executeRead = read.execute.bind(read);
  read.execute = vi.fn(async (...args: Parameters<typeof executeRead>) => ({
    ...(await executeRead(...args)),
    ...(scenario === "terminal read" ? { terminate: true } : {}),
  }));
  const complete = pluginToolWithExecute("complete_task", "Complete the task", async () => {
    effects.push("completed");
    return jsonResult({ completed: true });
  });
  let activeAgent: Agent | undefined;
  let waitDetails: Record<string, unknown> | undefined;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const running = runCodeModeAgent({
    hiddenTools: [read, complete],
    programs: [
      `${scenario === "earlier mutation" ? "await complete_task({});" : ""}
       json(await read({ path: ${JSON.stringify(input)} })); return missingAfterWait();`,
      { wait: true },
      "return await complete_task({});",
    ],
    configureAgent: (agent) => {
      activeAgent = agent;
      agent.afterToolCall = async ({ toolCall, result, isError }) => {
        if (toolCall.name === "wait") {
          waitDetails = resultDetails(result);
          if (scenario === "copied details") {
            return { details: structuredClone(waitDetails), isError: true };
          }
        }
        return { isError: isError || isToolResultError(result) };
      };
      agent.afterToolOutcome = async ({ toolCall, result }) => {
        if (toolCall.name === "exec" && readToolResultDetails(result)?.status === "waiting") {
          vi.useRealTimers();
          parked.resolve(resultDetails(result));
          await beginWait.promise;
        }
        if (toolCall.name === "wait" && scenario === "abort outcome") {
          outcomeEntered.resolve();
          await outcomeRelease.promise;
        }
      };
    },
  });
  try {
    await readStarted.promise;
    // Only the host deadline moves; the real worker has already dispatched the audited read.
    await vi.advanceTimersByTimeAsync(10_000);
    const suspended = await parked.promise;
    expect(suspended).toMatchObject({
      status: "waiting",
      reason: "pending_tools",
      replaySafe: false,
    });
    expect(read.execute).toHaveBeenCalledOnce();
    expect(effects).toEqual(scenario === "earlier mutation" ? ["completed"] : []);
    beginWait.resolve();
    if (scenario === "cancel wait") {
      await vi.waitFor(() => expect(testing.resumingRunIds.size).toBe(1));
      activeAgent?.abort();
    } else {
      readRelease.resolve();
    }
    if (scenario === "abort outcome") {
      await outcomeEntered.promise;
      activeAgent?.abort();
      outcomeRelease.resolve();
    }
    const result = await running;
    expect(read.execute).toHaveBeenCalledOnce();
    expect(testing.activeRuns.size).toBe(0);
    expect(testing.resumingRunIds.size).toBe(0);
    expect(waitDetails).toMatchObject(
      scenario === "cancel wait"
        ? { status: "failed", code: "aborted" }
        : {
            status: "failed",
            bridgeDispatchStarted: true,
            error: expect.stringContaining("ReferenceError: missingAfterWait is not defined"),
            output: [expect.objectContaining({ type: "json" })],
          },
    );
    return { ...result, complete, effects, waitDetails };
  } finally {
    vi.useRealTimers();
    activeAgent?.abort();
    beginWait.resolve();
    readRelease.resolve();
    outcomeRelease.resolve();
    await running;
    await readFinished.promise;
    await rm(workspace, { recursive: true, force: true });
  }
}

describe("Code Mode agent-loop error recovery", () => {
  afterEach(() => {
    resetCodeModeTestState();
    vi.useRealTimers();
  });

  it("inspects source and completes multiple edits after a partially applied program fails", async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), "code-mode-continue-")));
    const file = join(workspace, "source.txt");
    await writeFile(file, "original\n");
    const patch = pluginToolWithExecute(
      "apply_patch",
      "Append a source change",
      async (_id, input) => {
        await writeFile(
          file,
          `${await readFile(file, "utf8")}${(input as { value: string }).value}\n`,
        );
        return jsonResult({ applied: true });
      },
    );
    const shell = pluginToolWithExecute("shell_command", "Inspect source", async () =>
      jsonResult({ source: await readFile(file, "utf8") }),
    );

    try {
      const { agent, providerContexts } = await runCodeModeAgent({
        hiddenTools: [patch, shell],
        programs: [
          'await apply_patch({ value: "first" }); throw new Error("interrupted after first change");',
          "return await shell_command({});",
          'return await apply_patch({ value: "second" });',
          'return await apply_patch({ value: "third" });',
          "return await shell_command({});",
        ],
      });

      expect(providerContexts).toHaveLength(6);
      expect(providerContexts[1]?.messages).toContainEqual(
        expect.objectContaining({
          role: "toolResult",
          isError: true,
          details: expect.objectContaining({
            status: "failed",
            error: expect.stringContaining("interrupted after first change"),
          }),
        }),
      );
      expect(patch.execute).toHaveBeenCalledTimes(3);
      expect(shell.execute).toHaveBeenCalledTimes(2);
      expect(await readFile(file, "utf8")).toBe("original\nfirst\nsecond\nthird\n");
      expect(agent.state.messages.at(-1)).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: "recovered" }],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("recovers from a real parked read failure and completes the requested mutation once", async () => {
    const { agent, providerContexts, complete, effects } = await runParkedReadFailure("read-only");
    expect(providerContexts).toHaveLength(4);
    expect(complete.execute).toHaveBeenCalledOnce();
    expect(effects).toEqual(["completed"]);
    expect(agent.state.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "recovered" }],
    });
  });

  it.each(["earlier mutation", "copied details"] as const)(
    "continues after a parked failure with %s without replaying prior work",
    async (scenario) => {
      const { providerContexts, complete, effects } = await runParkedReadFailure(scenario);
      expect(providerContexts).toHaveLength(4);
      expect(complete.execute).toHaveBeenCalledTimes(scenario === "earlier mutation" ? 2 : 1);
      expect(effects).toEqual(
        scenario === "earlier mutation" ? ["completed", "completed"] : ["completed"],
      );
    },
  );

  it.each(["terminal read", "cancel wait", "abort outcome"] as const)(
    "prevents another provider turn after a parked failure with %s",
    async (scenario) => {
      const { providerContexts, complete, effects } = await runParkedReadFailure(scenario);
      expect(providerContexts).toHaveLength(2);
      expect(complete.execute).not.toHaveBeenCalled();
      expect(effects).toEqual([]);
    },
  );

  it("continues after an operator permission change without replaying earlier mutations", async () => {
    const generation = new AbortController();
    const parked = createDeferred();
    const applied: string[] = [];
    const recordEffect = pluginToolWithExecute("record_effect", "Record an effect", async () => {
      applied.push("prior mutation");
      return jsonResult({ recorded: true });
    });
    const pending = pluginToolWithExecute(
      "pending_action",
      "Wait for permission",
      async (_id, _input, signal) => {
        if (!signal) {
          throw new Error("Expected owning tool signal");
        }
        const cancelled = createDeferred<never>();
        const onAbort = () => cancelled.reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        parked.resolve();
        try {
          return await cancelled.promise;
        } finally {
          signal.removeEventListener("abort", onAbort);
        }
      },
    );
    const inspect = pluginToolWithExecute(
      "inspect_state",
      "Inspect authoritative state",
      async () => jsonResult({ applied: [...applied] }),
    );
    const finish = pluginToolWithExecute("finish_task", "Finish remaining work", async () => {
      applied.push("remaining mutation");
      return jsonResult({ finished: true });
    });
    let changePermissions!: () => void;
    let retainedControl!: AnyAgentTool;
    const running = runCodeModeAgent({
      hiddenTools: [recordEffect, pending, inspect, finish],
      abortSignal: generation.signal,
      configureAgent: (agent, harness) => {
        retainedControl = harness.tools[0]!;
        agent.prepareNextTurn = async () => ({
          context: {
            systemPrompt: agent.state.systemPrompt,
            tools: agent.state.tools,
            messages: agent.state.messages,
          },
        });
        changePermissions = () => {
          generation.abort(createCodeModePermissionChangeReason());
          agent.state.tools = createCodeModeTools({
            ...harness.ctx,
            abortSignal: new AbortController().signal,
          });
        };
      },
      programs: [
        'await record_effect({}); json("prior mutation completed"); return await pending_action({});',
        "return await inspect_state({});",
        "return await finish_task({});",
      ],
    });
    await parked.promise;
    changePermissions();
    const { agent, providerContexts } = await running;

    expect(providerContexts).toHaveLength(4);
    expect(applied).toEqual(["prior mutation", "remaining mutation"]);
    expect(recordEffect.execute).toHaveBeenCalledOnce();
    expect(pending.execute).toHaveBeenCalledOnce();
    expect(inspect.execute).toHaveBeenCalledOnce();
    expect(finish.execute).toHaveBeenCalledOnce();
    expect(agent.state.messages).toContainEqual(
      expect.objectContaining({
        role: "toolResult",
        toolName: "exec",
        details: expect.objectContaining({
          status: "failed",
          code: "aborted",
          error: expect.stringContaining("Permission change"),
          output: [{ type: "json", value: "prior mutation completed" }],
        }),
      }),
    );
    await expect(retainedControl.execute("stale-control", { code: "return 1;" })).rejects.toThrow(
      "Aborted",
    );
  });

  it.each([
    {
      name: "catalog.search",
      discovery: '(await catalog.search("complete_task")).map((tool) => tool.toolName)',
      value: ["complete_task"],
    },
    {
      name: "handle.describe",
      discovery: "(await complete_task.describe()).name",
      value: "complete_task",
    },
    {
      name: "skills.list",
      discovery: "(await skills.list()).map((skill) => skill.name)",
      value: ["demo"],
    },
    { name: "skills.read", discovery: 'await skills.read("demo")', value: "Demo instructions" },
  ])(
    "continues ordinary recovery after $name metadata and a guest error",
    async ({ discovery, value }) => {
      const complete = pluginToolWithExecute("complete_task", "Complete the task", async () =>
        jsonResult({ completed: true }),
      );
      const { agent, providerContexts } = await runCodeModeAgent({
        hiddenTools: [complete],
        codeModeSkills: [
          {
            name: "demo",
            description: "Demo skill",
            location: "/skills/demo/SKILL.md",
            source: { filePath: "/skills/demo/SKILL.md", readContent: "Demo instructions" },
          },
        ],
        programs: [`json(${discovery}); return missingFn();`, "return await complete_task({});"],
      });

      const failure = expect.objectContaining({
        role: "toolResult",
        toolName: "exec",
        isError: true,
        details: expect.objectContaining({
          status: "failed",
          error: expect.stringContaining("ReferenceError: missingFn is not defined"),
          output: [{ type: "json", value }],
          telemetry: expect.objectContaining({ callCount: 0 }),
        }),
      });
      expect(agent.state.messages).toContainEqual(failure);
      expect(providerContexts).toHaveLength(3);
      expect(complete.execute).toHaveBeenCalledOnce();
      expect(agent.state.messages.at(-1)).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: "recovered" }],
      });
    },
  );

  it("returns a trusted no-start tool failure to the model for ordinary recovery", async () => {
    const terminal = pluginToolWithExecute("terminal", "Open a terminal", async () =>
      jsonResult({ unexpected: true }),
    );
    terminal.prepareBeforeToolCallParams = () => {
      throw new ToolInputError("terminal unavailable before execution");
    };
    const recover = pluginToolWithExecute("recover_task", "Recover the task", async () =>
      jsonResult({ recovered: true }),
    );

    const { agent, providerContexts } = await runCodeModeAgent({
      hiddenTools: [terminal, recover],
      programs: ["return await terminal({});", "return await recover_task({});"],
    });

    expect(providerContexts).toHaveLength(3);
    expect(providerContexts[1]?.messages).toContainEqual(
      expect.objectContaining({
        role: "toolResult",
        toolName: "exec",
        isError: true,
        details: expect.objectContaining({
          status: "failed",
          failurePhase: "bridge",
          bridgeDispatchStarted: true,
          error: expect.stringContaining("terminal unavailable"),
        }),
      }),
    );
    expect(terminal.execute).not.toHaveBeenCalled();
    expect(recover.execute).toHaveBeenCalledOnce();
    expect(agent.state.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "recovered" }],
    });
  });

  it("returns a schema-invalid nested call for ordinary recovery before execution", async () => {
    const terminal = pluginToolWithExecute("terminal", "Open a terminal", async () =>
      jsonResult({ unexpected: true }),
    );
    const recover = pluginToolWithExecute("recover_task", "Recover the task", async () =>
      jsonResult({ recovered: true }),
    );

    const { agent, providerContexts } = await runCodeModeAgent({
      hiddenTools: [terminal, recover],
      programs: [
        "return await terminal({ value: 42 });",
        'return await recover_task({ value: "continue" });',
      ],
    });

    expect(providerContexts).toHaveLength(3);
    expect(providerContexts[1]?.messages).toContainEqual(
      expect.objectContaining({
        role: "toolResult",
        toolName: "exec",
        isError: true,
        details: expect.objectContaining({
          status: "failed",
          failurePhase: "bridge",
          bridgeDispatchStarted: true,
          error: expect.stringContaining("value"),
        }),
      }),
    );
    expect(terminal.execute).not.toHaveBeenCalled();
    expect(recover.execute).toHaveBeenCalledOnce();
    expect(agent.state.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "recovered" }],
    });
  });

  it("returns an exact replay-safe post-dispatch failure for ordinary recovery", async () => {
    const readOnly = fakeTool("sessions_history", "Read session history");
    readOnly.execute = vi.fn(async () => {
      throw new ToolInputError("read constraint rejected after dispatch");
    }) as AnyAgentTool["execute"];
    const recover = pluginToolWithExecute("recover_task", "Recover the task", async () =>
      jsonResult({ recovered: true }),
    );

    const { providerContexts } = await runCodeModeAgent({
      hiddenTools: [readOnly, recover],
      programs: ["return await sessions_history({});", "return await recover_task({});"],
    });

    expect(providerContexts).toHaveLength(3);
    expect(readOnly.execute).toHaveBeenCalledOnce();
    expect(recover.execute).toHaveBeenCalledOnce();
  });

  it("continues after a failed read through a mixed-action tool", async () => {
    const mixedAction = fakeTool("message", "Read or mutate messages");
    mixedAction.parameters = {
      type: "object",
      properties: { action: { type: "string" } },
      required: ["action"],
    };
    mixedAction.execute = vi.fn(async () => {
      throw new Error("read-only operation failed after dispatch");
    }) as AnyAgentTool["execute"];
    const recover = pluginToolWithExecute("recover_task", "Recover the task", async () =>
      jsonResult({ recovered: true }),
    );

    const { providerContexts } = await runCodeModeAgent({
      hiddenTools: [mixedAction, recover],
      harness: createSubscribedCodeModeHarness({ name: "input-aware-read-receipt" }),
      programs: ['return await message({ action: "read" });', "return await recover_task({});"],
    });

    expect(providerContexts).toHaveLength(3);
    expect(mixedAction.execute).toHaveBeenCalledOnce();
    expect(recover.execute).toHaveBeenCalledOnce();
  });

  it("continues after a namespace metadata call and a guest error", async () => {
    const listResources = mcpTool({
      name: "mcp_files_resources_list",
      serverName: "files",
      toolName: "resources/list",
      operation: "resources_list",
    });
    const recover = pluginToolWithExecute("recover_task", "Recover the task", async () =>
      jsonResult({ recovered: true }),
    );

    const { providerContexts } = await runCodeModeAgent({
      hiddenTools: [listResources, recover],
      programs: ["json(await MCP.$api()); return missingFn();", "return await recover_task({});"],
    });

    expect(providerContexts).toHaveLength(3);
    expect(listResources.execute).not.toHaveBeenCalled();
    expect(recover.execute).toHaveBeenCalledOnce();
  });

  it("continues after a replay-safe plugin failure", async () => {
    const readOnly = pluginToolWithExecute("plugin_read", "Read plugin state", async () => {
      throw new Error("plugin read failed after dispatch");
    });
    setPluginToolMeta(readOnly, {
      pluginId: "replay-safe-read-test",
      optional: false,
      replaySafe: true,
    });
    const recover = pluginToolWithExecute("recover_task", "Recover the task", async () =>
      jsonResult({ recovered: true }),
    );

    const { providerContexts } = await runCodeModeAgent({
      hiddenTools: [readOnly, recover],
      harness: createSubscribedCodeModeHarness({ name: "plugin-read-receipt" }),
      programs: ["return await plugin_read({});", "return await recover_task({});"],
    });

    expect(providerContexts).toHaveLength(3);
    expect(readOnly.execute).toHaveBeenCalledOnce();
    expect(recover.execute).toHaveBeenCalledOnce();
  });

  it("continues after a side-effecting plugin failure without replaying it", async () => {
    const appliedChanges: string[] = [];
    const mutation = pluginToolWithExecute("plugin_mutation", "Mutate plugin state", async () => {
      appliedChanges.push("plugin state changed");
      throw new ToolInputError("plugin rejected input after mutation");
    });
    setPluginToolMeta(mutation, {
      pluginId: "side-effecting-replay-safe-test",
      optional: false,
      replaySafe: true,
      sideEffecting: true,
    });
    const recover = pluginToolWithExecute("recover_task", "Recover the task", async () =>
      jsonResult({ recovered: true }),
    );

    const { providerContexts } = await runCodeModeAgent({
      hiddenTools: [mutation, recover],
      programs: ["return await plugin_mutation({});", "return await recover_task({});"],
    });

    expect(providerContexts).toHaveLength(3);
    expect(mutation.execute).toHaveBeenCalledOnce();
    expect(recover.execute).toHaveBeenCalledOnce();
    expect(appliedChanges).toEqual(["plugin state changed"]);
  });

  it("lets the model correct successive JavaScript syntax and runtime errors", async () => {
    const complete = pluginToolWithExecute("complete_task", "Complete the task", async () =>
      jsonResult({ completed: true }),
    );

    const { agent, providerContexts } = await runCodeModeAgent({
      hiddenTools: [complete],
      programs: ["const value = ;", "return missingFn();", "return await complete_task({});"],
    });

    expect(providerContexts).toHaveLength(4);
    for (const [index, errorName] of ["SyntaxError", "ReferenceError"].entries()) {
      expect(providerContexts[index + 1]?.messages).toContainEqual(
        expect.objectContaining({
          role: "toolResult",
          toolName: "exec",
          isError: true,
          details: expect.objectContaining({
            status: "failed",
            error: expect.stringContaining(errorName),
          }),
        }),
      );
    }
    expect(complete.execute).toHaveBeenCalledOnce();
    expect(agent.state.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "recovered" }],
    });
  });

  it("continues after an earlier side effect and a later tool failure", async () => {
    const recordEffect = pluginToolWithExecute("record_effect", "Record an effect", async () =>
      jsonResult({ recorded: true }),
    );
    const terminal = pluginToolWithExecute("terminal", "Open a terminal", async () => {
      throw new Error("terminal unavailable");
    });
    const write = pluginToolWithExecute("write", "Repeat a mutation", async () =>
      jsonResult({ repeated: true }),
    );

    const { providerContexts } = await runCodeModeAgent({
      hiddenTools: [recordEffect, terminal, write],
      programs: ["await record_effect({}); return await terminal({});", "return await write({});"],
    });

    expect(providerContexts).toHaveLength(3);
    expect(recordEffect.execute).toHaveBeenCalledOnce();
    expect(terminal.execute).toHaveBeenCalledOnce();
    expect(write.execute).toHaveBeenCalledOnce();
  });

  it("continues after a partially applied mutation reports an input error", async () => {
    const appliedChanges: string[] = [];
    const applyPatch = pluginToolWithExecute("apply_patch", "Apply a patch", async () => {
      appliedChanges.push("first hunk applied");
      throw new ToolInputError("second hunk input is ambiguous after applying the first");
    });
    const write = pluginToolWithExecute("write", "Repeat a mutation", async () =>
      jsonResult({ repeated: true }),
    );
    const send = pluginToolWithExecute("message", "Send a message", async () =>
      jsonResult({ delivered: true }),
    );
    const shell = pluginToolWithExecute("shell_command", "Run a shell command", async () =>
      jsonResult({ executed: true }),
    );

    const { providerContexts } = await runCodeModeAgent({
      hiddenTools: [applyPatch, write, send, shell],
      programs: ["return await apply_patch({});", "return await write({});"],
    });

    expect(providerContexts).toHaveLength(3);
    expect(applyPatch.execute).toHaveBeenCalledOnce();
    expect(write.execute).toHaveBeenCalledOnce();
    expect(send.execute).not.toHaveBeenCalled();
    expect(shell.execute).not.toHaveBeenCalled();
    expect(appliedChanges).toEqual(["first hunk applied"]);
  });

  it("preserves an explicitly terminal nested action when later JavaScript fails", async () => {
    const terminal = pluginToolWithExecute("terminal_action", "Finish the task", async () => ({
      ...jsonResult({ delivered: true }),
      terminate: true,
    }));
    const repeat = pluginToolWithExecute("repeat_action", "Repeat the action", async () =>
      jsonResult({ repeated: true }),
    );

    const { agent, providerContexts } = await runCodeModeAgent({
      hiddenTools: [terminal, repeat],
      programs: [
        'await terminal_action({}); throw new Error("after terminal action");',
        "return await repeat_action({});",
      ],
    });

    expect(providerContexts).toHaveLength(1);
    expect(terminal.execute).toHaveBeenCalledOnce();
    expect(repeat.execute).not.toHaveBeenCalled();
    expect(agent.state.messages.at(-1)).toMatchObject({
      role: "toolResult",
      isError: true,
      details: {
        status: "failed",
        error: expect.stringContaining("after terminal action"),
      },
    });
  });
});
