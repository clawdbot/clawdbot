// Slack plugin module implements message handler behavior.
import {
  createChannelInboundDebouncer,
  shouldDebounceTextInbound,
} from "openclaw/plugin-sdk/channel-inbound";
import { collectErrorGraphCandidates, formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { ResolvedSlackAccount } from "../accounts.js";
import type { SlackSendIdentity } from "../send.js";
import type { SlackMessageEvent } from "../types.js";
import { stripSlackMentionsForCommandDetection } from "./commands.js";
import type { SlackMonitorContext } from "./context.js";
import type { SlackEventScope } from "./event-scope.js";
import type { SlackIngressTurnLifecycle } from "./ingress.js";
import {
  buildSlackMessageDispatchReplayKey,
  claimSlackMessageDispatchReplay,
  createSlackMessageDispatchReplayGuard,
  type SlackMessageDispatchReplayClaim,
  type SlackMessageDispatchReplayGuard,
} from "./message-dispatch-dedupe.js";
import {
  buildSlackDebounceKey,
  buildTopLevelSlackConversationKey,
} from "./message-handler/debounce-key.js";
import type { PreparedSlackMessage } from "./message-handler/types.js";
import { createSlackThreadTsResolver } from "./thread-resolution.js";

const loadSlackMessagePipeline = createLazyRuntimeModule(
  () => import("./message-handler/pipeline.runtime.js"),
);

export type SlackMessageHandler = (
  message: SlackMessageEvent,
  opts: {
    source: "message" | "app_mention";
    wasMentioned?: boolean;
    relayIdentity?: SlackSendIdentity;
    /** Non-serializable listener scope for a validated enterprise event. */
    eventScope?: SlackEventScope;
    /** Wait until any inbound debounce flush and dispatch has completed. */
    awaitDispatch?: boolean;
    /** Durable ingress ownership carried into reply-lane adoption. */
    turnAdoptionLifecycle?: SlackIngressTurnLifecycle;
  },
) => Promise<void>;

type SlackDispatchCompletion = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
};

type IngressSlackMessageOptions = Parameters<SlackMessageHandler>[1] & {
  retryAttempt?: number;
};

type QueuedSlackMessageOptions = IngressSlackMessageOptions & {
  dispatchCompletion?: Omit<SlackDispatchCompletion, "promise">;
};

