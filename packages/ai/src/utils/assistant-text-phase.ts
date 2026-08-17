type AssistantTextPhaseBlock = {
  type: "text";
  text: string;
  textSignature?: string;
};

export type PendingCommentaryTags = Map<AssistantTextPhaseBlock, string>;

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
): PendingCommentaryTags {
  const textBlocks = content.filter(isAssistantTextPhaseBlock);
  let phaseIndex = textBlocks.filter((block) => block.textSignature !== undefined).length;
  const tagged: PendingCommentaryTags = new Map();
  for (const block of textBlocks) {
    if (block.text.trim().length === 0 || block.textSignature !== undefined) {
      continue;
    }
    const signature = encodeAssistantTextSignatureV1(`${idPrefix}-${phaseIndex}`, phase);
    block.textSignature = signature;
    tagged.set(block, signature);
    phaseIndex += 1;
  }
  return tagged;
}

/** Tags unphased narration before a tool-call event becomes consumer-visible. */
export function tagPendingCommentaryText(content: ReadonlyArray<unknown>): PendingCommentaryTags {
  return tagUnphasedText(content, "commentary", "commentary");
}

/** Records the confirmed final-answer boundary after reasoning resumes. */
export function tagInterruptedTextPhases(
  content: ReadonlyArray<unknown>,
  interruptedText: unknown,
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
  tagUnphasedText(content.slice(0, finalAnswerIndex), "commentary", "commentary");
  tagUnphasedText(content.slice(finalAnswerIndex), "final_answer", "final-answer");
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
