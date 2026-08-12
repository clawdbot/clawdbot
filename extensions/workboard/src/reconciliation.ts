// Workboard reconciliation facade accepts safe external execution observations.
import type {
  WorkboardCard,
  WorkboardExternalExecutionLink,
  WorkboardReconciliationApplyResult,
  WorkboardReconciliationObservation,
  WorkboardReconciliationPage,
  WorkboardStatus,
} from "@openclaw/workboard-contract";
import { WorkboardStore } from "./store.js";

const MAX_PAGE_SIZE = 100;
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

function sourceUpdatedAtFor(card: WorkboardCard): number | undefined {
  return card.metadata?.lifecycleStatusSourceUpdatedAt;
}

function isProtected(card: WorkboardCard): boolean {
  return RECONCILIATION_PROTECTED_STATUSES.has(card.status);
}

function linkFor(observation: WorkboardReconciliationObservation): WorkboardExternalExecutionLink {
  return {
    sourceUrl: readRequiredString(observation.sourceUrl, "sourceUrl"),
    tenant: readRequiredString(observation.tenant, "tenant"),
    idempotencyKey: readRequiredString(observation.idempotencyKey, "idempotencyKey"),
    sourceUpdatedAt: readTimestamp(observation.sourceUpdatedAt, "sourceUpdatedAt"),
    ...(typeof observation.link?.title === "string" && observation.link.title.trim()
      ? { title: observation.link.title.trim() }
      : {}),
  };
}

function result(card: WorkboardCard, applied: boolean, link: WorkboardExternalExecutionLink) {
  return { card, applied, link } satisfies WorkboardReconciliationApplyResult;
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
      cards: page,
      ...(last && start + page.length < cards.length ? { cursor: encodeCursor(last.id) } : {}),
    };
  }

  async apply(
    observation: WorkboardReconciliationObservation,
  ): Promise<WorkboardReconciliationApplyResult> {
    const link = linkFor(observation);
    const cards = await this.store.list();
    const duplicate = cards.find(
      (card) =>
        tenantFor(card) === link.tenant &&
        card.metadata?.automation?.idempotencyKey === link.idempotencyKey,
    );
    if (duplicate) {
      return result(duplicate, true, link);
    }

    const existing = observation.cardId
      ? await this.store.get(readRequiredString(observation.cardId, "cardId"))
      : cards.find((card) => card.sourceUrl === link.sourceUrl && tenantFor(card) === link.tenant);
    if (existing) {
      if (
        observation.expectedRevision !== undefined &&
        observation.expectedRevision !== existing.updatedAt
      ) {
        return result(existing, false, link);
      }
      if (
        sourceUpdatedAtFor(existing) !== undefined &&
        link.sourceUpdatedAt <= sourceUpdatedAtFor(existing)!
      ) {
        return result(existing, false, link);
      }
      if (isProtected(existing)) {
        return result(existing, false, link);
      }
      const patch = observation.card ?? {};
      const status = patch.status;
      const updated = await this.store.update(existing.id, {
        ...patch,
        ...(RECONCILIATION_PROTECTED_STATUSES.has(status as WorkboardStatus)
          ? { status: existing.status }
          : {}),
        sourceUrl: link.sourceUrl,
        tenant: link.tenant,
        idempotencyKey: link.idempotencyKey,
        metadata: {
          ...existing.metadata,
          lifecycleStatusSourceUpdatedAt: link.sourceUpdatedAt,
          links: [
            ...(existing.metadata?.links ?? []),
            {
              id: `external:${link.idempotencyKey}`,
              type: "relates_to",
              createdAt: Date.now(),
              url: link.sourceUrl,
              title: link.title,
            },
          ],
        },
      });
      return result(updated, true, link);
    }

    const card = observation.card ?? {};
    if (typeof card.title !== "string" || card.title.trim() === "") {
      throw new Error("card.title is required when creating a card.");
    }
    const created = await this.store.create({
      ...card,
      ...(RECONCILIATION_PROTECTED_STATUSES.has(card.status as WorkboardStatus)
        ? { status: "todo" }
        : {}),
      sourceUrl: link.sourceUrl,
      tenant: link.tenant,
      idempotencyKey: link.idempotencyKey,
      metadata: {
        lifecycleStatusSourceUpdatedAt: link.sourceUpdatedAt,
        links: [
          {
            id: `external:${link.idempotencyKey}`,
            type: "relates_to",
            createdAt: Date.now(),
            url: link.sourceUrl,
            title: link.title,
          },
        ],
      },
    });
    return result(created, true, link);
  }
}
