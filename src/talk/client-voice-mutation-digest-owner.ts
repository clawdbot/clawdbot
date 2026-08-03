import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildOutboundSessionContext } from "../infra/outbound/session-context.js";
import { resolveSessionDeliveryTarget } from "../infra/outbound/targets-session.js";
import { runOpenClawAgentWriteTransaction } from "../state/openclaw-agent-db.js";
import {
  type ClientVoiceSessionRecord,
  type ClientVoiceToolEffect,
  readVoiceSessionRecordInTransaction,
  writeVoiceSessionRecordInTransaction,
} from "./client-voice-session-store.js";

export const CLIENT_VOICE_MUTATION_DIGEST_POLICY = {
  maxRetainedIntents: 64,
  maxRetainedIdentityBytes: 64 * 1024,
  maxConcurrentAttempts: 2,
  maxAttemptFailures: 3,
  attemptAbortAfterMs: 30_000,
  failureRetentionMs: 5 * 60_000,
} as const;

function formatMutationDigest(effects: ClientVoiceToolEffect[]): string | undefined {
  if (effects.length === 0) {
    return undefined;
  }
  return [
    "Voice call changes",
    ...effects
      .slice(0, 12)
      .map(
        (effect) =>
          `- ${effect.toolName}: ${effect.status === "started" ? "outcome not confirmed" : effect.status}`,
      ),
  ].join("\n");
}

/** Deliver one point-in-time summary and mark the durable voice record after success. */
export async function deliverClientVoiceMutationDigest(
  record: ClientVoiceSessionRecord,
  config: OpenClawConfig,
  signal: AbortSignal,
): Promise<void> {
  if (record.digestDeliveredAt) {
    return;
  }
  const text = formatMutationDigest(record.effects);
  if (!text) {
    return;
  }
  const entry = loadSessionEntryReadOnly({
    agentId: record.agentId,
    sessionKey: record.sessionKey,
  });
  const target = resolveSessionDeliveryTarget({ entry, requestedChannel: "last" });
  if (!target.channel || target.channel === "webchat" || !target.to) {
    return;
  }
  const { sendDurableMessageBatch } = await import("../channels/message/runtime.js");
  const send = await sendDurableMessageBatch({
    cfg: config,
    channel: target.channel,
    to: target.to,
    ...(target.accountId ? { accountId: target.accountId } : {}),
    ...(target.threadId != null ? { threadId: target.threadId } : {}),
    payloads: [{ text }],
    durability: "required",
    requireUnknownSendReconciliation: true,
    signal,
    session: buildOutboundSessionContext({
      cfg: config,
      agentId: record.agentId,
      sessionKey: record.sessionKey,
      policySessionKey: record.sessionKey,
    }),
  });
  if (send.status === "failed" || send.status === "partial_failed") {
    throw send.error;
  }
  const deliveredAt = Date.now();
  runOpenClawAgentWriteTransaction(
    (database) => {
      const current = readVoiceSessionRecordInTransaction(database, record.voiceSessionId);
      if (!current || current.digestDeliveredAt) {
        return;
      }
      current.digestDeliveredAt = deliveredAt;
      current.updatedAt = deliveredAt;
      writeVoiceSessionRecordInTransaction(database, current);
    },
    { agentId: record.agentId },
  );
}

type MutationDigestIntent<TContext> = {
  agentId: string;
  voiceSessionId: string;
  context: TContext;
  identityBytes: number;
  failedAttempts: number;
  failureExpiry?: ReturnType<typeof setTimeout>;
  expireAfterActive?: boolean;
};

type MutationDigestAttempt<TContext> = {
  controller: AbortController;
  intent: MutationDigestIntent<TContext>;
  generation: number;
};

type MutationDigestPolicy = {
  maxRetainedIntents: number;
  maxRetainedIdentityBytes: number;
  maxConcurrentAttempts: number;
  maxAttemptFailures: number;
  attemptAbortAfterMs: number;
  failureRetentionMs: number;
};

