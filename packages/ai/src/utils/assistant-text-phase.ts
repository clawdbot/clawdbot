type AssistantTextPhaseBlock = {
  type: "text";
  text: string;
  textSignature?: string;
};

export type PendingCommentaryTags = Map<AssistantTextPhaseBlock, string>;

export type CommentaryTagOptions = {
  /** Monotonic per-stream counter so commentary ids stay unique across assistant messages. */
  commentarySequence?: { next: number };
};

const EMPTY_ASSISTANT_TEXT_BLOCK_SET: ReadonlySet<unknown> = new Set();

function isAssistantTextPhaseBlock(block: unknown): block is AssistantTextPhaseBlock {
  if (!block || typeof block !== "object") {
    return false;
  }
  const record = block as { type?: unknown; text?: unknown };
  return record.type === "text" && typeof record.text === "string";
}

function encodeAssistantTextSignatureV1(id: string, phase?: "commentary" | "final_answer"): string {
  return JSON.stringify({ v: 1, id, ...(phase ? { phase } : {}) });
}

function tagUnphasedText(
  content: ReadonlyArray<unknown>,
  phase: "commentary" | "final_answer",
  idPrefix: string,
  commentarySequence?: CommentaryTagOptions["commentarySequence"],
): PendingCommentaryTags {
  const textBlocks = content.filter(isAssistantTextPhaseBlock);
  let phaseIndex = textBlocks.filter((block) => block.textSignature !== undefined).length;
  const tagged: PendingCommentaryTags = new Map();
  for (const block of textBlocks) {
    if (block.text.trim().length === 0 || block.textSignature !== undefined) {
      continue;
    }
    const id =
      phase === "commentary" && commentarySequence
        ? `${idPrefix}-${commentarySequence.next++}`
        : `${idPrefix}-${phaseIndex}`;
    const signature = encodeAssistantTextSignatureV1(id, phase);
    block.textSignature = signature;
    tagged.set(block, signature);
    phaseIndex += 1;
  }
  return tagged;
}

/** Tags unphased narration before a tool-call event becomes consumer-visible. */
export function tagPendingCommentaryText(
  content: ReadonlyArray<unknown>,
  options?: CommentaryTagOptions,
): PendingCommentaryTags {
  return tagUnphasedText(content, "commentary", "commentary", options?.commentarySequence);
}

/** Records the confirmed final-answer boundary after reasoning resumes. */
export function tagInterruptedTextPhases(
  content: ReadonlyArray<unknown>,
  interruptedText: unknown,
  preservedVisibleText: ReadonlySet<unknown> = EMPTY_ASSISTANT_TEXT_BLOCK_SET,
  options?: CommentaryTagOptions,
): void {
  const interruptedTextIndex = content.indexOf(interruptedText);
  if (interruptedTextIndex === -1) {
    return;
  }
  const finalAnswerIndex = content.findIndex(
    (block, index) =>
      index > interruptedTextIndex &&
      isAssistantTextPhaseBlock(block) &&
      block.text.trim().length > 0,
  );
  if (finalAnswerIndex === -1) {
    return;
  }
  tagUnphasedText(
    content.slice(0, finalAnswerIndex).filter((block) => !preservedVisibleText.has(block)),
    "commentary",
    "commentary",
    options?.commentarySequence,
  );
  tagUnphasedText(
    content.filter((block, index) => index >= finalAnswerIndex || preservedVisibleText.has(block)),
    "final_answer",
    "final-answer",
  );
}

/** Prevents unresolved completion text from becoming a fallback answer after stream failure. */
export function tagUnresolvedTextAsCommentary(
  message: {
    content: ReadonlyArray<unknown>;
    openclawDelivery?: { textPhaseRequiresTerminal?: true };
  },
  options?: CommentaryTagOptions,
): void {
  if (message.openclawDelivery?.textPhaseRequiresTerminal) {
    tagUnphasedText(message.content, "commentary", "commentary", options?.commentarySequence);
  }
}

/** Rolls back only the exact provisional signatures created by this transport turn. */
export function clearPendingCommentaryText(tags: PendingCommentaryTags): void {
  for (const [block, signature] of tags) {
    if (block.textSignature === signature) {
      delete block.textSignature;
    }
  }
  tags.clear();
}

export function rememberPendingCommentaryTags(
  target: PendingCommentaryTags,
  tagged: PendingCommentaryTags,
): void {
  for (const [block, signature] of tagged) {
    target.set(block, signature);
  }
}

/** Applies end-of-stream commentary tagging for completions transports. */
export function finalizeStreamCommentaryPhases(params: {
  stopReason: string | undefined;
  content: ReadonlyArray<unknown>;
  provisionalCommentaryTags: PendingCommentaryTags;
  commentarySequence: { next: number };
  confirmedInterruptedTextBlock?: unknown;
  explicitVisibleTextBlocks?: ReadonlySet<unknown>;
  output: {
    content: ReadonlyArray<unknown>;
    openclawDelivery?: { textPhaseRequiresTerminal?: true };
  };
}): void {
  if (
    params.confirmedInterruptedTextBlock &&
    params.stopReason !== "toolUse" &&
    params.stopReason !== "error" &&
    params.stopReason !== "aborted"
  ) {
    tagInterruptedTextPhases(
      params.content,
      params.confirmedInterruptedTextBlock,
      params.explicitVisibleTextBlocks,
      { commentarySequence: params.commentarySequence },
    );
  }
  if (params.stopReason !== "toolUse") {
    clearPendingCommentaryText(params.provisionalCommentaryTags);
  }
  if (params.stopReason === "error" || params.stopReason === "aborted") {
    tagUnresolvedTextAsCommentary(params.output, {
      commentarySequence: params.commentarySequence,
    });
  }
  if (params.stopReason === "toolUse") {
    tagPendingCommentaryText(params.content, { commentarySequence: params.commentarySequence });
  }
}
