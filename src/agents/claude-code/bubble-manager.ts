/**
 * Bubble Manager for Claude Code Sessions
 *
 * Manages Telegram status bubble messages with:
 * - Real-time status updates
 * - Inline keyboard buttons (Continue, Cancel)
 * - Message editing for progress updates
 *
 * Bubble format:
 * ```
 * **juzi @experimental**
 * 0h 12m · Phase 3 in progress
 *
 * ✓ Read src/config.ts
 * ✓ Edited src/auth.ts
 * ▸ Running tests
 *
 * [Continue] [Cancel]
 * ```
 */

import type { Bot } from "grammy";
import type { SessionState } from "./types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("claude-code/bubble");

/**
 * Options for creating a bubble.
 */
export interface BubbleOptions {
  /** Telegram chat ID */
  chatId: string | number;

  /** Thread/topic ID (for supergroups with topics) */
  threadId?: number;

  /** Telegram bot API instance */
  api: Bot["api"];

  /** Session resume token (for button callbacks) */
  resumeToken: string;

  /** Callback data prefix (default: "claude") */
  callbackPrefix?: string;
}

/**
 * Bubble instance for a session.
 */
export interface BubbleInstance {
  /** Telegram message ID */
  messageId: number;

  /** Chat ID */
  chatId: string | number;

  /** Thread ID if applicable */
  threadId?: number;

  /** Resume token */
  resumeToken: string;

  /** Last update time */
  lastUpdate: number;
}

/**
 * Registry of active bubbles by session ID.
 */
const activeBubbles = new Map<string, BubbleInstance>();

/**
 * Format session state into bubble message text.
 */
export function formatBubbleMessage(state: SessionState): string {
  const lines: string[] = [];

  // Header: Project name
  lines.push(`**${state.projectName}**`);

  // Status line: Runtime · Phase
  const statusParts = [state.runtimeStr];
  if (state.phaseStatus && state.phaseStatus !== "Running") {
    statusParts.push(state.phaseStatus);
  } else if (state.hasQuestion) {
    statusParts.push("Waiting for input");
  } else if (state.isIdle) {
    statusParts.push("Idle");
  } else {
    statusParts.push("Running");
  }
  lines.push(statusParts.join(" · "));

  // Empty line before actions
  lines.push("");

  // Recent actions (last 5-7)
  const actionsToShow = state.recentActions.slice(-7);
  if (actionsToShow.length > 0) {
    for (const action of actionsToShow) {
      lines.push(`${action.icon} ${action.description}`);
    }
  } else {
    lines.push("_Starting..._");
  }

  // Question indicator
  if (state.hasQuestion && state.questionText) {
    lines.push("");
    const questionPreview = state.questionText.slice(0, 100);
    lines.push(`**Question:** ${questionPreview}${state.questionText.length > 100 ? "..." : ""}`);
  }

  return lines.join("\n");
}

/**
 * Build inline keyboard for bubble.
 */
export function buildBubbleKeyboard(
  resumeToken: string,
  state: SessionState,
  prefix: string = "claude",
): Array<Array<{ text: string; callback_data: string }>> {
  const tokenPrefix = resumeToken.slice(0, 8);

  // Different buttons based on state
  if (state.status === "completed" || state.status === "cancelled" || state.status === "failed") {
    // No buttons for finished sessions
    return [];
  }

  if (state.hasQuestion) {
    // When waiting for input, show Continue prominently
    return [
      [
        { text: "Answer", callback_data: `${prefix}:answer:${tokenPrefix}` },
        { text: "Cancel", callback_data: `${prefix}:cancel:${tokenPrefix}` },
      ],
    ];
  }

  // Default: Continue and Cancel
  return [
    [
      { text: "Continue", callback_data: `${prefix}:continue:${tokenPrefix}` },
      { text: "Cancel", callback_data: `${prefix}:cancel:${tokenPrefix}` },
    ],
  ];
}

/**
 * Create a new bubble message.
 */
export async function createBubble(
  sessionId: string,
  state: SessionState,
  options: BubbleOptions,
): Promise<BubbleInstance | undefined> {
  const { chatId, threadId, api, resumeToken, callbackPrefix = "claude" } = options;

  const text = formatBubbleMessage(state);
  const keyboard = buildBubbleKeyboard(resumeToken, state, callbackPrefix);

  try {
    const result = await api.sendMessage(chatId, text, {
      message_thread_id: threadId,
      parse_mode: "Markdown",
      reply_markup: keyboard.length > 0 ? { inline_keyboard: keyboard } : undefined,
    });

    const bubble: BubbleInstance = {
      messageId: result.message_id,
      chatId,
      threadId,
      resumeToken,
      lastUpdate: Date.now(),
    };

    activeBubbles.set(sessionId, bubble);
    log.info(`[${sessionId}] Created bubble: ${result.message_id}`);

    return bubble;
  } catch (err) {
    log.error(`[${sessionId}] Failed to create bubble: ${err}`);
    return undefined;
  }
}

/**
 * Update an existing bubble message.
 */
