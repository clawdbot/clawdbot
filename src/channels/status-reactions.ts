// Status-reaction controller helpers for channel-visible agent activity.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { TOOL_DISPLAY_CONFIG } from "../agents/tool-display-config.js";
import { resolveToolDisplay } from "../agents/tool-display.js";

/** Adapter implemented by channels that expose message reaction status updates. */
export type StatusReactionAdapter = {
  /** Set/replace the current reaction emoji. */
  setReaction: (emoji: string) => Promise<void>;
  /** Clear all status reactions for single-slot platforms such as WhatsApp. */
  clearReaction?: () => Promise<void>;
  /** Remove a specific reaction emoji (optional — needed for Discord-style platforms). */
  removeReaction?: (emoji: string) => Promise<void>;
};

/** Optional emoji overrides for each status reaction state. */
export type StatusReactionEmojis = {
  queued?: string;
  thinking?: string;
  tool?: string;
  coding?: string;
  web?: string;
  deploy?: string;
  build?: string;
  concierge?: string;
  done?: string;
  error?: string;
  stallSoft?: string;
  stallHard?: string;
  compacting?: string;
};

/** Timing controls for debounced status reactions and stall warnings. */
export type StatusReactionTiming = {
  debounceMs?: number;
  stallSoftMs?: number;
  stallHardMs?: number;
  doneHoldMs?: number;
  errorHoldMs?: number;
};

/** Controller API for agent status reaction state transitions. */
export type StatusReactionController = {
  setQueued: () => Promise<void> | void;
  setThinking: () => Promise<void> | void;
  setTool: (toolName?: string) => Promise<void> | void;
  setCompacting: () => Promise<void> | void;
  /** Cancel any pending debounced emoji (useful before forcing a state transition). */
  cancelPending: () => void;
  setDone: () => Promise<void>;
  setError: () => Promise<void>;
  clear: () => Promise<void>;
  restoreInitial: () => Promise<void>;
};

/** Default emoji set used by status reaction controllers. */
export const DEFAULT_EMOJIS: Required<StatusReactionEmojis> = {
  queued: "👀",
  thinking: "🧠",
  tool: "🛠️",
  coding: "💻",
  web: "🌐",
  deploy: "🛫",
  build: "🏗️",
  concierge: "💁",
  done: "✅",
  error: "❌",
  stallSoft: "⏳",
  stallHard: "⚠️",
  compacting: "🗜️",
};

/** Default debounce, stall, and terminal hold timings for status reactions. */
export const DEFAULT_TIMING: Required<StatusReactionTiming> = {
  debounceMs: 700,
  stallSoftMs: 10_000,
  stallHardMs: 30_000,
  doneHoldMs: 1500,
  errorHoldMs: 2500,
};

/** Tool-name tokens mapped to the coding status reaction. */
export const CODING_TOOL_TOKENS: string[] = [
  "exec",
  "process",
  "read",
  "write",
  "edit",
  "session_status",
  "bash",
];

/** Tool-name tokens mapped to the web status reaction. */
export const WEB_TOOL_TOKENS: string[] = [
  "web_search",
  "web-search",
  "web_fetch",
  "web-fetch",
  "browser",
];

/** Tool-name tokens mapped to the deploy status reaction. */
export const DEPLOY_TOOL_TOKENS: string[] = [
  "fastlane",
  "deploy",
  "upload",
  "testflight",
  "ship",
  "release",
  "publish",
  "distribute",
];

/** Tool-name tokens mapped to the build status reaction. */
export const BUILD_TOOL_TOKENS: string[] = [
  "build",
  "compile",
  "xcode",
  "swift",
  "gradle",
  "cargo",
  "make",
  "cmake",
  "webpack",
  "vite",
  "tsc",
  "lint",
];

/** Tool-name tokens mapped to the concierge/browser-control status reaction. */
export const CONCIERGE_TOOL_TOKENS: string[] = [
  "navigate",
  "click",
  "fill",
  "screenshot",
  "scroll",
  "page",
  "form",
  "puppeteer",
  "playwright",
  "selenium",
  "chromedp",
];

