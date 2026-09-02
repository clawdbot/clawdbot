import type { UserTurnInput } from "../sessions/user-turn-transcript.types.js";

const RUNTIME_PROMPT_IMAGE_PROVENANCE = Symbol.for("openclaw.runtimePromptImageProvenance");
type RuntimePromptImageFactIndex = number | null;
type MediaImageLayout = NonNullable<UserTurnInput["mediaImageLayout"]>;
type RuntimePromptImageProvenance = {
  imageFactIndexes: RuntimePromptImageFactIndex[];
  mediaImageLayout: MediaImageLayout;
};

export function finalizeRuntimePromptImages<TImage extends object>(
  entries: readonly {
    image: TImage;
    factIndex: RuntimePromptImageFactIndex;
    sourceSlotIndex?: number;
  }[],
  declaredLayout?: MediaImageLayout,
): { images: TImage[] } & RuntimePromptImageProvenance {
  const images = entries.map((entry) => entry.image);
  const imageFactIndexes = entries.map((entry) => entry.factIndex);
  const successfulBySlot = new Map(
    entries.flatMap((entry) =>
      entry.sourceSlotIndex === undefined ? [] : [[entry.sourceSlotIndex, entry] as const],
    ),
  );
  const suppressed = new Set(declaredLayout?.suppressedFactIndexes);
  const inline = (factIndex: RuntimePromptImageFactIndex) => ({
    kind: "inline" as const,
    ...(factIndex === null ? {} : { factIndex }),
  });
  // Missing facts retain their place; absent factless slots have no recoverable bytes.
  const slots = (declaredLayout?.slots ?? []).flatMap((slot, index) => {
    if (slot.factIndex !== undefined && suppressed.has(slot.factIndex)) {
      return [];
    }
    const entry = successfulBySlot.get(index);
    return [
      ...(entry ? [inline(entry.factIndex)] : []),
      ...(slot.factIndex !== undefined && entry?.factIndex !== slot.factIndex
        ? [{ kind: "offloaded" as const, factIndex: slot.factIndex }]
        : []),
    ];
  });
  // Extras have no declaration position; the detector already ordered their delivered bytes.
  slots.push(
    ...entries
      .filter((entry) => entry.sourceSlotIndex === undefined)
      .map((entry) => inline(entry.factIndex)),
  );
  const mediaImageLayout: MediaImageLayout = {
    slots,
    ...(suppressed.size ? { suppressedFactIndexes: [...suppressed] } : {}),
  };
  Object.defineProperty(images, RUNTIME_PROMPT_IMAGE_PROVENANCE, {
    configurable: true,
    value: { imageFactIndexes, mediaImageLayout, images: images.slice() },
  });
  return { images, imageFactIndexes, mediaImageLayout };
}

/** Image order, fact ownership and replay placement come from one prepared array. */
export function readRuntimePromptImageProvenance(
  images: readonly object[] | null | undefined,
): RuntimePromptImageProvenance | undefined {
  if (!images?.length) {
    return undefined;
  }
  const runtimeImages: readonly object[] & {
    [RUNTIME_PROMPT_IMAGE_PROVENANCE]?: RuntimePromptImageProvenance & {
      images: readonly object[];
    };
  } = images;
  const provenance = runtimeImages[RUNTIME_PROMPT_IMAGE_PROVENANCE];
  return provenance &&
    provenance.imageFactIndexes.length === images.length &&
    provenance.images.length === images.length &&
    provenance.images.every((image, index) => image === images[index])
    ? {
        imageFactIndexes: provenance.imageFactIndexes,
        mediaImageLayout: provenance.mediaImageLayout,
      }
    : undefined;
}
