import {
  activeSessions,
  authorizeTranscriptSource,
  readTranscriptStringParam,
  resolveSourceProvider,
  type TranscriptCaptureSelection,
  type TranscriptsRuntimeContext,
} from "../../transcripts/capture.js";
import type { TranscriptSessionDescriptor } from "../../transcripts/provider-types.js";
import { transcriptSessionSelector, type TranscriptsStore } from "../../transcripts/store.js";
import { toolText } from "./transcripts-tool-result.js";

type TranscriptSessionIdentity = Pick<TranscriptSessionDescriptor, "sessionId" | "startedAt">;

function sameSessionIdentity(
  left: TranscriptSessionIdentity,
  right: TranscriptSessionIdentity,
): boolean {
  return left.sessionId === right.sessionId && left.startedAt === right.startedAt;
}

function ownsTranscriptSession(
  ctx: TranscriptsRuntimeContext,
  session: TranscriptSessionDescriptor,
): boolean {
  const ownerAgentId = session.metadata?.agentId;
  if (typeof ownerAgentId === "string") {
    return ownerAgentId === ctx.agentId;
  }
  // Shipped ownerless rows stay with main; provider access still decides whether
  // the current caller may act on an account-bound canonical source.
  return ctx.agentId ? ctx.agentId === "main" : ctx.caller?.kind === "operator";
}

export async function canAccessTranscriptSession(
  ctx: TranscriptsRuntimeContext,
  session: TranscriptSessionDescriptor,
  action: "status" | "stop" | "summarize" | "list" | "show",
): Promise<boolean> {
  const readOnly = action === "list" || action === "show";
  if (!readOnly && !ownsTranscriptSession(ctx, session)) {
    return false;
  }
  if (readOnly && ctx.caller?.kind === "operator") {
    return true;
  }
  const provider = resolveSourceProvider(session.source.providerId, ctx);
  if (readOnly && (ctx.caller?.kind !== "channel" || !provider?.accessControl)) {
    return false;
  }
  if (!provider) {
    return ctx.caller?.kind === "operator";
  }
  try {
    await authorizeTranscriptSource({ action, ctx, provider, source: session.source });
    return true;
  } catch {
    return false;
  }
}

export async function resolveTranscriptToolSession(params: {
  ctx: TranscriptsRuntimeContext;
  store: TranscriptsStore;
  rawParams: Record<string, unknown>;
  action: "stop" | "summarize" | "show";
}) {
  const explicit = params.rawParams.selector !== undefined;
  if (explicit === (params.rawParams.sessionId !== undefined)) {
    throw new Error("Provide exactly one of selector or sessionId for stop, summarize, or show.");
  }
  const value = readTranscriptStringParam(params.rawParams, explicit ? "selector" : "sessionId", {
    required: true,
    trim: true,
  });
  params.ctx.assertCallerActive?.();
  const durableRead = params.action === "show";
  const exactActive = explicit || durableRead ? undefined : activeSessions.get(value);
  const { qualified, unqualified } = params.store.matchSessionEntries(value);
  let entry: { session: TranscriptSessionDescriptor; selector: string } | undefined;
  // Current raw handles can span historical dates, but never another raw ID
  // or a conflicting qualified meaning. Authorization cannot break a tie.
  const preferActive =
    !qualified.length &&
    exactActive &&
    unqualified.every((candidate) => candidate.session.sessionId === value);
  if (preferActive) {
    entry = {
      session: exactActive.session,
      selector: transcriptSessionSelector(exactActive.session),
    };
  } else {
    const candidates = explicit ? qualified : [...qualified, ...unqualified];
    const distinct = candidates.filter(
      (candidate, index) =>
        candidates.findIndex((other) => sameSessionIdentity(candidate.session, other.session)) ===
        index,
    );
    if (distinct.length > 1) {
      throw new Error(
        "Ambiguous transcripts session; pass selector from start, import, status, or the local transcripts list.",
      );
    }
    entry = distinct[0];
  }
  const activeCandidate = preferActive
    ? exactActive
    : entry && activeSessions.get(entry.session.sessionId);
  const selectedActive =
    !durableRead &&
    entry &&
    activeCandidate &&
    sameSessionIdentity(entry.session, activeCandidate.session)
      ? activeCandidate
      : undefined;
  // Reads authorize the durable descriptor that owns the notes. Mutations keep
  // the admitted capture's authority even after a same-tuple durable rewrite.
  const session = durableRead ? entry?.session : (selectedActive?.session ?? entry?.session);
  // Historical authorization and inference can outlive an entire reopen/stop.
  // Capture the durable input revision before either awaited operation.
  const historicalRevision =
    session && !selectedActive ? params.store.readSummaryInputRevision(session) : undefined;
  if (
    !entry ||
    !session ||
    !(await canAccessTranscriptSession(params.ctx, session, params.action))
  ) {
    throw new Error(`transcripts session not found: ${value}`);
  }
  return { session, selector: entry.selector, activeCandidate, selectedActive, historicalRevision };
}

export function transcriptSelectionNoLongerActive(selection: TranscriptCaptureSelection) {
  const sessionId = selection.session.sessionId;
  return toolText(`Transcripts session no longer active: ${sessionId}`, {
    sessionId,
    selector: selection.selector,
    skipped: true,
  });
}
