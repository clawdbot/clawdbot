// Qa Matrix plugin module records redacted Matrix protocol behavior.
import { createHash } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import {
  startMatrixQaFaultProxy,
  type MatrixQaFaultProxyExchange,
  type MatrixQaFaultProxyObserver,
} from "./fault-proxy.js";

const MATRIX_QA_RECORDING_PROFILE = "matrix-qa-v1";
const REDACTED_QUERY_VALUE = "[redacted]";

type MatrixQaStateFamily = "backup" | "device" | "key" | "media" | "sync-token";

type MatrixQaBodyShape =
  | { kind: "binary" }
  | { kind: "empty" }
  | { kind: "json"; fields: string[] }
  | { kind: "text" };

type MatrixQaRecordedExchange = {
  categories: MatrixQaStateFamily[];
  request: {
    body: MatrixQaBodyShape;
    method: string;
    query: Record<string, string>;
    route: string;
  };
  response: {
    body: MatrixQaBodyShape;
    errcode?: string;
    status: number;
  };
  scenarioId: string;
  sequence: number;
  sync?: {
    continuity?: boolean;
    nextBatch?: string;
    since?: string;
  };
};

type MatrixQaInternalRecordedExchange = MatrixQaRecordedExchange & {
  operationFingerprint: string;
};

type MatrixQaRouteExpectation = {
  count: number;
  method: string;
  route: string;
  statuses: number[];
};

type MatrixQaOrderingExpectation = {
  categories: MatrixQaStateFamily[];
  count: number;
  method: string;
  requestBody: MatrixQaBodyShape;
  responseBody: MatrixQaBodyShape;
  route: string;
  status: number;
};

type MatrixQaScenarioRouteStateExpectation = {
  errors: Array<{
    errcode?: string;
    method: string;
    route: string;
    status: number;
  }>;
  ordering: MatrixQaOrderingExpectation[];
  retries: Array<{
    attempts: number;
    kind: "retry";
    method: string;
    route: string;
    statuses: number[];
  }>;
  routes: MatrixQaRouteExpectation[];
  state: Record<MatrixQaStateFamily, string[]>;
  syncTokens: {
    continuityObserved: boolean;
    incrementalRequests: number;
    initialRequests: number;
    responseTokens: number;
  };
};

type MatrixQaRouteStateManifest = {
  generatedAt: string;
  phases: Record<string, MatrixQaScenarioRouteStateExpectation>;
  profile: {
    derivedFrom: "observed-request-response-traffic";
    id: typeof MATRIX_QA_RECORDING_PROFILE;
  };
  requestedProfile: string;
  scenarios: Record<string, MatrixQaScenarioRouteStateExpectation>;
  substrate: {
    id: string;
    version: string;
  };
};

export type MatrixQaRecordingProxy = MatrixQaFaultProxyObserver & {
  baseUrl: string;
  buildManifest(params: {
    generatedAt?: string;
    requestedProfile: string;
    scenarioIds: string[];
    substrate: MatrixQaRouteStateManifest["substrate"];
  }): MatrixQaRouteStateManifest;
  records(): MatrixQaRecordedExchange[];
  setScenarioId(scenarioId: string): void;
  stop(): Promise<void>;
};

function normalizeHeaderValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value.join(", ") : value;
}

function hasJsonContentType(headers: Headers | IncomingHttpHeaders) {
  const raw = headers instanceof Headers ? headers.get("content-type") : headers["content-type"];
  return (
    normalizeHeaderValue(raw ?? undefined)
      ?.toLowerCase()
      .includes("json") === true
  );
}

