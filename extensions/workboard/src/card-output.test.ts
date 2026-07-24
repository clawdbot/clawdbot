import type { WorkboardCard, WorkboardProof } from "@openclaw/workboard-contract";
import { describe, expect, it } from "vitest";
import {
  paginateWorkboardProof,
  readWorkboardProofPageRequest,
  toBoundedWorkboardCard,
} from "./card-output.js";

const EMBEDDED_PROOF_BYTES = 24 * 1024;

function createProof(count: number, note?: string): WorkboardProof[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `proof-${index}`,
    status: "passed" as const,
    createdAt: index + 1,
    label: `Proof ${index}`,
    ...(note ? { note } : {}),
  }));
}

function createCard(proof: WorkboardProof[]): WorkboardCard {
  return {
    id: "card-1",
    title: "Projected proof",
    status: "review",
    priority: "normal",
    labels: [],
    position: 1000,
    createdAt: 1,
    updatedAt: 2,
    metadata: {
      proof,
      comments: [{ id: "comment-1", body: "Keep canonical", createdAt: 1 }],
      claim: {
        ownerId: "worker",
        token: "secret-token",
        claimedAt: 1,
        lastHeartbeatAt: 2,
      },
    },
  };
}

describe("Workboard card output projection", () => {
  it.each([
    { total: 40, first: "proof-0", hasMore: false },
    { total: 41, first: "proof-1", hasMore: true },
    { total: 100, first: "proof-60", hasMore: true },
  ])("returns the newest bounded proof window for $total records", ({ total, first, hasMore }) => {
    const view = toBoundedWorkboardCard(createCard(createProof(total)));

    expect(view.metadata?.proof).toHaveLength(40);
    expect(view.metadata?.proof?.[0]?.id).toBe(first);
    expect(view.metadata?.proof?.at(-1)?.id).toBe(`proof-${total - 1}`);
    expect(view.proofPage).toMatchObject({ total, hasMore });
    expect(Boolean(view.proofPage.nextCursor)).toBe(hasMore);
  });

  it("uses the UTF-8 byte budget while retaining the newest proof", () => {
    const view = toBoundedWorkboardCard(createCard(createProof(100, "🧪".repeat(1000))));
    const projectedProof = view.metadata?.proof ?? [];

    expect(projectedProof.length).toBeGreaterThan(0);
    expect(projectedProof.length).toBeLessThan(40);
    expect(projectedProof.at(-1)?.id).toBe("proof-99");
    expect(Buffer.byteLength(JSON.stringify(projectedProof), "utf8")).toBeLessThanOrEqual(
      EMBEDDED_PROOF_BYTES,
    );
    expect(view.proofPage).toMatchObject({ total: 100, hasMore: true });
  });

  it("redacts and clones the view without mutating canonical nested data", () => {
    const card = createCard(createProof(41));
    const before = JSON.stringify(card);
    const view = toBoundedWorkboardCard(card);

    expect(JSON.stringify(card)).toBe(before);
    expect(view.metadata?.claim?.token).toBe("[redacted]");
    expect(view.proofPage.nextCursor).not.toContain("proof-1");
    if (view.metadata?.proof?.[0]) {
      view.metadata.proof[0].label = "Changed view";
    }
    if (view.metadata?.comments?.[0]) {
      view.metadata.comments[0].body = "Changed view";
    }
    expect(card.metadata?.proof?.[1]?.label).toBe("Proof 1");
    expect(card.metadata?.comments?.[0]?.body).toBe("Keep canonical");
  });

  it("uses opaque stable cursors to drain older proof in chronological pages", () => {
    const proof = createProof(100);
    const first = paginateWorkboardProof(proof, readWorkboardProofPageRequest());
    const second = paginateWorkboardProof(
      proof,
      readWorkboardProofPageRequest({ cursor: first.nextCursor }),
    );
    const third = paginateWorkboardProof(
      proof,
      readWorkboardProofPageRequest({ cursor: second.nextCursor }),
    );

    expect(first.proof.map((entry) => entry.id)).toEqual(
      Array.from({ length: 40 }, (_, index) => `proof-${index + 60}`),
    );
    expect(second.proof.map((entry) => entry.id)).toEqual(
      Array.from({ length: 40 }, (_, index) => `proof-${index + 20}`),
    );
    expect(third.proof.map((entry) => entry.id)).toEqual(
      Array.from({ length: 20 }, (_, index) => `proof-${index}`),
    );
    expect(third).toMatchObject({ total: 100, hasMore: false });
    expect(third.nextCursor).toBeUndefined();
  });

  it("accepts every opaque cursor it issues for an arbitrarily long canonical proof id", () => {
    const proof = createProof(2);
    const latest = proof[1];
    if (!latest) {
      throw new Error("expected latest proof");
    }
    latest.id = `proof-${"x".repeat(5000)}`;

    const first = paginateWorkboardProof(proof, readWorkboardProofPageRequest({ limit: 1 }));
    expect(first.nextCursor?.length).toBeGreaterThan(4096);
    const second = paginateWorkboardProof(
      proof,
      readWorkboardProofPageRequest({ cursor: first.nextCursor, limit: 1 }),
    );

    expect(second.proof.map((entry) => entry.id)).toEqual(["proof-0"]);
    expect(second).toMatchObject({ total: 2, hasMore: false });
  });

  it("round-trips a self-issued cursor for a lone-surrogate proof id", () => {
    const proof = createProof(2);
    const latest = proof[1];
    if (!latest) {
      throw new Error("expected latest proof");
    }
    latest.id = "\ud800";

    const first = paginateWorkboardProof(proof, readWorkboardProofPageRequest({ limit: 1 }));
    const second = paginateWorkboardProof(
      proof,
      readWorkboardProofPageRequest({ cursor: first.nextCursor, limit: 1 }),
    );

    expect(first.proof[0]?.id).toBe("\ud800");
    expect(second.proof.map((entry) => entry.id)).toEqual(["proof-0"]);
    expect(second).toMatchObject({ total: 2, hasMore: false });
  });

  it("omits a single oversized embedded proof while explicit pagination retains it", () => {
    const proof = createProof(1);
    const oversized = proof[0];
    if (!oversized) {
      throw new Error("expected oversized proof");
    }
    oversized.id = `proof-${"x".repeat(EMBEDDED_PROOF_BYTES)}`;

    const view = toBoundedWorkboardCard(createCard(proof));
    expect(view.metadata?.proof).toBeUndefined();
    expect(view.proofPage).toEqual({ total: 1, hasMore: true });

    const page = paginateWorkboardProof(proof, readWorkboardProofPageRequest());
    expect(page).toMatchObject({ total: 1, hasMore: false });
    expect(page.proof).toEqual(proof);
  });

  it("rejects invalid limits and foreign cursors", () => {
    expect(() => readWorkboardProofPageRequest({ limit: 0 })).toThrow(
      "limit must be an integer from 1 to 40",
    );
    expect(() => readWorkboardProofPageRequest({ limit: 41 })).toThrow(
      "limit must be an integer from 1 to 40",
    );
    expect(() => readWorkboardProofPageRequest({ limit: 1.5 })).toThrow(
      "limit must be an integer from 1 to 40",
    );
    expect(() => readWorkboardProofPageRequest({ cursor: "proof-1" })).toThrow(
      "invalid proof cursor",
    );
    const foreignProof = createProof(41);
    for (const entry of foreignProof) {
      entry.id = `foreign-${entry.id}`;
    }
    expect(() =>
      paginateWorkboardProof(
        createProof(2),
        readWorkboardProofPageRequest({
          cursor: toBoundedWorkboardCard(createCard(foreignProof)).proofPage.nextCursor,
        }),
      ),
    ).toThrow("proof cursor does not belong to this card");
  });
});
