import { AsyncLocalStorage } from "node:async_hooks";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { runWithoutOwnedSessionTranscriptWrites } from "../config/sessions/transcript-write-context.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { normalizeHeartbeatWakeReason } from "./heartbeat-reason.js";
import type { HeartbeatRunResult, HeartbeatWakeRequest } from "./heartbeat-wake-contracts.js";

type SessionEventWakeResult = HeartbeatRunResult;
type SessionEventWakeRequest = HeartbeatWakeRequest;
type WakeHandler = (
  request: SessionEventWakeRequest,
  signal: AbortSignal,
) => Promise<SessionEventWakeResult>;
export type SessionEventWakeWaitOptions = {
  abortSignal?: AbortSignal;
  /** Detach this waiter while the queue retains the wake at its retry deadline. */
  stopWaitingOnRetry?: (
    result: Extract<SessionEventWakeResult, { status: "skipped" }>,
    retryAtMs: number,
  ) => boolean;
};
type Settlement = {
  active: boolean;
  settle: (result: SessionEventWakeResult) => void;
  stopWaitingOnRetry?: SessionEventWakeWaitOptions["stopWaitingOnRetry"];
};
type PendingWake = SessionEventWakeRequest & {
  sequence: number;
  barrierSequence?: number;
  requestedAt: number;
  readyAt: number;
  notBefore: number;
  settlements: Settlement[];
};
type WakeGroup = {
  task?: PendingWake;
  scheduled?: PendingWake;
  event?: PendingWake;
  blockedUntil: number;
};
type ActiveWake = { generation: number; controller: AbortController };
type RequestOptions = Omit<SessionEventWakeRequest, "retainedWork"> & { coalesceMs?: number };

const SLOTS = ["task", "scheduled", "event"] as const;
const COALESCE_MS = 250;
const RETRY_MS = 1_000;
export const SESSION_EVENT_IDLE_RETRY_MS = 60_000;
const MAX_ACTIVE_TARGETS = 4;
const GLOBAL_TARGET = "::";
const RETRY_REASONS = new Set([
  "active-run",
  "requests-in-flight",
  "cron-in-progress",
  "preempted",
  "channel-not-ready",
]);
const GUARD_REASONS = new Set(["not-due", "min-spacing", "flood"]);

export function isRetryableSessionEventWakeReason(reason: string): boolean {
  return RETRY_REASONS.has(reason);
}

function priority(wake: SessionEventWakeRequest): number {
  return wake.intent === "manual" || wake.intent === "immediate"
    ? 3
    : wake.source === "retry" || wake.reason === "retry"
      ? 0
      : wake.intent === "scheduled" || wake.source === "interval" || wake.reason === "interval"
        ? 1
        : 2;
}

function merge(previous: PendingWake, next: PendingWake): PendingWake {
  const preferred =
    (previous.intent === "task") !== (next.intent === "task")
      ? previous.intent === "task"
        ? previous
        : next
      : priority(next) > priority(previous) ||
          (priority(next) === priority(previous) && next.requestedAt >= previous.requestedAt)
        ? next
        : previous;
  const other = preferred === previous ? next : previous;
  const tasks = new Map(
    [...(previous.tasks ?? []), ...(next.tasks ?? [])].map((task) => [task.jobId, task]),
  );
  const bypass =
    (preferred.intent === "manual" || preferred.intent === "immediate") && !preferred.retainedWork;
  return {
    ...preferred,
    // A scheduled reason must not discard the event's guard-retry semantics.
    intent: preferred.intent === "scheduled" ? other.intent : preferred.intent,
    sequence: Math.min(previous.sequence, next.sequence),
    barrierSequence:
      previous.barrierSequence === undefined
        ? next.barrierSequence
        : Math.min(previous.barrierSequence, next.barrierSequence ?? Infinity),
    requestedAt:
      !bypass && (previous.notBefore || next.notBefore)
        ? Math.min(previous.requestedAt, next.requestedAt)
        : preferred.requestedAt,
    readyAt: Math.min(previous.readyAt, next.readyAt),
    notBefore: bypass ? 0 : Math.max(previous.notBefore, next.notBefore),
    heartbeat: preferred.heartbeat ?? other.heartbeat,
    scheduledEveryMs: preferred.scheduledEveryMs ?? other.scheduledEveryMs,
    tasks: tasks.size
      ? [...tasks.values()].toSorted((left, right) => left.jobId.localeCompare(right.jobId))
      : undefined,
    retainedWork: !bypass && (previous.retainedWork || next.retainedWork),
    settlements: [...previous.settlements, ...next.settlements].filter((entry) => entry.active),
  };
}