/** Resolves the appropriate emoji for a tool invocation. */
export function resolveToolEmoji(
  toolName: string | undefined,
  emojis: Required<StatusReactionEmojis>,
  emojiOverrides?: StatusReactionEmojis,
): string {
  const normalized = normalizeOptionalLowercaseString(toolName) ?? "";
  if (!normalized) {
    return emojis.tool;
  }

  const category = DEPLOY_TOOL_TOKENS.some((token) => normalized.includes(token))
    ? "deploy"
    : BUILD_TOOL_TOKENS.some((token) => normalized.includes(token))
      ? "build"
      : CONCIERGE_TOOL_TOKENS.some((token) => normalized.includes(token))
        ? "concierge"
        : WEB_TOOL_TOKENS.some((token) => normalized.includes(token))
          ? "web"
          : CODING_TOOL_TOKENS.some((token) => normalized.includes(token))
            ? "coding"
            : "tool";
  if (emojiOverrides?.[category] !== undefined) {
    return emojis[category];
  }
  if (Object.hasOwn(TOOL_DISPLAY_CONFIG.tools, normalized)) {
    return resolveToolDisplay({ name: toolName }).emoji;
  }
  if (category === "deploy") {
    return emojis.deploy;
  }
  if (category === "build") {
    return emojis.build;
  }
  if (category === "concierge") {
    return emojis.concierge;
  }
  if (category === "web") {
    return emojis.web;
  }
  if (category === "coding") {
    return emojis.coding;
  }
  return emojis.tool;
}

/**
 * Create a status reaction controller.
 *
 * Features:
 * - Promise chain serialization (prevents concurrent API calls)
 * - Debouncing (intermediate states debounce, terminal states are immediate)
 * - Stall timers (soft/hard warnings on inactivity)
 * - Terminal state protection (done/error mark finished, subsequent updates ignored)
 * - Defers reaction removals until final cleanup to avoid visible flicker on
 *   platforms without atomic reaction replacement
 */