function normalizeJsonMapKey(key: string, prefix: string, route: string) {
  if (route.endsWith("/sync") && prefix === "rooms") {
    return key;
  }
  if (key.startsWith("!")) {
    return "{roomId}";
  }
  if (key.startsWith("@")) {
    return "{userId}";
  }
  if (key.startsWith("$")) {
    return "{eventId}";
  }
  if (route.endsWith("/keys/signatures/upload") && prefix === "") {
    return "{userId}";
  }
  if (route.endsWith("/keys/signatures/upload") && prefix === "{userId}") {
    return "{deviceOrKeyId}";
  }
  if (route.endsWith("/keys/upload") && prefix === "one_time_keys") {
    return "{keyId}";
  }
  if (/(?:^|\.)encrypted$/u.test(prefix)) {
    return "{keyId}";
  }
  if (prefix === "failures" && /\/keys\/(?:claim|query)$/u.test(route)) {
    return "{serverName}";
  }
  if (
    !route.endsWith("/keys/upload") &&
    /^(?:device_keys|master_keys|self_signing_keys|user_signing_keys)$/u.test(prefix)
  ) {
    return "{userId}";
  }
  if (/^(?:device_keys|devices|messages|one_time_keys)\.\{userId\}$/u.test(prefix)) {
    return "{deviceId}";
  }
  if (!route.endsWith("/keys/upload") && prefix === "one_time_keys") {
    return "{userId}";
  }
  if (
    /^(?:device_keys\.)?\{userId\}\.\{deviceId\}\.(?:fallback_keys|keys|one_time_keys)$/u.test(
      prefix,
    ) ||
    /^one_time_keys\.\{userId\}\.\{deviceId\}$/u.test(prefix) ||
    /^(?:ed25519|curve25519|signed_curve25519):/u.test(key)
  ) {
    return "{keyId}";
  }
  if (/(?:^|\.)rooms$/u.test(prefix)) {
    return "{roomId}";
  }
  if (/(?:^|\.)rooms\.\{roomId\}\.sessions$/u.test(prefix)) {
    return "{sessionId}";
  }
  return key;
}

function collectJsonFields(value: unknown, route: string, prefix = "", depth = 0): string[] {
  if (depth >= 8 || value === null || typeof value !== "object") {
    return [];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return prefix ? [`${prefix}[]`] : [];
    }
    const arrayPrefix = prefix ? `${prefix}[]` : "[]";
    return [
      ...new Set(value.flatMap((entry) => collectJsonFields(entry, route, arrayPrefix, depth + 1))),
    ].toSorted();
  }
  const fixedDeviceKeysObject =
    prefix === "device_keys" &&
    ["algorithms", "device_id", "keys", "signatures", "user_id"].some((key) => key in value);
  return Object.entries(value)
    .flatMap(([key, child]) => {
      const safeKey = fixedDeviceKeysObject ? key : normalizeJsonMapKey(key, prefix, route);
      const field = prefix ? `${prefix}.${safeKey}` : safeKey;
      if (
        /^(?:access_token|auth|body|ciphertext|content|file|formatted_body|password|recovery_key|session_data|token|unsigned)$/iu.test(
          key,
        )
      ) {
        return [field];
      }
      const nested = collectJsonFields(child, route, field, depth + 1);
      return nested.length > 0 ? nested : [field];
    })
    .toSorted();
}

