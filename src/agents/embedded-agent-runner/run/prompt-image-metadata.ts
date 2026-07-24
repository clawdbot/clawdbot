import { readPersistedMediaFacts, type MediaFact } from "../../../media/media-facts.js";
import type { AgentMessage } from "../../runtime/index.js";

export type ImageFactIndex = number | null;

export type MediaImageLayout = {
  slots: Array<{ kind: "inline" | "offloaded"; factIndex?: number }>;
  suppressedFactIndexes: number[];
};

export function resolveLayoutInlineFactIndexes(
  layout: MediaImageLayout | undefined,
  existingImageCount: number,
): ImageFactIndex[] | undefined {
  const factIndexes = layout?.slots.flatMap((slot) =>
    slot.kind === "inline" ? [slot.factIndex ?? null] : [],
  );
  return factIndexes?.length === existingImageCount ? factIndexes : undefined;
}

export function countMissingLayoutInlineSlots(
  layout: MediaImageLayout | undefined,
  existingFactIndexes: readonly ImageFactIndex[] | undefined,
  existingImageCount: number,
): number {
  if (!layout) {
    return 0;
  }
  const available = existingFactIndexes
    ? [...existingFactIndexes]
    : Array.from({ length: existingImageCount }, () => null);
  let missing = 0;
  for (const slot of layout.slots) {
    if (slot.kind !== "inline") {
      continue;
    }
    const exactIndex =
      slot.factIndex === undefined
        ? available.length > 0
          ? 0
          : -1
        : available.findIndex((factIndex) => factIndex === slot.factIndex);
    const matchIndex = exactIndex >= 0 ? exactIndex : available.indexOf(null);
    if (matchIndex >= 0) {
      available.splice(matchIndex, 1);
    } else {
      missing++;
    }
  }
  return missing;
}

export function readPersistedImageBlockFactIndexes(
  message: AgentMessage,
): ImageFactIndex[] | undefined {
  const meta = (message as unknown as Record<string, unknown>)["__openclaw"];
  const value =
    meta && typeof meta === "object" && !Array.isArray(meta)
      ? (meta as Record<string, unknown>).mediaImageBlockFactIndexes
      : undefined;
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.map((entry) =>
    typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0 ? entry : null,
  );
}

export function readPersistedPromptMediaFacts(message: AgentMessage): MediaFact[] | undefined {
  return readPersistedMediaFacts(message);
}

export function readPersistedMediaImageLayout(message: AgentMessage): MediaImageLayout | undefined {
  const meta = (message as unknown as Record<string, unknown>)["__openclaw"];
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return undefined;
  }
  const layout = (meta as Record<string, unknown>).mediaImageLayout;
  if (!layout || typeof layout !== "object" || Array.isArray(layout)) {
    return undefined;
  }
  const record = layout as Record<string, unknown>;
  const slots = Array.isArray(record.slots)
    ? record.slots.flatMap((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          return [];
        }
        const slot = entry as Record<string, unknown>;
        if (slot.kind !== "inline" && slot.kind !== "offloaded") {
          return [];
        }
        const kind: MediaImageLayout["slots"][number]["kind"] = slot.kind;
        const factIndex = slot.factIndex;
        return [
          {
            kind,
            ...(typeof factIndex === "number" && Number.isSafeInteger(factIndex) && factIndex >= 0
              ? { factIndex }
              : {}),
          },
        ];
      })
    : [];
  const suppressedFactIndexes = Array.isArray(record.suppressedFactIndexes)
    ? record.suppressedFactIndexes.filter(
        (entry): entry is number =>
          typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0,
      )
    : [];
  return slots.length > 0 || suppressedFactIndexes.length > 0
    ? { slots, suppressedFactIndexes }
    : undefined;
}
