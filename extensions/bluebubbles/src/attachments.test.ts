import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./test-mocks.js";
import {
  downloadBlueBubblesAttachment,
  fetchBlueBubblesMessageAttachments,
  sendBlueBubblesAttachment,
} from "./attachments.js";
import { fetchBlueBubblesServerInfo, getCachedBlueBubblesPrivateApiStatus } from "./probe.js";
import type { PluginRuntime } from "./runtime-api.js";
import { setBlueBubblesRuntime } from "./runtime.js";
import {
  BLUE_BUBBLES_PRIVATE_API_STATUS,
  installBlueBubblesFetchTestHooks,
  mockBlueBubblesPrivateApiStatus,
  mockBlueBubblesPrivateApiStatusOnce,
} from "./test-harness.js";
import type { BlueBubblesAttachment } from "./types.js";

const mockFetch = vi.fn();
const fetchServerInfoMock = vi.mocked(fetchBlueBubblesServerInfo);
const fetchRemoteMediaMock = vi.fn(
  async (params: {
    url: string;
    maxBytes?: number;
    fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  }) => {
    const fetchFn = params.fetchImpl ?? fetch;
    const res = await fetchFn(params.url);
    if (!res.ok) {
      const text = await res.text().catch(() => "unknown");
      throw new Error(
        `Failed to fetch media from ${params.url}: HTTP ${res.status}; body: ${text}`,
      );
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (typeof params.maxBytes === "number" && buffer.byteLength > params.maxBytes) {
      const error = new Error(`payload exceeds maxBytes ${params.maxBytes}`) as Error & {
        code?: string;
      };
      error.code = "max_bytes";
      throw error;
    }
    return {
      buffer,
      contentType: res.headers.get("content-type") ?? undefined,
      fileName: undefined,
    };
  },
);

installBlueBubblesFetchTestHooks({
  mockFetch,
  privateApiStatusMock: vi.mocked(getCachedBlueBubblesPrivateApiStatus),
});

const runtimeStub = {
  channel: {
    media: {
      fetchRemoteMedia:
        fetchRemoteMediaMock as unknown as PluginRuntime["channel"]["media"]["fetchRemoteMedia"],
    },
  },
} as unknown as PluginRuntime;

describe("downloadBlueBubblesAttachment", () => {
  beforeEach(() => {
    fetchRemoteMediaMock.mockClear();
    mockFetch.mockReset();
    setBlueBubblesRuntime(runtimeStub);
  });

  async function expectAttachmentTooLarge(params: { bufferBytes: number; maxBytes?: number }) {
    const largeBuffer = new Uint8Array(params.bufferBytes);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers(),
      arrayBuffer: () => Promise.resolve(largeBuffer.buffer),
    });

    const attachment: BlueBubblesAttachment = { guid: "att-large" };
    await expect(
      downloadBlueBubblesAttachment(attachment, {
        serverUrl: "http://localhost:1234",
        password: "test",
        ...(params.maxBytes === undefined ? {} : { maxBytes: params.maxBytes }),
      }),
    ).rejects.toThrow("too large");
  }

  function mockSuccessfulAttachmentDownload(buffer = new Uint8Array([1])) {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers(),
      arrayBuffer: () => Promise.resolve(buffer.buffer),
    });
    return buffer;
  }

  it("throws when guid is missing", async () => {
    const attachment: BlueBubblesAttachment = {};
    await expect(
      downloadBlueBubblesAttachment(attachment, {
        serverUrl: "http://localhost:1234",
        password: "test-password",
      }),
    ).rejects.toThrow("guid is required");
  });

  it("throws when guid is empty string", async () => {
    const attachment: BlueBubblesAttachment = { guid: "  " };
    await expect(
      downloadBlueBubblesAttachment(attachment, {
        serverUrl: "http://localhost:1234",
        password: "test-password",
      }),
    ).rejects.toThrow("guid is required");
  });

  it("throws when serverUrl is missing", async () => {
    const attachment: BlueBubblesAttachment = { guid: "att-123" };
    await expect(downloadBlueBubblesAttachment(attachment, {})).rejects.toThrow(
      "serverUrl is required",
    );
  });

  it("throws when password is missing", async () => {
    const attachment: BlueBubblesAttachment = { guid: "att-123" };
    await expect(
      downloadBlueBubblesAttachment(attachment, {
        serverUrl: "http://localhost:1234",
      }),
    ).rejects.toThrow("password is required");
  });

  it("downloads attachment successfully", async () => {
    const mockBuffer = new Uint8Array([1, 2, 3, 4]);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ "content-type": "image/png" }),
      arrayBuffer: () => Promise.resolve(mockBuffer.buffer),
    });

    const attachment: BlueBubblesAttachment = { guid: "att-123" };
    const result = await downloadBlueBubblesAttachment(attachment, {
      serverUrl: "http://localhost:1234",
      password: "test-password",
    });

    expect(result.buffer).toEqual(mockBuffer);
    expect(result.contentType).toBe("image/png");
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/attachment/att-123/download"),
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("includes password in URL query", async () => {
    const mockBuffer = new Uint8Array([1, 2, 3, 4]);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ "content-type": "image/jpeg" }),
      arrayBuffer: () => Promise.resolve(mockBuffer.buffer),
    });

    const attachment: BlueBubblesAttachment = { guid: "att-456" };
    await downloadBlueBubblesAttachment(attachment, {
      serverUrl: "http://localhost:1234",
      password: "my-secret-password",
    });

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("password=my-secret-password");
  });

  it("encodes guid in URL", async () => {
    mockSuccessfulAttachmentDownload();

    const attachment: BlueBubblesAttachment = { guid: "att/with/special chars" };
    await downloadBlueBubblesAttachment(attachment, {
      serverUrl: "http://localhost:1234",
      password: "test",
    });

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("att%2Fwith%2Fspecial%20chars");
  });

  it("throws on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: () => Promise.resolve("Attachment not found"),
    });

    const attachment: BlueBubblesAttachment = { guid: "att-missing" };
    await expect(
      downloadBlueBubblesAttachment(attachment, {
        serverUrl: "http://localhost:1234",
        password: "test",
      }),
    ).rejects.toThrow("Attachment not found");
  });

  it("throws when attachment exceeds max bytes", async () => {
    await expectAttachmentTooLarge({
      bufferBytes: 10 * 1024 * 1024,
      maxBytes: 5 * 1024 * 1024,
    });
  });

  it("uses default max bytes when not specified", async () => {
    await expectAttachmentTooLarge({ bufferBytes: 9 * 1024 * 1024 });
  });

  it("uses attachment mimeType as fallback when response has no content-type", async () => {
    const mockBuffer = new Uint8Array([1, 2, 3]);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers(),
      arrayBuffer: () => Promise.resolve(mockBuffer.buffer),
    });

    const attachment: BlueBubblesAttachment = {
      guid: "att-789",
      mimeType: "video/mp4",
    };
    const result = await downloadBlueBubblesAttachment(attachment, {
      serverUrl: "http://localhost:1234",
      password: "test",
    });

    expect(result.contentType).toBe("video/mp4");
  });

  it("prefers response content-type over attachment mimeType", async () => {
    const mockBuffer = new Uint8Array([1, 2, 3]);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ "content-type": "image/webp" }),
      arrayBuffer: () => Promise.resolve(mockBuffer.buffer),
    });

    const attachment: BlueBubblesAttachment = {
      guid: "att-xyz",
      mimeType: "image/png",
    };
    const result = await downloadBlueBubblesAttachment(attachment, {
      serverUrl: "http://localhost:1234",
      password: "test",
    });

    expect(result.contentType).toBe("image/webp");
  });

  it("resolves credentials from config when opts not provided", async () => {
    mockSuccessfulAttachmentDownload();

    const attachment: BlueBubblesAttachment = { guid: "att-config" };
    const result = await downloadBlueBubblesAttachment(attachment, {
      cfg: {
        channels: {
          bluebubbles: {
            serverUrl: "http://config-server:5678",
            password: "config-password",
          },
        },
      },
    });

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("config-server:5678");
    expect(calledUrl).toContain("password=config-password");
    expect(result.buffer).toEqual(new Uint8Array([1]));
  });

  it("passes ssrfPolicy with allowPrivateNetwork when config enables it", async () => {
    mockSuccessfulAttachmentDownload();

    const attachment: BlueBubblesAttachment = { guid: "att-ssrf" };
    await downloadBlueBubblesAttachment(attachment, {
      cfg: {
        channels: {
          bluebubbles: {
            serverUrl: "http://localhost:1234",
            password: "test",
            network: {
              dangerouslyAllowPrivateNetwork: true,
            },
          },
        },
      },
    });

    const fetchMediaArgs = fetchRemoteMediaMock.mock.calls[0][0] as Record<string, unknown>;
    expect(fetchMediaArgs.ssrfPolicy).toEqual({ allowPrivateNetwork: true });
  });

  it("auto-enables private-network fetches for loopback serverUrl when allowPrivateNetwork is not set", async () => {
    mockSuccessfulAttachmentDownload();

    const attachment: BlueBubblesAttachment = { guid: "att-no-ssrf" };
    await downloadBlueBubblesAttachment(attachment, {
      serverUrl: "http://localhost:1234",
      password: "test",
      cfg: { channels: { bluebubbles: {} } },
    });

    const fetchMediaArgs = fetchRemoteMediaMock.mock.calls[0][0] as Record<string, unknown>;
    expect(fetchMediaArgs.ssrfPolicy).toEqual({ allowPrivateNetwork: true });
  });

  it("auto-enables private-network fetches for private IP serverUrl when allowPrivateNetwork is not set", async () => {
    mockSuccessfulAttachmentDownload();

    const attachment: BlueBubblesAttachment = { guid: "att-private-ip" };
    await downloadBlueBubblesAttachment(attachment, {
      serverUrl: "http://192.168.1.5:1234",
      password: "test",
      cfg: { channels: { bluebubbles: {} } },
    });

    const fetchMediaArgs = fetchRemoteMediaMock.mock.calls[0][0] as Record<string, unknown>;
    expect(fetchMediaArgs.ssrfPolicy).toEqual({ allowPrivateNetwork: true });
  });

  it("respects an explicit private-network opt-out for loopback serverUrl", async () => {
    mockSuccessfulAttachmentDownload();

    const attachment: BlueBubblesAttachment = { guid: "att-opt-out" };
    await downloadBlueBubblesAttachment(attachment, {
      serverUrl: "http://localhost:1234",
      password: "test",
      cfg: {
        channels: {
          bluebubbles: {
            network: {
              dangerouslyAllowPrivateNetwork: false,
            },
          },
        },
      },
    });

    const fetchMediaArgs = fetchRemoteMediaMock.mock.calls[0][0] as Record<string, unknown>;
    expect(fetchMediaArgs.ssrfPolicy).toBeUndefined();
  });

  it("allowlists public serverUrl hostname when allowPrivateNetwork is not set", async () => {
    mockSuccessfulAttachmentDownload();

    const attachment: BlueBubblesAttachment = { guid: "att-public-host" };
    await downloadBlueBubblesAttachment(attachment, {
      serverUrl: "https://bluebubbles.example.com:1234",
      password: "test",
    });

    const fetchMediaArgs = fetchRemoteMediaMock.mock.calls[0][0] as Record<string, unknown>;
    expect(fetchMediaArgs.ssrfPolicy).toEqual({ allowedHostnames: ["bluebubbles.example.com"] });
  });

  it("keeps public serverUrl hostname pinning when private-network access is explicitly disabled", async () => {
    mockSuccessfulAttachmentDownload();

    const attachment: BlueBubblesAttachment = { guid: "att-public-host-opt-out" };
    await downloadBlueBubblesAttachment(attachment, {
      serverUrl: "https://bluebubbles.example.com:1234",
      password: "test",
      cfg: {
        channels: {
          bluebubbles: {
            network: {
              dangerouslyAllowPrivateNetwork: false,
            },
          },
        },
      },
    });

    const fetchMediaArgs = fetchRemoteMediaMock.mock.calls[0][0] as Record<string, unknown>;
    expect(fetchMediaArgs.ssrfPolicy).toEqual({ allowedHostnames: ["bluebubbles.example.com"] });
  });
});

