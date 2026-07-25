import { describe, expect, it, vi } from "vitest";
import { discardIgnoredResponseBody } from "./ignored-response-body.js";

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