export class ClientVoiceMutationDigestOwner<TContext> {
  private readonly intents = new Map<string, MutationDigestIntent<TContext>>();
  private readonly pendingKeys = new Set<string>();
  private readonly retryAfterActiveKeys = new Set<string>();
  private readonly activeAttempts = new Map<string, MutationDigestAttempt<TContext>>();
  private retainedIdentityBytes = 0;
  private generation = 0;

  constructor(
    private readonly options: {
      attempt: (intent: {
        agentId: string;
        voiceSessionId: string;
        context: TContext;
        signal: AbortSignal;
      }) => Promise<boolean>;
      warn: (message: string) => void;
      policy?: MutationDigestPolicy;
    },
  ) {}

  private get policy(): MutationDigestPolicy {
    return this.options.policy ?? CLIENT_VOICE_MUTATION_DIGEST_POLICY;
  }

  record(params: { agentId: string; voiceSessionId: string; context: TContext }): void {
    const key = this.key(params);
    const existing = this.intents.get(key);
    if (existing) {
      existing.context = params.context;
      if (this.activeAttempts.has(key)) {
        this.retryAfterActiveKeys.add(key);
      } else {
        this.pendingKeys.add(key);
      }
      this.pump();
      return;
    }
    const identityBytes =
      Buffer.byteLength(params.agentId, "utf8") +
      Buffer.byteLength(params.voiceSessionId, "utf8") +
      1;
    if (identityBytes > this.policy.maxRetainedIdentityBytes) {
      this.options.warn("voice mutation digest identity exceeds the retry owner byte limit");
      return;
    }
    if (
      this.intents.size >= this.policy.maxRetainedIntents ||
      this.retainedIdentityBytes + identityBytes > this.policy.maxRetainedIdentityBytes
    ) {
      this.options.warn("voice mutation digest retry owner is full");
      return;
    }
    const intent = { ...params, identityBytes, failedAttempts: 0 };
    this.intents.set(key, intent);
    this.retainedIdentityBytes += identityBytes;
    this.pendingKeys.add(key);
    this.pump();
  }

  retry(params: { agentId: string; voiceSessionId: string }): void {
    const key = this.key(params);
    if (!this.intents.has(key)) {
      return;
    }
    if (this.activeAttempts.has(key)) {
      this.retryAfterActiveKeys.add(key);
    } else {
      this.pendingKeys.add(key);
    }
    this.pump();
  }

  retryAgent(agentId: string, context: TContext): void {
    for (const [key, intent] of this.intents) {
      if (intent.agentId !== agentId) {
        continue;
      }
      intent.context = context;
      if (this.activeAttempts.has(key)) {
        this.retryAfterActiveKeys.add(key);
      } else {
        this.pendingKeys.add(key);
      }
    }
    this.pump();
  }

  snapshot(): {
    active: number;
    pending: number;
    retained: number;
    retainedIdentityBytes: number;
  } {
    return {
      active: this.activeAttempts.size,
      pending: this.pendingKeys.size,
      retained: this.intents.size,
      retainedIdentityBytes: this.retainedIdentityBytes,
    };
  }

  clear(): void {
    for (const attempt of this.activeAttempts.values()) {
      attempt.controller.abort(new Error("voice mutation digest delivery owner reset"));
    }
    for (const intent of this.intents.values()) {
      if (intent.failureExpiry) {
        clearTimeout(intent.failureExpiry);
      }
    }
    this.generation += 1;
    this.intents.clear();
    this.pendingKeys.clear();
    this.retryAfterActiveKeys.clear();
    this.activeAttempts.clear();
    this.retainedIdentityBytes = 0;
  }

  private key(params: { agentId: string; voiceSessionId: string }): string {
    return `${params.agentId}\0${params.voiceSessionId}`;
  }

