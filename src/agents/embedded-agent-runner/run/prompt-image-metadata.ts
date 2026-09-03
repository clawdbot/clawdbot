import { isImageMediaFact, type MediaFact } from "../../../media/media-facts.js";
import type { PromptImageOrderEntry } from "../../../media/prompt-image-order.js";
import type { UserTurnInput } from "../../../sessions/user-turn-transcript.types.js";

export type ImageFactIndex = number | null;

export type MediaImageLayout = NonNullable<UserTurnInput["mediaImageLayout"]>;

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
