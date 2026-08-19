// ClawHub promotion APIs and hosted feed validation.
import { isRecord as isJsonObject } from "@openclaw/normalization-core/record-coerce";
import { hasValidIsoCalendarComponents } from "../shared/iso-time.js";
import {
  CLAWHUB_JSON_MAX_BYTES,
  createClawHubError,
  decodeClawHubResponseBody,
  fetchClawHubJson,
  readClawHubBooleanField,
  readClawHubBytes,
  readClawHubStringArrayField,
  readClawHubStringField,
  readRequiredClawHubBooleanField,
  readRequiredClawHubNumberField,
  readRequiredClawHubStringField,
  requestClawHub,
  type ClawHubFetch,
} from "./clawhub-client.js";
import { parseRegistryNpmSpec } from "./npm-registry-spec.js";

// ─── ClawHub promotions ────────────────────────────────────────────────────
// Promotional model offers published by ClawHub (GET /api/v1/promotions).
// The payload is declarative only: provider/authChoiceId/pluginNames are
// validated against the local provider catalog by the caller before any
// install/auth action, so a malformed or hostile record cannot execute code.

type ClawHubPromotionModel = {
  modelRef: string;
  alias?: string;
  suggestedDefault?: boolean;
};

export type ClawHubPromotion = {
  slug: string;
  title: string;
  blurb: string;
  sponsor?: string;
  status: string;
  active: boolean;
  startsAt: number;
  endsAt: number;
  provider?: string;
  authChoiceId?: string;
  pluginNames?: string[];
  models: ClawHubPromotionModel[];
  signupUrl?: string;
  docsUrl?: string;
  launchPageUrl?: string;
};

// A hosted-feed snapshot entry: the same declarative payload without the
// live-only status/active flags (the feed only ever contains live records;
// clients still window-filter on startsAt/endsAt).
export type ClawHubPromotionsFeedEntry = Omit<ClawHubPromotion, "status" | "active">;

type ClawHubPromotionsFeed = {
  schemaVersion: number;
  id: string;
  generatedAt: string;
  sequence: number;
  expiresAt: string;
  entries: ClawHubPromotionsFeedEntry[];
};

// Shell-safe contract for provider/model refs: they are echoed into
// copy-paste CLI commands, so whitespace and shell metacharacters must fail
// parsing rather than reach a terminal.
const CLAWHUB_PROMOTION_MODEL_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

function parseClawHubPromotionModel(value: unknown, context: string): ClawHubPromotionModel {
  if (!isJsonObject(value)) {
    throw new Error(`Malformed ClawHub ${context}: expected each model to be an object.`);
  }
  const modelRef = readRequiredClawHubStringField(value, "modelRef", context);
  if (!CLAWHUB_PROMOTION_MODEL_REF_RE.test(modelRef)) {
    throw new Error(`Malformed ClawHub ${context}: modelRef contains unsupported characters.`);
  }
  const model: ClawHubPromotionModel = {
    modelRef,
  };
  const alias = readClawHubStringField(value, "alias", context);
  if (alias) {
    model.alias = alias;
  }
  const suggestedDefault = readClawHubBooleanField(value, "suggestedDefault", context);
  if (suggestedDefault !== undefined) {
    model.suggestedDefault = suggestedDefault;
  }
  return model;
}

// ClawHub's server-side slug contract. Enforced here because slugs are echoed
// into copy-paste CLI commands; anything else would be a shell-injection path.
const CLAWHUB_PROMOTION_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

// Safe identifier grammar for provider ids and auth choice ids.
const CLAWHUB_PROMOTION_IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._@/-]*$/;

