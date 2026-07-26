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
}>;

/** Tracks per-turn activity for compact progress receipts. */
export function createChannelProgressReceiptTracker(params?: { now?: () => number }) {
  const now = params?.now ?? Date.now;
  let startedAt = now();
  let reasoningSteps = 0;
  let toolCalls = 0;
  let commentaryNotes = 0;
  let reasoningOpen = false;
  const seenCommentaryIds = new Set<string>();
  let lastCommentaryText = "";

  const closeReasoning = () => {
    if (!reasoningOpen) {
      return;
    }
    reasoningOpen = false;
    reasoningSteps += 1;
  };

  const reset = () => {
    startedAt = now();
    reasoningSteps = 0;
    toolCalls = 0;
    commentaryNotes = 0;
    reasoningOpen = false;
    seenCommentaryIds.clear();
    lastCommentaryText = "";
  };

  return {
    noteReasoning() {
      reasoningOpen = true;
    },
    closeReasoning,
    noteToolCall(toolName?: string) {
      closeReasoning();
      if (isChannelProgressDraftWorkToolName(toolName)) {
        toolCalls += 1;
      }
    },
    noteCommentary(itemId?: string, text?: string) {
      const trimmed = text?.trim();
      if (!trimmed) {
        return;
      }
      if (itemId) {
        if (!seenCommentaryIds.has(itemId)) {
          seenCommentaryIds.add(itemId);
          commentaryNotes += 1;
        }
        return;
      }
      if (trimmed !== lastCommentaryText) {
        lastCommentaryText = trimmed;
        commentaryNotes += 1;
      }
    },
    reset,
    buildSummaryLine() {
      closeReasoning();
      const seconds = Math.max(1, Math.round((now() - startedAt) / 1000));
      return [
        ...(reasoningSteps > 0
          ? [`🧠 ${reasoningSteps} thought${reasoningSteps === 1 ? "" : "s"}`]
          : []),
        ...(commentaryNotes > 0
          ? [`💬 ${commentaryNotes} note${commentaryNotes === 1 ? "" : "s"}`]
          : []),
        ...(toolCalls > 0 ? [`🛠️ ${toolCalls} tool call${toolCalls === 1 ? "" : "s"}`] : []),
        `⏱️ ${seconds}s`,
      ].join(" · ");
    },
  };
}

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
  update: (text: string, options?: ChannelProgressDraftUpdateOptions) => Promise<void> | void;
  deleteCurrent?: () => Promise<void> | void;
  tryNativeUpdate?: (text: string) => Promise<boolean> | boolean;
  /** Publish when structured lines change even if the rendered text does not. */
  updateOnLineChange?: boolean;
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
    params.active && resolveChannelStreamingPreviewToolProgress(params.entry);
  const commentaryProgressEnabled =
    params.active && resolveChannelStreamingProgressCommentary(params.entry);
  const thinkingProgressEnabled =
    params.active && (params.reasoningGate ?? previewToolProgressEnabled);
  const suppressDefaultToolProgressMessages =
    params.active &&
    resolveChannelStreamingSuppressDefaultToolProgressMessages(params.entry, {
      draftStreamActive: true,
      previewToolProgressEnabled,
    });
  let progressSuppressed = false;
  let lines: ChannelProgressDraftCompositorLine[] = [];
  let lastRenderedText = "";
  let lastRenderedLines = lines;
  let reasoningRawText = "";
  let lastReasoningLine: string | undefined;
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
  let preambleExpiryTimer: ReturnType<typeof setTimeout> | undefined;

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

  const formatDraftText = (draftLines = lines, options?: { formatted?: boolean }) =>
    formatChannelProgressDraftText({
      entry: params.entry,
      lines: draftLines,
      seed: params.seed,
      formatLine: options?.formatted === false ? undefined : params.formatLine,
      narration: resolveStatusText() || undefined,
      plan: planSteps,
    });

  const getSnapshot = (): ChannelProgressDraftCompositorSnapshot => {
    const statusHeadline = resolveStatusText();
    return {
      lines: lines.map((line) => (typeof line === "string" ? line : { ...line })),
      ...(statusHeadline ? { statusHeadline } : {}),
      ...(planSteps ? { plan: planSteps.map((entry) => ({ ...entry })) } : {}),
      ...(planExplanation ? { planExplanation } : {}),
    };
  };

  const clearProgressState = (suppressed: boolean) => {
    clearPreambleExpiryTimer();
    progressSuppressed = suppressed;
    lines = [];
    lastRenderedText = "";
    lastRenderedLines = lines;
    reasoningRawText = "";
    lastReasoningLine = undefined;
    preambleText = "";
    preambleItemId = undefined;
    preambleAt = undefined;
    narrationText = "";
    planSteps = undefined;
    planExplanation = "";
  };

  const render = async (options?: { flush?: boolean }): Promise<boolean> => {
    if (!params.active || params.mode !== "progress" || finalReplyStarted || finalReplyDelivered) {
      return false;
    }
    const text = formatDraftText();
    const linesChanged = params.updateOnLineChange === true && lines !== lastRenderedLines;
    if (!text || (text === lastRenderedText && !linesChanged)) {
      return false;
    }
    lastRenderedText = text;
    lastRenderedLines = lines;
    await params.update(text, { ...options, lines: [...lines] });
    return true;
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
      await render({ flush: true });
      schedulePreambleExpiryRefresh();
    },
    setTimeoutFn,
    clearTimeoutFn,
  });

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
    if (shouldStoreLine && nextLines === lines) {
      return false;
    }
    // A work line lands between reasoning bursts: commit the current thinking
    // line so the next thought appends as its own line, interleaved with tools
    // in arrival order, instead of replacing the prior thought.
    if (shouldStoreLine) {
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
      if (!shouldStoreLine) {
        return false;
      }
      const text = formatDraftText();
      if (!text || text === lastRenderedText) {
        return false;
      }
      lastRenderedText = text;
      lastRenderedLines = lines;
      await params.update(text, { lines: [...lines] });
      return true;
    }
    if (options?.startImmediately || params.shouldStartNow?.(line)) {
      const alreadyStarted = gate.hasStarted;
      await gate.startNow();
      if (!gate.hasStarted) {
        return false;
      }
      return alreadyStarted ? await render() : true;
    }
    const alreadyStarted = gate.hasStarted;
    const progressActive = await gate.noteWork();
    if ((alreadyStarted || progressActive) && gate.hasStarted) {
      return await render();
    }
    return false;
  };

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
      return gate.hasStarted && !finalReplyStarted && !finalReplyDelivered;
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
        await gate.startNow();
        return gate.hasStarted ? await render({ flush: true }) : false;
      }
      const alreadyStarted = gate.hasStarted;
      const progressActive = await gate.noteWork();
      if ((alreadyStarted || progressActive) && gate.hasStarted) {
        return await render();
      }
      return false;
    },
    pushToolProgress: noteProgress,
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
      await gate.startNow();
      if (!gate.hasStarted) {
        return false;
      }
      if (alreadyStarted) {
        await render();
      }
      return true;
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
      const lineId = itemId ? `commentary:${itemId}` : normalized ? `commentary:${normalized}` : "";
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
        text: `${commentaryLinePrefix}${commentaryItalics ? normalized : stripLaneItalics(normalized)}`,
        kind: "item",
        label: "Commentary",
        prefix: false,
      };
      lines = mergeChannelProgressDraftLine(lines, line, {
        maxLines: resolveChannelProgressDraftMaxLines(params.entry),
      });
      const alreadyStarted = gate.hasStarted;
      await gate.startNow();
      if (!gate.hasStarted) {
        return false;
      }
      if (alreadyStarted) {
        await render();
      }
      // True means the sanitized commentary was accepted into the visible
      // lane. A first item renders inside gate.onStart, not this call site.
      return true;
    },
  };
}
