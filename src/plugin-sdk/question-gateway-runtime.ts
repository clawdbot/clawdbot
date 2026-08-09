/** Runtime SDK subpath for Gateway-backed ask_user question controls. */
import { registerQuestionChannelDelivery } from "../infra/question-channel-runtime.js";
// The pre-release named resolver exports were replaced wholesale by this
// runtime object before any tagged release shipped them; no compat aliases.
import { resolveQuestionOverGateway } from "../infra/question-gateway-resolver.js";
import {
  QUESTION_REACTION_EMOJIS,
  prepareQuestionReactionPayloadForDelivery,
  readAskUserQuestionId,
  readQuestionReactionBinding,
  resolveQuestionReactionIndex,
  resolveQuestionReactionOverGateway,
} from "../infra/question-reaction-runtime.js";

const DEFAULT_QUESTION_REACTION_TARGET_TTL_MS = 24 * 60 * 60 * 1_000;

/** Creates one channel-owned target store for numbered ask_user reactions. */
export function createQuestionReactionTargetStore<TIdentity, TMetadata = undefined>(params: {
  channel: string;
  channelDisplayName: string;
  ttlMs?: number;
  buildKey: (identity: TIdentity) => string | null | undefined;
  identityMatches?: (stored: TMetadata | undefined, incoming: TMetadata | undefined) => boolean;
  registerChannelDelivery?: typeof registerQuestionChannelDelivery;
  resolveReaction?: typeof resolveQuestionReactionOverGateway;
}) {
  type Target = {
    questionId: string;
    optionValues: string[];
    metadata?: TMetadata;
    terminal: boolean;
    expiresAtMs: number;
    cleanupTimer: ReturnType<typeof setTimeout>;
  };

  const ttlMs = params.ttlMs ?? DEFAULT_QUESTION_REACTION_TARGET_TTL_MS;
  const registerChannelDelivery = params.registerChannelDelivery ?? registerQuestionChannelDelivery;
  const resolveReaction = params.resolveReaction ?? resolveQuestionReactionOverGateway;
  const targets = new Map<string, Target>();

  const findTarget = (identities: readonly TIdentity[]): Target | undefined => {
    for (const identity of identities) {
      const key = params.buildKey(identity);
      const target = key ? targets.get(key) : undefined;
      if (target) {
        return target;
      }
    }
    return undefined;
  };

  return {
    register(
      binding: { questionId: string; optionValues: string[] },
      identity: TIdentity,
      metadata?: TMetadata,
    ): boolean {
      const key = params.buildKey(identity);
      if (!key) {
        return false;
      }
      const existing = targets.get(key);
      if (existing) {
        clearTimeout(existing.cleanupTimer);
      }
      const target: Target = {
        ...binding,
        metadata,
        terminal: false,
        expiresAtMs: Date.now() + ttlMs,
        cleanupTimer: setTimeout(() => {
          if (targets.get(key) === target) {
            targets.delete(key);
          }
        }, ttlMs),
      };
      target.cleanupTimer.unref?.();
      targets.set(key, target);
      // Registration can synchronously finalize an already-terminal question.
      registerChannelDelivery({
        questionId: binding.questionId,
        deliveryId: `${params.channel}-reaction:${key}`,
        finalize: () => {
          target.terminal = true;
        },
      });
      return true;
    },

    has(identities: readonly TIdentity[]): boolean {
      return Boolean(findTarget(identities));
    },

    async resolve(resolveParams: {
      identities: readonly TIdentity[];
      optionIndex: number;
      cfg: Parameters<typeof resolveQuestionReactionOverGateway>[0]["cfg"];
      senderId: string;
      gatewayUrl?: string;
      metadata?: TMetadata;
      logDebug?: (message: string) => void;
    }): Promise<boolean> {
      const target = findTarget(resolveParams.identities);
      if (
        !target ||
        (params.identityMatches && !params.identityMatches(target.metadata, resolveParams.metadata))
      ) {
        return false;
      }
      if (target.expiresAtMs <= Date.now() || target.terminal) {
        target.terminal = true;
        resolveParams.logDebug?.(
          `${params.channel}: stale question reaction ignored id=${target.questionId}`,
        );
        return true;
      }
      const optionValue = target.optionValues[resolveParams.optionIndex];
      if (!optionValue) {
        resolveParams.logDebug?.(
          `${params.channel}: out-of-range question reaction ignored id=${target.questionId}`,
        );
        return true;
      }
      try {
        const result = await resolveReaction({
          cfg: resolveParams.cfg,
          questionId: target.questionId,
          optionValue,
          senderId: resolveParams.senderId,
          gatewayUrl: resolveParams.gatewayUrl,
          clientDisplayName: `${params.channelDisplayName} question (${resolveParams.senderId})`,
        });
        target.terminal = result?.status === "answered" || result?.status === "already-terminal";
        if (result?.status === "already-terminal") {
          resolveParams.logDebug?.(
            `${params.channel}: stale question reaction ignored id=${target.questionId}`,
          );
        }
      } catch (error) {
        resolveParams.logDebug?.(
          `${params.channel}: question reaction failed id=${target.questionId}: ${String(error)}`,
        );
      }
      return true;
    },
  };
}

export const questionGatewayRuntime = {
  resolveOption: resolveQuestionOverGateway,
  reactionEmojis: QUESTION_REACTION_EMOJIS,
  prepareReactionPayloadForDelivery: prepareQuestionReactionPayloadForDelivery,
  readAskUserQuestionId,
  readReactionBinding: readQuestionReactionBinding,
  resolveReactionIndex: resolveQuestionReactionIndex,
  resolveReaction: resolveQuestionReactionOverGateway,
  registerChannelDelivery: registerQuestionChannelDelivery,
};
