import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
} from "openclaw/plugin-sdk/llm";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readNestedToolActivity } from "../../../sessions/nested-tool-activity.js";
import {
  fakeTool,
  pluginToolWithExecute,
  resetCodeModeTestState,
} from "../../code-mode.test-support.js";
import { Agent, type AgentTool } from "../../runtime/index.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { isToolResultError } from "../../tool-result-error.js";
import { jsonResult } from "../../tools/common.js";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  createContextEngineBootstrapAndAssemble,
  createDefaultEmbeddedSession,
  getHoisted,
  preloadRunEmbeddedAttemptForTests,
  resetEmbeddedAttemptHarness,
} from "./attempt-spawn-workspace.test-support.js";

const hoisted = getHoisted();
const tempPaths: string[] = [];
const model: Model = {
  id: "test-model",
  name: "Test Model",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8_192,
  maxTokens: 8_192,
};

function streamAssistant(content: AssistantMessage["content"]) {
  const message: AssistantMessage = {
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
}

describe("runEmbeddedAttempt Code Mode recovery boundary", () => {
  beforeAll(async () => {
    await preloadRunEmbeddedAttemptForTests();
  });

  beforeEach(() => {
    resetEmbeddedAttemptHarness();
  });

  afterEach(async () => {
    resetCodeModeTestState();
    await cleanupTempPaths(tempPaths);
  });

  it("keeps the normal Code Mode surface through failure, inspection, and multiple edits", async () => {
    const sessionManager = SessionManager.inMemory();
    const appliedChanges: string[] = [];
    const read = fakeTool("read", "Inspect current file contents");
    const shell = fakeTool("shell_command", "Inspect source through a shell");
    const applyPatch = pluginToolWithExecute("apply_patch", "Apply a patch", async () => {
      appliedChanges.push("first hunk applied");
      throw new Error("second hunk is ambiguous");
    });
    const write = pluginToolWithExecute("write", "Write a file", async (_id, input) => {
      appliedChanges.push((input as { value: string }).value);
      return jsonResult({ written: true });
    });
    hoisted.createOpenClawCodingToolsMock.mockReturnValue([read, shell, applyPatch, write]);

    const programs = [
      "return await apply_patch({});",
      "return await shell_command({});",
      'return await write({ value: "second hunk applied" });',
      'return await write({ value: "third hunk applied" });',
      "return await read({});",
    ];
    const providerContexts: Context[] = [];
    const createSession = () => {
      const session = createDefaultEmbeddedSession();
      const options = hoisted.createAgentSessionMock.mock.calls.at(-1)?.[0] as {
        customTools: AgentTool[];
      };
      const allTools = options.customTools;
      const agent = new Agent({
        initialState: { model, tools: allTools },
        afterToolCall: async ({ result, isError }) => ({
          isError: isError || isToolResultError(result),
        }),
        streamFn: (_activeModel, context) => {
          const turn = providerContexts.length;
          providerContexts.push(context);
          const code = programs[turn];
          return streamAssistant(
            code === undefined
              ? [{ type: "text", text: "all changes verified" }]
              : [{ type: "toolCall", id: `program-${turn}`, name: "exec", arguments: { code } }],
          );
        },
      });
      session.agent = agent as typeof session.agent;
      Object.defineProperty(session, "messages", {
        get: () => agent.state.messages,
        set: (messages) => {
          agent.state.messages = messages;
        },
      });
      session.setActiveToolsByName = (toolNames) => {
        agent.state.tools = allTools.filter((tool) => toolNames.includes(tool.name));
      };
      session.getActiveToolNames = () => agent.state.tools.map((tool) => tool.name);
      session.prompt = async (prompt, promptOptions) => {
        promptOptions?.preflightResult?.(true);
        await agent.prompt(prompt);
      };
      return session;
    };

    const result = await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      createSession,
      sessionKey: "agent:main:main",
      tempPaths,
      attemptOverrides: {
        config: { tools: { codeMode: true } },
        sessionManager,
        disableMessageTool: false,
        disableTools: false,
        model,
      },
    });

    expect(providerContexts).toHaveLength(6);
    for (const context of providerContexts) {
      expect(context.tools?.map((tool) => tool.name)).toContain("exec");
    }
    expect(providerContexts[1]?.messages).toContainEqual(
      expect.objectContaining({
        role: "toolResult",
        isError: true,
        content: [
          expect.objectContaining({ text: expect.stringContaining("second hunk is ambiguous") }),
        ],
      }),
    );
    expect(appliedChanges).toEqual([
      "first hunk applied",
      "second hunk applied",
      "third hunk applied",
    ]);
    expect(applyPatch.execute).toHaveBeenCalledOnce();
    expect(shell.execute).toHaveBeenCalledOnce();
    expect(write.execute).toHaveBeenCalledTimes(2);
    expect(read.execute).toHaveBeenCalledOnce();
    expect(result.messagesSnapshot.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "all changes verified" }],
    });
    const activities = sessionManager.getEntries().flatMap((entry) => {
      const activity = entry.type === "message" && readNestedToolActivity(entry.message);
      return activity ? [activity.details] : [];
    });
    expect(activities).toMatchObject([
      { toolName: "apply_patch", isError: true },
      { toolName: "shell_command", isError: false },
      { toolName: "write", isError: false },
      { toolName: "write", isError: false },
      { toolName: "read", isError: false },
    ]);
    expect(activities.map((activity) => activity.parentToolCallId)).toEqual(
      result.messagesSnapshot.flatMap((message) =>
        message.role === "assistant"
          ? message.content.flatMap((entry) => (entry.type === "toolCall" ? [entry.id] : []))
          : [],
      ),
    );
  });
});
