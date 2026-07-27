#!/usr/bin/env node
/**
 * Extracts the gateway event name list from server-methods-list.ts source.
 * Bare identifiers in the array (e.g. GATEWAY_EVENT_UPDATE_AVAILABLE) are
 * resolved against constantsSource (src/gateway/events.ts).
 */
export function extractGatewayEventNames(listSource: unknown, constantsSource: unknown): string[];
/**
 * Extracts qualified static string constants declared at Swift type scope.
 * Type qualification avoids resolving unrelated constants that share a short
 * member name elsewhere in the app.
 */
export function extractSwiftStaticStringConstants(source: unknown): Map<unknown, unknown>;
/** Extracts Swift gateway-event case labels, including qualified constants. */
export function extractSwiftHandledEvents(
  source: unknown,
  constants?: Map<unknown, unknown>,
): Set<unknown>;
/** Extracts generated Kotlin enum entries whose constructor stores a wire string. */
export function extractKotlinEnumStringConstants(source: unknown): Map<string, string>;
/**
 * Extracts event names a Kotlin source handles: string-literal case labels of
 * `when (event)` blocks plus `event == "..."` comparisons, both scoped to
 * `fun handle*Event(...)` bodies. Scoping matters: bare `event == "..."`
 * literals also appear in predicate helpers that are not called from the
 * dispatch path (e.g. gatewayEventInvalidatesNodesDevices in NodeRuntime.kt),
 * and counting those would silently mark events as covered. Swift extraction
 * stays tree-wide because Swift consumption always reads `.event` off a
 * received EventFrame, which does not have that false-positive shape.
 */
export function extractKotlinHandledEvents(
  source: unknown,
  constants?: ReadonlyMap<string, string>,
): Set<string>;
/**
 * Compares a client's handled events against the gateway catalog and its
 * allowlist. Returns human-readable error strings. Client-only names (e.g. the
 * client-synthesized "seqGap" pseudo-event) are intentionally ignored; this
 * check only guards the server->client direction.
 */
export function compareEventCoverage(params: unknown): string[];
