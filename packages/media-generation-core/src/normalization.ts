/** Primitive value types reported in media generation normalization metadata. */
export type MediaNormalizationValue = string | number | boolean;

/** Requested/applied value pair plus provenance for a normalized media option. */
export type MediaNormalizationEntry<TValue extends MediaNormalizationValue> = {
  requested?: TValue;
  applied?: TValue;
  derivedFrom?: string;
  supportedValues?: readonly TValue[];
};

/** Normalization metadata shared by media generation responses. */
export type MediaGenerationNormalizationMetadataInput = {
  size?: MediaNormalizationEntry<string>;
  aspectRatio?: MediaNormalizationEntry<string>;
  resolution?: MediaNormalizationEntry<string>;
  durationSeconds?: MediaNormalizationEntry<number>;
};

/** True when a normalization entry contains any user-visible normalization metadata. */
export function hasMediaNormalizationEntry<TValue extends MediaNormalizationValue>(
  entry: MediaNormalizationEntry<TValue> | undefined,
): entry is MediaNormalizationEntry<TValue> {
  return Boolean(
    entry &&
    (entry.requested !== undefined ||
      entry.applied !== undefined ||
      entry.derivedFrom !== undefined ||
      (entry.supportedValues?.length ?? 0) > 0),
  );
}
