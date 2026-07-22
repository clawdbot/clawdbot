import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { z } from "zod";
import {
  SESSION_OBSERVER_HEALTH_VALUES,
  type SessionObserverDigest,
  type SessionObserverHealth,
  type SessionObserverPlanProgress,
} from "../../packages/gateway-protocol/src/schema/sessions.js";
import {
  terminalHealthFor,
  type SessionActivityNoteState,
} from "../agents/session-activity-notes.js";
import type {
  completeWithPreparedSimpleCompletionModel,
  prepareSimpleCompletionModelForAgent,
} from "../agents/simple-completion-runtime.js";
import type { resolveUtilityModelRefForAgent } from "../agents/utility-model.js";
import {
  loadSessionEntryReadOnly,
  patchSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AgentEventPayload } from "../infra/agent-events.js";
import { redactToolPayloadText } from "../logging/redact.js";
import type {
  SessionEventSubscriberRegistry,
  SessionMessageSubscriberRegistry,
} from "./server-chat-state.js";

const HEADLINE_MAX_CHARS = 120;
const ASSESSMENT_MAX_CHARS = 320;
const MAX_REVISION_FLOORS = 256;
const MAX_SUPERSEDED_RUNS = 256;
const MAX_DORMANT_RUNS = 256;
const MAX_DISABLED_RUNS = 512;

export const SESSION_OBSERVER_MODEL_MAX_TOKENS = 300;
type PrepareModel = typeof prepareSimpleCompletionModelForAgent;
type CompleteModel = typeof completeWithPreparedSimpleCompletionModel;
export type PreparedModel = Awaited<ReturnType<PrepareModel>>;

export type SessionObserverState = SessionActivityNoteState & {
  sessionKey: string;
  sessionId?: string;
  runId: string;
  agentId: string;
  utilityModelRef?: string;
  startedAt: number;
  lastActivityAt: number;
  lastRunAt: number;
  lastPersistedAt?: number;
  revision: number;
  digestCount: number;
  consecutiveFailures: number;
  lastDigestNoteSequence: number;
  previousDigest?: SessionObserverDigest;
  preparedPromise?: Promise<PreparedModel>;
  activeController?: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  inFlight: boolean;
  finalPending: boolean;
  terminalHealth?: "done" | "failed";
};

export type DormantSessionObserverRun = Pick<
  SessionObserverState,
  | "sessionKey"
  | "sessionId"
  | "runId"
  | "agentId"
  | "utilityModelRef"
  | "startedAt"
  | "lastPersistedAt"
  | "revision"
  | "digestCount"
  | "consecutiveFailures"
  | "planProgress"
  | "previousDigest"
>;

export type SessionObserverRevisionFloor = Pick<
  DormantSessionObserverRun,
  "revision" | "previousDigest"
>;

export function rememberSessionObserverRevisionFloor(
  floors: Map<string, SessionObserverRevisionFloor>,
  sessionKey: string,
  candidate: SessionObserverRevisionFloor,
): void {
  const current = floors.get(sessionKey);
  if (!current || candidate.revision > current.revision) {
    floors.delete(sessionKey);
    floors.set(sessionKey, candidate);
  }
  while (floors.size > MAX_REVISION_FLOORS) {
    const oldest = floors.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    floors.delete(oldest);
  }
}

export function rememberSessionObserverDormantRun(
  runs: Map<string, DormantSessionObserverRun>,
  floors: Map<string, SessionObserverRevisionFloor>,
  run: DormantSessionObserverRun,
): void {
  runs.delete(run.runId);
  runs.set(run.runId, run);
  while (runs.size > MAX_DORMANT_RUNS) {
    const oldest = runs.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    const evicted = runs.get(oldest);
    runs.delete(oldest);
    if (evicted) {
      // Evicted dormant runs keep revision continuity through the bounded floor
      // map so a later resume cannot restart below an already broadcast revision.
      rememberSessionObserverRevisionFloor(floors, evicted.sessionKey, {
        revision: evicted.revision,
        previousDigest: evicted.previousDigest,
      });
    }
  }
}

export function rememberSessionObserverDisabledRun(runs: Set<string>, runId: string): void {
  runs.delete(runId);
  runs.add(runId);
  while (runs.size > MAX_DISABLED_RUNS) {
    const oldest = runs.values().next().value;
    if (oldest === undefined) {
      break;
    }
    runs.delete(oldest);
  }
}