function targetKey(request: SessionEventWakeRequest): string {
  if (!request.sessionKey || (request.sessionKey === "global" && !request.agentId)) {
    return `${request.agentId ?? ""}::`;
  }
  // Namespaced sessions carry their owner; shared keys need the agent store too.
  return parseAgentSessionKey(request.sessionKey)
    ? `::${request.sessionKey}`
    : `${request.agentId ?? ""}::${request.sessionKey}`;
}

function shouldRetain(
  wake: PendingWake,
  result: Extract<SessionEventWakeResult, { status: "skipped" }>,
): boolean {
  return (
    RETRY_REASONS.has(result.reason) ||
    (GUARD_REASONS.has(result.reason) &&
      Boolean(
        wake.tasks?.length ||
        wake.intent === "task" ||
        wake.intent === "event" ||
        wake.intent === "immediate",
      ))
  );
}

function createSessionEventWakeRuntime() {
  const pending = new Map<string, WakeGroup>();
  const active = new Map<string, ActiveWake>();
  const abortSignals = new AsyncLocalStorage<AbortSignal>();
  let handler: WakeHandler | null = null;
  let generation = 0;
  let sequence = 0;
  let timer: NodeJS.Timeout | undefined;
  let timerDueAt = 0;
  let enabled = true;

  function enqueue(wake: PendingWake, blockedUntil = 0): void {
    const key = targetKey(wake);
    const group = pending.get(key) ?? { blockedUntil: 0 };
    const slot =
      wake.intent === "task" ? "task" : wake.intent === "scheduled" ? "scheduled" : "event";
    group[slot] = group[slot] ? merge(group[slot], wake) : wake;
    group.blockedUntil = Math.max(group.blockedUntil, blockedUntil);
    pending.set(key, group);
  }

  function isReady(group: WakeGroup | undefined, now: number): boolean {
    return Boolean(
      group &&
      group.blockedUntil <= now &&
      SLOTS.some((slot) => {
        const wake = group[slot];
        return wake && Math.max(wake.readyAt, wake.notBefore) <= now;
      }),
    );
  }

  function afterBarrier(key: string, wake: PendingWake, global: WakeGroup | undefined): boolean {
    const barrier =
      global?.event?.intent === "immediate" ? global.event.barrierSequence : undefined;
    return key !== GLOBAL_TARGET && barrier !== undefined && wake.sequence >= barrier;
  }

  function takeReady(): Array<{ key: string; wakes: PendingWake[] }> {
    if (active.has(GLOBAL_TARGET)) {
      return [];
    }
    const now = performance.now();
    const global = pending.get(GLOBAL_TARGET);
    const globalReady = isReady(global, now);
    if (globalReady && active.size) {
      return [];
    }
    const event = global?.event;
    const flush =
      globalReady &&
      event?.intent === "immediate" &&
      Math.max(event.readyAt, event.notBefore) <= now;
    const candidates =
      globalReady && global
        ? flush
          ? [...pending].filter(([key]) => key !== GLOBAL_TARGET).concat([[GLOBAL_TARGET, global]])
          : [[GLOBAL_TARGET, global] as const]
        : pending;
    const ready: Array<{ key: string; wakes: PendingWake[] }> = [];
    for (const [key, group] of candidates) {
      if (ready.length + active.size >= MAX_ACTIVE_TARGETS) {
        break;
      }
      if (
        active.has(key) ||
        group.blockedUntil > now ||
        (key === GLOBAL_TARGET && (active.size || ready.length))
      ) {
        continue;
      }
      const picked: Partial<Record<(typeof SLOTS)[number], PendingWake>> = {};
      for (const slot of SLOTS) {
        const wake = group[slot];
        if (
          wake &&
          !afterBarrier(key, wake, global) &&
          wake.notBefore <= now &&
          (flush || wake.readyAt <= now)
        ) {
          picked[slot] = wake;
          delete group[slot];
        }
      }
      if (!SLOTS.some((slot) => group[slot])) {
        pending.delete(key);
      }
      let wakes: PendingWake[];
      if (picked.task) {
        // A task turn includes monitor scratch, so it consumes a coincident base tick.
        const task = picked.scheduled ? merge(picked.scheduled, picked.task) : picked.task;
        wakes = picked.event
          ? [task, picked.event].toSorted(
              (left, right) =>
                Number(Boolean(right.retainedWork)) - Number(Boolean(left.retainedWork)) ||
                left.requestedAt - right.requestedAt,
            )
          : [task];
      } else if (picked.event) {
        wakes = [picked.scheduled ? merge(picked.scheduled, picked.event) : picked.event];
      } else {
        wakes = picked.scheduled ? [picked.scheduled] : [];
      }
      if (wakes.length) {
        ready.push({ key, wakes });
      }
    }
    return ready;
  }

  function settle(wake: PendingWake, result: SessionEventWakeResult): void {
    for (const entry of wake.settlements) {
      entry.settle(result);
    }
  }

  function retry(
    wake: PendingWake,
    result?: Extract<SessionEventWakeResult, { status: "skipped" }>,
  ): void {
    const idleGrace =
      result &&
      (result.reason === "preempted" ||
        result.reason === "channel-not-ready" ||
        ((result.reason === "requests-in-flight" || result.reason === "active-run") &&
          (wake.intent === "scheduled" || wake.intent === "task")));
    const guard = idleGrace || (result && GUARD_REASONS.has(result.reason));
    const delay =
      result?.retryAtMs !== undefined
        ? Math.max(0, result.retryAtMs - Date.now())
        : idleGrace
          ? SESSION_EVENT_IDLE_RETRY_MS
          : RETRY_MS;
    const deadline = performance.now() + delay;
    if (result) {
      const retryAtMs = Date.now() + delay;
      for (const entry of wake.settlements) {
        if (entry.active && entry.stopWaitingOnRetry?.(result, retryAtMs)) {
          entry.settle(result);
        }
      }
    }
    enqueue(
      {
        ...wake,
        readyAt: performance.now(),
        notBefore: guard ? deadline : 0,
        retainedWork: guard ? true : wake.retainedWork,
      },
      guard ? 0 : deadline,
    );
  }

  function handOff(wakes: PendingWake[], start: number): void {
    for (const wake of wakes.slice(start)) {
      enqueue(wake);
    }
  }

  async function dispatch(
    key: string,
    wakes: PendingWake[],
    owner: ActiveWake,
    run: WakeHandler,
  ): Promise<void> {
    const signal = owner.controller.signal;
    try {
      for (const [index, wake] of wakes.entries()) {
        // Busy backoff also owns wakes selected before the current attempt began.
        const blockedUntil = pending.get(key)?.blockedUntil ?? 0;
        if (owner.generation !== generation || blockedUntil > performance.now()) {
          handOff(wakes, index);
          return;
        }
        let result: SessionEventWakeResult;
        let onAbort: (() => void) | undefined;
        try {
          result = await runWithGatewayIndependentRootWorkAdmission(() => {
            signal.throwIfAborted();
            // Subscribe before calling the handler: it can synchronously replace its owner.
            const aborted = new Promise<never>((_resolve, reject) => {
              onAbort = () =>
                reject(
                  signal.reason instanceof Error
                    ? signal.reason
                    : new Error("Heartbeat handler was replaced"),
                );
              signal.addEventListener("abort", onAbort, { once: true });
            });
            const request: SessionEventWakeRequest = {
              source: wake.source,
              intent: wake.intent,
              reason: wake.reason,
              ...(wake.agentId ? { agentId: wake.agentId } : {}),
              ...(wake.sessionKey ? { sessionKey: wake.sessionKey } : {}),
              ...(wake.heartbeat ? { heartbeat: wake.heartbeat } : {}),
              ...(wake.scheduledEveryMs !== undefined
                ? { scheduledEveryMs: wake.scheduledEveryMs }
                : {}),
              ...(wake.tasks ? { tasks: wake.tasks } : {}),
              ...(wake.retainedWork ? { retainedWork: true } : {}),
            };
            // A synchronous handler throw must not leave the abort promise unobserved.
            const running = abortSignals.run(signal, async () => run(request, signal));
            return Promise.race([running, aborted]);
          }, "heartbeat:wake");
        } catch {
          if (owner.generation === generation) {
            retry(wake);
          } else {
            enqueue(wake);
          }
          continue;
        } finally {
          if (onAbort) {
            signal.removeEventListener("abort", onAbort);
          }
        }
        if (result.status === "skipped" && shouldRetain(wake, result)) {
          if (owner.generation === generation) {
            retry(wake, result);
          } else {
            enqueue(wake);
          }
        } else {
          settle(wake, result);
        }
      }
    } finally {
      if (active.get(key) === owner) {
        active.delete(key);
      }
      schedulePending();
    }
  }

  function scheduleAt(dueAt: number): void {
    if (!handler || (timer && timerDueAt <= dueAt)) {
      return;
    }
    clearTimeout(timer);
    timerDueAt = dueAt;
    timer = setTimeout(
      () => {
        timer = undefined;
        const run = handler;
        if (!run) {
          return;
        }
        // Register the whole batch first so replacement retires unstarted work too.
        const ready = takeReady().map(({ key, wakes }) => {
          const owner = { generation, controller: new AbortController() };
          active.set(key, owner);
          return { key, wakes, owner };
        });
        for (const { key, wakes, owner } of ready) {
          void dispatch(key, wakes, owner, run);
        }
        schedulePending();
      },
      resolveTimerTimeoutMs(Math.max(0, dueAt - performance.now()), COALESCE_MS, 0),
    );
    timer.unref?.();
  }

  function schedulePending(readyDelayMs = 0): void {
    if (active.size >= MAX_ACTIVE_TARGETS || active.has(GLOBAL_TARGET)) {
      return;
    }
    const now = performance.now();
    const global = pending.get(GLOBAL_TARGET);
    if (active.size && isReady(global, now)) {
      return;
    }
    let earliest = Infinity;
    for (const [key, group] of pending) {
      if (active.has(key)) {
        continue;
      }
      for (const slot of SLOTS) {
        const wake = group[slot];
        if (wake && !afterBarrier(key, wake, global)) {
          earliest = Math.min(earliest, Math.max(wake.readyAt, wake.notBefore, group.blockedUntil));
        }
      }
    }
    if (Number.isFinite(earliest)) {
      scheduleAt(earliest <= now ? now + readyDelayMs : earliest);
    }
  }

  function setSessionEventWakeHandler(next: WakeHandler | null): () => void {
    const previousGeneration = generation;
    generation += 1;
    const ownedGeneration = generation;
    handler = next;
    clearTimeout(timer);
    timer = undefined;
    if (next) {
      for (const group of pending.values()) {
        group.blockedUntil = 0;
        for (const slot of SLOTS) {
          const wake = group[slot];
          if (wake) {
            wake.notBefore = 0;
            wake.retainedWork = false;
          }
        }
      }
    }
    // Abort listeners can register another handler; retire only the replaced generation.
    for (const owner of active.values()) {
      if (owner.generation === previousGeneration) {
        owner.controller.abort();
      }
    }
    schedulePending(COALESCE_MS);
    return () => {
      if (generation === ownedGeneration) {
        setSessionEventWakeHandler(null);
      }
    };
  }

  function enqueueRequest(options: RequestOptions, settlement?: Settlement): void {
    const now = performance.now();
    const { coalesceMs, ...wake } = options;
    const normalized = {
      ...wake,
      agentId: normalizeOptionalString(wake.agentId),
      sessionKey: normalizeOptionalString(wake.sessionKey),
      reason: normalizeHeartbeatWakeReason(wake.reason),
    };
    const nextSequence = ++sequence;
    runWithoutOwnedSessionTranscriptWrites(() => {
      const pendingWake: PendingWake = {
        ...normalized,
        sequence: nextSequence,
        barrierSequence:
          targetKey(normalized) === GLOBAL_TARGET && wake.intent === "immediate"
            ? nextSequence
            : undefined,
        requestedAt: now,
        readyAt: now + resolveTimerTimeoutMs(coalesceMs, COALESCE_MS, 0),
        notBefore: 0,
        settlements: settlement ? [settlement] : [],
      };
      enqueue(pendingWake);
      schedulePending();
    });
  }

  function requestSessionEventWake(options: RequestOptions): void {
    enqueueRequest(options);
  }
  function requestSessionEventWakeAndWait(
    options: RequestOptions,
    lifecycle?: SessionEventWakeWaitOptions,
  ): Promise<SessionEventWakeResult> {
    return new Promise((resolve) => {
      const signal = lifecycle?.abortSignal;
      const settlement: Settlement = {
        active: true,
        stopWaitingOnRetry: lifecycle?.stopWaitingOnRetry,
        settle: (result) => {
          if (settlement.active) {
            settlement.active = false;
            signal?.removeEventListener("abort", onAbort);
            resolve(result);
          }
        },
      };
      const onAbort = () =>
        settlement.settle({ status: "failed", reason: "heartbeat wake cancelled" });
      if (signal?.aborted) {
        onAbort();
      } else {
        signal?.addEventListener("abort", onAbort, { once: true });
        enqueueRequest(options, settlement);
      }
    });
  }

  return {
    setSessionEventWakeHandler,
    requestSessionEventWake,
    requestSessionEventWakeAndWait,
    getSessionEventWakeAbortSignal: () => abortSignals.getStore(),
    areSessionEventWakesEnabled: () => enabled,
    setSessionEventWakesEnabled: (value: boolean) => {
      enabled = value;
    },
  };
}

// Gateway and source-transformed plugins share the entire owner, including timer and disposal.
export const {
  setSessionEventWakeHandler,
  requestSessionEventWake,
  requestSessionEventWakeAndWait,
  getSessionEventWakeAbortSignal,
  areSessionEventWakesEnabled,
  setSessionEventWakesEnabled,
} = resolveGlobalSingleton(Symbol.for("openclaw.sessionEventWake"), createSessionEventWakeRuntime);
