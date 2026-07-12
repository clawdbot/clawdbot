/**
 * Continuation signal extraction and merging.
 *
 * This module owns the logic that produces a unified ContinuationSignal from
 * either bracket syntax in response text or tool-call requests captured during
 * the agent turn. The runner calls this after the agent response finalizes.
 *
 * RFC: docs/design/continue-work-signal-v2.md §2.1, §3.4
 */

import { createSubsystemLogger } from "../../logging/subsystem.js";
import { stripContinuationSignal } from "../tokens.js";
import type { ContinuationSignal } from "./types.js";

const log = createSubsystemLogger("continuation/signal");

// ContinueWorkRequest now lives in ./types.js — import for local use and
// re-export for call sites that already depend on this module.
import type { ContinueWorkRequest } from "./types.js";
export type { ContinueWorkRequest };

/**
 * A reply payload with optional text content.
 * Matches the shape used by agent-runner.ts payload arrays.
 */
export type ReplyPayload = {
  text?: string;
  [key: string]: unknown;
};

/**
 * Result of extracting continuation signals from a completed agent turn.
 */
export type ContinuationSignalExtraction = {
  /** The merged continuation signal, or null if no continuation requested. */
  signal: ContinuationSignal | null;
  /** The reason string from a continue_work tool call, if any. */
  workReason?: string;
  /** Whether the signal came from bracket syntax (vs tool call). */
  fromBracket: boolean;
};

/**
 * Extract a continuation signal from the agent's response payloads and/or
 * tool-call request.
 *
 * Priority: bracket-parsed signal takes precedence (it was explicitly in the
 * response text). If no bracket signal, fall back to tool-call request.
 *
 * The bracket signal is stripped from the payload text so the user only sees
 * the conversational reply.
 *
 * @param payloads - The agent's response payload array (text may be mutated to strip signal)
 * @param continueWorkRequest - Tool-call request captured during the turn, if any
 * @param enabled - Whether continuation is enabled in config
 * @param sessionKey - Session key for logging
 */
export function extractContinuationSignal(params: {
  payloads: ReplyPayload[];
  continueWorkRequest?: ContinueWorkRequest;
  enabled: boolean;
  sessionKey?: string;
}): ContinuationSignalExtraction {
  const { payloads, continueWorkRequest, enabled, sessionKey } = params;

  if (!enabled) {
    log.info(
      `[continuation:trace] signal-extract skipped: feature disabled session=${sessionKey ?? "none"}`,
    );
    return { signal: null, fromBracket: false };
  }

  // Try bracket parsing first. Scan ALL text payloads (not just the last one)
  // so that markers on earlier payloads survive even when later payloads add
  // plain text — for example, a warning/error block emitted after the model's
  // intended continuation marker. Tool-call payloads may follow text payloads,
  // and the model may emit multiple text fragments per turn; the marker can
  // legitimately live on any of them. Critical for subagent chain-hops where
  // the bracket is the ONLY continuation path (tool is denied for leaf subagents).
  // previous "stop at last text payload" shape
  // silently dropped markers on earlier payloads when later text existed.
  let bracketSignal: ContinuationSignal | null = null;
  let bracketPayloadIdx = -1;

  if (payloads.length > 0) {
    // Walk backward so that, if multiple payloads contain markers, the
    // last-emitted one wins (matches the model's "most recent intent" shape).
    for (let i = payloads.length - 1; i >= 0; i--) {
      const payload = payloads[i];
      if (!payload?.text) {
        continue;
      }
      const result = stripContinuationSignal(payload.text);
      if (result.signal) {
        bracketSignal = result.signal;
        bracketPayloadIdx = i;
        payload.text = result.text; // Mutate: strip signal from displayed text
        break;
      }
    }

    // Trace the structural shape of the scan (presence map only, no content)
    // for diagnosis without leaking reply text into operational logs.
    // prior shape included `text.slice(-60)`
    // of every payload via log.info, leaking PII / model output into normal-
    // info logs and creating high-volume log bloat.
    const presenceMap = payloads.map((p, i) => `[${i}]text=${Boolean(p.text)}`).join(" ");
    log.info(
      `[continuation:trace] payload-scan: count=${payloads.length} ` +
        `bracketIdx=${bracketPayloadIdx} ` +
        `${presenceMap} session=${sessionKey ?? "none"}`,
    );

    if (bracketSignal) {
      log.info(
        `[continuation:trace] bracket-parse: kind=${bracketSignal.kind} ` +
          `delayMs=${bracketSignal.delayMs ?? "default"} session=${sessionKey ?? "none"}`,
      );
    }
  } else {
    log.info(
      `[continuation:trace] bracket-parse skipped: empty payloads session=${sessionKey ?? "none"}`,
    );
  }

  // Merge: bracket signal takes precedence over tool-call request.
  const signal: ContinuationSignal | null =
    bracketSignal ??
    (continueWorkRequest
      ? {
          kind: "work" as const,
          delayMs: continueWorkRequest.delaySeconds * 1000,
        }
      : null);

  const fromBracket = bracketSignal !== null;
  const origin = bracketSignal ? "bracket" : signal ? "tool-call" : "none";
  const workReason =
    !bracketSignal && signal?.kind === "work" ? continueWorkRequest?.reason : undefined;

  log.info(
    `[continuation:trace] effective-signal: origin=${origin} ` +
      `kind=${signal?.kind ?? "none"} session=${sessionKey ?? "none"}`,
  );

  return { signal, workReason, fromBracket };
}
