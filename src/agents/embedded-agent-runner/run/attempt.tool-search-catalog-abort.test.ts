import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
} from "openclaw/plugin-sdk/llm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  onInternalDiagnosticEvent,
  type DiagnosticEventPayload,
} from "../../../infra/diagnostic-events.js";
import { wrapToolWithBeforeToolCallHook } from "../../agent-tools.before-tool-call.js";
import type { createOpenClawCodingTools } from "../../agent-tools.js";
import { Agent, type AgentTool } from "../../runtime/index.js";
import { getInternalToolExecutionPreparer } from "../../runtime/internal-hooks.js";
import type { ToolSearchCatalogRef } from "../../tool-search.js";
import { createAgentsWaitTool } from "../../tools/agents-wait-tool.js";
import { createSessionsSpawnTool } from "../../tools/sessions-spawn-tool.js";
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

function catalogProbeTools() {
  return [
    {
      name: "tool_search",
      description: "tool-search control surface",
      parameters: { type: "object", properties: {} },
      execute: async () => "",
    },
    {
      name: "cataloged_probe_tool",
      description: "deferred behind the catalog",
      parameters: { type: "object", properties: {} },
      execute: async () => "",
    },
  ];
}

function requireAttemptCatalogRef(): ToolSearchCatalogRef {
  const options = hoisted.createOpenClawCodingToolsMock.mock.calls.at(-1)?.[0] as
    | { toolSearchCatalogRef?: ToolSearchCatalogRef }
    | undefined;
  if (!options?.toolSearchCatalogRef) {
    throw new Error("Expected the embedded attempt to own its Tool Search catalog");
  }
  return options.toolSearchCatalogRef;
}

