import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { discardIgnoredResponseBody, readQaJsonResponse } from "./ignored-response-body.js";

describe("discardIgnoredResponseBody", () => {
  it("swallows cancellation failures for an unread body", async () => {
    const cancel = vi.fn(() => {
      throw new Error("cancel failed");
    });
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }));

    await expect(discardIgnoredResponseBody(response)).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not cancel a body a caller already consumed", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("done"));
          controller.close();
        },
        cancel,
      }),
    );
    await response.text();

    await discardIgnoredResponseBody(response);
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe("readQaJsonResponse", () => {
  it.each([
    { name: "oversized", body: `{"padding":"${"x".repeat(1 << 20)}"}`, error: /exceeds 1048576/ },
    { name: "stalled", body: "[", error: /stalled for 5000ms/ },
  ])("bounds $name local provider responses and releases the request", async ({ body, error }) => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write(body);
      if (body !== "[") {
        response.end();
      }
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    const release = vi.fn(async () => {});

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}`);
      await expect(readQaJsonResponse(response, release, "qa response")).rejects.toThrow(error);
      expect(release).toHaveBeenCalledOnce();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((closeError) => (closeError ? reject(closeError) : resolve()));
      });
    }
  });
});
