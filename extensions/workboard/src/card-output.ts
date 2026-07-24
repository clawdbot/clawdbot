import type {
  WorkboardCard,
  WorkboardCardView,
  WorkboardProof,
  WorkboardProofPage,
} from "@openclaw/workboard-contract";

export const WORKBOARD_PROOF_VIEW_LIMIT = 40;
export const WORKBOARD_EMBEDDED_PROOF_BYTES = 24 * 1024;

const WORKBOARD_PROOF_CURSOR_PREFIX = "proof-v1.";

export type WorkboardProofPageRequest = {
  beforeProofId?: string;
  limit: number;
};

function proofBytes(proof: readonly WorkboardProof[]): number {
  return Buffer.byteLength(JSON.stringify(proof), "utf8");
}

function encodeProofCursor(proofId: string): string {
  return `${WORKBOARD_PROOF_CURSOR_PREFIX}${Buffer.from(JSON.stringify(proofId), "utf8").toString("base64url")}`;
}

function decodeProofCursor(cursor: string): string {
  if (!cursor.startsWith(WORKBOARD_PROOF_CURSOR_PREFIX)) {
    throw new Error("invalid proof cursor.");
  }
  const encoded = cursor.slice(WORKBOARD_PROOF_CURSOR_PREFIX.length);
  let proofId: unknown;
  try {
    proofId = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid proof cursor.");
  }
  if (typeof proofId !== "string" || !proofId || encodeProofCursor(proofId) !== cursor) {
    throw new Error("invalid proof cursor.");
  }
  return proofId;
}

export function readWorkboardProofPageRequest(
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
  return { beforeProofId: decodeProofCursor(options.cursor), limit };
}

export function createWorkboardProofPage(params: {
  proof: WorkboardProof[];
  total: number;
  hasMore: boolean;
}): WorkboardProofPage {
  return {
    proof: params.proof,
    total: params.total,
    hasMore: params.hasMore,
    ...(params.hasMore && params.proof[0]
      ? { nextCursor: encodeProofCursor(params.proof[0].id) }
      : {}),
  };
}

export function paginateWorkboardProof(
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
  return createWorkboardProofPage({
    proof: structuredClone(proof.slice(start, end)),
    total: proof.length,
    hasMore: start > 0,
  });
}

export function redactCanonicalWorkboardCard(card: WorkboardCard): WorkboardCard {
  const claim = card.metadata?.claim;
  if (!claim) {
    return card;
  }
  return {
    ...card,
    metadata: {
      ...card.metadata,
      claim: { ...claim, token: "[redacted]" },
    },
  };
}

export function toBoundedWorkboardCard(card: WorkboardCard): WorkboardCardView {
  const canonicalProof = card.metadata?.proof ?? [];
  let proof = canonicalProof.slice(-WORKBOARD_PROOF_VIEW_LIMIT);
  while (proof.length > 0 && proofBytes(proof) > WORKBOARD_EMBEDDED_PROOF_BYTES) {
    proof = proof.slice(1);
  }
  const hasMore = proof.length < canonicalProof.length;
  const redacted = redactCanonicalWorkboardCard(card);
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
      ...(hasMore && proof[0] ? { nextCursor: encodeProofCursor(proof[0].id) } : {}),
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
