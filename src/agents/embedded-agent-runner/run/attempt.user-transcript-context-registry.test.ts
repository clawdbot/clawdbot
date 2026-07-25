import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../runtime/index.js";
import { createUserTranscriptContextRegistry } from "./attempt.user-transcript-context-registry.js";

describe("createUserTranscriptContextRegistry", () => {
  it("retains a recorder-backed initial turn after a queued turn becomes latest", () => {
    const initialRuntime = { role: "user", content: "same", timestamp: 1 } as AgentMessage;
    const initialTranscript = {
      role: "user",
      content: "same",
      timestamp: 1,
      __openclaw: { senderName: "Alice" },
    } as AgentMessage;
    const queuedRuntime = { role: "user", content: "queued", timestamp: 2 } as AgentMessage;
    const queuedTranscript = {
      role: "user",
      content: "queued",
      timestamp: 2,
      __openclaw: { senderName: "Bob" },
    } as AgentMessage;
    const registry = createUserTranscriptContextRegistry();

    registry.list(initialRuntime, initialTranscript);
    registry.list(queuedRuntime, queuedTranscript);

    expect(registry.list()).toEqual([
      { runtimeMessage: initialRuntime, transcriptMessage: initialTranscript },
      { runtimeMessage: queuedRuntime, transcriptMessage: queuedTranscript },
    ]);
  });
});
