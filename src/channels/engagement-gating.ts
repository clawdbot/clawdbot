/**
 * Engagement mode gating logic for group messages.
 *
 * This module handles the probabilistic response logic for engagement mode,
 * including state management and persistence.
 *
 * @see docs/experiments/plans/engagement-mode.md
 */

import type { MoltbotConfig } from "../config/config.js";
import { logVerbose } from "../globals.js";
import { shouldRespond, type EngagementState } from "../config/engagement.js";
import {
  resolveChannelGroupEngagement,
  resolveChannelGroupMode,
  type GroupPolicyChannel,
} from "../config/group-policy.js";
import { loadSessionStore, updateSessionStore } from "../config/sessions/store.js";
import type { SessionEntry } from "../config/sessions/types.js";

export type EngagementGatingParams = {
  cfg: MoltbotConfig;
  channel: GroupPolicyChannel;
  groupId: string;
  accountId?: string;
  sessionKey: string;
  storePath: string;
  messageText: string;
  /** Was the bot explicitly mentioned? */
  wasMentioned: boolean;
  /** Injectable for testing */
  random?: () => number;
  /** Injectable for testing */
  now?: number;
};

export type EngagementGatingResult = {
  /** Whether to process this message */
  shouldProcess: boolean;
  /** The resolved group mode */
  mode: "mention" | "always" | "engagement";
  /** Whether engagement mode decided to respond (only set if mode="engagement") */
  engagementTriggered?: boolean;
  /** Updated engagement state (only set if mode="engagement") */
  nextState?: EngagementState;
};

/**
 * Apply engagement gating logic to a group message.
 *
 * For "mention" mode: requires mention to process
 * For "always" mode: always processes
 * For "engagement" mode: probabilistic response based on config
 *
 * This function does NOT persist state - call `persistEngagementState` after
 * processing if you want to save the state.
 */
export function applyEngagementGating(params: EngagementGatingParams): EngagementGatingResult {
  const { cfg, channel, groupId, accountId, sessionKey, storePath, messageText, wasMentioned } =
    params;
  const now = params.now ?? Date.now();

  // Resolve group mode from config
  const mode = resolveChannelGroupMode({
    cfg,
    channel,
    groupId,
    accountId,
  });

  logVerbose(`[engagement-gating] channel=${channel} groupId=${groupId} resolvedMode=${mode}`);

  // Handle non-engagement modes
  if (mode === "always") {
    logVerbose(`[engagement-gating] mode=always, processing`);
    return { shouldProcess: true, mode };
  }

  if (mode === "mention") {
    logVerbose(`[engagement-gating] mode=mention, wasMentioned=${wasMentioned}`);
    return { shouldProcess: wasMentioned, mode };
  }

  // Engagement mode
  const engagementConfig = resolveChannelGroupEngagement({
    cfg,
    channel,
    groupId,
    accountId,
  });

  logVerbose(`[engagement-gating] engagementConfig=${engagementConfig ? "found" : "missing"}`);

  // If no engagement config, fall back to mention behavior
  if (!engagementConfig) {
    logVerbose(`[engagement-gating] no engagement config, falling back to mention mode`);
    return { shouldProcess: wasMentioned, mode: "mention" };
  }

  // If mentioned, always respond in engagement mode (and transition to engaged)
  // But don't corrupt state - this is a USER message, not a bot message
  if (wasMentioned) {
    const currentState = loadEngagementState(storePath, sessionKey);
    const nextState: EngagementState = {
      engaged: true,
      engagedAt: currentState.engaged ? currentState.engagedAt : now,
      lastResponseAt: currentState.lastResponseAt, // Don't update - bot hasn't responded yet
      lastMessageAt: now,
      messagesSinceResponse: (currentState.messagesSinceResponse ?? 0) + 1, // Increment - this is a user message
      recentMessages: appendToRecentMessages(
        currentState.recentMessages,
        false, // This is a USER message, not bot
        now,
        engagementConfig.ratioWindow ?? 10,
      ),
    };
    return {
      shouldProcess: true,
      mode: "engagement",
      engagementTriggered: true,
      nextState,
    };
  }

  // Probabilistic response
  const currentState = loadEngagementState(storePath, sessionKey);
  logVerbose(
    `[engagement-gating] currentState: engaged=${currentState.engaged} messagesSinceResponse=${currentState.messagesSinceResponse ?? 0}`,
  );

  const result = shouldRespond({
    config: engagementConfig,
    state: currentState,
    messageText,
    now,
    wasMentioned,
    random: params.random,
  });

  logVerbose(
    `[engagement-gating] shouldRespond result: respond=${result.respond} nextEngaged=${result.nextState.engaged}`,
  );

  return {
    shouldProcess: result.respond,
    mode: "engagement",
    engagementTriggered: result.respond,
    nextState: result.nextState,
  };
}

/**
 * Persist engagement state to the session store.
 * Call this after processing a message in engagement mode.
 */
export async function persistEngagementState(params: {
  storePath: string;
  sessionKey: string;
  state: EngagementState;
}): Promise<void> {
  const { storePath, sessionKey, state } = params;
  await updateSessionStore(storePath, (store) => {
    const entry = store[sessionKey];
    if (entry) {
      entry.engagementState = state;
      // Also update groupActivation to reflect engagement mode
      entry.groupActivation = "engagement";
    }
    return store;
  });
}

/**
 * Load engagement state from the session store.
 */
function loadEngagementState(storePath: string, sessionKey: string): EngagementState {
  const store = loadSessionStore(storePath);
  const entry = store[sessionKey] as SessionEntry | undefined;
  return entry?.engagementState ?? { engaged: false };
}

/**
 * Append a message to the recent messages window, trimming to size.
 */
function appendToRecentMessages(
  messages: EngagementState["recentMessages"],
  isBot: boolean,
  at: number,
  windowSize: number,
): EngagementState["recentMessages"] {
  const current = messages ?? [];
  const updated = [...current, { isBot, at }];
  if (updated.length > windowSize) {
    return updated.slice(-windowSize);
  }
  return updated;
}
