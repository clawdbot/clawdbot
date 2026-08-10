import { isDeepStrictEqual, types } from "node:util";
import {
  MAX_MODEL_TRANSPORT_ATTEMPTS,
  MAX_MODEL_TRANSPORT_EVENTS,
  MAX_MODEL_TRANSPORT_INVOCATIONS,
  MAX_MODEL_TRANSPORT_LOGICAL_CALLS,
} from "./provider-transport-accounting-limits.js";
import { createProviderTransportAccountingCollector } from "./provider-transport-accounting.js";
import { PROVIDER_TRANSPORT_ACCOUNTING_COVERAGE_REASONS } from "./provider-transport-accounting.types.js";
import type {
  ProviderTransportAccountingCoverage,
  ProviderTransportAccountingCoverageReason,
  ProviderTransportAccountingSnapshot,
} from "./provider-transport-accounting.types.js";

const MAX_AUDIT_ARRAY_LENGTH = 256;
const MAX_AUDIT_DEPTH = 24;
const MAX_AUDIT_NODES = 4_096;
const MAX_AUDIT_BYTES = 512 * 1024;

type ProviderTransportAccountingAudit = {
  snapshot?: ProviderTransportAccountingSnapshot;
  coverage?: ProviderTransportAccountingCoverage;
  truncated: boolean;
};

function readOwnDataProperty(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function readArrayLength(value: unknown): number | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const descriptor = Reflect.getOwnPropertyDescriptor(value, "length");
  return descriptor && "value" in descriptor && Number.isSafeInteger(descriptor.value)
    ? descriptor.value
    : undefined;
}

function observeTransportTruncation(snapshot: unknown): boolean {
  const logicalCalls = readOwnDataProperty(snapshot, "logicalCalls");
  const attempts = readOwnDataProperty(snapshot, "attempts");
  const invocations = readOwnDataProperty(snapshot, "invocations");
  const events = readOwnDataProperty(snapshot, "events");
  return (
    readOwnDataProperty(logicalCalls, "entriesTruncated") === true ||
    (readArrayLength(readOwnDataProperty(logicalCalls, "entries")) ?? 0) >
      MAX_MODEL_TRANSPORT_LOGICAL_CALLS ||
    readOwnDataProperty(attempts, "entriesTruncated") === true ||
    (readArrayLength(readOwnDataProperty(attempts, "entries")) ?? 0) >
      MAX_MODEL_TRANSPORT_ATTEMPTS ||
    readOwnDataProperty(invocations, "entriesTruncated") === true ||
    (readArrayLength(readOwnDataProperty(invocations, "entries")) ?? 0) >
      MAX_MODEL_TRANSPORT_INVOCATIONS ||
    readOwnDataProperty(events, "entriesTruncated") === true ||
    (readArrayLength(readOwnDataProperty(events, "entries")) ?? 0) > MAX_MODEL_TRANSPORT_EVENTS
  );
}

function normalizeBoundedPlainData(value: unknown): unknown {
  const state = {
    bytes: 0,
    nodes: 0,
    stack: new WeakSet<object>(),
  };
  const charge = (bytes: number): boolean => {
    state.bytes += bytes;
    return state.bytes <= MAX_AUDIT_BYTES;
  };
  const visit = (candidate: unknown, depth: number): unknown => {
    state.nodes += 1;
    if (state.nodes > MAX_AUDIT_NODES || depth > MAX_AUDIT_DEPTH) {
      return undefined;
    }
    if (candidate === null || typeof candidate === "boolean") {
      return charge(candidate === null ? 4 : candidate ? 4 : 5) ? candidate : undefined;
    }
    if (typeof candidate === "number") {
      return Number.isFinite(candidate) && charge(String(candidate).length) ? candidate : undefined;
    }
    if (typeof candidate === "string") {
      return charge(Buffer.byteLength(candidate, "utf8") + 2) ? candidate : undefined;
    }
    if (
      !candidate ||
      typeof candidate !== "object" ||
      types.isProxy(candidate) ||
      state.stack.has(candidate)
    ) {
      return undefined;
    }
    const prototype = Reflect.getPrototypeOf(candidate);
    state.stack.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        const length = readArrayLength(candidate);
        if (
          prototype !== Array.prototype ||
          length === undefined ||
          length > MAX_AUDIT_ARRAY_LENGTH ||
          !charge(2)
        ) {
          return undefined;
        }
        const descriptors = Object.getOwnPropertyDescriptors(candidate);
        const keys = Reflect.ownKeys(candidate);
        if (keys.length !== length + 1 || keys.at(-1) !== "length") {
          return undefined;
        }
        const copy: unknown[] = [];
        for (let index = 0; index < length; index += 1) {
          const key = String(index);
          const descriptor = descriptors[key];
          if (
            keys[index] !== key ||
            !descriptor ||
            !descriptor.enumerable ||
            !("value" in descriptor) ||
            !charge(index === 0 ? 0 : 1)
          ) {
            return undefined;
          }
          const item = visit(descriptor.value, depth + 1);
          if (item === undefined) {
            return undefined;
          }
          copy.push(item);
        }
        return copy;
      }
      if (prototype !== Object.prototype && prototype !== null) {
        return undefined;
      }
      const descriptors = Object.getOwnPropertyDescriptors(candidate);
      const keys = Reflect.ownKeys(candidate);
      if (keys.some((key) => typeof key !== "string") || !charge(2)) {
        return undefined;
      }
      const copy: Record<string, unknown> = {};
      for (const [index, key] of (keys as string[]).entries()) {
        const descriptor = descriptors[key];
        if (
          !descriptor ||
          !descriptor.enumerable ||
          !("value" in descriptor) ||
          !charge((index === 0 ? 0 : 1) + Buffer.byteLength(key, "utf8") + 3)
        ) {
          return undefined;
        }
        const item = visit(descriptor.value, depth + 1);
        if (item === undefined) {
          return undefined;
        }
        Object.defineProperty(copy, key, {
          configurable: true,
          enumerable: true,
          value: item,
          writable: true,
        });
      }
      return copy;
    } finally {
      state.stack.delete(candidate);
    }
  };
  return visit(value, 0);
}

