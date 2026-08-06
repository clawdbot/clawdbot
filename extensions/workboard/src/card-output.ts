import type {
  WorkboardCard,
  WorkboardCardView,
  WorkboardLink,
  WorkboardProof,
  WorkboardProofPage,
} from "@openclaw/workboard-contract";
import { redactClaimToken } from "./card-redaction.js";
import { removeUndefinedMetadataFields } from "./store-normalizers.js";

export const WORKBOARD_PROOF_VIEW_LIMIT = 40;
const WORKBOARD_MODEL_OUTPUT_BYTES = 24 * 1024;

const WORKBOARD_PROOF_CURSOR_PREFIX = "proof-v2.";

export type WorkboardProofPageRequest = {
  beforeProofId?: string;
  limit: number;
};

function serializedBytes(value: unknown, pretty = false): number {
  return Buffer.byteLength(JSON.stringify(value, null, pretty ? 2 : undefined), "utf8");
}

function dropFirst<T>(items: readonly T[] | undefined): T[] | undefined {
  const next = items?.slice(1);
  return next?.length ? next : undefined;
}

function slimDependencyLinks(links: readonly WorkboardLink[]): WorkboardLink[] {
  return links.map((link) => {
    if (link.type !== "parent" && link.type !== "child") {
      return link;
    }
    const { title: _title, url: _url, ...essential } = link;
    return essential;
  });
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
  let proof = params.proof.slice();
  let hasMore = params.hasMore;
  while (true) {
    const page: WorkboardProofPage = {
      proof,
      total: params.total,
      hasMore,
      ...(hasMore && proof[0] ? { nextCursor: encodeProofCursor(cardId, proof[0].id) } : {}),
    };
    // jsonResult pretty-prints tool payloads, so page budgeting includes that exact model text.
    if (serializedBytes(page, true) <= WORKBOARD_MODEL_OUTPUT_BYTES) {
      return structuredClone(page);
    }
    if (proof.length <= 1) {
      throw new Error(
        "proof record exceeds the model-safe page budget; use Workboard CLI or export for complete history.",
      );
    }
    proof = proof.slice(1);
    hasMore = true;
  }
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

export function toBoundedWorkboardCardFromPage(
  card: WorkboardCard,
  page: {
    proof: WorkboardProof[];
    total: number;
    hasMore: boolean;
  },
): WorkboardCardView {
  const redacted = redactClaimToken(card);
  const initialProof = page.proof.slice(-WORKBOARD_PROOF_VIEW_LIMIT);
  let hasMore = page.hasMore || initialProof.length < page.proof.length;
  let metadata = removeUndefinedMetadataFields({
    ...redacted.metadata,
    proof: initialProof.length ? initialProof : undefined,
  });
  let events = redacted.events?.slice();
  const base: WorkboardCard = { ...redacted };
  delete base.events;
  delete base.metadata;

  const project = (): WorkboardCardView => {
    const proof = metadata.proof ?? [];
    return {
      ...base,
      ...(events?.length ? { events } : {}),
      ...(Object.keys(metadata).length ? { metadata } : {}),
      proofPage: {
        total: page.total,
        hasMore,
        ...(hasMore && proof[0] ? { nextCursor: encodeProofCursor(card.id, proof[0].id) } : {}),
      },
    };
  };

  let projected = project();
  while (serializedBytes(projected) > WORKBOARD_MODEL_OUTPUT_BYTES) {
    const previousBytes = serializedBytes(projected);
    if (events?.length) {
      events = dropFirst(events);
    } else if (metadata.attempts?.length) {
      metadata = removeUndefinedMetadataFields({
        ...metadata,
        attempts: dropFirst(metadata.attempts),
      });
    } else if (metadata.diagnostics?.length) {
      metadata = removeUndefinedMetadataFields({
        ...metadata,
        diagnostics: dropFirst(metadata.diagnostics),
      });
    } else if (metadata.notifications?.length) {
      metadata = removeUndefinedMetadataFields({
        ...metadata,
        notifications: dropFirst(metadata.notifications),
      });
    } else if (metadata.proof?.length) {
      metadata = removeUndefinedMetadataFields({ ...metadata, proof: dropFirst(metadata.proof) });
      hasMore = true;
    } else if (metadata.artifacts?.length) {
      metadata = removeUndefinedMetadataFields({
        ...metadata,
        artifacts: dropFirst(metadata.artifacts),
      });
    } else if (metadata.attachments?.length) {
      metadata = removeUndefinedMetadataFields({
        ...metadata,
        attachments: dropFirst(metadata.attachments),
      });
    } else if (metadata.workerLogs?.length) {
      metadata = removeUndefinedMetadataFields({
        ...metadata,
        workerLogs: dropFirst(metadata.workerLogs),
      });
    } else if (metadata.links?.some((link) => link.type !== "parent" && link.type !== "child")) {
      const index = metadata.links.findIndex(
        (link) => link.type !== "parent" && link.type !== "child",
      );
      metadata = removeUndefinedMetadataFields({
        ...metadata,
        links: metadata.links.filter((_, linkIndex) => linkIndex !== index),
      });
    } else if (metadata.comments?.length) {
      metadata = removeUndefinedMetadataFields({
        ...metadata,
        comments: dropFirst(metadata.comments),
      });
    } else if (
      metadata.links?.some(
        (link) => (link.type === "parent" || link.type === "child") && (link.title || link.url),
      )
    ) {
      metadata = removeUndefinedMetadataFields({
        ...metadata,
        links: slimDependencyLinks(metadata.links),
      });
    } else if (base.sourceUrl) {
      delete base.sourceUrl;
    } else if (base.taskId) {
      delete base.taskId;
    } else if (metadata.automation?.summary) {
      const { summary: _summary, ...automation } = metadata.automation;
      metadata = removeUndefinedMetadataFields({ ...metadata, automation });
    } else if (metadata.automation?.createdCardIds?.length) {
      metadata = removeUndefinedMetadataFields({
        ...metadata,
        automation: { ...metadata.automation, createdCardIds: undefined },
      });
    } else if (metadata.automation?.idempotencyKey) {
      const { idempotencyKey: _idempotencyKey, ...automation } = metadata.automation;
      metadata = removeUndefinedMetadataFields({ ...metadata, automation });
    } else if (metadata.automation?.workspaceAccess) {
      const { workspaceAccess: _workspaceAccess, ...automation } = metadata.automation;
      metadata = removeUndefinedMetadataFields({ ...metadata, automation });
    } else if (metadata.automation?.workspace?.sourcePath) {
      const { sourcePath: _sourcePath, ...workspace } = metadata.automation.workspace;
      metadata = removeUndefinedMetadataFields({
        ...metadata,
        automation: { ...metadata.automation, workspace },
      });
    } else if (metadata.automation?.workspace?.sourceBranch) {
      const { sourceBranch: _sourceBranch, ...workspace } = metadata.automation.workspace;
      metadata = removeUndefinedMetadataFields({
        ...metadata,
        automation: { ...metadata.automation, workspace },
      });
    } else if (base.execution) {
      delete base.execution;
    } else if (base.runId) {
      delete base.runId;
    } else if (base.sessionKey) {
      delete base.sessionKey;
    } else if (base.agentId) {
      delete base.agentId;
    } else if (metadata.stale) {
      metadata = removeUndefinedMetadataFields({ ...metadata, stale: undefined });
    } else if (metadata.workerProtocol?.detail) {
      const { detail: _detail, ...workerProtocol } = metadata.workerProtocol;
      metadata = removeUndefinedMetadataFields({ ...metadata, workerProtocol });
    } else if (metadata.automation?.skills?.length) {
      metadata = removeUndefinedMetadataFields({
        ...metadata,
        automation: { ...metadata.automation, skills: undefined },
      });
    } else if (metadata.automation?.workspace?.branch) {
      const { branch: _branch, ...workspace } = metadata.automation.workspace;
      metadata = removeUndefinedMetadataFields({
        ...metadata,
        automation: { ...metadata.automation, workspace },
      });
    } else if (metadata.automation?.workspace?.path) {
      const { path: _path, ...workspace } = metadata.automation.workspace;
      metadata = removeUndefinedMetadataFields({
        ...metadata,
        automation: { ...metadata.automation, workspace },
      });
    } else if (base.notes) {
      delete base.notes;
    } else {
      throw new Error("Workboard card required fields exceed the model-safe output budget.");
    }
    projected = project();
    if (serializedBytes(projected) >= previousBytes) {
      throw new Error("Workboard card projection could not satisfy the model-safe output budget.");
    }
  }
  // Structured cloning strips SQLite's private snapshot symbol and prevents output consumers from
  // mutating canonical nested objects before the view is serialized.
  return structuredClone(projected) as WorkboardCardView;
}

export function toBoundedWorkboardCard(card: WorkboardCard): WorkboardCardView {
  const canonicalProof = card.metadata?.proof ?? [];
  return toBoundedWorkboardCardFromPage(card, {
    proof: canonicalProof,
    total: canonicalProof.length,
    hasMore: false,
  });
}

export function assertNotProjectedWorkboardCard(value: unknown): void {
  if (value && typeof value === "object" && Object.hasOwn(value, "proofPage")) {
    throw new Error("projected Workboard cards are read-only; send a field patch instead.");
  }
}
