import { createHash } from "node:crypto";
import { types } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentCommandRunAccountingCoverageReason } from "../agents/command/run-accounting.types.js";
import type {
  AgentExecTraceCacheObservation,
  AgentExecTraceMetric,
} from "./agent-exec-trace-metrics.js";

export const TRACE_SCHEMA_VERSION = 2 as const;
export const RECEIPT_SCHEMA_VERSION = 2 as const;
export const MAX_CALLS = 64;
export const MAX_INVOCATIONS = 128;
export const MAX_RECEIPT_BYTES = 128 * 1024;
export const MAX_TRACE_BYTES = 256 * 1024;
export const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

const MAX_VALUE = 1_000_000_000_000_000;
const MAX_REASONS = 64;
const MAX_PLAIN_DATA_DEPTH = 32;
const MAX_PLAIN_DATA_NODES = 16_384;
const SAFE_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/+@-]{0,255}$/u;
const UNSAFE_LABEL_PATTERN =
  /(?:^\/|(?:^|[/.])\.\.?\/|\\|\/Users\/|\/home\/|(?:sk|sk-ant|ghp|github_pat)[_-]|AKIA|ASIA|AIza|bearer|api[_-]?key|authorization|credential|secret|token|file:\/\/|:\/\/)/iu;

const METRIC_NAMES = [
  "effective_turns",
  "logical_model_calls",
  "provider_attempts",
  "provider_initial_attempts",
  "provider_retries",
  "provider_auth_recoveries",
  "provider_payload_recoveries",
  "provider_transport_fallbacks",
  "model_facing_api_calls",
  "outer_tool_calls",
  "code_mode_bridge_calls",
  "total_tool_operations",
  "underlying_total_calls",
  "input_tokens",
  "cached_input_tokens",
  "output_tokens",
  "reasoning_tokens",
  "total_tokens",
  "agent_duration",
  "command_execution_duration",
  "wall_latency",
] as const;

const SOURCE_COVERAGE_REASONS = [
  "candidate_failed",
  "candidate_details_truncated",
  "candidate_identity_truncated",
  "effective_model_details_truncated",
  "cli_runtime",
  "native_runtime",
  "cloud_runtime",
  "unknown_runtime",
  "missing_usage",
  "partial_usage",
  "partial_provider_billed_cost",
  "missing_pricing",
  "tiered_pricing_aggregate",
  "acp_runtime",
  "settled_finalization_failed",
  "session_core_compaction",
  "session_extension_compaction",
  "native_harness_compaction",
  "deferred_context_engine_maintenance",
  "post_turn_compaction",
  "tool_details_truncated",
  "agent_submission_unsettled",
  "model_call_unsettled",
  "not_instrumented",
  "not_observed",
  "attempt_extraction_only",
  "transport_details_truncated",
  "transport_totals_lower_bound",
  "transport_outcomes_lower_bound",
  "transport_identity_overflow",
  "transport_unknown_route",
  "transport_uncorrelated_event",
  "transport_event_id_missing",
  "transport_event_conflict",
  "transport_invalid_fact",
  "transport_invalid_ordinal",
  "transport_invocation_relation_incomplete",
  "transport_invocation_relation_invalid",
  "transport_lifecycle_ambiguous",
  "transport_observer_failed",
  "transport_logical_call_incomplete",
  "transport_terminal_unverified",
  "transport_endpoint_authority_partial",
  "transport_submission_authority_partial",
] as const satisfies readonly AgentCommandRunAccountingCoverageReason[];
type SourceCoverageReasonsExhaustive =
  Exclude<
    AgentCommandRunAccountingCoverageReason,
    (typeof SOURCE_COVERAGE_REASONS)[number]
  > extends never
    ? true
    : never;
const SOURCE_COVERAGE_REASONS_EXHAUSTIVE: SourceCoverageReasonsExhaustive = true;
void SOURCE_COVERAGE_REASONS_EXHAUSTIVE;

