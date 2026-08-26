import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime, RuntimeEnv } from "../../../runtime-api.js";
import { setMatrixRuntime } from "../../runtime.js";
import type { MatrixClient } from "../sdk.js";
import { deliverMatrixReplies } from "./replies.js";

const runtimeStub = {
  config: { current: () => ({}) },
  channel: {
    text: {
      resolveMarkdownTableMode: () => "code",
      resolveTextChunkLimit: () => 4000,
      resolveChunkMode: () => "length",
      chunkMarkdownTextWithMode: (text: string) => [text],
    },
  },
  media: {
    mediaKindFromMime: () => "unknown",
    getImageMetadata: async () => null,
    resizeToJpeg: async () => Buffer.alloc(0),
  },
  logging: { shouldLogVerbose: () => false },
} as unknown as PluginRuntime;

const runtimeEnv = {} as RuntimeEnv;

describe("deliverMatrixReplies file boundary", () => {
  let tempDir = "";

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-reply-media-"));
    setMatrixRuntime(runtimeStub);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("reads and sends singular media when plural media entries are blank", async () => {
    const mediaPath = path.join(tempDir, "fallback.txt");
    fs.writeFileSync(mediaPath, "matrix-file-boundary-proof");
    const uploadContent = vi.fn(async () => "mxc://example/fallback");
    const sendMessage = vi.fn(async () => "$event-1");
    const client = {
      prepareRoomForMessageSend: vi.fn(async () => "m.room.message"),
      uploadContent,
      sendMessage,
      getUserId: vi.fn(async () => "@bot:example.org"),
    } as unknown as MatrixClient;

    const result = await deliverMatrixReplies({
      cfg: { channels: { matrix: {} } },
      replies: [{ text: "caption", mediaUrl: mediaPath, mediaUrls: ["   "] }],
      roomId: "!room:example.org",
      client,
      runtime: runtimeEnv,
      textLimit: 4000,
      replyToMode: "off",
      mediaLocalRoots: [tempDir],
    });

    expect(uploadContent).toHaveBeenCalledWith(
      Buffer.from("matrix-file-boundary-proof"),
      "text/plain",
      "fallback.txt",
    );
    expect(sendMessage).toHaveBeenCalledWith(
      "!room:example.org",
      expect.objectContaining({
        body: "caption",
        filename: "fallback.txt",
        msgtype: "m.file",
        url: "mxc://example/fallback",
      }),
      undefined,
      undefined,
    );
    expect(result).toMatchObject({ messageIds: ["$event-1"], visibleReplySent: true });
  });
});
