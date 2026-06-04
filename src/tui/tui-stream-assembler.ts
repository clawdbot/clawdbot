// Assembles streamed backend events into TUI-visible messages.
import {
  composeThinkingAndContent,
  extractContentFromMessage,
  extractThinkingFromMessage,
  resolveFinalAssistantText,
} from "./tui-formatters.js";

// Per-run state used to merge streaming deltas with final assistant messages.
type RunStreamState = {
  thinkingText: string;
  contentText: string;
  contentBlocks: string[];
  sawNonTextContentBlocks: boolean;
  displayText: string;
};

type BoundaryDropMode = "off" | "streamed-only" | "streamed-or-incoming";

// Pull text blocks out of provider-style content arrays while remembering non-text blocks.
function extractTextBlocksAndSignals(message: unknown): {
  textBlocks: string[];
  sawNonTextContentBlocks: boolean;
} {
  if (!message || typeof message !== "object") {
    return { textBlocks: [], sawNonTextContentBlocks: false };
  }
  const record = message as Record<string, unknown>;
  const content = record.content;

  if (typeof content === "string") {
    const text = content.trim();
    return {
      textBlocks: text ? [text] : [],
      sawNonTextContentBlocks: false,
    };
  }
  if (!Array.isArray(content)) {
    return { textBlocks: [], sawNonTextContentBlocks: false };
  }

  const textBlocks: string[] = [];
  let sawNonTextContentBlocks = false;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const rec = block as Record<string, unknown>;
    if (rec.type === "text" && typeof rec.text === "string") {
      const text = rec.text.trim();
      if (text) {
        textBlocks.push(text);
      }
      continue;
    }
    if (typeof rec.type === "string" && rec.type !== "thinking") {
      sawNonTextContentBlocks = true;
    }
  }
  return { textBlocks, sawNonTextContentBlocks };
}

// Detects final messages that dropped streamed boundary text around a non-text block.
function isDroppedBoundaryTextBlockSubset(params: {
  streamedTextBlocks: string[];
  finalTextBlocks: string[];
}): boolean {
  const { streamedTextBlocks, finalTextBlocks } = params;
  if (finalTextBlocks.length === 0 || finalTextBlocks.length >= streamedTextBlocks.length) {
    return false;
  }

  const prefixMatches = finalTextBlocks.every(
    (block, index) => streamedTextBlocks[index] === block,
  );
  if (prefixMatches) {
    return true;
  }

  const suffixStart = streamedTextBlocks.length - finalTextBlocks.length;
  return finalTextBlocks.every((block, index) => streamedTextBlocks[suffixStart + index] === block);
}

// Some providers omit text adjacent to images/files in the final message; preserve streamed text.
function shouldPreserveBoundaryDroppedText(params: {
  boundaryDropMode: BoundaryDropMode;
  streamedSawNonTextContentBlocks: boolean;
  incomingSawNonTextContentBlocks: boolean;
  streamedTextBlocks: string[];
  nextContentBlocks: string[];
}) {
  if (params.boundaryDropMode === "off") {
    return false;
  }
  const sawEligibleNonTextContent =
    params.boundaryDropMode === "streamed-or-incoming"
      ? params.streamedSawNonTextContentBlocks || params.incomingSawNonTextContentBlocks
      : params.streamedSawNonTextContentBlocks;
  if (!sawEligibleNonTextContent) {
    return false;
  }
  return isDroppedBoundaryTextBlockSubset({
    streamedTextBlocks: params.streamedTextBlocks,
    finalTextBlocks: params.nextContentBlocks,
  });
}

/** Assembles assistant stream deltas and final messages into stable TUI display text. */
export class TuiStreamAssembler {
  private runs = new Map<string, RunStreamState>();

  private getOrCreateRun(runId: string): RunStreamState {
    let state = this.runs.get(runId);
    if (!state) {
      state = {
        thinkingText: "",
        contentText: "",
        contentBlocks: [],
        sawNonTextContentBlocks: false,
        displayText: "",
      };
      this.runs.set(runId, state);
    }
    return state;
  }

  private updateRunState(
    state: RunStreamState,
    message: unknown,
    showThinking: boolean,
    opts?: { boundaryDropMode?: BoundaryDropMode },
  ) {
    const thinkingText = extractThinkingFromMessage(message);
    const contentText = extractContentFromMessage(message);
    const { textBlocks, sawNonTextContentBlocks } = extractTextBlocksAndSignals(message);

    if (thinkingText) {
      state.thinkingText = thinkingText;
    }
    if (contentText) {
      const nextContentBlocks = textBlocks.length > 0 ? textBlocks : [contentText];
      const boundaryDropMode = opts?.boundaryDropMode ?? "off";
      const shouldKeepStreamedBoundaryText = shouldPreserveBoundaryDroppedText({
        boundaryDropMode,
        streamedSawNonTextContentBlocks: state.sawNonTextContentBlocks,
        incomingSawNonTextContentBlocks: sawNonTextContentBlocks,
        streamedTextBlocks: state.contentBlocks,
        nextContentBlocks,
      });

      if (!shouldKeepStreamedBoundaryText) {
        state.contentText = contentText;
        state.contentBlocks = nextContentBlocks;
      }
    }
    if (sawNonTextContentBlocks) {
      state.sawNonTextContentBlocks = true;
    }

    const displayText = composeThinkingAndContent({
      thinkingText: state.thinkingText,
      contentText: state.contentText,
      showThinking,
    });

    state.displayText = displayText;
  }

  /** Ingests a streaming delta and returns updated display text only when it changed. */
  ingestDelta(runId: string, message: unknown, showThinking: boolean): string | null {
    const state = this.getOrCreateRun(runId);
    const previousDisplayText = state.displayText;
    this.updateRunState(state, message, showThinking, {
      boundaryDropMode: "streamed-or-incoming",
    });

    if (!state.displayText || state.displayText === previousDisplayText) {
      return null;
    }

    return state.displayText;
  }

  /** Finalizes a run, combines any error text, and drops stored stream state. */
  finalize(runId: string, message: unknown, showThinking: boolean, errorMessage?: string): string {
    const state = this.getOrCreateRun(runId);
    const streamedDisplayText = state.displayText;
    const streamedTextBlocks = [...state.contentBlocks];
    const streamedSawNonTextContentBlocks = state.sawNonTextContentBlocks;
    this.updateRunState(state, message, showThinking, {
      boundaryDropMode: "streamed-only",
    });
    const finalComposed = state.displayText;
    const shouldKeepStreamedText =
      streamedSawNonTextContentBlocks &&
      isDroppedBoundaryTextBlockSubset({
        streamedTextBlocks,
        finalTextBlocks: state.contentBlocks,
      });
    const finalText = resolveFinalAssistantText({
      finalText: shouldKeepStreamedText ? streamedDisplayText : finalComposed,
      streamedText: streamedDisplayText,
      errorMessage,
    });

    this.runs.delete(runId);
    return finalText;
  }

  /** Drops stored stream state for an aborted or discarded run. */
  drop(runId: string) {
    this.runs.delete(runId);
  }
}