describe("runEmbeddedAttempt tool-search catalog cleanup", () => {
  beforeAll(async () => {
    await preloadRunEmbeddedAttemptForTests();
  });

  beforeEach(() => {
    resetEmbeddedAttemptHarness();
  });

  afterEach(async () => {
    await cleanupTempPaths(tempPaths);
    tempPaths.length = 0;
  });

  it.each([
    { mode: "direct spawn", toolName: "sessions_spawn", code: undefined },
    { mode: "direct wait", toolName: "agents_wait", code: undefined },
    {
      mode: "raw catalog spawn",
      toolName: "sessions_spawn",
      code: 'return await sessions_spawn({ task: "inspect", collect: true });',
    },
    {
      mode: "raw catalog wait",
      toolName: "agents_wait",
      code: 'return await agents_wait({ ids: ["child"] });',
    },
    {
      mode: "joined Code Mode",
      toolName: "sessions_spawn",
      code: 'return await agents.run("inspect");',
    },
  ])(
    "does not enter the original preparer or action through denied $mode",
    async ({ toolName, code }) => {
      const execute = vi.fn(async () => ({ content: [], details: {} }));
      const prepare = vi.fn(async (args: unknown) => args);
      const native =
        toolName === "sessions_spawn"
          ? createSessionsSpawnTool({ agentSessionKey: "agent:main:main" })
          : createAgentsWaitTool({ agentSessionKey: "agent:main:main" });
      native.execute = execute;
      native.prepareBeforeToolCallParams = prepare;
      const source = wrapToolWithBeforeToolCallHook(native);
      expect(getInternalToolExecutionPreparer(source)).toBeDefined();
      hoisted.createOpenClawCodingToolsMock.mockReturnValue([source]);
      const observed: AssistantMessage["content"][] = [];
      const outcomes: Array<{ toolName: string; isError: boolean }> = [];
      await createContextEngineAttemptRunner({
        contextEngine: createContextEngineBootstrapAndAssemble(),
        sessionKey: "agent:main:main",
        tempPaths,
        createSession: () => {
          const session = createDefaultEmbeddedSession();
          // SAFETY: The runner supplied the model and finalized tools to this session factory.
          const options = hoisted.createAgentSessionMock.mock.calls.at(-1)?.[0] as {
            model: Model;
            customTools: AgentTool[];
          };
          const allTools = options.customTools;
          expect(allTools.map((tool) => tool.name)).toContain(code ? "exec" : toolName);
          let turn = 0;
          const agent = new Agent({
            initialState: { model: options.model, tools: allTools },
            streamFn: () => {
              const content: AssistantMessage["content"] =
                turn++ === 0
                  ? [
                      {
                        type: "toolCall",
                        id: "denied",
                        name: code ? "exec" : toolName,
                        arguments: code
                          ? { code }
                          : toolName === "sessions_spawn"
                            ? { task: "inspect" }
                            : { ids: ["child"] },
                      },
                    ]
                  : [{ type: "text", text: "Denied as expected." }];
              observed.push(content);
              const message: AssistantMessage = {
                role: "assistant",
                content,
                api: options.model.api,
                provider: options.model.provider,
                model: options.model.id,
                usage: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 0,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                stopReason: turn === 1 ? "toolUse" : "stop",
                timestamp: Date.now(),
              };
              const stream = createAssistantMessageEventStream();
              queueMicrotask(() => {
                stream.push({ type: "done", reason: turn === 1 ? "toolUse" : "stop", message });
                stream.end();
              });
              return stream;
            },
          });
          agent.subscribe((event) => {
            if (event.type === "tool_execution_end") {
              outcomes.push(event);
            }
          });
          // SAFETY: This session fixture delegates its agent operations to the real loop below.
          session.agent = agent as typeof session.agent;
          Object.defineProperty(session, "messages", {
            get: () => agent.state.messages,
            set: (messages) => {
              agent.state.messages = messages;
            },
          });
          session.setActiveToolsByName = (names) => {
            agent.state.tools = allTools.filter((tool) => names.includes(tool.name));
          };
          session.getActiveToolNames = () => agent.state.tools.map((tool) => tool.name);
          session.prompt = async (prompt, opts) => {
            opts?.preflightResult?.(true);
            await agent.prompt(prompt);
          };
          return session;
        },
        attemptOverrides: {
          disableTools: false,
          toolExecutionAllow: ["read"],
          config: { tools: { codeMode: Boolean(code), toolSearch: false } },
        },
      });
      expect(observed.length).toBeGreaterThanOrEqual(1);
      expect(outcomes).toContainEqual(
        expect.objectContaining({ toolName: code ? "exec" : toolName, isError: true }),
      );
      expect(prepare).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      mode: "code-mode",
      tools: { codeMode: { enabled: true } },
      cancel: false,
      timeout: false,
    },
    {
      mode: "tool-search-tools",
      tools: { toolSearch: { enabled: true, mode: "tools" } },
      cancel: false,
      timeout: false,
    },
    {
      mode: "tool-search-directory",
      tools: { toolSearch: { enabled: true, mode: "directory" } },
      cancel: false,
      timeout: false,
    },
    {
      mode: "cancelled-code-mode",
      tools: { codeMode: { enabled: true } },
      cancel: true,
      timeout: false,
    },
    {
      mode: "timed-out-code-mode",
      tools: { codeMode: { enabled: true } },
      cancel: true,
      timeout: true,
    },
  ] as const)(
    "clears the $mode run catalog when preparation fails or is cancelled",
    async ({ mode, tools, cancel, timeout }) => {
      const runId = `run-catalog-diagnostics-${mode}`;
      const diagnosticsError = new Error(`failed ${mode} tool diagnostics`);
      if (timeout) {
        diagnosticsError.name = "TimeoutError";
      }
      const abortController = new AbortController();
      let catalogRef: ToolSearchCatalogRef | undefined;
      const logDiagnostics = vi.fn(() => {
        catalogRef = requireAttemptCatalogRef();
        expect(catalogRef.current?.entries).toContainEqual(
          expect.objectContaining({ name: "cataloged_probe_tool" }),
        );
        if (cancel) {
          abortController.abort(diagnosticsError);
        } else {
          throw diagnosticsError;
        }
      });
      const cleanup = vi.fn(async (_reason: string) => {});
      hoisted.createOpenClawCodingToolsMock.mockImplementation((options) => {
        const toolOptions = options as NonNullable<Parameters<typeof createOpenClawCodingTools>[0]>;
        toolOptions.registerRunCleanup?.(cleanup);
        return catalogProbeTools();
      });
      const events: DiagnosticEventPayload[] = [];
      const unsubscribe = onInternalDiagnosticEvent((event) => events.push(event), {
        include: ["run.completed"],
      });

      const attempt = createContextEngineAttemptRunner({
        contextEngine: createContextEngineBootstrapAndAssemble(),
        sessionKey: "agent:main:telegram:direct:123",
        tempPaths,
        attemptOverrides: {
          runId,
          abortSignal: abortController.signal,
          disableTools: false,
          config: { tools },
          runtimePlan: {
            tools: {
              normalize: (normalizedTools: unknown[]) => normalizedTools,
              logDiagnostics,
            },
          } as never,
        },
      });

      try {
        if (timeout) {
          await expect(attempt).rejects.toMatchObject({
            cause: diagnosticsError,
            terminalOutcome: { status: "timeout" },
          });
        } else {
          await expect(attempt).rejects.toBe(diagnosticsError);
        }
      } finally {
        unsubscribe();
      }
      expect(cleanup).toHaveBeenCalledExactlyOnceWith(
        timeout ? "timeout" : cancel ? "cancel" : "completion",
      );
      if (timeout) {
        expect(events).toContainEqual(
          expect.objectContaining({
            type: "run.completed",
            runId,
            outcome: "aborted",
          }),
        );
      }
      expect(logDiagnostics).toHaveBeenCalledOnce();
      expect(catalogRef).toBeDefined();
      expect(catalogRef?.current).toBeUndefined();
    },
  );
});