export function markSessionObserverRunSuperseded(
  runs: Map<string, number>,
  runId: string,
  observedAt: number,
): void {
  runs.delete(runId);
  runs.set(runId, observedAt);
  while (runs.size > MAX_SUPERSEDED_RUNS) {
    const oldest = runs.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    runs.delete(oldest);
  }
}

export function createDormantSessionObserverRun(
  state: SessionObserverState,
): DormantSessionObserverRun {
  return {
    sessionKey: state.sessionKey,
    sessionId: state.sessionId,
    runId: state.runId,
    agentId: state.agentId,
    ...(state.utilityModelRef ? { utilityModelRef: state.utilityModelRef } : {}),
    startedAt: state.startedAt,
    lastPersistedAt: state.lastPersistedAt,
    revision: state.revision,
    digestCount: state.digestCount,
    consecutiveFailures: state.consecutiveFailures,
    planProgress: state.planProgress,
    previousDigest: state.previousDigest,
  };
}

export type SessionObserverDeps = {
  getConfig: () => OpenClawConfig;
  subscribers: SessionMessageSubscriberRegistry;
  sessionEventSubscribers?: SessionEventSubscriberRegistry;
  broadcastToConnIds: (
    event: string,
    payload: unknown,
    connIds: ReadonlySet<string>,
    opts?: { dropIfSlow?: boolean },
  ) => void;
  resolveUtilityModelRef?: typeof resolveUtilityModelRefForAgent;
  prepareModel?: PrepareModel;
  completeModel?: CompleteModel;
  readSession?: (sessionKey: string, agentId: string) => SessionEntry | undefined;
  persistDigest?: (params: {
    sessionKey: string;
    sessionId?: string;
    agentId: string;
    digest: SessionObserverDigest;
    /** Evaluated inside the entry updater so run rollover cannot commit a
     * digest from a replaced run between acceptance and the async write. */
    stillCurrent?: () => boolean;
  }) => Promise<boolean>;
  now?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
};

let completionRuntimePromise:
  | Promise<typeof import("../agents/simple-completion-runtime.js")>
  | undefined;

function loadCompletionRuntime() {
  completionRuntimePromise ??= import("../agents/simple-completion-runtime.js");
  return completionRuntimePromise;
}

export async function defaultPrepareModel(params: Parameters<PrepareModel>[0]) {
  return await (await loadCompletionRuntime()).prepareSimpleCompletionModelForAgent(params);
}

export async function defaultCompleteModel(params: Parameters<CompleteModel>[0]) {
  return await (await loadCompletionRuntime()).completeWithPreparedSimpleCompletionModel(params);
}

export const SESSION_OBSERVER_SYSTEM_PROMPT = [
  "You judge the trajectory of a running AI agent session for an operator status surface.",
  "Judge whether the agent is progressing, grinding through necessary work, stuck in a repeated failing loop, waiting on the user, wrapping up, done, or failed.",
  "Do not transcribe the activity log. Summarize what it is doing and how it is going.",
  "Use American English and present tense. Do not use markdown in string values.",
  'Set health to exactly one of "on-track", "grinding", "stuck", "waiting-on-user", "wrapping-up", "done", or "failed".',
  'Return strict JSON only, for example: {"headline":"Checking the fix","assessment":"Tests are passing.","health":"on-track","planProgress":{"completed":2,"total":3}}. Omit optional fields instead of setting them to null.',
].join(" ");

const ModelDigestSchema = z
  .strictObject({
    headline: z.string().min(1),
    assessment: z.string().min(1).optional(),
    health: z.enum(SESSION_OBSERVER_HEALTH_VALUES),
    planProgress: z
      .strictObject({
        completed: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
      })
      .refine((value) => value.completed <= value.total)
      .optional(),
  })
  .strict();

export function sanitizeSessionObserverModelText(value: string, maxChars: number): string {
  const normalized = redactToolPayloadText(value).replace(/\s+/gu, " ").trim();
  return truncateUtf16Safe(normalized, maxChars);
}

export function defaultReadSession(sessionKey: string, agentId: string): SessionEntry | undefined {
  // Read-only: observation must never materialize agent state (dirs, agent DB
  // registration) for agents that are not configured.
  return loadSessionEntryReadOnly({ sessionKey, agentId });
}

