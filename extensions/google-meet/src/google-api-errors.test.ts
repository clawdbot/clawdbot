// Google Meet tests cover bounded Google API error handling.
import { describe, expect, it, vi } from "vitest";
import { googleApiError } from "./google-api-errors.js";

function cancelTrackedResponse(
  text: string,
  init: ResponseInit,
): {
  response: Response;
  wasCanceled: () => boolean;
} {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
    },
    cancel() {
      canceled = true;
    },
  });
  return {
    response: new Response(stream, init),
    wasCanceled: () => canceled,
  };
}

describe("googleApiError", () => {
  it("bounds Google API error bodies without using response.text()", async () => {
    const tracked = cancelTrackedResponse(`${"access denied ".repeat(1024)}tail`, {
      status: 403,
      headers: { "content-type": "text/plain" },
    });
    const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));

    const error = await googleApiError({
      response: tracked.response,
      prefix: "Google Meet spaces.get",
      scopes: ["https://www.googleapis.com/auth/meetings.space.readonly"],
    });

    expect(error.message).toContain("Google Meet spaces.get failed (403): access denied");
    expect(error.message).not.toContain("tail");
    expect(error.message.length).toBeLessThan(8_400);
    expect(tracked.wasCanceled()).toBe(true);
    expect(textSpy).not.toHaveBeenCalled();
  });
});
