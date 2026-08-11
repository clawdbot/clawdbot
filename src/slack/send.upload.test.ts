import type { WebClient } from "@slack/web-api";
import { describe, expect, it, vi } from "vitest";
import { installSlackBlockTestMocks } from "./blocks.test-helpers.js";

// --- Module mocks (must precede dynamic import) ---
installSlackBlockTestMocks();

vi.mock("../web/media.js", () => ({
  loadWebMedia: vi.fn(async () => ({
    buffer: Buffer.from("fake-image"),
    contentType: "image/png",
    kind: "image",
    fileName: "screenshot.png",
  })),
}));

const { sendMessageSlack } = await import("./send.js");

type UploadTestClient = WebClient & {
  conversations: { open: ReturnType<typeof vi.fn> };
  chat: { postMessage: ReturnType<typeof vi.fn> };
  files: { uploadV2: ReturnType<typeof vi.fn> };
};

function createUploadTestClient(): UploadTestClient {
  return {
    conversations: {
      open: vi.fn(async () => ({ channel: { id: "D99RESOLVED" } })),
    },
    chat: {
      postMessage: vi.fn(async () => ({ ts: "171234.567" })),
    },
    files: {
      uploadV2: vi.fn(async () => ({ files: [{ id: "F001" }] })),
    },
  } as unknown as UploadTestClient;
}

describe("sendMessageSlack file upload with user IDs", () => {
  it("resolves bare user ID to DM channel before files.uploadV2", async () => {
    const client = createUploadTestClient();

    // Bare user ID — parseSlackTarget classifies this as kind="channel"
    await sendMessageSlack("U2ZH3MFSR", "screenshot", {
      token: "xoxb-test",
      client,
      mediaUrl: "/tmp/screenshot.png",
    });

    // Should call conversations.open to resolve user ID → DM channel
    expect(client.conversations.open).toHaveBeenCalledWith({
      users: "U2ZH3MFSR",
    });

    // files.uploadV2 should receive the resolved DM channel ID, not the user ID
    expect(client.files.uploadV2).toHaveBeenCalledWith(
      expect.objectContaining({
        channel_id: "D99RESOLVED",
        filename: "screenshot.png",
      }),
    );
  });

  it("resolves prefixed user ID to DM channel before files.uploadV2", async () => {
    const client = createUploadTestClient();

    await sendMessageSlack("user:UABC123", "image", {
      token: "xoxb-test",
      client,
      mediaUrl: "/tmp/photo.png",
    });

    expect(client.conversations.open).toHaveBeenCalledWith({
      users: "UABC123",
    });
    expect(client.files.uploadV2).toHaveBeenCalledWith(
      expect.objectContaining({ channel_id: "D99RESOLVED" }),
    );
  });

  it("sends file directly to channel without conversations.open", async () => {
    const client = createUploadTestClient();

    await sendMessageSlack("channel:C123CHAN", "chart", {
      token: "xoxb-test",
      client,
      mediaUrl: "/tmp/chart.png",
    });

    expect(client.conversations.open).not.toHaveBeenCalled();
    expect(client.files.uploadV2).toHaveBeenCalledWith(
      expect.objectContaining({ channel_id: "C123CHAN" }),
    );
  });

  it("resolves mention-style user ID before file upload", async () => {
    const client = createUploadTestClient();

    await sendMessageSlack("<@U777TEST>", "report", {
      token: "xoxb-test",
      client,
      mediaUrl: "/tmp/report.png",
    });

    expect(client.conversations.open).toHaveBeenCalledWith({
      users: "U777TEST",
    });
    expect(client.files.uploadV2).toHaveBeenCalledWith(
      expect.objectContaining({ channel_id: "D99RESOLVED" }),
    );
  });

  it("uppercases lowercase bare user ID before conversations.open", async () => {
    const client = createUploadTestClient();

    await sendMessageSlack("u2zh3mfsr", "screenshot", {
      token: "xoxb-test",
      client,
      mediaUrl: "/tmp/screenshot.png",
    });

    expect(client.conversations.open).toHaveBeenCalledWith({
      users: "U2ZH3MFSR",
    });
    expect(client.files.uploadV2).toHaveBeenCalledWith(
      expect.objectContaining({ channel_id: "D99RESOLVED" }),
    );
  });

  it("uppercases lowercase prefixed user ID before conversations.open", async () => {
    const client = createUploadTestClient();

    await sendMessageSlack("user:uabc123", "image", {
      token: "xoxb-test",
      client,
      mediaUrl: "/tmp/photo.png",
    });

    expect(client.conversations.open).toHaveBeenCalledWith({
      users: "UABC123",
    });
    expect(client.files.uploadV2).toHaveBeenCalledWith(
      expect.objectContaining({ channel_id: "D99RESOLVED" }),
    );
  });
});
