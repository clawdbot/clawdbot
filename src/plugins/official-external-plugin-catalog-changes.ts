import { Buffer } from "node:buffer";
import { isRecord } from "../utils.js";
import { verifyOfficialExternalPluginCatalogEnvelopePayload } from "./official-external-plugin-catalog-envelope.js";
import {
  isOfficialExternalPluginCatalogFeed,
  isOfficialExternalPluginCatalogSequence,
  parseOfficialExternalPluginCatalogTimestamp,
  type OfficialExternalPluginCatalogEntry,
  type OfficialExternalPluginCatalogFeed,
} from "./official-external-plugin-catalog.js";

const OFFICIAL_EXTERNAL_PLUGIN_CATALOG_CHANGES_PAYLOAD_TYPE =
  "openclaw.official-external-plugin-catalog-changes.v1";

const INCREMENTAL_SNAPSHOT_KIND = "official-external-plugin-catalog-changes-v1";
const RESET_FLOOR_SNAPSHOT_KIND = "official-external-plugin-catalog-reset-floor-v1";
const MAX_CHANGE_RECORDS_PER_PAGE = 500;
const MAX_CHANGE_PAGES_PER_SNAPSHOT = 2048;
const MAX_CURSOR_BYTES = 4096;
const MAX_DESCRIPTION_BYTES = 1024;

type TrustedSigningKey = { keyId: string; publicKey: string };

type CatalogChange =
  | { sequence: number; operation: "upsert"; entry: OfficialExternalPluginCatalogEntry }
  | { sequence: number; operation: "remove"; entryId: string; entryType: "plugin" | "skill" }
  | { sequence: number; operation: "metadata"; metadata: { description: string | null } };

type OfficialExternalPluginCatalogChangePage = {
  schemaVersion: 1;
  feedId: string;
  fromSequence: number;
  toSequence: number;
  generatedAt: string;
  expiresAt: string;
  requestCursor: string | null;
  pageIndex: number;
  startIndex: number;
  changeCount: number;
  changes: readonly CatalogChange[];
  nextCursor: string | null;
};

type OfficialExternalPluginCatalogResetRequired = {
  schemaVersion: 1;
  feedId: string;
  fromSequence: number;
  currentSequence: number;
  generatedAt: string;
  expiresAt: string;
  resetRequired: true;
  snapshotUrl: string;
};

type OfficialExternalPluginCatalogIncrementalSnapshot = {
  kind: typeof INCREMENTAL_SNAPSHOT_KIND;
  baseBody: string;
  changeBodies: readonly string[];
  materializedFeedSha256?: string;
};

type OfficialExternalPluginCatalogResetFloorSnapshot = {
  kind: typeof RESET_FLOOR_SNAPSHOT_KIND;
  snapshotBody: string;
  minimumSequence: number;
};

type VerifiedOfficialExternalPluginCatalogChangePayload = {
  payload: OfficialExternalPluginCatalogChangePage | OfficialExternalPluginCatalogResetRequired;
  signedBy: string;
  signatureCount: number;
  threshold: number;
};

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return (
    Object.keys(value).length === expected.size &&
    Object.keys(value).every((key) => expected.has(key))
  );
}

function requireString(value: unknown, label: string, maxBytes = 256): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") < 1 ||
    Buffer.byteLength(value, "utf8") > maxBytes
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function requireAnyString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function requireSequence(value: unknown, label: string): number {
  if (!isOfficialExternalPluginCatalogSequence(value)) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function requireTimestamp(value: unknown, label: string): string {
  const timestamp = requireString(value, label, 64);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(timestamp) ||
    parseOfficialExternalPluginCatalogTimestamp(timestamp) === undefined
  ) {
    throw new Error(`${label} must be an RFC 3339 timestamp`);
  }
  return timestamp;
}

function requireCursor(value: unknown, label: string): string | null {
  if (value === null) {
    return null;
  }
  return requireString(value, label, MAX_CURSOR_BYTES);
}

