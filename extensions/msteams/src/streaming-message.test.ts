import { afterEach, describe, expect, it, vi } from "vitest";
import { TeamsHttpStream } from "./streaming-message.js";

describe("TeamsHttpStream", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends first chunk as typing activity with streaminfo", async () => {
    const sent: unknown[] = [];
    const stream = new TeamsHttpStream({
      sendActivity: vi.fn(async (activity) => {
        sent.push(activity);
        return { id: "stream-1" };
      }),
    });

    // Enough text to pass MIN_INITIAL_CHARS threshold
    stream.update("Hello, this is a test response that is long enough.");

    // Wait for throttle to flush
    await new Promise((r) => setTimeout(r, 700));

    expect(sent.length).toBeGreaterThanOrEqual(1);
    const firstActivity = sent[0] as Record<string, unknown>;
    expect(firstActivity.type).toBe("typing");
    expect(typeof firstActivity.text).toBe("string");
    expect(firstActivity.text as string).toContain("Hello");
    // Should have streaminfo entity
    const entities = firstActivity.entities as Array<Record<string, unknown>>;
    expect(entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "streaminfo", streamType: "streaming" }),
      ]),
    );
  });

  it("sends final message activity on finalize", async () => {
    const sent: unknown[] = [];
    const stream = new TeamsHttpStream({
      sendActivity: vi.fn(async (activity) => {
        sent.push(activity);
        return { id: "stream-1" };
      }),
    });

    stream.update("Hello, this is a complete response for finalization testing.");
    await new Promise((r) => setTimeout(r, 700));

    await stream.finalize();

    // Find the final message activity
    const finalActivity = sent.find((a) => (a as Record<string, unknown>).type === "message") as
      | Record<string, unknown>
      | undefined;

    expect(finalActivity).toBeDefined();
    expect(finalActivity!.text).toBe(
      "Hello, this is a complete response for finalization testing.",
    );
    // No cursor in final
    expect(finalActivity!.text as string).not.toContain("\u258D");

    // Should have AI-generated entity
    const entities = finalActivity!.entities as Array<Record<string, unknown>>;
    expect(entities).toEqual(
      expect.arrayContaining([expect.objectContaining({ additionalType: ["AIGeneratedContent"] })]),
    );

    // Should have streaminfo with final type
    expect(entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "streaminfo", streamType: "final" }),
      ]),
    );
  });

  it("does not send below MIN_INITIAL_CHARS", async () => {
    const sendActivity = vi.fn(async () => ({ id: "x" }));
    const stream = new TeamsHttpStream({ sendActivity });

    stream.update("Hi");
    await new Promise((r) => setTimeout(r, 700));

    expect(sendActivity).not.toHaveBeenCalled();
  });

  it("finalize with no content does nothing", async () => {
    const sendActivity = vi.fn(async () => ({ id: "x" }));
    const stream = new TeamsHttpStream({ sendActivity });

    await stream.finalize();
    expect(sendActivity).not.toHaveBeenCalled();
  });

  it("finalize sends content even if no chunks were streamed", async () => {
    const sent: unknown[] = [];
    const stream = new TeamsHttpStream({
      sendActivity: vi.fn(async (activity) => {
        sent.push(activity);
        return { id: "msg-1" };
      }),
    });

    // Short text — below MIN_INITIAL_CHARS, so no streaming chunk sent
    stream.update("Short");
    await stream.finalize();

    // Should send final message even though no chunks were streamed
    expect(sent.length).toBe(1);
    const activity = sent[0] as Record<string, unknown>;
    expect(activity.type).toBe("message");
    expect(activity.text).toBe("Short");
  });

  it("sets feedbackLoopEnabled on final message", async () => {
    const sent: unknown[] = [];
    const stream = new TeamsHttpStream({
      sendActivity: vi.fn(async (activity) => {
        sent.push(activity);
        return { id: "stream-1" };
      }),
      feedbackLoopEnabled: true,
    });

    stream.update("A response long enough to pass the minimum character threshold for streaming.");
    await new Promise((r) => setTimeout(r, 700));
    await stream.finalize();

    const finalActivity = sent.find(
      (a) => (a as Record<string, unknown>).type === "message",
    ) as Record<string, unknown>;

    const channelData = finalActivity.channelData as Record<string, unknown>;
    expect(channelData.feedbackLoopEnabled).toBe(true);
  });

  it("sends informative update with streamType informative", async () => {
    const sent: unknown[] = [];
    const stream = new TeamsHttpStream({
      sendActivity: vi.fn(async (activity) => {
        sent.push(activity);
        return { id: "stream-1" };
      }),
    });

    await stream.sendInformativeUpdate("Thinking...");

    expect(sent.length).toBe(1);
    const activity = sent[0] as Record<string, unknown>;
    expect(activity.type).toBe("typing");
    expect(activity.text).toBe("Thinking...");
    const entities = activity.entities as Array<Record<string, unknown>>;
    expect(entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "streaminfo",
          streamType: "informative",
          streamSequence: 1,
        }),
      ]),
    );
  });

  it("informative update establishes streamId for subsequent chunks", async () => {
    const sent: unknown[] = [];
    const stream = new TeamsHttpStream({
      sendActivity: vi.fn(async (activity) => {
        sent.push(activity);
        return { id: "stream-1" };
      }),
    });

    await stream.sendInformativeUpdate("Working...");
    stream.update("Hello, this is a long enough response for streaming to begin.");
    await new Promise((r) => setTimeout(r, 1600));

    // Second activity (streaming chunk) should have the streamId from the informative update
    expect(sent.length).toBeGreaterThanOrEqual(2);
    const chunk = sent[1] as Record<string, unknown>;
    const entities = chunk.entities as Array<Record<string, unknown>>;
    expect(entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "streaminfo", streamId: "stream-1" }),
      ]),
    );
  });

  it("hasContent is true after update", () => {
    const stream = new TeamsHttpStream({
      sendActivity: vi.fn(async () => ({ id: "x" })),
    });

    expect(stream.hasContent).toBe(false);
    stream.update("some text");
    expect(stream.hasContent).toBe(true);
  });

  it("double finalize is a no-op", async () => {
    const sendActivity = vi.fn(async () => ({ id: "x" }));
    const stream = new TeamsHttpStream({ sendActivity });

    stream.update("A response long enough to pass the minimum character threshold.");
    await stream.finalize();
    const callCount = sendActivity.mock.calls.length;

    await stream.finalize();
    expect(sendActivity.mock.calls.length).toBe(callCount);
  });

  it("stops streaming before stream age timeout and finalizes with last good text", async () => {
    vi.useFakeTimers();

    const sent: unknown[] = [];
    const sendActivity = vi.fn(async (activity) => {
      sent.push(activity);
      return { id: "stream-1" };
    });
    const stream = new TeamsHttpStream({ sendActivity, throttleMs: 1 });

    stream.update("Hello, this is a long enough response for streaming to begin.");
    await vi.advanceTimersByTimeAsync(1);

    stream.update(
      "Hello, this is a long enough response for streaming to begin. More text before timeout.",
    );
    await vi.advanceTimersByTimeAsync(1);

    vi.setSystemTime(new Date(Date.now() + 45_001));
    stream.update(
      "Hello, this is a long enough response for streaming to begin. More text before timeout. Even more text after timeout.",
    );
    await vi.advanceTimersByTimeAsync(1);

    expect(stream.isFailed).toBe(true);

    const finalActivity = sent.find((a) => (a as Record<string, unknown>).type === "message") as
      | Record<string, unknown>
      | undefined;

    expect(finalActivity).toBeDefined();
    expect(finalActivity!.text).toBe(
      "Hello, this is a long enough response for streaming to begin. More text before timeout.",
    );
  });
});
