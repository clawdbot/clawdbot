import { describe, expect, it, vi } from "vitest";
import { handleSlackMessageAction } from "./message-action-dispatch.js";

function createInvokeSpy() {
  return vi.fn(async (action: Record<string, unknown>) => ({
    ok: true,
    content: action,
  }));
}

describe("handleSlackMessageAction", () => {
  it("merges presentation and interactive blocks when sending", async () => {
    const invoke = createInvokeSpy();

    await handleSlackMessageAction({
      providerId: "slack",
      ctx: {
        action: "send",
        cfg: {},
        params: {
          to: "channel:C1",
          message: "Deploy?",
          presentation: {
            blocks: [{ type: "text", text: "Deploy summary" }],
          },
          interactive: {
            blocks: [
              {
                type: "buttons",
                buttons: [{ label: "Approve", value: "approve" }],
              },
            ],
          },
        },
      } as never,
      invoke: invoke as never,
    });

    const action = invoke.mock.calls[0]?.[0] as {
      blocks?: Array<{ type?: string; elements?: Array<{ value?: string }> }>;
    };
    expect(action.blocks).toEqual([
      expect.objectContaining({ type: "section" }),
      expect.objectContaining({
        type: "actions",
        elements: [expect.objectContaining({ value: "approve" })],
      }),
    ]);
  });

  it("keeps generated Slack control ids unique when presentation and interactive controls are merged", async () => {
    const invoke = createInvokeSpy();

    await handleSlackMessageAction({
      providerId: "slack",
      ctx: {
        action: "send",
        cfg: {},
        params: {
          to: "channel:C1",
          message: "Deploy?",
          presentation: {
            blocks: [
              {
                type: "buttons",
                buttons: [{ label: "Stage", value: "stage" }],
              },
            ],
          },
          interactive: {
            blocks: [
              {
                type: "buttons",
                buttons: [{ label: "Approve", value: "approve" }],
              },
            ],
          },
        },
      } as never,
      invoke: invoke as never,
    });

    const action = invoke.mock.calls[0]?.[0] as {
      blocks?: Array<{
        block_id?: string;
        elements?: Array<{ action_id?: string; value?: string }>;
      }>;
    };

    expect(action.blocks).toEqual([
      expect.objectContaining({
        block_id: "openclaw_reply_buttons_1",
        elements: [expect.objectContaining({ action_id: "openclaw:reply_button:1:1" })],
      }),
      expect.objectContaining({
        block_id: "openclaw_reply_buttons_2",
        elements: [expect.objectContaining({ action_id: "openclaw:reply_button:2:1" })],
      }),
    ]);
  });

  it("maps upload-file to the internal uploadFile action", async () => {
    const invoke = createInvokeSpy();

    await handleSlackMessageAction({
      providerId: "slack",
      ctx: {
        action: "upload-file",
        cfg: {},
        params: {
          to: "user:U1",
          filePath: "/tmp/report.png",
          initialComment: "fresh build",
          filename: "build.png",
          title: "Build Screenshot",
          threadId: "111.222",
        },
      } as never,
      invoke: invoke as never,
    });

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "uploadFile",
        to: "user:U1",
        filePath: "/tmp/report.png",
        initialComment: "fresh build",
        filename: "build.png",
        title: "Build Screenshot",
        threadTs: "111.222",
      }),
      expect.any(Object),
      undefined,
    );
  });

  it("maps upload-file aliases to upload params", async () => {
    const invoke = createInvokeSpy();

    await handleSlackMessageAction({
      providerId: "slack",
      ctx: {
        action: "upload-file",
        cfg: {},
        params: {
          channelId: "C1",
          media: "/tmp/chart.png",
          message: "chart attached",
          replyTo: "333.444",
        },
      } as never,
      invoke: invoke as never,
    });

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "uploadFile",
        to: "C1",
        filePath: "/tmp/chart.png",
        initialComment: "chart attached",
        threadTs: "333.444",
      }),
      expect.any(Object),
      undefined,
    );
  });

  it("maps upload-file path alias to filePath", async () => {
    const invoke = createInvokeSpy();

    await handleSlackMessageAction({
      providerId: "slack",
      ctx: {
        action: "upload-file",
        cfg: {},
        params: {
          to: "channel:C1",
          path: "/tmp/report.txt",
          initialComment: "path alias",
        },
      } as never,
      invoke: invoke as never,
    });

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "uploadFile",
        to: "channel:C1",
        filePath: "/tmp/report.txt",
        initialComment: "path alias",
      }),
      expect.any(Object),
      undefined,
    );
  });

  it("requires filePath, path, or media for upload-file", async () => {
    await expect(
      handleSlackMessageAction({
        providerId: "slack",
        ctx: {
          action: "upload-file",
          cfg: {},
          params: {
            to: "channel:C1",
          },
        } as never,
        invoke: createInvokeSpy() as never,
      }),
    ).rejects.toThrow(/upload-file requires filePath, path, or media/i);
  });

  it("maps download-file to the internal downloadFile action", async () => {
    const invoke = createInvokeSpy();

    await handleSlackMessageAction({
      providerId: "slack",
      ctx: {
        action: "download-file",
        cfg: {},
        params: {
          channelId: "C1",
          fileId: "F123",
          threadId: "111.222",
        },
      } as never,
      invoke: invoke as never,
    });

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "downloadFile",
        fileId: "F123",
        channelId: "C1",
        threadId: "111.222",
      }),
      expect.any(Object),
    );
  });

  it("maps download-file target aliases to scope fields", async () => {
    const invoke = createInvokeSpy();

    await handleSlackMessageAction({
      providerId: "slack",
      ctx: {
        action: "download-file",
        cfg: {},
        params: {
          to: "channel:C2",
          fileId: "F999",
          replyTo: "333.444",
        },
      } as never,
      invoke: invoke as never,
    });

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "downloadFile",
        fileId: "F999",
        channelId: "channel:C2",
        threadId: "333.444",
      }),
      expect.any(Object),
    );
  });
});