function parseJsonBody(body: Buffer, headers: Headers | IncomingHttpHeaders): unknown {
  if (body.byteLength === 0) {
    return undefined;
  }
  const text = body.toString("utf8");
  const firstNonWhitespace = text.trimStart()[0];
  if (!hasJsonContentType(headers) && firstNonWhitespace !== "[" && firstNonWhitespace !== "{") {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

const MATRIX_QA_STATE_FIELD_MARKERS = new Set([
  "backup",
  "content_uri",
  "device_id",
  "device_keys",
  "device_lists",
  "device_one_time_keys_count",
  "device_unused_fallback_key_types",
  "mimetype",
  "one_time_key",
  "session_data",
]);

function collectStateFieldMarkers(value: unknown, depth = 0): string[] {
  if (depth >= 8 || value === null || typeof value !== "object") {
    return [];
  }
  if (Array.isArray(value)) {
    return [...new Set(value.flatMap((entry) => collectStateFieldMarkers(entry, depth + 1)))];
  }
  const markers = new Set<string>();
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    if (MATRIX_QA_STATE_FIELD_MARKERS.has(normalizedKey)) {
      markers.add(normalizedKey);
    }
    for (const marker of collectStateFieldMarkers(child, depth + 1)) {
      markers.add(marker);
    }
  }
  return [...markers];
}

function extractStateFieldMarkers(body: Buffer, headers: Headers | IncomingHttpHeaders) {
  const parsed = parseJsonBody(body, headers);
  return parsed === undefined ? [] : collectStateFieldMarkers(parsed);
}

function buildBodyShape(
  body: Buffer,
  headers: Headers | IncomingHttpHeaders,
  route: string,
): MatrixQaBodyShape {
  if (body.byteLength === 0) {
    return { kind: "empty" };
  }
  const parsed = parseJsonBody(body, headers);
  if (parsed !== undefined) {
    return { kind: "json", fields: collectJsonFields(parsed, route) };
  }
  const contentType =
    headers instanceof Headers
      ? headers.get("content-type")
      : normalizeHeaderValue(headers["content-type"]);
  return contentType?.toLowerCase().startsWith("text/") ? { kind: "text" } : { kind: "binary" };
}

function normalizeMatrixIdSegment(segment: string) {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return segment;
  }
  if (decoded.startsWith("!")) {
    return "{roomId}";
  }
  if (decoded.startsWith("@")) {
    return "{userId}";
  }
  if (decoded.startsWith("$")) {
    return "{eventId}";
  }
  if (decoded.startsWith("#")) {
    return "{roomAlias}";
  }
  return segment;
}

export function normalizeMatrixQaRoute(pathname: string) {
  const segments = pathname.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    const previous = segments[index - 1];
    const beforePrevious = segments[index - 2];
    if (previous === "rooms") {
      segments[index] = "{roomId}";
      continue;
    }
    if (previous === "profile" || previous === "user") {
      segments[index] = "{userId}";
      continue;
    }
    if (previous === "filter") {
      segments[index] = "{filterId}";
      continue;
    }
    if (previous === "join") {
      segments[index] = normalizeMatrixIdSegment(segments[index] ?? "");
      continue;
    }
    if (previous === "devices") {
      segments[index] = "{deviceId}";
      continue;
    }
    if (previous === "redact") {
      segments[index] = "{eventId}";
      continue;
    }
    if (beforePrevious === "send" || beforePrevious === "redact") {
      segments[index] = "{transactionId}";
      continue;
    }
    if (beforePrevious === "sendToDevice") {
      segments[index] = "{transactionId}";
      continue;
    }
    if (previous === "version" && beforePrevious === "room_keys") {
      segments[index] = "{backupVersion}";
      continue;
    }
    if (previous === "keys" && beforePrevious === "room_keys") {
      segments[index] = "{roomId}";
      continue;
    }
    if (segments[index - 2] === "keys" && segments[index - 3] === "room_keys") {
      segments[index] = "{sessionId}";
      continue;
    }
    if (segments[index - 2] === "state" && segments[index] !== "") {
      segments[index] = "{stateKey}";
      continue;
    }
    if (previous === "account_data" && segments[index]?.startsWith("m.secret_storage.key.")) {
      segments[index] = "m.secret_storage.key.{keyId}";
      continue;
    }
    const mediaActionIndex = segments.findIndex(
      (segment) => segment === "download" || segment === "thumbnail",
    );
    if (mediaActionIndex >= 0 && index === mediaActionIndex + 2) {
      segments[index] = "{mediaId}";
      segments[index - 1] = "{serverName}";
      continue;
    }
    if (mediaActionIndex >= 0 && index === mediaActionIndex + 3) {
      segments[index] = "{filename}";
      continue;
    }
    segments[index] = normalizeMatrixIdSegment(segments[index] ?? "");
  }
  return segments.join("/");
}

