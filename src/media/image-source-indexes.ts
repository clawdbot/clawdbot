import { isImageMediaFact, type MediaFact } from "./media-facts.js";
import type { PromptImageOrderEntry } from "./prompt-image-order.js";

// Runtime image ownership must be available before transcript mediaImageLayout materializes and
// must survive collect batching, where several recorders are merged into one projected media list.

type ImageSourceIndexesResult =
  | { kind: "none" }
  | { kind: "mapped"; indexes: Array<number | undefined> }
  | { kind: "invalid"; reason: string; indexes: Array<number | undefined> };

type ImageSourceMappingInput = {
  indexes: readonly (number | undefined)[];
  space: "inbound-media" | "run-media";
};

/** Normalizes image slots into the media space used by an executing run. */
export function resolveProjectedImageSourceIndexes(params: {
  imageSourceMapping?: ImageSourceMappingInput;
  imageOrderLength: number;
  projectedMediaSourceIndexes?: readonly (number | undefined)[];
  projectedMediaLength: number;
}): ImageSourceIndexesResult {
  const mapping = params.imageSourceMapping;
  if (!mapping) {
    return { kind: "none" };
  }
  const reasons: string[] = [];
  if (mapping.indexes.length !== params.imageOrderLength) {
    reasons.push("Queued image source slots and image order must remain aligned");
  }
  const sourceIndexes = Array.from(
    { length: params.imageOrderLength },
    (_, index) => mapping.indexes[index],
  );
  if (mapping.space === "run-media") {
    const indexes = sourceIndexes.map((sourceIndex) => {
      if (
        sourceIndex !== undefined &&
        (!Number.isInteger(sourceIndex) ||
          sourceIndex < 0 ||
          sourceIndex >= params.projectedMediaLength)
      ) {
        reasons.push(`Run-media image source index ${sourceIndex} is outside the media projection`);
        return undefined;
      }
      return sourceIndex;
    });
    if (reasons.length > 0) {
      return { kind: "invalid", reason: reasons.join("; "), indexes };
    }
    return { kind: "mapped", indexes };
  }
  if (!params.projectedMediaSourceIndexes) {
    return {
      kind: "invalid",
      reason: [...reasons, "Cannot remap image sources without a declared media projection"].join(
        "; ",
      ),
      indexes: sourceIndexes.map(() => undefined),
    };
  }
  if (params.projectedMediaSourceIndexes.length !== params.projectedMediaLength) {
    return {
      kind: "invalid",
      reason: [...reasons, "Media projection facts and source indexes must remain aligned"].join(
        "; ",
      ),
      indexes: sourceIndexes.map(() => undefined),
    };
  }
  const projectedIndexBySource = new Map<number, number>();
  for (const [projectedIndex, sourceIndex] of params.projectedMediaSourceIndexes.entries()) {
    if (sourceIndex !== undefined) {
      projectedIndexBySource.set(sourceIndex, projectedIndex);
    }
  }
  const indexes: Array<number | undefined> = [];
  for (const sourceIndex of sourceIndexes) {
    if (sourceIndex === undefined) {
      indexes.push(undefined);
      continue;
    }
    const projectedIndex = projectedIndexBySource.get(sourceIndex);
    if (projectedIndex === undefined) {
      reasons.push(`Image source index ${sourceIndex} is absent from the media projection`);
      indexes.push(undefined);
      continue;
    }
    indexes.push(projectedIndex);
  }
  if (reasons.length > 0) {
    return { kind: "invalid", reason: reasons.join("; "), indexes };
  }
  return { kind: "mapped", indexes };
}

/** Maps offloaded image slots to their facts in the combined inbound media list. */
export function buildSuppliedImageSourceIndexes(params: {
  imageOrder?: readonly PromptImageOrderEntry[];
  suppliedMedia: readonly MediaFact[];
  sourceOffset: number;
}): ImageSourceIndexesResult {
  if (!params.imageOrder?.length) {
    return { kind: "none" };
  }
  const suppliedImageIndexes = params.suppliedMedia.flatMap((fact, index) =>
    isImageMediaFact(fact) ? [params.sourceOffset + index] : [],
  );
  const offloadedCount = params.imageOrder.filter((entry) => entry === "offloaded").length;
  if (offloadedCount !== suppliedImageIndexes.length) {
    let suppliedImageIndex = 0;
    return {
      kind: "invalid",
      reason: `Offloaded image slot count ${offloadedCount} does not match supplied image fact count ${suppliedImageIndexes.length}`,
      indexes: params.imageOrder.map((entry) =>
        entry === "offloaded" ? suppliedImageIndexes[suppliedImageIndex++] : undefined,
      ),
    };
  }
  let offloadedIndex = 0;
  const indexes = params.imageOrder.map((entry) =>
    entry === "offloaded" ? suppliedImageIndexes[offloadedIndex++] : undefined,
  );
  return indexes.some((index) => index !== undefined)
    ? { kind: "mapped", indexes }
    : { kind: "none" };
}

/** Selects fact identities for inline payloads, aligned one-to-one with the image array. */
export function resolveInlineImageFactIndexes(params: {
  imageOrder?: readonly PromptImageOrderEntry[];
  imageSourceIndexes?: readonly (number | undefined)[];
}): Array<number | null> | undefined {
  if (!params.imageSourceIndexes) {
    return undefined;
  }
  return params.imageOrder?.flatMap((entry, index) =>
    entry === "inline" ? [params.imageSourceIndexes?.[index] ?? null] : [],
  );
}

/**
 * Orders source-backed entries by source position without moving unsourced entries.
 * Unsourced entries do not share the media index space, so their append positions stay fixed.
 */
export function orderSourceIndexedEntries<T extends { sourceIndex?: number; sequence: number }>(
  entries: readonly T[],
): T[] {
  const sourced = entries
    .filter((entry): entry is T & { sourceIndex: number } => entry.sourceIndex !== undefined)
    .toSorted(
      (left, right) => left.sourceIndex - right.sourceIndex || left.sequence - right.sequence,
    );
  let sourcedIndex = 0;
  return entries
    .toSorted((left, right) => left.sequence - right.sequence)
    .map((entry) => (entry.sourceIndex === undefined ? entry : sourced[sourcedIndex++]!));
}
