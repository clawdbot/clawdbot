import {
  appendRuntimeImageHistory,
  readRuntimeImageHistory,
  withRuntimeImageHistory,
  type RuntimeImageHistory,
} from "@openclaw/media-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

type RequestImageFormat = "responses" | "chat" | "anthropic" | "google" | "mistral";

function requestImageSource(part: Record<string, unknown>, format: RequestImageFormat): unknown[] {
  if (format === "responses") {
    return [part.type, part.image_url];
  }
  if (format === "mistral") {
    return [part.type, part.imageUrl];
  }
  const source =
    format === "google" ? part.inlineData : format === "anthropic" ? part.source : part.image_url;
  const record = isRecord(source) ? source : {};
  return format === "google"
    ? [record.mimeType, record.data]
    : format === "anthropic"
      ? [part.type, record.type, record.media_type, record.data, record.url]
      : [part.type, record.url];
}

/** Bind provenance on fresh native parts to the source that payload hooks may replace. */
export function withRequestImageHistory<T extends Record<string, unknown>>(
  image: T,
  history: RuntimeImageHistory | undefined,
  format: RequestImageFormat,
): T {
  if (!history) {
    return image;
  }
  const encodedSource = requestImageSource(image, format);
  return withRuntimeImageHistory(image, history, (current) => {
    const currentSource = requestImageSource(current, format);
    return encodedSource.every((value, index) => value === currentSource[index]);
  });
}

/** Capture request-local diagnostic origins before payload hooks can replace image objects. */
export function createRequestImageHistoryProjector(request: object, format: RequestImageFormat) {
  const messagesKey =
    format === "responses" ? "input" : format === "google" ? "contents" : "messages";
  const contentKey = format === "google" ? "parts" : "content";
  const textType = format === "responses" ? "input_text" : format === "google" ? undefined : "text";
  const imageType =
    format === "responses" ? "input_image" : format === "anthropic" ? "image" : "image_url";
  const readRows = (value: object) => {
    const messages = isRecord(value) ? value[messagesKey] : undefined;
    return Array.isArray(messages)
      ? messages.flatMap((message: unknown, index) => {
          if (!isRecord(message) || message.role !== "user") {
            return [];
          }
          const content = message[contentKey];
          if (!Array.isArray(content)) {
            return [];
          }
          const images = content.flatMap((part: unknown, contentIndex) =>
            isRecord(part) &&
            (format === "google" ? isRecord(part.inlineData) : part.type === imageType)
              ? [
                  Object.freeze({
                    part,
                    contentIndex,
                    source: Object.freeze(requestImageSource(part, format)),
                    history: readRuntimeImageHistory(part),
                  }),
                ]
              : [],
          );
          return [{ index, message, content, images }];
        })
      : [];
  };
  type Row = ReturnType<typeof readRows>[number];
  type Image = Row["images"][number];
  const captured = readRows(request).flatMap(({ images }) => images);
  const capturedParts = new Set(captured.map((image) => image.part));
  const sameSource = (left: Image, right: Image) =>
    left.source.every((value, index) => value === right.source[index]);

  const replaceRows = <T extends object>(
    value: T,
    rows: Row[],
    project: (row: Row) => unknown[] | undefined,
  ): T => {
    if (!isRecord(value) || !Array.isArray(value[messagesKey])) {
      return value;
    }
    const messages = value[messagesKey].slice();
    let changed = false;
    for (const row of rows) {
      const content = project(row);
      if (content) {
        changed = true;
        messages[row.index] = { ...row.message, [contentKey]: content };
      }
    }
    return changed ? { ...value, [messagesKey]: messages } : value;
  };

  return {
    bind<T extends object>(value: T): T {
      const rows = readRows(value);
      const images = rows.flatMap((row) => row.images);
      const remaining = new Set(captured);
      const origins = new Map<Image, Image>();
      // Reserve unchanged identities before matching clones. Known mutated parts
      // cannot borrow another origin, but a clone of their original bytes can survive.
      for (const image of images) {
        const original = Array.from(remaining).find((item) => item.part === image.part);
        if (original && sameSource(original, image)) {
          remaining.delete(original);
          origins.set(image, original);
        }
      }
      for (const image of images) {
        if (capturedParts.has(image.part)) {
          continue;
        }
        const history = image.history;
        const original =
          history &&
          Array.from(remaining).find((item) => item.history === history && sameSource(item, image));
        if (original) {
          remaining.delete(original);
          origins.set(image, original);
        }
      }
      for (const image of images) {
        if (capturedParts.has(image.part) || image.history) {
          continue;
        }
        const candidates = captured.filter((item) => sameSource(item, image));
        const candidate = candidates.find((item) => remaining.has(item));
        const history = candidate?.history;
        // Byte-identical ordinary/retained or conflicting origins are ambiguous
        // after cloning. Do not infer provenance from message or image positions.
        if (
          !candidate ||
          !history ||
          candidates.some((item) => {
            const other = item.history;
            return other?.key !== history.key || other?.sourceText !== history.sourceText;
          })
        ) {
          continue;
        }
        remaining.delete(candidate);
        origins.set(image, candidate);
      }
      return replaceRows(value, rows, (row) => {
        const content = row.content.slice();
        let changed = false;
        for (const image of row.images) {
          const origin = origins.get(image);
          if (image.history === origin?.history) {
            continue;
          }
          // Bind only fresh parts; caller objects and non-configurable hints stay
          // untouched. Final native filters can validate, normalize, or drop them.
          const part = { ...image.part };
          content[image.contentIndex] = withRequestImageHistory(part, origin?.history, format);
          changed = true;
        }
        return changed ? content : undefined;
      });
    },
    project<T extends object>(value: T): T {
      return replaceRows(value, readRows(value), (row) => {
        const textPart = row.content
          .filter(isRecord)
          .find((part) => part.type === textType && typeof part.text === "string");
        const prompt = typeof textPart?.text === "string" ? textPart.text : "";
        const text = appendRuntimeImageHistory(
          prompt,
          row.images.map(({ part }) => part),
        );
        if (text === prompt) {
          return undefined;
        }
        const content = row.content.slice();
        if (textPart) {
          content[row.content.indexOf(textPart)] = { ...textPart, text };
        } else {
          content.unshift({ ...(textType ? { type: textType } : {}), text });
        }
        return content;
      });
    },
  };
}