function parseCatalogEntry(value: unknown): OfficialExternalPluginCatalogEntry {
  if (!isRecord(value)) {
    throw new Error("hosted catalog change upsert entry is malformed");
  }
  const optional = new Set(["description", "icon", "featured", "featuredAt"]);
  const required = ["type", "id", "title", "version", "state", "publisher", "install"];
  if (
    !Object.keys(value).every((key) => required.includes(key) || optional.has(key)) ||
    !required.every((key) => key in value)
  ) {
    throw new Error("hosted catalog change upsert entry is malformed");
  }
  if (value.type !== "plugin" && value.type !== "skill") {
    throw new Error("hosted catalog change upsert entry type is invalid");
  }
  requireString(value.id, "hosted catalog change upsert entry id");
  requireAnyString(value.title, "hosted catalog change upsert entry title");
  requireAnyString(value.version, "hosted catalog change upsert entry version");
  if (
    typeof value.state !== "string" ||
    !["available", "recommended", "disabled", "blocked", "deprecated"].includes(value.state)
  ) {
    throw new Error("hosted catalog change upsert entry state is invalid");
  }
  if (value.description !== undefined) {
    requireAnyString(value.description, "hosted catalog change upsert entry description");
  }
  if (value.icon !== undefined) {
    requireAnyString(value.icon, "hosted catalog change upsert entry icon");
  }
  if (value.featured !== undefined && typeof value.featured !== "boolean") {
    throw new Error("hosted catalog change upsert entry featured is invalid");
  }
  if (
    value.featuredAt !== undefined &&
    (!Number.isSafeInteger(value.featuredAt) ||
      Number(value.featuredAt) < 0 ||
      value.featured !== true)
  ) {
    throw new Error("hosted catalog change upsert entry featuredAt is invalid");
  }
  if (
    !isRecord(value.publisher) ||
    !hasExactKeys(value.publisher, ["id", "trust"]) ||
    (value.publisher.trust !== "official" && value.publisher.trust !== "community")
  ) {
    throw new Error("hosted catalog change upsert publisher is malformed");
  }
  requireAnyString(value.publisher.id, "hosted catalog change upsert publisher id");
  if (
    !isRecord(value.install) ||
    !hasExactKeys(value.install, ["candidates"]) ||
    !Array.isArray(value.install.candidates)
  ) {
    throw new Error("hosted catalog change upsert install is malformed");
  }
  for (const candidate of value.install.candidates) {
    if (!isRecord(candidate)) {
      throw new Error("hosted catalog change upsert install candidate is malformed");
    }
    const keys =
      candidate.github === undefined
        ? ["sourceRef", "package", "version", "integrity"]
        : ["sourceRef", "package", "version", "integrity", "github"];
    if (!hasExactKeys(candidate, keys)) {
      throw new Error("hosted catalog change upsert install candidate is malformed");
    }
    for (const field of ["sourceRef", "package", "version", "integrity"] as const) {
      requireAnyString(candidate[field], `hosted catalog change upsert install candidate ${field}`);
    }
    if (candidate.github !== undefined) {
      if (
        !isRecord(candidate.github) ||
        !hasExactKeys(candidate.github, ["repo", "path", "commit", "contentHash"])
      ) {
        throw new Error("hosted catalog change upsert GitHub source is malformed");
      }
      for (const field of ["repo", "path", "commit", "contentHash"] as const) {
        requireAnyString(
          candidate.github[field],
          `hosted catalog change upsert GitHub source ${field}`,
        );
      }
    }
  }
  return value;
}

function parseChange(value: unknown): CatalogChange {
  if (!isRecord(value)) {
    throw new Error("hosted catalog change record is malformed");
  }
  const sequence = requireSequence(value.sequence, "hosted catalog change sequence");
  if (value.operation === "upsert" && hasExactKeys(value, ["sequence", "operation", "entry"])) {
    return { sequence, operation: "upsert", entry: parseCatalogEntry(value.entry) };
  }
  if (
    value.operation === "remove" &&
    hasExactKeys(value, ["sequence", "operation", "entryId", "entryType"]) &&
    (value.entryType === "plugin" || value.entryType === "skill")
  ) {
    return {
      sequence,
      operation: "remove",
      entryId: requireString(value.entryId, "hosted catalog change removed entry id"),
      entryType: value.entryType,
    };
  }
  if (
    value.operation === "metadata" &&
    hasExactKeys(value, ["sequence", "operation", "metadata"]) &&
    isRecord(value.metadata) &&
    hasExactKeys(value.metadata, ["description"]) &&
    (value.metadata.description === null || typeof value.metadata.description === "string")
  ) {
    if (typeof value.metadata.description === "string") {
      requireString(
        value.metadata.description,
        "hosted catalog change description",
        MAX_DESCRIPTION_BYTES,
      );
    }
    return {
      sequence,
      operation: "metadata",
      metadata: { description: value.metadata.description },
    };
  }
  throw new Error("hosted catalog change record is malformed");
}