const TRACE_REASONS = [
  "candidate_scope_incomplete",
  "provider_transport_not_observed",
  "model_calls_not_observed",
  "model_call_conservation_mismatch",
  "model_provider_call_count_mismatch",
  "model_provider_completed_count_mismatch",
  "model_provider_failed_count_mismatch",
  "provider_logical_calls_lower_bound",
  "provider_logical_outcomes_lower_bound",
  "provider_logical_calls_truncated",
  "provider_logical_call_entries_incomplete",
  "logical_outcome_conservation_mismatch",
  "provider_logical_call_identity_invalid",
  "provider_logical_call_terminal_unverified",
  "logical_outcome_entry_mismatch",
  "provider_events_truncated",
  "provider_event_entries_incomplete",
  "provider_attempt_conservation_mismatch",
  "provider_invocations_lower_bound",
  "provider_invocations_unavailable",
  "provider_invocations_truncated",
  "provider_invocation_entries_incomplete",
  "provider_connections_lower_bound",
  "provider_fallbacks_lower_bound",
  "provider_provider_fallbacks_lower_bound",
  "provider_zero_submissions_lower_bound",
  "provider_events_lower_bound",
  "provider_aggregate_conservation_mismatch",
  "provider_event_conservation_mismatch",
  "candidate_route_incomplete",
  "provider_route_incomplete",
  "provider_route_identity_mismatch",
  "reported_route_identity_missing",
  "reported_route_identity_mismatch",
  "invocation_logical_call_ledger_incomplete",
  "invocation_ledger_incomplete",
  "invocation_attempt_ledger_incomplete",
  "invocation_event_ledger_incomplete",
  "invocation_route_not_singular",
  "invocation_call_lifecycle_incomplete",
  "invocation_global_sequence_invalid",
  "invocation_attempt_conservation_mismatch",
  "invocation_provider_ledger_mismatch",
  "invocation_orphan_fact",
  "invocation_receipt_unavailable",
  "invocation_receipt_authority_invalid",
  "invocation_receipt_conservation_mismatch",
  "invocation_receipt_call_invalid",
  "invocation_receipt_call_identity_duplicate",
  "invocation_receipt_incomplete",
  "invocation_receipt_truncated",
  "invocation_receipt_route_mismatch",
  "code_mode_engagement_unreported",
  "code_mode_configuration_unreported",
  "code_mode_stats_not_observed",
  "code_mode_bridge_count_invalid",
  "code_mode_configuration_mismatch",
  "code_mode_engagement_mismatch",
  "code_mode_not_quiescent",
  "code_mode_unresolved_bridge_calls",
  "code_mode_bridge_lifecycle_count_invalid",
  "code_mode_bridge_lifecycle_conservation_mismatch",
  "provider_attempt_usage_unattributed",
  "provider_attempt_usage_unproven",
  "terminal_metadata_unavailable",
  "first_logical_call_cached_input_unknown",
  "tool_operation_components_incomplete",
  "underlying_call_components_incomplete",
  "route_unavailable",
] as const;

const KNOWN_REASONS = new Set<string>([
  ...SOURCE_COVERAGE_REASONS,
  ...TRACE_REASONS,
  ...METRIC_NAMES.flatMap((name) => [`${name}_lower_bound`, `${name}_unavailable`]),
]);

export type SchemaRoute = { provider: string; model: string; api: string };
export type SchemaTraceRoute = SchemaRoute & { runtime: "embedded" };
export type SchemaProviderAttempts = {
  total: AgentExecTraceMetric;
  initial: AgentExecTraceMetric;
  retries: AgentExecTraceMetric;
  authRecoveries: AgentExecTraceMetric;
  payloadRecoveries: AgentExecTraceMetric;
  transportFallbacks: AgentExecTraceMetric;
};
export type SchemaTokens = {
  input: AgentExecTraceMetric;
  cachedInput: AgentExecTraceMetric;
  firstLogicalCallCachedInput: AgentExecTraceCacheObservation;
  output: AgentExecTraceMetric;
  reasoning: AgentExecTraceMetric;
  total: AgentExecTraceMetric;
};
export type SchemaSourceFacts = {
  auditReasons: string[];
  accounting: {
    effectiveTurns: AgentExecTraceMetric;
    logicalModelCalls: AgentExecTraceMetric;
    providerAttempts: SchemaProviderAttempts;
  };
  tools: {
    outerToolCalls: AgentExecTraceMetric;
    codeModeBridgeCalls: AgentExecTraceMetric;
  };
  usage: SchemaTokens;
  duration: {
    agentDurationMs: AgentExecTraceMetric;
    commandExecutionDurationMs: AgentExecTraceMetric;
    wallLatencyMs: AgentExecTraceMetric;
  };
};

