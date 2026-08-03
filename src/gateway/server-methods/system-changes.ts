// Reads the bounded system/config journals as one admin-facing change history.
import {
  ErrorCodes,
  errorShape,
  validateSystemChangesListParams,
  type SystemChangeEntry,
  type SystemChangesListParams,
  type SystemChangesListResult,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  CONFIG_AUDIT_MAX_ENTRIES,
  CONFIG_AUDIT_SCOPE,
  type ConfigAuditRecord,
} from "../../config/io.audit.js";
import { consumeRootOptionToken, FLAG_TERMINATOR } from "../../infra/cli-root-options.js";
import {
  createSqliteAuditRecordStore,
  type SequencedSqliteAuditRecordEntry,
} from "../../infra/sqlite-audit-record-store.js";
import {
  SYSTEM_AGENT_AUDIT_MAX_ENTRIES,
  SYSTEM_AGENT_AUDIT_SCOPE,
  type SystemAgentAuditEntry,
} from "../../system-agent/audit.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

const DEFAULT_CHANGE_LIMIT = 50;
const MAX_CHANGE_LIMIT = 200;
const CHANGE_SCAN_BATCH_SIZE = MAX_CHANGE_LIMIT + 1;
export const SYSTEM_CHANGE_MAX_RAW_SCAN_PER_SCOPE = 1_000;
const COLLAPSE_MAX_DELAY_MS = 60_000;
const MAX_PENDING_COLLAPSES = MAX_CHANGE_LIMIT;

type PendingCollapse = {
  transition: string;
  maxConfigSequence: number;
  operationAt: number;
};

type ChangeCursor = {
  version: 1;
  systemAgentBefore: number;
  configBefore: number;
  pendingCollapse?: PendingCollapse[];
};

type ChangeScope = typeof SYSTEM_AGENT_AUDIT_SCOPE | typeof CONFIG_AUDIT_SCOPE;

type ChangeCandidate = {
  entry: SystemChangeEntry;
  recordedAt: number;
  transition?: string;
  pendingCollapse?: PendingCollapse;
  positions: Array<{ scope: ChangeScope; sequence: number }>;
};

type EligibleScan<T> = {
  entries: SequencedSqliteAuditRecordEntry<T>[];
  exhausted: boolean;
  nextBeforeSequence: number;
};

type AuditStore<T> = {
  latest: (params: {
    limit: number;
    beforeSequence?: number;
  }) => SequencedSqliteAuditRecordEntry<T>[];
};

function encodeCursor(cursor: ChangeCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): ChangeCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid change-history cursor");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as { version?: unknown }).version !== 1 ||
    !Number.isSafeInteger((parsed as { systemAgentBefore?: unknown }).systemAgentBefore) ||
    !Number.isSafeInteger((parsed as { configBefore?: unknown }).configBefore) ||
    !isValidPendingCollapses((parsed as { pendingCollapse?: unknown }).pendingCollapse)
  ) {
    throw new Error("invalid change-history cursor");
  }
  return parsed as ChangeCursor;
}

function isValidPendingCollapses(value: unknown): value is PendingCollapse[] | undefined {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.length <= MAX_PENDING_COLLAPSES &&
      value.every(
        (marker) =>
          marker !== null &&
          typeof marker === "object" &&
          typeof (marker as PendingCollapse).transition === "string" &&
          (marker as PendingCollapse).transition.length <= 512 &&
          Number.isSafeInteger((marker as PendingCollapse).maxConfigSequence) &&
          Number.isSafeInteger((marker as PendingCollapse).operationAt),
      ))
  );
}

function transitionKey(before: string | null | undefined, after: string | null | undefined) {
  if (before === after || (before == null && after == null)) {
    return undefined;
  }
  return JSON.stringify([before ?? null, after ?? null]);
}

function recordTime(value: string, fallback: number): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : fallback;
}