function buildRedactedQuery(search: string, syncTokens: Map<string, string>) {
  const result: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(search)) {
    if (key === "since") {
      result[key] = syncTokens.get(value) ?? "sync-unknown";
    } else if (key === "timeout" || key === "full_state" || key === "set_presence") {
      result[key] = value;
    } else {
      result[key] = REDACTED_QUERY_VALUE;
    }
  }
  return result;
}

function resolveStateFamilies(params: {
  requestFields: string[];
  responseFields: string[];
  route: string;
}) {
  const fields = [...params.requestFields, ...params.responseFields].join(" ").toLowerCase();
  const route = params.route.toLowerCase();
  const families = new Set<MatrixQaStateFamily>();
  if (route.includes("/sync")) {
    families.add("sync-token");
  }
  if (route.includes("/room_keys/") || fields.includes("backup")) {
    families.add("backup");
  }
  if (route.includes("/account_data/m.megolm_backup.")) {
    families.add("backup");
  }
  if (
    route.includes("/keys/") ||
    route.includes("/sendtodevice/") ||
    route.includes("/account_data/m.cross_signing.") ||
    route.includes("/account_data/m.secret_storage.") ||
    fields.includes("one_time_key") ||
    fields.includes("device_one_time_keys_count") ||
    fields.includes("device_unused_fallback_key_types") ||
    fields.includes("device_keys") ||
    fields.includes("session_data")
  ) {
    families.add("key");
  }
  if (
    route.includes("/devices") ||
    fields.includes("device_id") ||
    fields.includes("device_lists")
  ) {
    families.add("device");
  }
  if (route.includes("/media/") || fields.includes("content_uri") || fields.includes("mimetype")) {
    families.add("media");
  }
  return [...families].toSorted();
}

function buildExpectation(
  records: MatrixQaInternalRecordedExchange[],
): MatrixQaScenarioRouteStateExpectation {
  const orderedRecords = records.toSorted((left, right) => left.sequence - right.sequence);
  const routeGroups = new Map<string, MatrixQaRouteExpectation>();
  const ordering: MatrixQaOrderingExpectation[] = [];
  const state = {
    backup: new Set<string>(),
    device: new Set<string>(),
    key: new Set<string>(),
    media: new Set<string>(),
    "sync-token": new Set<string>(),
  } satisfies Record<MatrixQaStateFamily, Set<string>>;

  for (const record of orderedRecords) {
    const routeKey = `${record.request.method} ${record.request.route}`;
    const route = routeGroups.get(routeKey) ?? {
      count: 0,
      method: record.request.method,
      route: record.request.route,
      statuses: [],
    };
    route.count += 1;
    if (!route.statuses.includes(record.response.status)) {
      route.statuses.push(record.response.status);
      route.statuses.sort((left, right) => left - right);
    }
    routeGroups.set(routeKey, route);
    for (const category of record.categories) {
      state[category].add(record.request.route);
    }
    const previous = ordering.at(-1);
    if (
      previous?.method === record.request.method &&
      previous.route === record.request.route &&
      previous.status === record.response.status &&
      JSON.stringify(previous.requestBody) === JSON.stringify(record.request.body) &&
      JSON.stringify(previous.responseBody) === JSON.stringify(record.response.body) &&
      previous.categories.join("\0") === record.categories.join("\0")
    ) {
      previous.count += 1;
    } else {
      ordering.push({
        categories: record.categories,
        count: 1,
        method: record.request.method,
        requestBody: record.request.body,
        responseBody: record.response.body,
        route: record.request.route,
        status: record.response.status,
      });
    }
  }

  const routes = [...routeGroups.values()].toSorted((left, right) =>
    `${left.method} ${left.route}`.localeCompare(`${right.method} ${right.route}`),
  );
  const retries: MatrixQaScenarioRouteStateExpectation["retries"] = [];
  const adjacentOperationRuns: MatrixQaInternalRecordedExchange[][] = [];
  for (const record of orderedRecords) {
    const currentRun = adjacentOperationRuns.at(-1);
    if (currentRun?.[0]?.operationFingerprint === record.operationFingerprint) {
      currentRun.push(record);
    } else {
      adjacentOperationRuns.push([record]);
    }
  }
  for (const attempts of adjacentOperationRuns) {
    if (attempts[0]?.request.route.endsWith("/sync")) {
      continue;
    }
    for (let index = 0; index < attempts.length; index += 1) {
      const first = attempts[index];
      if (!first || first.response.status < 400) {
        continue;
      }
      const recoveryOffset = attempts
        .slice(index + 1)
        .findIndex((attempt) => attempt.response.status < 400);
      const retryEndIndex = recoveryOffset < 0 ? attempts.length : index + recoveryOffset + 2;
      const retryAttempts = attempts.slice(index, retryEndIndex);
      if (retryAttempts.length < 2) {
        continue;
      }
      retries.push({
        attempts: retryAttempts.length,
        kind: "retry",
        method: first.request.method,
        route: first.request.route,
        statuses: retryAttempts.map((attempt) => attempt.response.status),
      });
      index = retryEndIndex - 1;
    }
  }
  const incrementalSyncRecords = orderedRecords.filter(
    (record) => record.sync?.since !== undefined,
  );
  return {
    errors: orderedRecords
      .filter((record) => record.response.status >= 400)
      .map((record) => {
        const error: MatrixQaScenarioRouteStateExpectation["errors"][number] = {
          method: record.request.method,
          route: record.request.route,
          status: record.response.status,
        };
        if (record.response.errcode) {
          error.errcode = record.response.errcode;
        }
        return error;
      }),
    ordering,
    retries,
    routes,
    state: Object.fromEntries(
      Object.entries(state).map(([key, values]) => [key, [...values].toSorted()]),
    ) as Record<MatrixQaStateFamily, string[]>,
    syncTokens: {
      continuityObserved:
        incrementalSyncRecords.length > 0 &&
        incrementalSyncRecords.every((record) => record.sync?.continuity === true),
      incrementalRequests: incrementalSyncRecords.length,
      initialRequests: orderedRecords.filter(
        (record) => record.categories.includes("sync-token") && record.sync?.since === undefined,
      ).length,
      responseTokens: orderedRecords.filter((record) => record.sync?.nextBatch !== undefined)
        .length,
    },
  };
}

