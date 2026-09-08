import { beforeEach, describe, expect, it, vi } from "vitest";

const { readDeliveryMock, getChannelPluginMock } = vi.hoisted(() => ({
  readDeliveryMock: vi.fn(),
  getChannelPluginMock: vi.fn(),
}));

vi.mock("../../config/sessions/delivery-info.js", () => ({
  readExactSessionDeliveryContext: readDeliveryMock,
}));
vi.mock("../../channels/plugins/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../channels/plugins/index.js")>()),
  getChannelPlugin: getChannelPluginMock,
}));

import type { PreparedMessageToolCatalog } from "../../channels/plugins/message-action-discovery.js";
import {
  buildMessageToolDescription,
  buildMessageToolSchema,
  resolveMessageToolActionSchemaActions,
  resolveEffectiveCurrentChannelContext,
} from "./message-tool-discovery.js";

const canonicalSpace = "spaces/AAQA1bC2dEf";
const foldedSpace = "spaces/aaqa1bc2def";
const options = {
  currentChannelProvider: "webchat",
  agentSessionKey: `agent:main:googlechat:group:${foldedSpace}`,
};
const request = { config: {}, action: "send" as const, params: {} };

describe("session-derived message destinations", () => {
  beforeEach(() => {
    readDeliveryMock.mockReset();
    readDeliveryMock.mockReturnValue({
      channel: "googlechat",
      to: `googlechat:${canonicalSpace}`,
      accountId: "default",
    });
    getChannelPluginMock.mockReset();
    getChannelPluginMock.mockReturnValue({
      config: { listAccountIds: () => ["default"] },
      messaging: { targetIdComparison: "case-sensitive" },
    });
  });

  it("uses the current session's canonical destination without changing the route", () => {
    expect(resolveEffectiveCurrentChannelContext(options, request)).toEqual({
      accountId: undefined,
      currentChannelProvider: "googlechat",
      currentChannelId: canonicalSpace,
      currentMessagingTarget: canonicalSpace,
      currentChatType: "group",
      currentThreadTs: undefined,
    });
  });

  it.each([
    { name: "missing delivery", delivery: undefined },
    { name: "another channel", delivery: { channel: "slack", to: canonicalSpace } },
    { name: "another peer", delivery: { channel: "googlechat", to: "spaces/Other" } },
    {
      name: "another account",
      delivery: { channel: "googlechat", to: canonicalSpace, accountId: "other" },
    },
  ])("keeps the inferred destination for $name", ({ delivery }) => {
    readDeliveryMock.mockReturnValue(delivery);
    expect(resolveEffectiveCurrentChannelContext(options, request).currentMessagingTarget).toBe(
      foldedSpace,
    );
  });

  it.each([
    { target: "spaces/Explicit" },
    { to: "spaces/Explicit" },
    { channelId: "spaces/Explicit" },
    { targets: ["spaces/Explicit"] },
  ])("does not recover an explicitly addressed action %j", (params) => {
    expect(
      resolveEffectiveCurrentChannelContext(options, { ...request, params }).currentMessagingTarget,
    ).toBe(foldedSpace);
    expect(readDeliveryMock).not.toHaveBeenCalled();
  });

  it("does not read delivery while discovering a reusable tool", () => {
    resolveEffectiveCurrentChannelContext(options);
    expect(readDeliveryMock).not.toHaveBeenCalled();
  });

  it("keeps lowercase-canonical channels free of delivery reads", () => {
    getChannelPluginMock.mockReturnValue({ messaging: { targetIdComparison: "lowercase" } });
    expect(resolveEffectiveCurrentChannelContext(options, request).currentMessagingTarget).toBe(
      foldedSpace,
    );
    expect(readDeliveryMock).not.toHaveBeenCalled();
  });

  it("keeps a normal inbound destination", () => {
    const inbound = {
      ...options,
      currentChannelProvider: "googlechat",
      currentChannelId: canonicalSpace,
    };
    expect(resolveEffectiveCurrentChannelContext(inbound, request).currentChannelId).toBe(
      canonicalSpace,
    );
    expect(readDeliveryMock).not.toHaveBeenCalled();
  });

  it("preserves the account and thread encoded by a direct route", () => {
    readDeliveryMock.mockReturnValue({
      channel: "googlechat",
      to: canonicalSpace,
      accountId: "work",
    });
    const direct = {
      ...options,
      agentSessionKey: `agent:main:googlechat:work:direct:${foldedSpace}:thread:Thread1`,
    };
    expect(
      resolveEffectiveCurrentChannelContext(direct, { ...request, accountId: "work" }),
    ).toMatchObject({
      accountId: "work",
      currentChatType: "direct",
      currentThreadTs: "Thread1",
      currentChannelId: canonicalSpace,
      currentMessagingTarget: canonicalSpace,
    });
  });
});

describe("message tool discovery cache stability", () => {
  it.each([
    { allow: undefined, expected: ["poll", "poll-vote", "react", "send"] },
    { allow: ["send", "react", "poll", "react"], expected: ["poll", "react", "send"] },
    { allow: ["read", "edit", "read"], expected: ["edit", "read"] },
  ])("keeps schema bytes stable across channel discovery order ($allow)", ({ allow, expected }) => {
    const channels: PreparedMessageToolCatalog["channels"] = [
      {
        id: "telegram",
        reconcilesUnknownSend: false,
        actions: { describeMessageTool: () => ({ actions: ["send", "react", "poll"] }) },
      },
      {
        id: "discord",
        reconcilesUnknownSend: false,
        actions: { describeMessageTool: () => ({ actions: ["send", "poll", "poll-vote"] }) },
      },
    ];
    const createTool = (
      orderedChannels: PreparedMessageToolCatalog["channels"],
      currentChannelProvider: string,
    ) => {
      const params = {
        cfg: { tools: { message: { actions: { allow } } } },
        currentChannelProvider,
        preparedMessageToolCatalog: {
          version: 1,
          channels: orderedChannels,
          getChannel: (id: string) => orderedChannels.find((channel) => channel.id === id),
        },
      };
      const actions = resolveMessageToolActionSchemaActions(params);
      return {
        parameters: buildMessageToolSchema(params, actions),
        description: buildMessageToolDescription(actions),
      };
    };
    const tools = [
      createTool(channels, "telegram"),
      createTool(channels.toReversed(), "discord"),
    ] as const;

    expect(tools[0].description).toBe(tools[1].description);
    expect(JSON.stringify(tools[0].parameters)).toBe(JSON.stringify(tools[1].parameters));
    for (const tool of tools) {
      expect(tool.parameters.properties.action).toMatchObject({ enum: expected });
      if (allow) {
        expect(tool.description).not.toContain("poll-vote");
      }
    }
  });
});