function classifyConfigWriteSource(record: Extract<ConfigAuditRecord, { event: "config.write" }>) {
  if (record.origin) {
    return record.origin;
  }
  const launcherIndex = record.argv.findIndex((arg) =>
    /(?:^|[/\\])openclaw(?:\.m?js)?$/i.test(arg),
  );
  let command: string | undefined;
  if (launcherIndex >= 0) {
    for (let index = launcherIndex + 1; index < record.argv.length; index += 1) {
      const consumed = consumeRootOptionToken(record.argv, index);
      if (consumed > 0) {
        index += consumed - 1;
        continue;
      }
      if (record.argv[index] === FLAG_TERMINATOR) {
        command = record.argv[index + 1];
        break;
      }
      if (!record.argv[index]?.startsWith("-")) {
        command = record.argv[index];
        break;
      }
    }
  }
  if (command === "doctor") {
    return "doctor" as const;
  }
  if (command === "config") {
    return "cli" as const;
  }
  return "unknown" as const;
}

function summarizePaths(prefix: string, changedPaths: readonly string[] | undefined): string {
  if (!changedPaths || changedPaths.length === 0) {
    return prefix;
  }
  return `${prefix}: ${changedPaths.join(", ")}`;
}

function configWriteSummary(
  source: SystemChangeEntry["source"],
  changedPaths: readonly string[] | undefined,
): string {
  const prefix =
    source === "doctor"
      ? "Doctor updated configuration"
      : source === "config-rpc"
        ? "Settings updated configuration"
        : source === "plugin-install"
          ? "Plugin installation updated configuration"
          : source === "system-agent"
            ? "OpenClaw updated configuration"
            : source === "cli"
              ? "CLI updated configuration"
              : "Configuration updated";
  return summarizePaths(prefix, changedPaths);
}

function toSystemAgentCandidate(
  record: SequencedSqliteAuditRecordEntry<SystemAgentAuditEntry>,
): ChangeCandidate {
  return {
    entry: {
      id: `${SYSTEM_AGENT_AUDIT_SCOPE}:${record.sequence}`,
      at: recordTime(record.value.timestamp, record.createdAt),
      kind: "operation",
      source: "system-agent",
      summary: record.value.summary,
    },
    transition: transitionKey(record.value.configHashBefore, record.value.configHashAfter),
    recordedAt: record.createdAt,
    positions: [{ scope: SYSTEM_AGENT_AUDIT_SCOPE, sequence: record.sequence }],
  };
}

function toConfigCandidate(
  record: SequencedSqliteAuditRecordEntry<ConfigAuditRecord>,
): ChangeCandidate | null {
  const value = record.value;
  if (value.event === "config.observe") {
    return null;
  }
  if (value.event === "config.external") {
    const changedPaths = value.changedPaths?.length ? value.changedPaths : undefined;
    return {
      entry: {
        id: `${CONFIG_AUDIT_SCOPE}:${record.sequence}`,
        at: recordTime(value.ts, record.createdAt),
        kind: "external-edit",
        source: "external",
        summary: summarizePaths("Configuration edited outside OpenClaw", changedPaths),
        ...(changedPaths ? { changedPaths } : {}),
        ...(!value.valid ? { invalid: true } : {}),
        ...(value.opaqueChange ? { opaqueChange: true } : {}),
      },
      transition: transitionKey(value.previousHash, value.nextHash),
      recordedAt: record.createdAt,
      positions: [{ scope: CONFIG_AUDIT_SCOPE, sequence: record.sequence }],
    };
  }
  if (value.result !== "rename" && value.result !== "copy-fallback") {
    return null;
  }
  const changedPaths = value.changedPaths?.length ? value.changedPaths : undefined;
  const source = classifyConfigWriteSource(value);
  return {
    entry: {
      id: `${CONFIG_AUDIT_SCOPE}:${record.sequence}`,
      at: recordTime(value.ts, record.createdAt),
      kind: "config-write",
      source,
      summary: configWriteSummary(source, changedPaths),
      ...(changedPaths ? { changedPaths } : {}),
    },
    transition: transitionKey(value.previousHash, value.nextHash),
    recordedAt: record.createdAt,
    positions: [{ scope: CONFIG_AUDIT_SCOPE, sequence: record.sequence }],
  };
}

