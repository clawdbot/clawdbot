// Zalo tests cover actions plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { zaloMessageActions } from "./actions.js";
import type { OpenClawConfig } from "./runtime-api.js";

describe("zaloMessageActions.describeMessageTool", () => {
  it("honors the selected Zalo account during discovery", () => {
    const cfg: OpenClawConfig = {
      channels: {
        zalo: {
          enabled: true,
          botToken: "root-token",
          accounts: {
            default: {
              enabled: false,
              botToken: "default-token",
            },
            work: {
              enabled: true,
              botToken: "work-token",
            },
          },
        },
      },
    };

    expect(zaloMessageActions.describeMessageTool?.({ cfg, accountId: "default" })).toBeNull();
    expect(zaloMessageActions.describeMessageTool?.({ cfg, accountId: "work" })).toEqual({
      actions: ["send"],
      capabilities: [],
    });
    expect(zaloMessageActions.supportsAction?.({ action: "send" })).toBe(true);
    expect(zaloMessageActions.supportsAction?.({ action: "react" })).toBe(false);
  });
});

describe("zaloMessageActions.handleAction", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends text to the Bot API when the message tool supplies whitespace-only media", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        ok: true,
        result: { message_id: "z-msg-with-blank-media" },
      }),
    );
    const handleAction = zaloMessageActions.handleAction;
    if (!handleAction) {
      throw new Error("Expected Zalo message action handler");
    }

    await handleAction({
      channel: "zalo",
      action: "send",
      params: {
        to: "dm-chat-blank-media",
        message: "hello there",
        media: "   ",
      },
      cfg: {
        channels: {
          zalo: {
            enabled: true,
            botToken: "test-zalo-token",
          },
        },
      },
      accountId: "default",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://bot-api.zaloplatforms.com/bottest-zalo-token/sendMessage");
    expect(request?.method).toBe("POST");
    expect(JSON.parse(String(request?.body))).toEqual({
      chat_id: "dm-chat-blank-media",
      text: "hello there",
    });
  });
});
