import { withServer } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { downloadXaiVideo } from "./video-generation-transport.js";

function downloadVideo(fetchFn: typeof fetch) {
  return downloadXaiVideo({
    url: "https://example.com/generated.mp4",
    defaultTimeoutMs: 5_000,
    fetchFn,
    maxBytes: 10 * 1024 * 1024,
    allowPrivateNetwork: false,
  });
}

describe("downloadXaiVideo", () => {
  it("returns the downloaded video bytes for a well-formed binary response", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response("mp4-bytes", { status: 200, headers: { "content-type": "video/mp4" } }),
    );

    const video = await downloadVideo(fetchFn);

    expect(video.mimeType).toBe("video/mp4");
    expect(video.fileName).toBe("video-1.mp4");
    expect(video.buffer?.toString("utf8")).toBe("mp4-bytes");
  });

  it.each([
    { name: "JSON error", contentType: "application/json", body: '{"error":"denied"}' },
    { name: "problem JSON", contentType: "application/problem+json", body: '{"title":"denied"}' },
    { name: "HTML", contentType: "text/html; charset=utf-8", body: "<html>sign in</html>" },
    { name: "empty video", contentType: "video/mp4", body: "" },
  ])("rejects a successful $name response as generated video", async ({ contentType, body }) => {
    const fetchFn = vi.fn(
      async () => new Response(body, { status: 200, headers: { "content-type": contentType } }),
    );

    await expect(downloadVideo(fetchFn)).rejects.toThrow(
      "xAI generated video download: malformed video response",
    );
  });

  it("closes the upstream socket for a never-ending malformed response over a real connection", async () => {
    let notifySocketClosed: ((closed: boolean) => void) | undefined;
    const socketClosed = new Promise<boolean>((resolve) => {
      notifySocketClosed = resolve;
    });
    await withServer(
      (request, response) => {
        request.socket.once("close", () => notifySocketClosed?.(true));
        response.writeHead(200, { "content-type": "application/json" });
        // Headers land, then the body never ends: only an explicit cancel closes this.
        response.write('{"error":"still streaming');
      },
      async (baseUrl) => {
        await expect(
          downloadXaiVideo({
            url: `${baseUrl}/generated.mp4`,
            defaultTimeoutMs: 5_000,
            fetchFn: fetch,
            maxBytes: 10 * 1024 * 1024,
            allowPrivateNetwork: true,
          }),
        ).rejects.toThrow("xAI generated video download: malformed video response");

        await expect(socketClosed).resolves.toBe(true);
      },
    );
  });
});