export async function updateBubble(
  sessionId: string,
  state: SessionState,
  api: Bot["api"],
  callbackPrefix: string = "claude",
): Promise<boolean> {
  const bubble = activeBubbles.get(sessionId);
  if (!bubble) {
    log.warn(`[${sessionId}] No bubble to update`);
    return false;
  }

  // Throttle updates (min 1 second between edits)
  const now = Date.now();
  if (now - bubble.lastUpdate < 1000) {
    return true; // Skip this update
  }

  const text = formatBubbleMessage(state);
  const keyboard = buildBubbleKeyboard(bubble.resumeToken, state, callbackPrefix);

  try {
    await api.editMessageText(bubble.chatId, bubble.messageId, text, {
      parse_mode: "Markdown",
      reply_markup: keyboard.length > 0 ? { inline_keyboard: keyboard } : undefined,
    });

    bubble.lastUpdate = now;
    log.debug(`[${sessionId}] Updated bubble`);
    return true;
  } catch (err) {
    // Telegram returns error if message content hasn't changed
    const errMsg = String(err);
    if (errMsg.includes("message is not modified")) {
      return true; // Not an error, just no change
    }
    log.warn(`[${sessionId}] Failed to update bubble: ${err}`);
    return false;
  }
}

/**
 * Delete a bubble message.
 */
export async function deleteBubble(sessionId: string, api: Bot["api"]): Promise<boolean> {
  const bubble = activeBubbles.get(sessionId);
  if (!bubble) {
    return false;
  }

  try {
    await api.deleteMessage(bubble.chatId, bubble.messageId);
    activeBubbles.delete(sessionId);
    log.info(`[${sessionId}] Deleted bubble`);
    return true;
  } catch (err) {
    log.warn(`[${sessionId}] Failed to delete bubble: ${err}`);
    activeBubbles.delete(sessionId);
    return false;
  }
}

/**
 * Get bubble for a session.
 */
export function getBubble(sessionId: string): BubbleInstance | undefined {
  return activeBubbles.get(sessionId);
}

/**
 * Get bubble by resume token prefix.
 */
export function getBubbleByToken(tokenPrefix: string): BubbleInstance | undefined {
  for (const bubble of activeBubbles.values()) {
    if (bubble.resumeToken.startsWith(tokenPrefix)) {
      return bubble;
    }
  }
  return undefined;
}

/**
 * Send a final completion message.
 */
export async function sendCompletionMessage(
  sessionId: string,
  state: SessionState,
  api: Bot["api"],
  completedPhases: string[] = [],
): Promise<boolean> {
  const bubble = activeBubbles.get(sessionId);
  if (!bubble) {
    return false;
  }

  const lines: string[] = [];

  // Header
  lines.push(`**Session Complete**`);
  lines.push("");
  lines.push(`**Project:** ${state.projectName}`);
  lines.push(`**Runtime:** ${state.runtimeStr}`);
  lines.push(`**Events:** ${state.totalEvents.toLocaleString()}`);

  // Completed phases
  if (completedPhases.length > 0) {
    lines.push("");
    lines.push("**Phases Completed:**");
    for (const phase of completedPhases) {
      lines.push(`- ${phase}`);
    }
  }

  // Resume info
  lines.push("");
  lines.push("---");
  lines.push(`ctx: ${state.projectName} @${state.branch}`);
  lines.push(`\`claude --resume ${state.resumeToken}\``);

  const text = lines.join("\n");

  try {
    // Edit the bubble to show completion (no buttons)
    await api.editMessageText(bubble.chatId, bubble.messageId, text, {
      parse_mode: "Markdown",
    });

    activeBubbles.delete(sessionId);
    log.info(`[${sessionId}] Sent completion message`);
    return true;
  } catch (err) {
    log.error(`[${sessionId}] Failed to send completion message: ${err}`);
    return false;
  }
}

/**
 * BubbleManager class for managing a session's bubble.
 *
 * Usage:
 * ```typescript
 * const manager = new BubbleManager(api, chatId, threadId);
 * await manager.create(sessionId, state, resumeToken);
 *
 * // On state changes
 * await manager.update(state);
 *
 * // On completion
 * await manager.complete(state, completedPhases);
 * ```
 */
export class BubbleManager {
  private api: Bot["api"];
  private chatId: string | number;
  private threadId?: number;
  private sessionId?: string;
  private callbackPrefix: string;

  constructor(
    api: Bot["api"],
    chatId: string | number,
    threadId?: number,
    callbackPrefix: string = "claude",
  ) {
    this.api = api;
    this.chatId = chatId;
    this.threadId = threadId;
    this.callbackPrefix = callbackPrefix;
  }

  /**
   * Create a new bubble for a session.
   */
  async create(
    sessionId: string,
    state: SessionState,
    resumeToken: string,
  ): Promise<BubbleInstance | undefined> {
    this.sessionId = sessionId;
    return createBubble(sessionId, state, {
      chatId: this.chatId,
      threadId: this.threadId,
      api: this.api,
      resumeToken,
      callbackPrefix: this.callbackPrefix,
    });
  }

  /**
   * Update the bubble with new state.
   */
  async update(state: SessionState): Promise<boolean> {
    if (!this.sessionId) {
      return false;
    }
    return updateBubble(this.sessionId, state, this.api, this.callbackPrefix);
  }

  /**
   * Mark the session as complete.
   */
  async complete(state: SessionState, completedPhases: string[] = []): Promise<boolean> {
    if (!this.sessionId) {
      return false;
    }
    return sendCompletionMessage(this.sessionId, state, this.api, completedPhases);
  }

  /**
   * Delete the bubble.
   */
  async delete(): Promise<boolean> {
    if (!this.sessionId) {
      return false;
    }
    return deleteBubble(this.sessionId, this.api);
  }

  /**
   * Get the current bubble instance.
   */
  getBubble(): BubbleInstance | undefined {
    if (!this.sessionId) {
      return undefined;
    }
    return getBubble(this.sessionId);
  }
}