describe("sendBlueBubblesAttachment", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
    fetchRemoteMediaMock.mockClear();
    fetchServerInfoMock.mockReset();
    fetchServerInfoMock.mockResolvedValue(null);
    setBlueBubblesRuntime(runtimeStub);
    vi.mocked(getCachedBlueBubblesPrivateApiStatus).mockReset();
    mockBlueBubblesPrivateApiStatus(
      vi.mocked(getCachedBlueBubblesPrivateApiStatus),
      BLUE_BUBBLES_PRIVATE_API_STATUS.unknown,
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function decodeBody(body: Uint8Array) {
    return Buffer.from(body).toString("utf8");
  }

  function expectVoiceAttachmentBody() {
    const body = mockFetch.mock.calls[0][1]?.body as Uint8Array;
    const bodyText = decodeBody(body);
    expect(bodyText).toContain('name="isAudioMessage"');
    expect(bodyText).toContain("true");
    return bodyText;
  }

  it("marks voice memos when asVoice is true and mp3 is provided", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ messageId: "msg-1" })),
    });

    await sendBlueBubblesAttachment({
      to: "chat_guid:iMessage;-;+15551234567",
      buffer: new Uint8Array([1, 2, 3]),
      filename: "voice.mp3",
      contentType: "audio/mpeg",
      asVoice: true,
      opts: { serverUrl: "http://localhost:1234", password: "test" },
    });

    const bodyText = expectVoiceAttachmentBody();
    expect(bodyText).toContain('filename="voice.mp3"');
  });

  it("normalizes mp3 filenames for voice memos", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ messageId: "msg-2" })),
    });

    await sendBlueBubblesAttachment({
      to: "chat_guid:iMessage;-;+15551234567",
      buffer: new Uint8Array([1, 2, 3]),
      filename: "voice",
      contentType: "audio/mpeg",
      asVoice: true,
      opts: { serverUrl: "http://localhost:1234", password: "test" },
    });

    const bodyText = expectVoiceAttachmentBody();
    expect(bodyText).toContain('filename="voice.mp3"');
    expect(bodyText).toContain('name="voice.mp3"');
  });

  it("throws when asVoice is true but media is not audio", async () => {
    await expect(
      sendBlueBubblesAttachment({
        to: "chat_guid:iMessage;-;+15551234567",
        buffer: new Uint8Array([1, 2, 3]),
        filename: "image.png",
        contentType: "image/png",
        asVoice: true,
        opts: { serverUrl: "http://localhost:1234", password: "test" },
      }),
    ).rejects.toThrow("voice messages require audio");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("throws when asVoice is true but audio is not mp3 or caf", async () => {
    await expect(
      sendBlueBubblesAttachment({
        to: "chat_guid:iMessage;-;+15551234567",
        buffer: new Uint8Array([1, 2, 3]),
        filename: "voice.wav",
        contentType: "audio/wav",
        asVoice: true,
        opts: { serverUrl: "http://localhost:1234", password: "test" },
      }),
    ).rejects.toThrow("require mp3 or caf");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("sanitizes filenames before sending", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ messageId: "msg-3" })),
    });

    await sendBlueBubblesAttachment({
      to: "chat_guid:iMessage;-;+15551234567",
      buffer: new Uint8Array([1, 2, 3]),
      filename: "../evil.mp3",
      contentType: "audio/mpeg",
      opts: { serverUrl: "http://localhost:1234", password: "test" },
    });

    const body = mockFetch.mock.calls[0][1]?.body as Uint8Array;
    const bodyText = decodeBody(body);
    expect(bodyText).toContain('filename="evil.mp3"');
    expect(bodyText).toContain('name="evil.mp3"');
  });

  it("downgrades attachment reply threading when private API is disabled", async () => {
    mockBlueBubblesPrivateApiStatusOnce(
      vi.mocked(getCachedBlueBubblesPrivateApiStatus),
      BLUE_BUBBLES_PRIVATE_API_STATUS.disabled,
    );
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ messageId: "msg-4" })),
    });

    await sendBlueBubblesAttachment({
      to: "chat_guid:iMessage;-;+15551234567",
      buffer: new Uint8Array([1, 2, 3]),
      filename: "photo.jpg",
      contentType: "image/jpeg",
      replyToMessageGuid: "reply-guid-123",
      opts: { serverUrl: "http://localhost:1234", password: "test" },
    });

    const body = mockFetch.mock.calls[0][1]?.body as Uint8Array;
    const bodyText = decodeBody(body);
    expect(bodyText).not.toContain('name="method"');
    expect(bodyText).not.toContain('name="selectedMessageGuid"');
    expect(bodyText).not.toContain('name="partIndex"');
  });

  it("warns and downgrades attachment reply threading when private API status is unknown", async () => {
    const runtimeLog = vi.fn();
    setBlueBubblesRuntime({
      ...runtimeStub,
      log: runtimeLog,
    } as unknown as PluginRuntime);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ messageId: "msg-5" })),
    });

    await sendBlueBubblesAttachment({
      to: "chat_guid:iMessage;-;+15551234567",
      buffer: new Uint8Array([1, 2, 3]),
      filename: "photo.jpg",
      contentType: "image/jpeg",
      replyToMessageGuid: "reply-guid-unknown",
      opts: { serverUrl: "http://localhost:1234", password: "test" },
    });

    expect(runtimeLog).toHaveBeenCalledTimes(1);
    expect(runtimeLog.mock.calls[0]?.[0]).toContain("Private API status unknown");
    const body = mockFetch.mock.calls[0][1]?.body as Uint8Array;
    const bodyText = decodeBody(body);
    expect(bodyText).not.toContain('name="selectedMessageGuid"');
    expect(bodyText).not.toContain('name="partIndex"');
  });

  it("auto-creates a new chat when sending to a phone number with no existing chat", async () => {
    // First call: resolveChatGuidForTarget queries chats, returns empty (no match)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: [] }),
    });
    // Second call: createChatForHandle creates new chat
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            data: { chatGuid: "iMessage;-;+15559876543", guid: "iMessage;-;+15559876543" },
          }),
        ),
    });
    // Third call: actual attachment send
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ data: { guid: "attach-msg-1" } })),
    });

    const result = await sendBlueBubblesAttachment({
      to: "+15559876543",
      buffer: new Uint8Array([1, 2, 3]),
      filename: "photo.jpg",
      contentType: "image/jpeg",
      opts: { serverUrl: "http://localhost:1234", password: "test" },
    });

    expect(result.messageId).toBe("attach-msg-1");
    // Verify chat creation was called
    const createCallBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(createCallBody.addresses).toEqual(["+15559876543"]);
    // Verify attachment was sent to the newly created chat
    const attachBody = mockFetch.mock.calls[2][1]?.body as Uint8Array;
    const attachText = decodeBody(attachBody);
    expect(attachText).toContain("iMessage;-;+15559876543");
  });

  it("retries chatGuid resolution after creating a chat with no returned guid", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: [] }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ data: {} })),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: [{ guid: "iMessage;-;+15557654321" }] }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ data: { guid: "attach-msg-2" } })),
    });

    const result = await sendBlueBubblesAttachment({
      to: "+15557654321",
      buffer: new Uint8Array([4, 5, 6]),
      filename: "photo.jpg",
      contentType: "image/jpeg",
      opts: { serverUrl: "http://localhost:1234", password: "test" },
    });

    expect(result.messageId).toBe("attach-msg-2");
    const createCallBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(createCallBody.addresses).toEqual(["+15557654321"]);
    const attachBody = mockFetch.mock.calls[3][1]?.body as Uint8Array;
    const attachText = decodeBody(attachBody);
    expect(attachText).toContain("iMessage;-;+15557654321");
  });

  describe("lazy private API refresh (#43764)", () => {
    const privateApiStatusMock = vi.mocked(getCachedBlueBubblesPrivateApiStatus);

    it("refreshes cache when expired and reply threading is requested", async () => {
      privateApiStatusMock.mockReturnValueOnce(null).mockReturnValueOnce(true);
      fetchServerInfoMock.mockResolvedValueOnce({ private_api: true });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ data: { guid: "msg-refreshed" } })),
      });

      const result = await sendBlueBubblesAttachment({
        to: "chat_guid:iMessage;-;+15551234567",
        buffer: new Uint8Array([1, 2, 3]),
        filename: "photo.jpg",
        contentType: "image/jpeg",
        replyToMessageGuid: "reply-guid-456",
        opts: { serverUrl: "http://localhost:1234", password: "test" },
      });

      expect(result.messageId).toBe("msg-refreshed");
      expect(fetchServerInfoMock).toHaveBeenCalledTimes(1);
      const body = mockFetch.mock.calls[0][1]?.body as Uint8Array;
      const bodyText = decodeBody(body);
      expect(bodyText).toContain('name="method"');
      expect(bodyText).toContain("private-api");
      expect(bodyText).toContain('name="selectedMessageGuid"');
    });

    it("does not refresh when cache is populated (cache hit)", async () => {
      mockBlueBubblesPrivateApiStatusOnce(
        privateApiStatusMock,
        BLUE_BUBBLES_PRIVATE_API_STATUS.enabled,
      );
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ data: { guid: "msg-cached" } })),
      });

      await sendBlueBubblesAttachment({
        to: "chat_guid:iMessage;-;+15551234567",
        buffer: new Uint8Array([1, 2, 3]),
        filename: "photo.jpg",
        contentType: "image/jpeg",
        replyToMessageGuid: "reply-guid-123",
        opts: { serverUrl: "http://localhost:1234", password: "test" },
      });

      expect(fetchServerInfoMock).not.toHaveBeenCalled();
    });

    it("degrades gracefully when refresh fails", async () => {
      fetchServerInfoMock.mockRejectedValueOnce(new Error("network error"));
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ data: { guid: "msg-degraded" } })),
      });

      const runtimeLog = vi.fn();
      setBlueBubblesRuntime({
        ...runtimeStub,
        log: runtimeLog,
      } as unknown as PluginRuntime);

      const result = await sendBlueBubblesAttachment({
        to: "chat_guid:iMessage;-;+15551234567",
        buffer: new Uint8Array([1, 2, 3]),
        filename: "photo.jpg",
        contentType: "image/jpeg",
        replyToMessageGuid: "reply-guid-789",
        opts: { serverUrl: "http://localhost:1234", password: "test" },
      });

      expect(result.messageId).toBe("msg-degraded");
      expect(fetchServerInfoMock).toHaveBeenCalledTimes(1);
      expect(runtimeLog).toHaveBeenCalledTimes(1);
      expect(runtimeLog.mock.calls[0]?.[0]).toContain("Private API status unknown");
    });

    it("degrades reply threading when refresh succeeds with private_api: false", async () => {
      privateApiStatusMock.mockReturnValueOnce(null).mockReturnValueOnce(false);
      fetchServerInfoMock.mockResolvedValueOnce({ private_api: false });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ data: { guid: "msg-disabled" } })),
      });

      const runtimeLog = vi.fn();
      setBlueBubblesRuntime({
        ...runtimeStub,
        log: runtimeLog,
      } as unknown as PluginRuntime);

      const result = await sendBlueBubblesAttachment({
        to: "chat_guid:iMessage;-;+15551234567",
        buffer: new Uint8Array([1, 2, 3]),
        filename: "photo.jpg",
        contentType: "image/jpeg",
        replyToMessageGuid: "reply-guid-disabled",
        opts: { serverUrl: "http://localhost:1234", password: "test" },
      });

      expect(result.messageId).toBe("msg-disabled");
      expect(fetchServerInfoMock).toHaveBeenCalledTimes(1);
      // No warning — status is known (disabled), not unknown
      expect(runtimeLog).not.toHaveBeenCalled();
      const body = mockFetch.mock.calls[0][1]?.body as Uint8Array;
      const bodyText = decodeBody(body);
      expect(bodyText).not.toContain('name="selectedMessageGuid"');
      expect(bodyText).not.toContain('name="method"');
    });

    it("does not refresh when no reply threading is requested", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ data: { guid: "msg-plain" } })),
      });

      await sendBlueBubblesAttachment({
        to: "chat_guid:iMessage;-;+15551234567",
        buffer: new Uint8Array([1, 2, 3]),
        filename: "photo.jpg",
        contentType: "image/jpeg",
        opts: { serverUrl: "http://localhost:1234", password: "test" },
      });

      expect(fetchServerInfoMock).not.toHaveBeenCalled();
    });
  });

  it("still throws for non-handle targets when chatGuid is not found", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: [] }),
    });

    await expect(
      sendBlueBubblesAttachment({
        to: "chat_id:999",
        buffer: new Uint8Array([1, 2, 3]),
        filename: "photo.jpg",
        opts: { serverUrl: "http://localhost:1234", password: "test" },
      }),
    ).rejects.toThrow("chatGuid not found");
  });
});

