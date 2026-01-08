import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config/config.js", () => ({
  loadConfig: () => ({}),
}));

vi.mock("../web/media.js", () => ({
  loadWebMedia: vi.fn().mockResolvedValue({
    buffer: Buffer.from("media"),
    fileName: "photo.png",
    contentType: "image/png",
    kind: "image",
  }),
}));

let sendMessageMatrix: typeof import("./send.js").sendMessageMatrix;

const makeClient = (encrypted: boolean) => {
  const sendMessage = vi.fn().mockResolvedValue({ event_id: "evt1" });
  const uploadContent = vi.fn().mockResolvedValue({
    content_uri: "mxc://example/file",
  });
  const crypto = {
    isEncryptionEnabledInRoom: vi.fn(async () => encrypted),
  };
  const client = {
    getCrypto: () => crypto,
    sendMessage,
    uploadContent,
  } as unknown as import("matrix-js-sdk").MatrixClient;
  return { client, sendMessage, uploadContent };
};

describe("sendMessageMatrix media", () => {
  beforeAll(async () => {
    ({ sendMessageMatrix } = await import("./send.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uploads encrypted media with file payloads", async () => {
    const { client, sendMessage, uploadContent } = makeClient(true);

    await sendMessageMatrix("room:!room:example", "caption", {
      client,
      mediaUrl: "file:///tmp/photo.png",
    });

    const uploadArg = uploadContent.mock.calls[0]?.[0];
    expect(Buffer.isBuffer(uploadArg)).toBe(true);
    expect(uploadContent).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.objectContaining({
        type: "application/octet-stream",
        name: "photo.png",
        includeFilename: false,
      }),
    );

    const content = sendMessage.mock.calls[0]?.[2] as {
      file?: { url?: string };
      url?: string;
      msgtype?: string;
      format?: string;
      formatted_body?: string;
    };
    expect(content.msgtype).toBe("m.file");
    expect(content.format).toBe("org.matrix.custom.html");
    expect(content.formatted_body).toContain("caption");
    expect(content.file?.url).toBe("mxc://example/file");
    expect(content.url).toBeUndefined();
  });

  it("uploads unencrypted media with url payloads", async () => {
    const { client, sendMessage, uploadContent } = makeClient(false);

    await sendMessageMatrix("room:!room:example", "caption", {
      client,
      mediaUrl: "file:///tmp/photo.png",
    });

    const uploadArg = uploadContent.mock.calls[0]?.[0];
    expect(Buffer.isBuffer(uploadArg)).toBe(true);

    const content = sendMessage.mock.calls[0]?.[2] as {
      file?: { url?: string };
      url?: string;
      msgtype?: string;
      format?: string;
      formatted_body?: string;
    };
    expect(content.msgtype).toBe("m.file");
    expect(content.format).toBe("org.matrix.custom.html");
    expect(content.formatted_body).toContain("caption");
    expect(content.url).toBe("mxc://example/file");
    expect(content.file).toBeUndefined();
  });
});
