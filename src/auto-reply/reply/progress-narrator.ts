// Utility-model narration for channel progress drafts.
import { formatToolSummary, resolveToolDisplay } from "../../agents/tool-display.js";
import { resolveUtilityModelRefForAgent } from "../../agents/utility-model.js";
import { PROGRESS_STATUS_PREAMBLE_FRESH_MS } from "../../channels/progress-draft-compositor.js";
import { sanitizeProgressStatusText } from "../../channels/progress-draft-status-text.js";
import { isChannelProgressDraftWorkToolName, isCommandToolName } from "../../channels/streaming.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import {
  generateNarrationWithUtilityModel,
  prepareNarrationModel,
  type ProgressNarrationInput,
  truncateAtWordBoundary,
} from "./progress-narrator-model.js";

const narratorLog = createSubsystemLogger("auto-reply/progress-narrator");

const MIN_EVENTS_PER_NARRATION = 4;
const MIN_INTERVAL_MS = 12_000;
const NARRATION_MAX_CHARS = 280;
const NARRATION_NOTE_MAX_CHARS = 160;
const MAX_ACTIVITY_NOTES = 40;
const VISIBILITY_RETRY_MS = 1_000;
// Keep hidden-draft polling bounded even when a channel never exposes the draft.
const MAX_VISIBILITY_RETRIES = 30;
const PREAMBLE_RETRY_EPSILON_MS = 1;
const MAX_NARRATIONS_PER_TURN = 30;
const MAX_CONSECUTIVE_FAILURES = 2;

type ProgressNarrator = {
  beginTurn: () => void;
  stopTurn: () => void;
  noteToolStart: (payload: {
    name?: string;
    phase?: string;
    args?: Record<string, unknown>;
  }) => void;
  noteCommandOutput: (payload: {
    name?: string;
    title?: string;
    phase?: string;
    status?: string;
    exitCode?: number | null;
  }) => void;
  noteItemEvent: (payload: {
    kind?: string;
    name?: string;
    title?: string;
    status?: string;
    progressText?: string;
  }) => void;
};

