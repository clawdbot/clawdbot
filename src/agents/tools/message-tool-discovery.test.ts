import { describe, expect, it } from "vitest";
import type { PreparedMessageToolCatalog } from "../../channels/plugins/message-action-discovery.js";
import {
  buildMessageToolDescription,
  buildMessageToolSchema,
  resolveMessageToolActionSchemaActions,
} from "./message-tool-discovery.js";

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
