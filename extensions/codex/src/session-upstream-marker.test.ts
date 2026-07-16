import { describe, expect, it } from "vitest";
import type { CodexThread } from "./app-server/protocol.js";
import { codexUpstreamBaseline } from "./session-upstream-marker.js";

const normalizeTurnId = (value: unknown) =>
  typeof value === "string" && value ? value : undefined;

describe("codexUpstreamBaseline", () => {
  it("baselines an active adoption-time turn including its current user items", () => {
    const thread = {
      id: "thread-1",
      turns: [
        {
          id: "turn-done",
          status: "completed",
          items: [{ type: "userMessage", text: "old prompt" }],
        },
        {
          id: "turn-active",
          status: "inProgress",
          items: [
            { type: "userMessage", text: "current prompt" },
            { type: "userMessage", text: "steer before adoption" },
          ],
        },
      ],
    } as unknown as CodexThread;

    // Skipping to the last terminal turn would replay the active turn's existing
    // user items as external activity once it completes.
    expect(codexUpstreamBaseline(thread, normalizeTurnId)).toEqual({
      turnId: "turn-active",
      userMessageCount: 2,
    });
  });

  it("falls back to the newest identifiable turn and null on empty threads", () => {
    const empty = { id: "thread-2", turns: [] } as unknown as CodexThread;
    expect(codexUpstreamBaseline(empty, normalizeTurnId)).toEqual({
      turnId: null,
      userMessageCount: 0,
    });
  });
});
