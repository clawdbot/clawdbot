import { describe, expect, it } from "vitest";
import { normalizeCardPayload } from "./normalization.ts";

function cardPayload(overrides: Record<string, unknown> = {}) {
  return {
    card: {
      id: "card-1",
      title: "Proof history",
      status: "review",
      priority: "normal",
      labels: [],
      position: 1000,
      createdAt: 1,
      updatedAt: 2,
      ...overrides,
    },
  };
}

describe("Workboard card normalization", () => {
  it("synthesizes proof page information for legacy card payloads", () => {
    const card = normalizeCardPayload(
      cardPayload({
        metadata: {
          proof: [
            { id: "proof-1", status: "passed", createdAt: 1 },
            { id: "proof-2", status: "failed", createdAt: 2 },
          ],
        },
      }),
    );

    expect(card.proofPage).toEqual({ total: 2, hasMore: false });
  });

  it("normalizes projected proof page information", () => {
    const card = normalizeCardPayload(
      cardPayload({
        metadata: {
          proof: [{ id: "proof-100", status: "passed", createdAt: 100 }],
        },
        proofPage: {
          total: 100,
          hasMore: true,
          nextCursor: " proof-100 ",
        },
      }),
    );

    expect(card.proofPage).toEqual({
      total: 100,
      hasMore: true,
      nextCursor: "proof-100",
    });
  });
});
