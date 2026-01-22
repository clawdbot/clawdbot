/**
 * Bubble Service for Claude Code Sessions
 *
 * Provides a high-level interface for managing Telegram bubbles
 * using the standard Telegram send/edit functions.
 *
 * Features:
 * - Status bubble with live updates and Continue/Cancel buttons
 * - Takopi-style debouncing (signal-based, content comparison)
 * - Hybrid format: summarized actions + expanded Q&A when active
 * - Runtime limit enforcement (3 hours default)
 *
 * Takopi patterns applied:
 * - Signal-based update triggering (event_seq vs rendered_seq)
 * - Content comparison before editing
 * - Pending update coalescing
 * - Non-blocking edits
 */

import { sendMessageTelegram, editMessageTelegram } from "../../telegram/send.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { buildBubbleKeyboard } from "./bubble-manager.js";
import { logDyDoCommand, getLatestDyDoCommand } from "./orchestrator.js";
import type { SessionState, SessionEvent } from "./types.js";

const log = createSubsystemLogger("claude-code/bubble-service");

// ============================================================================
// Takopi-style Hybrid Bubble Format
// ============================================================================

/**
 * Q&A state for tracking DyDo↔CC conversations.
 */
interface QAState {
  /** Current question from CC (if any) */
  currentQuestion?: string;
  /** DyDo's pending answer (if thinking) */
  dydoThinking?: boolean;
  /** Recent answered Q&As (for summarization) */
  answeredCount: number;
}

const qaStates = new Map<string, QAState>();

/**
 * Takopi-style hard break: two spaces + newline.
 * Creates line breaks without paragraph spacing.
 */
const HARD_BREAK = "  \n";

/**
 * Format session state into hybrid bubble message.
 *
 * Takopi-style format:
 * - Header: "working · project · 45m" (no bold, uses · separator)
 * - Body: action lines with status icons (no list markers)
 * - Footer: ctx and resume lines with hard breaks
 * - Sections separated by double newline
 */