function createSlackDispatchCompletion(): SlackDispatchCompletion {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

const RETRYABLE_FLUSH_MAX_ATTEMPTS = 3;
const RETRYABLE_FLUSH_RETRY_DELAY_MS = 1_000;
const REPLY_SESSION_INIT_CONFLICT_MESSAGE_RE = /reply session initialization conflicted for \S+/u;

function isRetryableSlackInboundError(error: unknown): boolean {
  return collectErrorGraphCandidates(error, (current) => [current.cause, current.error]).some(
    (candidate) => REPLY_SESSION_INIT_CONFLICT_MESSAGE_RE.test(formatErrorMessage(candidate)),
  );
}

function shouldDebounceSlackMessage(message: SlackMessageEvent, cfg: SlackMonitorContext["cfg"]) {
  const text = message.text ?? "";
  const textForCommandDetection = stripSlackMentionsForCommandDetection(text);
  return shouldDebounceTextInbound({
    text: textForCommandDetection,
    cfg,
    hasMedia: Boolean(message.files && message.files.length > 0),
  });
}

export function createSlackMessageHandler(params: {
  ctx: SlackMonitorContext;
  account: ResolvedSlackAccount;
  /** Called on each inbound event to update liveness tracking. */
  trackEvent?: () => void;
  /** Called after access/routing preparation accepts a human message. */
  onPrepared?: (prepared: PreparedSlackMessage) => void;
  dispatchReplayGuard?: SlackMessageDispatchReplayGuard;
}): SlackMessageHandler {
  const { ctx, account, trackEvent, onPrepared } = params;
  const dispatchReplayGuard =
    params.dispatchReplayGuard ??
    createSlackMessageDispatchReplayGuard({
      onDiskError: (error) =>
        ctx.runtime.error?.(
          `slack message dispatch dedupe persistence failed: ${formatErrorMessage(error)}`,
        ),
    });
  const { debounceMs, debouncer } = createChannelInboundDebouncer<{
    message: SlackMessageEvent;
    opts: QueuedSlackMessageOptions;
  }>({
    cfg: ctx.cfg,
    channel: "slack",
    buildKey: (entry) =>
      buildSlackDebounceKey(entry.message, ctx.accountId, entry.opts.eventScope?.teamId),
    shouldDebounce: (entry) =>
      !entry.opts.eventScope && shouldDebounceSlackMessage(entry.message, ctx.cfg),
    onFlush: async (entries) => {
      const retryEntries = (sourceError: unknown): boolean => {
        if (
          !isRetryableSlackInboundError(sourceError) ||
          entries.some((entry) => entry.opts.eventScope)
        ) {
          return false;
        }
        const nextEntries = entries
          .map((entry) => {
            // Relay delivery owns retry until its dispatch completion is acknowledged.
            // Scheduling here as well can race the router redelivery and duplicate a reply.
            if (entry.opts.dispatchCompletion) {
              return null;
            }
            const retryAttempt = entry.opts.retryAttempt ?? 0;
            if (retryAttempt >= RETRYABLE_FLUSH_MAX_ATTEMPTS) {
              return null;
            }
            const { dispatchCompletion: _dispatchCompletion, ...retryOpts } = entry.opts;
            return {
              ...entry,
              opts: {
                ...retryOpts,
                retryAttempt: retryAttempt + 1,
              },
            };
          })
          .filter((entry) => entry !== null);
        if (nextEntries.length === 0) {
          return false;
        }
        const retryTimer = setTimeout(() => {
          for (const entry of nextEntries) {
            // Re-enter the normal inbound path so retry ordering and debouncing stay consistent.
            void enqueueSlackMessage(entry.message, entry.opts).catch((err: unknown) => {
              ctx.runtime.error?.(`slack inbound retry enqueue failed: ${formatErrorMessage(err)}`);
            });
          }
        }, RETRYABLE_FLUSH_RETRY_DELAY_MS);
        retryTimer.unref?.();
        return true;
      };
      const completions = entries
        .map((entry) => entry.opts.dispatchCompletion)
        .filter((completion) => completion !== undefined);
      try {
        await (async () => {
          // Logical-identity claims: Slack sends message + app_mention twins with
          // distinct event_ids for one post, so the durable queue cannot dedupe
          // them. Same-flush twins share one claim; a later twin claims duplicate
          // and is dropped before it can produce a second visible reply.
          const claims: SlackMessageDispatchReplayClaim[] = [];
          const claimedKeys = new Set<string>();
          const surviving: typeof entries = [];
          for (const entry of entries) {
            const replayKey = buildSlackMessageDispatchReplayKey({
              accountId: ctx.accountId,
              channelId: entry.message.channel,
              ts: entry.message.ts,
              teamId: entry.opts.eventScope?.teamId,
            });
            if (!replayKey || claimedKeys.has(replayKey)) {
              surviving.push(entry);
              continue;
            }
            const claim = await claimSlackMessageDispatchReplay({
              guard: dispatchReplayGuard,
              key: replayKey,
            });
            if (claim.kind === "claimed") {
              claims.push(claim.handle);
              claimedKeys.add(replayKey);
              surviving.push(entry);
            }
          }
          const releaseClaims = (error?: unknown) => {
            for (const handle of claims) {
              handle.release(error === undefined ? {} : { error });
            }
          };
          const commitClaims = async () => {
            for (const handle of claims) {
              await handle.commit();
            }
          };
          const last = surviving.at(-1);
          if (!last) {
            releaseClaims();
            return;
          }
          const teamId = last.opts.eventScope?.teamId;
          const flushedKey = buildSlackDebounceKey(last.message, ctx.accountId, teamId);
          const topLevelConversationKey = buildTopLevelSlackConversationKey(
            last.message,
            ctx.accountId,
            teamId,
          );
          if (flushedKey && topLevelConversationKey) {
            const pendingKeys = pendingTopLevelDebounceKeys.get(topLevelConversationKey);
            if (pendingKeys) {
              pendingKeys.delete(flushedKey);
              if (pendingKeys.size === 0) {
                pendingTopLevelDebounceKeys.delete(topLevelConversationKey);
              }
            }
          }
          const combinedText =
            surviving.length === 1
              ? (last.message.text ?? "")
              : surviving
                  .map((entry) => entry.message.text ?? "")
                  .filter(Boolean)
                  .join("\n");
          const combinedMentioned = surviving.some((entry) => Boolean(entry.opts.wasMentioned));
          const syntheticMessage: SlackMessageEvent = {
            ...last.message,
            text: combinedText,
          };
          const { prepareSlackMessage, dispatchPreparedSlackMessage } =
            await loadSlackMessagePipeline();
          const {
            dispatchCompletion: _completion,
            awaitDispatch: _awaitDispatch,
            turnAdoptionLifecycle,
            ...lastOpts
          } = last.opts;
          let prepared: Awaited<ReturnType<typeof prepareSlackMessage>>;
          let settlementHandedOff = false;
          try {
            prepared = await prepareSlackMessage({
              ctx,
              account,
              message: syntheticMessage,
              opts: {
                ...lastOpts,
                wasMentioned: combinedMentioned || last.opts.wasMentioned,
              },
            });
            if (!prepared) {
              // Gated before dispatch: release so the surviving twin can run the
              // same gate; nothing visible was produced, so no duplicate risk.
              releaseClaims();
              return;
            }
            // Commit at adoption (durable turn ownership), release on abandonment;
            // deferred turns hand settlement to the reply lane with the claim held.
            prepared.turnAdoptionLifecycle = turnAdoptionLifecycle
              ? {
                  ...turnAdoptionLifecycle,
                  onAdopted: async () => {
                    settlementHandedOff = true;
                    await commitClaims();
                    await turnAdoptionLifecycle.onAdopted();
                  },
                  onDeferred: () => {
                    settlementHandedOff = true;
                    turnAdoptionLifecycle.onDeferred();
                  },
                  onAbandoned: () => {
                    releaseClaims();
                    // Slack has no owner-local teardown gated on core claim release.
                    void turnAdoptionLifecycle.onAbandoned();
                  },
                }
              : turnAdoptionLifecycle;
            onPrepared?.(prepared);
            if (surviving.length > 1) {
              const ids = surviving.map((entry) => entry.message.ts).filter(Boolean) as string[];
              if (ids.length > 0) {
                prepared.ctxPayload.MessageSids = ids;
                prepared.ctxPayload.MessageSidFirst = ids[0];
                prepared.ctxPayload.MessageSidLast = ids[ids.length - 1];
              }
            }
            await dispatchPreparedSlackMessage(prepared);
            if (!turnAdoptionLifecycle) {
              await commitClaims();
            } else if (!settlementHandedOff) {
              // Dispatch finished without adoption or deferral (skip/no-reply):
              // deliberate terminal handling, release for gate-idempotent twins.
              releaseClaims();
            }
          } catch (error) {
            releaseClaims(error);
            throw error;
          }
        })();
        for (const completion of completions) {
          completion.resolve();
        }
      } catch (error) {
        retryEntries(error);
        for (const completion of completions) {
          completion.reject(error);
        }
        throw error;
      }
    },
    onError: (err) => {
      ctx.runtime.error?.(`slack inbound debounce flush failed: ${formatErrorMessage(err)}`);
    },
  });
  const threadTsResolver = createSlackThreadTsResolver({ client: ctx.app.client });
  const pendingTopLevelDebounceKeys = new Map<string, Set<string>>();

  async function enqueueSlackMessage(
    message: SlackMessageEvent,
    opts: IngressSlackMessageOptions,
  ): Promise<SlackDispatchCompletion | undefined> {
    if (opts.source === "message" && message.type !== "message") {
      return undefined;
    }
    if (
      opts.source === "message" &&
      message.subtype &&
      message.subtype !== "file_share" &&
      message.subtype !== "bot_message" &&
      message.subtype !== "thread_broadcast"
    ) {
      return undefined;
    }
    // Record Slack's explicit type before thread-resolution awaits.
    // Relay and native events can overlap; a following typeless bot event must see it.
    ctx.rememberSlackChannelType(message.channel, message.channel_type, opts.eventScope);
    trackEvent?.();
    const resolvedMessage = await (
      opts.eventScope
        ? createSlackThreadTsResolver({ client: opts.eventScope.client })
        : threadTsResolver
    ).resolve({ message, source: opts.source });
    const teamId = opts.eventScope?.teamId;
    const debounceKey = buildSlackDebounceKey(resolvedMessage, ctx.accountId, teamId);
    const conversationKey = buildTopLevelSlackConversationKey(
      resolvedMessage,
      ctx.accountId,
      teamId,
    );
    const canDebounce =
      !opts.eventScope && debounceMs > 0 && shouldDebounceSlackMessage(resolvedMessage, ctx.cfg);
    if (!canDebounce && conversationKey) {
      const pendingKeys = pendingTopLevelDebounceKeys.get(conversationKey);
      if (pendingKeys && pendingKeys.size > 0) {
        const keysToFlush = Array.from(pendingKeys);
        for (const pendingKey of keysToFlush) {
          await debouncer.flushKey(pendingKey);
        }
      }
    }
    if (canDebounce && debounceKey && conversationKey) {
      const pendingKeys = pendingTopLevelDebounceKeys.get(conversationKey) ?? new Set<string>();
      pendingKeys.add(debounceKey);
      pendingTopLevelDebounceKeys.set(conversationKey, pendingKeys);
    }
    const dispatchCompletion = opts.awaitDispatch ? createSlackDispatchCompletion() : undefined;
    await debouncer.enqueue({
      message: resolvedMessage,
      opts: {
        ...opts,
        ...(dispatchCompletion
          ? {
              dispatchCompletion: {
                resolve: dispatchCompletion.resolve,
                reject: dispatchCompletion.reject,
              },
            }
          : {}),
      },
    });
    return dispatchCompletion;
  }

  return async (message, opts) => {
    const dispatchCompletion = await enqueueSlackMessage(message, opts);
    await dispatchCompletion?.promise;
  };
}
