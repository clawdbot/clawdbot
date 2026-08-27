import { describe, expect, it } from "vitest";
import { createInitialUserMessageHandoff } from "../../app/initial-user-message-handoff.ts";
import { prepareInitialUserMessageHandoff } from "./initial-turn-handoff.ts";

const imageDataUrl = "data:image/png;base64,iVBORw0KGgo=";

describe("initial user message handoff", () => {
  it("prepares accepted prompts only with explicit run ownership", () => {
    const sessionKey = "agent:main:main";
    const client = {};
    const handoff = createInitialUserMessageHandoff();
    const item = {
      text: "inspect this image",
      attachments: [
        {
          id: "image-1",
          mimeType: "image/png",
          fileName: "image.png",
          sizeBytes: 68,
          dataUrl: imageDataUrl,
        },
      ],
      createdAt: 123,
      sender: { id: "profile-1", name: "Alice Example" },
    };

    prepareInitialUserMessageHandoff(handoff, sessionKey, item, client);
    expect(handoff.read(sessionKey, client)).toBeNull();

    prepareInitialUserMessageHandoff(handoff, sessionKey, item, client, {
      runId: "initial-image-run",
      messageSeq: 1,
    });

    expect(handoff.read("main", client)).toEqual({
      sessionKey,
      owner: client,
      pendingRunId: "initial-image-run",
      message: {
        role: "user",
        content: [
          { type: "text", text: "inspect this image" },
          {
            type: "image",
            url: imageDataUrl,
            source: { type: "url", url: imageDataUrl },
          },
        ],
        timestamp: 123,
        __openclaw: {
          idempotencyKey: "initial-image-run:user",
          senderId: "profile-1",
          senderName: "Alice Example",
          seq: 1,
        },
      },
    });
  });

  it("retains independent reconnect handoffs without exposing them to a replacement client", () => {
    const client = {};
    const replacementClient = {};
    const handoff = createInitialUserMessageHandoff();
    for (const [sessionKey, runId] of [
      ["agent:main:first", "first-run"],
      ["agent:main:second", "second-run"],
    ] as const) {
      prepareInitialUserMessageHandoff(
        handoff,
        sessionKey,
        { text: runId, createdAt: 123 },
        client,
        { runId },
      );
      expect(handoff.read(sessionKey, client)?.pendingRunId).toBe(runId);
      expect(handoff.read(sessionKey, replacementClient)).toBeNull();
    }
  });
});
