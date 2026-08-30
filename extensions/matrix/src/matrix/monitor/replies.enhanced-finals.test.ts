// Matrix tests cover replies plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime, RuntimeEnv } from "../../../runtime-api.js";
import {
  MATRIX_PREVIEW_PROTOCOL_KEY,
  type MatrixOpenClawPreviewMarker,
} from "../preview-protocol.js";
import type { MatrixClient } from "../sdk.js";

const sendMessageMatrixMock = vi.hoisted(() => vi.fn());
const chunkMatrixTextMock = vi.hoisted(() =>
  vi.fn((text: string, _opts?: unknown) => ({
    trimmedText: text.trim(),
    convertedText: text,
    singleEventLimit: 4000,
    fitsInSingleEvent: true,
    chunks: text ? [text] : [],
  })),
);

vi.mock("../send.js", () => ({
  chunkMatrixText: (text: string, opts?: unknown) => chunkMatrixTextMock(text, opts),
  sendMessageMatrix: (to: string, message: string, opts?: unknown) =>
    sendMessageMatrixMock(to, message, opts),
}));

vi.mock("../accounts.js", () => ({
  listMatrixAccountIds: () => ["alpha", "beta"],
  resolveMatrixAccount: ({ accountId }: { accountId: string }) => ({
    accountId,
    enabled: true,
    configured: true,
  }),
}));

vi.mock("./route.js", () => ({
  resolveMatrixInboundRoute: ({ accountId }: { accountId: string }) => ({
    route: {
      accountId,
      agentId: `agent-${accountId}`,
      sessionKey: `agent:${accountId}:main`,
    },
  }),
}));

import { setMatrixRuntime } from "../../runtime.js";
import { deliverMatrixReplies } from "./replies.js";
import { createMatrixTurnTakingCoordinator } from "./turn-taking-coordinator.js";

let nextMessageId = 0;

async function resolveMockMatrixSend(_to: string, message: string, opts?: Record<string, unknown>) {
  nextMessageId += 1;
  const messageId = `mx-${nextMessageId}`;
  const mediaUrl = typeof opts?.mediaUrl === "string" ? opts.mediaUrl : "unknown";
  const content = message || `media:${mediaUrl}`;
  const result = {
    messageId,
    roomId: "room:1",
    primaryMessageId: messageId,
    receipt: {
      primaryPlatformMessageId: messageId,
      platformMessageIds: [messageId],
      parts: [{ platformMessageId: messageId, kind: "text" as const, index: 0 }],
      sentAt: 1,
    },
    content,
  };
  const onDeliveryResult = opts?.onDeliveryResult;
  if (typeof onDeliveryResult === "function") {
    await onDeliveryResult(result);
  }
  return result;
}

function sendCall(index: number) {
  const call = sendMessageMatrixMock.mock.calls.at(index);
  if (!call) {
    throw new Error(`Expected send call at index ${index}`);
  }
  return call;
}

function sendOptions(index: number): Record<string, unknown> {
  const options = sendCall(index)[2];
  if (!options || typeof options !== "object") {
    throw new Error(`Expected send options at call ${index}`);
  }
  return options as Record<string, unknown>;
}

function registerCoordinatorMonitor(
  coordinator: ReturnType<typeof createMatrixTurnTakingCoordinator>,
  accountId: string,
  joined: string[],
) {
  coordinator.registerMonitor({
    accountId,
    userId: `@${accountId}:example.org`,
    homeserver: "https://matrix.example.org",
    client: {
      getJoinedRoomMembers: vi.fn(async () => joined),
      getEvent: vi.fn(),
      getRelations: vi.fn(),
    } as never,
    core: {
      channel: { routing: { resolveAgentRoute: vi.fn() } },
      agent: {
        resolveAgentIdentity: (_cfg: unknown, agentId: string) => ({ name: agentId.toUpperCase() }),
      },
    } as never,
    log: vi.fn(),
  });
}

