import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";

type AssistantTextInput = {
  text?: string;
  delta?: string;
  itemId?: string;
  replace?: boolean;
  replaceable?: boolean;
  managedMediaUrls?: string[];
};

export type AssistantTextSnapshot = {
  text: string;
  scope?: { itemId: string; prefix: string };
};

/** A text-bearing empty result clears output; a missing text payload does not. */
export function resolveAssistantResultText(result: unknown): string | undefined {
  const payloads = asOptionalObjectRecord(result)?.payloads;
  const texts = Array.isArray(payloads)
    ? payloads.flatMap((payload) => {
        const text = asOptionalObjectRecord(payload)?.text;
        return typeof text === "string" ? [text] : [];
      })
    : [];
  return texts.length > 0 ? texts.filter(Boolean).join("\n\n") : undefined;
}

/** Settled provisional output is run-wide; ordinary item streams keep their wire projection. */
export function resolveAssistantTextCompletion(params: {
  assistantText: AssistantTextSnapshot;
  pending?: AssistantTextSnapshot;
  resultText?: string;
  streamedText: string;
  fallbackText: string;
}): string {
  if (params.pending) {
    return (
      params.resultText ?? (params.pending.text || (params.streamedText ? "" : params.fallbackText))
    );
  }
  return params.streamedText
    ? params.assistantText.text
    : (params.resultText ?? params.assistantText.text) || params.fallbackText;
}

/** Unkeyed held snapshots, including terminal echoes, describe the whole pending run. */
export function mergePendingAssistantText(
  previous: AssistantTextSnapshot,
  input: AssistantTextInput,
): AssistantTextSnapshot {
  return mergeAssistantText(
    previous,
    !input.itemId && input.text !== undefined ? { ...input, replace: true } : input,
    "append-only",
  );
}

/** Preserve snapshot presence: an absent snapshot is not an empty item. */
export function resolveAssistantTextInput(data: unknown): AssistantTextInput | undefined {
  const record = asOptionalObjectRecord(data);
  if (!record || (typeof record.text !== "string" && typeof record.delta !== "string")) {
    return undefined;
  }
  return {
    text: typeof record.text === "string" ? record.text : undefined,
    delta: typeof record.delta === "string" ? record.delta : undefined,
    itemId: typeof record.itemId === "string" && record.itemId ? record.itemId : undefined,
    replace: record.replace === true,
    replaceable: record.replaceable === true,
    ...(Array.isArray(record.managedMediaUrls)
      ? {
          managedMediaUrls: record.managedMediaUrls.filter(
            (url): url is string => typeof url === "string",
          ),
        }
      : {}),
  };
}

/** Merge item snapshots without imposing a transport's display or wire limit. */
export function mergeAssistantText(
  previous: AssistantTextSnapshot,
  input: AssistantTextInput,
  unkeyed: "live" | "append-only",
): AssistantTextSnapshot {
  const scope = !input.itemId
    ? undefined
    : previous.scope?.itemId === input.itemId
      ? previous.scope
      : {
          itemId: input.itemId,
          // Only provisional stream replacements discard earlier items.
          prefix: input.replace && input.replaceable ? "" : previous.text,
        };
  let text: string;
  if (scope && input.text !== undefined) {
    text = scope.prefix + input.text;
  } else if (input.text === undefined) {
    text = previous.text + (input.delta ?? "");
  } else if (unkeyed === "append-only") {
    // Legacy HTTP snapshots recover held prefixes; non-prefix input remains
    // incremental unless its producer explicitly marks a replacement.
    text =
      input.replace || input.text.startsWith(previous.text)
        ? input.text
        : previous.text + (input.delta ?? input.text);
  } else if (
    previous.text &&
    input.text.length > previous.text.length &&
    input.text.startsWith(previous.text)
  ) {
    text = input.text;
  } else if (input.delta) {
    text = previous.text + input.delta;
  } else {
    text = previous.text.startsWith(input.text) ? previous.text : input.text;
  }
  return { text, scope };
}
