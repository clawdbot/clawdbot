// Msteams tests cover personal-chat media identifier routing.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../runtime-api.js";
import type { resolveMSTeamsInboundMedia } from "./inbound-media.js";
import "./message-handler-mock-support.test-support.js";

const inboundMediaMockState = vi.hoisted(() => ({
  resolve: vi.fn<typeof resolveMSTeamsInboundMedia>(),
}));

vi.mock("./inbound-media.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./inbound-media.js")>();
  return {
    ...actual,
    resolveMSTeamsInboundMedia: inboundMediaMockState.resolve,
  };
});

import { createMSTeamsMessageHandler } from "./message-handler.js";
import { buildChannelActivity, createMessageHandlerDeps } from "./message-handler.test-support.js";

const cfg = {
  channels: { msteams: { dmPolicy: "open", allowFrom: ["*"] } },
} as OpenClawConfig;

function buildPersonalAttachmentActivity() {
  return buildChannelActivity({
    text: "please inspect this file",
    conversation: { id: "a:bot-framework-dm", conversationType: "personal" },
    channelData: {},
    attachments: [
      {
        contentType: "text/html",
        content: '<div><attachment id="attachment-1"></attachment></div>',
      },
    ],
    entities: [],
  });
}

function firstInboundMediaParams(): Record<string, unknown> {
  const [call] = inboundMediaMockState.resolve.mock.calls;
  if (!call?.[0] || typeof call[0] !== "object") {
    throw new Error("expected inbound media parameters");
  }
  return call[0] as Record<string, unknown>;
}

describe("msteams personal media identifier routing", () => {
  beforeEach(() => {
    inboundMediaMockState.resolve.mockReset();
    inboundMediaMockState.resolve.mockResolvedValue([]);
  });

  it("preserves the raw Bot Framework ID for personal attachment recovery", async () => {
    const { deps } = createMessageHandlerDeps(cfg);
    const handler = createMSTeamsMessageHandler(deps);

    await handler({
      activity: buildPersonalAttachmentActivity(),
      sendActivity: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof handler>[0]);

    const params = firstInboundMediaParams();
    expect(params).toMatchObject({ conversationId: "a:bot-framework-dm" });
    expect(params).not.toHaveProperty("graphChatId");
  });
});