export async function defaultPersistDigest(params: {
  sessionKey: string;
  sessionId?: string;
  agentId: string;
  digest: SessionObserverDigest;
  stillCurrent?: () => boolean;
}): Promise<boolean> {
  const result = await patchSessionEntry(
    { sessionKey: params.sessionKey, agentId: params.agentId },
    (entry, context) => {
      if (!context.existingEntry) {
        return null;
      }
      if (params.stillCurrent?.() === false) {
        return null;
      }
      if (params.sessionId && entry.sessionId !== params.sessionId) {
        return null;
      }
      if ((entry.observerDigest?.revision ?? 0) >= params.digest.revision) {
        return null;
      }
      return { observerDigest: params.digest };
    },
    { preserveActivity: true },
  );
  return result != null;
}

export function isTerminalLifecycleEvent(event: AgentEventPayload): boolean {
  return (
    event.stream === "lifecycle" && (event.data.phase === "end" || event.data.phase === "error")
  );
}

export async function synthesizeSessionObserverTerminalDigest(params: {
  source: { event?: AgentEventPayload; state?: SessionObserverState };
  dormant?: DormantSessionObserverRun;
  readSession: NonNullable<SessionObserverDeps["readSession"]>;
  persistDigest: NonNullable<SessionObserverDeps["persistDigest"]>;
  now: () => number;
  /** Rechecked at persist time: rollover can admit a newer run between the
   * synchronous synthesis start and the async write. */
  stillCurrent?: () => boolean;
}): Promise<SessionObserverDigest | undefined> {
  const runId = params.source.event?.runId ?? params.source.state?.runId;
  if (!runId) {
    return undefined;
  }
  const sessionKey =
    params.source.event?.sessionKey ??
    params.source.state?.sessionKey ??
    params.dormant?.sessionKey;
  const agentId =
    params.source.event?.agentId ?? params.source.state?.agentId ?? params.dormant?.agentId;
  const health = params.source.event
    ? terminalHealthFor(params.source.event)
    : params.source.state?.terminalHealth;
  if (!sessionKey || !agentId || !health) {
    return undefined;
  }
  const session = params.readSession(sessionKey, agentId);
  const previous = [
    params.source.state?.previousDigest,
    params.dormant?.previousDigest,
    session?.observerDigest,
  ].find((digest) => digest?.runId === runId);
  if (!previous) {
    return undefined;
  }
  const sessionId =
    params.source.state?.sessionId ?? params.dormant?.sessionId ?? session?.sessionId;
  const persistBounded = async (candidate: SessionObserverDigest): Promise<boolean> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (params.stillCurrent?.() === false) {
        return false;
      }
      try {
        return await params.persistDigest({
          sessionKey,
          sessionId,
          agentId,
          digest: candidate,
          stillCurrent: params.stillCurrent,
        });
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  };
  if (previous.health === health) {
    // The live broadcast already matched the terminal health; only the durable
    // entry can lag behind the persist throttle. Catch it up without rebroadcast.
    if (previous.revision > (session?.observerDigest?.revision ?? 0)) {
      await persistBounded(previous);
    }
    return undefined;
  }
  const digest: SessionObserverDigest = {
    ...previous,
    sessionKey,
    runId,
    health,
    revision: previous.revision + 1,
    updatedAt: params.now(),
  };
  // A rejected write (reset session, newer stored revision) must not surface
  // to watchers as a committed terminal status.
  return (await persistBounded(digest)) ? digest : undefined;
}

export function buildSessionObserverPrompt(
  state: Pick<SessionObserverState, "previousDigest" | "planProgress">,
  notes: readonly string[],
): string {
  return JSON.stringify({
    previousDigest: state.previousDigest ?? null,
    newNotes: notes,
    planProgress: state.planProgress ?? null,
  });
}

/** Validates strict model JSON and applies the protocol's hard string caps. */
export function normalizeSessionObserverModelOutput(text: string): {
  headline: string;
  assessment?: string;
  health: SessionObserverHealth;
  planProgress?: SessionObserverPlanProgress;
} | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim()) as unknown;
  } catch {
    return null;
  }
  const result = ModelDigestSchema.safeParse(parsed);
  if (!result.success) {
    return null;
  }
  const headline = sanitizeSessionObserverModelText(result.data.headline, HEADLINE_MAX_CHARS);
  const assessment = result.data.assessment
    ? sanitizeSessionObserverModelText(result.data.assessment, ASSESSMENT_MAX_CHARS)
    : undefined;
  if (!headline || (result.data.assessment && !assessment)) {
    return null;
  }
  return {
    headline,
    ...(assessment ? { assessment } : {}),
    health: result.data.health,
    ...(result.data.planProgress ? { planProgress: result.data.planProgress } : {}),
  };
}