function formatHybridBubbleMessage(state: SessionState, sessionId: string): string {
  const qaState = qaStates.get(sessionId) || { answeredCount: 0 };

  // Header: "working · project · 45m" or "done · project · 45m"
  // IMPORTANT: "done" should only show when session process has ended
  const sessionEnded =
    state.status === "completed" || state.status === "cancelled" || state.status === "failed";
  const isBlocked = state.status === "blocked";

  // Determine status label
  let statusLabel: string;
  if (isBlocked) {
    statusLabel = "⚠️ blocked";
  } else if (sessionEnded) {
    statusLabel = state.blockerInfo ? "⏸️ partial" : "done";
  } else {
    statusLabel = "working";
  }

  const runtime = compactRuntime(state.runtimeStr);
  const header = `${statusLabel} · ${state.projectName} · ${runtime}`;

  // Get DyDo's command for this session
  const dydoCommand = state.resumeToken ? getLatestDyDoCommand(state.resumeToken) : undefined;

  // Build body lines (no list markers, use hard breaks)
  const bodyLines: string[] = [];

  // === BLOCKED STATE ===
  if (isBlocked && state.blockerInfo) {
    bodyLines.push(`⚠️ Blocker: ${state.blockerInfo.reason}`);
    bodyLines.push("");
    bodyLines.push("_DyDo is attempting to resolve..._");
  }
  // === DONE STATE (with possible blocker) ===
  else if (sessionEnded) {
    // Show blocker info if present
    if (state.blockerInfo) {
      bodyLines.push(`⚠️ Blocked: ${state.blockerInfo.reason}`);
      bodyLines.push("");

      // Show extracted context if available
      if (state.blockerInfo.extractedContext) {
        const ctx = state.blockerInfo.extractedContext;
        if (ctx.wallet) bodyLines.push(`Wallet: \`${ctx.wallet}\``);
        if (ctx.current !== undefined && ctx.needed !== undefined) {
          bodyLines.push(`Balance: ${ctx.current} SOL (need ${ctx.needed} SOL)`);
        }
        bodyLines.push("");
      }

      bodyLines.push("_Click Continue after resolving the blocker_");
    } else {
      // Normal done state - show last message summary
      const lastMessage = state.recentActions
        .slice()
        .reverse()
        .find((a) => a.icon === "💬");
      if (lastMessage) {
        // Use fullText if available (contains complete message), otherwise fall back to description
        const fullMsg = lastMessage.fullText || lastMessage.description;
        // Allow up to 2500 chars for the summary in done state
        // (Telegram limit is 4096, header+footer ~200 chars)
        const maxSummaryLength = 2500;
        const msg =
          fullMsg.length > maxSummaryLength
            ? fullMsg.slice(0, maxSummaryLength - 3) + "..."
            : fullMsg;
        bodyLines.push(`💬 ${msg}`);
      } else {
        bodyLines.push("_(session complete)_");
      }
    }
  } else {
    // === WORKING STATE ===
    // Summarize answered Q&As if any
    if (qaState.answeredCount > 0) {
      bodyLines.push(
        `✓ DyDo answered ${qaState.answeredCount} question${qaState.answeredCount > 1 ? "s" : ""}`,
      );
    }

    // Check if Q&A is currently active
    if (qaState.currentQuestion && qaState.dydoThinking) {
      const questionPreview =
        qaState.currentQuestion.length > 150
          ? qaState.currentQuestion.slice(0, 147) + "..."
          : qaState.currentQuestion;
      bodyLines.push(`💬 CC asking: ${questionPreview}`);
      bodyLines.push(`🐶 DyDo thinking...`);
    }

    // Show recent actions (last 6, no list markers)
    const actionsToShow = state.recentActions.slice(-6);
    if (actionsToShow.length > 0) {
      for (const action of actionsToShow) {
        bodyLines.push(`${action.icon} ${action.description}`);
      }
    } else if (!qaState.currentQuestion) {
      bodyLines.push("_(waiting...)_");
    }
  }

  // Footer: context and resume command with hard breaks
  const ctxLine = state.projectName.includes("@")
    ? `ctx: ${state.projectName}`
    : `ctx: ${state.projectName} @${state.branch}`;
  const resumeLine = `\`claude --resume ${state.resumeToken}\``;
  const footer = ctxLine + HARD_BREAK + resumeLine;

  // Assemble: header \n\n body \n\n footer
  const body = bodyLines.length > 0 ? bodyLines.join(HARD_BREAK) : null;
  const parts = [header, body, footer].filter(Boolean);
  return parts.join("\n\n");
}

/**
 * Compact runtime format: "0h 5m" → "5m", "1h 30m" → "1h 30m"
 */
function compactRuntime(runtime: string): string {
  if (runtime.startsWith("0h ")) {
    return runtime.slice(3);
  }
  return runtime;
}

/**
 * Record that CC asked a question (for hybrid display).
 */
export function recordCCQuestion(sessionId: string, question: string): void {
  const qaState = qaStates.get(sessionId) || { answeredCount: 0 };
  qaState.currentQuestion = question;
  qaState.dydoThinking = true;
  qaStates.set(sessionId, qaState);
}

/**
 * Record that DyDo answered (collapse Q&A in display).
 */
export function recordDyDoAnswer(sessionId: string): void {
  const qaState = qaStates.get(sessionId) || { answeredCount: 0 };
  qaState.currentQuestion = undefined;
  qaState.dydoThinking = false;
  qaState.answeredCount++;
  qaStates.set(sessionId, qaState);
}

/**
 * Clear Q&A state for a session.
 */
export function clearQAState(sessionId: string): void {
  qaStates.delete(sessionId);
}

// ============================================================================
// Takopi-style Debouncing
// ============================================================================

/**
 * Pending update state for debouncing.
 * Implements takopi's signal-based approach.
 */
