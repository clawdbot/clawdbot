import {
  createProgressDraftDiffStatTracker,
  type ChannelProgressDraftDiffStat,
} from "./progress-draft-diffstat.js";
import {
  createChannelProgressDraftEventHandlers,
  type ChannelProgressDraftEventLineBuilder,
} from "./progress-draft-events.js";
// Stateful progress-draft compositor for channel streaming previews.
// It merges status, tool, reasoning, and commentary updates until the final reply replaces them.
import { removeChannelProgressDraftLine } from "./progress-draft-lines.js";
import {
  formatReasoningProgressDisplayLine,
  mergeReasoningProgressText,
  normalizeCommentaryProgressText,
  normalizeReasoningProgressLine,
  sanitizeProgressStatusText,
} from "./progress-draft-status-text.js";
import { settleProgressVisibilityCallbackResult } from "./progress-visibility.js";
import {
  createChannelProgressDraftGate,
  type AgentPlanStep,
  type ChannelProgressDraftLine,
  formatChannelProgressDraftText,
  isChannelProgressDraftWorkToolName,
  mergeChannelProgressDraftLine,
  normalizeChannelProgressDraftLineIdentity,
  resolveChannelProgressDraftMaxLineChars,
  resolveChannelProgressDraftMaxLines,
  resolveChannelStreamingProgressCommentary,
  resolveChannelStreamingPreviewToolProgress,
  resolveChannelStreamingSuppressDefaultToolProgressMessages,
  type StreamingCompatEntry,
  type StreamingMode,
} from "./streaming.js";

export { createChannelProgressWorkCounter } from "./progress-work-counter.js";

// A recent model preamble remains the primary status; utility narration fills
// the slot only after the model has been quiet for this interval. Exported for
// the narrator, deliberately not re-exported through the SDK barrels.
export const PROGRESS_STATUS_PREAMBLE_FRESH_MS = 20_000;

// Composes transient channel progress drafts from tool, reasoning, and
// commentary updates. It owns draft lifecycle state before the final reply wins.
type ChannelProgressDraftMode = StreamingMode;
export type ChannelProgressDraftCompositorLine = string | ChannelProgressDraftLine;
export type ChannelProgressDraftCompositorSnapshot = Readonly<{
  lines: readonly ChannelProgressDraftCompositorLine[];
  statusHeadline?: string;
  plan?: readonly AgentPlanStep[];
  planExplanation?: string;
  diffStat?: ChannelProgressDraftDiffStat;
}>;

type ChannelProgressDraftUpdateOptions = {
  flush?: boolean;
  lines?: readonly ChannelProgressDraftCompositorLine[];
};

