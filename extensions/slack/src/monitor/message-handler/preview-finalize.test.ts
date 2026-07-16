import type { WebClient } from "@slack/web-api";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const editSlackMessageMock = vi.fn();

vi.mock("../../actions.js", () => ({
  editSlackMessage: (...args: unknown[]) =>
    editSlackMessageMock(...(args as Parameters<typeof editSlackMessageMock>)),
}));

let finalizeSlackPreviewEdit: typeof import("./preview-finalize.js").finalizeSlackPreviewEdit;
let __testing: typeof import("./preview-finalize.js").__testing;

function createClient(overrides?: {
  historyMessages?: Array<Record<string, unknown>>;
  replyMessages?: Array<Record<string, unknown>>;
}) {
  return {
    conversations: {
      history: vi.fn(async () => ({ messages: overrides?.historyMessages ?? [] })),
      replies: vi.fn(async () => ({ messages: overrides?.replyMessages ?? [] })),
    },
  } as unknown as WebClient;
}

describe("finalizeSlackPreviewEdit", () => {
  beforeAll(async () => {
    ({ finalizeSlackPreviewEdit, __testing } = await import("./preview-finalize.js"));
  });

  beforeEach(() => {
    editSlackMessageMock.mockReset();
  });

  it("treats a thrown edit as success when history readback already matches", async () => {
    editSlackMessageMock.mockRejectedValueOnce(new Error("socket closed"));
    const client = createClient({
      historyMessages: [{ ts: "171234.567", text: "fair. poke harder then 🦞" }],
    });

    await expect(
      finalizeSlackPreviewEdit({
        client,
        token: "xoxb-test",
        channelId: "C123",
        messageId: "171234.567",
        text: "fair. poke harder then 🦞",
      }),
    ).resolves.toBeUndefined();

    expect(client.conversations.history as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalled();
  });

  it("checks threaded replies via conversations.replies", async () => {
    editSlackMessageMock.mockRejectedValueOnce(new Error("socket closed"));
    const client = createClient({
      replyMessages: [{ ts: "171234.567", text: "done" }],
    });

    await expect(
      finalizeSlackPreviewEdit({
        client,
        token: "xoxb-test",
        channelId: "C123",
        messageId: "171234.567",
        threadTs: "170000.111",
        text: "done",
      }),
    ).resolves.toBeUndefined();

    expect(
      client.conversations.replies as unknown as ReturnType<typeof vi.fn>,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123",
        ts: "170000.111",
        latest: "171234.567",
      }),
    );
  });

  it("rethrows when readback does not match the expected final text", async () => {
    editSlackMessageMock.mockRejectedValueOnce(new Error("socket closed"));
    const client = createClient({
      historyMessages: [{ ts: "171234.567", text: "partial draft" }],
    });

    await expect(
      finalizeSlackPreviewEdit({
        client,
        token: "xoxb-test",
        channelId: "C123",
        messageId: "171234.567",
        text: "final answer",
      }),
    ).rejects.toThrow("socket closed");
  });

  it("requires matching blocks when finalizing a blocks-only edit", async () => {
    const blocks = [{ type: "section", text: { type: "mrkdwn", text: "*Done*" } }] as const;

    expect(
      __testing.buildExpectedSlackEditText({
        text: "",
        blocks: blocks as unknown as Parameters<
          typeof __testing.buildExpectedSlackEditText
        >[0]["blocks"],
      }),
    ).toBe("*Done*");
  });
});
