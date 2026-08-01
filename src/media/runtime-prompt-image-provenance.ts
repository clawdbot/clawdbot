const RUNTIME_PROMPT_IMAGE_FACT_INDEXES = Symbol.for("openclaw.runtimePromptImageFactIndexes");

type RuntimePromptImageFactIndex = number | null;
export type RuntimePromptImageFactSpace = "inbound-media" | "run-media";

type RuntimePromptImageProvenance = {
  factIndexes: RuntimePromptImageFactIndex[];
  space?: RuntimePromptImageFactSpace;
};

export function finalizeRuntimePromptImages<TImage extends object>(
  entries: readonly { image: TImage; factIndex: RuntimePromptImageFactIndex }[],
  space?: RuntimePromptImageFactSpace,
): { images: TImage[]; imageFactIndexes: RuntimePromptImageFactIndex[] } {
  const images = entries.map((entry) => entry.image);
  const imageFactIndexes = entries.map((entry) => entry.factIndex);
  attachRuntimePromptImageFactIndexes(images, imageFactIndexes, space);
  return { images, imageFactIndexes };
}

/** Carries fact ownership on image blocks without changing provider-visible bytes. */
function attachRuntimePromptImageFactIndexes(
  images: readonly object[],
  factIndexes: readonly RuntimePromptImageFactIndex[],
  space?: RuntimePromptImageFactSpace,
): void {
  if (images.length !== factIndexes.length) {
    return;
  }
  Object.defineProperty(images, RUNTIME_PROMPT_IMAGE_FACT_INDEXES, {
    configurable: true,
    value: {
      factIndexes: [...factIndexes],
      ...(space ? { space } : {}),
    } satisfies RuntimePromptImageProvenance,
  });
}

function isRuntimePromptImageFactIndexes(
  value: unknown,
  imageCount: number,
): value is RuntimePromptImageFactIndex[] {
  return (
    Array.isArray(value) &&
    value.length === imageCount &&
    value.every(
      (entry) =>
        entry === null || (typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0),
    )
  );
}

export function readRuntimePromptImageProvenance(
  images: readonly object[] | null | undefined,
): RuntimePromptImageProvenance | undefined {
  if (!images?.length) {
    return undefined;
  }
  const value = (images as unknown as Record<PropertyKey, unknown>)[
    RUNTIME_PROMPT_IMAGE_FACT_INDEXES
  ];
  // Accept the pre-space carrier while queued turns from an older process drain during upgrade.
  if (isRuntimePromptImageFactIndexes(value, images.length)) {
    return { factIndexes: value };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (!isRuntimePromptImageFactIndexes(candidate.factIndexes, images.length)) {
    return undefined;
  }
  const space = candidate.space;
  if (space !== undefined && space !== "inbound-media" && space !== "run-media") {
    return undefined;
  }
  return {
    factIndexes: candidate.factIndexes,
    ...(space ? { space } : {}),
  };
}

export function readRuntimePromptImageFactIndexes(
  images: readonly object[] | null | undefined,
): RuntimePromptImageFactIndex[] | undefined {
  return readRuntimePromptImageProvenance(images)?.factIndexes;
}