function scanEligible<T>(params: {
  beforeSequence: number;
  target: number;
  latest: (params: {
    limit: number;
    beforeSequence?: number;
  }) => SequencedSqliteAuditRecordEntry<T>[];
  include: (entry: SequencedSqliteAuditRecordEntry<T>) => boolean;
}): EligibleScan<T> {
  const entries: SequencedSqliteAuditRecordEntry<T>[] = [];
  let beforeSequence = params.beforeSequence;
  let exhausted = false;
  let loadedRawEntries = 0;
  // Journal history is served on the gateway event loop. Bound each scope even
  // when nearly every retained row is an ineligible observation or failed write.
  while (
    entries.length < params.target &&
    loadedRawEntries < SYSTEM_CHANGE_MAX_RAW_SCAN_PER_SCOPE
  ) {
    const pageLimit = Math.min(
      CHANGE_SCAN_BATCH_SIZE,
      SYSTEM_CHANGE_MAX_RAW_SCAN_PER_SCOPE - loadedRawEntries,
    );
    const page = params.latest({
      limit: pageLimit,
      beforeSequence,
    });
    if (page.length === 0) {
      exhausted = true;
      break;
    }
    loadedRawEntries += page.length;
    let stoppedAt = -1;
    for (let index = 0; index < page.length; index += 1) {
      const entry = page[index]!;
      // The cursor tracks every scanned raw row, including filtered records.
      beforeSequence = entry.sequence;
      if (params.include(entry)) {
        entries.push(entry);
        if (entries.length >= params.target) {
          stoppedAt = index;
          break;
        }
      }
    }
    if (entries.length >= params.target) {
      exhausted = stoppedAt === page.length - 1 && page.length < pageLimit;
      break;
    }
    if (page.length < pageLimit) {
      exhausted = true;
      break;
    }
  }
  return {
    entries,
    exhausted,
    nextBeforeSequence: entries.at(-1)?.sequence ?? beforeSequence,
  };
}

function planConfigMatches(
  systemCandidates: ChangeCandidate[],
  configCandidates: ChangeCandidate[],
): ReadonlyMap<ChangeCandidate, ChangeCandidate> {
  const configByTransition = new Map<string, ChangeCandidate[]>();
  for (const candidate of configCandidates) {
    if (
      !candidate.transition ||
      candidate.entry.kind !== "config-write" ||
      candidate.entry.source !== "system-agent"
    ) {
      continue;
    }
    const matches = configByTransition.get(candidate.transition) ?? [];
    matches.push(candidate);
    configByTransition.set(candidate.transition, matches);
  }

  const planned = new Map<ChangeCandidate, ChangeCandidate>();
  const usedConfig = new Set<ChangeCandidate>();
  let lastMatchedConfigSequence = Number.POSITIVE_INFINITY;
  for (const operation of systemCandidates) {
    if (!operation.transition) {
      continue;
    }
    const write = configByTransition
      .get(operation.transition)
      ?.filter((candidate) => {
        const configSequence = candidate.positions[0]!.sequence;
        return (
          !usedConfig.has(candidate) &&
          configSequence < lastMatchedConfigSequence &&
          isWithinCollapseWindow(operation.entry.at, candidate.entry.at)
        );
      })
      .toSorted((left, right) => right.recordedAt - left.recordedAt)[0];
    if (!write) {
      continue;
    }
    planned.set(operation, write);
    usedConfig.add(write);
    lastMatchedConfigSequence = write.positions[0]!.sequence;
  }
  return planned;
}

function compareCandidates(left: ChangeCandidate, right: ChangeCandidate): number {
  // History is insertion-ordered; display time may differ if a producer's clock skewed.
  if (left.recordedAt !== right.recordedAt) {
    return right.recordedAt - left.recordedAt;
  }
  const scopeOrder = right.positions[0]!.scope.localeCompare(left.positions[0]!.scope);
  if (scopeOrder !== 0) {
    return scopeOrder;
  }
  return right.positions[0]!.sequence - left.positions[0]!.sequence;
}

function isWithinCollapseWindow(operationAt: number, configAt: number): boolean {
  const delay = operationAt - configAt;
  return delay >= 0 && delay <= COLLAPSE_MAX_DELAY_MS;
}

function appendPendingCollapse(
  pending: readonly PendingCollapse[],
  marker: PendingCollapse,
): PendingCollapse[] {
  const next = [...pending, marker];
  // Keep the cursor bounded. A dropped marker can reveal a rare duplicate
  // config-write row, but never hides a newer visible history entry.
  return next.length <= MAX_PENDING_COLLAPSES ? next : next.slice(-MAX_PENDING_COLLAPSES);
}

