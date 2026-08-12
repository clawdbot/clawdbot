// Workboard reconciliation facade accepts safe external execution observations.
import { createHash, randomUUID } from "node:crypto";
import type {
  WorkboardCard,
  WorkboardExternalExecutionLink,
  WorkboardReconciliationApplyResult,
  WorkboardReconciliationObservation,
  WorkboardReconciliationPage,
  WorkboardReconciliationTriage,
  WorkboardReconciliationSourceObservation,
  WorkboardReconciliationSourceObservationResult,
  WorkboardStatus,
} from "@openclaw/workboard-contract";
import { WorkboardStore } from "./store.js";

const MAX_PAGE_SIZE = 100;
const MAX_OBJECTIVE_KEY_LENGTH = 160;
const MAX_STALE_AFTER_MISSES = 1000;
const MAX_OBSERVATION_ID_LENGTH = 200;
const MAX_ASSOCIATION_KEY_LENGTH = 160;
const MAX_TRIAGE_ENTRIES = 20;
const MAX_TRIAGE_CARD_ID_LENGTH = 120;
const MAX_TRIAGE_REFERENCE_LENGTH = 1024;
const MAX_TRIAGE_BYTES = 16 * 1024;
const DEFAULT_PAGE_SIZE = 50;
const RECONCILIATION_PROTECTED_STATUSES = new Set<WorkboardStatus>(["blocked", "review", "done"]);

export type WorkboardReconciliationListInput = {
  cursor?: unknown;
  limit?: unknown;
  tenant?: unknown;
  boardId?: unknown;
  terminal?: unknown;
};

function readRequiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required.`);
  }
  return value.trim();
}

function readBoundedString(value: unknown, name: string, maximum: number): string {
  const result = readRequiredString(value, name);
  if (result.length > maximum) {
    throw new Error(`${name} must be ${maximum} characters or fewer.`);
  }
  return result;
}

function readTimestamp(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative timestamp.`);
  }
  return Math.trunc(value);
}

function readLimit(value: unknown): number {
  if (value === undefined) {
    return DEFAULT_PAGE_SIZE;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_PAGE_SIZE) {
    throw new Error("limit must be between 1 and 100.");
  }
  return value;
}

function encodeCursor(id: string): string {
  return Buffer.from(id, "utf8").toString("base64url");
}

function decodeCursor(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const cursor = readRequiredString(value, "cursor");
  try {
    const id = Buffer.from(cursor, "base64url").toString("utf8");
    if (encodeCursor(id) !== cursor || id === "") {
      throw new Error();
    }
    return id;
  } catch {
    throw new Error("cursor is invalid.");
  }
}

function tenantFor(card: WorkboardCard): string | undefined {
  return card.metadata?.automation?.tenant;
}

function isProtected(card: WorkboardCard): boolean {
  return RECONCILIATION_PROTECTED_STATUSES.has(card.status);
}

function redactReconciliationApplyKey(card: WorkboardCard): WorkboardCard {
  const automation = card.metadata?.automation;
  const links = card.metadata?.links?.map((link) =>
    (() => {
      const {
        lastSourceObservationId: _lastSourceObservationId,
        lastSourceObservationRequestJson: _lastSourceObservationRequestJson,
        lastSourceObservationRevision: _lastSourceObservationRevision,
        lastSourceObservationEvidenceJson: _lastSourceObservationEvidenceJson,
        ...safeLink
      } = link;
      return link.id.startsWith("external:")
        ? {
            ...safeLink,
            id: `external:${createHash("sha256").update(link.id).digest("base64url")}`,
          }
        : safeLink;
    })(),
  );
  if (!automation?.idempotencyKey && !links) return card;
  const { idempotencyKey: _idempotencyKey, ...safeAutomation } = automation ?? {};
  return {
    ...card,
    metadata: {
      ...card.metadata,
      ...(automation ? { automation: safeAutomation } : {}),
      ...(links ? { links } : {}),
    },
  };
}

function linkFor(observation: WorkboardReconciliationObservation): WorkboardExternalExecutionLink {
  return {
    sourceUrl: readRequiredString(observation.sourceUrl, "sourceUrl"),
    tenant: readRequiredString(observation.tenant, "tenant"),
    idempotencyKey: readRequiredString(observation.idempotencyKey, "idempotencyKey"),
    sourceUpdatedAt: readTimestamp(observation.sourceUpdatedAt, "sourceUpdatedAt"),
    reconciliationAssociationKey: randomUUID().replaceAll("-", ""),
    ...(typeof observation.link?.title === "string" && observation.link.title.trim()
      ? { title: observation.link.title.trim() }
      : {}),
  };
}

