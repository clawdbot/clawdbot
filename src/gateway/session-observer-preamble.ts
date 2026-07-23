import type { SessionObserverDigest } from "../../packages/gateway-protocol/src/schema/sessions.js";
import { normalizeSessionPreambleText } from "../agents/session-preamble.js";
import type { SessionObserverEvent } from "./session-observer-contract.js";
import type { SessionObserverState } from "./session-observer-model.js";

const PREAMBLE_HEADLINE_MAX_CHARS = 120;
const PREAMBLE_PUBLISH_INTERVAL_MS = 2_000;

type PreambleEntry = {
  headline: string;
  lastPublishedAt: number;
  published: boolean;
  timer?: ReturnType<typeof setTimeout>;
  updatedAt: number;
};

export function createSessionObserverPreamblePublisher(params: {
  now: () => number;
  setTimeoutFn: typeof setTimeout;
  clearTimeoutFn: typeof clearTimeout;
  isCurrent: (state: SessionObserverState) => boolean;
  publish: (state: SessionObserverState, digest: SessionObserverDigest) => void;
}) {
  const entries = new Map<SessionObserverState, PreambleEntry>();
  const generations = new WeakMap<SessionObserverState, number>();

  const clear = (state: SessionObserverState): void => {
    const entry = entries.get(state);
    if (entry?.timer) {
      params.clearTimeoutFn(entry.timer);
    }
    entries.delete(state);
  };

  const publish = (state: SessionObserverState, entry: PreambleEntry): void => {
    entry.timer = undefined;
    if (!params.isCurrent(state)) {
      clear(state);
      return;
    }
    const previous = state.previousDigest;
    if (previous?.runId === state.runId && previous.headline === entry.headline) {
      clear(state);
      return;
    }
    state.revision += 1;
    const digest: SessionObserverDigest = {
      sessionKey: state.sessionKey,
      runId: state.runId,
      revision: state.revision,
      updatedAt: Math.max(entry.updatedAt, (previous?.updatedAt ?? -1) + 1),
      headline: entry.headline,
      health:
        previous?.runId === state.runId &&
        previous.health !== "done" &&
        previous.health !== "failed"
          ? previous.health
          : "on-track",
      ...(state.planProgress ? { planProgress: state.planProgress } : {}),
    };
    state.previousDigest = digest;
    entry.lastPublishedAt = params.now();
    entry.published = true;
    params.publish(state, digest);
  };

  return {
    handle(state: SessionObserverState, event: SessionObserverEvent): boolean {
      if (event.stream !== "item" || event.data.kind !== "preamble") {
        return false;
      }
      const headline = normalizeSessionPreambleText(
        event.data.progressText,
        PREAMBLE_HEADLINE_MAX_CHARS,
      );
      if (!headline) {
        return true;
      }
      const existing = entries.get(state);
      const previousHeadline =
        state.lastPreambleHeadline ??
        (state.previousDigest?.runId === state.runId ? state.previousDigest.headline : "");
      if (!existing && previousHeadline === headline) {
        return true;
      }
      const entry = existing ?? {
        headline: "",
        lastPublishedAt: 0,
        published: false,
        updatedAt: event.ts,
      };
      if (previousHeadline !== headline) {
        generations.set(state, (generations.get(state) ?? 0) + 1);
      }
      state.lastPreambleHeadline = headline;
      entry.headline = headline;
      entry.updatedAt = event.ts;
      entries.set(state, entry);

      const elapsed = params.now() - entry.lastPublishedAt;
      if (!entry.published || elapsed >= PREAMBLE_PUBLISH_INTERVAL_MS) {
        if (entry.timer) {
          params.clearTimeoutFn(entry.timer);
        }
        publish(state, entry);
      } else if (!entry.timer) {
        entry.timer = params.setTimeoutFn(
          () => publish(state, entry),
          PREAMBLE_PUBLISH_INTERVAL_MS - elapsed,
        );
        entry.timer.unref?.();
      }
      return true;
    },
    generation(state: SessionObserverState): number {
      return generations.get(state) ?? 0;
    },
    flush(state: SessionObserverState): void {
      const entry = entries.get(state);
      if (entry) {
        if (entry.timer) {
          params.clearTimeoutFn(entry.timer);
        }
        publish(state, entry);
      }
    },
    clear,
    dispose(): void {
      for (const state of entries.keys()) {
        clear(state);
      }
    },
  };
}