function consumePendingCollapse(
  pending: readonly PendingCollapse[],
  candidate: ChangeCandidate,
): { pending: PendingCollapse[]; suppressed: boolean } {
  if (
    candidate.entry.kind !== "config-write" ||
    candidate.entry.source !== "system-agent" ||
    !candidate.transition
  ) {
    return { pending: [...pending], suppressed: false };
  }
  const sequence = candidate.positions[0]!.sequence;
  let markerIndex = -1;
  let markerSequence = Number.POSITIVE_INFINITY;
  for (let index = 0; index < pending.length; index += 1) {
    const marker = pending[index]!;
    if (
      marker.transition === candidate.transition &&
      sequence <= marker.maxConfigSequence &&
      isWithinCollapseWindow(marker.operationAt, candidate.entry.at) &&
      marker.maxConfigSequence < markerSequence
    ) {
      markerIndex = index;
      markerSequence = marker.maxConfigSequence;
    }
  }
  if (markerIndex < 0) {
    return { pending: [...pending], suppressed: false };
  }
  return {
    pending: pending.filter((_, index) => index !== markerIndex),
    suppressed: true,
  };
}

function mergeCandidates(params: {
  systemCandidates: ChangeCandidate[];
  configCandidates: ChangeCandidate[];
  pendingCollapse: readonly PendingCollapse[];
  limit: number;
}): {
  entries: ChangeCandidate[];
  systemBefore?: number;
  configBefore?: number;
  pendingCollapse: PendingCollapse[];
  hasBufferedEntries: boolean;
  hasBufferedSystemEntries: boolean;
  hasBufferedConfigEntries: boolean;
} {
  let systemIndex = 0;
  let configIndex = 0;
  let systemBefore: number | undefined;
  let configBefore: number | undefined;
  let pendingCollapse = [...params.pendingCollapse];
  const entries: ChangeCandidate[] = [];

  while (true) {
    const system = params.systemCandidates[systemIndex];
    const config = params.configCandidates[configIndex];
    const next =
      system && config
        ? compareCandidates(system, config) <= 0
          ? system
          : config
        : (system ?? config);
    if (!next) {
      break;
    }

    if (next === config) {
      const collapse = consumePendingCollapse(pendingCollapse, config);
      pendingCollapse = collapse.pending;
      if (collapse.suppressed) {
        configBefore = config.positions[0]!.sequence;
        configIndex += 1;
        continue;
      }
    }
    if (entries.length >= params.limit) {
      break;
    }

    entries.push(next);
    if (next === system) {
      systemBefore = system.positions[0]!.sequence;
      systemIndex += 1;
      if (system.pendingCollapse) {
        pendingCollapse = appendPendingCollapse(pendingCollapse, system.pendingCollapse);
      }
    } else {
      configBefore = config!.positions[0]!.sequence;
      configIndex += 1;
    }
  }

  return {
    entries,
    systemBefore,
    configBefore,
    pendingCollapse,
    hasBufferedEntries:
      systemIndex < params.systemCandidates.length || configIndex < params.configCandidates.length,
    hasBufferedSystemEntries: systemIndex < params.systemCandidates.length,
    hasBufferedConfigEntries: configIndex < params.configCandidates.length,
  };
}

function initialBefore<T>(
  latest: (params: { limit: number }) => SequencedSqliteAuditRecordEntry<T>[],
): number {
  const sequence = latest({ limit: 1 })[0]?.sequence;
  return sequence === undefined ? 0 : sequence + 1;
}

