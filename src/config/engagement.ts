/**
 * Engagement mode for groups — natural participation without @mentions.
 *
 * State machine:
 *   LURKING ──(chance hit)──► ENGAGED
 *      ▲                          │
 *      └──(cooldown: time OR msgs)┘
 *
 * @see docs/experiments/plans/engagement-mode.md
 */

// =============================================================================
// Types
// =============================================================================

export type EngagementConfig = {
  /** Base probability when lurking (0-1) */
  baseChance: number;
  /** Probability when engaged (0-1) */
  engagedChance: number;
  /** Words that boost response probability (case-insensitive substring match) */
  triggerWords?: string[];
  /** Probability boost when trigger word found (0-1, added to base/engaged chance) */
  triggerBoost: number;
  /** Cooldown settings — either threshold triggers reset to lurking */
  cooldown: {
    /** Seconds of silence before resetting to lurking */
    time: number;
    /** Messages without bot responding before resetting to lurking */
    messages: number;
  };
  /** Max ratio of bot messages in recent window (0-1) — suppresses if exceeded */
  maxRatio?: number;
  /** Number of messages to consider for ratio calculation */
  ratioWindow?: number;
};

export type RecentMessage = {
  isBot: boolean;
  at: number;
};

export type EngagementState = {
  engaged: boolean;
  engagedAt?: number;
  lastResponseAt?: number;
  lastMessageAt?: number;
  messagesSinceResponse?: number;
  recentMessages?: RecentMessage[];
};

export type ShouldRespondResult = {
  respond: boolean;
  nextState: EngagementState;
};

// =============================================================================
// Trigger word detection
// =============================================================================

/**
 * Check if message contains any trigger word (case-insensitive substring match).
 */
export function hasTriggerWord(message: string, triggerWords: string[] | undefined): boolean {
  if (!triggerWords || triggerWords.length === 0) return false;
  if (!message) return false;

  const lowerMessage = message.toLowerCase();
  return triggerWords.some((word) => lowerMessage.includes(word.toLowerCase()));
}

// =============================================================================
// Ratio calculation
// =============================================================================

/**
 * Calculate the ratio of bot messages in the recent window.
 */
export function calculateBotRatio(
  recentMessages: RecentMessage[] | undefined,
  windowSize: number,
): number {
  if (!recentMessages || recentMessages.length === 0) return 0;

  // Take only the most recent `windowSize` messages
  const window = recentMessages.slice(-windowSize);
  if (window.length === 0) return 0;

  const botCount = window.filter((m) => m.isBot).length;
  return botCount / window.length;
}

// =============================================================================
// Cooldown logic
// =============================================================================

/**
 * Check if engagement has cooled down (should reset to lurking).
 * Returns true if cooldown threshold exceeded.
 */
export function checkCooldown(
  state: EngagementState,
  cooldown: EngagementConfig["cooldown"],
  now: number,
): boolean {
  // Not engaged → nothing to cool down
  if (!state.engaged) return false;

  // No lastMessageAt → treat as stale (cooled down)
  if (state.lastMessageAt === undefined) return true;

  // Time-based cooldown (convert seconds to ms)
  const timeSinceLastMessage = now - state.lastMessageAt;
  if (timeSinceLastMessage > cooldown.time * 1000) return true;

  // Message-based cooldown
  const messagesSinceResponse = state.messagesSinceResponse ?? 0;
  if (messagesSinceResponse > cooldown.messages) return true;

  return false;
}

// =============================================================================
// Main logic
// =============================================================================

/**
 * Determine whether to respond to a message and compute next state.
 *
 * @param params.wasMentioned - Whether bot was @mentioned (bypasses maxRatio)
 * @param params.random - Injectable random function for testing (default: Math.random)
 */
export function shouldRespond(params: {
  config: EngagementConfig;
  state: EngagementState;
  messageText: string;
  now: number;
  wasMentioned?: boolean;
  random?: () => number;
}): ShouldRespondResult {
  const { config, state, messageText, now } = params;
  const random = params.random ?? Math.random;

  const ratioWindow = config.ratioWindow ?? 10;
  const hasTrigger = hasTriggerWord(messageText, config.triggerWords);

  // Direct summons (trigger word or @mention) bypass maxRatio
  // Someone explicitly called the bot, they want a response
  const directSummon = hasTrigger || params.wasMentioned;

  // 1. Check ratio limit — suppress if bot is dominating (unless direct summon)
  if (config.maxRatio !== undefined && !directSummon) {
    const currentRatio = calculateBotRatio(state.recentMessages, ratioWindow);
    if (currentRatio >= config.maxRatio) {
      // Suppress response, but still update window with this message (as non-bot)
      return {
        respond: false,
        nextState: updateStateForNonResponse(state, now, ratioWindow),
      };
    }
  }

  // 2. Check cooldown → maybe reset to lurking
  const cooledDown = checkCooldown(state, config.cooldown, now);
  const effectiveEngaged = state.engaged && !cooledDown;

  // 3. When engaged, always respond (no probability roll)
  // This makes engagement feel like "I'm in this conversation now"
  // The bot will stay engaged until cooldown or maxRatio kicks in
  if (effectiveEngaged) {
    return {
      respond: true,
      nextState: updateStateForResponse(state, effectiveEngaged, now, ratioWindow),
    };
  }

  // 4. When lurking, use probability (baseChance + trigger boost)
  let chance = config.baseChance;

  if (hasTrigger) {
    chance = Math.min(1, chance + config.triggerBoost);
  }

  // 5. Roll the dice
  const respond = random() < chance;

  // 6. Compute next state
  if (respond) {
    return {
      respond: true,
      nextState: updateStateForResponse(state, effectiveEngaged, now, ratioWindow),
    };
  } else {
    return {
      respond: false,
      nextState: updateStateForNonResponse(state, now, ratioWindow, effectiveEngaged),
    };
  }
}

// =============================================================================
// State update helpers
// =============================================================================

function updateStateForResponse(
  state: EngagementState,
  wasEngaged: boolean,
  now: number,
  ratioWindow: number,
): EngagementState {
  const recentMessages = appendToWindow(
    state.recentMessages,
    { isBot: true, at: now },
    ratioWindow,
  );

  return {
    engaged: true,
    engagedAt: wasEngaged ? state.engagedAt : now,
    lastResponseAt: now,
    lastMessageAt: now,
    messagesSinceResponse: 0,
    recentMessages,
  };
}

function updateStateForNonResponse(
  state: EngagementState,
  now: number,
  ratioWindow: number,
  stayEngaged?: boolean,
): EngagementState {
  const recentMessages = appendToWindow(
    state.recentMessages,
    { isBot: false, at: now },
    ratioWindow,
  );

  return {
    engaged: stayEngaged ?? state.engaged,
    engagedAt: state.engagedAt,
    lastResponseAt: state.lastResponseAt,
    lastMessageAt: now,
    messagesSinceResponse: (state.messagesSinceResponse ?? 0) + 1,
    recentMessages,
  };
}

function appendToWindow(
  messages: RecentMessage[] | undefined,
  newMessage: RecentMessage,
  windowSize: number,
): RecentMessage[] {
  const current = messages ?? [];
  const updated = [...current, newMessage];

  // Trim to window size (keep most recent)
  if (updated.length > windowSize) {
    return updated.slice(-windowSize);
  }
  return updated;
}
