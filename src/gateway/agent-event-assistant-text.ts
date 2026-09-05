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
