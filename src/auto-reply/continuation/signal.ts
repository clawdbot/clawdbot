/**
 * Continuation signal parsing, stripping, extraction, and merging.
 *
 * This module owns the logic that produces a unified ContinuationSignal from
 * either bracket syntax in response text or tool-call requests captured during
 * the agent turn. The runner calls this after the agent response finalizes.
 *
 * RFC: docs/design/continue-work-signal-v2.md §2.1, §3.4
 */

import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  CONTINUATION_DELEGATE_FANOUT_MODES,
  normalizeContinuationTargetKey,
  normalizeContinuationTargetKeys,
} from "./targeting-pure.js";
import type { ContinueWorkRequest, ContinuationSignal } from "./types.js";

export type { ContinuationSignal };

export const CONTINUE_WORK_TOKEN = "CONTINUE_WORK";

function isContinuationDelegateFanoutMode(
  value: string,
): value is (typeof CONTINUATION_DELEGATE_FANOUT_MODES)[number] {
  return CONTINUATION_DELEGATE_FANOUT_MODES.some((mode) => mode === value);
}

type DelegateDirectiveParse = { status: "applied" } | { status: "unknown" } | { status: "invalid" };

type DelegateDirectiveState = {
  silent?: boolean;
  silentWake?: boolean;
  postCompaction?: boolean;
  targetSessionKey?: string;
  targetSessionKeys?: string[];
  fanoutMode?: "tree" | "all";
  model?: string;
};

function splitDirectiveAssignment(segment: string): { key: string; value: string } | null {
  const separator = segment.indexOf("=");
  if (separator < 0) {
    return null;
  }
  return {
    key: segment.slice(0, separator).trim().toLowerCase(),
    value: segment.slice(separator + 1).trim(),
  };
}

function parseDelegateDirective(
  segment: string,
  state: DelegateDirectiveState,
): DelegateDirectiveParse {
  const normalized = segment.trim().toLowerCase();
  if (!normalized) {
    return { status: "invalid" };
  }
  if (normalized === "normal") {
    return { status: "applied" };
  }
  if (normalized === "silent-wake" || normalized === "silent wake") {
    state.silentWake = true;
    state.silent = undefined;
    return { status: "applied" };
  }
  if (normalized === "silent") {
    state.silent = true;
    return { status: "applied" };
  }
  // Post-compaction stages the delegate for release after the next compaction
  // seam instead of dispatching now or on a timer. Mirrors the tool-form
  // mode="post-compaction" branch (see continue-delegate-tool.ts) and is
  // exclusive with silent/silent-wake — staging applies silentAnnounce +
  // wakeOnReturn at release time.
  if (
    normalized === "post-compaction" ||
    normalized === "postcompaction" ||
    normalized === "post compaction"
  ) {
    state.postCompaction = true;
    state.silent = undefined;
    state.silentWake = undefined;
    return { status: "applied" };
  }

  const assignment = splitDirectiveAssignment(segment);
  if (!assignment) {
    return { status: "unknown" };
  }

  if (
    assignment.key === "target" ||
    assignment.key === "targetsessionkey" ||
    assignment.key === "target_session_key"
  ) {
    const targetSessionKey = normalizeContinuationTargetKey(assignment.value);
    if (!targetSessionKey) {
      return { status: "invalid" };
    }
    state.targetSessionKey = targetSessionKey;
    return { status: "applied" };
  }

  if (
    assignment.key === "targets" ||
    assignment.key === "targetsessionkeys" ||
    assignment.key === "target_session_keys"
  ) {
    const targetSessionKeys = normalizeContinuationTargetKeys(assignment.value.split(","));
    if (targetSessionKeys.length === 0) {
      return { status: "invalid" };
    }
    state.targetSessionKeys = targetSessionKeys;
    return { status: "applied" };
  }

  if (
    assignment.key === "fanout" ||
    assignment.key === "fanoutmode" ||
    assignment.key === "fanout_mode"
  ) {
    const fanoutMode = assignment.value.trim().toLowerCase();
    if (!isContinuationDelegateFanoutMode(fanoutMode)) {
      return { status: "invalid" };
    }
    state.fanoutMode = fanoutMode;
    return { status: "applied" };
  }

  if (assignment.key === "traceparent" || assignment.key === "trace_parent") {
    // Diagnostic context is runtime-owned. Consume the legacy/hidden directive
    // so it cannot become task text, but never let model output choose tracing.
    return { status: "applied" };
  }

  if (assignment.key === "model") {
    // Provider/model override forwarded to the spawned delegate. The model ref
    // is not validated here; unknown models resolve downstream at spawn time,
    // mirroring sessions_spawn. An empty value is malformed and rejects the token.
    // The "default" sentinel means "inherit the parent model" (no override),
    // matching the tool form's normalizeToolModelOverride so both surfaces agree.
    if (!assignment.value) {
      return { status: "invalid" };
    }
    if (assignment.value.toLowerCase() !== "default") {
      state.model = assignment.value;
    }
    return { status: "applied" };
  }

  // Token syntax is intentionally attachment-free. Unknown assignments such
  // as `attachment=...` remain task text; callers can reference a workspace
  // file, but inline blobs are accepted only by the typed tool.
  return { status: "unknown" };
}

