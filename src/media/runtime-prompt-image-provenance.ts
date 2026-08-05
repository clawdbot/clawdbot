const RUNTIME_PROMPT_IMAGE_FACT_INDEXES = Symbol.for("openclaw.runtimePromptImageFactIndexes");

type RuntimePromptImageFactIndex = number | null;

export function finalizeRuntimePromptImages<TImage extends object>(
  entries: readonly { image: TImage; factIndex: RuntimePromptImageFactIndex }[],
): { images: TImage[]; imageFactIndexes: RuntimePromptImageFactIndex[] } {
  const images = entries.map((entry) => entry.image);
  const imageFactIndexes = entries.map((entry) => entry.factIndex);
  attachRuntimePromptImageFactIndexes(images, imageFactIndexes);
  return { images, imageFactIndexes };
}

/** Carries fact ownership on image blocks without changing provider-visible bytes. */
function attachRuntimePromptImageFactIndexes(
  images: readonly object[],
  factIndexes: readonly RuntimePromptImageFactIndex[],
): void {
  if (images.length !== factIndexes.length) {
    return;
  }
  Object.defineProperty(images, RUNTIME_PROMPT_IMAGE_FACT_INDEXES, {
    configurable: true,
    value: [...factIndexes],
  });
}

export function readRuntimePromptImageFactIndexes(
  images: readonly object[] | null | undefined,
): RuntimePromptImageFactIndex[] | undefined {
  if (!images?.length) {
    return undefined;
  }
  const factIndexes = (images as unknown as Record<PropertyKey, unknown>)[
    RUNTIME_PROMPT_IMAGE_FACT_INDEXES
  ];
  return Array.isArray(factIndexes) &&
    factIndexes.length === images.length &&
    factIndexes.every(
      (entry) =>
        entry === null || (typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0),
    )
    ? (factIndexes as RuntimePromptImageFactIndex[])
    : undefined;
}