export function hasKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(record);
  return (
    actual.length === keys.length &&
    actual.every((key) => typeof key === "string") &&
    keys.every((key) => Object.hasOwn(record, key))
  );
}

export function bytewiseCompare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .toSorted(bytewiseCompare)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function digest(domain: string, value: unknown): string {
  return createHash("sha256")
    .update(domain)
    .update("\0")
    .update(canonicalJson(value))
    .digest("hex");
}

function dataKeys(
  keys: readonly PropertyKey[],
  descriptors: object,
  allowToJSONBlocker: boolean,
): PropertyKey[] | undefined {
  if (!keys.includes("toJSON")) {
    return [...keys];
  }
  if (!allowToJSONBlocker) {
    return undefined;
  }
  const blocker = (descriptors as { toJSON?: PropertyDescriptor }).toJSON;
  if (
    !blocker ||
    blocker.enumerable ||
    blocker.configurable ||
    blocker.writable ||
    !("value" in blocker) ||
    blocker.value !== undefined
  ) {
    return undefined;
  }
  return keys.filter((key) => key !== "toJSON");
}

export function normalizePlainData(
  value: unknown,
  maxBytes: number,
  options: { allowToJSONBlocker?: boolean } = {},
): unknown {
  const allowToJSONBlocker = options.allowToJSONBlocker !== false;
  const state = { bytes: 0, nodes: 0 };
  const charge = (bytes: number): boolean => {
    state.bytes += bytes;
    return state.bytes <= maxBytes;
  };
  const visit = (candidate: unknown, depth: number): unknown => {
    state.nodes += 1;
    if (state.nodes > MAX_PLAIN_DATA_NODES || depth > MAX_PLAIN_DATA_DEPTH) {
      return undefined;
    }
    if (candidate === null || typeof candidate === "boolean") {
      return charge(candidate === null ? 4 : candidate ? 4 : 5) ? candidate : undefined;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) {
        return undefined;
      }
      const encoded = JSON.stringify(candidate);
      return charge(Buffer.byteLength(encoded, "utf8")) ? candidate : undefined;
    }
    if (typeof candidate === "string") {
      const encoded = JSON.stringify(candidate);
      return charge(Buffer.byteLength(encoded, "utf8")) ? candidate : undefined;
    }
    if (typeof candidate !== "object") {
      return undefined;
    }
    if (types.isProxy(candidate)) {
      return undefined;
    }
    const prototype = Object.getPrototypeOf(candidate);
    if (Array.isArray(candidate)) {
      if (prototype !== Array.prototype || !charge(2)) {
        return undefined;
      }
      const descriptors = Object.getOwnPropertyDescriptors(candidate);
      const keys = dataKeys(Reflect.ownKeys(candidate), descriptors, allowToJSONBlocker);
      const lengthDescriptor = Object.getOwnPropertyDescriptor(candidate, "length");
      if (
        !keys ||
        keys.length !== candidate.length + 1 ||
        keys.at(-1) !== "length" ||
        !lengthDescriptor ||
        !("value" in lengthDescriptor) ||
        lengthDescriptor.value !== candidate.length
      ) {
        return undefined;
      }
      const copy: unknown[] = [];
      for (let index = 0; index < candidate.length; index += 1) {
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
    const keys = dataKeys(Reflect.ownKeys(candidate), descriptors, allowToJSONBlocker);
    if (!keys || keys.some((key) => typeof key !== "string") || !charge(2)) {
      return undefined;
    }
    const copy = Object.create(null) as Record<string, unknown>;
    for (const [index, key] of (keys as string[]).entries()) {
      const descriptor = descriptors[key];
      if (
        !descriptor ||
        !descriptor.enumerable ||
        !("value" in descriptor) ||
        !charge((index === 0 ? 0 : 1) + Buffer.byteLength(JSON.stringify(key), "utf8") + 1)
      ) {
        return undefined;
      }
      const item = visit(descriptor.value, depth + 1);
      if (item === undefined) {
        return undefined;
      }
      copy[key] = item;
    }
    return copy;
  };
  try {
    return visit(value, 0);
  } catch {
    return undefined;
  }
}

export function isolatePlainDataForPersistence(value: unknown): unknown {
  if (Array.isArray(value)) {
    const copy = value.map(isolatePlainDataForPersistence);
    Object.defineProperty(copy, "toJSON", { value: undefined });
    return Object.freeze(copy);
  }
  if (value !== null && typeof value === "object") {
    const copy = Object.create(null) as Record<string, unknown>;
    for (const [key, entry] of Object.entries(value)) {
      copy[key] = isolatePlainDataForPersistence(entry);
    }
    return Object.freeze(copy);
  }
  return value;
}

export function parseBoundedJson(value: unknown, maxBytes: number): unknown {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maxBytes) {
    return undefined;
  }
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export function safeInteger(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    !Object.is(value, -0) &&
    Number(value) >= 0 &&
    Number(value) <= MAX_VALUE
  );
}

