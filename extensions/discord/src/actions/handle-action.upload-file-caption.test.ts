// Discord tests cover upload-file caption text resolution.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtimeModule = await import("./runtime.js");
const handleDiscordActionMock = vi
  .spyOn(runtimeModule, "handleDiscordAction")
  .mockResolvedValue({ content: [], details: { ok: true } });
const { handleDiscordMessageAction } = await import("./handle-action.js");

function discordConfig(): OpenClawConfig {
  return {
    channels: { discord: { token: "tok" } },
  } as OpenClawConfig;
}

function expectUploadedContent(expected: string) {
  expect(handleDiscordActionMock).toHaveBeenCalledTimes(1);
  const [call] = handleDiscordActionMock.mock.calls;
  if (!call) {
    throw new Error("expected Discord action call");
  }
  const [payload] = call;
  expect(payload).toMatchObject({
    action: "sendMessage",
    to: "channel:123",
    mediaUrl: "/tmp/agent-root/chart.png",
    content: expected,
  });
}

describe("handleDiscordMessageAction upload-file caption", () => {
  beforeEach(() => {
    handleDiscordActionMock.mockClear();
  });

  it.each([
    {
      name: "maps a caption to the uploaded message content",
      params: { caption: "chart attached" },
      expected: "chart attached",
    },
    {
      name: "prefers an explicit message over a caption",
      params: { message: "message text", caption: "caption text" },
      expected: "message text",
    },
    {
      name: "keeps an explicitly empty message empty instead of using the caption",
      params: { message: "", caption: "caption text" },
      expected: "",
    },
  ])("$name", async ({ params, expected }) => {
    const mediaReadFile = vi.fn(async () => Buffer.from("image"));
    const cfg = discordConfig();

    await handleDiscordMessageAction({
      action: "upload-file",
      params: {
        target: "channel:123",
        media: "/tmp/agent-root/chart.png",
        ...params,
      },
      cfg,
      mediaAccess: { localRoots: ["/tmp/agent-root"], readFile: mediaReadFile },
      mediaLocalRoots: ["/tmp/agent-root"],
      mediaReadFile,
    });

    expectUploadedContent(expected);
  });
});
