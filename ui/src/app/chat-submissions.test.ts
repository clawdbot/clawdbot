import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { findChatSubmissionMessage } from "../lib/chat/history-message-identity.ts";
import { shouldDisplayChatSubmission } from "../pages/chat/history-merge.ts";
import { buildInitialChatSubmission } from "../pages/chat/user-message-content.ts";
import { createChatSubmissions, type RetainedChatSubmission } from "./chat-submissions.ts";

function message(text: string): RetainedChatSubmission["message"] {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1, __openclaw: {} };
}

describe("retained chat submissions", () => {
  it.each([
    { kind: "initial", limit: 32 },
    { kind: "delivered", limit: 64 },
  ] as const)(
    "bounds $kind display retention and clears it at application disposal",
    ({ kind, limit }) => {
      const submissions = createChatSubmissions();
      const owner = {};
      const retain = (index: number, client = owner) =>
        submissions.retain({
          kind,
          deliveryKey: String(index),
          sessionKey: `agent:main:retained-${index}`,
          pendingRunId: String(index),
          message: message(String(index)),
          owner: client,
        });
      const read = (index: number, client = owner) =>
        kind === "initial"
          ? submissions.readInitial(`agent:main:retained-${index}`, client)
          : submissions.readDelivered(String(index), client);
      for (let index = 0; index <= limit; index++) {
        retain(index);
      }
      expect(read(0)).toBeFalsy();
      expect(read(1)?.message.content).toEqual([{ type: "text", text: "1" }]);
      const replacement = expectDefined(retain(1), "retained submission");
      expect(
        shouldDisplayChatSubmission(
          replacement,
          findChatSubmissionMessage(
            [
              {
                ...replacement.message,
                __openclaw: { id: "receipt", idempotencyKey: `${replacement.pendingRunId}:user` },
              },
            ],
            replacement.pendingRunId,
            true,
          ),
        ),
      ).toBe(false);
      expect(read(1)?.pending).toBe(false);
      expect(read(1, {})).toBeFalsy();
      if (kind === "delivered") {
        const otherClient = {};
        retain(1, otherClient);
        expect(read(1)?.pending).toBe(false);
        expect(read(1, otherClient)?.pending).toBe(true);
      }
      submissions.clear();
      expect(read(1)).toBeFalsy();
      expect(read(limit)).toBeFalsy();
    },
  );
  it("stores run ownership and preserves client privacy until clearing", () => {
    const handoff = createChatSubmissions();
    const owner = {};
    const replacementOwner = {};
    const first = message("first");
    handoff.retain({
      kind: "initial",
      sessionKey: "agent:main:main",
      message: first,
      owner,
      pendingRunId: "initial-run",
    });

    expect(handoff.readInitial("main", owner)).toEqual({
      kind: "initial",
      pending: true,
      sessionKey: "agent:main:main",
      message: first,
      owner,
      pendingRunId: "initial-run",
    });
    expect(handoff.readInitial("main", replacementOwner)).toBeNull();
    handoff.clearInitial("agent:main:missing");
    expect(handoff.readInitial("main", owner)).not.toBeNull();
    handoff.clearInitial("agent:main:main");
    expect(handoff.readInitial("main", owner)).toBeNull();
  });
});

const imageDataUrl = "data:image/png;base64,iVBORw0KGgo=";

describe("initial user message handoff", () => {
  it("prepares accepted prompts only with explicit run ownership", () => {
    const sessionKey = "agent:main:main";
    const client = {};
    const handoff = createChatSubmissions();
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

    handoff.retain(buildInitialChatSubmission(sessionKey, item, client));
    expect(handoff.readInitial(sessionKey, client)).toBeNull();

    handoff.retain(buildInitialChatSubmission(sessionKey, item, client, "initial-image-run"));

    expect(handoff.readInitial("main", client)).toEqual({
      kind: "initial",
      sessionKey,
      owner: client,
      pendingRunId: "initial-image-run",
      pending: true,
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
        },
      },
    });
  });

  it("retains independent reconnect handoffs without exposing them to a replacement client", () => {
    const client = {};
    const replacementClient = {};
    const handoff = createChatSubmissions();
    for (const [sessionKey, runId] of [
      ["agent:main:first", "first-run"],
      ["agent:main:second", "second-run"],
    ] as const) {
      handoff.retain(
        buildInitialChatSubmission(sessionKey, { text: runId, createdAt: 123 }, client, runId),
      );
      expect(handoff.readInitial(sessionKey, client)?.pendingRunId).toBe(runId);
      expect(handoff.readInitial(sessionKey, replacementClient)).toBeNull();
    }
  });
});