function parseDelegateBodyDirectives(taskBody: string): {
  taskBody: string;
  directives: DelegateDirectiveState;
} | null {
  const segments = taskBody.split("|").map((segment) => segment.trim());
  const directives: DelegateDirectiveState = {};
  while (segments.length > 1) {
    const segment = segments.at(-1) ?? "";
    const parsed = parseDelegateDirective(segment, directives);
    if (parsed.status === "unknown") {
      break;
    }
    if (parsed.status === "invalid") {
      return null;
    }
    segments.pop();
  }
  if (
    directives.fanoutMode &&
    (directives.targetSessionKey ||
      (directives.targetSessionKeys && directives.targetSessionKeys.length > 0))
  ) {
    return null;
  }
  return {
    taskBody: segments.join(" | ").trim(),
    directives,
  };
}

/**
 * Checks if the agent response ends with a continuation signal.
 * Returns the parsed signal or null if no continuation is requested.
 *
 * Formats:
 *   CONTINUE_WORK              → continue with default delay
 *   CONTINUE_WORK:30           → continue after 30 seconds
 *   [[CONTINUE_DELEGATE: task]]      → spawn sub-agent with task immediately
 *   [[CONTINUE_DELEGATE: task +30s]] → spawn sub-agent after 30-second delay
 *   [[CONTINUE_DELEGATE: task | target=session-key]]
 *   [[CONTINUE_DELEGATE: task | targets=key1,key2]]
 *   [[CONTINUE_DELEGATE: task | fanout=tree]]
 *
 * The `+Ns` suffix on DELEGATE specifies a timer offset before the sub-agent
 * spawns (delegate-as-scheduler pattern). Timers do not survive gateway restarts.
 *
 * DELEGATE uses bracket syntax ([[...]]) following the repo convention for tokens
 * that carry body content (see reply_to, tts, line directives). Brackets naturally
 * delimit the boundary, so multiline tasks work without ambiguity.
 */