interface PendingUpdate {
  /** Event sequence number (incremented on each update) */
  eventSeq: number;
  /** Rendered sequence number (what's currently displayed) */
  renderedSeq: number;
  /** Last rendered content (for comparison) */
  lastRenderedContent: string;
  /** Timer for coalescing rapid updates */
  coalescingTimer?: ReturnType<typeof setTimeout>;
  /** Minimum interval between edits (ms) */
  minEditInterval: number;
  /** Last edit timestamp */
  lastEditAt: number;
}

const pendingUpdates = new Map<string, PendingUpdate>();

/**
 * Get or create pending update state for a session.
 */
function getPendingUpdate(sessionId: string): PendingUpdate {
  let pending = pendingUpdates.get(sessionId);
  if (!pending) {
    pending = {
      eventSeq: 0,
      renderedSeq: 0,
      lastRenderedContent: "",
      minEditInterval: 1500, // 1.5s minimum between edits
      lastEditAt: 0,
    };
    pendingUpdates.set(sessionId, pending);
  }
  return pending;
}

/**
 * Signal that an update is needed (takopi-style).
 * Uses coalescing to batch rapid updates.
 */
function signalUpdate(sessionId: string): void {
  const pending = getPendingUpdate(sessionId);
  pending.eventSeq++;

  // Clear existing timer (coalescing)
  if (pending.coalescingTimer) {
    clearTimeout(pending.coalescingTimer);
  }

  // Schedule update with small delay for coalescing
  pending.coalescingTimer = setTimeout(() => {
    pending.coalescingTimer = undefined;
    // The actual update will be triggered by the next updateSessionBubble call
  }, 100); // 100ms coalescing window
}

/**
 * Active bubble tracking.
 */
interface ActiveBubble {
  chatId: string;
  messageId: string;
  threadId?: number;
  resumeToken: string;
  lastUpdate: number;
  accountId?: string;
  // Project info for resume
  workingDir: string;
  projectName: string;
  // Runtime limit tracking
  startedAt: number;
  runtimeLimitHours: number;
  isPaused: boolean;
  // Last forwarded event index (to avoid duplicates)
  lastForwardedEventIndex: number;
}

const activeBubbles = new Map<string, ActiveBubble>();

/**
 * Format a session event for Telegram message forwarding.
 * Uses emoji convention: 🐶 = user, 💬 = Claude, ▸ = tool start, ✓ = tool done
 */
function formatEventForForward(event: SessionEvent): string | null {
  switch (event.type) {
    case "user_message":
      if (event.text) {
        const truncated = event.text.length > 200 ? event.text.slice(0, 197) + "..." : event.text;
        return `🐶 ${truncated}`;
      }
      return null;

    case "assistant_message":
      if (event.text) {
        // Skip redundant status messages (bubble already shows this)
        if (
          event.text === "Session ended with error" ||
          event.text === "Session completed" ||
          event.text.startsWith("Session ended")
        ) {
          return null;
        }
        const truncated = event.text.length > 300 ? event.text.slice(0, 297) + "..." : event.text;
        return `💬 ${truncated}`;
      }
      return null;

    case "tool_use":
      const toolName = event.toolName ?? "tool";
      const input = event.toolInput ?? "";
      const filename = extractFilename(input);

      if (toolName.toLowerCase().includes("read")) {
        return `▸ Reading ${filename || "file"}`;
      }
      if (toolName.toLowerCase().includes("write")) {
        return `▸ Writing ${filename || "file"}`;
      }
      if (toolName.toLowerCase().includes("edit")) {
        return `▸ Editing ${filename || "file"}`;
      }
      if (toolName.toLowerCase().includes("bash")) {
        const cmd = input.split(/\s/)[0] || "command";
        return `▸ Running: ${cmd.slice(0, 20)}`;
      }
      if (toolName.toLowerCase().includes("grep")) {
        return `▸ Searching code`;
      }
      if (toolName.toLowerCase().includes("glob")) {
        return `▸ Finding files`;
      }
      if (toolName.toLowerCase().includes("task")) {
        return `▸ Running subagent`;
      }
      return `▸ ${toolName}`;

    case "tool_result":
      // Tool results are shown in recentActions, don't forward separately
      return null;

    default:
      return null;
  }
}