export function safeLabel(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Array.from(value).length <= 256 &&
    SAFE_LABEL_PATTERN.test(value) &&
    !UNSAFE_LABEL_PATTERN.test(value)
  );
}

export function sortedKnownReasons(value: unknown, allowEmpty: boolean): value is string[] {
  if (!Array.isArray(value) || value.length > MAX_REASONS || (!allowEmpty && value.length === 0)) {
    return false;
  }
  let previous: string | undefined;
  for (const reason of value) {
    if (typeof reason !== "string" || !KNOWN_REASONS.has(reason)) {
      return false;
    }
    if (previous !== undefined && bytewiseCompare(previous, reason) >= 0) {
      return false;
    }
    previous = reason;
  }
  return true;
}

export function normalizeReasons(reasons: readonly string[]): string[] {
  return [...new Set(reasons)].toSorted(bytewiseCompare);
}

export function parseRoute(
  value: unknown,
  runtime: boolean,
): SchemaRoute | SchemaTraceRoute | undefined {
  const keys = runtime ? ["provider", "model", "api", "runtime"] : ["provider", "model", "api"];
  if (
    !isRecord(value) ||
    !hasKeys(value, keys) ||
    !safeLabel(value.provider) ||
    !safeLabel(value.model) ||
    !safeLabel(value.api) ||
    (runtime && value.runtime !== "embedded")
  ) {
    return undefined;
  }
  return {
    provider: value.provider,
    model: value.model,
    api: value.api,
    ...(runtime ? { runtime: "embedded" as const } : {}),
  };
}

export function parseMetric(value: unknown): AgentExecTraceMetric | undefined {
  if (!isRecord(value) || typeof value.state !== "string") {
    return undefined;
  }
  if (value.state === "exact" && hasKeys(value, ["state", "value"]) && safeInteger(value.value)) {
    return { state: "exact", value: value.value };
  }
  if (
    value.state === "lower_bound" &&
    hasKeys(value, ["state", "value", "reasons"]) &&
    safeInteger(value.value) &&
    sortedKnownReasons(value.reasons, false)
  ) {
    return { state: "lower_bound", value: value.value, reasons: [...value.reasons] };
  }
  if (
    value.state === "unavailable" &&
    hasKeys(value, ["state", "reasons"]) &&
    sortedKnownReasons(value.reasons, false)
  ) {
    return { state: "unavailable", reasons: [...value.reasons] };
  }
  return undefined;
}