const OBSERVATION_FIELDS = new Set([
  "sourceUrl",
  "tenant",
  "objectiveKey",
  "idempotencyKey",
  "observationId",
  "sourceUpdatedAt",
  "cardId",
  "expectedRevision",
  "card",
  "link",
  "triage",
]);
const SOURCE_OBSERVATION_FIELDS = new Set([
  "cardId",
  "tenant",
  "objectiveKey",
  "sourceUrl",
  "reconciliationAssociationKey",
  "observationId",
  "sourceState",
  "staleAfterMisses",
  "observedAt",
  "expectedRevision",
]);
const CARD_FIELDS = new Set([
  "title",
  "notes",
  "status",
  "priority",
  "labels",
  "agentId",
  "sessionKey",
  "runId",
  "taskId",
  "sourceUrl",
  "execution",
  "position",
  "boardId",
]);
const LINK_FIELDS = new Set(["title"]);
const TRIAGE_FIELDS = new Set(["candidateCardIds", "evidence"]);
const TRIAGE_EVIDENCE_FIELDS = new Set(["reference", "sha256"]);

function objectWithOnly(
  value: unknown,
  name: string,
  fields: Set<string>,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!fields.has(key)) {
      throw new Error(`${name}.${key} is not allowed.`);
    }
  }
  return record;
}

function readSafeTriageCardId(value: unknown): string {
  const id = readBoundedString(value, "candidateCardIds entry", MAX_TRIAGE_CARD_ID_LENGTH);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new Error("candidateCardIds entries must be safe card IDs.");
  }
  return id;
}

function projectReconciliationTriage(value: unknown): WorkboardReconciliationTriage {
  const input = objectWithOnly(value, "triage", TRIAGE_FIELDS);
  if (
    !Array.isArray(input.candidateCardIds) ||
    input.candidateCardIds.length > MAX_TRIAGE_ENTRIES
  ) {
    throw new Error("candidateCardIds supports at most 20 entries.");
  }
  if (!Array.isArray(input.evidence) || input.evidence.length > MAX_TRIAGE_ENTRIES) {
    throw new Error("triage evidence supports at most 20 entries.");
  }
  const triage = {
    candidateCardIds: input.candidateCardIds.map(readSafeTriageCardId),
    evidence: input.evidence.map((value) => {
      const evidence = objectWithOnly(value, "triage evidence", TRIAGE_EVIDENCE_FIELDS);
      const reference = readBoundedString(
        evidence.reference,
        "triage evidence reference",
        MAX_TRIAGE_REFERENCE_LENGTH,
      );
      if (!isSafeTriageReference(reference))
        throw new Error("triage evidence reference is unsupported.");
      if (typeof evidence.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(evidence.sha256)) {
        throw new Error("triage evidence sha256 must be 64 hexadecimal characters.");
      }
      return { reference, sha256: evidence.sha256.toLowerCase() };
    }),
  };
  if (Buffer.byteLength(JSON.stringify(triage), "utf8") > MAX_TRIAGE_BYTES) {
    throw new Error("reconciliation triage must be 16384 bytes or fewer.");
  }
  return triage;
}

function isSafeTriageReference(reference: string): boolean {
  if (/\p{C}/u.test(reference)) return false;
  if (/(?:^|\/)\.{1,2}(?:\/|$)/.test(reference)) return false;
  try {
    const url = new URL(reference);
    if (url.search || url.hash || url.username || url.password) return false;
    if (url.protocol === "codex:") {
      return url.hostname === "thread" && /^\/[A-Za-z0-9_-]{1,200}$/.test(url.pathname);
    }
    if (url.protocol !== "git:" && url.protocol !== "file:") return false;
    if (url.protocol === "file:" && url.hostname) return false;
    if (url.protocol === "git:" && !/^[A-Za-z0-9._-]{1,120}$/.test(url.hostname)) return false;
    return /^(?:\/[A-Za-z]:)?\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(url.pathname);
  } catch {
    return false;
  }
}