/**
 * Extract filename from tool input.
 */
function extractFilename(input: string): string {
  if (!input) return "";
  const match = input.match(/([a-zA-Z0-9_\-.]+\.[a-zA-Z0-9]+)/);
  if (match) {
    const filename = match[1];
    return filename.length > 25 ? filename.slice(0, 22) + "..." : filename;
  }
  return "";
}

/**
 * Create a bubble for a Claude Code session.
 */
export async function createSessionBubble(params: {
  sessionId: string;
  chatId: string | number;
  threadId?: number;
  accountId?: string;
  resumeToken: string;
  state: SessionState;
  workingDir: string;
  runtimeLimitHours?: number;
  /** Optional DyDo command to display */
  dydoCommand?: string;
}): Promise<{ messageId: string } | null> {
  const {
    sessionId,
    chatId,
    threadId,
    accountId,
    resumeToken,
    state,
    workingDir,
    runtimeLimitHours = 3.0,
    dydoCommand,
  } = params;

  // Store DyDo command for display if provided
  if (dydoCommand && resumeToken) {
    logDyDoCommand({ prompt: dydoCommand, resumeToken });
  }

  // Initialize pending update state
  const pending = getPendingUpdate(sessionId);

  // Use hybrid format
  const text = formatHybridBubbleMessage(state, sessionId);
  const keyboard = buildBubbleKeyboard(resumeToken, state, "claude");

  // Store initial content for comparison
  pending.lastRenderedContent = text;

  try {
    const result = await sendMessageTelegram(String(chatId), text, {
      accountId,
      messageThreadId: threadId,
      buttons: keyboard,
      disableLinkPreview: true, // Prevent file names like "progress.md" from showing link previews
    });

    const bubble: ActiveBubble = {
      chatId: result.chatId,
      messageId: result.messageId,
      threadId,
      resumeToken,
      lastUpdate: Date.now(),
      accountId,
      workingDir,
      projectName: state.projectName,
      startedAt: Date.now(),
      runtimeLimitHours,
      isPaused: false,
      lastForwardedEventIndex: 0,
    };

    activeBubbles.set(sessionId, bubble);
    log.info(`[${sessionId}] Created bubble: ${result.messageId}`);

    return { messageId: result.messageId };
  } catch (err) {
    log.error(`[${sessionId}] Failed to create bubble: ${err}`);
    return null;
  }
}

/**
 * Update an existing bubble (takopi-style debounced).
 *
 * Implements:
 * - Content comparison (skip if unchanged)
 * - Rate limiting (1.5s minimum between edits)
 * - Sequence tracking for coalescing
 */
