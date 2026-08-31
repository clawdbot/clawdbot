import path from "node:path";
import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { resolveStateDir } from "../config/paths.js";
import { KeyedAsyncQueue } from "../plugin-sdk/keyed-async-queue.js";
import { resolveTranscriptsConfig } from "../transcripts/config.js";
import type {
  TranscriptSessionDescriptor,
  TranscriptSourceStatus,
  TranscriptStartRequest,
  TranscriptsStartResult,
  TranscriptsStopResult,
  TranscriptUtterance,
} from "../transcripts/provider-types.js";
import { sanitizeTranscriptSourceLocator } from "../transcripts/source-locator.js";
import { TranscriptsStore } from "../transcripts/store.js";
import { summarizeTranscripts } from "../transcripts/summary.js";
import { MeetingTranscriptDeliveryError } from "./session-transcript-store.js";
import type { MeetingSessionRecord, MeetingTranscriptLine } from "./session-types.js";
import type {
  MeetingDurableTranscriptBridge,
  MeetingDurableTranscriptsOptions,
  MeetingTranscriptBridgeLogger,
} from "./transcripts-bridge.js";

const CAPTURE_INTERVAL_MS = 5_000;

type ActiveCapture<TSession extends MeetingSessionRecord> = {
  closing: boolean;
  descriptor: TranscriptSessionDescriptor;
  finalCaptureError?: string;
  finalCaptureFailedAt?: string;
  initialized: boolean;
  initializationWarned: boolean;
  polling: boolean;
  runCapture(task: () => Promise<void>): Promise<void>;
  session: TSession;
  timer?: ReturnType<typeof setInterval>;
  utteranceCount: number;
};

type Subscriber = {
  agentId: string;
  deliveredUtteranceIds: Set<string>;
  meetingSessionId: string;
  onStatus?: TranscriptStartRequest["onStatus"];
  onUtterance: TranscriptStartRequest["onUtterance"];
};

function descriptorForSession(
  session: MeetingSessionRecord,
  options: MeetingDurableTranscriptsOptions,
): TranscriptSessionDescriptor {
  return {
    sessionId: session.id,
    title: `${options.providerName} meeting`,
    source: sanitizeTranscriptSourceLocator({
      providerId: options.providerId,
      kind: "live-caption",
      meetingUrl: session.url,
    }),
    startedAt: session.createdAt,
    metadata: {
      agentId: session.agentId,
      meetingSessionId: session.id,
      mode: session.mode,
      participantIdentity: session.participantIdentity,
    },
  };
}

function utteranceFromLine(params: {
  line: MeetingTranscriptLine;
  session: MeetingSessionRecord;
  sequence: number;
}): TranscriptUtterance {
  return {
    id: `${params.session.id}:${params.sequence}`,
    sessionId: params.session.id,
    startedAt: params.line.at,
    speaker: params.line.speaker ? { label: params.line.speaker } : undefined,
    text: params.line.text,
    final: true,
    metadata: {
      agentId: params.session.agentId,
      meetingSessionId: params.session.id,
    },
  };
}

export function createMeetingDurableTranscriptBridge<
  TSession extends MeetingSessionRecord,