  private deleteIntent(key: string, expected?: MutationDigestIntent<TContext>): void {
    const current = this.intents.get(key);
    if (!current || (expected && current !== expected)) {
      return;
    }
    this.intents.delete(key);
    this.pendingKeys.delete(key);
    this.retryAfterActiveKeys.delete(key);
    if (current.failureExpiry) {
      clearTimeout(current.failureExpiry);
    }
    this.retainedIdentityBytes -= current.identityBytes;
  }

  private retainAfterFailure(key: string, intent: MutationDigestIntent<TContext>): void {
    if (intent.failureExpiry) {
      return;
    }
    intent.failureExpiry = setTimeout(() => {
      if (this.intents.get(key) !== intent) {
        return;
      }
      if (this.activeAttempts.has(key)) {
        intent.expireAfterActive = true;
        return;
      }
      this.deleteIntent(key, intent);
      this.options.warn(
        `voice mutation digest dropped after retry retention expired (${intent.failedAttempts} failed attempts)`,
      );
    }, this.policy.failureRetentionMs);
    intent.failureExpiry.unref?.();
  }

  private clearFailureState(intent: MutationDigestIntent<TContext>): void {
    if (intent.failureExpiry) {
      clearTimeout(intent.failureExpiry);
      delete intent.failureExpiry;
    }
    delete intent.expireAfterActive;
    intent.failedAttempts = 0;
  }

  private pump(): void {
    while (
      this.activeAttempts.size < this.policy.maxConcurrentAttempts &&
      this.pendingKeys.size > 0
    ) {
      const key = this.pendingKeys.values().next().value as string | undefined;
      if (!key) {
        return;
      }
      this.pendingKeys.delete(key);
      const intent = this.intents.get(key);
      if (!intent || this.activeAttempts.has(key)) {
        continue;
      }
      this.startAttempt(key, intent);
    }
  }

  private startAttempt(key: string, intent: MutationDigestIntent<TContext>): void {
    const controller = new AbortController();
    const attempt = { controller, intent, generation: this.generation };
    this.activeAttempts.set(key, attempt);
    const timeout = setTimeout(
      () => controller.abort(new Error("voice mutation digest delivery abort requested")),
      this.policy.attemptAbortAfterMs,
    );
    timeout.unref?.();
    // Abort is cooperative, not a wall-clock completion guarantee. An adapter
    // that ignores it keeps this exact slot so repeated retries cannot fan out.
    let completion: Promise<boolean>;
    try {
      completion = this.options.attempt({ ...intent, signal: controller.signal });
    } catch (error) {
      completion = Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    void completion
      .then((complete) => {
        if (complete) {
          this.deleteIntent(key, intent);
        } else {
          // A live consult is a legitimate defer, not a delivery failure. Its
          // run-completion event owns the next retry and must not inherit expiry.
          this.clearFailureState(intent);
        }
      })
      .catch((error: unknown) => {
        if (attempt.generation !== this.generation) {
          return;
        }
        intent.failedAttempts += 1;
        const message = error instanceof Error ? error.message : String(error);
        if (intent.failedAttempts >= this.policy.maxAttemptFailures) {
          this.deleteIntent(key, intent);
          this.options.warn(
            `voice mutation digest dropped after ${intent.failedAttempts} failed attempts: ${message}`,
          );
          return;
        }
        this.options.warn(message);
        this.retainAfterFailure(key, intent);
      })
      .finally(() => {
        clearTimeout(timeout);
        if (attempt.generation !== this.generation) {
          return;
        }
        if (this.activeAttempts.get(key) === attempt) {
          this.activeAttempts.delete(key);
        }
        if (intent.expireAfterActive && this.intents.get(key) === intent) {
          this.deleteIntent(key, intent);
          this.options.warn(
            `voice mutation digest dropped after retry retention expired (${intent.failedAttempts} failed attempts)`,
          );
          this.pump();
          return;
        }
        if (this.retryAfterActiveKeys.delete(key) && this.intents.has(key)) {
          this.pendingKeys.add(key);
        }
        this.pump();
      });
  }
}
