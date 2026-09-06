import { createDedupeCache } from "../infra/dedupe.js";

// Bound process-local warning state; evicted conversations may log again.
const inboundDropWarnings = createDedupeCache({ ttlMs: 0, maxSize: 512 });

/**
 * Shared channel diagnostic formatters exposed through the plugin SDK.
 * Keep messages compact and stable enough for plugin logs without making them machine contracts.
 */
/** Minimal logger callback shape exposed through channel SDK helpers. */
export type LogFn = (message: string) => void;

/** Emits a normalized inbound-drop diagnostic for channel plugins. */
export function logInboundDrop(params: {
  log: LogFn;
  channel: string;
  reason: string;
  target?: string;
  /** Deduplicate by channel, reason, and caller-owned account/conversation scope. */
  onceKey?: string;
  /** Actionable operator guidance; never include message bodies or sender details. */
  hint?: string;
}): void {
  if (
    params.onceKey !== undefined &&
    inboundDropWarnings.check(JSON.stringify([params.channel, params.reason, params.onceKey]))
  ) {
    return;
  }
  const target = params.target ? ` target=${params.target}` : "";
  const hint = params.hint ? `. ${params.hint}` : "";
  params.log(`${params.channel}: drop ${params.reason}${target}${hint}`);
}

/** Emits a normalized typing-indicator failure diagnostic for channel plugins. */
export function logTypingFailure(params: {
  log: LogFn;
  channel: string;
  target?: string;
  action?: "start" | "stop";
  error: unknown;
}): void {
  const target = params.target ? ` target=${params.target}` : "";
  const action = params.action ? ` action=${params.action}` : "";
  params.log(`${params.channel} typing${action} failed${target}: ${String(params.error)}`);
}

/** Emits a normalized acknowledgement-cleanup failure diagnostic for channel plugins. */
export function logAckFailure(params: {
  log: LogFn;
  channel: string;
  target?: string;
  error: unknown;
}): void {
  const target = params.target ? ` target=${params.target}` : "";
  params.log(`${params.channel} ack cleanup failed${target}: ${String(params.error)}`);
}
