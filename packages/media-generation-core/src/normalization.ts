export type MediaNormalizationValue = string | number | boolean;

export type MediaNormalizationEntry<TValue extends MediaNormalizationValue> = {
  requested?: TValue;
  applied?: TValue;
  derivedFrom?: string;
  supportedValues?: readonly TValue[];
};

export type MediaGenerationNormalizationMetadataInput = {
  size?: MediaNormalizationEntry<string>;
  aspectRatio?: MediaNormalizationEntry<string>;
  resolution?: MediaNormalizationEntry<string>;
  durationSeconds?: MediaNormalizationEntry<number>;
};

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
