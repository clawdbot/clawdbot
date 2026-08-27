import path from "node:path";
import type { Model } from "openclaw/plugin-sdk/llm";
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
} from "./agent-session-loop-correctness.test-support.js";
import { createResourceLoader } from "./agent-session-loop-resource-loader.test-support.js";
import type { MessageEndEvent } from "./extensions/types.js";
import { SessionManager } from "./session-manager.js";

registerAgentSessionLoopTestLifecycle();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("AgentSession runtime and transcript projections", () => {
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
