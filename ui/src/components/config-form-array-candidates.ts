import {
  arrayConstraintCandidates,
  configValuesEqual,
  defaultValue,
  isSupportedConfigValueValid,
  MAX_AUTO_ARRAY_DEFAULT_ITEMS,
  NO_SAFE_DEFAULT,
} from "./config-form.constraints.ts";
import type { JsonSchema } from "./config-form.shared.ts";

type ArrayAddCandidates = {
  atomicCandidate: unknown[] | undefined;
  autoCandidate: unknown[] | undefined;
};

function extendsArrayValue(value: readonly unknown[], candidate: readonly unknown[]): boolean {
  return (
    candidate.length > value.length &&
    value.every((entry, index) => configValuesEqual(entry, candidate[index]))
  );
}

export function arrayAddCandidates(params: {
  schema: JsonSchema;
  value: unknown[];
  minimumItems: number;
  maximumItems: number | undefined;
  uniqueItems: boolean;
  isUnset: boolean;
  isRequired: boolean;
  itemSchemaAt: (index: number) => JsonSchema;
}): ArrayAddCandidates {
  const {
    schema,
    value,
    minimumItems,
    maximumItems,
    uniqueItems,
    isUnset,
    isRequired,
    itemSchemaAt,
  } = params;
  const requiredAppendCount = Math.max(1, minimumItems - value.length);
  const autoAppendCount =
    requiredAppendCount > MAX_AUTO_ARRAY_DEFAULT_ITEMS ? 1 : requiredAppendCount;
  const generatedItems: unknown[] = [];
  for (let offset = 0; offset < autoAppendCount; offset += 1) {
    const generatedDefault = defaultValue(itemSchemaAt(value.length + offset));
    if (generatedDefault === NO_SAFE_DEFAULT) {
      generatedItems.length = 0;
      break;
    }
    generatedItems.push(generatedDefault);
  }
  const generatedCandidate =
    generatedItems.length === autoAppendCount ? [...value, ...generatedItems] : undefined;
  const autoCandidate =
    generatedCandidate !== undefined &&
    !uniqueItems &&
    (maximumItems === undefined || generatedCandidate.length <= maximumItems) &&
    (generatedCandidate.length < minimumItems ||
      isSupportedConfigValueValid(schema, generatedCandidate))
      ? generatedCandidate
      : undefined;

  const currentValueValid = isSupportedConfigValueValid(schema, value);
  const constrainedCandidate = arrayConstraintCandidates(schema).find(
    (candidate) =>
      isSupportedConfigValueValid(schema, candidate) &&
      (isUnset || !currentValueValid || extendsArrayValue(value, candidate)),
  );
  const wholeArrayDefault =
    constrainedCandidate ??
    (isUnset && isRequired && maximumItems === 0 && isSupportedConfigValueValid(schema, [])
      ? []
      : undefined);
  const atomicCandidate = Array.isArray(wholeArrayDefault)
    ? structuredClone(wholeArrayDefault)
    : undefined;
  return { atomicCandidate, autoCandidate };
}