function extractErrcode(body: Buffer, headers: Headers) {
  const parsed = parseJsonBody(body, headers);
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const errcode = (parsed as { errcode?: unknown }).errcode;
  return typeof errcode === "string" ? errcode : undefined;
}

function extractNextBatch(body: Buffer, headers: Headers) {
  const parsed = parseJsonBody(body, headers);
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const nextBatch = (parsed as { next_batch?: unknown }).next_batch;
  return typeof nextBatch === "string" ? nextBatch : undefined;
}

export async function startMatrixQaRecordingProxy(params: {
  targetBaseUrl: string;
}): Promise<MatrixQaRecordingProxy> {
  let scenarioId = "setup";
  let sequence = 0;
  const records: MatrixQaInternalRecordedExchange[] = [];
  const syncTokensByPrincipal = new Map<string, Map<string, string>>();
  const observer: Required<MatrixQaFaultProxyObserver> = {
    createExchangeContext: () => ({ scenarioId, sequence: ++sequence }),
    onExchange(exchange: MatrixQaFaultProxyExchange) {
      recordExchange(exchange);
    },
  };
  const recordExchange = (exchange: MatrixQaFaultProxyExchange) => {
    const context =
      typeof exchange.context === "object" && exchange.context !== null
        ? (exchange.context as { scenarioId?: unknown; sequence?: unknown })
        : undefined;
    const exchangeSequence = typeof context?.sequence === "number" ? context.sequence : ++sequence;
    const route = normalizeMatrixQaRoute(exchange.request.path);
    const exchangeScenarioId = route.endsWith("/sync")
      ? scenarioId
      : typeof context?.scenarioId === "string"
        ? context.scenarioId
        : "unattributed";
    const requestBody = buildBodyShape(exchange.request.body, exchange.request.headers, route);
    const responseBody = buildBodyShape(exchange.response.body, exchange.response.headers, route);
    const requestFields = extractStateFieldMarkers(exchange.request.body, exchange.request.headers);
    const responseFields = extractStateFieldMarkers(
      exchange.response.body,
      exchange.response.headers,
    );
    const syncPrincipal = exchange.request.bearerToken ?? "anonymous";
    const syncTokens = syncTokensByPrincipal.get(syncPrincipal) ?? new Map<string, string>();
    syncTokensByPrincipal.set(syncPrincipal, syncTokens);
    const sinceRaw = new URLSearchParams(exchange.request.search).get("since") ?? undefined;
    const since = sinceRaw ? (syncTokens.get(sinceRaw) ?? "sync-unknown") : undefined;
    const nextBatch = extractNextBatch(exchange.response.body, exchange.response.headers);
    if (nextBatch && !syncTokens.has(nextBatch)) {
      syncTokens.set(nextBatch, `sync-${syncTokens.size + 1}`);
    }
    const nextBatchAlias = nextBatch ? syncTokens.get(nextBatch) : undefined;
    const responseErrcode = extractErrcode(exchange.response.body, exchange.response.headers);
    const operationFingerprint = createHash("sha256")
      .update(exchange.request.method)
      .update("\0")
      .update(exchange.request.path)
      .update("\0")
      .update(exchange.request.search)
      .update("\0")
      .update(exchange.request.body)
      .update("\0")
      .update(exchange.request.bearerToken ?? "anonymous")
      .digest("hex");
    records.push({
      categories: resolveStateFamilies({ requestFields, responseFields, route }),
      request: {
        body: requestBody,
        method: exchange.request.method,
        query: buildRedactedQuery(exchange.request.search, syncTokens),
        route,
      },
      response: {
        body: responseBody,
        ...(responseErrcode ? { errcode: responseErrcode } : {}),
        status: exchange.response.status,
      },
      scenarioId: exchangeScenarioId,
      sequence: exchangeSequence,
      operationFingerprint,
      ...(route.endsWith("/sync")
        ? {
            sync: {
              ...(since ? { since } : {}),
              ...(nextBatchAlias ? { nextBatch: nextBatchAlias } : {}),
              ...(since && nextBatchAlias ? { continuity: since !== "sync-unknown" } : {}),
            },
          }
        : {}),
    });
  };
  const proxy = await startMatrixQaFaultProxy({
    targetBaseUrl: params.targetBaseUrl,
    rules: [],
    ...observer,
  });

  return {
    baseUrl: proxy.baseUrl,
    ...observer,
    buildManifest({ generatedAt, requestedProfile, scenarioIds, substrate }) {
      const selectedIds = new Set(scenarioIds);
      const byScenario = new Map<string, MatrixQaInternalRecordedExchange[]>();
      for (const record of records) {
        const entries = byScenario.get(record.scenarioId) ?? [];
        entries.push(record);
        byScenario.set(record.scenarioId, entries);
      }
      const scenarios = Object.fromEntries(
        scenarioIds.map((id) => [id, buildExpectation(byScenario.get(id) ?? [])]),
      );
      const phases = Object.fromEntries(
        [...byScenario.entries()]
          .filter(([id]) => !selectedIds.has(id))
          .toSorted(([left], [right]) => left.localeCompare(right))
          .map(([id, entries]) => [id, buildExpectation(entries)]),
      );
      return {
        generatedAt: generatedAt ?? new Date().toISOString(),
        phases,
        profile: {
          derivedFrom: "observed-request-response-traffic",
          id: MATRIX_QA_RECORDING_PROFILE,
        },
        requestedProfile,
        scenarios,
        substrate,
      };
    },
    records: () =>
      structuredClone(
        records
          .toSorted((left, right) => left.sequence - right.sequence)
          .map(({ operationFingerprint: _operationFingerprint, ...record }) => record),
      ),
    setScenarioId(nextScenarioId) {
      scenarioId = nextScenarioId;
    },
    stop: () => proxy.stop(),
  };
}
