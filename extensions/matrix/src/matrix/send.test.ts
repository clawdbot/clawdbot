import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "../../runtime-api.js";
import { setMatrixRuntime } from "../runtime.js";
import { voteMatrixPoll } from "./actions/polls.js";
import {
  editMessageMatrix,
  sendMessageMatrix,
  sendPollMatrix,
  sendSingleTextMessageMatrix,
  sendTypingMatrix,
} from "./send.js";
import { MATRIX_OPENCLAW_FINALIZED_PREVIEW_KEY } from "./send/types.js";

const loadOutboundMediaFromUrlMock = vi.hoisted(() => vi.fn());
const loadWebMediaMock = vi.fn().mockResolvedValue({
  buffer: Buffer.from("media"),
  fileName: "photo.png",
  contentType: "image/png",
  kind: "image",
});
const loadConfigMock = vi.fn(() => ({}));
const withResolvedRuntimeMatrixClientMock = vi.hoisted(() => vi.fn());
const getImageMetadataMock = vi.fn().mockResolvedValue(null);
const resizeToJpegMock = vi.fn();
const mediaKindFromMimeMock = vi.fn((_: string | null | undefined) => "image");
const isVoiceCompatibleAudioMock = vi.fn(
  (_: { contentType?: string | null; fileName?: string | null }) => false,
);
const resolveTextChunkLimitMock = vi.fn<
  (cfg: unknown, channel: unknown, accountId?: unknown) => number
>(() => 4000);
const resolveMarkdownTableModeMock = vi.fn(() => "code");
const convertMarkdownTablesMock = vi.fn((text: string) => text);
const chunkMarkdownTextWithModeMock = vi.fn((text: string) => (text ? [text] : []));

vi.mock("openclaw/plugin-sdk/config-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/config-runtime")>(
    "openclaw/plugin-sdk/config-runtime",
  );
  return {
    ...actual,
    requireRuntimeConfig: vi.fn((cfg: unknown) => cfg ?? loadConfigMock()),
  };
});

vi.mock("./outbound-media-runtime.js", () => ({
  loadOutboundMediaFromUrl: loadOutboundMediaFromUrlMock,
}));

vi.mock("./client-bootstrap.js", () => ({
  withResolvedRuntimeMatrixClient: withResolvedRuntimeMatrixClientMock,
}));

const runtimeStub = {
  config: {
    loadConfig: () => loadConfigMock(),
  },
  media: {
    loadWebMedia: (...args: unknown[]) => loadWebMediaMock(...args),
    mediaKindFromMime: (mime?: string | null) => mediaKindFromMimeMock(mime),
    isVoiceCompatibleAudio: (opts: { contentType?: string | null; fileName?: string | null }) =>
      isVoiceCompatibleAudioMock(opts),
    getImageMetadata: (...args: unknown[]) => getImageMetadataMock(...args),
    resizeToJpeg: (...args: unknown[]) => resizeToJpegMock(...args),
  },
  channel: {
    text: {
      resolveTextChunkLimit: (cfg: unknown, channel: unknown, accountId?: unknown) =>
        resolveTextChunkLimitMock(cfg, channel, accountId),
      resolveChunkMode: () => "length",
      chunkMarkdownText: (text: string) => (text ? [text] : []),
      chunkMarkdownTextWithMode: (text: string) => chunkMarkdownTextWithModeMock(text),
      resolveMarkdownTableMode: () => resolveMarkdownTableModeMock(),
      convertMarkdownTables: (text: string) => convertMarkdownTablesMock(text),
    },
  },
} as unknown as PluginRuntime;

function applyMatrixSendRuntimeStub() {
  setMatrixRuntime(runtimeStub);
}

function createEncryptedMediaPayload() {
  return {
    buffer: Buffer.from("encrypted"),
    file: {
      key: {
        kty: "oct",
        key_ops: ["encrypt", "decrypt"],
        alg: "A256CTR",
        k: "secret",
        ext: true,
      },
      iv: "iv",
      hashes: { sha256: "hash" },
      v: "v2",
    },
  };
}

