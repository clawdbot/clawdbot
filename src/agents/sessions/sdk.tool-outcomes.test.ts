import path from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { disposeOpenClawAgentDatabaseByPath } from "../../state/openclaw-agent-db.js";
import { toToolDefinitions } from "../agent-tool-definition-adapter.js";
import type { AgentTool } from "../runtime/index.js";
import { attachInternalToolExecutionPreparer } from "../runtime/internal-hooks.js";
import {
  createAssistant,
  createAssistantResultStream,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import { createResourceLoader } from "./agent-session-loop-resource-loader.test-support.js";
import { AuthStorage } from "./auth-storage.js";
import type { ToolResultEvent } from "./extensions/types.js";
import { ModelRegistry } from "./model-registry.js";
import { createAgentSession } from "./sdk.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("session tool outcomes", () => {
  it.each([false, true])(
    "preserves tool outcomes through events, replay, and storage (recovery=%s)",
    async (withRecovery) => {
      const outcomes = [
        {
          name: "returned_error",
          details: { status: "error", error: "capture failed" },
          isError: true,
        },
        { name: "adapted_error", details: {}, throws: true, isError: true },
        { name: "preflight_error", details: {}, preflight: true, isError: true },
        { name: "recovered_tool", details: {}, throws: true, isError: !withRecovery },
        { name: "middleware_error", details: {}, isError: withRecovery },
        {
          name: "completed_command",
          details: { status: "completed", exitCode: 1 },
          isError: false,
        },
        { name: "successful_tool", details: { status: "ok" }, isError: false },
      ];
      const calls = [...outcomes, { name: "missing_tool", isError: true }].map((outcome) => ({
        type: "toolCall" as const,
        id: `call_${outcome.name}`,
        name: outcome.name,
        arguments: {},
      }));
      const expected = [...outcomes, { name: "missing_tool", isError: true }].map((outcome) => ({
        toolName: outcome.name,
        isError: outcome.isError,
      }));
      const agentDir = tempDirs.make("openclaw-sdk-tool-outcome-");
      const { session } = await createAgentSession({
        agentDir,
        model: testModel,
        noTools: "builtin",
        customTools: toToolDefinitions(
          outcomes.map((outcome) => {
            const tool: AgentTool = {
              name: outcome.name,
              label: outcome.name,
              description: "Returns a synthetic tool outcome.",
              parameters: Type.Object({}),
              execute: async () => {
                if (outcome.throws) {
                  throw new Error("capture failed");
                }
                return {
                  content: [{ type: "text", text: "synthetic result" }],
                  details: outcome.details,
                };
              },
            };
            return outcome.preflight
              ? attachInternalToolExecutionPreparer(tool, async () => {
                  throw new Error("preflight failed");
                })
              : tool;
          }),
        ),
        resourceLoader: createResourceLoader(
          new Map(
            withRecovery
              ? [
                  [
                    "tool_result",
                    [
                      async (event: unknown) => {
                        const { toolName } = event as ToolResultEvent;
                        if (toolName === "recovered_tool") {
                          return { isError: false };
                        }
                        return toolName === "middleware_error"
                          ? { details: { status: "error", error: "middleware failed" } }
                          : undefined;
                      },
                    ],
                  ],
                ]
              : [],
          ),
        ),
        settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
        modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
      });
      const completed: Array<{ toolName: string; isError: boolean }> = [];
      session.subscribe((event) => {
        if (event.type === "tool_execution_end") {
          completed.push({ toolName: event.toolName, isError: event.isError });
        }
      });
      let replay: unknown;
      let firstTurn = true;
      session.agent.streamFn = (_model, context) => {
        if (!firstTurn) {
          replay = context.messages.filter((message) => message.role === "toolResult");
          return createAssistantResultStream(
            createAssistant(testModel, [{ type: "text", text: "done" }]),
          );
        }
        firstTurn = false;
        return createAssistantResultStream(createAssistant(testModel, calls, "toolUse"));
      };
      try {
        await session.agent.prompt({
          role: "user",
          content: "Run the synthetic tools.",
          timestamp: 1,
        });
        expect(completed).toHaveLength(expected.length);
        expect(completed).toEqual(expect.arrayContaining(expected));
        expect(replay).toMatchObject(expected);
        const target = session.sessionManager.getSessionTarget();
        if (!target) {
          throw new Error("Expected a saved transcript target");
        }
        const events = SessionManager.open(target).getEntries();
        expect(
          events.flatMap((event) =>
            event.type === "message" && event.message.role === "toolResult" ? [event.message] : [],
          ),
        ).toMatchObject(expected);
      } finally {
        session.dispose();
        disposeOpenClawAgentDatabaseByPath(path.join(agentDir, "openclaw-agent.sqlite"));
      }
    },
  );
});
