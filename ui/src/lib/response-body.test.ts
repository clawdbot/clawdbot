import { describe, expect, it } from "vitest";
import { readResponseTextWithLimit } from "./response-body.js";

describe("readResponseTextWithLimit", () => {
  it.each([-1, Number.NEGATIVE_INFINITY])(
    "rejects an empty streamed chunk against a negative byte budget (%s)",
    async (maxBytes) => {
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array());
            controller.close();
          },
        }),
      );

      await expect(
        readResponseTextWithLimit(response, {
          maxBytes,
          tooLargeMessage: "response exceeds its byte budget",
        }),
      ).rejects.toThrow("response exceeds its byte budget");
      expect(response.body?.locked).toBe(false);
    },
  );
});