const makeClient = () => {
  const sendMessage = vi.fn().mockResolvedValue("evt1");
  const sendEvent = vi.fn().mockResolvedValue("evt-poll-vote");
  const getEvent = vi.fn();
  const getJoinedRoomMembers = vi.fn().mockResolvedValue([]);
  const uploadContent = vi.fn().mockResolvedValue("mxc://example/file");
  const client = {
    sendMessage,
    sendEvent,
    getEvent,
    getJoinedRoomMembers,
    uploadContent,
    getUserId: vi.fn().mockResolvedValue("@bot:example.org"),
    prepareForOneOff: vi.fn(async () => undefined),
    start: vi.fn(async () => undefined),
    stop: vi.fn(() => undefined),
    stopAndPersist: vi.fn(async () => undefined),
  } as unknown as import("./sdk.js").MatrixClient;
  return { client, sendMessage, sendEvent, getEvent, getJoinedRoomMembers, uploadContent };
};

function makeEncryptedMediaClient() {
  const result = makeClient();
  (result.client as { crypto?: object }).crypto = {
    isRoomEncrypted: vi.fn().mockResolvedValue(true),
    encryptMedia: vi.fn().mockResolvedValue(createEncryptedMediaPayload()),
  };
  return result;
}

function resetMatrixSendRuntimeMocks() {
  setMatrixRuntime(runtimeStub);
  loadOutboundMediaFromUrlMock.mockReset().mockImplementation(
    async (
      mediaUrl: string,
      options?: {
        maxBytes?: number;
        mediaLocalRoots?: readonly string[];
        mediaReadFile?: (filePath: string) => Promise<Buffer>;
      },
    ) =>
      await loadWebMediaMock(mediaUrl, {
        maxBytes: options?.maxBytes,
        localRoots: options?.mediaLocalRoots,
        hostReadCapability: false,
        readFile: options?.mediaReadFile,
      }),
  );
  loadWebMediaMock.mockReset().mockResolvedValue({
    buffer: Buffer.from("media"),
    fileName: "photo.png",
    contentType: "image/png",
    kind: "image",
  });
  loadConfigMock.mockReset().mockReturnValue({});
  withResolvedRuntimeMatrixClientMock
    .mockReset()
    .mockImplementation(
      async (
        opts: { client?: import("./sdk.js").MatrixClient },
        run: (resolved: import("./sdk.js").MatrixClient) => Promise<unknown>,
      ) => {
        if (!opts.client) {
          throw new Error("test Matrix client is required");
        }
        return await run(opts.client);
      },
    );
  getImageMetadataMock.mockReset().mockResolvedValue(null);
  resizeToJpegMock.mockReset();
  mediaKindFromMimeMock.mockReset().mockReturnValue("image");
  isVoiceCompatibleAudioMock.mockReset().mockReturnValue(false);
  resolveTextChunkLimitMock.mockReset().mockReturnValue(4000);
  resolveMarkdownTableModeMock.mockReset().mockReturnValue("code");
  convertMarkdownTablesMock.mockReset().mockImplementation((text: string) => text);
  chunkMarkdownTextWithModeMock
    .mockReset()
    .mockImplementation((text: string) => (text ? [text] : []));
  applyMatrixSendRuntimeStub();
}

