export type RecordRequirementKind = "object" | "record";

export type RecordRequirementMessage =
  | "expected-label"
  | "expected-label-object"
  | "expected-label-object-short"
  | "expected-label-record"
  | "expected-label-record-short"
  | "expected-label-capitalized"
  | "expected-label-object-capitalized"
  | "expected-non-array-record"
  | "expected-object-value"
  | "expected-record"
  | "label-not-object"
  | "message";

type FixedRecordRequirementMessage =
  | "expected-non-array-record"
  | "expected-object-value"
  | "expected-record";
type LabeledRecordRequirementMessage = Exclude<
  RecordRequirementMessage,
  FixedRecordRequirementMessage
>;

function recordRequirementError(
  message: RecordRequirementMessage,
  label?: string,
): string | undefined {
  switch (message) {
    case "expected-label":
      return `expected ${label}`;
    case "expected-label-object":
      return `expected ${label} to be an object`;
    case "expected-label-object-short":
      return `expected ${label} object`;
    case "expected-label-record":
      return `expected ${label} to be a record`;
    case "expected-label-record-short":
      return `expected ${label} record`;
    case "expected-label-capitalized":
      return `Expected ${label}`;
    case "expected-label-object-capitalized":
      return `Expected ${label} to be an object`;
    case "expected-non-array-record":
      return "Expected a non-array record";
    case "expected-object-value":
      return "Expected object value";
    case "expected-record":
      return "expected record";
    case "label-not-object":
      return `${label} was not an object`;
    case "message":
      return label ?? "expected record";
  }
  return undefined;
}

export function createRequireRecord(
  kind: RecordRequirementKind,
  message: FixedRecordRequirementMessage,
): (value: unknown) => Record<string, unknown>;
export function createRequireRecord(
  kind: RecordRequirementKind,
  message: LabeledRecordRequirementMessage,
): (value: unknown, label: string) => Record<string, unknown>;
export function createRequireRecord(
  kind: RecordRequirementKind,
  message: RecordRequirementMessage,
): (value: unknown, label?: string) => Record<string, unknown> {
  return (value: unknown, label?: string): Record<string, unknown> => {
    const isObject = value !== null && typeof value === "object";
    if (!isObject || (kind === "record" && Array.isArray(value))) {
      throw new Error(recordRequirementError(message, label));
    }
    return value as Record<string, unknown>;
  };
}
