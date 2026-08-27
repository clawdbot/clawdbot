import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
} from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setPluginToolMeta } from "../plugins/tools.js";
import type { CodeModeSkill } from "./code-mode-skills.js";
import { applyCodeModeCatalog } from "./code-mode.js";
import {
  createCodeModeHarness,
  fakeTool,
  pluginToolWithExecute,
  resetCodeModeTestState,
} from "./code-mode.test-support.js";
import { installCodeModeOutcomeHook } from "./embedded-agent-runner/run/code-mode-outcome.js";
import { Agent } from "./runtime/index.js";
import { isToolResultError } from "./tool-result-error.js";
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
  programs: string[];
  hiddenTools: AnyAgentTool[];
  codeModeSkills?: CodeModeSkill[];
}) {
  const { config, catalogRef, tools } = createCodeModeHarness({
    codeModeSkills: params.codeModeSkills,
  });
  applyCodeModeCatalog({
    tools: [...tools, ...params.hiddenTools],
    config,
    sessionId: "session-code-mode",
    sessionKey: "agent:main:main",
    runId: "run-code-mode",
    catalogRef,
    codeModeSkills: params.codeModeSkills,
  });
  const providerContexts: Context[] = [];
  let reconciliationCandidates = 0;
  const agent = new Agent({
    initialState: { model, tools },
    afterToolCall: async ({ result, isError }) => ({
      isError: isError || isToolResultError(result),
    }),
    streamFn: (_activeModel, context) => {
      providerContexts.push(context);
      const index = providerContexts.length - 1;
      const code = params.programs[index];
      const message = createAssistant(
        code === undefined
          ? [{ type: "text", text: "recovered" }]
          : [{ type: "toolCall", id: `code-call-${index}`, name: "exec", arguments: { code } }],
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
  installCodeModeOutcomeHook({
    agent,
    onReconciliationCandidate: () => {
      reconciliationCandidates += 1;
    },
  });
  await agent.prompt("finish the task despite tool errors");

  return { agent, providerContexts, reconciliationCandidates };
}

describe("Code Mode agent-loop error recovery", () => {
  afterEach(() => resetCodeModeTestState());

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
      const { agent, providerContexts, reconciliationCandidates } = await runCodeModeAgent({
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
      expect(reconciliationCandidates).toBe(0);
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

    const { agent, providerContexts, reconciliationCandidates } = await runCodeModeAgent({
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
    expect(reconciliationCandidates).toBe(0);
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

    const { agent, providerContexts, reconciliationCandidates } = await runCodeModeAgent({
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
    expect(reconciliationCandidates).toBe(0);
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

    const { providerContexts, reconciliationCandidates } = await runCodeModeAgent({
      hiddenTools: [readOnly, recover],
      programs: ["return await sessions_history({});", "return await recover_task({});"],
    });

    expect(providerContexts).toHaveLength(3);
    expect(readOnly.execute).toHaveBeenCalledOnce();
    expect(recover.execute).toHaveBeenCalledOnce();
    expect(reconciliationCandidates).toBe(0);
  });

  it("keeps replay-safe side-effecting plugin failures in restricted reconciliation", async () => {
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

    const { providerContexts, reconciliationCandidates } = await runCodeModeAgent({
      hiddenTools: [mutation, recover],
      programs: ["return await plugin_mutation({});", "return await recover_task({});"],
    });

    expect(providerContexts).toHaveLength(1);
    expect(mutation.execute).toHaveBeenCalledOnce();
    expect(recover.execute).not.toHaveBeenCalled();
    expect(reconciliationCandidates).toBe(1);
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

  it("blocks another action after an earlier side effect and a later tool failure", async () => {
    const recordEffect = pluginToolWithExecute("record_effect", "Record an effect", async () =>
      jsonResult({ recorded: true }),
    );
    const terminal = pluginToolWithExecute("terminal", "Open a terminal", async () => {
      throw new Error("terminal unavailable");
    });
    const write = pluginToolWithExecute("write", "Repeat a mutation", async () =>
      jsonResult({ repeated: true }),
    );

    const { providerContexts, reconciliationCandidates } = await runCodeModeAgent({
      hiddenTools: [recordEffect, terminal, write],
      programs: ["await record_effect({}); return await terminal({});", "return await write({});"],
    });

    expect(providerContexts).toHaveLength(1);
    expect(recordEffect.execute).toHaveBeenCalledOnce();
    expect(terminal.execute).toHaveBeenCalledOnce();
    expect(write.execute).not.toHaveBeenCalled();
    expect(reconciliationCandidates).toBe(1);
  });

  it("routes a partially applied mutation with an input error to restricted reconciliation", async () => {
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

    const { providerContexts, reconciliationCandidates } = await runCodeModeAgent({
      hiddenTools: [applyPatch, write, send, shell],
      programs: ["return await apply_patch({});", "return await write({});"],
    });

    expect(providerContexts).toHaveLength(1);
    expect(applyPatch.execute).toHaveBeenCalledOnce();
    expect(write.execute).not.toHaveBeenCalled();
    expect(send.execute).not.toHaveBeenCalled();
    expect(shell.execute).not.toHaveBeenCalled();
    expect(reconciliationCandidates).toBe(1);
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
