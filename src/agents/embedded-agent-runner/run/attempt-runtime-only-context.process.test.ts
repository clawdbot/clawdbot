// Production-path proof for a runtime-only background wake: the submitted prompt is the
// stable event stub, inbound metadata rides the hidden carrier, and the carrier is cleaned up.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMemoryPluginState } from "../../../plugins/memory-state.test-fixtures.js";
import {
  cleanupTempPaths,
  createContextEngineBootstrapAndAssemble,
  createContextEngineAttemptRunner,
  getHoisted,
  preloadRunEmbeddedAttemptForTests,
  resetEmbeddedAttemptHarness,
} from "./attempt-spawn-workspace.test-support.js";

const hoisted = getHoisted();
const sessionKey = "agent:main:telegram:background-proof";
const tempPaths: string[] = [];

beforeAll(async () => {
  await preloadRunEmbeddedAttemptForTests();
});

beforeEach(() => {
  resetEmbeddedAttemptHarness();
  clearMemoryPluginState();
  hoisted.runContextEngineMaintenanceMock.mockReset().mockResolvedValue(undefined);
  hoisted.detectAndLoadPromptImagesMock.mockClear();
});

afterEach(async () => {
  await cleanupTempPaths(tempPaths);
  clearMemoryPluginState();
  vi.restoreAllMocks();
});

describe("runtime-only background wake production path", () => {
  it("submits a bare event stub with hidden inbound context and cleans it up", async () => {
    let submittedPrompt: string | undefined;
    let submittedMessages: unknown[] | undefined;
    let submittedSession: { messages: unknown[] } | undefined;
    await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey,
      tempPaths,
      trajectory: true,
      attemptOverrides: {
        prompt: "runtime bare mention event",
        transcriptPrompt: "",
        runtimeContextFragments: [
          { kind: "runtime-instruction", text: "runtime bare mention event" },
        ],
        currentInboundContext: {
          text: [
            "Reply target of current user message:",
            "```json",
            JSON.stringify({ sender_label: "Alice", body: "Hello from the replied message" }),
            "```",
          ].join("\n"),
        },
      },
      sessionPrompt: async (session, prompt) => {
        submittedSession = session;
        submittedPrompt = prompt;
        submittedMessages = [...session.messages];
        session.messages = [
          ...session.messages,
          { role: "assistant", content: "done", timestamp: 2 },
        ];
      },
    });

    const carrier = (submittedMessages ?? []).find(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "customType" in message &&
        message.customType === "openclaw.runtime-context",
    );
    const finalSnapshot = JSON.stringify(submittedSession?.messages ?? []);
    expect(submittedPrompt).toBe("Continue the OpenClaw runtime event.");
    expect(submittedPrompt).not.toContain("Hello from the replied message");
    expect(carrier).toBeDefined();
    expect(JSON.stringify(carrier)).toContain("Hello from the replied message");
    expect(finalSnapshot).not.toContain("openclaw.runtime-context");
    console.log(
      `runtime-only-background-wake-proof ${JSON.stringify({
        submittedPrompt,
        hiddenCarrier: true,
        carrierRemovedAfterSubmission: !finalSnapshot.includes("openclaw.runtime-context"),
      })}`,
    );
  });
});
