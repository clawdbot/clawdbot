import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { PluginRuntime } from "clawdbot/plugin-sdk";
import { setMatrixRuntime } from "../runtime.js";

vi.mock("matrix-bot-sdk", () => ({
  ConsoleLogger: class {
    trace = vi.fn();
    debug = vi.fn();
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
  },
  LogService: {
    setLogger: vi.fn(),
  },
  MatrixClient: vi.fn(),
  SimpleFsStorageProvider: vi.fn(),
  RustSdkCryptoStorageProvider: vi.fn(),
}));

const loadWebMediaMock = vi.fn().mockResolvedValue({
  buffer: Buffer.from("media"),
  fileName: "photo.png",
  contentType: "image/png",
  kind: "image",
});
const getImageMetadataMock = vi.fn().mockResolvedValue(null);
const resizeToJpegMock = vi.fn();

const runtimeStub = {
  config: {
    loadConfig: () => ({}),
  },
  media: {
    loadWebMedia: (...args: unknown[]) => loadWebMediaMock(...args),
    mediaKindFromMime: () => "image",
    isVoiceCompatibleAudio: () => false,
    getImageMetadata: (...args: unknown[]) => getImageMetadataMock(...args),
    resizeToJpeg: (...args: unknown[]) => resizeToJpegMock(...args),
  },
  channel: {
    text: {
      resolveTextChunkLimit: () => 4000,
      resolveChunkMode: () => "length",
      chunkMarkdownText: (text: string) => (text ? [text] : []),
      chunkMarkdownTextWithMode: (text: string) => (text ? [text] : []),
      resolveMarkdownTableMode: () => "code",
      convertMarkdownTables: (text: string) => text,
    },
  },
} as unknown as PluginRuntime;

let sendMessageMatrix: typeof import("./send.js").sendMessageMatrix;

const makeClient = () => {
  const sendMessage = vi.fn().mockResolvedValue("evt1");
  const uploadContent = vi.fn().mockResolvedValue("mxc://example/file");
  const client = {
    sendMessage,
    uploadContent,
    getUserId: vi.fn().mockResolvedValue("@bot:example.org"),
  } as unknown as import("matrix-bot-sdk").MatrixClient;
  return { client, sendMessage, uploadContent };
};

describe("sendMessageMatrix media", () => {
  beforeAll(async () => {
    setMatrixRuntime(runtimeStub);
    ({ sendMessageMatrix } = await import("./send.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    setMatrixRuntime(runtimeStub);
  });

  it("uploads media with url payloads", async () => {
    const { client, sendMessage, uploadContent } = makeClient();

    await sendMessageMatrix("room:!room:example", "caption", {
      client,
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
    const { client, sendMessage, uploadContent } = makeClient();
    (client as { crypto?: object }).crypto = {
      isRoomEncrypted: vi.fn().mockResolvedValue(true),
      encryptMedia: vi.fn().mockResolvedValue({
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
      }),
    };

    await sendMessageMatrix("room:!room:example", "caption", {
      client,
      mediaUrl: "file:///tmp/photo.png",
    });

    const uploadArg = uploadContent.mock.calls[0]?.[0] as Buffer | undefined;
    expect(uploadArg?.toString()).toBe("encrypted");

    const content = sendMessage.mock.calls[0]?.[1] as {
      url?: string;
      file?: { url?: string };
    };
    expect(content.url).toBeUndefined();
    expect(content.file?.url).toBe("mxc://example/file");
  });
});

describe("sendMessageMatrix threads", () => {
  beforeAll(async () => {
    setMatrixRuntime(runtimeStub);
    ({ sendMessageMatrix } = await import("./send.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    setMatrixRuntime(runtimeStub);
  });

  it("includes thread relation metadata when threadId is set", async () => {
    const { client, sendMessage } = makeClient();

    await sendMessageMatrix("room:!room:example", "hello thread", {
      client,
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
});
