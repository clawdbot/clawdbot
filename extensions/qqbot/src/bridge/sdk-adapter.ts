/**
 * SDK adapter — binds engine port interfaces to the framework's shared
 * SDK implementations.
 *
 * This file lives in bridge/ (not engine/) because it imports from
 * `openclaw/plugin-sdk/*`. The engine layer stays zero-SDK-dependency;
 * only the bridge layer couples to the framework.
 */

import {
  implicitMentionKindWhen,
  resolveInboundMentionDecision,
} from "openclaw/plugin-sdk/channel-mention-gating";
import {
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  recordPendingHistoryEntryIfEnabled,
  type HistoryEntry as SdkHistoryEntry,
} from "openclaw/plugin-sdk/reply-history";
import type { HistoryPort, HistoryEntryLike } from "../engine/adapter/history.port.js";
import type {
  MentionGatePort,
  MentionGateDecision,
  MentionFacts,
  MentionPolicy,
} from "../engine/adapter/mention-gate.port.js";

// ============ History Adapter ============

// Helper: cast engine Map to SDK Map. TypeScript Map is invariant on its
// value type, but the shapes are structurally identical (HistoryEntryLike
// ⊇ SdkHistoryEntry). The `as unknown as` double-cast is safe here.
function asSdkMap<T>(map: Map<string, T[]>): Map<string, SdkHistoryEntry[]> {
  return map as unknown as Map<string, SdkHistoryEntry[]>;
}

/**
 * History adapter backed by SDK `reply-history`.
 *
 * Delegates record/build/clear to the SDK's shared implementation so
 * the engine benefits from SDK improvements (e.g. future visibility
 * filtering) without code duplication.
 */
export function createSdkHistoryAdapter(): HistoryPort {
  return {
    recordPendingHistoryEntry<T extends HistoryEntryLike>(params: {
      historyMap: Map<string, T[]>;
      historyKey: string;
      entry?: T | null;
      limit: number;
    }): T[] {
      return recordPendingHistoryEntryIfEnabled({
        historyMap: asSdkMap(params.historyMap),
        historyKey: params.historyKey,
        entry: params.entry as SdkHistoryEntry | undefined,
        limit: params.limit,
      }) as T[];
    },

    buildPendingHistoryContext(params: {
      historyMap: Map<string, HistoryEntryLike[]>;
      historyKey: string;
      limit: number;
      currentMessage: string;
      formatEntry: (entry: HistoryEntryLike) => string;
      lineBreak?: string;
    }): string {
      return buildPendingHistoryContextFromMap({
        historyMap: asSdkMap(params.historyMap),
        historyKey: params.historyKey,
        limit: params.limit,
        currentMessage: params.currentMessage,
        formatEntry: params.formatEntry as (entry: SdkHistoryEntry) => string,
        lineBreak: params.lineBreak,
      });
    },

    clearPendingHistory(params: {
      historyMap: Map<string, HistoryEntryLike[]>;
      historyKey: string;
      limit: number;
    }): void {
      clearHistoryEntriesIfEnabled({
        historyMap: asSdkMap(params.historyMap),
        historyKey: params.historyKey,
        limit: params.limit,
      });
    },
  };
}

// ============ MentionGate Adapter ============

/**
 * MentionGate adapter backed by SDK `channel-mention-gating`.
 *
 * Maps the engine's mention facts/policy to the SDK's
 * `resolveInboundMentionDecision` call, normalizing the implicit
 * mention boolean into the SDK's typed `ImplicitMentionKind[]`.
 */
export function createSdkMentionGateAdapter(): MentionGatePort {
  return {
    resolveInboundMentionDecision(params: {
      facts: MentionFacts;
      policy: MentionPolicy;
    }): MentionGateDecision {
      const result = resolveInboundMentionDecision({
        facts: {
          canDetectMention: params.facts.canDetectMention,
          wasMentioned: params.facts.wasMentioned,
          hasAnyMention: params.facts.hasAnyMention,
          implicitMentionKinds:
            params.facts.implicitMentionKinds ?? implicitMentionKindWhen("reply_to_bot", false),
        },
        policy: {
          isGroup: params.policy.isGroup,
          requireMention: params.policy.requireMention,
          allowTextCommands: params.policy.allowTextCommands,
          hasControlCommand: params.policy.hasControlCommand,
          commandAuthorized: params.policy.commandAuthorized,
        },
      });
      return {
        effectiveWasMentioned: result.effectiveWasMentioned,
        shouldSkip: result.shouldSkip,
        shouldBypassMention: result.shouldBypassMention,
        implicitMention: result.implicitMention,
      };
    },
  };
}
