import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import type { RealtimeVoiceCloseDisposition } from "openclaw/plugin-sdk/realtime-voice";
import type { RawData } from "ws";
import type { OpenAIQuicksilverSocket } from "./realtime-quicksilver-sideband.js";

const REALTIME_CLEANUP_RETRY_DELAYS_MS = [1_000, 5_000];

export type OpenAIRealtimeSession = {
  closing?: Promise<void>;
  initialRetirement?: Promise<void>;
  detach?: () => void;
  retire?: (error?: Error) => void;
  dispose?: () => Promise<void> | void;
  retryTimer?: NodeJS.Timeout;
  retryIndex?: number;
  handleFrame?: (data: RawData, isBinary: boolean) => void;
  socket?: OpenAIQuicksilverSocket;
  timer?: NodeJS.Timeout;
  token: string;
};

type SessionLease = {
  activeSessions: ReadonlyMap<string, OpenAIRealtimeSession>;
  retiringSessions: ReadonlyMap<string, OpenAIRealtimeSession>;
  adopt: (token: string, wire: Omit<OpenAIRealtimeSession, "token">) => OpenAIRealtimeSession;
  close: (
    session: OpenAIRealtimeSession,
    disposition?: RealtimeVoiceCloseDisposition,
    error?: Error,
    retry?: boolean,
  ) => Promise<void>;
  expireIn: (session: OpenAIRealtimeSession, ttlMs: number) => void;
  deliverAnswer: (
    session: OpenAIRealtimeSession,
    signal: AbortSignal,
    deliver: () => Promise<boolean>,
  ) => Promise<void>;
};

export function createOpenAIRealtimeSessionLease(params: {
  logger: Pick<PluginLogger, "warn">;
  releaseReservation: (token: string) => void;
  onSettled: () => void;
}): SessionLease {
  const activeSessions = new Map<string, OpenAIRealtimeSession>();
  const retiringSessions = new Map<string, OpenAIRealtimeSession>();
  const activeSessionLease = {
    adopt: (token: string, wire: Omit<OpenAIRealtimeSession, "token">): OpenAIRealtimeSession => {
      const session = { token, ...wire };
      activeSessions.set(token, session);
      return session;
    },
    close: (
      session: OpenAIRealtimeSession,
      disposition: RealtimeVoiceCloseDisposition = "abort",
      error?: Error,
      retry = false,
    ): Promise<void> => {
      if (session.closing) {
        return session.closing;
      }
      if (
        activeSessions.get(session.token) !== session &&
        retiringSessions.get(session.token) !== session
      ) {
        return Promise.resolve();
      }
      clearTimeout(session.retryTimer);
      if (!retry) {
        session.retryIndex = 0;
      }
      clearTimeout(session.timer);
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const closing = new Promise<void>((accept, fail) => {
        resolve = accept;
        reject = fail;
      });
      // Retirement removes admission before callbacks; the cleanup capability and
      // reservation remain owned until the remote operation actually settles.
      session.closing = closing;
      if (activeSessions.delete(session.token)) {
        session.initialRetirement = closing;
        retiringSessions.set(session.token, session);
        try {
          if (disposition === "detach") {
            session.detach?.();
          }
          session.retire?.(error);
        } catch {
          params.logger.warn("OpenAI realtime local retirement failed; attempting remote cleanup");
        }
      }
      const complete = () => {
        retiringSessions.delete(session.token);
        params.releaseReservation(session.token);
        session.closing = undefined;
        resolve();
        params.onSettled();
      };
      const failed = (failure: unknown) => {
        session.closing = undefined;
        const delay = REALTIME_CLEANUP_RETRY_DELAYS_MS[session.retryIndex ?? 0];
        if (delay !== undefined) {
          session.retryIndex = (session.retryIndex ?? 0) + 1;
          session.retryTimer = setTimeout(() => {
            void activeSessionLease.close(session, "abort", undefined, true).catch(() => undefined);
          }, delay);
          session.retryTimer.unref?.();
          params.logger.warn("OpenAI realtime remote cleanup failed; retry remains scheduled");
        } else {
          params.logger.warn(
            "OpenAI realtime cleanup INCOMPLETE after three attempts; capacity remains reserved. " +
              "A later broker/plugin cleanup can retry. Restarting loses this in-memory obligation.",
          );
        }
        reject(failure);
      };
      try {
        const disposal = session.dispose?.();
        if (disposal) {
          void Promise.resolve(disposal).then(complete, failed);
        } else {
          complete();
        }
      } catch (failure) {
        failed(failure);
      }
      return closing;
    },
    expireIn: (session: OpenAIRealtimeSession, ttlMs: number) => {
      clearTimeout(session.timer);
      session.timer = setTimeout(
        () => void activeSessionLease.close(session).catch(() => undefined),
        Math.max(0, ttlMs),
      );
      session.timer.unref?.();
    },
    deliverAnswer: async (
      session: OpenAIRealtimeSession,
      signal: AbortSignal,
      deliver: () => Promise<boolean>,
    ) => {
      if (!(await deliver()) || signal.aborted) {
        // Late delivery joins retirement without resetting a failed attempt's retry budget.
        await (session.initialRetirement ?? activeSessionLease.close(session));
      }
    },
  };
  return { ...activeSessionLease, activeSessions, retiringSessions };
}
