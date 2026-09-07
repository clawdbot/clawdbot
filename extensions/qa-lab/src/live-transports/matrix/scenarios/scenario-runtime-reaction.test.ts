import { afterEach, describe, expect, it, vi } from "vitest";
import { observeReactionScenario } from "./scenario-runtime-reaction.js";

const baseUrl = "http://127.0.0.1:28008";
const roomId = "!room:matrix-qa.test";

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("Matrix reaction scenarios", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("observes the sender echo from a scenario-owned cursor", async () => {
    const syncSince: Array<string | null> = [];
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      if (url.pathname.endsWith("/sync")) {
        const since = url.searchParams.get("since");
        syncSince.push(since);
        return jsonResponse(
          since
            ? {
                next_batch: "reaction-next",
                rooms: {
                  join: {
                    [roomId]: {
                      timeline: {
                        events: [
                          {
                            event_id: "$reaction",
                            sender: "@driver:matrix-qa.test",
                            type: "m.reaction",
                            content: {
                              "m.relates_to": {
                                rel_type: "m.annotation",
                                event_id: "$target",
                                key: "👍",
                              },
                            },
                          },
                        ],
                      },
                    },
                  },
                },
              }
            : { next_batch: "reaction-start" },
        );
      }
      if (url.pathname.includes("/send/m.reaction/")) {
        return jsonResponse({ event_id: "$reaction" });
      }
      throw new Error(`unexpected Matrix QA request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const observedEvents: Parameters<typeof observeReactionScenario>[0]["observedEvents"] = [];
    const result = await observeReactionScenario({
      accessToken: "driver-token",
      actorId: "driver",
      actorUserId: "@driver:matrix-qa.test",
      baseUrl,
      observedEvents,
      reactionTargetEventId: "$target",
      roomId,
      timeoutMs: 1_000,
    });

    expect(syncSince).toEqual([null, "reaction-start"]);
    expect(result.event.eventId).toBe("$reaction");
    expect(result.event.reaction).toEqual({ eventId: "$target", key: "👍" });
    expect(result.startSince).toBe("reaction-start");
    expect(result.since).toBe("reaction-next");
    expect(observedEvents).toContainEqual(result.event);
  });
});