// Shared shape between the live API promotion and a feed entry: everything
// except the live-only `status`/`active` flags.
function parseClawHubPromotionCore(
  value: Record<string, unknown>,
  context: string,
): ClawHubPromotionsFeedEntry {
  const modelsRaw = value.models;
  if (!Array.isArray(modelsRaw) || modelsRaw.length === 0) {
    throw new Error(`Malformed ClawHub ${context}: expected models to be a non-empty array.`);
  }
  const slug = readRequiredClawHubStringField(value, "slug", context);
  if (!CLAWHUB_PROMOTION_SLUG_RE.test(slug)) {
    throw new Error(`Malformed ClawHub ${context}: slug must be lowercase [a-z0-9-].`);
  }
  const startsAt = readRequiredClawHubNumberField(value, "startsAt", context);
  const endsAt = readRequiredClawHubNumberField(value, "endsAt", context);
  if (endsAt <= startsAt) {
    throw new Error(`Malformed ClawHub ${context}: promotion window must end after it starts.`);
  }
  const promotion: ClawHubPromotionsFeedEntry = {
    slug,
    title: readRequiredClawHubStringField(value, "title", context),
    blurb: readRequiredClawHubStringField(value, "blurb", context),
    startsAt,
    endsAt,
    models: modelsRaw.map((entry) => parseClawHubPromotionModel(entry, context)),
  };
  const optionalStrings = ["sponsor", "signupUrl", "docsUrl", "launchPageUrl"] as const;
  for (const field of optionalStrings) {
    const parsed = readClawHubStringField(value, field, context);
    if (parsed) {
      promotion[field] = parsed;
    }
  }
  // Identifier fields are echoed into error messages and config; hold them to
  // a safe identifier grammar so remote payloads cannot smuggle terminal
  // controls or whitespace through failure paths.
  const identifierFields = ["provider", "authChoiceId"] as const;
  for (const field of identifierFields) {
    const parsed = readClawHubStringField(value, field, context);
    if (!parsed) {
      continue;
    }
    if (!CLAWHUB_PROMOTION_IDENTIFIER_RE.test(parsed)) {
      throw new Error(`Malformed ClawHub ${context}: ${field} contains unsupported characters.`);
    }
    promotion[field] = parsed;
  }
  const pluginNames = readClawHubStringArrayField(value, "pluginNames", context);
  if (pluginNames && pluginNames.length > 0) {
    for (const name of pluginNames) {
      const parsed = parseRegistryNpmSpec(name);
      if (!parsed || parsed.selectorKind !== "none" || parsed.name !== name) {
        throw new Error(
          `Malformed ClawHub ${context}: pluginNames must contain npm package names.`,
        );
      }
    }
    promotion.pluginNames = pluginNames;
  }
  return promotion;
}

function parseClawHubPromotion(value: unknown): ClawHubPromotion {
  const context = "promotion";
  if (!isJsonObject(value)) {
    throw new Error(`Malformed ClawHub ${context}: expected an object.`);
  }
  return {
    ...parseClawHubPromotionCore(value, context),
    status: readRequiredClawHubStringField(value, "status", context),
    active: readRequiredClawHubBooleanField(value, "active", context),
  };
}

export async function fetchClawHubPromotions(
  params: {
    baseUrl?: string;
    timeoutMs?: number;
    fetchImpl?: ClawHubFetch;
  } = {},
): Promise<ClawHubPromotion[]> {
  const response = await fetchClawHubJson<unknown>({
    baseUrl: params.baseUrl,
    path: "/api/v1/promotions",
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
  });
  if (!isJsonObject(response) || !Array.isArray(response.promotions)) {
    throw new Error("Malformed ClawHub promotions response: expected a promotions array.");
  }
  return response.promotions.map((entry) => parseClawHubPromotion(entry));
}

export async function fetchClawHubPromotion(params: {
  slug: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: ClawHubFetch;
}): Promise<ClawHubPromotion> {
  const response = await fetchClawHubJson<unknown>({
    baseUrl: params.baseUrl,
    path: `/api/v1/promotions/${encodeURIComponent(params.slug)}`,
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
  });
  return parseClawHubPromotion(response);
}

// ─── ClawHub promotions feed (GET /api/v1/feeds/promotions) ───────────────
// Immutable hosted snapshot used for passive discovery: cheap conditional
// GETs (`If-None-Match` → 304), never authoritative for claiming — `promos
// claim` always revalidates against the live API so the kill switch wins
// regardless of snapshot staleness.

const CLAWHUB_PROMOTIONS_FEED_ID = "clawhub-promotions";
// Strict cross-repo wire contract with ClawHub's promotionsFeed publisher.
// Bump only in lockstep with the server-side schema.
const CLAWHUB_PROMOTIONS_FEED_SCHEMA_VERSION = 1;