describe("deliverMatrixReplies", () => {
  const cfg = { channels: { matrix: {} } };
  const loadConfigMock = vi.fn(() => ({}));
  const resolveMarkdownTableModeMock = vi.fn<(params: unknown) => string>(() => "code");
  const convertMarkdownTablesMock = vi.fn((text: string) => text);
  const resolveChunkModeMock = vi.fn<
    (cfg: unknown, channel: unknown, accountId?: unknown) => string
  >(() => "length");
  const chunkMarkdownTextWithModeMock = vi.fn((text: string) => [text]);

  const runtimeStub = {
    config: {
      current: () => loadConfigMock(),
    },
    channel: {
      text: {
        resolveMarkdownTableMode: (params: unknown) => resolveMarkdownTableModeMock(params),
        resolveTextChunkLimit: () => 4000,
        convertMarkdownTables: (text: string) => convertMarkdownTablesMock(text),
        resolveChunkMode: (cfgLocal: unknown, channel: unknown, accountId?: unknown) =>
          resolveChunkModeMock(cfgLocal, channel, accountId),
        chunkMarkdownTextWithMode: (text: string) => chunkMarkdownTextWithModeMock(text),
      },
    },
    logging: {
      shouldLogVerbose: () => false,
    },
  } as unknown as PluginRuntime;

  const runtimeEnv: RuntimeEnv = {
    log: vi.fn(),
    error: vi.fn(),
  } as unknown as RuntimeEnv;

  beforeEach(() => {
    vi.clearAllMocks();
    nextMessageId = 0;
    sendMessageMatrixMock.mockReset().mockImplementation(resolveMockMatrixSend);
    setMatrixRuntime(runtimeStub);
    chunkMatrixTextMock.mockReset().mockImplementation((text: string) => ({
      trimmedText: text.trim(),
      convertedText: text,
      singleEventLimit: 4000,
      fitsInSingleEvent: true,
      chunks: text ? [text] : [],
    }));
  });
  it("marks chunked text as one correlated standalone final", async () => {
    chunkMatrixTextMock.mockImplementation((text: string) => ({
      trimmedText: text.trim(),
      convertedText: text,
      singleEventLimit: 4,
      fitsInSingleEvent: false,
      chunks: text.split("|"),
    }));
    const onAcceptedPart = vi.fn();
    const onLogicalFinalAccepted = vi.fn();
    await expect(
      deliverMatrixReplies({
        cfg,
        replies: [{ text: "first|second" }],
        roomId: "room:enhanced",
        client: { redactEvent: vi.fn() } as unknown as MatrixClient,
        runtime: runtimeEnv,
        replyToMode: "off",
        enhancedFinalProtocol: {
          triggerEventId: "$trigger",
          createResponseId: () => "response-multipart",
          onLogicalFinalAccepted,
          onAcceptedPart,
          onAbandoned: vi.fn(),
        },
      }),
    ).resolves.toMatchObject({ content: "first\nsecond" });

    const firstMarker = (sendOptions(0).extraContent as Record<string, unknown>)[
      MATRIX_PREVIEW_PROTOCOL_KEY
    ];
    const secondMarker = (sendOptions(1).extraContent as Record<string, unknown>)[
      MATRIX_PREVIEW_PROTOCOL_KEY
    ];
    expect(firstMarker).toMatchObject({
      responseId: "response-multipart",
      state: "final",
      partIndex: 0,
      partCount: 2,
    });
    expect(secondMarker).toMatchObject({
      responseId: "response-multipart",
      state: "final",
      partIndex: 1,
      partCount: 2,
    });
    expect(onAcceptedPart).toHaveBeenCalledTimes(2);
    expect(onLogicalFinalAccepted).toHaveBeenCalledExactlyOnceWith({
      responseId: "response-multipart",
    });
  });

  it("materializes a location-only host final into a visible authenticated Matrix final", async () => {
    const onAcceptedPart = vi.fn();
    const onLogicalFinalAccepted = vi.fn();

    await expect(
      deliverMatrixReplies({
        cfg,
        replies: [{ location: { latitude: 31.778, longitude: 35.235 } }],
        roomId: "room:enhanced",
        client: { redactEvent: vi.fn() } as unknown as MatrixClient,
        runtime: runtimeEnv,
        replyToMode: "off",
        enhancedFinalProtocol: {
          triggerEventId: "$trigger",
          createResponseId: () => "response-location",
          onLogicalFinalAccepted,
          onAcceptedPart,
          onAbandoned: vi.fn(),
        },
      }),
    ).resolves.toMatchObject({
      visibleReplySent: true,
      content: "📍 31.778000, 35.235000",
    });

    expect(sendCall(0)[1]).toBe("📍 31.778000, 35.235000");
    expect(
      (sendOptions(0).extraContent as Record<string, unknown>)[MATRIX_PREVIEW_PROTOCOL_KEY],
    ).toMatchObject({
      responseId: "response-location",
      state: "final",
      partIndex: 0,
      partCount: 1,
    });
    expect(onAcceptedPart).toHaveBeenCalledOnce();
    expect(onLogicalFinalAccepted).toHaveBeenCalledExactlyOnceWith({
      responseId: "response-location",
    });
  });

  it("materializes a presentation-only host final with native Matrix metadata", async () => {
    const presentation = {
      title: "Choose one",
      blocks: [
        {
          type: "buttons" as const,
          buttons: [{ label: "Yes", value: "yes" }],
        },
      ],
    };

    await deliverMatrixReplies({
      cfg,
      replies: [{ presentation }],
      roomId: "room:enhanced",
      client: { redactEvent: vi.fn() } as unknown as MatrixClient,
      runtime: runtimeEnv,
      replyToMode: "off",
      enhancedFinalProtocol: {
        triggerEventId: "$trigger",
        createResponseId: () => "response-presentation",
        onLogicalFinalAccepted: vi.fn(),
        onAcceptedPart: vi.fn(),
        onAbandoned: vi.fn(),
      },
    });

    expect(String(sendCall(0)[1])).toContain("Choose one");
    const extraContent = sendOptions(0).extraContent as Record<string, unknown>;
    expect(extraContent["com.openclaw.presentation"]).toEqual({
      ...presentation,
      version: 1,
      type: "message.presentation",
    });
    expect(extraContent[MATRIX_PREVIEW_PROTOCOL_KEY]).toMatchObject({
      responseId: "response-presentation",
      state: "final",
    });
  });

  it("indexes only deliverable final chunks contiguously so the receiver can promote them", async () => {
    chunkMatrixTextMock.mockImplementation((text: string) => ({
      trimmedText: text.trim(),
      convertedText: text,
      singleEventLimit: 4,
      fitsInSingleEvent: false,
      chunks: ["first", " \n\t ", "second", "\t"],
    }));
    const onLogicalFinalAccepted = vi.fn();
    await deliverMatrixReplies({
      cfg,
      replies: [{ text: "first and second" }],
      roomId: "!whitespace-final:example.org",
      client: { redactEvent: vi.fn() } as unknown as MatrixClient,
      runtime: runtimeEnv,
      replyToMode: "off",
      enhancedFinalProtocol: {
        triggerEventId: "$trigger",
        createResponseId: () => "response-whitespace",
        onLogicalFinalAccepted,
        onAcceptedPart: vi.fn(),
        onAbandoned: vi.fn(),
      },
    });

    expect(sendMessageMatrixMock).toHaveBeenCalledTimes(2);
    const markers = [0, 1].map(
      (index) =>
        (sendOptions(index).extraContent as Record<string, unknown>)[
          MATRIX_PREVIEW_PROTOCOL_KEY
        ] as MatrixOpenClawPreviewMarker,
    );
    expect(markers.map((marker) => marker.partIndex)).toEqual([0, 1]);
    expect(markers.map((marker) => marker.partCount)).toEqual([2, 2]);
    expect(onLogicalFinalAccepted).toHaveBeenCalledExactlyOnceWith({
      responseId: "response-whitespace",
    });

    const coordinator = createMatrixTurnTakingCoordinator();
    const joined = ["@alpha:example.org", "@beta:example.org"];
    registerCoordinatorMonitor(coordinator, "alpha", joined);
    registerCoordinatorMonitor(coordinator, "beta", joined);
    const receiverEvent = (index: number) => ({
      event_id: `mx-${index + 1}`,
      sender: "@alpha:example.org",
      type: "m.room.message",
      origin_server_ts: Date.now(),
      content: {
        msgtype: "m.text",
        body: String(sendCall(index)[1]),
        ...(sendOptions(index).extraContent as Record<string, unknown>),
      },
    });
    await expect(
      coordinator.interceptPreviewEvent({
        cfg: cfg as never,
        roomId: "!whitespace-final:example.org",
        accountId: "beta",
        event: receiverEvent(0),
      }),
    ).resolves.toEqual({ kind: "consume", reason: "standalone final awaiting parts" });
    await expect(
      coordinator.interceptPreviewEvent({
        cfg: cfg as never,
        roomId: "!whitespace-final:example.org",
        accountId: "beta",
        event: receiverEvent(1),
      }),
    ).resolves.toMatchObject({
      kind: "promote",
      event: { event_id: "mx-1", content: { body: "first\nsecond" } },
    });
  });

  it("tombstones and redacts an incomplete standalone multipart send", async () => {
    chunkMatrixTextMock.mockImplementation((text: string) => ({
      trimmedText: text.trim(),
      convertedText: text,
      singleEventLimit: 4,
      fitsInSingleEvent: false,
      chunks: text.split("|"),
    }));
    let attempts = 0;
    sendMessageMatrixMock.mockImplementation(async (...args: unknown[]) => {
      attempts += 1;
      if (attempts === 2) {
        throw new Error("second part failed");
      }
      return await resolveMockMatrixSend(
        String(args[0]),
        String(args[1]),
        args[2] as Record<string, unknown> | undefined,
      );
    });
    const onAbandoned = vi.fn();
    const redactEvent = vi.fn().mockResolvedValue("$redaction");

    await expect(
      deliverMatrixReplies({
        cfg,
        replies: [{ text: "first|second" }],
        roomId: "room:enhanced",
        client: { redactEvent } as unknown as MatrixClient,
        runtime: runtimeEnv,
        replyToMode: "off",
        enhancedFinalProtocol: {
          triggerEventId: "$trigger",
          createResponseId: () => "response-partial",
          onAcceptedPart: vi.fn(),
          onAbandoned,
        },
      }),
    ).rejects.toMatchObject({ code: "CHANNEL_PARTIAL_DELIVERY" });
    expect(onAbandoned).toHaveBeenCalledWith({
      responseId: "response-partial",
      sourceEventIds: ["mx-1"],
    });
    expect(redactEvent).toHaveBeenCalledWith("room:enhanced", "mx-1", "Incomplete enhanced final");
  });

  it("fails closed before sending an unbounded enhanced multipart final", async () => {
    chunkMatrixTextMock.mockImplementation((text: string) => ({
      trimmedText: text.trim(),
      convertedText: text,
      singleEventLimit: 1,
      fitsInSingleEvent: false,
      chunks: Array.from({ length: 65 }, (_, index) => String(index)),
    }));
    await expect(
      deliverMatrixReplies({
        cfg,
        replies: [{ text: "too large" }],
        roomId: "room:enhanced",
        client: { redactEvent: vi.fn() } as unknown as MatrixClient,
        runtime: runtimeEnv,
        replyToMode: "off",
        enhancedFinalProtocol: {
          triggerEventId: "$trigger",
          onAcceptedPart: vi.fn(),
          onAbandoned: vi.fn(),
        },
      }),
    ).rejects.toThrow("maximum is 64");
    expect(sendMessageMatrixMock).not.toHaveBeenCalled();
  });

  it("sends one authenticated text final and non-triggering ancillary media", async () => {
    const onAcceptedPart = vi.fn();
    await deliverMatrixReplies({
      cfg,
      replies: [
        {
          text: "Here is the recording",
          mediaUrls: ["https://example.com/a.mp3", "https://example.com/b.mp3"],
          audioAsVoice: true,
        },
      ],
      roomId: "room:enhanced",
      client: { redactEvent: vi.fn() } as unknown as MatrixClient,
      runtime: runtimeEnv,
      replyToMode: "off",
      enhancedFinalProtocol: {
        triggerEventId: "$trigger",
        createResponseId: () => "response-media",
        onAcceptedPart,
        onAbandoned: vi.fn(),
      },
    });

    expect(sendMessageMatrixMock).toHaveBeenCalledTimes(3);
    expect(sendCall(0)[1]).toBe("Here is the recording");
    expect(
      (sendOptions(0).extraContent as Record<string, unknown>)[MATRIX_PREVIEW_PROTOCOL_KEY],
    ).toMatchObject({ state: "final", responseId: "response-media" });
    expect(sendCall(1)[1]).toBe("");
    expect(
      (sendOptions(1).extraContent as Record<string, unknown>)[MATRIX_PREVIEW_PROTOCOL_KEY],
    ).toMatchObject({ state: "ancillary", responseId: "response-media" });
    expect(
      (sendOptions(2).extraContent as Record<string, unknown>)[MATRIX_PREVIEW_PROTOCOL_KEY],
    ).toMatchObject({ state: "ancillary", responseId: "response-media" });
    expect(onAcceptedPart).toHaveBeenCalledOnce();
  });

  it("marks later reply payloads ancillary after one logical final", async () => {
    const onAcceptedPart = vi.fn();
    await deliverMatrixReplies({
      cfg,
      replies: [{ text: "The answer" }, { mediaUrl: "https://example.com/result.png" }],
      roomId: "room:enhanced",
      client: { redactEvent: vi.fn() } as unknown as MatrixClient,
      runtime: runtimeEnv,
      replyToMode: "off",
      enhancedFinalProtocol: {
        triggerEventId: "$trigger",
        createResponseId: () => "response-one-final",
        onAcceptedPart,
        onAbandoned: vi.fn(),
      },
    });

    expect(sendMessageMatrixMock).toHaveBeenCalledTimes(2);
    expect(
      (sendOptions(0).extraContent as Record<string, unknown>)[MATRIX_PREVIEW_PROTOCOL_KEY],
    ).toMatchObject({ state: "final", responseId: "response-one-final" });
    expect(
      (sendOptions(1).extraContent as Record<string, unknown>)[MATRIX_PREVIEW_PROTOCOL_KEY],
    ).toMatchObject({ state: "ancillary", responseId: "response-one-final" });
    expect(onAcceptedPart).toHaveBeenCalledOnce();
  });

  it("uses a media-only payload as the one logical final", async () => {
    const onAcceptedPart = vi.fn();
    await deliverMatrixReplies({
      cfg,
      replies: [{ mediaUrl: "https://example.com/answer.mp3", audioAsVoice: true }],
      roomId: "room:enhanced",
      client: { redactEvent: vi.fn() } as unknown as MatrixClient,
      runtime: runtimeEnv,
      replyToMode: "off",
      enhancedFinalProtocol: {
        triggerEventId: "$trigger",
        createResponseId: () => "response-media-only",
        onAcceptedPart,
        onAbandoned: vi.fn(),
      },
    });

    expect(sendMessageMatrixMock).toHaveBeenCalledOnce();
    expect(
      (sendOptions(0).extraContent as Record<string, unknown>)[MATRIX_PREVIEW_PROTOCOL_KEY],
    ).toMatchObject({
      state: "final",
      responseId: "response-media-only",
      partIndex: 0,
      partCount: 1,
    });
    expect(onAcceptedPart).toHaveBeenCalledOnce();
  });

  it("does not retry an accepted final when its local observer rejects", async () => {
    const redactEvent = vi.fn();
    await expect(
      deliverMatrixReplies({
        cfg,
        replies: [{ text: "accepted exactly once" }],
        roomId: "room:enhanced",
        client: { redactEvent } as unknown as MatrixClient,
        runtime: runtimeEnv,
        replyToMode: "off",
        enhancedFinalProtocol: {
          triggerEventId: "$trigger",
          onAcceptedPart: vi.fn(async () => {
            throw new Error("journal unavailable");
          }),
          onAbandoned: vi.fn(),
        },
      }),
    ).resolves.toMatchObject({ visibleReplySent: true, content: "accepted exactly once" });
    expect(sendMessageMatrixMock).toHaveBeenCalledOnce();
    expect(redactEvent).not.toHaveBeenCalled();
  });
});