describe("sendMessageMatrix media", () => {
  beforeEach(() => {
    resetMatrixSendRuntimeMocks();
  });

  it("uploads media with url payloads", async () => {
    const { client, sendMessage, uploadContent } = makeClient();

    await sendMessageMatrix("room:!room:example", "caption", {
      client,
      cfg: {} as never,
      mediaUrl: "file:///tmp/photo.png",
    });

    const uploadArg = uploadContent.mock.calls[0]?.[0];
    expect(Buffer.isBuffer(uploadArg)).toBe(true);

    const content = sendMessage.mock.calls[0]?.[1] as {
      url?: string;
      msgtype?: string;
      format?: string;
      formatted_body?: string;
    };
    expect(content.msgtype).toBe("m.image");
    expect(content.format).toBe("org.matrix.custom.html");
    expect(content.formatted_body).toContain("caption");
    expect(content.url).toBe("mxc://example/file");
  });

  it("uploads encrypted media with file payloads", async () => {
    const { client, sendMessage, uploadContent } = makeEncryptedMediaClient();

    await sendMessageMatrix("room:!room:example", "caption", {
      client,
      cfg: {} as never,
      mediaUrl: "file:///tmp/photo.png",
    });

    const uploadArg = uploadContent.mock.calls[0]?.[0];
    expect(uploadArg instanceof Uint8Array ? Buffer.from(uploadArg).toString() : undefined).toBe(
      "encrypted",
    );

    const content = sendMessage.mock.calls[0]?.[1] as {
      url?: string;
      file?: { url?: string };
    };
    expect(content.url).toBeUndefined();
    expect(content.file?.url).toBe("mxc://example/file");
  });

  it("encrypts thumbnail via thumbnail_file when room is encrypted", async () => {
    const { client, sendMessage, uploadContent } = makeClient();
    const isRoomEncrypted = vi.fn().mockResolvedValue(true);
    const encryptMedia = vi.fn().mockResolvedValue({
      buffer: Buffer.from("encrypted-thumb"),
      file: {
        key: { kty: "oct", key_ops: ["encrypt", "decrypt"], alg: "A256CTR", k: "tkey", ext: true },
        iv: "tiv",
        hashes: { sha256: "thash" },
        v: "v2",
      },
    });
    (client as { crypto?: object }).crypto = {
      isRoomEncrypted,
      encryptMedia,
    };
    // Return image metadata so thumbnail generation is triggered (image > 800px)
    getImageMetadataMock
      .mockResolvedValueOnce({ width: 1920, height: 1080 }) // original image
      .mockResolvedValueOnce({ width: 800, height: 450 }); // thumbnail
    resizeToJpegMock.mockResolvedValueOnce(Buffer.from("thumb-bytes"));
    // Two uploadContent calls: one for the main encrypted image, one for the encrypted thumbnail
    uploadContent
      .mockResolvedValueOnce("mxc://example/main")
      .mockResolvedValueOnce("mxc://example/thumb");

    await sendMessageMatrix("room:!room:example", "caption", {
      client,
      cfg: {} as never,
      mediaUrl: "file:///tmp/photo.png",
    });

    // encryptMedia called twice: once for main media, once for thumbnail
    expect(isRoomEncrypted).toHaveBeenCalledTimes(1);
    expect(encryptMedia).toHaveBeenCalledTimes(2);

    const content = sendMessage.mock.calls[0]?.[1] as {
      url?: string;
      file?: { url?: string };
      info?: { thumbnail_url?: string; thumbnail_file?: { url?: string } };
    };
    // Main media encrypted correctly
    expect(content.url).toBeUndefined();
    expect(content.file?.url).toBe("mxc://example/main");
    // Thumbnail must use thumbnail_file (encrypted), NOT thumbnail_url (unencrypted)
    expect(content.info?.thumbnail_url).toBeUndefined();
    expect(content.info?.thumbnail_file?.url).toBe("mxc://example/thumb");
  });

  it("keeps reply context on voice transcript follow-ups outside threads", async () => {
    const { client, sendMessage } = makeClient();
    mediaKindFromMimeMock.mockReturnValue("audio");
    isVoiceCompatibleAudioMock.mockReturnValue(true);
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.from("audio"),
      fileName: "clip.mp3",
      contentType: "audio/mpeg",
      kind: "audio",
    });

    await sendMessageMatrix("room:!room:example", "voice caption", {
      client,
      cfg: {} as never,
      mediaUrl: "file:///tmp/clip.mp3",
      audioAsVoice: true,
      replyToId: "$reply",
    });

    const transcriptContent = sendMessage.mock.calls[1]?.[1] as {
      body?: string;
      "m.relates_to"?: {
        "m.in_reply_to"?: { event_id?: string };
      };
    };

    expect(transcriptContent.body).toBe("voice caption");
    expect(transcriptContent["m.relates_to"]).toMatchObject({
      "m.in_reply_to": { event_id: "$reply" },
    });
  });

  it("keeps regular audio payload when audioAsVoice media is incompatible", async () => {
    const { client, sendMessage } = makeClient();
    mediaKindFromMimeMock.mockReturnValue("audio");
    isVoiceCompatibleAudioMock.mockReturnValue(false);
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.from("audio"),
      fileName: "clip.wav",
      contentType: "audio/wav",
      kind: "audio",
    });

    await sendMessageMatrix("room:!room:example", "voice caption", {
      client,
      cfg: {} as never,
      mediaUrl: "file:///tmp/clip.wav",
      audioAsVoice: true,
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const mediaContent = sendMessage.mock.calls[0]?.[1] as {
      msgtype?: string;
      body?: string;
      "org.matrix.msc3245.voice"?: Record<string, never>;
    };
    expect(mediaContent.msgtype).toBe("m.audio");
    expect(mediaContent.body).toBe("voice caption");
    expect(mediaContent["org.matrix.msc3245.voice"]).toBeUndefined();
  });

  it("keeps thumbnail_url metadata for unencrypted large images", async () => {
    const { client, sendMessage, uploadContent } = makeClient();
    getImageMetadataMock
      .mockResolvedValueOnce({ width: 1600, height: 1200 })
      .mockResolvedValueOnce({ width: 800, height: 600 });
    resizeToJpegMock.mockResolvedValueOnce(Buffer.from("thumb"));

    await sendMessageMatrix("room:!room:example", "caption", {
      client,
      cfg: {} as never,
      mediaUrl: "file:///tmp/photo.png",
    });

    expect(uploadContent).toHaveBeenCalledTimes(2);
    const content = sendMessage.mock.calls[0]?.[1] as {
      info?: {
        thumbnail_url?: string;
        thumbnail_file?: { url?: string };
        thumbnail_info?: {
          w?: number;
          h?: number;
          mimetype?: string;
          size?: number;
        };
      };
    };
    expect(content.info?.thumbnail_url).toBe("mxc://example/file");
    expect(content.info?.thumbnail_file).toBeUndefined();
    expect(content.info?.thumbnail_info).toMatchObject({
      w: 800,
      h: 600,
      mimetype: "image/jpeg",
      size: Buffer.from("thumb").byteLength,
    });
  });

  it("uses explicit cfg for media sends instead of runtime loadConfig fallbacks", async () => {
    const { client } = makeClient();
    const explicitCfg = {
      channels: {
        matrix: {
          accounts: {
            ops: {
              mediaMaxMb: 1,
            },
          },
        },
      },
    };

    loadConfigMock.mockImplementation(() => {
      throw new Error("sendMessageMatrix should not reload runtime config when cfg is provided");
    });

    await sendMessageMatrix("room:!room:example", "caption", {
      client,
      cfg: explicitCfg,
      accountId: "ops",
      mediaUrl: "file:///tmp/photo.png",
    });

    expect(loadConfigMock).not.toHaveBeenCalled();
    expect(loadWebMediaMock).toHaveBeenCalledWith(
      "file:///tmp/photo.png",
      expect.objectContaining({
        maxBytes: 1024 * 1024,
        localRoots: undefined,
      }),
    );
    expect(resolveTextChunkLimitMock).toHaveBeenCalledWith(explicitCfg, "matrix", "ops");
  });

  it("passes caller mediaLocalRoots to media loading", async () => {
    const { client } = makeClient();

    await sendMessageMatrix("room:!room:example", "caption", {
      client,
      cfg: {} as never,
      mediaUrl: "file:///tmp/photo.png",
      mediaLocalRoots: ["/tmp/openclaw-matrix-test"],
    });

    expect(loadWebMediaMock).toHaveBeenCalledWith(
      "file:///tmp/photo.png",
      expect.objectContaining({
        maxBytes: undefined,
        localRoots: ["/tmp/openclaw-matrix-test"],
      }),
    );
  });
});

