import { isImageMediaFact, type MediaFact } from "../../../media/media-facts.js";
import type { PromptImageOrderEntry } from "../../../media/prompt-image-order.js";
import type { AgentMessage } from "../../runtime/index.js";

export type ImageFactIndex = number | null;

export type MediaImageLayout = {
  slots: Array<{ kind: "inline" | "offloaded"; factIndex?: number }>;
  suppressedFactIndexes?: number[];
};

/** Resolves image ownership before independent media arrays are combined. */
export function resolveMediaImageLayout(params: {
  media: readonly MediaFact[];
  imageOrder?: readonly PromptImageOrderEntry[];
  mediaImageLayout?: MediaImageLayout;
  inlineImageCount: number;
}): MediaImageLayout {
  const suppressed = new Set([
    ...(params.mediaImageLayout?.suppressedFactIndexes ?? []),
    ...params.media.flatMap((fact, index) => (fact.hydrationSuppressed === true ? [index] : [])),
  ]);
  const imageFactIndexes = params.media.flatMap((fact, factIndex) =>
    isImageMediaFact(fact) && !suppressed.has(factIndex) ? [factIndex] : [],
  );
  const slots = (() => {
    // Keep suppressed inline slots for byte-to-fact alignment; consumers filter
    // them only after associating the original inline image array.
    if (params.mediaImageLayout?.slots.length) {
      return params.mediaImageLayout.slots;
    }
    if (params.imageOrder?.length === imageFactIndexes.length) {
      return params.imageOrder.map((kind, index) => ({ kind, factIndex: imageFactIndexes[index] }));
    }
    if (params.imageOrder?.length) {
      const pending = [...imageFactIndexes];
      return [
        ...params.imageOrder.map((kind) => ({
          kind,
          ...(kind === "offloaded" && pending.length ? { factIndex: pending.shift() } : {}),
        })),
        ...pending.map((factIndex) => ({ kind: "offloaded" as const, factIndex })),
      ];
    }
    return imageFactIndexes.map((factIndex, imageIndex) => ({
      factIndex,
      kind:
        !params.media[factIndex]?.path &&
        !params.media[factIndex]?.url &&
        imageIndex < params.inlineImageCount
          ? ("inline" as const)
          : ("offloaded" as const),
    }));
  })();
  return { slots, suppressedFactIndexes: [...suppressed] };
}

export function readPersistedImageBlockFactIndexes(
  message: AgentMessage,
): ImageFactIndex[] | undefined {
  const meta = Reflect.get(message, "__openclaw");
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

export function readPersistedMediaImageLayout(message: AgentMessage): MediaImageLayout | undefined {
  const meta = Reflect.get(message, "__openclaw");
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