export async function updateSessionBubble(params: {
  sessionId: string;
  state: SessionState;
}): Promise<boolean> {
  const { sessionId, state } = params;
  const bubble = activeBubbles.get(sessionId);

  // Log incoming update for debugging
  const isSessionEnded =
    state.status === "completed" ||
    state.status === "cancelled" ||
    state.status === "failed" ||
    state.status === "blocked";
  log.info(
    `[${sessionId}] updateSessionBubble called: status=${state.status}, ended=${isSessionEnded}, hasBubble=${!!bubble}, token=${state.resumeToken?.slice(0, 8) || "none"}`,
  );

  if (!bubble) {
    log.warn(
      `[${sessionId}] No bubble found in activeBubbles (size=${activeBubbles.size}) - cannot update`,
    );
    return false;
  }

  // Signal update for coalescing
  signalUpdate(sessionId);

  const pending = getPendingUpdate(sessionId);
  const now = Date.now();

  // Rate limiting: respect minimum edit interval
  // IMPORTANT: Skip rate limiting for session end events - these must be shown immediately
  const timeSinceLastEdit = now - pending.lastEditAt;
  if (timeSinceLastEdit < pending.minEditInterval && !isSessionEnded) {
    // Schedule retry after interval
    const delay = pending.minEditInterval - timeSinceLastEdit;
    log.debug(
      `[${sessionId}] Rate limited (${timeSinceLastEdit}ms < ${pending.minEditInterval}ms), will retry in ${delay}ms`,
    );
    setTimeout(() => {
      // Re-trigger update if still pending
      if (pending.eventSeq > pending.renderedSeq) {
        updateSessionBubble({ sessionId, state }).catch(() => {});
      }
    }, delay);
    return true; // Will update later
  }

  if (isSessionEnded) {
    log.info(`[${sessionId}] Session ended - bypassing rate limit to ensure final state is shown`);
  }

  // Generate new content using hybrid format
  const text = formatHybridBubbleMessage(state, sessionId);
  const keyboard = buildBubbleKeyboard(bubble.resumeToken, state, "claude");

  // Content comparison: skip if unchanged (takopi pattern)
  if (text === pending.lastRenderedContent) {
    pending.renderedSeq = pending.eventSeq;
    return true; // No change needed
  }

  try {
    await editMessageTelegram(bubble.chatId, bubble.messageId, text, {
      accountId: bubble.accountId,
      buttons: keyboard,
      disableLinkPreview: true,
    });

    // Update tracking state
    pending.lastRenderedContent = text;
    pending.renderedSeq = pending.eventSeq;
    pending.lastEditAt = now;
    bubble.lastUpdate = now;

    log.info(
      `[${sessionId}] Updated bubble (seq ${pending.renderedSeq}, status=${state.status}, ended=${isSessionEnded})`,
    );
    return true;
  } catch (err) {
    // Telegram returns error if message content hasn't changed
    const errMsg = String(err);
    if (errMsg.includes("message is not modified")) {
      pending.renderedSeq = pending.eventSeq;
      return true; // Not an error
    }
    log.warn(`[${sessionId}] Failed to update bubble: ${err}`);
    return false;
  }
}

/**
 * Mark a bubble as complete (remove buttons, show final state).
 */
export async function completeSessionBubble(params: {
  sessionId: string;
  state: SessionState;
  completedPhases?: string[];
}): Promise<boolean> {
  const { sessionId, state, completedPhases = [] } = params;
  const bubble = activeBubbles.get(sessionId);

  if (!bubble) {
    return false;
  }

  // Takopi-style: header · project · runtime · step N
  const runtime = compactRuntime(state.runtimeStr);
  const header = `done · ${state.projectName} · ${runtime}`;

  // Body: summary of completed work
  const bodyLines: string[] = [];
  bodyLines.push(`✓ ${state.totalEvents.toLocaleString()} events`);

  if (completedPhases.length > 0) {
    for (const phase of completedPhases) {
      bodyLines.push(`✓ ${phase}`);
    }
  }

  // Footer: context and resume command with hard breaks
  const ctxLine = state.projectName.includes("@")
    ? `ctx: ${state.projectName}`
    : `ctx: ${state.projectName} @${state.branch}`;
  const resumeLine = `\`claude --resume ${state.resumeToken}\``;
  const footer = ctxLine + HARD_BREAK + resumeLine;

  // Assemble with double newlines between sections
  const body = bodyLines.join(HARD_BREAK);
  const text = [header, body, footer].join("\n\n");

  try {
    await editMessageTelegram(bubble.chatId, bubble.messageId, text, {
      accountId: bubble.accountId,
      buttons: [], // Remove buttons (CLEAR_MARKUP style)
      disableLinkPreview: true,
    });

    // Cleanup all session state
    activeBubbles.delete(sessionId);
    pendingUpdates.delete(sessionId);
    clearQAState(sessionId);

    log.info(`[${sessionId}] Completed bubble`);
    return true;
  } catch (err) {
    log.error(`[${sessionId}] Failed to complete bubble: ${err}`);
    // Cleanup even on error
    activeBubbles.delete(sessionId);
    pendingUpdates.delete(sessionId);
    clearQAState(sessionId);
    return false;
  }
}