describe("sendMessageMatrix mentions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMatrixSendRuntimeMocks();
  });

  it("adds an empty m.mentions object for plain messages without mentions", async () => {
    const { client, sendMessage } = makeClient();

    await sendMessageMatrix("room:!room:example", "hello", {
      client,
      cfg: {} as never,
    });

    expect(sendMessage.mock.calls[0]?.[1]).toMatchObject({
      body: "hello",
      "m.mentions": {},
    });
  });

  it("emits m.mentions and matrix.to anchors for qualified user mentions", async () => {
    const { client, sendMessage } = makeClient();

    await sendMessageMatrix("room:!room:example", "hello @alice:example.org", {
      client,
      cfg: {} as never,
    });

    expect(sendMessage.mock.calls[0]?.[1]).toMatchObject({
      body: "hello @alice:example.org",
      "m.mentions": { user_ids: ["@alice:example.org"] },
    });
    expect(
      (sendMessage.mock.calls[0]?.[1] as { formatted_body?: string }).formatted_body,
    ).toContain('href="https://matrix.to/#/%40alice%3Aexample.org"');
  });

  it("keeps bare localpart text as plain text", async () => {
    const { client, sendMessage } = makeClient();

    await sendMessageMatrix("room:!room:example", "hello @alice", {
      client,
      cfg: {} as never,
    });

    expect(sendMessage.mock.calls[0]?.[1]).toMatchObject({
      "m.mentions": {},
    });
    expect(
      (sendMessage.mock.calls[0]?.[1] as { formatted_body?: string }).formatted_body,
    ).not.toContain("matrix.to/#/@alice:example.org");
  });

  it("does not emit mentions for escaped qualified users", async () => {
    const { client, sendMessage } = makeClient();

    await sendMessageMatrix("room:!room:example", "\\@alice:example.org", {
      client,
      cfg: {} as never,
    });

    expect(sendMessage.mock.calls[0]?.[1]).toMatchObject({
      "m.mentions": {},
    });
    expect(
      (sendMessage.mock.calls[0]?.[1] as { formatted_body?: string }).formatted_body,
    ).not.toContain("matrix.to/#/@alice:example.org");
  });

  it("does not emit mentions for escaped room mentions", async () => {
    const { client, sendMessage } = makeClient();

    await sendMessageMatrix("room:!room:example", "\\@room please review", {
      client,
      cfg: {} as never,
    });

    expect(sendMessage.mock.calls[0]?.[1]).toMatchObject({
      "m.mentions": {},
    });
  });

  it("marks room mentions via m.mentions.room", async () => {
    const { client, sendMessage } = makeClient();

    await sendMessageMatrix("room:!room:example", "@room please review", {
      client,
      cfg: {} as never,
    });

    expect(sendMessage.mock.calls[0]?.[1]).toMatchObject({
      "m.mentions": { room: true },
    });
  });

  it("adds mention metadata to media captions", async () => {
    const { client, sendMessage } = makeClient();

    await sendMessageMatrix("room:!room:example", "caption @alice:example.org", {
      client,
      cfg: {} as never,
      mediaUrl: "file:///tmp/photo.png",
    });

    expect(sendMessage.mock.calls[0]?.[1]).toMatchObject({
      "m.mentions": { user_ids: ["@alice:example.org"] },
    });
  });

  it("does not emit mentions from fallback filenames when there is no caption", async () => {
    const { client, sendMessage } = makeClient();
    loadWebMediaMock.mockResolvedValue({
      buffer: Buffer.from("media"),
      fileName: "@room.png",
      contentType: "image/png",
      kind: "image",
    });

    await sendMessageMatrix("room:!room:example", "", {
      client,
      cfg: {} as never,
      mediaUrl: "file:///tmp/room.png",
    });

    expect(sendMessage.mock.calls[0]?.[1]).toMatchObject({
      body: "@room.png",
      "m.mentions": {},
    });
    expect(
      (sendMessage.mock.calls[0]?.[1] as { formatted_body?: string }).formatted_body,
    ).toBeUndefined();
  });
});

