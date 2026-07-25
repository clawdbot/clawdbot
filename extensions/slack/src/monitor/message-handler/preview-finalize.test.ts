// Slack tests cover preview finalize plugin behavior.
import type { WebClient } from "@slack/web-api";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const editSlackMessageMock = vi.fn();

vi.mock("../../actions.js", () => ({
  editSlackMessage: (...args: unknown[]) =>
    editSlackMessageMock(...(args as Parameters<typeof editSlackMessageMock>)),
}));

let finalizeSlackPreviewEdit: typeof import("./preview-finalize.js").finalizeSlackPreviewEdit;

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
    ({ finalizeSlackPreviewEdit } = await import("./preview-finalize.js"));
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
    ).toHaveBeenCalledWith({
      token: "xoxb-test",
      channel: "C123",
      ts: "170000.111",
      latest: "171234.567",
      inclusive: true,
      limit: 100,
    });
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

  it("accepts native-data fallback blocks after an ambiguous retry response", async () => {
    editSlackMessageMock.mockRejectedValueOnce(new Error("socket closed"));
    const blocks = [
      {
        type: "data_visualization",
        title: "Revenue mix",
        chart: {
          type: "pie",
          segments: [
            { label: "Product", value: 60 },
            { label: "Services", value: 40 },
          ],
        },
      },
    ] as const;
    const text = "Revenue mix (pie chart)\n- Product: 60\n- Services: 40";
    const fallbackBlocks = [
      {
        type: "section",
        text: { type: "mrkdwn", text, verbatim: true },
      },
    ];
    const client = createClient({
      historyMessages: [{ ts: "171234.567", text, blocks: fallbackBlocks }],
    });

    await expect(
      finalizeSlackPreviewEdit({
        client,
        token: "xoxb-test",
        channelId: "C123",
        messageId: "171234.567",
        text: "",
        blocks: blocks as unknown as Parameters<typeof finalizeSlackPreviewEdit>[0]["blocks"],
      }),
    ).resolves.toBeUndefined();
  });

  it("accepts native-data text fallback without blocks after an ambiguous retry response", async () => {
    editSlackMessageMock.mockRejectedValueOnce(new Error("socket closed"));
    const blocks = [
      {
        type: "data_visualization",
        title: "Revenue mix",
        chart: {
          type: "pie",
          segments: [
            { label: "Product", value: 60 },
            { label: "Services", value: 40 },
          ],
        },
      },
    ] as const;
    const text = "Revenue mix (pie chart)\n- Product: 60\n- Services: 40";
    const client = createClient({
      historyMessages: [{ ts: "171234.567", text }],
    });

    await expect(
      finalizeSlackPreviewEdit({
        client,
        token: "xoxb-test",
        channelId: "C123",
        messageId: "171234.567",
        text: "",
        blocks: blocks as unknown as Parameters<typeof finalizeSlackPreviewEdit>[0]["blocks"],
      }),
    ).resolves.toBeUndefined();
  });
});