describe("fetchBlueBubblesMessageAttachments", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("returns attachments from the BB API response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            attachments: [
              {
                guid: "att-1",
                mimeType: "image/jpeg",
                transferName: "photo.jpg",
                totalBytes: 1024,
              },
              {
                guid: "att-2",
                mime_type: "image/png",
                transfer_name: "screenshot.png",
                total_bytes: 2048,
              },
            ],
          },
        }),
    });
    const result = await fetchBlueBubblesMessageAttachments("msg-guid", {
      baseUrl: "http://localhost:1234",
      password: "test",
    });
    expect(result).toHaveLength(2);
    expect(result[0].guid).toBe("att-1");
    expect(result[0].mimeType).toBe("image/jpeg");
    expect(result[1].guid).toBe("att-2");
    expect(result[1].mimeType).toBe("image/png");
  });

  it("returns empty array on non-ok HTTP response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
    });
    const result = await fetchBlueBubblesMessageAttachments("msg-guid", {
      baseUrl: "http://localhost:1234",
      password: "test",
    });
    expect(result).toEqual([]);
  });

  it("returns empty array when data has no attachments", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: {} }),
    });
    const result = await fetchBlueBubblesMessageAttachments("msg-guid", {
      baseUrl: "http://localhost:1234",
      password: "test",
    });
    expect(result).toEqual([]);
  });

  it("includes entries without a guid (downstream download handles filtering)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            attachments: [{ mimeType: "image/jpeg" }, { guid: "att-valid", mimeType: "image/png" }],
          },
        }),
    });
    const result = await fetchBlueBubblesMessageAttachments("msg-guid", {
      baseUrl: "http://localhost:1234",
      password: "test",
    });
    expect(result).toHaveLength(2);
    expect(result[0].guid).toBeUndefined();
    expect(result[1].guid).toBe("att-valid");
  });
});