export function parseCache(value: unknown): AgentExecTraceCacheObservation | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value.state === "exact" && hasKeys(value, ["state", "value"]) && safeInteger(value.value)) {
    return { state: "exact", value: value.value };
  }
  if (
    value.state === "unknown" &&
    hasKeys(value, ["state", "reasons"]) &&
    sortedKnownReasons(value.reasons, false)
  ) {
    return { state: "unknown", reasons: [...value.reasons] };
  }
  return undefined;
}

export function parseProviderAttempts(value: unknown): SchemaProviderAttempts | undefined {
  if (
    !isRecord(value) ||
    !hasKeys(value, [
      "total",
      "initial",
      "retries",
      "authRecoveries",
      "payloadRecoveries",
      "transportFallbacks",
    ])
  ) {
    return undefined;
  }
  const parsed = {
    total: parseMetric(value.total),
    initial: parseMetric(value.initial),
    retries: parseMetric(value.retries),
    authRecoveries: parseMetric(value.authRecoveries),
    payloadRecoveries: parseMetric(value.payloadRecoveries),
    transportFallbacks: parseMetric(value.transportFallbacks),
  };
  return Object.values(parsed).every(Boolean) ? (parsed as SchemaProviderAttempts) : undefined;
}

export function parseTokens(value: unknown): SchemaTokens | undefined {
  if (
    !isRecord(value) ||
    !hasKeys(value, [
      "input",
      "cachedInput",
      "firstLogicalCallCachedInput",
      "output",
      "reasoning",
      "total",
    ])
  ) {
    return undefined;
  }
  const parsed = {
    input: parseMetric(value.input),
    cachedInput: parseMetric(value.cachedInput),
    firstLogicalCallCachedInput: parseCache(value.firstLogicalCallCachedInput),
    output: parseMetric(value.output),
    reasoning: parseMetric(value.reasoning),
    total: parseMetric(value.total),
  };
  return Object.values(parsed).every(Boolean) ? (parsed as SchemaTokens) : undefined;
}

export function parseFacts(value: unknown): SchemaSourceFacts | undefined {
  if (
    !isRecord(value) ||
    !hasKeys(value, ["auditReasons", "accounting", "tools", "usage", "duration"]) ||
    !sortedKnownReasons(value.auditReasons, true) ||
    !isRecord(value.accounting) ||
    !hasKeys(value.accounting, ["effectiveTurns", "logicalModelCalls", "providerAttempts"]) ||
    !isRecord(value.tools) ||
    !hasKeys(value.tools, ["outerToolCalls", "codeModeBridgeCalls"]) ||
    !isRecord(value.duration) ||
    !hasKeys(value.duration, ["agentDurationMs", "commandExecutionDurationMs", "wallLatencyMs"])
  ) {
    return undefined;
  }
  const facts = {
    auditReasons: [...value.auditReasons],
    accounting: {
      effectiveTurns: parseMetric(value.accounting.effectiveTurns),
      logicalModelCalls: parseMetric(value.accounting.logicalModelCalls),
      providerAttempts: parseProviderAttempts(value.accounting.providerAttempts),
    },
    tools: {
      outerToolCalls: parseMetric(value.tools.outerToolCalls),
      codeModeBridgeCalls: parseMetric(value.tools.codeModeBridgeCalls),
    },
    usage: parseTokens(value.usage),
    duration: {
      agentDurationMs: parseMetric(value.duration.agentDurationMs),
      commandExecutionDurationMs: parseMetric(value.duration.commandExecutionDurationMs),
      wallLatencyMs: parseMetric(value.duration.wallLatencyMs),
    },
  };
  if (
    !facts.accounting.effectiveTurns ||
    !facts.accounting.logicalModelCalls ||
    !facts.accounting.providerAttempts ||
    !facts.tools.outerToolCalls ||
    !facts.tools.codeModeBridgeCalls ||
    !facts.usage ||
    !facts.duration.agentDurationMs ||
    !facts.duration.commandExecutionDurationMs ||
    !facts.duration.wallLatencyMs
  ) {
    return undefined;
  }
  return facts as SchemaSourceFacts;
}