/** Creates a stateful compositor for one streaming channel reply. */
export function createChannelProgressDraftCompositor(params: {
  entry: StreamingCompatEntry | null | undefined;
  mode: ChannelProgressDraftMode;
  active: boolean;
  seed: string;
  update: (
    text: string,
    options?: ChannelProgressDraftUpdateOptions,
  ) => Promise<boolean | void> | boolean | void;
  deleteCurrent?: () => Promise<void> | void;
  tryNativeUpdate?: (text: string) => Promise<boolean> | boolean;
  /** Publish when structured lines change even if the rendered text does not. */
  updateOnLineChange?: boolean;
  /**
   * Set when the channel renders `update`'s structured `lines` itself, so the
   * composed text carries only the status block (label, headline, checklist).
   */
  rendersRollingLinesNatively?: boolean;
  formatLine?: (line: string) => string;
  isEmptyLine?: (line: ChannelProgressDraftCompositorLine | undefined) => boolean;
  shouldStartNow?: (line: ChannelProgressDraftCompositorLine | undefined) => boolean;
  reasoningLinePrefix?: string;
  commentaryLinePrefix?: string;
  reasoningGate?: boolean;
  commentaryItalics?: boolean;
  now?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  /** Channel-specific formatter policy; event/lifecycle ownership remains in the compositor. */
  buildProgressEventLine?: ChannelProgressDraftEventLineBuilder;
}) {
  const now = params.now ?? Date.now;
  const setTimeoutFn = params.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = params.clearTimeoutFn ?? clearTimeout;
  const reasoningLinePrefix = params.reasoningLinePrefix ?? "";
  const commentaryLinePrefix = params.commentaryLinePrefix ?? "";
  const commentaryItalics = params.commentaryItalics ?? true;
  const stripLaneItalics = (text: string): string =>
    text
      .split("\n")
      .map((line) => line.replace(/^_(.*)_$/su, "$1"))
      .join("\n");
  const previewToolProgressEnabled =
    params.active && resolveChannelStreamingPreviewToolProgress(params.entry, true, params.mode);
  const commentaryProgressEnabled =
    params.active && resolveChannelStreamingProgressCommentary(params.entry, false, params.mode);
  const thinkingProgressEnabled =
    params.active && (params.reasoningGate ?? previewToolProgressEnabled);
  const suppressDefaultToolProgressMessages =
    params.active &&
    resolveChannelStreamingSuppressDefaultToolProgressMessages(params.entry, {
      draftStreamActive: true,
      mode: params.mode,
      previewToolProgressEnabled,
    });
  let progressSuppressed = false;
  let lines: ChannelProgressDraftCompositorLine[] = [];
  let lastRenderedText = "";
  let lastRenderedLines = lines;
  let lastRenderedDiffStatKey = "";
  let reasoningRawText = "";
  let lastReasoningLine: string | undefined;
  // Id-less commentary streams as cumulative snapshots ("Checking" → "Checking
  // the workspace"). Remember the open line so successive snapshots replace in
  // place instead of appending one line per growing prefix.
  let lastIdLessCommentaryId: string | undefined;
  let lastIdLessCommentaryBare = "";
  // Model preambles and narration share the status slot while tool lines keep
  // accumulating underneath for turns where neither source is available.
  let preambleText = "";
  let preambleItemId: string | undefined;
  let preambleAt: number | undefined;
  let narrationText = "";
  let planSteps: AgentPlanStep[] | undefined;
  let planExplanation = "";
  let finalReplyStarted = false;
  let finalReplyDelivered = false;
  const diffStatTracker = createProgressDraftDiffStatTracker({
    canStage: () =>
      params.active &&
      params.mode === "progress" &&
      !progressSuppressed &&
      !finalReplyStarted &&
      !finalReplyDelivered,
  });
  let preambleExpiryTimer: ReturnType<typeof setTimeout> | undefined;
  let lastStartRendered = false;

  const mergeReasoningProgress = (text?: string, options?: { snapshot?: boolean }): string => {
    if (!text) {
      return "";
    }
    reasoningRawText = mergeReasoningProgressText(reasoningRawText, text, {
      snapshot: options?.snapshot === true,
    });
    return normalizeReasoningProgressLine(reasoningRawText);
  };

  const clearPreambleExpiryTimer = () => {
    if (preambleExpiryTimer !== undefined) {
      clearTimeoutFn(preambleExpiryTimer);
      preambleExpiryTimer = undefined;
    }
  };

  const resolveStatusText = () => {
    const preambleIsFresh =
      preambleAt !== undefined && now() - preambleAt < PROGRESS_STATUS_PREAMBLE_FRESH_MS;
    const effectiveNarration = narrationText || planExplanation;
    return preambleText && (preambleIsFresh || !effectiveNarration)
      ? preambleText
      : effectiveNarration;
  };

  const formatDraftText = (draftLines = lines, options?: { formatted?: boolean }) => {
    const narration = resolveStatusText() || undefined;
    // Channels that render the rolling lines themselves (from `update`'s
    // `lines`) would print them twice if they also appeared in this text.
    const linesRenderedByChannel =
      params.rendersRollingLinesNatively === true && Boolean(narration || planSteps?.length);
    return formatChannelProgressDraftText({
      entry: params.entry,
      lines: linesRenderedByChannel ? [] : draftLines,
      seed: params.seed,
      formatLine: options?.formatted === false ? undefined : params.formatLine,
      narration,
      plan: planSteps,
    });
  };

  const resolveDiffStat = diffStatTracker.resolve;

  const getSnapshot = (): ChannelProgressDraftCompositorSnapshot => {
    const statusHeadline = resolveStatusText();
    const diffStat = resolveDiffStat();
    return {
      lines: lines.map((line) => (typeof line === "string" ? line : { ...line })),
      ...(statusHeadline ? { statusHeadline } : {}),
      ...(planSteps ? { plan: planSteps.map((entry) => ({ ...entry })) } : {}),
      ...(planExplanation ? { planExplanation } : {}),
      ...(diffStat ? { diffStat } : {}),
    };
  };

  const clearProgressState = (suppressed: boolean) => {
    clearPreambleExpiryTimer();
    progressSuppressed = suppressed;
    lines = [];
    lastRenderedText = "";
    lastRenderedLines = lines;
    lastRenderedDiffStatKey = "";
    reasoningRawText = "";
    lastReasoningLine = undefined;
    lastIdLessCommentaryId = undefined;
    lastIdLessCommentaryBare = "";
    preambleText = "";
    preambleItemId = undefined;
    preambleAt = undefined;
    narrationText = "";
    planSteps = undefined;
    planExplanation = "";
    diffStatTracker.reset();
    lastStartRendered = false;
  };

  const publish = async (options?: { flush?: boolean }): Promise<boolean> => {
    const text = formatDraftText();
    const diffStatKey = JSON.stringify(resolveDiffStat() ?? null);
    const structuredStateChanged =
      params.updateOnLineChange === true &&
      (lines !== lastRenderedLines || diffStatKey !== lastRenderedDiffStatKey);
    if (!text || (text === lastRenderedText && !structuredStateChanged)) {
      return false;
    }
    const observed = await settleProgressVisibilityCallbackResult(
      params.update(text, { ...options, lines: [...lines] }),
    );
    if (!observed.visible) {
      return false;
    }
    // Only accepted renders become the dedupe baseline; pending sends remain retryable.
    lastRenderedText = text;
    lastRenderedLines = lines;
    lastRenderedDiffStatKey = diffStatKey;
    return true;
  };

  const render = async (options?: { flush?: boolean }): Promise<boolean> => {
    if (!params.active || params.mode !== "progress" || finalReplyStarted || finalReplyDelivered) {
      return false;
    }
    return await publish(options);
  };

  const schedulePreambleExpiryRefresh = () => {
    clearPreambleExpiryTimer();
    if (
      !preambleText ||
      !narrationText ||
      preambleAt === undefined ||
      !gate.hasStarted ||
      finalReplyStarted ||
      finalReplyDelivered
    ) {
      return;
    }
    const remaining = PROGRESS_STATUS_PREAMBLE_FRESH_MS - (now() - preambleAt);
    if (remaining <= 0) {
      return;
    }
    preambleExpiryTimer = setTimeoutFn(() => {
      preambleExpiryTimer = undefined;
      void render().catch((err: unknown) => {
        console.warn(`[progress-draft] channel progress status refresh failed: ${String(err)}`);
      });
    }, remaining);
  };

  const gate = createChannelProgressDraftGate({
    onStart: async () => {
      lastStartRendered = await render({ flush: true });
      schedulePreambleExpiryRefresh();
    },
    setTimeoutFn,
    clearTimeoutFn,
  });

  /**
   * Commentary line identity. An explicit item id owns its line. Without one,
   * providers stream cumulative snapshots ("Checking" → "Checking the
   * workspace"), so a snapshot that continues the open line reuses its id and
   * updates in place; anything else starts a new line.
   */
  const resolveCommentaryLineId = (commentary: {
    itemId?: string;
    normalized: string;
    bareNormalized: string;
  }): string => {
    if (commentary.itemId) {
      return `commentary:${commentary.itemId}`;
    }
    if (!commentary.normalized) {
      // Sanitized to nothing (directive-only / NO_REPLY): no line to address, so
      // it cannot retract the open one. Only an explicit itemId clears a line.
      return "";
    }
    const continuesOpenLine =
      Boolean(lastIdLessCommentaryBare) &&
      (commentary.bareNormalized.startsWith(lastIdLessCommentaryBare) ||
        lastIdLessCommentaryBare.startsWith(commentary.bareNormalized));
    if (continuesOpenLine && lastIdLessCommentaryId) {
      return lastIdLessCommentaryId;
    }
    return `commentary:${commentary.normalized}`;
  };

  const clearLine = async (lineId: string) => {
    const nextLines = removeChannelProgressDraftLine(lines, lineId);
    if (nextLines === lines) {
      return;
    }
    lines = nextLines;
    if (!gate.hasStarted) {
      return;
    }
    const text = formatDraftText();
    if (text) {
      await render();
      return;
    }
    lastRenderedText = "";
    await params.deleteCurrent?.();
  };

  const noteProgress = async (
    line?: ChannelProgressDraftCompositorLine,
    options?: { toolName?: string; startImmediately?: boolean },
  ) => {
    if (!params.active || finalReplyStarted || finalReplyDelivered) {
      return false;
    }
    if (options?.toolName !== undefined && !isChannelProgressDraftWorkToolName(options.toolName)) {
      return false;
    }
    if (params.isEmptyLine?.(line)) {
      return false;
    }
    const normalized = normalizeChannelProgressDraftLineIdentity(line);
    if (!normalized || progressSuppressed) {
      return false;
    }
    if (params.mode !== "progress" && !previewToolProgressEnabled) {
      return false;
    }
    const progressLine = typeof line === "object" && line !== undefined ? line : normalized;
    const shouldStoreLine = previewToolProgressEnabled;
    const nextLines = shouldStoreLine
      ? mergeChannelProgressDraftLine(lines, progressLine, {
          maxLines: resolveChannelProgressDraftMaxLines(params.entry),
        })
      : lines;
    const lineChanged = nextLines !== lines;
    const hasUnconfirmedRender = formatDraftText(nextLines) !== lastRenderedText;
    const diffStatChanged =
      params.updateOnLineChange === true &&
      JSON.stringify(resolveDiffStat() ?? null) !== lastRenderedDiffStatKey;
    if (shouldStoreLine && !lineChanged && !hasUnconfirmedRender && !diffStatChanged) {
      return false;
    }
    // A work line lands between reasoning bursts: commit the current thinking
    // line so the next thought appends as its own line, interleaved with tools
    // in arrival order, instead of replacing the prior thought.
    if (shouldStoreLine && lineChanged) {
      reasoningRawText = "";
      lastReasoningLine = undefined;
    }
    if (shouldStoreLine && params.tryNativeUpdate) {
      // Native draft updates get unformatted text; if the channel accepts it,
      // keep local state aligned without sending a generic draft message.
      const text = formatDraftText(nextLines, { formatted: false });
      if (text && (await params.tryNativeUpdate(text))) {
        lines = nextLines;
        lastRenderedText = text;
        lastRenderedLines = lines;
        return true;
      }
    }
    lines = nextLines;
    if (params.mode !== "progress") {
      return shouldStoreLine ? await publish() : false;
    }
    if (options?.startImmediately || params.shouldStartNow?.(line)) {
      const alreadyStarted = gate.hasStarted;
      if (!alreadyStarted) {
        lastStartRendered = false;
      }
      await gate.startNow();
      if (!gate.hasStarted) {
        return false;
      }
      return alreadyStarted ? await render() : lastStartRendered;
    }
    const alreadyStarted = gate.hasStarted;
    const progressActive = await gate.noteWork();
    if ((alreadyStarted || progressActive) && gate.hasStarted) {
      return await render();
    }
    return false;
  };

  const progressEventHandlers = createChannelProgressDraftEventHandlers({
    entry: params.entry,
    pushLine: noteProgress,
    onTool: diffStatTracker.stageToolEvent,
    onItem: diffStatTracker.commitItemEvent,
    ...(params.buildProgressEventLine ? { buildLine: params.buildProgressEventLine } : {}),
  });

  return {
    get previewToolProgressEnabled() {
      return previewToolProgressEnabled;
    },
    get commentaryProgressEnabled() {
      return commentaryProgressEnabled;
    },
    get suppressDefaultToolProgressMessages() {
      return suppressDefaultToolProgressMessages;
    },
    get hasStarted() {
      return gate.hasStarted;
    },
    get isVisible() {
      return Boolean(lastRenderedText) && !finalReplyStarted && !finalReplyDelivered;
    },
    get hasStatusHeadline() {
      return Boolean(resolveStatusText());
    },
    get hasPlanProgress() {
      return Boolean(planSteps?.length);
    },
    getSnapshot,
    markFinalReplyStarted() {
      finalReplyStarted = true;
      // Final delivery must disarm the delayed start before async delivery work.
      // Queued turns reopen the gate through beginNewTurn().
      gate.cancel();
      clearPreambleExpiryTimer();
    },
    markFinalReplyDelivered() {
      finalReplyDelivered = true;
      clearPreambleExpiryTimer();
    },
    // Authoritative queued admission may force reset after a silent turn;
    // ordinary assistant boundaries still require a settled final.
    beginNewTurn(options?: { force?: boolean }) {
      if (options?.force !== true && !finalReplyStarted && !finalReplyDelivered) {
        return false;
      }
      finalReplyStarted = false;
      finalReplyDelivered = false;
      gate.reset();
      clearProgressState(false);
      return true;
    },
    reset() {
      clearProgressState(false);
    },
    resetReasoningProgress() {
      reasoningRawText = "";
    },
    mergeReasoningProgress,
    suppress() {
      clearProgressState(true);
    },
    cancel() {
      gate.cancel();
      clearPreambleExpiryTimer();
    },
    start() {
      return gate.startNow();
    },
    async noteActivity(options?: { startImmediately?: boolean }) {
      if (
        !params.active ||
        params.mode !== "progress" ||
        progressSuppressed ||
        finalReplyStarted ||
        finalReplyDelivered
      ) {
        return false;
      }
      if (options?.startImmediately) {
        const alreadyStarted = gate.hasStarted;
        if (!alreadyStarted) {
          lastStartRendered = false;
        }
        await gate.startNow();
        if (!gate.hasStarted) {
          return false;
        }
        return alreadyStarted ? await render({ flush: true }) : lastStartRendered;
      }
      const alreadyStarted = gate.hasStarted;
      const progressActive = await gate.noteWork();
      if ((alreadyStarted || progressActive) && gate.hasStarted) {
        return await render();
      }
      return false;
    },
    pushToolProgress: noteProgress,
    ...progressEventHandlers,
    async pushPlanProgress(
      steps?: AgentPlanStep[],
      options?: { explanation?: string },
    ): Promise<boolean> {
      if (
        !params.active ||
        params.mode !== "progress" ||
        progressSuppressed ||
        finalReplyStarted ||
        finalReplyDelivered
      ) {
        return false;
      }
      planSteps = steps && steps.length > 0 ? steps.map((entry) => ({ ...entry })) : undefined;
      planExplanation = options?.explanation?.replace(/\s+/g, " ").trim() ?? "";
      if (!planSteps && !planExplanation) {
        if (!gate.hasStarted) {
          return false;
        }
        const rendered = await render();
        if (rendered || formatDraftText()) {
          return rendered;
        }
        lastRenderedText = "";
        await params.deleteCurrent?.();
        return true;
      }
      const alreadyStarted = gate.hasStarted;
      if (!alreadyStarted) {
        lastStartRendered = false;
      }
      await gate.startNow();
      if (!gate.hasStarted) {
        return false;
      }
      return alreadyStarted ? await render() : lastStartRendered;
    },
    async pushPreambleHeadline(text?: string, options?: { itemId?: string }) {
      if (!params.active || params.mode !== "progress" || progressSuppressed) {
        return false;
      }
      // The opt-in commentary lane already renders every preamble as an
      // interleaved 💬 line; letting the headline also consume it would
      // replace those documented lines with a duplicate status paragraph.
      // Deliberate: the headline itself is default-on presentation of the
      // typed preamble (owner decision, #105872); `commentary` only picks the
      // interleaved-lane presentation, it is not a preamble kill switch.
      if (commentaryProgressEnabled) {
        return false;
      }
      if (finalReplyStarted || finalReplyDelivered) {
        return false;
      }
      const itemId = options?.itemId?.trim() || undefined;
      const normalized = sanitizeProgressStatusText(text ?? "")
        .replace(/\s+/g, " ")
        .trim();
      if (!normalized) {
        // Retractions must identify the currently displayed preamble. A late
        // retraction for an older item must not clear a newer headline.
        if (!itemId || itemId !== preambleItemId) {
          return false;
        }
        preambleText = "";
        preambleItemId = undefined;
        preambleAt = undefined;
        clearPreambleExpiryTimer();
        if (!gate.hasStarted) {
          return false;
        }
        const rendered = await render();
        if (rendered || formatDraftText()) {
          return rendered;
        }
        lastRenderedText = "";
        await params.deleteCurrent?.();
        return true;
      }
      const isNewPreambleItem = Boolean(itemId && itemId !== preambleItemId);
      if (isNewPreambleItem) {
        preambleItemId = itemId;
      } else if (!itemId) {
        preambleItemId = undefined;
      }
      if (normalized === preambleText && !isNewPreambleItem) {
        return false;
      }
      preambleText = normalized;
      preambleAt = now();
      schedulePreambleExpiryRefresh();
      // Work activity owns the delayed start gate. Retain preambles from fast
      // turns without making their draft visible.
      return gate.hasStarted ? await render() : false;
    },
    async pushNarrationProgress(text?: string) {
      if (!params.active || params.mode !== "progress" || progressSuppressed) {
        return false;
      }
      if (finalReplyStarted || finalReplyDelivered) {
        return false;
      }
      const normalized = text?.replace(/\s+/g, " ").trim() ?? "";
      if (normalized === narrationText) {
        return false;
      }
      if (!normalized) {
        // Release stopped narration without retracting the model's headline;
        // raw tool lines return only when no preamble remains.
        narrationText = "";
        clearPreambleExpiryTimer();
        return await render();
      }
      narrationText = normalized;
      schedulePreambleExpiryRefresh();
      // Tool activity owns the delayed start gate. Narration may arrive while
      // that timer is pending; retain the newest text without flashing a draft
      // for a turn that finishes inside the grace period.
      return gate.hasStarted ? await render() : false;
    },
    async pushReasoningProgress(text?: string, options?: { snapshot?: boolean }) {
      if (
        !params.active ||
        params.mode !== "progress" ||
        !text ||
        progressSuppressed ||
        finalReplyDelivered ||
        !thinkingProgressEnabled
      ) {
        return false;
      }
      const normalized = mergeReasoningProgress(text, options);
      if (!normalized) {
        return false;
      }
      const compactLine = formatReasoningProgressDisplayLine(
        normalized,
        resolveChannelProgressDraftMaxLineChars(params.entry),
      );
      if (!compactLine) {
        return false;
      }
      const displayLine = `${reasoningLinePrefix}${compactLine}`;
      // Reasoning streams usually arrive as deltas. Replace the previous
      // reasoning line so the draft stays compact instead of appending noise.
      const priorIndex =
        lastReasoningLine === undefined ? -1 : lines.lastIndexOf(lastReasoningLine);
      if (priorIndex >= 0) {
        lines = [...lines];
        lines[priorIndex] = displayLine;
      } else {
        lines = [...lines, displayLine].slice(-resolveChannelProgressDraftMaxLines(params.entry));
      }
      lastReasoningLine = displayLine;
      const progressActive = await gate.noteWork();
      if (progressActive && gate.hasStarted) {
        return await render();
      }
      return false;
    },
    async pushCommentaryProgress(text?: string, options?: { itemId?: string }) {
      if (!params.active || params.mode !== "progress" || !commentaryProgressEnabled) {
        return false;
      }
      if (finalReplyStarted || finalReplyDelivered) {
        return false;
      }
      const itemId = options?.itemId?.trim();
      if (!text && !itemId) {
        return false;
      }
      const normalized = normalizeCommentaryProgressText(text ?? "");
      // Compare bare (de-italicized) text so cumulative snapshots still match
      // after normalizeCommentaryProgressText wraps each line in _…_.
      const bareNormalized = stripLaneItalics(normalized);
      const lineId = resolveCommentaryLineId({ itemId, normalized, bareNormalized });
      if (!normalized) {
        // Empty commentary with an item id means the producer retracted that
        // item; remove its draft line if it was already rendered.
        if (lineId) {
          await clearLine(lineId);
        }
        return false;
      }
      const line: ChannelProgressDraftLine = {
        id: lineId,
        // The lane marker (💬, matching 🧠 thinking / 🛠️ tools) is a per-channel
        // presentation choice supplied via commentaryLinePrefix; default none.
        text: `${commentaryLinePrefix}${commentaryItalics ? normalized : bareNormalized}`,
        kind: "item",
        label: "Commentary",
        prefix: false,
      };
      lines = mergeChannelProgressDraftLine(lines, line, {
        maxLines: resolveChannelProgressDraftMaxLines(params.entry),
      });
      if (!itemId) {
        lastIdLessCommentaryId = lineId;
        lastIdLessCommentaryBare = bareNormalized;
      }
      const alreadyStarted = gate.hasStarted;
      if (!alreadyStarted) {
        lastStartRendered = false;
      }
      await gate.startNow();
      if (!gate.hasStarted) {
        return false;
      }
      return alreadyStarted ? await render() : lastStartRendered;
    },
  };
}