describe("sendMessageMatrix threads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMatrixSendRuntimeMocks();
  });

  it("includes thread relation metadata when threadId is set", async () => {
    const { client, sendMessage } = makeClient();

    await sendMessageMatrix("room:!room:example", "hello thread", {
      client,
      cfg: {} as never,
      threadId: "$thread",
    });

    const content = sendMessage.mock.calls[0]?.[1] as {
      "m.relates_to"?: {
        rel_type?: string;
        event_id?: string;
        "m.in_reply_to"?: { event_id?: string };
      };
    };

    expect(content["m.relates_to"]).toMatchObject({
      rel_type: "m.thread",
      event_id: "$thread",
      "m.in_reply_to": { event_id: "$thread" },
    });
  });

  it("resolves text chunk limit using the active Matrix account", async () => {
    const { client } = makeClient();

    await sendMessageMatrix("room:!room:example", "hello", {
      client,
      cfg: {} as never,
      accountId: "ops",
    });

    expect(resolveTextChunkLimitMock).toHaveBeenCalledWith(expect.anything(), "matrix", "ops");
  });

  it("returns ordered event ids for chunked text sends", async () => {
    const { client, sendMessage } = makeClient();
    sendMessage
      .mockReset()
      .mockResolvedValueOnce("$m1")
      .mockResolvedValueOnce("$m2")
      .mockResolvedValueOnce("$m3");
    convertMarkdownTablesMock.mockImplementation(() => "part1|part2|part3");
    chunkMarkdownTextWithModeMock.mockImplementation((text: string) => text.split("|"));

    const result = await sendMessageMatrix("room:!room:example", "ignored", {
      client,
      cfg: {} as never,
    });

    expect(result).toMatchObject({
      roomId: "!room:example",
      primaryMessageId: "$m1",
      messageId: "$m3",
      messageIds: ["$m1", "$m2", "$m3"],
    });
  });
});

