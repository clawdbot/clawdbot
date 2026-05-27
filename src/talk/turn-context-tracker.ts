const DEFAULT_REALTIME_VOICE_TURN_CONTEXT_LIMIT = 32;
const DEFAULT_REALTIME_VOICE_IGNORED_CONTEXT_TTL_MS = 10_000;

export type RealtimeVoiceTurnContextTrackerOptions = {
  limit?: number;
  ignoredContextTtlMs?: number;
  now?: () => number;
  deferUntilAudio?: boolean;
};

export type RealtimeVoiceTurnContextHandle<
  TContext,
  TExtra extends object = Record<never, never>,
> = TExtra & {
  id: string;
  context: TContext;
  hasAudio: boolean;
  closed: boolean;
  startedAt: number;
  lastAudioAt?: number;
};

type RealtimeVoiceTurnContextOpenArgs<TExtra extends object> = keyof TExtra extends never
  ? [extra?: TExtra]
  : [extra: TExtra];

export type RealtimeVoiceTurnContextTracker<
  TContext,
  TExtra extends object = Record<never, never>,
> = {
  open(
    context: TContext,
    ...extra: RealtimeVoiceTurnContextOpenArgs<TExtra>
  ): RealtimeVoiceTurnContextHandle<TContext, TExtra>;
  markAudio(handle: RealtimeVoiceTurnContextHandle<TContext, TExtra>): void;
  close(handle: RealtimeVoiceTurnContextHandle<TContext, TExtra>): void;
  consumeAudioContext(): TContext | undefined;
  peekAudioTurn(): RealtimeVoiceTurnContextHandle<TContext, TExtra> | undefined;
  hasAudioContext(): boolean;
  rememberIgnoredContext(context: TContext | undefined): void;
  consumeIgnoredContext(): TContext | undefined;
  size(): number;
  clear(): void;
};

type RecentIgnoredContext<TContext> = {
  context: TContext;
  createdAt: number;
};

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.floor(value));
}

export function createRealtimeVoiceTurnContextTracker<
  TContext,
  TExtra extends object = Record<never, never>,
>(
  options: RealtimeVoiceTurnContextTrackerOptions = {},
): RealtimeVoiceTurnContextTracker<TContext, TExtra> {
  const turns: RealtimeVoiceTurnContextHandle<TContext, TExtra>[] = [];
  let recentIgnoredContext: RecentIgnoredContext<TContext> | undefined;
  let nextId = 0;
  const owner = Symbol("realtimeVoiceTurnContextTracker");
  const now = options.now ?? Date.now;
  const limit = normalizeNonNegativeInteger(
    options.limit,
    DEFAULT_REALTIME_VOICE_TURN_CONTEXT_LIMIT,
  );
  const ignoredContextTtlMs = normalizeNonNegativeInteger(
    options.ignoredContextTtlMs,
    DEFAULT_REALTIME_VOICE_IGNORED_CONTEXT_TTL_MS,
  );
  const deferUntilAudio = options.deferUntilAudio === true;

  const prune = () => {
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index];
      if (turn?.closed && !turn.hasAudio) {
        turns.splice(index, 1);
      }
    }
    while (turns.length > limit) {
      const completedIndex = turns.findIndex((turn) => turn.closed);
      turns.splice(Math.max(completedIndex, 0), 1);
    }
  };

  const expireClosedTurnsBeforeLaterAudio = () => {
    let hasLaterAudio = false;
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index];
      if (!turn?.hasAudio) {
        continue;
      }
      if (turn.closed && hasLaterAudio) {
        turns.splice(index, 1);
        continue;
      }
      hasLaterAudio = true;
    }
  };

  const prepareForAudioContextRead = () => {
    prune();
    expireClosedTurnsBeforeLaterAudio();
  };

  const owns = (handle: RealtimeVoiceTurnContextHandle<TContext, TExtra>) =>
    (
      handle as RealtimeVoiceTurnContextHandle<TContext, TExtra> & {
        [owner]?: true;
      }
    )[owner] === true;

  return {
    open(context, ...extra) {
      const startedAt = now();
      const handle: RealtimeVoiceTurnContextHandle<TContext, TExtra> = {
        ...(extra[0] ?? ({} as TExtra)),
        [owner]: true,
        id: `realtime-turn:${startedAt}:${++nextId}`,
        context,
        hasAudio: false,
        closed: false,
        startedAt,
      };
      if (!deferUntilAudio) {
        turns.push(handle);
        prune();
      }
      return handle;
    },
    markAudio(handle) {
      if (!owns(handle)) {
        return;
      }
      handle.hasAudio = true;
      handle.lastAudioAt = now();
      if (!turns.includes(handle)) {
        turns.push(handle);
        prune();
        return;
      }
    },
    close(handle) {
      if (!owns(handle)) {
        return;
      }
      handle.closed = true;
      if (!turns.includes(handle)) {
        return;
      }
      prune();
    },
    consumeAudioContext() {
      prepareForAudioContextRead();
      const index = turns.findIndex((turn) => turn.hasAudio);
      if (index < 0) {
        return undefined;
      }
      const [turn] = turns.splice(index, 1);
      prune();
      return turn?.context;
    },
    peekAudioTurn() {
      prepareForAudioContextRead();
      return turns.find((turn) => turn.hasAudio);
    },
    hasAudioContext() {
      prepareForAudioContextRead();
      return turns.some((turn) => turn.hasAudio);
    },
    rememberIgnoredContext(context) {
      if (context === undefined) {
        return;
      }
      recentIgnoredContext = { context, createdAt: now() };
    },
    consumeIgnoredContext() {
      const recent = recentIgnoredContext;
      recentIgnoredContext = undefined;
      if (!recent || now() - recent.createdAt > ignoredContextTtlMs) {
        return undefined;
      }
      return recent.context;
    },
    size() {
      prune();
      return turns.length;
    },
    clear() {
      turns.length = 0;
      recentIgnoredContext = undefined;
    },
  };
}
