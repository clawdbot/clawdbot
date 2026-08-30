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

// Keyed registry keeps the message union exhaustively checked: adding a
// variant without a formatter is a compile error, and the return stays string.
const RECORD_REQUIREMENT_ERRORS = {
  "expected-label": (label) => `expected ${label}`,
  "expected-label-object": (label) => `expected ${label} to be an object`,
  "expected-label-object-short": (label) => `expected ${label} object`,
  "expected-label-record": (label) => `expected ${label} to be a record`,
  "expected-label-record-short": (label) => `expected ${label} record`,
  "expected-label-capitalized": (label) => `Expected ${label}`,
  "expected-label-object-capitalized": (label) => `Expected ${label} to be an object`,
  "expected-non-array-record": () => "Expected a non-array record",
  "expected-object-value": () => "Expected object value",
  "expected-record": () => "expected record",
  "label-not-object": (label) => `${label} was not an object`,
  message: (label) => label ?? "expected record",
} satisfies Record<RecordRequirementMessage, (label?: string) => string>;

function recordRequirementError(message: RecordRequirementMessage, label?: string): string {
  return RECORD_REQUIREMENT_ERRORS[message](label);
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