function normalizeNarrationText(raw: string): string {
  const collapsed = raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'`“”]+|["'`“”]+$/gu, "")
    .trim();
  if (!collapsed) {
    return "";
  }
  return truncateAtWordBoundary(collapsed, NARRATION_MAX_CHARS);
}

function createProgressNarrator(params: {
  cfg: OpenClawConfig;
  agentId: string;
  userMessage?: string;
  onUpdate: (payload: { text: string }) => Promise<void> | void;
  isProgressDraftVisible?: () => boolean;
  abortSignal?: AbortSignal;
  /** Mirror of the channel's commandText: "status" policy for narration input. */
  hideCommandText?: boolean;
  /** Test seam: replaces the utility-model completion. */
  generate?: (input: ProgressNarrationInput) => Promise<string | null>;
  now?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}): ProgressNarrator {
  const now = params.now ?? Date.now;
  const setTimeoutFn = params.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = params.clearTimeoutFn ?? clearTimeout;
  const notes: string[] = [];
  let disabled = false;
  let inFlight = false;
  let pendingImmediate = false;
  let notesAtLastRun = -1;
  let lastRunAt = 0;
  let narrationCount = 0;
  let consecutiveFailures = 0;
  let lastText = "";
  let preparedPromise: ReturnType<typeof prepareNarrationModel> | undefined;
  let lastFailure: string | undefined;
  let utilityModelLabel: string | undefined;
  let lastPreambleAt: number | undefined;
  let visibilityRetryCount = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryImmediate = false;
  let turnGeneration = 0;
  let turnActive = true;
  let userMessage = params.userMessage ?? "";

  const clearRetryTimer = () => {
    if (retryTimer !== undefined) {
      clearTimeoutFn(retryTimer);
      retryTimer = undefined;
    }
    retryImmediate = false;
  };

  const resetTurnState = () => {
    turnGeneration += 1;
    turnActive = true;
    // Queued turns reuse the narrator lifecycle but not the primary request.
    // Empty context is safer than describing follow-up work with stale intent.
    userMessage = "";
    notes.splice(0);
    disabled = false;
    inFlight = false;
    pendingImmediate = false;
    notesAtLastRun = -1;
    lastRunAt = 0;
    narrationCount = 0;
    consecutiveFailures = 0;
    lastText = "";
    lastFailure = undefined;
    lastPreambleAt = undefined;
    visibilityRetryCount = 0;
    clearRetryTimer();
  };

  const stopTurn = () => {
    if (!turnActive) {
      return;
    }
    turnGeneration += 1;
    turnActive = false;
    inFlight = false;
    pendingImmediate = false;
    clearRetryTimer();
  };

  // Stopping mid-turn must clear any rendered narration so the channel draft
  // falls back to raw tool lines instead of pinning stale status text.
  function disableNarration() {
    clearRetryTimer();
    if (disabled) {
      return;
    }
    disabled = true;
    if (!lastText || params.abortSignal?.aborted) {
      return;
    }
    lastText = "";
    void Promise.resolve(params.onUpdate({ text: "" })).catch((err: unknown) => {
      logVerbose(`progress-narrator: narration clear failed: ${String(err)}`);
    });
  }

  const generate =
    params.generate ??
    (async (input: ProgressNarrationInput) => {
      preparedPromise ??= prepareNarrationModel({ cfg: params.cfg, agentId: params.agentId });
      const prepared = await preparedPromise;
      if (!prepared) {
        disableNarration();
        return null;
      }
      const { provider, modelId, profileId } = prepared.selection;
      utilityModelLabel = `${provider}/${modelId}${profileId ? ` via ${profileId}` : ""}`;
      const outcome = await generateNarrationWithUtilityModel({
        cfg: params.cfg,
        prepared,
        input,
        abortSignal: params.abortSignal,
      });
      lastFailure = outcome.error;
      return outcome.text;
    });

  const addNote = (note: string, options?: { immediate?: boolean }) => {
    if (!turnActive || disabled || params.abortSignal?.aborted) {
      return;
    }
    visibilityRetryCount = 0;
    notes.push(truncateAtWordBoundary(note.replace(/\s+/g, " ").trim(), NARRATION_NOTE_MAX_CHARS));
    if (notes.length > MAX_ACTIVITY_NOTES) {
      notes.splice(0, notes.length - MAX_ACTIVITY_NOTES);
    }
    maybeRun(options?.immediate === true);
  };

  const shouldRunNow = (immediate: boolean): boolean => {
    const newNotes = notes.length - Math.max(0, notesAtLastRun);
    if (newNotes <= 0) {
      return false;
    }
    if (immediate || notesAtLastRun < 0) {
      return true;
    }
    if (newNotes >= MIN_EVENTS_PER_NARRATION) {
      return true;
    }
    return now() - lastRunAt >= MIN_INTERVAL_MS;
  };

  // Skips retain note bookkeeping; one replaceable timer rechecks the active gate.
  const scheduleRetry = (delayMs: number, immediate: boolean) => {
    retryImmediate ||= immediate;
    if (retryTimer !== undefined) {
      clearTimeoutFn(retryTimer);
      retryTimer = undefined;
    }
    if (!turnActive || disabled || params.abortSignal?.aborted) {
      retryImmediate = false;
      return;
    }
    retryTimer = setTimeoutFn(
      () => {
        retryTimer = undefined;
        const rerunImmediate = retryImmediate;
        retryImmediate = false;
        maybeRun(rerunImmediate);
      },
      Math.max(1, delayMs),
    );
  };

  function maybeRun(immediate: boolean) {
    if (!turnActive || disabled || params.abortSignal?.aborted) {
      clearRetryTimer();
      return;
    }
    if (params.isProgressDraftVisible?.() === false) {
      if (visibilityRetryCount < MAX_VISIBILITY_RETRIES) {
        visibilityRetryCount += 1;
        scheduleRetry(VISIBILITY_RETRY_MS, immediate);
      }
      return;
    }
    const preambleAge = lastPreambleAt === undefined ? undefined : now() - lastPreambleAt;
    if (preambleAge !== undefined && preambleAge < PROGRESS_STATUS_PREAMBLE_FRESH_MS) {
      scheduleRetry(
        PROGRESS_STATUS_PREAMBLE_FRESH_MS - preambleAge + PREAMBLE_RETRY_EPSILON_MS,
        immediate,
      );
      return;
    }
    clearRetryTimer();
    if (inFlight) {
      pendingImmediate ||= immediate;
      return;
    }
    if (!shouldRunNow(immediate)) {
      return;
    }
    if (narrationCount >= MAX_NARRATIONS_PER_TURN) {
      disableNarration();
      return;
    }
    visibilityRetryCount = 0;
    inFlight = true;
    const runGeneration = turnGeneration;
    narrationCount += 1;
    notesAtLastRun = notes.length;
    lastRunAt = now();
    const input: ProgressNarrationInput = {
      userMessage,
      activityNotes: [...notes],
      previousText: lastText,
    };
    void (async () => {
      try {
        const raw = await generate(input);
        if (!turnActive || runGeneration !== turnGeneration) {
          return;
        }
        const text = raw ? normalizeNarrationText(raw) : "";
        if (!text) {
          consecutiveFailures += 1;
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            // A dead utility-model credential otherwise degrades silently to raw
            // tool lines; per-attempt detail is verbose-only, so emit one warn
            // per turn naming the model/profile operators must repair.
            narratorLog.warn(
              `narration disabled after ${consecutiveFailures} consecutive failures` +
                (utilityModelLabel ? ` (${utilityModelLabel})` : "") +
                (lastFailure ? `: ${lastFailure}` : ""),
            );
            disableNarration();
          }
          return;
        }
        consecutiveFailures = 0;
        if (text === lastText || params.abortSignal?.aborted) {
          return;
        }
        lastText = text;
        await params.onUpdate({ text });
      } catch (err) {
        logVerbose(`progress-narrator: update failed: ${String(err)}`);
      } finally {
        if (runGeneration === turnGeneration) {
          inFlight = false;
          const rerunImmediate = pendingImmediate;
          pendingImmediate = false;
          if (rerunImmediate) {
            maybeRun(true);
          }
        }
      }
    })();
  }

  params.abortSignal?.addEventListener("abort", stopTurn, { once: true });

  return {
    beginTurn() {
      resetTurnState();
    },
    stopTurn,
    noteToolStart(payload) {
      if (payload.phase !== "start" || !isChannelProgressDraftWorkToolName(payload.name)) {
        return;
      }
      const display = resolveToolDisplay({ name: payload.name, args: payload.args });
      // Same command-tool set the draft formatter uses for commandText policy.
      const hideDetail = params.hideCommandText === true && isCommandToolName(display.name);
      addNote(formatToolSummary(hideDetail ? { ...display, detail: undefined } : display));
    },
    noteCommandOutput(payload) {
      if (payload.phase !== "end") {
        return;
      }
      const failed =
        payload.status === "failed" ||
        (typeof payload.exitCode === "number" && payload.exitCode !== 0);
      if (!failed) {
        return;
      }
      // Command-output titles usually carry the raw command text; honor the
      // channel's commandText: "status" policy for the failure note too.
      const subject = params.hideCommandText
        ? payload.name || "command"
        : payload.title || payload.name || "command";
      const exit = typeof payload.exitCode === "number" ? ` (exit ${payload.exitCode})` : "";
      addNote(`${subject} failed${exit}`, { immediate: true });
    },
    noteItemEvent(payload) {
      if (payload.kind === "preamble") {
        const preambleText = sanitizeProgressStatusText(payload.progressText ?? "")
          .replace(/\s+/g, " ")
          .trim();
        if (!preambleText) {
          return;
        }
        lastPreambleAt = now();
        addNote(`model: ${preambleText}`);
        return;
      }
      if (payload.status !== "failed") {
        return;
      }
      addNote(`${payload.title || payload.name || "step"} failed`, { immediate: true });
    },
  };
}

/**
 * Wraps reply options with a progress narrator when the channel opted in via
 * onNarrationUpdate and a utility model resolves (explicit config or the
 * primary provider's declared default; utilityModel: "" disables).
 * Returns the options unchanged otherwise.
 */
export function attachProgressNarratorToReplyOptions(params: {
  cfg: OpenClawConfig;
  agentId: string;
  userMessage?: string;
  opts?: InternalGetReplyOptions;
  /** Model-locked native sessions must never invoke the utility model. */
  disabled?: boolean;
}): InternalGetReplyOptions | undefined {
  const opts = params.opts;
  const onNarrationUpdate = opts?.onNarrationUpdate;
  if (!opts || !onNarrationUpdate || params.disabled === true) {
    return opts;
  }
  // Explicit config or a provider-declared default both enable narration;
  // utilityModel: "" and providers without a default keep it off.
  if (!resolveUtilityModelRefForAgent({ cfg: params.cfg, agentId: params.agentId })) {
    return opts;
  }
  const narrator = createProgressNarrator({
    cfg: params.cfg,
    agentId: params.agentId,
    userMessage: params.userMessage,
    onUpdate: onNarrationUpdate,
    isProgressDraftVisible: opts.isProgressDraftVisible,
    abortSignal: opts.abortSignal,
    hideCommandText: opts.narrationHideCommandText === true,
  });
  opts.onProgressNarratorLifecycle?.({
    beginTurn: narrator.beginTurn,
    stopTurn: narrator.stopTurn,
  });
  return {
    ...opts,
    ...(opts.onToolStart
      ? {
          onToolStart: async (payload) => {
            narrator.noteToolStart(payload);
            return await opts.onToolStart?.(payload);
          },
        }
      : {}),
    ...(opts.onCommandOutput
      ? {
          onCommandOutput: async (payload) => {
            narrator.noteCommandOutput(payload);
            return await opts.onCommandOutput?.(payload);
          },
        }
      : {}),
    ...(opts.onItemEvent
      ? {
          onItemEvent: async (payload) => {
            narrator.noteItemEvent(payload);
            return await opts.onItemEvent?.(payload);
          },
        }
      : {}),
  };
}