function parseProjectionHeader(value: Record<string, unknown>) {
  if (value.schemaVersion !== 1) {
    throw new Error("hosted catalog change schema version is unsupported");
  }
  const feedId = requireString(value.feedId, "hosted catalog change feed id");
  const generatedAt = requireTimestamp(value.generatedAt, "hosted catalog change generatedAt");
  const expiresAt = requireTimestamp(value.expiresAt, "hosted catalog change expiresAt");
  if (Date.parse(expiresAt) <= Date.parse(generatedAt)) {
    throw new Error("hosted catalog change validity window is invalid");
  }
  return { feedId, generatedAt, expiresAt };
}

function parseOfficialExternalPluginCatalogChangePayload(
  value: unknown,
): OfficialExternalPluginCatalogChangePage | OfficialExternalPluginCatalogResetRequired {
  if (!isRecord(value)) {
    throw new Error("hosted catalog change payload is malformed");
  }
  const header = parseProjectionHeader(value);
  if (value.resetRequired === true) {
    if (
      !hasExactKeys(value, [
        "schemaVersion",
        "feedId",
        "fromSequence",
        "currentSequence",
        "generatedAt",
        "expiresAt",
        "resetRequired",
        "snapshotUrl",
      ])
    ) {
      throw new Error("hosted catalog reset response is malformed");
    }
    const fromSequence = requireSequence(value.fromSequence, "hosted catalog reset fromSequence");
    const currentSequence = requireSequence(
      value.currentSequence,
      "hosted catalog reset currentSequence",
    );
    if (currentSequence <= fromSequence) {
      throw new Error("hosted catalog reset currentSequence must advance fromSequence");
    }
    let snapshotUrl: URL;
    try {
      snapshotUrl = new URL(
        requireString(value.snapshotUrl, "hosted catalog reset snapshot URL", 4096),
      );
    } catch {
      throw new Error("hosted catalog reset snapshot URL is invalid");
    }
    if (snapshotUrl.protocol !== "https:" || snapshotUrl.username || snapshotUrl.password) {
      throw new Error("hosted catalog reset snapshot URL must be credential-free HTTPS");
    }
    return {
      schemaVersion: 1,
      ...header,
      fromSequence,
      currentSequence,
      resetRequired: true,
      snapshotUrl: snapshotUrl.href,
    };
  }
  if (
    !hasExactKeys(value, [
      "schemaVersion",
      "feedId",
      "fromSequence",
      "toSequence",
      "generatedAt",
      "expiresAt",
      "requestCursor",
      "pageIndex",
      "startIndex",
      "changeCount",
      "changes",
      "nextCursor",
    ]) ||
    !Array.isArray(value.changes)
  ) {
    throw new Error("hosted catalog change page is malformed");
  }
  const fromSequence = requireSequence(value.fromSequence, "hosted catalog change fromSequence");
  const toSequence = requireSequence(value.toSequence, "hosted catalog change toSequence");
  const pageIndex = requireSequence(value.pageIndex, "hosted catalog change pageIndex");
  const startIndex = requireSequence(value.startIndex, "hosted catalog change startIndex");
  const changeCount = requireSequence(value.changeCount, "hosted catalog change changeCount");
  if (toSequence < fromSequence) {
    throw new Error("hosted catalog change toSequence precedes fromSequence");
  }
  if (value.changes.length > MAX_CHANGE_RECORDS_PER_PAGE) {
    throw new Error("hosted catalog change page exceeds its record limit");
  }
  const changes = value.changes.map(parseChange);
  let prior = fromSequence;
  for (const change of changes) {
    if (
      change.sequence <= fromSequence ||
      change.sequence > toSequence ||
      change.sequence < prior ||
      (change.sequence > prior + 1 && (pageIndex === 0 || prior > fromSequence))
    ) {
      throw new Error("hosted catalog change page contains an invalid sequence range");
    }
    prior = change.sequence;
  }
  const requestCursor = requireCursor(value.requestCursor, "hosted catalog change request cursor");
  const nextCursor = requireCursor(value.nextCursor, "hosted catalog change next cursor");
  if (requestCursor === null && (pageIndex !== 0 || startIndex !== 0)) {
    throw new Error("hosted catalog change first page must start at zero");
  }
  if (requestCursor !== null && pageIndex === 0) {
    throw new Error("hosted catalog change continuation page index is invalid");
  }
  if (
    startIndex + changes.length > changeCount ||
    (nextCursor === null && startIndex + changes.length !== changeCount) ||
    (nextCursor !== null &&
      (changes.length === 0 ||
        startIndex + changes.length >= changeCount ||
        nextCursor === requestCursor))
  ) {
    throw new Error("hosted catalog change page bounds are invalid");
  }
  if (nextCursor === null && (changes.at(-1)?.sequence ?? fromSequence) !== toSequence) {
    throw new Error("hosted catalog terminal change page does not reach toSequence");
  }
  return {
    schemaVersion: 1,
    ...header,
    fromSequence,
    toSequence,
    requestCursor,
    pageIndex,
    startIndex,
    changeCount,
    changes,
    nextCursor,
  };
}