/**
 * Get bubble for a session by ID.
 */
export function getSessionBubble(sessionId: string): ActiveBubble | undefined {
  return activeBubbles.get(sessionId);
}

/**
 * Get bubble by resume token prefix.
 */
export function getBubbleByTokenPrefix(
  tokenPrefix: string,
): { sessionId: string; bubble: ActiveBubble } | undefined {
  for (const [sessionId, bubble] of activeBubbles.entries()) {
    if (bubble.resumeToken.startsWith(tokenPrefix)) {
      return { sessionId, bubble };
    }
  }
  return undefined;
}

/**
 * Remove bubble tracking (without editing the message).
 */
export function removeSessionBubble(sessionId: string): void {
  activeBubbles.delete(sessionId);
}

/**
 * Get bubble by chat ID and message ID (for reply detection).
 * Returns the session ID and bubble if found.
 */
export function getBubbleByMessageId(
  chatId: string | number,
  messageId: string | number,
): { sessionId: string; bubble: ActiveBubble } | undefined {
  const chatIdStr = String(chatId);
  const messageIdStr = String(messageId);

  for (const [sessionId, bubble] of activeBubbles.entries()) {
    if (bubble.chatId === chatIdStr && bubble.messageId === messageIdStr) {
      return { sessionId, bubble };
    }
  }
  return undefined;
}

/**
 * Check if a message is a reply to a bubble and handle it.
 * Returns true if handled, false if not a bubble reply.
 */
export function isReplyToBubble(
  chatId: string | number,
  replyToMessageId: string | number | undefined,
): { sessionId: string; bubble: ActiveBubble } | undefined {
  if (!replyToMessageId) return undefined;
  return getBubbleByMessageId(chatId, replyToMessageId);
}

/**
 * Forward a session event to the chat as a message.
 * Uses emoji convention for visibility.
 */
export async function forwardEventToChat(params: {
  sessionId: string;
  event: SessionEvent;
  eventIndex: number;
}): Promise<boolean> {
  const { sessionId, event, eventIndex } = params;
  const bubble = activeBubbles.get(sessionId);

  if (!bubble) {
    return false;
  }

  // Avoid duplicate forwards
  if (eventIndex <= bubble.lastForwardedEventIndex) {
    return false;
  }

  // Format the event
  const formatted = formatEventForForward(event);
  if (!formatted) {
    // Update index even if we don't forward (e.g., tool_result)
    bubble.lastForwardedEventIndex = eventIndex;
    return false;
  }

  try {
    await sendMessageTelegram(bubble.chatId, formatted, {
      accountId: bubble.accountId,
      messageThreadId: bubble.threadId,
      disableLinkPreview: true,
    });
    bubble.lastForwardedEventIndex = eventIndex;
    return true;
  } catch (err) {
    log.warn(`[${sessionId}] Failed to forward event: ${err}`);
    return false;
  }
}

/**
 * Check if runtime limit has been exceeded.
 */
export function checkRuntimeLimit(sessionId: string): {
  exceeded: boolean;
  elapsedHours: number;
  limitHours: number;
} {
  const bubble = activeBubbles.get(sessionId);
  if (!bubble) {
    return { exceeded: false, elapsedHours: 0, limitHours: 0 };
  }

  const elapsedMs = Date.now() - bubble.startedAt;
  const elapsedHours = elapsedMs / (1000 * 60 * 60);

  return {
    exceeded: elapsedHours >= bubble.runtimeLimitHours,
    elapsedHours,
    limitHours: bubble.runtimeLimitHours,
  };
}

/**
 * Pause the session (for runtime limit or manual pause).
 */
export function pauseSession(sessionId: string): void {
  const bubble = activeBubbles.get(sessionId);
  if (bubble) {
    bubble.isPaused = true;
  }
}

/**
 * Resume a paused session (resets runtime timer).
 */
export function resumeSession(sessionId: string): void {
  const bubble = activeBubbles.get(sessionId);
  if (bubble) {
    bubble.isPaused = false;
    bubble.startedAt = Date.now(); // Reset timer on resume
  }
}

