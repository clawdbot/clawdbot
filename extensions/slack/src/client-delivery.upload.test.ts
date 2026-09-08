import type { WebClient } from "@slack/web-api";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { WebMediaResult } from "openclaw/plugin-sdk/web-media";
import { afterEach, describe, expect, it, vi } from "vitest";

const { loadMedia, guardedFetch } = vi.hoisted(() => ({
  loadMedia: vi.fn<() => Promise<WebMediaResult>>(),
  guardedFetch: vi.fn<typeof import("openclaw/plugin-sdk/ssrf-runtime").fetchWithSsrFGuard>(),
}));

vi.mock("openclaw/plugin-sdk/outbound-media", () => ({
  loadOutboundMediaFromUrl: loadMedia,
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: guardedFetch,
}));

const { uploadSlackFile } = await import("./client-delivery.js");

afterEach(() => {
  vi.resetAllMocks();
});

describe("uploadSlackFile snapshots", () => {
  it.each(["image/png", undefined])("preserves upload bytes and MIME %s", async (contentType) => {
    const backing = Buffer.from([0xfe, 0xfd, 1, 2, 3, 0xfc]);
    const buffer = backing.subarray(2, 5);
    const expectedBytes = Buffer.from([0, 0x80, 0xff]);
    loadMedia.mockResolvedValue({ buffer, contentType, kind: "image", fileName: "image.png" });
    const urlReady = createDeferred<void>();
    const getUploadURLExternal = vi.fn(async () => {
      await urlReady.promise;
      return { ok: true, upload_url: "https://files.slack.com/upload", file_id: "F123" };
    });
    const completeUploadExternal = vi.fn(async () => ({ ok: true }));
    const client = {
      files: { getUploadURLExternal, completeUploadExternal },
    } as unknown as WebClient;
    let uploadedBytes: Buffer | undefined;
    let uploadedMime: string | null | undefined;
    guardedFetch.mockImplementation(async (params) => {
      backing.fill(0);
      const request = new Request(params.url, params.init);
      uploadedBytes = Buffer.from(await request.arrayBuffer());
      uploadedMime = request.headers.get("content-type");
      return {
        response: new Response("ok"),
        finalUrl: params.url,
        release: async () => {},
      };
    });

    const upload = uploadSlackFile({ client, channelId: "C123", mediaUrl: "/tmp/image.png" });
    await vi.waitFor(() => expect(getUploadURLExternal).toHaveBeenCalledOnce());
    expect(guardedFetch).not.toHaveBeenCalled();
    expectedBytes.copy(buffer);
    urlReady.resolve();
    await expect(upload).resolves.toBe("F123");

    expect(uploadedBytes).toEqual(expectedBytes);
    expect(uploadedMime).toBe(contentType ?? null);
    expect(completeUploadExternal).toHaveBeenCalledOnce();
  });
});
