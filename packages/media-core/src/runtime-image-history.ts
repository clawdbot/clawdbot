// Core and plugin bundle copies share the symbol. Its non-enumerable property
// carries provenance without adding fields to provider payloads or stored data.
const RUNTIME_IMAGE_HISTORY = Symbol.for("openclaw.runtimeImageHistory");
const MAX_HISTORY_SOURCE_BYTES = 192;
const MAX_HISTORY_NOTES = 4;

export type RuntimeImageHistory = Readonly<{
  key: string;
  sourceText: string;
}>;

export function withRuntimeImageHistory<T extends object>(
  image: T,
  history: RuntimeImageHistory | undefined,
  isCurrent?: (image: T) => boolean,
): T {
  if (!history || readRuntimeImageHistory(image) === history) {
    return image;
  }
  if (Buffer.byteLength(history.sourceText, "utf8") > MAX_HISTORY_SOURCE_BYTES) {
    throw new RangeError("Retained image source context exceeds its byte limit");
  }
  const frozenHistory = Object.freeze(history);
  Object.defineProperty(image, RUNTIME_IMAGE_HISTORY, {
    // A copied descriptor must validate its receiver, not the original image.
    get(this: T) {
      return !isCurrent || isCurrent(this) ? frozenHistory : undefined;
    },
  });
  return image;
}

export function readRuntimeImageHistory(
  image: object | undefined,
): RuntimeImageHistory | undefined {
  const annotated: object & { [RUNTIME_IMAGE_HISTORY]?: RuntimeImageHistory } = image ?? {};
  return annotated[RUNTIME_IMAGE_HISTORY];
}

/** Call only with the images accepted by the final runtime encoder. */
export function appendRuntimeImageHistory(prompt: string, images: readonly object[]): string {
  const history = images.flatMap((image) => {
    const source = readRuntimeImageHistory(image);
    return source ? [source] : [];
  });
  // Four bounded clauses keep injected context below 1 KB even for hostile labels.
  const notes = history
    .slice(0, MAX_HISTORY_NOTES)
    .map((source, index) => `[Recent image ${index + 1} ${source.sourceText}, attached as media.]`);
  return notes.length === 0
    ? prompt
    : [prompt, notes.join("\n")].filter((part) => part.trim().length > 0).join("\n\n");
}