function normalizeCoverage(
  value: unknown,
  transportTruncated: boolean,
): ProviderTransportAccountingCoverage | undefined {
  const normalized = normalizeBoundedPlainData(value);
  if (!normalized || typeof normalized !== "object") {
    return undefined;
  }
  const keys = Reflect.ownKeys(normalized);
  const state = readOwnDataProperty(normalized, "state");
  if (state === "complete" && keys.length === 1 && keys[0] === "state") {
    return { state };
  }
  const reasons = readOwnDataProperty(normalized, "reasons");
  if (
    (state === "partial" || state === "unavailable") &&
    keys.length === 2 &&
    keys.includes("state") &&
    keys.includes("reasons") &&
    Array.isArray(reasons) &&
    reasons.every(
      (reason) =>
        typeof reason === "string" &&
        PROVIDER_TRANSPORT_ACCOUNTING_COVERAGE_REASONS.includes(
          reason as (typeof PROVIDER_TRANSPORT_ACCOUNTING_COVERAGE_REASONS)[number],
        ),
    ) &&
    (!reasons.includes("transport_details_truncated") || transportTruncated)
  ) {
    return { state, reasons: [...reasons] as ProviderTransportAccountingCoverageReason[] };
  }
  return undefined;
}

function isCanonicalCachedInputObservation(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  const state = readOwnDataProperty(value, "state");
  if (state === "unknown") {
    return keys.length === 1 && keys[0] === "state";
  }
  const tokens = readOwnDataProperty(value, "tokens");
  return (
    state === "exact" &&
    keys.length === 2 &&
    keys.includes("state") &&
    keys.includes("tokens") &&
    typeof tokens === "number" &&
    Number.isSafeInteger(tokens) &&
    tokens >= 0
  );
}

export function extractAuditableProviderTransportAccountingSnapshot(
  snapshot: unknown,
  coverage: unknown,
): ProviderTransportAccountingAudit {
  let truncated = false;
  try {
    truncated = observeTransportTruncation(snapshot);
    const normalizedCoverage = normalizeCoverage(coverage, truncated);
    const normalizedSnapshot = normalizeBoundedPlainData(snapshot) as
      | ProviderTransportAccountingSnapshot
      | undefined;
    if (!normalizedCoverage || !normalizedSnapshot) {
      return { coverage: normalizedCoverage, truncated };
    }
    const calls = normalizedSnapshot.logicalCalls.entries;
    const attempts = normalizedSnapshot.attempts.entries;
    const invocations = normalizedSnapshot.invocations;
    const events = normalizedSnapshot.events.entries;
    if (
      normalizedCoverage.state !== "complete" ||
      normalizedSnapshot.logicalCalls.totalKind !== "exact" ||
      normalizedSnapshot.logicalCalls.outcomeKind !== "exact" ||
      normalizedSnapshot.logicalCalls.entriesTruncated ||
      normalizedSnapshot.logicalCalls.total !== calls.length ||
      calls.length > MAX_MODEL_TRANSPORT_LOGICAL_CALLS ||
      calls.some(
        (call, index) =>
          call.ordinal !== index + 1 ||
          call.outcome === undefined ||
          call.finalized !== true ||
          !isCanonicalCachedInputObservation(call.cachedInput),
      ) ||
      new Set(calls.map((call) => call.callId)).size !== calls.length ||
      normalizedSnapshot.attempts.totalKind !== "exact" ||
      attempts === undefined ||
      normalizedSnapshot.attempts.entriesTruncated ||
      normalizedSnapshot.attempts.total !== attempts.length ||
      attempts.length > MAX_MODEL_TRANSPORT_ATTEMPTS ||
      invocations === undefined ||
      invocations.totalKind !== "exact" ||
      invocations.entriesTruncated ||
      invocations.total !== invocations.entries.length ||
      invocations.entries.length > MAX_MODEL_TRANSPORT_INVOCATIONS ||
      normalizedSnapshot.events.totalKind !== "exact" ||
      normalizedSnapshot.events.entriesTruncated ||
      normalizedSnapshot.events.total !== events.length ||
      events.length > MAX_MODEL_TRANSPORT_EVENTS
    ) {
      return { coverage: normalizedCoverage, truncated };
    }

    const collector = createProviderTransportAccountingCollector();
    for (const call of calls) {
      collector.observer.onLogicalCallStarted(call);
    }
    for (const event of events) {
      collector.observer.onTransportEvent(event);
    }
    for (const call of calls) {
      collector.observer.onLogicalCallSettled(call.callId, call.outcome!, call.cachedInput);
      collector.observer.onLogicalCallFinalized(call.callId);
    }
    collector.seal();
    const replayed = collector.project();
    return isDeepStrictEqual(replayed, {
      snapshot: normalizedSnapshot,
      coverage: normalizedCoverage,
    })
      ? { snapshot: replayed.snapshot, coverage: replayed.coverage, truncated }
      : { coverage: normalizedCoverage, truncated };
  } catch {
    return { truncated };
  }
}
