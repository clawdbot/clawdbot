/** Process-wide listener counts used to avoid telemetry work without consumers. */

const DIAGNOSTIC_EVENT_LISTENER_PRESENCE_KEY = Symbol.for(
  "openclaw.diagnosticEventListenerPresence.v1",
);

type DiagnosticEventListenerPresence = {
  broadInterestCount: number;
  eventInterestDeltas: Map<string, number>;
  marker: symbol;
  internalCount: number;
  trustedCount: number;
};

function getDiagnosticEventListenerPresence(): DiagnosticEventListenerPresence {
  const globalRecord = globalThis as Record<PropertyKey, unknown>;
  const existing = globalRecord[DIAGNOSTIC_EVENT_LISTENER_PRESENCE_KEY];
  if (
    existing &&
    typeof existing === "object" &&
    (existing as Partial<DiagnosticEventListenerPresence>).marker ===
      DIAGNOSTIC_EVENT_LISTENER_PRESENCE_KEY
  ) {
    const state = existing as DiagnosticEventListenerPresence;
    state.broadInterestCount ??= 0;
    state.eventInterestDeltas ??= new Map();
    return state;
  }
  const state: DiagnosticEventListenerPresence = {
    broadInterestCount: 0,
    eventInterestDeltas: new Map(),
    marker: DIAGNOSTIC_EVENT_LISTENER_PRESENCE_KEY,
    internalCount: 0,
    trustedCount: 0,
  };
  Object.defineProperty(globalThis, DIAGNOSTIC_EVENT_LISTENER_PRESENCE_KEY, {
    configurable: true,
    enumerable: false,
    value: state,
    writable: false,
  });
  return state;
}

export type InternalDiagnosticEventInterest<EventType extends string = string> = Readonly<{
  include?: readonly EventType[];
  exclude?: readonly EventType[];
}>;

function updateEventInterestDelta(
  state: DiagnosticEventListenerPresence,
  type: string,
  delta: number,
): void {
  const next = (state.eventInterestDeltas.get(type) ?? 0) + delta;
  if (next === 0) {
    state.eventInterestDeltas.delete(type);
  } else {
    state.eventInterestDeltas.set(type, next);
  }
}

export function updateInternalDiagnosticEventInterest(
  interest: InternalDiagnosticEventInterest | undefined,
  delta: 1 | -1,
): void {
  const state = getDiagnosticEventListenerPresence();
  if (interest?.include) {
    for (const type of new Set(interest.include)) {
      if (!interest.exclude?.includes(type)) {
        updateEventInterestDelta(state, type, delta);
      }
    }
    return;
  }
  state.broadInterestCount += delta;
  for (const type of new Set(interest?.exclude ?? [])) {
    updateEventInterestDelta(state, type, -delta);
  }
}

export function hasInternalDiagnosticEventInterest(type: string): boolean {
  const state = getDiagnosticEventListenerPresence();
  return state.broadInterestCount + (state.eventInterestDeltas.get(type) ?? 0) > 0;
}

export function resetInternalDiagnosticEventListenerPresence(): void {
  const state = getDiagnosticEventListenerPresence();
  state.internalCount = 0;
  state.trustedCount = 0;
  state.broadInterestCount = 0;
  state.eventInterestDeltas.clear();
}

export function setInternalDiagnosticEventListenerCounts(
  internalCount: number,
  trustedCount: number,
): void {
  const state = getDiagnosticEventListenerPresence();
  state.internalCount = internalCount;
  state.trustedCount = trustedCount;
}

export function hasInternalDiagnosticEventListeners(): boolean {
  const state = getDiagnosticEventListenerPresence();
  return state.internalCount > 0 || state.trustedCount > 0;
}