export function verifyOfficialExternalPluginCatalogChangeEnvelopeBody(
  body: string,
  params: { trustedKeys: readonly TrustedSigningKey[]; threshold?: number },
): VerifiedOfficialExternalPluginCatalogChangePayload {
  let document: unknown;
  try {
    document = JSON.parse(body) as unknown;
  } catch {
    throw new Error("hosted catalog change envelope is not valid JSON");
  }
  const threshold = Math.max(1, Math.trunc(params.threshold ?? 1));
  const verified = verifyOfficialExternalPluginCatalogEnvelopePayload(document, {
    trustedKeys: params.trustedKeys,
    acceptedPayloadTypes: new Set([OFFICIAL_EXTERNAL_PLUGIN_CATALOG_CHANGES_PAYLOAD_TYPE]),
    threshold,
  });
  if (!verified.ok) {
    throw new Error(verified.message);
  }
  return {
    payload: parseOfficialExternalPluginCatalogChangePayload(verified.payload),
    signedBy: verified.signedBy,
    signatureCount: verified.signatureCount ?? 1,
    threshold,
  };
}

function entryKey(entry: OfficialExternalPluginCatalogEntry): string {
  if (
    (entry.type !== "plugin" && entry.type !== "skill") ||
    typeof entry.id !== "string" ||
    entry.id.length === 0
  ) {
    throw new Error("hosted catalog incremental base entry has no stable identity");
  }
  return `${entry.type}\0${entry.id}`;
}

function compareEntries(
  left: OfficialExternalPluginCatalogEntry,
  right: OfficialExternalPluginCatalogEntry,
): number {
  return Buffer.compare(Buffer.from(entryKey(left), "utf8"), Buffer.from(entryKey(right), "utf8"));
}

