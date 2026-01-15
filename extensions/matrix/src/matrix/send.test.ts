import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("matrix-js-sdk", () => ({
  EventType: {
    Direct: "m.direct",
    RoomMessage: "m.room.message",
    Reaction: "m.reaction",
  },
  MsgType: {
    Text: "m.text",
    File: "m.file",
    Image: "m.image",
    Audio: "m.audio",
    Video: "m.video",
  },
  RelationType: {
    Annotation: "m.annotation",
  },
}));

vi.mock("../../../../src/config/config.js", () => ({
  loadConfig: () => ({}),
}));

vi.mock("../../../../src/web/media.js", () => ({
  loadWebMedia: vi.fn().mockResolvedValue({
    buffer: Buffer.from("media"),
    fileName: "photo.png",
    contentType: "image/png",
    kind: "image",
  }),
}));

let sendMessageMatrix: typeof import("./send.js").sendMessageMatrix;

const makeClient = () => {
  const sendMessage = vi.fn().mockResolvedValue({ event_id: "evt1" });
  const uploadContent = vi.fn().mockResolvedValue({
    content_uri: "mxc://example/file",
  });
  const client = {
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

  it("uploads media with url payloads", async () => {
    const { client, sendMessage, uploadContent } = makeClient();

    await sendMessageMatrix("room:!room:example", "caption", {
      client,
      mediaUrl: "file:///tmp/photo.png",
    });

    const uploadArg = uploadContent.mock.calls[0]?.[0];
    expect(Buffer.isBuffer(uploadArg)).toBe(true);

    const content = sendMessage.mock.calls[0]?.[2] as {
      url?: string;
      msgtype?: string;
      format?: string;
      formatted_body?: string;
    };
    expect(content.msgtype).toBe("m.file");
    expect(content.format).toBe("org.matrix.custom.html");
    expect(content.formatted_body).toContain("caption");
    expect(content.url).toBe("mxc://example/file");
  });
});