>(params: {
  logger: MeetingTranscriptBridgeLogger;
  options: MeetingDurableTranscriptsOptions;
}): MeetingDurableTranscriptBridge<TSession> {
  const config = resolveTranscriptsConfig(params.options.config);
  const stateDir = params.options.stateDir ?? resolveStateDir();
  const store = new TranscriptsStore(path.join(stateDir, "transcripts"), {
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  });
  const captures = new Map<string, ActiveCapture<TSession>>();
  const pendingSubscribers = new Map<string, Subscriber>();
  const subscribers = new Map<string, Subscriber>();
  const lifecycleTasks = new KeyedAsyncQueue();
  const tasks = new KeyedAsyncQueue();

  const reportCaptureError = (sessionId: string, error: unknown) => {
    params.logger.debug?.(
      `[meeting-transcripts] capture ignored session=${sessionId}: ${coerceErrorMessage(error)}`,
    );
  };

  const notifySubscriberStatus = (subscriber: Subscriber, status: TranscriptSourceStatus) => {
    if (!subscriber.onStatus) {
      return;
    }
    try {
      void Promise.resolve(subscriber.onStatus(status)).catch((error: unknown) => {
        params.logger.warn(
          `[meeting-transcripts] subscriber status failed session=${status.sessionId ?? "unknown"}: ${coerceErrorMessage(error)}`,
        );
      });
    } catch (error) {
      params.logger.warn(
        `[meeting-transcripts] subscriber status failed session=${status.sessionId ?? "unknown"}: ${coerceErrorMessage(error)}`,
      );
    }
  };

  return {
    enabled: config.enabled,
    async start(session, capture) {
      await lifecycleTasks.enqueue(session.id, async () => {
        if (!config.enabled || captures.has(session.id)) {
          return;
        }
        const descriptor = descriptorForSession(session, params.options);
        let captureQueue = Promise.resolve();
        const runCapture = async (task: () => Promise<void>) => {
          const result = captureQueue.catch(() => {}).then(task);
          captureQueue = result.then(
            () => undefined,
            () => undefined,
          );
          return await result;
        };
        const active: ActiveCapture<TSession> = {
          closing: false,
          descriptor,
          initialized: false,
          initializationWarned: false,
          polling: false,
          runCapture,
          session,
          utteranceCount: 0,
        };
        captures.set(session.id, active);
        // Start and stop share runLifecycle(session.id), so teardown cannot mark
        // this published capture closing while initialization awaits.
        const initialize = async () => {
          if (active.initialized) {
            return;
          }
          try {
            await store.writeSession(descriptor);
            active.initialized = true;
            active.initializationWarned = false;
          } catch (error) {
            if (!active.initializationWarned) {
              params.logger.warn(
                `[meeting-transcripts] durable capture initialization pending session=${session.id}: ${coerceErrorMessage(error)}`,
              );
              active.initializationWarned = true;
            }
          }
        };
        const timer = setInterval(() => {
          // polling covers both initialize() and capture, so session writes are
          // single-flight too. A skipped tick is followed within CAPTURE_INTERVAL_MS.
          if (active.polling || active.closing) {
            return;
          }
          active.polling = true;
          void initialize()
            .then(async () => await active.runCapture(capture))
            .catch((error: unknown) => reportCaptureError(session.id, error))
            .finally(() => {
              active.polling = false;
            });
        }, CAPTURE_INTERVAL_MS);
        timer.unref?.();
        active.timer = timer;
        active.polling = true;
        try {
          await initialize();
          await active
            .runCapture(capture)
            .catch((error: unknown) => reportCaptureError(session.id, error));
        } finally {
          active.polling = false;
        }
      });
    },
    async ingest(session, lines) {
      const active = captures.get(session.id);
      if (!active || lines.length === 0) {
        return;
      }
      await tasks.enqueue(session.id, async () => {
        for (const line of lines) {
          const sequence = active.utteranceCount;
          const utterance = utteranceFromLine({
            line,
            session,
            sequence,
          });
          await store.appendUtteranceForSession(active.descriptor, utterance);
          for (const [subscriberSessionId, subscriber] of subscribers) {
            if (
              subscriber.meetingSessionId !== session.id ||
              (utterance.id && subscriber.deliveredUtteranceIds.has(utterance.id))
            ) {
              continue;
            }
            const subscriberUtterance = {
              ...utterance,
              id: `${subscriberSessionId}:${utterance.id ?? sequence}`,
              sessionId: subscriberSessionId,
            };
            try {
              await subscriber.onUtterance(subscriberUtterance);
              if (utterance.id) {
                subscriber.deliveredUtteranceIds.add(utterance.id);
              }
            } catch (error) {
              subscribers.delete(subscriberSessionId);
              params.logger.warn(
                `[meeting-transcripts] detached failing subscriber session=${subscriberSessionId}: ${coerceErrorMessage(error)}`,
              );
              notifySubscriberStatus(subscriber, {
                sessionId: subscriberSessionId,
                active: false,
                message: "Detached after transcript delivery failed.",
                source: active.descriptor.source,
              });
            }
          }
          active.utteranceCount += 1;
        }
      });
    },
    async stop(session, finalCapture) {
      const active = await lifecycleTasks.enqueue(session.id, async () => {
        const current = captures.get(session.id);
        if (!current) {
          return undefined;
        }
        current.closing = true;
        if (current.timer) {
          clearInterval(current.timer);
          delete current.timer;
        }
        return current;
      });
      if (!active) {
        return false;
      }
      try {
        let initializationError: Error | undefined;
        if (!active.initialized) {
          try {
            await store.writeSession(active.descriptor);
            active.initialized = true;
          } catch (error) {
            initializationError =
              error instanceof Error
                ? error
                : new Error("could not initialize durable transcript session", { cause: error });
          }
        }
        let deliveryError: MeetingTranscriptDeliveryError | undefined;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            await active.runCapture(finalCapture);
            deliveryError = undefined;
            break;
          } catch (error) {
            if (!(error instanceof MeetingTranscriptDeliveryError)) {
              reportCaptureError(session.id, error);
              active.finalCaptureError = coerceErrorMessage(error);
              active.finalCaptureFailedAt ??= new Date().toISOString();
              deliveryError = undefined;
              break;
            }
            if (error.finalCaptureError !== undefined) {
              active.finalCaptureError = error.finalCaptureError;
              active.finalCaptureFailedAt ??= new Date().toISOString();
            }
            deliveryError = error;
          }
        }
        if (deliveryError) {
          throw deliveryError;
        }
        if (initializationError !== undefined) {
          throw initializationError;
        }
        const finalCaptureError = active.finalCaptureError;
        const stoppedAt = new Date().toISOString();
        const stopped = {
          ...active.descriptor,
          stoppedAt,
          ...(finalCaptureError !== undefined
            ? {
                metadata: {
                  ...active.descriptor.metadata,
                  finalCaptureError,
                  finalCaptureFailedAt: active.finalCaptureFailedAt,
                },
              }
            : {}),
        };
        try {
          await tasks.enqueue(session.id, async () => {
            await store.writeSession(stopped);
            const utterances = await store.readUtterancesForSession(stopped, {
              maxUtterances: config.maxUtterances,
            });
            await store.writeSummary(
              summarizeTranscripts({ session: stopped, utterances }),
              stopped,
            );
          });
        } catch (error) {
          params.logger.warn(
            `[meeting-transcripts] could not finalize durable capture session=${session.id}: ${coerceErrorMessage(error)}`,
          );
          throw error;
        }
      } finally {
        // Final delivery drains before retirement, even if durable finalization
        // needs recovery. Subscribers no longer receive this capture's audio.
        await tasks.enqueue(session.id, async () => {
          for (const [subscriberSessionId, subscriber] of subscribers) {
            if (subscriber.meetingSessionId !== session.id) {
              continue;
            }
            notifySubscriberStatus(subscriber, {
              sessionId: subscriberSessionId,
              active: false,
              message: `${params.options.providerName} meeting capture ended.`,
              source: active.descriptor.source,
            });
            subscribers.delete(subscriberSessionId);
          }
        });
      }
      captures.delete(session.id);
      return true;
    },
    async attach(session, request): Promise<TranscriptsStartResult> {
      const active = captures.get(session.id);
      if (!config.enabled || !active || active.closing) {
        return {
          ok: false,
          error: `${params.options.providerName} meeting capture is not active.`,
        };
      }
      if (
        subscribers.has(request.session.sessionId) ||
        pendingSubscribers.has(request.session.sessionId)
      ) {
        return {
          ok: false,
          error: `transcripts session already attached: ${request.session.sessionId}`,
        };
      }
      let attached = false;
      const subscriber: Subscriber = {
        agentId: session.agentId,
        meetingSessionId: session.id,
        deliveredUtteranceIds: new Set(),
        onStatus: request.onStatus,
        onUtterance: request.onUtterance,
      };
      pendingSubscribers.set(request.session.sessionId, subscriber);
      try {
        await tasks.enqueue(session.id, async () => {
          if (captures.get(session.id) !== active || active.closing) {
            return;
          }
          const utterances = await store.readUtterancesForSession(active.descriptor);
          const { deliveredUtteranceIds } = subscriber;
          for (const utterance of utterances) {
            await request.onUtterance({
              ...utterance,
              id: `${request.session.sessionId}:${utterance.id ?? "replay"}`,
              sessionId: request.session.sessionId,
            });
            if (utterance.id) {
              deliveredUtteranceIds.add(utterance.id);
            }
          }
          subscribers.set(request.session.sessionId, subscriber);
          try {
            await request.onStatus?.({
              sessionId: request.session.sessionId,
              active: true,
              message: `Attached to active ${params.options.providerName} meeting capture.`,
              source: active.descriptor.source,
            });
            attached = true;
          } catch (error) {
            subscribers.delete(request.session.sessionId);
            throw error;
          }
        });
      } finally {
        pendingSubscribers.delete(request.session.sessionId);
      }
      return attached
        ? { ok: true, session: request.session }
        : { ok: false, error: `${params.options.providerName} meeting capture is ending.` };
    },
    async detach(request): Promise<TranscriptsStopResult> {
      const subscriber = subscribers.get(request.sessionId);
      const pending = pendingSubscribers.get(request.sessionId);
      const owner = subscriber ?? pending;
      if (!owner) {
        return { ok: true, sessionId: request.sessionId, stoppedAt: new Date().toISOString() };
      }
      if (request.source.agentId !== owner.agentId) {
        return { ok: false, error: "transcripts session belongs to another agent" };
      }
      return await tasks.enqueue(owner.meetingSessionId, async () => {
        const current = subscribers.get(request.sessionId);
        // A queued detach must not consume a replacement attachment with the same id.
        if (current !== owner) {
          return { ok: true, sessionId: request.sessionId, stoppedAt: new Date().toISOString() };
        }
        subscribers.delete(request.sessionId);
        notifySubscriberStatus(current, {
          sessionId: request.sessionId,
          active: false,
          message: `Detached from ${params.options.providerName} meeting capture.`,
          source: request.source,
        });
        return {
          ok: true as const,
          sessionId: request.sessionId,
          stoppedAt: new Date().toISOString(),
        };
      });
    },
  };
}