export function parseClawHubPromotionsFeed(value: unknown): ClawHubPromotionsFeed {
  const context = "promotions feed";
  if (!isJsonObject(value)) {
    throw new Error(`Malformed ClawHub ${context}: expected an object.`);
  }
  const id = readRequiredClawHubStringField(value, "id", context);
  if (id !== CLAWHUB_PROMOTIONS_FEED_ID) {
    throw new Error(`Malformed ClawHub ${context}: unexpected feed id.`);
  }
  const schemaVersion = readRequiredClawHubNumberField(value, "schemaVersion", context);
  if (schemaVersion !== CLAWHUB_PROMOTIONS_FEED_SCHEMA_VERSION) {
    throw new Error(`Unsupported ClawHub ${context} schema version ${schemaVersion}.`);
  }
  const sequence = readRequiredClawHubNumberField(value, "sequence", context);
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error(`Malformed ClawHub ${context}: sequence must be a non-negative integer.`);
  }
  const generatedAt = readRequiredClawHubStringField(value, "generatedAt", context);
  const expiresAt = readRequiredClawHubStringField(value, "expiresAt", context);
  const generatedAtMs = Date.parse(generatedAt);
  const expiresAtMs = Date.parse(expiresAt);
  if (
    !Number.isFinite(generatedAtMs) ||
    !Number.isFinite(expiresAtMs) ||
    !hasValidIsoCalendarComponents(generatedAt) ||
    !hasValidIsoCalendarComponents(expiresAt)
  ) {
    throw new Error(`Malformed ClawHub ${context}: timestamps must be ISO dates.`);
  }
  if (expiresAtMs <= generatedAtMs) {
    throw new Error(`Malformed ClawHub ${context}: expiresAt must be after generatedAt.`);
  }
  const entriesRaw = value.entries;
  if (!Array.isArray(entriesRaw)) {
    throw new Error(`Malformed ClawHub ${context}: expected an entries array.`);
  }
  const entries = entriesRaw.map((entry) => {
    if (!isJsonObject(entry)) {
      throw new Error(`Malformed ClawHub ${context}: expected each entry to be an object.`);
    }
    if (readRequiredClawHubStringField(entry, "type", context) !== "promotion") {
      throw new Error(`Malformed ClawHub ${context}: unexpected entry type.`);
    }
    return parseClawHubPromotionCore(entry, context);
  });
  return { schemaVersion, id, generatedAt, sequence, expiresAt, entries };
}

type ClawHubPromotionsFeedFetchResult =
  | { status: "not-modified" }
  | { status: "ok"; feed: ClawHubPromotionsFeed; payload: string; etag?: string };

export async function fetchClawHubPromotionsFeed(
  params: {
    etag?: string;
    baseUrl?: string;
    timeoutMs?: number;
    fetchImpl?: ClawHubFetch;
  } = {},
): Promise<ClawHubPromotionsFeedFetchResult> {
  const { response, url } = await requestClawHub({
    baseUrl: params.baseUrl,
    path: "/api/v1/feeds/promotions",
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
    // This passive refresh runs inline from interactive commands. Its cache
    // cadence owns retries; shared backoff would turn the 2.5s cap into ~24s.
    retryTransientReads: false,
    // Public CDN-served snapshot; an Authorization header would only
    // fragment edge caches.
    skipAuth: true,
    ...(params.etag ? { headers: { "If-None-Match": params.etag } } : {}),
  });
  if (response.status === 304) {
    return { status: "not-modified" };
  }
  if (!response.ok) {
    throw await createClawHubError(response, url, false, params.timeoutMs);
  }
  const buffer = await readClawHubBytes({
    response,
    maxBytes: CLAWHUB_JSON_MAX_BYTES,
    timeoutMs: params.timeoutMs,
    resourceLabel: "promotions feed",
  });
  const payload = decodeClawHubResponseBody(buffer);
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(payload);
  } catch (cause) {
    throw new Error(`ClawHub ${url.pathname} returned malformed JSON`, { cause });
  }
  const feed = parseClawHubPromotionsFeed(parsedJson);
  const etag = response.headers.get("etag") ?? undefined;
  return { status: "ok", feed, payload, ...(etag ? { etag } : {}) };
}
