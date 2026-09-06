import type { Context, Model, SimpleStreamOptions } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { applyAgentCompactionSettingsFromConfig } from "../agent-settings.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import type { AgentSessionEvent } from "./agent-session-types.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

registerAgentSessionLoopTestLifecycle();

describe("AgentSession small-context compaction", () => {
  it("keeps a fresh 32K conversation intact and compacts growing history within summary headroom", async () => {
    const model = { ...testModel, contextWindow: 32_768, maxTokens: 8_192 };
    const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
    applyAgentCompactionSettingsFromConfig({
      settingsManager,
      contextTokenBudget: model.contextWindow,
    });
    const sessionManager = SessionManager.inMemory();
    const { session } = await createTestSession({ model, settingsManager, sessionManager });
    const summaryBudgets: number[] = [];
    const firstPrompt = "Remember that the project uses blue buttons.";
    const secondPrompt = `Review the module results and preserve button contrast.\n${"The module output needs a careful accessibility review.\n".repeat(1_400)}`;
    const firstAnswer = `Blue buttons are the project decision.\n${"Validated widget: blue buttons remain accessible.\n".repeat(600)}`;
    let userTurns = 0;
    streamMocks.streamSimple.mockImplementation(
      (activeModel: Model, context: Context, options?: SimpleStreamOptions) => {
        const userMessage = context.messages.findLast((message) => message.role === "user");
        const userText =
          typeof userMessage?.content === "string"
            ? userMessage.content
            : userMessage?.content
                .map((block) => (block.type === "text" ? block.text : ""))
                .join("");
        if (userText !== firstPrompt && userText !== secondPrompt) {
          expect(userText).toContain("blue buttons");
          expect(options?.maxTokens).toBeTypeOf("number");
          summaryBudgets.push(options!.maxTokens!);
          return createAssistantResultStream(
            createAssistant(
              activeModel,
              [{ type: "text", text: "The project uses blue buttons." }],
              "stop",
              100,
            ),
          );
        }
        userTurns += 1;
        return createAssistantResultStream(
          createAssistant(
            activeModel,
            [
              {
                type: "text",
                text: userTurns === 1 ? firstAnswer : "Completed the accessibility review.",
              },
            ],
            "stop",
            userTurns === 1 ? 12_824 : 24_577,
          ),
        );
      },
    );
    const compactionEvents: Array<Extract<AgentSessionEvent, { type: "compaction_end" }>> = [];
    session.subscribe((event) => {
      if (event.type === "compaction_end") {
        compactionEvents.push(event);
      }
    });

    await session.prompt(firstPrompt);
    expect(compactionEvents).toHaveLength(0);
    expect(sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);

    await session.prompt(secondPrompt);
    expect(compactionEvents).toMatchObject([{ outcome: { status: "completed" } }]);
    expect(
      sessionManager.getEntries().filter((entry) => entry.type === "compaction"),
    ).toMatchObject([{ summary: expect.stringContaining("blue buttons") }]);
    expect(summaryBudgets.length).toBeGreaterThan(0);
    for (const budget of summaryBudgets) {
      expect(budget).toBeGreaterThan(0);
      expect(budget).toBeLessThanOrEqual(6_553);
    }
    expect(
      session.messages.some((message) => JSON.stringify(message).includes("blue buttons")),
    ).toBe(true);
  });
});
