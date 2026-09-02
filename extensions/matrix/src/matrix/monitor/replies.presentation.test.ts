// Matrix tests cover reply presentation delivery behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime, RuntimeEnv } from "../../../runtime-api.js";
import { prepareMatrixReplyPayload } from "../../outbound.js";
import type { MatrixClient } from "../sdk.js";

const sendMessageMatrixMock = vi.hoisted(() => vi.fn());

vi.mock("../send.js", () => ({
  sendMessageMatrix: (to: string, message: string, opts?: unknown) =>
    sendMessageMatrixMock(to, message, opts),
}));

import { setMatrixRuntime } from "../../runtime.js";
import { deliverMatrixReplies } from "./replies.js";
import type { ReplyPayload } from "./runtime-api.js";

const PRESENTATION_KEY = "com.openclaw.presentation";

async function resolveMockMatrixSend(_to: string, message: string, opts?: Record<string, unknown>) {
  const result = {
    messageId: "mx-1",
    roomId: "room:1",
    primaryMessageId: "mx-1",
    receipt: {
      primaryPlatformMessageId: "mx-1",
      platformMessageIds: ["mx-1"],
      parts: [{ platformMessageId: "mx-1", kind: "text" as const, index: 0 }],
      sentAt: 1,
    },
    content: message,
  };
  const onDeliveryResult = opts?.onDeliveryResult;
  if (typeof onDeliveryResult === "function") {
    await onDeliveryResult(result);
  }
  return result;
}

describe("Matrix reply presentation delivery", () => {
  const cfg = { channels: { matrix: {} } };
  const runtimeStub = {
    config: { current: () => ({}) },
    channel: {
      text: {
        resolveMarkdownTableMode: () => "code",
        resolveTextChunkLimit: () => 4000,
        convertMarkdownTables: (text: string) => text,
        resolveChunkMode: () => "length",
        chunkMarkdownTextWithMode: (text: string) => [text],
      },
    },
    logging: { shouldLogVerbose: () => false },
  } as unknown as PluginRuntime;

  const runtimeEnv: RuntimeEnv = {
    log: vi.fn(),
    error: vi.fn(),
  } as unknown as RuntimeEnv;

  beforeEach(() => {
    vi.clearAllMocks();
    sendMessageMatrixMock.mockReset().mockImplementation(resolveMockMatrixSend);
    setMatrixRuntime(runtimeStub);
  });

  const deliver = async (reply: ReplyPayload) =>
    await deliverMatrixReplies({
      cfg,
      replies: [await prepareMatrixReplyPayload(reply)],
      roomId: "room:1",
      client: {} as MatrixClient,
      runtime: runtimeEnv,
      replyToMode: "off",
    });

  const approvalPresentation = {
    blocks: [
      { type: "text" as const, text: "Deploy to production?" },
      {
        type: "buttons" as const,
        buttons: [
          { label: "Approve", action: { type: "callback" as const, value: "approve" } },
          { label: "Deny", action: { type: "callback" as const, value: "deny" } },
        ],
      },
    ],
  };

  it("reaches the room with the controls a controls-only reply carries", async () => {
    const result = await deliver({ presentation: approvalPresentation });

    expect(result.visibleReplySent).toBe(true);
    expect(runtimeEnv.error).not.toHaveBeenCalled();
    const [, text, opts] = sendMessageMatrixMock.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(text).toContain("Approve");
    expect(text).toContain("Deny");
    const presentation = (opts.extraContent as Record<string, unknown>)[PRESENTATION_KEY];
    expect(presentation).toMatchObject({
      type: "message.presentation",
      version: 1,
      blocks: approvalPresentation.blocks,
    });
  });

  it("keeps the controls on a reply that also carries text", async () => {
    await deliver({ text: "Ready when you are.", presentation: approvalPresentation });

    const [, text, opts] = sendMessageMatrixMock.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(text).toContain("Ready when you are.");
    expect(text).toContain("Approve");
    expect((opts.extraContent as Record<string, unknown>)[PRESENTATION_KEY]).toBeDefined();
  });

  it("attaches the controls to the first event of a reply that carries media", async () => {
    await deliver({
      text: "Pick one",
      mediaUrls: ["https://example.com/a.jpg", "https://example.com/b.jpg"],
      presentation: approvalPresentation,
    });

    expect(sendMessageMatrixMock).toHaveBeenCalledTimes(2);
    const first = sendMessageMatrixMock.mock.calls[0]?.[2] as Record<string, unknown>;
    const second = sendMessageMatrixMock.mock.calls[1]?.[2] as Record<string, unknown>;
    expect((first.extraContent as Record<string, unknown>)[PRESENTATION_KEY]).toBeDefined();
    expect(second.extraContent).toBeUndefined();
  });

  it("sends the authored text once when the presentation only restates it", async () => {
    // `/status` curates table/context facts into prose with extra diagnostics.
    // Native context support must not replace that authored fallback when tables degrade.
    const authoredText =
      "Status: ok\nUptime: 42s\nReference UTC: 12:00\n\n| agent | state |\n| --- | --- |\n| main | idle |";
    await deliver({
      text: authoredText,
      presentationTextMode: "fallback",
      presentation: {
        blocks: [
          { type: "context", text: "Status: ok · Uptime: 42s" },
          {
            type: "table",
            caption: "Agents",
            headers: ["agent", "state"],
            rows: [["main", "idle"]],
          },
        ],
      },
    });

    expect(sendMessageMatrixMock).toHaveBeenCalledTimes(1);
    const [, text, opts] = sendMessageMatrixMock.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(text).toBe(authoredText);
    expect(opts.extraContent).toBeUndefined();
  });

  it("keeps a context block Matrix renders natively in the event", async () => {
    // Matrix advertises context support, so a context-only presentation is not the
    // fully-degraded case that lets the producer's own prose stand alone.
    await deliver({
      text: "Deploy finished.",
      presentationTextMode: "fallback",
      presentation: {
        blocks: [{ type: "context", text: "took 42s" }],
      },
    });

    const [, text, opts] = sendMessageMatrixMock.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(text).toContain("took 42s");
    expect((opts.extraContent as Record<string, unknown>)[PRESENTATION_KEY]).toMatchObject({
      type: "message.presentation",
      version: 1,
    });
  });

  it("does not repeat prose the fallback text already renders", async () => {
    await deliver({
      text: "Deploy to production?\n\n- Approve\n- Deny",
      presentationTextMode: "fallback",
      presentation: approvalPresentation,
    });

    const [, text] = sendMessageMatrixMock.mock.calls[0] as [string, string];
    expect(text.match(/Approve/g)).toHaveLength(1);
    expect(text.match(/Deploy to production\?/g)).toHaveLength(1);
  });
});