describe("sendSingleTextMessageMatrix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMatrixSendRuntimeMocks();
  });

  it("rejects single-event sends when converted text exceeds the Matrix limit", async () => {
    const { client, sendMessage } = makeClient();
    resolveTextChunkLimitMock.mockReturnValue(5);
    convertMarkdownTablesMock.mockImplementation(() => "123456");

    await expect(
      sendSingleTextMessageMatrix("room:!room:example", "1234", {
        client,
        cfg: {} as never,
      }),
    ).rejects.toThrow("Matrix single-message text exceeds limit");

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("supports quiet draft preview sends without mention metadata", async () => {
    const { client, sendMessage } = makeClient();

    await sendSingleTextMessageMatrix("room:!room:example", "@room hi @alice:example.org", {
      client,
      cfg: {} as never,
      msgtype: "m.notice",
      includeMentions: false,
    });

    expect(sendMessage.mock.calls[0]?.[1]).toMatchObject({
      msgtype: "m.notice",
      body: "@room hi @alice:example.org",
    });
    expect(sendMessage.mock.calls[0]?.[1]).not.toHaveProperty("m.mentions");
    expect(
      (sendMessage.mock.calls[0]?.[1] as { formatted_body?: string }).formatted_body,
    ).not.toContain("matrix.to");
  });

  it("merges extra content fields into single-event sends", async () => {
    const { client, sendMessage } = makeClient();

    await sendSingleTextMessageMatrix("room:!room:example", "done", {
      client,
      cfg: {} as never,
      extraContent: { [MATRIX_OPENCLAW_FINALIZED_PREVIEW_KEY]: true },
    });

    expect(sendMessage.mock.calls[0]?.[1]).toMatchObject({
      body: "done",
      [MATRIX_OPENCLAW_FINALIZED_PREVIEW_KEY]: true,
    });
  });
});