export function parseContinuationSignal(text: string | undefined): ContinuationSignal | null {
  if (!text) {
    return null;
  }

  const trimmed = text.trim();

  // Check for [[CONTINUE_DELEGATE: task]] at end of response.
  // The bracket pair [[ ... ]] delimits the body, so multiline tasks are safe.
  // The negative lookahead (?!\]\]) prevents ]] inside the body from prematurely
  // closing the bracket, and ensures we match the LAST [[CONTINUE_DELEGATE:]] when
  // the same token appears mid-text earlier in the response.
  const delegateMatch = trimmed.match(
    /\[\[\s*CONTINUE_DELEGATE:\s*((?:(?!\]\])[\s\S])+?)\s*\]\]\s*$/,
  );
  const delegateBody = delegateMatch?.[1];
  if (delegateBody) {
    let taskBody = delegateBody.trim();
    const parsedBody = parseDelegateBodyDirectives(taskBody);
    if (!parsedBody) {
      return null;
    }
    taskBody = parsedBody.taskBody;
    const {
      silent,
      silentWake,
      postCompaction,
      targetSessionKey,
      targetSessionKeys,
      fanoutMode,
      model,
    } = parsedBody.directives;

    // Parse optional +Ns delay suffix (e.g. "+30s", "+5s")
    let delayMs: number | undefined;
    const delayMatch = taskBody.match(/\s+\+(\d+)s\s*$/);
    const delaySuffix = delayMatch?.[0];
    const delaySeconds = delayMatch?.[1];
    if (delaySuffix && delaySeconds) {
      delayMs = Number.parseInt(delaySeconds, 10) * 1000;
      taskBody = taskBody.slice(0, -delaySuffix.length).trimEnd();
    }
    if (taskBody) {
      // Truncate overly long task strings to prevent context-dumping patterns.
      // Same limit as the continue_delegate tool schema (4096 chars).
      const maxTaskLength = 4096;
      const truncatedTask =
        taskBody.length > maxTaskLength ? taskBody.slice(0, maxTaskLength) : taskBody;
      return {
        kind: "delegate",
        task: truncatedTask,
        delayMs,
        silent,
        silentWake,
        ...(postCompaction ? { postCompaction } : {}),
        ...(targetSessionKey ? { targetSessionKey } : {}),
        ...(targetSessionKeys && targetSessionKeys.length > 0 ? { targetSessionKeys } : {}),
        ...(fanoutMode ? { fanoutMode } : {}),
        ...(model ? { model } : {}),
      };
    }
  }

  // Check for [[CONTINUE_WORK]] or [[CONTINUE_WORK:<delay>]] at end of response.
  // This mirrors the bracket convention used by CONTINUE_DELEGATE and keeps
  // tool-less / light-context continuation surfaces from depending on the bare
  // token form alone. Keep this grammar narrow: only a terminal bracket token is
  // consumed, and bracket text elsewhere in the reply is left alone.
  const bracketWorkMatch = trimmed.match(/\[\[\s*CONTINUE_WORK(?::(\d+))?\s*\]\]\s*$/);
  if (bracketWorkMatch) {
    const delaySec = bracketWorkMatch[1] ? Number.parseInt(bracketWorkMatch[1], 10) : undefined;
    return {
      kind: "work",
      delayMs: delaySec !== undefined ? delaySec * 1000 : undefined,
    };
  }

  // Check for CONTINUE_WORK or CONTINUE_WORK:<delay> at end of response
  const workMatch = trimmed.match(/\bCONTINUE_WORK(?::(\d+))?\s*$/);
  if (workMatch) {
    const delaySec = workMatch[1] ? Number.parseInt(workMatch[1], 10) : undefined;
    return {
      kind: "work",
      delayMs: delaySec !== undefined ? delaySec * 1000 : undefined,
    };
  }

  return null;
}

/**
 * Strips the continuation signal from the response text, returning the
 * displayable text and the parsed signal separately.
 */
export function stripContinuationSignal(text: string): {
  text: string;
  signal: ContinuationSignal | null;
} {
  const signal = parseContinuationSignal(text);
  if (!signal) {
    return { text, signal: null };
  }

  let stripped: string;
  if (signal.kind === "delegate") {
    // Strip the [[CONTINUE_DELEGATE: ...]] bracket directive.
    // Mirrors the parser grammar exactly.
    stripped = text.replace(/\[\[\s*CONTINUE_DELEGATE:\s*(?:(?!\]\])[\s\S])+?\s*\]\]\s*$/, "");
  } else if (/\[\[\s*CONTINUE_WORK(?::\d+)?\s*\]\]\s*$/.test(text.trim())) {
    // Strip the bracket continue_work directive. Must run before the bare-token
    // replacement below: otherwise only the inner CONTINUE_WORK would be
    // removed and the display text would leak a dangling "[[".
    stripped = text.replace(/\[\[\s*CONTINUE_WORK(?::\d+)?\s*\]\]\s*$/, "");
  } else {
    // Only strip CONTINUE_WORK when it's the signal type parsed
    stripped = text.replace(/\bCONTINUE_WORK(?::\d+)?\s*$/, "");
  }
  stripped = stripped.trimEnd();

  return { text: stripped, signal };
}

const log = createSubsystemLogger("continuation/signal");

/**
 * A reply payload with optional text content.
 * Matches the shape used by agent-runner.ts payload arrays.
 */
type ReplyPayload = {
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
