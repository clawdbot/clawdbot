import { beforeEach, describe, expect, it } from "vitest";
import { describeMessageTool } from "../message-tool-api.js";
import {
  clearCachedIMessagePrivateApiStatus,
  setCachedIMessagePrivateApiStatus,
} from "./private-api-status.js";

describe("iMessage message-tool artifact", () => {
  beforeEach(() => {
    clearCachedIMessagePrivateApiStatus();
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