describe("editMessageMatrix mentions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMatrixSendRuntimeMocks();
  });

  it("stores full mentions in m.new_content and only newly-added mentions in the edit event", async () => {
    const { client, sendMessage, getEvent } = makeClient();
    getEvent.mockResolvedValue({
      content: {
        body: "hello @alice:example.org",
        "m.mentions": { user_ids: ["@alice:example.org"] },
      },
    });

    await editMessageMatrix(
      "room:!room:example",
      "$original",
      "hello @alice:example.org and @bob:example.org",
      {
        client,
        cfg: {} as never,
      },
    );

    expect(sendMessage.mock.calls[0]?.[1]).toMatchObject({
      "m.mentions": { user_ids: ["@bob:example.org"] },
      "m.new_content": {
        "m.mentions": { user_ids: ["@alice:example.org", "@bob:example.org"] },
      },
    });
  });

  it("does not re-notify legacy mentions when the prior event body already mentioned the user", async () => {
    const { client, sendMessage, getEvent } = makeClient();
    getEvent.mockResolvedValue({
      content: {
        body: "hello @alice:example.org",
      },
    });

    await editMessageMatrix("room:!room:example", "$original", "hello again @alice:example.org", {
      client,
      cfg: {} as never,
    });

    expect(sendMessage.mock.calls[0]?.[1]).toMatchObject({
      "m.mentions": {},
      "m.new_content": {
        body: "hello again @alice:example.org",
        "m.mentions": { user_ids: ["@alice:example.org"] },
      },
    });
  });

  it("keeps explicit empty prior m.mentions authoritative", async () => {
    const { client, sendMessage, getEvent } = makeClient();
    getEvent.mockResolvedValue({
      content: {
        body: "`@alice:example.org`",
        "m.mentions": {},
      },
    });

    await editMessageMatrix("room:!room:example", "$original", "@alice:example.org", {
      client,
      cfg: {} as never,
    });

    expect(sendMessage.mock.calls[0]?.[1]).toMatchObject({
      "m.mentions": { user_ids: ["@alice:example.org"] },
      "m.new_content": {
        "m.mentions": { user_ids: ["@alice:example.org"] },
      },
    });
  });

  it("supports quiet draft preview edits without mention metadata", async () => {
    const { client, sendMessage, getEvent } = makeClient();
    getEvent.mockResolvedValue({
      content: {
        body: "@room hi @alice:example.org",
        "m.mentions": { room: true, user_ids: ["@alice:example.org"] },
      },
    });

    await editMessageMatrix("room:!room:example", "$original", "@room hi @alice:example.org", {
      client,
      cfg: {} as never,
      msgtype: "m.notice",
      includeMentions: false,
    });

    expect(sendMessage.mock.calls[0]?.[1]).toMatchObject({
      msgtype: "m.notice",
      "m.new_content": {
        msgtype: "m.notice",
      },
    });
    expect(sendMessage.mock.calls[0]?.[1]).not.toHaveProperty("m.mentions");
    expect(sendMessage.mock.calls[0]?.[1]?.["m.new_content"]).not.toHaveProperty("m.mentions");
    expect(
      (sendMessage.mock.calls[0]?.[1] as { formatted_body?: string }).formatted_body,
    ).not.toContain("matrix.to");
    expect(
      (
        sendMessage.mock.calls[0]?.[1] as {
          "m.new_content"?: { formatted_body?: string };
        }
      )["m.new_content"]?.formatted_body,
    ).not.toContain("matrix.to");
  });

  it("merges extra content fields into edit payloads and m.new_content", async () => {
    const { client, sendMessage } = makeClient();

    await editMessageMatrix("room:!room:example", "$original", "done", {
      client,
      cfg: {} as never,
      extraContent: { [MATRIX_OPENCLAW_FINALIZED_PREVIEW_KEY]: true },
    });

    expect(sendMessage.mock.calls[0]?.[1]).toMatchObject({
      [MATRIX_OPENCLAW_FINALIZED_PREVIEW_KEY]: true,
      "m.new_content": {
        [MATRIX_OPENCLAW_FINALIZED_PREVIEW_KEY]: true,
      },
    });
  });
});

describe("sendPollMatrix mentions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMatrixSendRuntimeMocks();
  });

  it("adds m.mentions for poll fallback text", async () => {
    const { client, sendEvent } = makeClient();

    await sendPollMatrix(
      "room:!room:example",
      {
        question: "@room lunch with @alice:example.org?",
        options: ["yes", "no"],
      },
      {
        client,
        cfg: {} as never,
      },
    );

    expect(sendEvent).toHaveBeenCalledWith(
      "!room:example",
      "m.poll.start",
      expect.objectContaining({
        "m.mentions": {
          room: true,
          user_ids: ["@alice:example.org"],
        },
      }),
    );
  });
});