export function projectReconciliationObservation(
  value: unknown,
): WorkboardReconciliationObservation {
  const input = objectWithOnly(value, "observation", OBSERVATION_FIELDS);
  const card =
    input.card === undefined ? undefined : objectWithOnly(input.card, "card", CARD_FIELDS);
  const link =
    input.link === undefined ? undefined : objectWithOnly(input.link, "link", LINK_FIELDS);
  if (input.expectedRevision !== undefined) {
    readTimestamp(input.expectedRevision, "expectedRevision");
  }
  return {
    sourceUrl: input.sourceUrl as string,
    tenant: input.tenant as string,
    ...(input.objectiveKey === undefined
      ? {}
      : {
          objectiveKey: readBoundedString(
            input.objectiveKey,
            "objectiveKey",
            MAX_OBJECTIVE_KEY_LENGTH,
          ),
        }),
    idempotencyKey: input.idempotencyKey as string,
    sourceUpdatedAt: input.sourceUpdatedAt as number,
    ...(input.cardId === undefined ? {} : { cardId: readRequiredString(input.cardId, "cardId") }),
    ...(input.expectedRevision === undefined
      ? {}
      : { expectedRevision: readTimestamp(input.expectedRevision, "expectedRevision") }),
    ...(card === undefined ? {} : { card: card as WorkboardReconciliationObservation["card"] }),
    ...(link === undefined ? {} : { link: link as WorkboardReconciliationObservation["link"] }),
    ...(input.triage === undefined ? {} : { triage: projectReconciliationTriage(input.triage) }),
  };
}

export function projectReconciliationSourceObservation(
  value: unknown,
): WorkboardReconciliationSourceObservation {
  const input = objectWithOnly(value, "source observation", SOURCE_OBSERVATION_FIELDS);
  const sourceState = input.sourceState;
  if (
    sourceState !== "present" &&
    sourceState !== "missing-after-successful-full-scan" &&
    sourceState !== "dependency-failed"
  ) {
    throw new Error("sourceState is invalid.");
  }
  if (
    !Number.isInteger(input.staleAfterMisses) ||
    (input.staleAfterMisses as number) < 1 ||
    (input.staleAfterMisses as number) > MAX_STALE_AFTER_MISSES
  ) {
    throw new Error("staleAfterMisses must be between 1 and 1000.");
  }
  return {
    cardId: readBoundedString(input.cardId, "cardId", 120),
    tenant: readBoundedString(input.tenant, "tenant", 80),
    objectiveKey: readBoundedString(input.objectiveKey, "objectiveKey", MAX_OBJECTIVE_KEY_LENGTH),
    sourceUrl: readBoundedString(input.sourceUrl, "sourceUrl", 2000),
    reconciliationAssociationKey: readBoundedString(
      input.reconciliationAssociationKey,
      "reconciliationAssociationKey",
      MAX_ASSOCIATION_KEY_LENGTH,
    ),
    observationId: readBoundedString(
      input.observationId,
      "observationId",
      MAX_OBSERVATION_ID_LENGTH,
    ),
    sourceState,
    staleAfterMisses: input.staleAfterMisses as number,
    observedAt: readTimestamp(input.observedAt, "observedAt"),
    expectedRevision: readTimestamp(input.expectedRevision, "expectedRevision"),
  };
}

export class WorkboardReconciler {
  constructor(private readonly store: WorkboardStore) {}

  async list(input: WorkboardReconciliationListInput = {}): Promise<WorkboardReconciliationPage> {
    const cursor = decodeCursor(input.cursor);
    const limit = readLimit(input.limit);
    const tenant =
      input.tenant === undefined ? undefined : readRequiredString(input.tenant, "tenant");
    const boardId =
      input.boardId === undefined ? undefined : readRequiredString(input.boardId, "boardId");
    if (input.terminal !== undefined && typeof input.terminal !== "boolean") {
      throw new Error("terminal must be a boolean.");
    }
    const cards = (await this.store.list({ boardId }))
      .filter((card) => tenant === undefined || tenantFor(card) === tenant)
      .filter((card) => input.terminal === undefined || isProtected(card) === input.terminal)
      .toSorted((left, right) => left.id.localeCompare(right.id));
    const start = cursor === undefined ? 0 : cards.findIndex((card) => card.id > cursor);
    const page = cards.slice(
      start < 0 ? cards.length : start,
      (start < 0 ? cards.length : start) + limit,
    );
    const last = page.at(-1);
    return {
      cards: page.map(redactReconciliationApplyKey),
      ...(last && start + page.length < cards.length ? { cursor: encodeCursor(last.id) } : {}),
    };
  }

  async apply(
    observation: WorkboardReconciliationObservation,
  ): Promise<WorkboardReconciliationApplyResult> {
    const projected = projectReconciliationObservation(observation);
    const link = linkFor(projected);
    const result = await this.store.applyReconciliation(projected, link);
    const { idempotencyKey: _idempotencyKey, ...safeLink } =
      result.link as WorkboardExternalExecutionLink;
    return { ...result, card: redactReconciliationApplyKey(result.card), link: safeLink };
  }

  async observeSource(
    value: WorkboardReconciliationSourceObservation,
  ): Promise<WorkboardReconciliationSourceObservationResult> {
    const result = await this.store.applyReconciliationSourceObservation(
      projectReconciliationSourceObservation(value),
    );
    return { ...result, card: redactReconciliationApplyKey(result.card) };
  }
}
