import type { ResponseReasoningItem } from "openai/resources/responses/responses.js";
import type { TextContent } from "../types.js";
import type {
  ResponsesThinkingBlock,
  TextBlockReference,
} from "./openai-responses-stream-terminal-internal.js";

export type ResponsesStreamOutputSlot<TMessage, TToolCall> =
  | {
      type: "thinking";
      item: ResponseReasoningItem;
      block: ResponsesThinkingBlock;
      contentIndex: number;
    }
  | {
      type: "text";
      item: TMessage;
      block: TextContent | null;
      contentIndex: number | undefined;
      pendingText: string | null;
      collapseCandidate: TextBlockReference | null;
    }
  | { type: "toolCall"; toolCall: TToolCall };

type DeferredTextSlot = {
  pendingText: string | null;
  collapseCandidate: { block: { text: string } } | null;
};

type ResponsesOutputIdentityItem = {
  type: string;
  id?: string | null;
  call_id?: string | null;
};

export function createResponsesOutputContentIndex() {
  const indexes = new Map<string, number>();
  const identity = (item: ResponsesOutputIdentityItem): string | undefined => {
    if ((item.type === "reasoning" || item.type === "message") && item.id) {
      return `${item.type}:${item.id}`;
    }
    return item.type === "function_call"
      ? `function_call:${item.call_id ?? item.id ?? ""}`
      : undefined;
  };
  return {
    get(item: ResponsesOutputIdentityItem): number | undefined {
      const key = identity(item);
      return key === undefined ? undefined : indexes.get(key);
    },
    set(item: ResponsesOutputIdentityItem, contentIndex: number): void {
      const key = identity(item);
      if (key !== undefined) {
        indexes.set(key, contentIndex);
      }
    },
  };
}

export function appendResponsesPendingTextDelta<TSlot extends DeferredTextSlot>(
  slot: TSlot,
  delta: string,
  materialize: (slot: TSlot) => void,
): void {
  slot.pendingText = `${slot.pendingText ?? ""}${delta}`;
  const priorText = slot.collapseCandidate?.block.text ?? "";
  if (priorText.startsWith(slot.pendingText) || slot.pendingText.startsWith(priorText)) {
    return;
  }
  // Divergence means this is a distinct message; materialize its withheld delta.
  materialize(slot);
}

export function readResponsesOutputIndex(event: object): number | undefined {
  const outputIndex = (event as { output_index?: unknown }).output_index;
  return typeof outputIndex === "number" && Number.isInteger(outputIndex) && outputIndex >= 0
    ? outputIndex
    : undefined;
}

export function createResponsesOutputSlotTracker<TSlot extends { type: string }>() {
  const indexed = new Map<number, TSlot>();
  let unindexed: TSlot | undefined;
  return {
    register(event: object, slot: TSlot): void {
      const outputIndex = readResponsesOutputIndex(event);
      if (outputIndex === undefined) {
        if (unindexed) {
          throw new Error("Responses stream added overlapping unindexed output items");
        }
        unindexed = slot;
        return;
      }
      if (indexed.has(outputIndex)) {
        throw new Error(`Responses stream reused active output index ${outputIndex}`);
      }
      indexed.set(outputIndex, slot);
    },
    resolve<TType extends TSlot["type"]>(
      event: object,
      type: TType,
    ): Extract<TSlot, { type: TType }> | undefined {
      const outputIndex = readResponsesOutputIndex(event);
      let slot = outputIndex === undefined ? unindexed : indexed.get(outputIndex);
      if (outputIndex === undefined && !slot) {
        const matches = [...indexed.values()].filter((candidate) => candidate.type === type);
        slot = matches.length === 1 ? matches[0] : undefined;
      }
      return slot?.type === type ? (slot as Extract<TSlot, { type: TType }>) : undefined;
    },
    get(event: object): TSlot | undefined {
      const outputIndex = readResponsesOutputIndex(event);
      return outputIndex === undefined ? unindexed : indexed.get(outputIndex);
    },
    values(): TSlot[] {
      return [...new Set([...indexed.values(), ...(unindexed ? [unindexed] : [])])];
    },
    forget(slot: TSlot): void {
      if (unindexed === slot) {
        unindexed = undefined;
      }
      for (const [outputIndex, candidate] of indexed) {
        if (candidate === slot) {
          indexed.delete(outputIndex);
        }
      }
    },
  };
}
