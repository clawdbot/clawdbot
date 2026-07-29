import type {
  WorkboardCard,
  WorkboardCardView,
  WorkboardProof,
  WorkboardProofPage,
} from "@openclaw/workboard-contract";
import { redactClaimToken } from "./card-redaction.js";

const WORKBOARD_PROOF_VIEW_LIMIT = 40;
const WORKBOARD_EMBEDDED_PROOF_BYTES = 24 * 1024;

const WORKBOARD_PROOF_CURSOR_PREFIX = "proof-v2.";

export type WorkboardProofPageRequest = {
  beforeProofId?: string;
  limit: number;
};

function proofBytes(proof: readonly WorkboardProof[]): number {
  return Buffer.byteLength(JSON.stringify(proof), "utf8");
}

function encodeProofCursor(cardId: string, proofId: string): string {
  return `${WORKBOARD_PROOF_CURSOR_PREFIX}${Buffer.from(JSON.stringify([cardId, proofId]), "utf8").toString("base64url")}`;
}

function decodeProofCursor(cursor: string): { cardId: string; proofId: string } {
  if (!cursor.startsWith(WORKBOARD_PROOF_CURSOR_PREFIX)) {
    throw new Error("invalid proof cursor.");
  }
  const encoded = cursor.slice(WORKBOARD_PROOF_CURSOR_PREFIX.length);
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid proof cursor.");
  }
  if (
    !Array.isArray(payload) ||
    payload.length !== 2 ||
    typeof payload[0] !== "string" ||
    !payload[0] ||
    typeof payload[1] !== "string" ||
    !payload[1] ||
    encodeProofCursor(payload[0], payload[1]) !== cursor
  ) {
    throw new Error("invalid proof cursor.");
  }
  return { cardId: payload[0], proofId: payload[1] };
}

export function readWorkboardProofPageRequest(
  cardId: string,
  options: { cursor?: unknown; limit?: unknown } = {},
): WorkboardProofPageRequest {
  const limit = options.limit === undefined ? WORKBOARD_PROOF_VIEW_LIMIT : options.limit;
  if (
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > WORKBOARD_PROOF_VIEW_LIMIT
  ) {
    throw new Error(`limit must be an integer from 1 to ${WORKBOARD_PROOF_VIEW_LIMIT}.`);
  }
  if (options.cursor === undefined) {
    return { limit };
  }
  if (typeof options.cursor !== "string") {
    throw new Error("invalid proof cursor.");
  }
  const cursor = decodeProofCursor(options.cursor);
  if (cursor.cardId !== cardId) {
    throw new Error("proof cursor does not belong to this card.");
  }
  return { beforeProofId: cursor.proofId, limit };
}

export function createWorkboardProofPage(
  cardId: string,
  params: {
    proof: WorkboardProof[];
    total: number;
    hasMore: boolean;
  },
): WorkboardProofPage {
  return {
    proof: params.proof,
    total: params.total,
    hasMore: params.hasMore,
    ...(params.hasMore && params.proof[0]
      ? { nextCursor: encodeProofCursor(cardId, params.proof[0].id) }
      : {}),
  };
}

export function paginateWorkboardProof(
  cardId: string,
  proof: readonly WorkboardProof[],
  request: WorkboardProofPageRequest,
): WorkboardProofPage {
  const end =
    request.beforeProofId === undefined
      ? proof.length
      : proof.findIndex((entry) => entry.id === request.beforeProofId);
  if (end < 0) {
    throw new Error("proof cursor does not belong to this card.");
  }
  const start = Math.max(0, end - request.limit);
  return createWorkboardProofPage(cardId, {
    proof: structuredClone(proof.slice(start, end)),
    total: proof.length,
    hasMore: start > 0,
  });
}

export function toBoundedWorkboardCard(card: WorkboardCard): WorkboardCardView {
  const canonicalProof = card.metadata?.proof ?? [];
  let proof = canonicalProof.slice(-WORKBOARD_PROOF_VIEW_LIMIT);
  while (proof.length > 0 && proofBytes(proof) > WORKBOARD_EMBEDDED_PROOF_BYTES) {
    proof = proof.slice(1);
  }
  const hasMore = proof.length < canonicalProof.length;
  const redacted = redactClaimToken(card);
  const projected = {
    ...redacted,
    ...(redacted.metadata
      ? {
          metadata: {
            ...redacted.metadata,
            ...(proof.length > 0 ? { proof } : { proof: undefined }),
          },
        }
      : {}),
    proofPage: {
      total: canonicalProof.length,
      hasMore,
      ...(hasMore && proof[0] ? { nextCursor: encodeProofCursor(card.id, proof[0].id) } : {}),
    },
  };
  // Structured cloning strips SQLite's private snapshot symbol and prevents output consumers from
  // mutating canonical nested objects before the view is serialized.
  return structuredClone(projected) as WorkboardCardView;
}

export function assertNotProjectedWorkboardCard(value: unknown): void {
  if (value && typeof value === "object" && Object.hasOwn(value, "proofPage")) {
    throw new Error("projected Workboard cards are read-only; send a field patch instead.");
  }
}
