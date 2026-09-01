// QA Lab Matrix tests cover scenario runtime shared plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildMatrixNoticeArtifact,
  buildMatrixReplyArtifact,
  resolveMatrixQaNoReplyWindowMs,
  runNoReplyExpectedScenario,
  truncateMatrixQaPreview,
} from "./scenario-runtime-shared.js";

describe("matrix scenario runtime shared", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("normalizes the Matrix QA no-reply window env", () => {
    expect(resolveMatrixQaNoReplyWindowMs(30_000)).toBe(8_000);

    vi.stubEnv("OPENCLAW_QA_MATRIX_NO_REPLY_WINDOW_MS", "12000");
    expect(resolveMatrixQaNoReplyWindowMs(30_000)).toBe(12_000);
    expect(resolveMatrixQaNoReplyWindowMs(5_000)).toBe(5_000);

    for (const value of ["1e3", "0x1000", "1.5", "nope"]) {
      vi.stubEnv("OPENCLAW_QA_MATRIX_NO_REPLY_WINDOW_MS", value);
      expect(resolveMatrixQaNoReplyWindowMs(30_000)).toBe(8_000);
    }
  });

  it.each([
    { observeTrigger: false, reply: false, error: "did not observe the trigger event" },
    { observeTrigger: true, reply: false, error: undefined },
    { observeTrigger: true, reply: true, error: "unexpected SUT reply" },
  ])(
    "requires observed ingress throughout the no-reply window (trigger=$observeTrigger, reply=$reply)",
    async ({ observeTrigger, reply, error }) => {
      vi.useFakeTimers();
      let polls = 0;
      const fetchImpl: typeof fetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input);
        if (init?.method === "PUT") {
          return Response.json({ event_id: "$trigger" });
        }
        if (!url.searchParams.has("since")) {
          return Response.json({ next_batch: "primed" });
        }
        polls += 1;
        if (polls > 1) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, Number(url.searchParams.get("timeout")));
          });
        }
        const event =
          polls === 1 && observeTrigger
            ? { event_id: "$trigger", sender: "@observer:matrix-qa.test" }
            : polls > 1 && reply
              ? { event_id: "$reply", sender: "@sut:matrix-qa.test" }
              : undefined;
        return Response.json({
          next_batch: `batch-${polls}`,
          rooms: {
            join: {
              "!room:matrix-qa.test": {
                timeline: {
                  events: event
                    ? [{ ...event, type: "m.room.message", content: { body: "marker" } }]
                    : [],
                },
              },
            },
          },
        });
      };
      vi.stubGlobal("fetch", fetchImpl);
      let settled = false;
      const pending = runNoReplyExpectedScenario({
        accessToken: "token",
        actorId: "observer",
        actorUserId: "@observer:matrix-qa.test",
        baseUrl: "http://127.0.0.1:28008/",
        body: "marker",
        observedEvents: [],
        roomId: "!room:matrix-qa.test",
        syncState: {},
        sutUserId: "@sut:matrix-qa.test",
        timeoutMs: 8_000,
        token: "marker",
      }).then(
        (value) => ({ value }),
        (failure: unknown) => ({ error: failure }),
      );
      void pending.then(() => {
        settled = true;
      });
      try {
        await vi.advanceTimersByTimeAsync(7_999);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        const result = await pending;
        if (error) {
          expect(result).toMatchObject({
            error: expect.objectContaining({ message: expect.stringContaining(error) }),
          });
        } else {
          expect(result).toMatchObject({
            value: { artifacts: { driverEventId: "$trigger", expectedNoReplyWindowMs: 8_000 } },
          });
        }
      } finally {
        await vi.runAllTimersAsync();
        await pending;
        vi.unstubAllGlobals();
        vi.useRealTimers();
      }
    },
  );

  it("keeps every shared Matrix preview UTF-16 safe", () => {
    const prefix = "a".repeat(199);
    const event = {
      kind: "message" as const,
      roomId: "!room:matrix-qa.test",
      eventId: "$event",
      sender: "@sut:matrix-qa.test",
      type: "m.room.message",
    };
    expect(truncateMatrixQaPreview(`${prefix}😀tail`)).toBe(prefix);
    expect(buildMatrixReplyArtifact({ ...event, body: `${prefix}😀tail` }).bodyPreview).toBe(
      prefix,
    );
    expect(buildMatrixNoticeArtifact({ ...event, body: `${prefix}😀tail` }).bodyPreview).toBe(
      prefix,
    );
    expect(buildMatrixReplyArtifact({ ...event, body: " " }).bodyPreview).toBe("");
  });
});
