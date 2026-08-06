// Imessage tests cover message tool api plugin behavior.
import { beforeEach, describe, expect, it } from "vitest";
import { describeMessageTool } from "../message-tool-api.js";
import {
  getCachedIMessagePrivateApiStatus,
  setCachedIMessagePrivateApiStatus,
} from "./private-api-status.js";

function expireCachedPrivateApiStatus(): void {
  setCachedIMessagePrivateApiStatus(
    "imsg",
    { available: false, v2Ready: false, selectors: {}, rpcMethods: [] },
    1,
  );
  getCachedIMessagePrivateApiStatus("imsg");
}

describe("iMessage message-tool artifact", () => {
  beforeEach(() => {
    expireCachedPrivateApiStatus();
  });

  it("keeps poll actions discoverable until the first lazy bridge probe", () => {
    const discovery = describeMessageTool({
      cfg: { channels: { imessage: { cliPath: "imsg" } } } as never,
      currentChannelId: "chat_id:1",
    });

    expect(discovery?.actions).toContain("poll");
    expect(discovery?.actions).toContain("poll-vote");
    expect(discovery?.schema).toMatchObject({
      actions: ["poll-vote"],
      visibility: "all-configured",
      properties: { pollOptionText: { type: "string" } },
    });
  });

  it("exposes lightweight discovery without loading the channel plugin", () => {
    setCachedIMessagePrivateApiStatus("imsg", {
      available: true,
      v2Ready: true,
      selectors: {
        editMessage: true,
        retractMessagePart: true,
      },
      rpcMethods: [],
    });

    const discovery = describeMessageTool({
      cfg: {
        channels: {
          imessage: {
            cliPath: "imsg",
            actions: {
              edit: false,
            },
          },
        },
      } as never,
      currentChannelId: "chat_id:1",
    });

    expect(discovery?.actions).toStrictEqual([
      "react",
      "unsend",
      "reply",
      "sendWithEffect",
      "renameGroup",
      "setGroupIcon",
      "addParticipant",
      "removeParticipant",
      "leaveGroup",
      "upload-file",
    ]);
  });

  it("offers poll but hides poll-vote on imsg builds without the poll.vote rpc", () => {
    setCachedIMessagePrivateApiStatus("imsg", {
      available: true,
      v2Ready: true,
      selectors: { pollPayloadMessage: true, pollVoteMessage: true },
      rpcMethods: [],
    });

    const discovery = describeMessageTool({
      cfg: { channels: { imessage: { cliPath: "imsg" } } } as never,
      currentChannelId: "chat_id:1",
    });

    expect(discovery?.actions).toContain("poll");
    expect(discovery?.actions).not.toContain("poll-vote");
    expect(discovery?.schema).toBeUndefined();
  });

  it("hides poll-vote when only the poll creation selector is available", () => {
    setCachedIMessagePrivateApiStatus("imsg", {
      available: true,
      v2Ready: true,
      selectors: { pollPayloadMessage: true },
      rpcMethods: ["send", "poll.send", "poll.vote"],
    });

    const discovery = describeMessageTool({
      cfg: { channels: { imessage: { cliPath: "imsg" } } } as never,
      currentChannelId: "chat_id:1",
    });

    expect(discovery?.actions).toContain("poll");
    expect(discovery?.actions).not.toContain("poll-vote");
  });

  it("offers poll-vote once imsg advertises the poll.vote rpc", () => {
    setCachedIMessagePrivateApiStatus("imsg", {
      available: true,
      v2Ready: true,
      selectors: { pollPayloadMessage: true, pollVoteMessage: true },
      rpcMethods: ["send", "poll.send", "poll.vote", "messages.poll.vote"],
    });

    const discovery = describeMessageTool({
      cfg: { channels: { imessage: { cliPath: "imsg" } } } as never,
      currentChannelId: "chat_id:1",
    });

    expect(discovery?.actions).toContain("poll");
    expect(discovery?.actions).toContain("poll-vote");
  });

  it("hides private actions when cached bridge status is unavailable", () => {
    setCachedIMessagePrivateApiStatus("imsg", {
      available: false,
      v2Ready: false,
      selectors: {},
      rpcMethods: [],
    });

    const discovery = describeMessageTool({
      cfg: {
        channels: {
          imessage: {
            cliPath: "imsg",
          },
        },
      } as never,
      currentChannelId: "chat_id:1",
    });

    expect(discovery?.actions).toStrictEqual([]);
  });
});
