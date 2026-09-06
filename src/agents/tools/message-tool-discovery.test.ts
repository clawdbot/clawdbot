// Covers session-derived current-channel resolution, including recovery of the
// casing a session recorded when its session key folded the peer id.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { extractDeliveryInfoMock, getChannelPluginMock } = vi.hoisted(() => ({
  extractDeliveryInfoMock: vi.fn(),
  getChannelPluginMock: vi.fn(),
}));

vi.mock("../../config/sessions/delivery-info.js", () => ({
  extractDeliveryInfo: extractDeliveryInfoMock,
}));

vi.mock("../../channels/plugins/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../channels/plugins/index.js")>()),
  getChannelPlugin: getChannelPluginMock,
}));

import { resolveEffectiveCurrentChannelContext } from "./message-tool-discovery.js";

// Google Chat space ids are mixed case and compare case-sensitively, but the
// session key lowercases the peer id for channels outside the case-preservation
// registry.
const CANONICAL_SPACE = "spaces/AAQA1bC2dEf";
const FOLDED_SPACE = "spaces/aaqa1bc2def";
const SESSION_KEY = `agent:main:googlechat:group:${FOLDED_SPACE}`;

describe("resolveEffectiveCurrentChannelContext", () => {
  beforeEach(() => {
    extractDeliveryInfoMock.mockReset();
    extractDeliveryInfoMock.mockReturnValue({ deliveryContext: undefined, threadId: undefined });
    getChannelPluginMock.mockReset();
    // Google Chat declares case-sensitive space ids (extensions/googlechat/src/channel.ts).
    getChannelPluginMock.mockReturnValue({ messaging: { targetIdComparison: "case-sensitive" } });
  });

  it("recovers the canonical space casing from the session's delivery metadata", () => {
    extractDeliveryInfoMock.mockReturnValue({
      deliveryContext: { channel: "googlechat", to: `googlechat:${CANONICAL_SPACE}` },
      threadId: undefined,
    });

    expect(
      resolveEffectiveCurrentChannelContext({
        currentChannelProvider: "webchat",
        agentSessionKey: SESSION_KEY,
      }),
    ).toMatchObject({
      currentChannelProvider: "googlechat",
      currentChannelId: CANONICAL_SPACE,
      currentMessagingTarget: CANONICAL_SPACE,
    });
  });

  it("keeps the session-derived target when no delivery metadata is stored", () => {
    expect(
      resolveEffectiveCurrentChannelContext({
        currentChannelProvider: "webchat",
        agentSessionKey: SESSION_KEY,
      }),
    ).toMatchObject({
      currentChannelId: FOLDED_SPACE,
      currentMessagingTarget: FOLDED_SPACE,
    });
  });

  it("keeps the session-derived target when the stored delivery names another space", () => {
    extractDeliveryInfoMock.mockReturnValue({
      deliveryContext: { channel: "googlechat", to: "googlechat:spaces/ZZZZ9z9Z9Zz" },
      threadId: undefined,
    });

    expect(
      resolveEffectiveCurrentChannelContext({
        currentChannelProvider: "webchat",
        agentSessionKey: SESSION_KEY,
      }),
    ).toMatchObject({
      currentChannelId: FOLDED_SPACE,
      currentMessagingTarget: FOLDED_SPACE,
    });
  });

  it("keeps the session-derived target when the stored delivery names another channel", () => {
    extractDeliveryInfoMock.mockReturnValue({
      deliveryContext: { channel: "slack", to: `slack:${CANONICAL_SPACE}` },
      threadId: undefined,
    });

    expect(
      resolveEffectiveCurrentChannelContext({
        currentChannelProvider: "webchat",
        agentSessionKey: SESSION_KEY,
      }),
    ).toMatchObject({
      currentChannelId: FOLDED_SPACE,
      currentMessagingTarget: FOLDED_SPACE,
    });
  });

  it("does not read session storage for a channel with lowercase-canonical ids", () => {
    getChannelPluginMock.mockReturnValue({ messaging: { targetIdComparison: "lowercase" } });

    expect(
      resolveEffectiveCurrentChannelContext({
        currentChannelProvider: "webchat",
        agentSessionKey: SESSION_KEY,
      }),
    ).toMatchObject({
      currentChannelId: FOLDED_SPACE,
      currentMessagingTarget: FOLDED_SPACE,
    });
    expect(extractDeliveryInfoMock).not.toHaveBeenCalled();
  });

  it("leaves an inbound non-internal provider untouched", () => {
    expect(
      resolveEffectiveCurrentChannelContext({
        currentChannelProvider: "googlechat",
        currentChannelId: CANONICAL_SPACE,
        currentMessagingTarget: CANONICAL_SPACE,
        agentSessionKey: SESSION_KEY,
      }),
    ).toMatchObject({
      currentChannelProvider: "googlechat",
      currentChannelId: CANONICAL_SPACE,
      currentMessagingTarget: CANONICAL_SPACE,
    });
    expect(extractDeliveryInfoMock).not.toHaveBeenCalled();
  });
});
