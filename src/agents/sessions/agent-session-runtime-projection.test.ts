import fs from "node:fs/promises";
import path from "node:path";
import type { Model } from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { toClientToolDefinitions } from "../agent-tool-definition-adapter.js";
import { guardSessionManager } from "../session-tool-result-guard-wrapper.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import { createResourceLoader } from "./agent-session-loop-resource-loader.test-support.js";
import { AuthStorage } from "./auth-storage.js";
import type { MessageEndEvent, ToolDefinition } from "./extensions/types.js";
import { ModelRegistry } from "./model-registry.js";
import { createAgentSession } from "./sdk.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

registerAgentSessionLoopTestLifecycle();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("AgentSession runtime and transcript projections", () => {
  it("keeps grep-only truncation results free of unavailable read-tool instructions", async () => {
    const cwd = await fs.realpath(tempDirs.make("openclaw-sdk-grep-guidance-"));
    const line = `needle ${"x".repeat(600)} OMITTED_END`;
    await fs.writeFile(path.join(cwd, "long-line.txt"), `${line}\n`);
    const { session } = await createAgentSession({
      cwd,
      tools: ["grep"],
      model: testModel,
      resourceLoader: createResourceLoader(),
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory(),
      modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
    });
    try {
      expect(session.getActiveToolNames()).toEqual(["grep"]);
      session.setActiveToolsByName(["read", "grep"]);
      expect(session.getActiveToolNames()).toEqual(["grep"]);
      const grep = session.agent.state.tools[0];
      if (!grep) {
        throw new Error("Expected the selected grep tool");
      }
      const result = await grep.execute("grep-long-line", {
        pattern: "needle",
        path: "long-line.txt",
      });
      const text = result.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("\n");
      expect(result.details).toMatchObject({ linesTruncated: true });
      expect(text).toContain(`long-line.txt:1: ${line.slice(0, 500)}... [truncated]`);
      expect(text).toContain("Some lines truncated to 500 chars");
      expect(text).not.toContain("OMITTED_END");
      expect(text).not.toMatch(/\bread tool\b/u);
    } finally {
      session.dispose();
    }
  });

  it("preserves execution correlation IDs through redacted transcript persistence", async () => {
    const dir = tempDirs.make("openclaw-correlation-projection-");
    const scope = {
      agentId: "main",
      sessionId: "correlation-projection",
      sessionKey: "agent:main:correlation-projection",
      storePath: path.join(dir, "sessions.json"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const sessionManager = SessionManager.open(scope, dir);
    guardSessionManager(sessionManager, { config: {}, allowedToolNames: ["lookup"] });
    const ids = ["call_lookup|fc-jztpgrWaMLTnokJk", "call_lookup|fc-jztDifferentokJk"];
    streamMocks.streamSimple
      .mockImplementationOnce((model: Model) =>
        createAssistantResultStream(
          createAssistant(
            model,
            ids.map((id) => ({ type: "toolCall", id, name: "lookup", arguments: { value: id } })),
            "toolUse",
          ),
        ),
      )
      .mockImplementation((model: Model) =>
        createAssistantResultStream(createAssistant(model, [{ type: "text", text: "Done." }])),
      );
    const parameters = Type.Object({ value: Type.String() });
    const lookupTool: ToolDefinition<typeof parameters> = {
      name: "lookup",
      label: "Lookup",
      description: "Look up a record.",
      parameters,
      async execute(_toolCallId, args) {
        return { content: [{ type: "text", text: args.value }], details: args };
      },
    };
    const { session } = await createTestSession({ sessionManager, customTools: [lookupTool] });
    const started: string[] = [];
    session.subscribe((event) => {
      if (event.type === "tool_execution_start") {
        started.push(event.toolCallId);
      }
    });

    await session.prompt("Look up both records.");

    expect(started).toEqual(ids);
    expect(streamMocks.streamSimple).toHaveBeenCalledTimes(2);
    const stored = SessionManager.open(scope, dir)
      .getBranch()
      .flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
    expect(stored.find((message) => message.role === "assistant")).toMatchObject({
      content: ids.map((id) => ({
        type: "toolCall",
        id,
        arguments: { value: expect.not.stringContaining(id) },
      })),
    });
    expect(stored.filter((message) => message.role === "toolResult")).toMatchObject(
      ids.map((toolCallId) => ({
        toolCallId,
        content: [{ type: "text", text: expect.not.stringContaining(toolCallId) }],
        details: { value: expect.not.stringContaining(toolCallId) },
        isError: false,
      })),
    );
  });

  it.each(["key", "apiKey", "account"])(
    "executes original %s arguments while preserving redacted storage and delivery facts",
    async (field) => {
      const dir = tempDirs.make("openclaw-runtime-projection-");
      const scope = {
        agentId: "main",
        sessionId: "runtime-projection",
        sessionKey: "agent:main:runtime-projection",
        storePath: path.join(dir, "sessions.json"),
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const sessionManager = SessionManager.open(scope, dir);
      guardSessionManager(sessionManager, { config: {}, allowedToolNames: ["lookup"] });
      const calls = vi.fn();
      const values = ["alpha", "beta"];
      const customTools = toClientToolDefinitions(
        [
          {
            type: "function",
            function: {
              name: "lookup",
              parameters: {
                type: "object",
                properties: { [field]: { type: "string", enum: values } },
                required: [field],
                additionalProperties: false,
              },
            },
          },
        ],
        calls,
      );
      streamMocks.streamSimple
        .mockImplementationOnce((model: Model) =>
          createAssistantResultStream(
            createAssistant(
              model,
              [
                { type: "text", text: "Looking up both records." },
                ...values.map((value, index) => ({
                  type: "toolCall" as const,
                  id: `call_${index}`,
                  name: "lookup",
                  arguments: { [field]: value },
                })),
              ],
              "toolUse",
            ),
          ),
        )
        .mockImplementation((model: Model) =>
          createAssistantResultStream(
            createAssistant(model, [{ type: "text", text: "Stopped after tool errors." }]),
          ),
        );
      const resourceLoader = createResourceLoader(
        new Map([
          [
            "message_end",
            [
              async (event: unknown) => {
                const { message } = event as MessageEndEvent;
                if (message.role !== "assistant") {
                  return undefined;
                }
                return {
                  message: {
                    ...message,
                    content: message.content.map((block) =>
                      block.type === "text"
                        ? {
                            type: block.type,
                            text: `[[reply_to_current]] Extension: ${block.text}`,
                          }
                        : block,
                    ),
                  },
                };
              },
            ],
          ],
        ]),
      );
      const { session } = await createTestSession({ sessionManager, customTools, resourceLoader });

      await session.prompt("Look up alpha and beta.");

      expect(calls.mock.calls).toEqual(values.map((value) => ["lookup", { [field]: value }]));
      expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
      const live = session.state.messages.find((message) => message.role === "assistant");
      expect(live).toMatchObject({
        content: [
          { type: "text", text: "Extension: Looking up both records." },
          ...values.map((value) => ({ type: "toolCall", arguments: { [field]: value } })),
        ],
        openclawDelivery: { replyToCurrent: true },
      });
      const reopened = SessionManager.open(scope, dir);
      const stored = reopened.getBranch().find((entry) => {
        return entry.type === "message" && entry.message.role === "assistant";
      });
      expect(stored).toMatchObject({
        message: {
          content: [
            { type: "text", text: "Extension: Looking up both records." },
            ...values.map((value) => ({
              type: "toolCall",
              arguments: { [field]: field === "account" ? value : "***" },
            })),
          ],
          openclawDelivery: { replyToCurrent: true },
        },
      });
    },
  );
});
