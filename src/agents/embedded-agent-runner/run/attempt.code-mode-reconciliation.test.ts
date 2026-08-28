import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
} from "openclaw/plugin-sdk/llm";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  fakeTool,
  pluginToolWithExecute,
  resetCodeModeTestState,
} from "../../code-mode.test-support.js";
import { Agent, type AgentTool } from "../../runtime/index.js";
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
import { activateCodeModeReconciliation } from "./code-mode-reconciliation.js";
import { createEmbeddedRunTerminalRetryState } from "./terminal-retry-state.js";

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

describe("runEmbeddedAttempt Code Mode reconciliation boundary", () => {
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

  it("settles a real partial bridge mutation before exposing only core read", async () => {
    const appliedChanges: string[] = [];
    const read = fakeTool("read", "Inspect current file contents");
    const applyPatch = pluginToolWithExecute("apply_patch", "Apply a patch", async () => {
      appliedChanges.push("first hunk applied");
      throw new Error("second hunk is ambiguous");
    });
    const write = pluginToolWithExecute("write", "Write a file", async () => jsonResult({}));
    const message = pluginToolWithExecute("message", "Send a message", async () => jsonResult({}));
    const shell = pluginToolWithExecute("shell_command", "Run a shell", async () => jsonResult({}));
    hoisted.createOpenClawCodingToolsMock.mockReturnValue([
      read,
      applyPatch,
      write,
      message,
      shell,
    ]);

    const providerContexts: Context[] = [];
    let reconciliationAttempt = false;
    const createSession = () => {
      const session = createDefaultEmbeddedSession();
      const options = hoisted.createAgentSessionMock.mock.calls.at(-1)?.[0] as {
        customTools: AgentTool[];
      };
      const allTools = options.customTools;
      let assistantTurn = 0;
      const agent = new Agent({
        initialState: { model, tools: allTools },
        streamFn: (_activeModel, context) => {
          providerContexts.push(context);
          if (assistantTurn++ > 0) {
            return streamAssistant([{ type: "text", text: "first hunk applied" }]);
          }
          return streamAssistant([
            reconciliationAttempt
              ? { type: "toolCall", id: "observe", name: "read", arguments: { value: "file" } }
              : {
                  type: "toolCall",
                  id: "mutate",
                  name: "exec",
                  arguments: { code: "return await apply_patch({});" },
                },
          ]);
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

    const firstAttempt = await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      createSession,
      sessionKey: "agent:main:main",
      tempPaths,
      attemptOverrides: {
        config: { tools: { codeMode: true } },
        disableMessageTool: false,
        disableTools: false,
        model,
      },
    });

    expect(firstAttempt.codeModeReconciliationCandidate).toBe(true);
    expect(appliedChanges).toEqual(["first hunk applied"]);
    expect(applyPatch.execute).toHaveBeenCalledOnce();

    const retryState = createEmbeddedRunTerminalRetryState();
    let recoveryPrompt: string | undefined;
    expect(
      activateCodeModeReconciliation({
        attempt: firstAttempt,
        hostOwnsToolSurface: true,
        retryState,
        activateInternalPrompt: (prompt) => {
          recoveryPrompt = prompt;
        },
      }),
    ).toBe(true);
    expect(recoveryPrompt).toContain("may have partially applied");

    reconciliationAttempt = true;
    await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      createSession,
      sessionKey: "agent:main:main",
      tempPaths,
      attemptOverrides: {
        config: { tools: { codeMode: true } },
        disableMessageTool: false,
        disableTools: false,
        forceCodeModeReconciliationTools: retryState.forceCodeModeReconciliationTools,
        model,
        prompt: recoveryPrompt,
      },
    });

    expect(providerContexts).toHaveLength(3);
    expect(providerContexts[1]?.tools?.map((tool) => tool.name)).toEqual(["read"]);
    expect(read.execute).toHaveBeenCalledOnce();
    expect(applyPatch.execute).toHaveBeenCalledOnce();
    expect(write.execute).not.toHaveBeenCalled();
    expect(message.execute).not.toHaveBeenCalled();
    expect(shell.execute).not.toHaveBeenCalled();
    expect(appliedChanges).toEqual(["first hunk applied"]);
  });
});