export function createStatusReactionController(params: {
  enabled: boolean;
  adapter: StatusReactionAdapter;
  initialEmoji: string;
  emojis?: StatusReactionEmojis;
  timing?: StatusReactionTiming;
  onError?: (err: unknown) => void;
}): StatusReactionController {
  const { enabled, adapter, initialEmoji, onError } = params;

  const emojis: Required<StatusReactionEmojis> = {
    ...DEFAULT_EMOJIS,
    queued: params.emojis?.queued ?? initialEmoji,
    ...params.emojis,
  };

  const timing: Required<StatusReactionTiming> = {
    ...DEFAULT_TIMING,
    ...params.timing,
  };

  let currentEmoji = "";
  let pendingEmoji = "";
  let debounceTimer: NodeJS.Timeout | null = null;
  let stallSoftTimer: NodeJS.Timeout | null = null;
  let stallHardTimer: NodeJS.Timeout | null = null;
  let finished = false;
  let chainPromise = Promise.resolve();
  const activeEmojis = new Set<string>();

  function enqueue(fn: () => Promise<void>): Promise<void> {
    chainPromise = chainPromise.then(fn, fn);
    return chainPromise;
  }

  function clearAllTimers(): void {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (stallSoftTimer) {
      clearTimeout(stallSoftTimer);
      stallSoftTimer = null;
    }
    if (stallHardTimer) {
      clearTimeout(stallHardTimer);
      stallHardTimer = null;
    }
  }

  function clearDebounceTimer(): void {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  function resetStallTimers(): void {
    if (stallSoftTimer) {
      clearTimeout(stallSoftTimer);
    }
    if (stallHardTimer) {
      clearTimeout(stallHardTimer);
    }

    stallSoftTimer = setTimeout(() => {
      scheduleEmoji(emojis.stallSoft, { immediate: true, skipStallReset: true });
    }, timing.stallSoftMs);

    stallHardTimer = setTimeout(() => {
      scheduleEmoji(emojis.stallHard, { immediate: true, skipStallReset: true });
    }, timing.stallHardMs);
  }

  async function removeActiveEmojis(options: { keepEmoji?: string } = {}): Promise<void> {
    if (!adapter.removeReaction) {
      return;
    }

    for (const emoji of Array.from(activeEmojis)) {
      if (emoji === options.keepEmoji) {
        continue;
      }
      try {
        await adapter.removeReaction(emoji);
      } catch (err) {
        if (onError) {
          onError(err);
        }
      } finally {
        activeEmojis.delete(emoji);
      }
    }
  }

  async function applyEmoji(newEmoji: string): Promise<void> {
    if (!enabled) {
      return;
    }

    try {
      if (!adapter.removeReaction || !activeEmojis.has(newEmoji)) {
        await adapter.setReaction(newEmoji);
      }

      activeEmojis.add(newEmoji);
      currentEmoji = newEmoji;
    } catch (err) {
      if (onError) {
        onError(err);
      }
    }
  }

  function scheduleEmoji(
    emoji: string,
    options: { immediate?: boolean; skipStallReset?: boolean } = {},
  ): void {
    if (!enabled || finished) {
      return;
    }

    // Skip duplicate sends while still refreshing stall timers for active phases.
    if (emoji === currentEmoji || emoji === pendingEmoji) {
      if (!options.skipStallReset) {
        resetStallTimers();
      }
      return;
    }

    pendingEmoji = emoji;
    clearDebounceTimer();

    if (options.immediate) {
      void enqueue(async () => {
        await applyEmoji(emoji);
        pendingEmoji = "";
      });
    } else {
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void enqueue(async () => {
          await applyEmoji(emoji);
          pendingEmoji = "";
        });
      }, timing.debounceMs);
    }

    if (!options.skipStallReset) {
      resetStallTimers();
    }
  }

  function setQueued(): void {
    scheduleEmoji(emojis.queued, { immediate: true });
  }

  function setThinking(): void {
    scheduleEmoji(emojis.thinking);
  }

  function setTool(toolName?: string): void {
    const emoji = resolveToolEmoji(toolName, emojis, params.emojis);
    scheduleEmoji(emoji);
  }

  function setCompacting(): void {
    scheduleEmoji(emojis.compacting);
  }

  function cancelPending(): void {
    clearDebounceTimer();
    pendingEmoji = "";
  }

  function finishWithEmoji(emoji: string): Promise<void> {
    if (!enabled) {
      return Promise.resolve();
    }

    finished = true;
    clearAllTimers();

    // Return the updated chain so callers can wait for terminal cleanup.
    return enqueue(async () => {
      await applyEmoji(emoji);
      await removeActiveEmojis({ keepEmoji: emoji });
      pendingEmoji = "";
    });
  }

  function setDone(): Promise<void> {
    return finishWithEmoji(emojis.done);
  }

  function setError(): Promise<void> {
    return finishWithEmoji(emojis.error);
  }

  async function clear(): Promise<void> {
    if (!enabled) {
      return;
    }

    clearAllTimers();
    finished = true;

    await enqueue(async () => {
      if (adapter.clearReaction) {
        try {
          await adapter.clearReaction();
        } catch (err) {
          if (onError) {
            onError(err);
          }
        } finally {
          activeEmojis.clear();
        }
      } else if (adapter.removeReaction) {
        await removeActiveEmojis();
      } else {
        // Telegram handles this atomically on the next setReaction.
      }
      currentEmoji = "";
      pendingEmoji = "";
    });
  }

  async function restoreInitial(): Promise<void> {
    if (!enabled) {
      return;
    }

    const alreadyInitial = currentEmoji === initialEmoji;
    const pendingBeforeClear = pendingEmoji;
    const hadDebouncedPending = debounceTimer !== null;
    const hasExtraActiveEmoji = Array.from(activeEmojis).some((emoji) => emoji !== initialEmoji);
    clearAllTimers();
    if (alreadyInitial && (!pendingBeforeClear || hadDebouncedPending) && !hasExtraActiveEmoji) {
      pendingEmoji = "";
      return;
    }
    if (pendingBeforeClear === initialEmoji && !hadDebouncedPending) {
      await chainPromise;
      return;
    }

    await enqueue(async () => {
      await applyEmoji(initialEmoji);
      await removeActiveEmojis({ keepEmoji: initialEmoji });
      pendingEmoji = "";
    });
  }

  return {
    setQueued,
    setThinking,
    setTool,
    setCompacting,
    cancelPending,
    setDone,
    setError,
    clear,
    restoreInitial,
  };
}