function applyChangePages(
  feed: OfficialExternalPluginCatalogFeed,
  pages: readonly OfficialExternalPluginCatalogChangePage[],
): OfficialExternalPluginCatalogFeed {
  if (pages.length === 0) {
    return feed;
  }
  const first = pages[0]!;
  if (first.feedId !== feed.id || first.fromSequence !== feed.sequence) {
    throw new Error("hosted catalog change range does not continue the accepted feed");
  }
  let expectedCursor: string | null = null;
  let expectedStartIndex = 0;
  let priorSequence = first.fromSequence;
  const consumedCursors = new Set<string>();
  for (const [index, page] of pages.entries()) {
    if (
      page.feedId !== first.feedId ||
      page.fromSequence !== first.fromSequence ||
      page.toSequence !== first.toSequence ||
      page.generatedAt !== first.generatedAt ||
      page.expiresAt !== first.expiresAt ||
      page.changeCount !== first.changeCount
    ) {
      throw new Error("hosted catalog change page chain changed its pinned range");
    }
    if (
      page.pageIndex !== index ||
      page.startIndex !== expectedStartIndex ||
      page.requestCursor !== expectedCursor
    ) {
      throw new Error("hosted catalog change page chain contains a cursor, page, or offset gap");
    }
    if (page.requestCursor !== null) {
      if (consumedCursors.has(page.requestCursor)) {
        throw new Error("hosted catalog change page chain reuses a continuation cursor");
      }
      consumedCursors.add(page.requestCursor);
    }
    for (const change of page.changes) {
      if (change.sequence !== priorSequence && change.sequence !== priorSequence + 1) {
        throw new Error("hosted catalog change page chain contains a missing revision");
      }
      priorSequence = change.sequence;
    }
    expectedStartIndex += page.changes.length;
    expectedCursor = page.nextCursor;
  }
  if (
    expectedCursor !== null ||
    expectedStartIndex !== first.changeCount ||
    priorSequence !== first.toSequence
  ) {
    throw new Error("hosted catalog change page chain is incomplete");
  }
  if (
    first.toSequence === feed.sequence &&
    Date.parse(first.generatedAt) < Date.parse(feed.generatedAt)
  ) {
    throw new Error("hosted catalog change range rolls back the accepted generation time");
  }
  const entries = new Map<string, OfficialExternalPluginCatalogEntry>();
  for (const entry of feed.entries) {
    const key = entryKey(entry);
    if (entries.has(key)) {
      throw new Error("hosted catalog incremental base contains duplicate entry identities");
    }
    entries.set(key, entry);
  }
  let description = feed.description;
  for (const page of pages) {
    for (const change of page.changes) {
      if (change.operation === "upsert") {
        entries.set(entryKey(change.entry), change.entry);
      } else if (change.operation === "remove") {
        entries.delete(`${change.entryType}\0${change.entryId}`);
      } else {
        description = change.metadata.description ?? undefined;
      }
    }
  }
  const materialized: OfficialExternalPluginCatalogFeed = {
    ...feed,
    sequence: first.toSequence,
    generatedAt: first.generatedAt,
    expiresAt: first.expiresAt,
    entries: [...entries.values()].toSorted(compareEntries),
  };
  if (description === undefined) {
    delete materialized.description;
  } else {
    materialized.description = description;
  }
  if (!isOfficialExternalPluginCatalogFeed(materialized)) {
    throw new Error("hosted catalog incremental result is invalid");
  }
  return materialized;
}

export function applyVerifiedOfficialExternalPluginCatalogChanges(params: {
  feed: OfficialExternalPluginCatalogFeed;
  changes: readonly VerifiedOfficialExternalPluginCatalogChangePayload[];
  expectedFeedId?: string;
}): {
  feed: OfficialExternalPluginCatalogFeed;
  signedBy: string;
  signatureCount: number;
  threshold: number;
} {
  if (params.changes.length === 0 || params.changes.length > MAX_CHANGE_PAGES_PER_SNAPSHOT) {
    throw new Error("hosted catalog incremental snapshot has an invalid change page count");
  }
  let feed = params.feed;
  let range: OfficialExternalPluginCatalogChangePage[] = [];
  let lastVerification: VerifiedOfficialExternalPluginCatalogChangePayload | undefined;
  for (const verified of params.changes) {
    if ("resetRequired" in verified.payload) {
      throw new Error("hosted catalog incremental snapshot cannot contain a reset response");
    }
    if (params.expectedFeedId && verified.payload.feedId !== params.expectedFeedId) {
      throw new Error("hosted catalog change feed identity did not match the configured feed");
    }
    if (verified.payload.pageIndex === 0) {
      if (range.length > 0) {
        throw new Error("hosted catalog incremental snapshot contains an incomplete range");
      }
    } else if (range.length === 0) {
      throw new Error("hosted catalog incremental snapshot starts with a continuation page");
    }
    range.push(verified.payload);
    if (verified.payload.nextCursor === null) {
      feed = applyChangePages(feed, range);
      range = [];
    }
    lastVerification = verified;
  }
  if (range.length > 0 || !lastVerification) {
    throw new Error("hosted catalog incremental snapshot contains an incomplete range");
  }
  return {
    feed,
    signedBy: lastVerification.signedBy,
    signatureCount: lastVerification.signatureCount,
    threshold: lastVerification.threshold,
  };
}

