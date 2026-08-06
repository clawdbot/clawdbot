import type { WorkboardCard, WorkboardProof } from "@openclaw/workboard-contract";
import { describe, expect, it } from "vitest";
import {
  paginateWorkboardProof,
  readWorkboardProofPageRequest,
  toBoundedWorkboardCard,
} from "./card-output.js";

const CARD_ID = "card-1";
const WORKBOARD_MODEL_OUTPUT_BYTES = 24 * 1024;

function createProof(count: number, note?: string): WorkboardProof[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `proof-${index}`,
    status: "passed" as const,
    createdAt: index + 1,
    label: `Proof ${index}`,
    ...(note ? { note } : {}),
  }));
}

function createCard(proof: WorkboardProof[], id = CARD_ID): WorkboardCard {
  return {
    id,
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
    expect(Buffer.byteLength(JSON.stringify(view), "utf8")).toBeLessThanOrEqual(
      WORKBOARD_MODEL_OUTPUT_BYTES,
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

  it("bounds the complete card view without mutating large non-proof metadata", () => {
    const card = createCard(createProof(20));
    card.events = Array.from({ length: 50 }, (_, index) => ({
      id: `event-${index}`,
      kind: "edited" as const,
      at: index + 1,
      sessionKey: "event-session".repeat(100),
    }));
    card.metadata = {
      ...card.metadata,
      comments: Array.from({ length: 50 }, (_, index) => ({
        id: `comment-${index}`,
        body: `Comment ${index} ${"🧪".repeat(1000)}`,
        createdAt: index + 1,
      })),
      artifacts: Array.from({ length: 40 }, (_, index) => ({
        id: `artifact-${index}`,
        label: `Artifact ${index}`,
        url: `https://example.com/${"a".repeat(2000)}`,
        createdAt: index + 1,
      })),
      workerLogs: Array.from({ length: 40 }, (_, index) => ({
        id: `log-${index}`,
        level: "info" as const,
        message: `Log ${index} ${"🧪".repeat(400)}`,
        createdAt: index + 1,
      })),
    };
    const before = JSON.stringify(card);

    const view = toBoundedWorkboardCard(card);

    expect(Buffer.byteLength(JSON.stringify(view), "utf8")).toBeLessThanOrEqual(
      WORKBOARD_MODEL_OUTPUT_BYTES,
    );
    expect(view.metadata?.comments?.at(-1)?.id).toBe("comment-49");
    expect(view.proofPage).toMatchObject({ total: 20, hasMore: true });
    expect(JSON.stringify(card)).toBe(before);
  });

  it("omits optional scalar fields only in the view when history trimming is insufficient", () => {
    const card = createCard([]);
    card.notes = "ࠀ".repeat(4000);
    card.sourceUrl = "ࠀ".repeat(5000);
    card.taskId = "ࠀ".repeat(5000);
    card.metadata = {
      automation: {
        boardId: "default",
        summary: "ࠀ".repeat(2000),
      },
    };
    const before = JSON.stringify(card);

    const view = toBoundedWorkboardCard(card);

    expect(Buffer.byteLength(JSON.stringify(view), "utf8")).toBeLessThanOrEqual(
      WORKBOARD_MODEL_OUTPUT_BYTES,
    );
    expect(view).toMatchObject({ id: CARD_ID, title: "Projected proof", status: "review" });
    expect(JSON.stringify(card)).toBe(before);
  });

  it("uses opaque stable cursors to drain older proof in chronological pages", () => {
    const proof = createProof(100);
    const first = paginateWorkboardProof(CARD_ID, proof, readWorkboardProofPageRequest(CARD_ID));
    const second = paginateWorkboardProof(
      CARD_ID,
      proof,
      readWorkboardProofPageRequest(CARD_ID, { cursor: first.nextCursor }),
    );
    const third = paginateWorkboardProof(
      CARD_ID,
      proof,
      readWorkboardProofPageRequest(CARD_ID, { cursor: second.nextCursor }),
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

  it("drains byte-bounded proof pages without gaps or duplicates", () => {
    const proof = createProof(100).map((entry) => {
      entry.label = "l".repeat(160);
      entry.command = "c".repeat(1000);
      entry.url = `https://example.com/${"u".repeat(1980)}`;
      entry.note = "n".repeat(2000);
      return entry;
    });
    const chunks: string[][] = [];
    let cursor: string | undefined;

    for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
      const page = paginateWorkboardProof(
        CARD_ID,
        proof,
        readWorkboardProofPageRequest(CARD_ID, { cursor }),
      );
      expect(Buffer.byteLength(JSON.stringify(page, null, 2), "utf8")).toBeLessThanOrEqual(
        WORKBOARD_MODEL_OUTPUT_BYTES,
      );
      chunks.unshift(page.proof.map((entry) => entry.id));
      if (!page.hasMore) {
        break;
      }
      cursor = page.nextCursor;
      expect(cursor).toEqual(expect.any(String));
    }

    const ids = chunks.flat();
    expect(ids).toEqual(proof.map((entry) => entry.id));
    expect(new Set(ids).size).toBe(proof.length);
  });

  it("accepts every opaque cursor it issues for an arbitrarily long canonical proof id", () => {
    const proof = createProof(2);
    const latest = proof[1];
    if (!latest) {
      throw new Error("expected latest proof");
    }
    latest.id = `proof-${"x".repeat(5000)}`;

    const first = paginateWorkboardProof(
      CARD_ID,
      proof,
      readWorkboardProofPageRequest(CARD_ID, { limit: 1 }),
    );
    expect(first.nextCursor?.length).toBeGreaterThan(4096);
    const second = paginateWorkboardProof(
      CARD_ID,
      proof,
      readWorkboardProofPageRequest(CARD_ID, { cursor: first.nextCursor, limit: 1 }),
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

    const first = paginateWorkboardProof(
      CARD_ID,
      proof,
      readWorkboardProofPageRequest(CARD_ID, { limit: 1 }),
    );
    const second = paginateWorkboardProof(
      CARD_ID,
      proof,
      readWorkboardProofPageRequest(CARD_ID, { cursor: first.nextCursor, limit: 1 }),
    );

    expect(first.proof[0]?.id).toBe("\ud800");
    expect(second.proof.map((entry) => entry.id)).toEqual(["proof-0"]);
    expect(second).toMatchObject({ total: 2, hasMore: false });
  });

  it("rejects an individually oversized model page while retaining the canonical proof", () => {
    const proof = createProof(1);
    const oversized = proof[0];
    if (!oversized) {
      throw new Error("expected oversized proof");
    }
    oversized.id = `proof-${"x".repeat(WORKBOARD_MODEL_OUTPUT_BYTES)}`;

    const view = toBoundedWorkboardCard(createCard(proof));
    expect(view.metadata?.proof).toBeUndefined();
    expect(view.proofPage).toEqual({ total: 1, hasMore: true });

    expect(() =>
      paginateWorkboardProof(CARD_ID, proof, readWorkboardProofPageRequest(CARD_ID)),
    ).toThrow("proof record exceeds the model-safe page budget");
    expect(proof[0]?.id).toBe(oversized.id);
  });

  it("rejects invalid limits and cursors issued for another card", () => {
    expect(() => readWorkboardProofPageRequest(CARD_ID, { limit: 0 })).toThrow(
      "limit must be an integer from 1 to 40",
    );
    expect(() => readWorkboardProofPageRequest(CARD_ID, { limit: 41 })).toThrow(
      "limit must be an integer from 1 to 40",
    );
    expect(() => readWorkboardProofPageRequest(CARD_ID, { limit: 1.5 })).toThrow(
      "limit must be an integer from 1 to 40",
    );
    expect(() => readWorkboardProofPageRequest(CARD_ID, { cursor: "proof-1" })).toThrow(
      "invalid proof cursor",
    );
    expect(() =>
      readWorkboardProofPageRequest(CARD_ID, {
        cursor: toBoundedWorkboardCard(createCard(createProof(41), "card-2")).proofPage.nextCursor,
      }),
    ).toThrow("proof cursor does not belong to this card");
  });
});