describe("voteMatrixPoll", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMatrixSendRuntimeMocks();
  });

  it("maps 1-based option indexes to Matrix poll answer ids", async () => {
    const { client, getEvent, sendEvent } = makeClient();
    getEvent.mockResolvedValue({
      type: "m.poll.start",
      content: {
        "m.poll.start": {
          question: { "m.text": "Lunch?" },
          max_selections: 1,
          answers: [
            { id: "a1", "m.text": "Pizza" },
            { id: "a2", "m.text": "Sushi" },
          ],
        },
      },
    });

    const result = await voteMatrixPoll("room:!room:example", "$poll", {
      client,
      cfg: {} as never,
      optionIndex: 2,
    });

    expect(sendEvent).toHaveBeenCalledWith("!room:example", "m.poll.response", {
      "m.poll.response": { answers: ["a2"] },
      "org.matrix.msc3381.poll.response": { answers: ["a2"] },
      "m.relates_to": {
        rel_type: "m.reference",
        event_id: "$poll",
      },
    });
    expect(result).toMatchObject({
      eventId: "evt-poll-vote",
      roomId: "!room:example",
      pollId: "$poll",
      answerIds: ["a2"],
      labels: ["Sushi"],
    });
  });

  it("rejects out-of-range option indexes", async () => {
    const { client, getEvent } = makeClient();
    getEvent.mockResolvedValue({
      type: "m.poll.start",
      content: {
        "m.poll.start": {
          question: { "m.text": "Lunch?" },
          max_selections: 1,
          answers: [{ id: "a1", "m.text": "Pizza" }],
        },
      },
    });

    await expect(
      voteMatrixPoll("room:!room:example", "$poll", {
        client,
        cfg: {} as never,
        optionIndex: 2,
      }),
    ).rejects.toThrow("out of range");
  });

  it("rejects votes that exceed the poll selection cap", async () => {
    const { client, getEvent } = makeClient();
    getEvent.mockResolvedValue({
      type: "m.poll.start",
      content: {
        "m.poll.start": {
          question: { "m.text": "Lunch?" },
          max_selections: 1,
          answers: [
            { id: "a1", "m.text": "Pizza" },
            { id: "a2", "m.text": "Sushi" },
          ],
        },
      },
    });

    await expect(
      voteMatrixPoll("room:!room:example", "$poll", {
        client,
        cfg: {} as never,
        optionIndexes: [1, 2],
      }),
    ).rejects.toThrow("at most 1 selection");
  });

  it("rejects non-poll events before sending a response", async () => {
    const { client, getEvent, sendEvent } = makeClient();
    getEvent.mockResolvedValue({
      type: "m.room.message",
      content: { body: "hello" },
    });

    await expect(
      voteMatrixPoll("room:!room:example", "$poll", {
        client,
        cfg: {} as never,
        optionIndex: 1,
      }),
    ).rejects.toThrow("is not a Matrix poll start event");
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it("accepts decrypted poll start events returned from encrypted rooms", async () => {
    const { client, getEvent, sendEvent } = makeClient();
    getEvent.mockResolvedValue({
      type: "m.poll.start",
      content: {
        "m.poll.start": {
          question: { "m.text": "Lunch?" },
          max_selections: 1,
          answers: [{ id: "a1", "m.text": "Pizza" }],
        },
      },
    });

    await expect(
      voteMatrixPoll("room:!room:example", "$poll", {
        client,
        cfg: {} as never,
        optionIndex: 1,
      }),
    ).resolves.toMatchObject({
      pollId: "$poll",
      answerIds: ["a1"],
    });
    expect(sendEvent).toHaveBeenCalledWith("!room:example", "m.poll.response", {
      "m.poll.response": { answers: ["a1"] },
      "org.matrix.msc3381.poll.response": { answers: ["a1"] },
      "m.relates_to": {
        rel_type: "m.reference",
        event_id: "$poll",
      },
    });
  });
});

describe("sendTypingMatrix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMatrixSendRuntimeMocks();
  });

  it("normalizes room-prefixed targets before sending typing state", async () => {
    const setTyping = vi.fn().mockResolvedValue(undefined);
    const client = {
      setTyping,
      prepareForOneOff: vi.fn(async () => undefined),
      start: vi.fn(async () => undefined),
      stop: vi.fn(() => undefined),
      stopAndPersist: vi.fn(async () => undefined),
    } as unknown as import("./sdk.js").MatrixClient;

    await sendTypingMatrix("room:!room:example", true, undefined, client);

    expect(setTyping).toHaveBeenCalledWith("!room:example", true, 30_000);
  });

  it("passes account config through when resolving the typing client", async () => {
    const cfg = { channels: { matrix: {} } } as unknown as import("../types.js").CoreConfig;
    const setTyping = vi.fn().mockResolvedValue(undefined);
    const client = {
      setTyping,
    } as unknown as import("./sdk.js").MatrixClient;
    withResolvedRuntimeMatrixClientMock.mockImplementation(
      async (
        opts: Record<string, unknown>,
        run: (resolved: import("./sdk.js").MatrixClient) => Promise<void>,
      ) => {
        expect(opts).toMatchObject({
          cfg,
          accountId: "work",
          timeoutMs: 12_345,
          readiness: "none",
        });
        return await run(client);
      },
    );

    await sendTypingMatrix("room:!room:example", true, {
      cfg,
      accountId: "work",
      timeoutMs: 12_345,
    });

    expect(setTyping).toHaveBeenCalledWith("!room:example", true, 12_345);
  });
});