export function applyVerifiedOfficialExternalPluginCatalogChangeBodies(params: {
  feed: OfficialExternalPluginCatalogFeed;
  changeBodies: readonly string[];
  trustedKeys: readonly TrustedSigningKey[];
  threshold?: number;
  expectedFeedId?: string;
}): {
  feed: OfficialExternalPluginCatalogFeed;
  signedBy: string;
  signatureCount: number;
  threshold: number;
} {
  return applyVerifiedOfficialExternalPluginCatalogChanges({
    feed: params.feed,
    changes: params.changeBodies.map((body) =>
      verifyOfficialExternalPluginCatalogChangeEnvelopeBody(body, params),
    ),
    expectedFeedId: params.expectedFeedId,
  });
}

export function parseOfficialExternalPluginCatalogIncrementalSnapshot(
  value: unknown,
): OfficialExternalPluginCatalogIncrementalSnapshot | null {
  if (!isRecord(value) || value.kind !== INCREMENTAL_SNAPSHOT_KIND) {
    return null;
  }
  if (
    (!hasExactKeys(value, ["kind", "baseBody", "changeBodies"]) &&
      !hasExactKeys(value, ["kind", "baseBody", "changeBodies", "materializedFeedSha256"])) ||
    typeof value.baseBody !== "string" ||
    !Array.isArray(value.changeBodies) ||
    !value.changeBodies.every((body): body is string => typeof body === "string") ||
    value.changeBodies.length === 0 ||
    value.changeBodies.length > MAX_CHANGE_PAGES_PER_SNAPSHOT ||
    (value.materializedFeedSha256 !== undefined &&
      (typeof value.materializedFeedSha256 !== "string" ||
        !/^sha256:[a-f0-9]{64}$/u.test(value.materializedFeedSha256)))
  ) {
    throw new Error("hosted catalog incremental snapshot is malformed");
  }
  return {
    kind: INCREMENTAL_SNAPSHOT_KIND,
    baseBody: value.baseBody,
    changeBodies: value.changeBodies,
    ...(typeof value.materializedFeedSha256 === "string"
      ? { materializedFeedSha256: value.materializedFeedSha256 }
      : {}),
  };
}

export function serializeOfficialExternalPluginCatalogIncrementalSnapshot(params: {
  baseBody: string;
  changeBodies: readonly string[];
  materializedFeedSha256?: string;
}): string {
  if (
    params.changeBodies.length === 0 ||
    params.changeBodies.length > MAX_CHANGE_PAGES_PER_SNAPSHOT
  ) {
    throw new Error("hosted catalog incremental snapshot has an invalid change page count");
  }
  if (
    params.materializedFeedSha256 !== undefined &&
    !/^sha256:[a-f0-9]{64}$/u.test(params.materializedFeedSha256)
  ) {
    throw new Error("hosted catalog incremental snapshot materialized feed digest is invalid");
  }
  return JSON.stringify({
    kind: INCREMENTAL_SNAPSHOT_KIND,
    baseBody: params.baseBody,
    changeBodies: params.changeBodies,
    ...(params.materializedFeedSha256
      ? { materializedFeedSha256: params.materializedFeedSha256 }
      : {}),
  });
}

export function parseOfficialExternalPluginCatalogResetFloorSnapshot(
  value: unknown,
): OfficialExternalPluginCatalogResetFloorSnapshot | null {
  if (!isRecord(value) || value.kind !== RESET_FLOOR_SNAPSHOT_KIND) {
    return null;
  }
  if (
    !hasExactKeys(value, ["kind", "snapshotBody", "minimumSequence"]) ||
    typeof value.snapshotBody !== "string" ||
    !isOfficialExternalPluginCatalogSequence(value.minimumSequence)
  ) {
    throw new Error("hosted catalog reset floor snapshot is malformed");
  }
  return {
    kind: RESET_FLOOR_SNAPSHOT_KIND,
    snapshotBody: value.snapshotBody,
    minimumSequence: value.minimumSequence,
  };
}

export function serializeOfficialExternalPluginCatalogResetFloorSnapshot(params: {
  snapshotBody: string;
  minimumSequence: number;
}): string {
  if (!isOfficialExternalPluginCatalogSequence(params.minimumSequence)) {
    throw new Error("hosted catalog reset floor snapshot sequence is invalid");
  }
  return JSON.stringify({ kind: RESET_FLOOR_SNAPSHOT_KIND, ...params });
}