export function listSystemChanges(
  params: SystemChangesListParams,
  options: {
    env?: NodeJS.ProcessEnv;
    systemStore?: AuditStore<SystemAgentAuditEntry>;
    configStore?: AuditStore<ConfigAuditRecord>;
  } = {},
): SystemChangesListResult {
  const env = options.env ?? process.env;
  const systemStore =
    options.systemStore ??
    createSqliteAuditRecordStore<SystemAgentAuditEntry>({
      scope: SYSTEM_AGENT_AUDIT_SCOPE,
      maxEntries: SYSTEM_AGENT_AUDIT_MAX_ENTRIES,
      env,
    });
  const configStore =
    options.configStore ??
    createSqliteAuditRecordStore<ConfigAuditRecord>({
      scope: CONFIG_AUDIT_SCOPE,
      maxEntries: CONFIG_AUDIT_MAX_ENTRIES,
      env,
    });
  const cursor = params.beforeCursor
    ? decodeCursor(params.beforeCursor)
    : {
        version: 1 as const,
        // Freeze both journal heads before scanning so page two cannot admit a
        // record inserted into the untouched scope after page one was read.
        systemAgentBefore: initialBefore(systemStore.latest),
        configBefore: initialBefore(configStore.latest),
      };
  const limit = Math.min(MAX_CHANGE_LIMIT, Math.max(1, params.limit ?? DEFAULT_CHANGE_LIMIT));
  const target = limit + 1;
  const systemScan = scanEligible({
    beforeSequence: cursor.systemAgentBefore,
    target,
    latest: systemStore.latest,
    include: () => true,
  });
  const configScan = scanEligible({
    beforeSequence: cursor.configBefore,
    target,
    latest: configStore.latest,
    include: (entry) => toConfigCandidate(entry) !== null,
  });
  const systemCandidates = systemScan.entries.map(toSystemAgentCandidate);
  const configCandidates = configScan.entries.flatMap((entry) => {
    const candidate = toConfigCandidate(entry);
    return candidate ? [candidate] : [];
  });
  // A visible write can enrich the operation immediately. Its cursor position
  // stays in the config stream and is suppressed only when that stream reaches it.
  const plannedMatches = planConfigMatches(systemCandidates, configCandidates);
  const unseenConfigMaxSequence = configScan.exhausted
    ? undefined
    : configScan.nextBeforeSequence - 1;
  for (const operation of systemCandidates) {
    if (!operation.transition) {
      continue;
    }
    const write = plannedMatches.get(operation);
    if (write) {
      operation.pendingCollapse = {
        transition: operation.transition,
        maxConfigSequence: write.positions[0]!.sequence,
        operationAt: operation.entry.at,
      };
      if (write.entry.changedPaths?.length) {
        operation.entry.changedPaths = [...write.entry.changedPaths];
      }
    } else if (unseenConfigMaxSequence !== undefined) {
      operation.pendingCollapse = {
        transition: operation.transition,
        maxConfigSequence: unseenConfigMaxSequence,
        operationAt: operation.entry.at,
      };
    }
  }
  const merged = mergeCandidates({
    systemCandidates,
    configCandidates,
    pendingCollapse: cursor.pendingCollapse ?? [],
    limit,
  });
  // Payload timestamps can move backwards, so only discard markers after every
  // remaining config record has passed the cursor and none was a partner.
  const pendingCollapse =
    configScan.exhausted && !merged.hasBufferedConfigEntries ? [] : merged.pendingCollapse;
  const next = { ...cursor };
  if (!merged.hasBufferedSystemEntries) {
    next.systemAgentBefore = systemScan.nextBeforeSequence;
  } else if (merged.systemBefore !== undefined) {
    next.systemAgentBefore = merged.systemBefore;
  }
  if (!merged.hasBufferedConfigEntries) {
    next.configBefore = configScan.nextBeforeSequence;
  } else if (merged.configBefore !== undefined) {
    next.configBefore = merged.configBefore;
  }
  if (pendingCollapse.length > 0) {
    next.pendingCollapse = pendingCollapse;
  } else {
    delete next.pendingCollapse;
  }
  const hasMore =
    merged.hasBufferedEntries ||
    pendingCollapse.length > 0 ||
    !systemScan.exhausted ||
    !configScan.exhausted;
  const scanAdvanced =
    next.systemAgentBefore !== cursor.systemAgentBefore ||
    next.configBefore !== cursor.configBefore;
  return {
    entries: merged.entries.map((candidate) => candidate.entry),
    ...(hasMore && (merged.entries.length > 0 || scanAdvanced)
      ? { nextCursor: encodeCursor(next) }
      : {}),
  };
}

export const systemChangesHandlers: GatewayRequestHandlers = {
  "openclaw.changes.list": ({ params, respond }) => {
    if (
      !assertValidParams(params, validateSystemChangesListParams, "openclaw.changes.list", respond)
    ) {
      return;
    }
    try {
      respond(true, listSystemChanges(params));
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          error instanceof Error ? error.message : "invalid change-history cursor",
        ),
      );
    }
  },
};