/**
 * Check if session is paused.
 */
export function isSessionPaused(sessionId: string): boolean {
  const bubble = activeBubbles.get(sessionId);
  return bubble?.isPaused ?? false;
}

/**
 * Send a runtime limit warning to the chat.
 */
export async function sendRuntimeLimitWarning(params: {
  sessionId: string;
  elapsedHours: number;
  limitHours: number;
}): Promise<boolean> {
  const { sessionId, elapsedHours, limitHours } = params;
  const bubble = activeBubbles.get(sessionId);

  if (!bubble) {
    return false;
  }

  const text = [
    `**⏱ Runtime Limit Reached**`,
    ``,
    `Session has been running for ${elapsedHours.toFixed(1)}h (limit: ${limitHours}h).`,
    `Session paused. Use **Continue** to resume.`,
  ].join("\n");

  try {
    await sendMessageTelegram(bubble.chatId, text, {
      accountId: bubble.accountId,
      messageThreadId: bubble.threadId,
      disableLinkPreview: true,
    });
    return true;
  } catch (err) {
    log.error(`[${sessionId}] Failed to send runtime warning: ${err}`);
    return false;
  }
}

/**
 * Update all active bubbles to "interrupted" state.
 * Called during gateway shutdown to prevent stale "working" bubbles.
 */
export async function interruptAllBubbles(reason: string = "Gateway restarting"): Promise<void> {
  const bubbleCount = activeBubbles.size;
  if (bubbleCount === 0) {
    log.info(`[shutdown] No active bubbles to interrupt`);
    return;
  }

  log.info(`[shutdown] Interrupting ${bubbleCount} active bubble(s): ${reason}`);

  const promises: Promise<void>[] = [];

  for (const [sessionId, bubble] of activeBubbles.entries()) {
    promises.push(
      (async () => {
        try {
          // Build interrupted state message
          const text = [
            `⚠️ interrupted · ${bubble.projectName} · session paused`,
            "",
            `_${reason}_`,
            "",
            `ctx: ${bubble.projectName}`,
            `\`claude --resume ${bubble.resumeToken}\``,
          ].join("\n");

          // Keep Continue button so user can resume after restart
          const keyboard = [
            [
              {
                text: "▶️ Continue",
                callback_data: `cc:continue:${bubble.resumeToken.slice(0, 8)}`,
              },
            ],
          ];

          await editMessageTelegram(bubble.chatId, bubble.messageId, text, {
            accountId: bubble.accountId,
            buttons: keyboard,
            disableLinkPreview: true,
          });

          log.info(`[shutdown] Interrupted bubble for session ${sessionId}`);
        } catch (err) {
          log.warn(`[shutdown] Failed to interrupt bubble ${sessionId}: ${String(err)}`);
        }
      })(),
    );
  }

  // Wait for all updates with timeout
  await Promise.race([
    Promise.allSettled(promises),
    new Promise((resolve) => setTimeout(resolve, 3000)), // 3s timeout
  ]);

  log.info(`[shutdown] Bubble interruption complete`);
}

/**
 * Send a question to the chat and wait for reply.
 */
export async function sendQuestionToChat(params: {
  sessionId: string;
  questionText: string;
}): Promise<boolean> {
  const { sessionId, questionText } = params;
  const bubble = activeBubbles.get(sessionId);

  if (!bubble) {
    return false;
  }

  const truncated = questionText.length > 500 ? questionText.slice(0, 497) + "..." : questionText;
  const text = [
    `**❓ Claude needs input:**`,
    ``,
    truncated,
    ``,
    `_Reply to this message to answer._`,
  ].join("\n");

  try {
    await sendMessageTelegram(bubble.chatId, text, {
      accountId: bubble.accountId,
      messageThreadId: bubble.threadId,
      disableLinkPreview: true,
    });
    return true;
  } catch (err) {
    log.error(`[${sessionId}] Failed to send question: ${err}`);
    return false;
  }
}
