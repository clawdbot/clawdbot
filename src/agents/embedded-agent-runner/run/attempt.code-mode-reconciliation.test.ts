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
  mcpTool,
  pluginToolWithExecute,
  resetCodeModeTestState,
} from "../../code-mode.test-support.js";
import { Agent, type AgentTool } from "../../runtime/index.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { createToolSearchTools } from "../../tool-search.js";
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
import { advanceCodeModeRecovery } from "./code-mode-reconciliation.js";
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

  it("inspects a partial mutation, then resumes through Tool Search behind a replay fence", async () => {
    const sessionManager = SessionManager.inMemory();
    const appliedChanges: string[] = [];
    const read = fakeTool("read", "Inspect current file contents");
    const computer = fakeTool("computer", "Observe the computer");
    computer.catalogMode = "direct-only";
    computer.parameters = { type: "object", properties: { action: { type: "string" } } };
    const applyPatch = pluginToolWithExecute("apply_patch", "Apply a patch", async () => {
      appliedChanges.push("first hunk applied");
      throw new Error("second hunk is ambiguous");
    });
    const write = pluginToolWithExecute("write", "Write a file", async () => {
      throw new Error("recovery write failed");
    });
    const message = pluginToolWithExecute("message", "Send a message", async () => jsonResult({}));
    const shell = pluginToolWithExecute("shell_command", "Run a shell", async () => jsonResult({}));
    const remoteMutation = mcpTool({
      name: "remote_mutation",
      serverName: "remote",
      toolName: "mutate",
    });
    const coreTools = [read, computer, applyPatch, write, message, shell, remoteMutation];
    hoisted.createOpenClawCodingToolsMock.mockImplementation((rawOptions) => {
      const options = rawOptions as {
        includeToolSearchControls?: boolean;
        config?: Parameters<typeof createToolSearchTools>[0]["config"];
        toolSearchCatalogRef?: Parameters<typeof createToolSearchTools>[0]["catalogRef"];
        toolSearchCatalogExecutor?: Parameters<typeof createToolSearchTools>[0]["executeTool"];
      };
      return [
        ...coreTools,
        ...(options.includeToolSearchControls
          ? createToolSearchTools({
              config: options.config,
              runtimeConfig: options.config,
              agentId: "main",
              sessionKey: "agent:main:main",
              sessionId: "session-code-mode-recovery",
              runId: "run-code-mode-recovery",
              catalogRef: options.toolSearchCatalogRef,
              executeTool: options.toolSearchCatalogExecutor,
            })
          : []),
      ];
    });

    const providerContexts: Context[] = [];
    const retryState = createEmbeddedRunTerminalRetryState();
    let phase: "mutation" | "inspection" | "resume" = "mutation";
    const baseSubscribe = hoisted.subscribeEmbeddedAgentSessionMock.getMockImplementation();
    if (!baseSubscribe) {
      throw new Error("Missing embedded subscription test implementation");
    }
    hoisted.subscribeEmbeddedAgentSessionMock.mockImplementation((params) => {
      const subscription = baseSubscribe(params);
      if (phase === "inspection") {
        subscription.toolMetas.push(
          { toolName: "read", isError: false },
          { toolName: "recovery_resume", isError: false, terminate: true },
        );
      }
      return subscription;
    });
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
          const turn = assistantTurn++;
          if (phase === "inspection") {
            if (turn === 0) {
              return streamAssistant([
                { type: "toolCall", id: "observe", name: "read", arguments: { value: "file" } },
              ]);
            }
            if (turn === 1) {
              return streamAssistant([
                { type: "toolCall", id: "resume", name: "recovery_resume", arguments: {} },
              ]);
            }
          }
          if (phase === "resume") {
            if (turn === 0 || turn === 7) {
              return streamAssistant([
                {
                  type: "toolCall",
                  id: `computer-observe-${turn}`,
                  name: "computer",
                  arguments: { action: "list_windows" },
                },
              ]);
            }
            if (turn === 1) {
              return streamAssistant([
                {
                  type: "toolCall",
                  id: "search-patch",
                  name: "tool_search",
                  arguments: { query: "apply_patch", limit: 1 },
                },
              ]);
            }
            if (turn === 2) {
              return streamAssistant([
                {
                  type: "toolCall",
                  id: "describe-patch",
                  name: "tool_describe",
                  arguments: { id: "apply_patch" },
                },
              ]);
            }
            if (turn === 3) {
              return streamAssistant([
                {
                  type: "toolCall",
                  id: "replay",
                  name: "tool_call",
                  arguments: { id: "apply_patch", args: {} },
                },
              ]);
            }
            if (turn === 4) {
              return streamAssistant([
                {
                  type: "toolCall",
                  id: "continue",
                  name: "tool_call",
                  arguments: { id: "write", args: { value: "remaining work" } },
                },
              ]);
            }
            if (turn === 5) {
              return streamAssistant([
                {
                  type: "toolCall",
                  id: "blind-later-work",
                  name: "tool_call",
                  arguments: { id: "remote_mutation", args: { value: "later work" } },
                },
              ]);
            }
            if (turn === 6) {
              return streamAssistant([
                {
                  type: "toolCall",
                  id: "verify",
                  name: "tool_call",
                  arguments: { id: "read", args: { value: "file" } },
                },
              ]);
            }
            return streamAssistant([{ type: "text", text: "recovery completed" }]);
          }
          if (turn === 0) {
            return streamAssistant([
              {
                type: "toolCall",
                id: "mutate",
                name: "exec",
                arguments: { code: "return await apply_patch({});" },
              },
            ]);
          }
          return streamAssistant([{ type: "text", text: "first hunk applied" }]);
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

    const runAttempt = (overrides = {}) =>
      createContextEngineAttemptRunner({
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
          ...overrides,
        },
      });

    const firstAttempt = await runAttempt();
    expect(firstAttempt.codeModeRecoveryCandidate?.blockedActionKeys).toHaveLength(1);
    expect(appliedChanges).toEqual(["first hunk applied"]);
    expect(applyPatch.execute).toHaveBeenCalledOnce();
    expect(remoteMutation.execute).not.toHaveBeenCalled();
    const activities = sessionManager.getEntries().flatMap((entry) => {
      const activity = entry.type === "message" && readNestedToolActivity(entry.message);
      return activity ? [activity.details] : [];
    });
    expect(activities).toMatchObject([
      {
        parentToolCallId: "mutate",
        toolName: "apply_patch",
        isError: true,
      },
    ]);

    let inspectionPrompt = "";
    expect(
      advanceCodeModeRecovery({
        attempt: firstAttempt,
        hostOwnsToolSurface: true,
        retryState,
        activateInternalPrompt: (prompt) => {
          inspectionPrompt = prompt;
        },
      }),
    ).toBe(true);

    phase = "inspection";
    const inspectionAttempt = await runAttempt({
      codeModeRecovery: retryState.codeModeRecovery,
      prompt: inspectionPrompt,
    });
    expect(providerContexts[2]?.tools?.map((tool) => tool.name)).toEqual([
      "read",
      "recovery_resume",
    ]);
    expect(read.execute).toHaveBeenCalledOnce();
    expect(write.execute).not.toHaveBeenCalled();
    expect(retryState.codeModeRecovery).toMatchObject({
      kind: "inspect",
      phase: "ready",
    });
    expect(inspectionAttempt.toolMetas).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ toolName: "read", isError: false }),
        expect.objectContaining({
          toolName: "recovery_resume",
          isError: false,
          terminate: true,
        }),
      ]),
    );

    let resumePrompt = "";
    expect(
      advanceCodeModeRecovery({
        attempt: inspectionAttempt,
        hostOwnsToolSurface: true,
        retryState,
        activateInternalPrompt: (prompt) => {
          resumePrompt = prompt;
        },
      }),
    ).toBe(true);
    expect(retryState.codeModeRecovery.kind).toBe("resume");

    phase = "resume";
    await runAttempt({
      codeModeOverride: false,
      codeModeRecovery: retryState.codeModeRecovery,
      disableMessageTool: true,
      config: {
        tools: {
          codeMode: false,
          toolSearch: { enabled: true, mode: "tools" },
        },
      },
      prompt: resumePrompt,
    });
    const resumeTools = providerContexts.at(-1)?.tools?.map((tool) => tool.name) ?? [];
    expect(resumeTools).toEqual(
      expect.arrayContaining(["computer", "tool_search", "tool_describe", "tool_call"]),
    );
    expect(resumeTools).not.toContain("write");
    expect(resumeTools).not.toContain("apply_patch");
    expect(resumeTools).not.toContain("exec");
    expect(write.execute).toHaveBeenCalledOnce();
    expect(computer.execute).toHaveBeenCalledTimes(2);
    expect(applyPatch.execute).toHaveBeenCalledOnce();
    expect(read.execute).toHaveBeenCalledTimes(2);
    expect(message.execute).not.toHaveBeenCalled();
    expect(shell.execute).not.toHaveBeenCalled();
  });
});
