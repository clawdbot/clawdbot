import { describe, expect, it } from "vitest";
import { createResponseModelTracker } from "./openai-transport-shared.js";

function websocketEvents(...events: unknown[]): AsyncIterable<unknown> {
  return (async function* () {
    yield* events;
  })();
}

async function consume(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const event of stream) {
    void event;
    // Model evidence is observed as the transport consumes each event.
  }
}

describe("OpenAI response model tracker", () => {
  it("tracks provider model evidence from Responses lifecycle events", async () => {
    const tracker = createResponseModelTracker();

    await consume(
      tracker.track(
        undefined,
        websocketEvents({
          type: "response.created",
          response: { model: "gpt-5.6-luna" },
        }),
      ),
    );

    expect(tracker.resolve()).toBe("gpt-5.6-luna");
  });

  it("prefers a compatible dated model header over an undated lifecycle model", async () => {
    const tracker = createResponseModelTracker();

    await consume(
      tracker.track(
        new Response(null, {
          headers: { "openai-model": "gpt-5.6-luna-2026-08-01" },
        }),
        websocketEvents({
          type: "response.created",
          response: { model: "gpt-5.6-luna" },
        }),
      ),
    );

    expect(tracker.resolve()).toBe("gpt-5.6-luna-2026-08-01");
  });

  it("tracks WebSocket event evidence without an HTTP response", async () => {
    const tracker = createResponseModelTracker();

    await consume(
      tracker.track(
        undefined,
        websocketEvents({
          type: "response.completed",
          response: { headers: { "openai-model": "gpt-5.6-luna-2026-08-01" } },
        }),
      ),
    );

    expect(tracker.resolve()).toBe("gpt-5.6-luna-2026-08-01");
  });

  it("fails closed on conflicting WebSocket event evidence", async () => {
    const tracker = createResponseModelTracker();
    const tracked = tracker.track(
      undefined,
      websocketEvents(
        { headers: { "openai-model": "gpt-5.6-sol" } },
        {
          type: "response.completed",
          response: { headers: { "x-openai-model": "gpt-5.6-terra-2026-08-01" } },
        },
      ),
    );

    await expect(consume(tracked)).rejects.toThrow(
      "Conflicting OpenAI response model attestations",
    );
  });

  it("fails closed on conflicting lifecycle model evidence", async () => {
    const tracker = createResponseModelTracker();
    const tracked = tracker.track(
      undefined,
      websocketEvents(
        { type: "response.created", response: { model: "gpt-5.6-sol" } },
        { type: "response.completed", response: { model: "gpt-5.6-terra" } },
      ),
    );

    await expect(consume(tracked)).rejects.toThrow(
      "Conflicting OpenAI response model attestations",
    );
  });
});
