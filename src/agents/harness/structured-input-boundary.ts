import { truncateUtf16Safe } from "../../utils.js";
import type { AgentHarnessUserInputQuestion } from "./user-input-bridge.js";

type StructuredInputScalar = string | number | boolean | null;
export type StructuredInputValue =
  | StructuredInputScalar
  | StructuredInputValue[]
  | StructuredInputRecord;
export type StructuredInputRecord = { [key: string]: StructuredInputValue };
export type StructuredInputAnswerValue = string | number | boolean | string[];

type StructuredInputDecodeResult =
  | { kind: "absent" }
  | { kind: "invalid"; message: string }
  | { kind: "present"; entries: Array<[string, StructuredInputAnswerValue]> };

export type StructuredInputField = {
  question: AgentHarnessUserInputQuestion;
  decode: (values: readonly string[]) => StructuredInputDecodeResult;
};

type StructuredInputPlan =
  | { kind: "form"; intro: string; fields: StructuredInputField[] }
  | { kind: "url"; question: AgentHarnessUserInputQuestion };

export type StructuredInputCompileResult =
  | { kind: "ready"; plan: StructuredInputPlan }
  | { kind: "unsupported"; message: string };

export type StructuredInputCompilerOptions = {
  protocolName: string;
  allowEmptyForm?: boolean;
  minimumChoiceCount?: 1 | 2;
  allowEnumNames?: boolean;
  allowImagePicker?: boolean;
  booleanLabels?: readonly [string, string];
  metadata?: {
    secretPath?: readonly string[];
    otherAnswerPath?: readonly string[];
    otherQuestionIdPath?: readonly string[];
  };
};

const MAX_SNAPSHOT_DEPTH = 8;
const MAX_SNAPSHOT_NODES = 256;
const MAX_SNAPSHOT_OBJECT_KEYS = 32;
const MAX_SNAPSHOT_ARRAY_ITEMS = 16;
const MAX_SNAPSHOT_TEXT = 65_536;
const MAX_FIELD_NAME = 256;

/** Copies only bounded, enumerable own data properties without invoking accessors. */
export function snapshotStructuredInput(value: unknown): StructuredInputValue | undefined {
  let nodes = 0;
  const visit = (current: unknown, depth: number): StructuredInputValue | undefined => {
    nodes += 1;
    if (nodes > MAX_SNAPSHOT_NODES || depth > MAX_SNAPSHOT_DEPTH) {
      return undefined;
    }
    if (current === null || typeof current === "boolean") {
      return current;
    }
    if (typeof current === "number") {
      return Number.isFinite(current) ? current : undefined;
    }
    if (typeof current === "string") {
      return current.length <= MAX_SNAPSHOT_TEXT ? current : undefined;
    }
    if (typeof current !== "object") {
      return undefined;
    }
    if (Array.isArray(current)) {
      if (
        Object.getPrototypeOf(current) !== Array.prototype ||
        current.length > MAX_SNAPSHOT_ARRAY_ITEMS
      ) {
        return undefined;
      }
      const descriptors = Object.getOwnPropertyDescriptors(current);
      const keys = Reflect.ownKeys(descriptors);
      if (
        keys.some(
          (key) => typeof key !== "string" || (key !== "length" && !/^(?:0|[1-9]\d*)$/u.test(key)),
        )
      ) {
        return undefined;
      }
      const result: StructuredInputValue[] = [];
      for (let index = 0; index < current.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor?.enumerable || !("value" in descriptor)) {
          return undefined;
        }
        const item = visit(descriptor.value, depth + 1);
        if (item === undefined) {
          return undefined;
        }
        result.push(item);
      }
      return result;
    }
    const descriptors = Object.getOwnPropertyDescriptors(current);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length > MAX_SNAPSHOT_OBJECT_KEYS ||
      keys.some((key) => typeof key !== "string" || key.length > MAX_FIELD_NAME)
    ) {
      return undefined;
    }
    const result: StructuredInputRecord = Object.create(null);
    for (const key of keys) {
      if (typeof key !== "string") {
        return undefined;
      }
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        return undefined;
      }
      if (descriptor.value === undefined) {
        continue;
      }
      const item = visit(descriptor.value, depth + 1);
      if (item === undefined) {
        return undefined;
      }
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: item,
        writable: true,
      });
    }
    return result;
  };
  return visit(value, 0);
}

export function isStructuredInputRecord(value: unknown): value is StructuredInputRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function structuredInputEntries(
  record: StructuredInputRecord,
  maximum: number,
): Array<[string, StructuredInputValue]> | undefined {
  const entries = Object.entries(record);
  return entries.length <= maximum ? entries : undefined;
}

export function structuredInputValue(
  record: StructuredInputRecord,
  key: string,
): StructuredInputValue | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

export function structuredInputString(
  record: StructuredInputRecord,
  key: string,
): string | undefined {
  const value = structuredInputValue(record, key);
  return typeof value === "string" ? value : undefined;
}

export function structuredInputRecord(
  record: StructuredInputRecord,
  key: string,
): StructuredInputRecord | undefined {
  const value = structuredInputValue(record, key);
  return isStructuredInputRecord(value) ? value : undefined;
}

export function structuredInputArray(
  record: StructuredInputRecord,
  key: string,
  maximum: number,
): StructuredInputValue[] | undefined {
  const value = structuredInputValue(record, key);
  return Array.isArray(value) && value.length <= maximum ? value : undefined;
}

export function structuredInputFiniteNumber(
  record: StructuredInputRecord,
  key: string,
): number | null | undefined {
  const value = structuredInputValue(record, key);
  if (value === undefined || value === null) {
    return value;
  }
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function structuredInputInteger(
  record: StructuredInputRecord,
  key: string,
  minimum: number,
): number | null | undefined {
  const value = structuredInputFiniteNumber(record, key);
  if (value === undefined || value === null) {
    return value;
  }
  return Number.isInteger(value) && value >= minimum ? value : null;
}

export function readStructuredInputText(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.length <= maximum && !hasUnsafeVisibleCharacters(value)
    ? value
    : undefined;
}

export function hasUnsafeVisibleCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0x200b && codePoint <= 0x200f) ||
      (codePoint >= 0x2028 && codePoint <= 0x202e) ||
      codePoint === 0x2060 ||
      (codePoint >= 0x2066 && codePoint <= 0x2069) ||
      codePoint === 0xfeff
    ) {
      return true;
    }
  }
  return false;
}

export function boundStructuredInputText(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${truncateUtf16Safe(value, maximum - 1)}…`;
}

export function quoteStructuredInputValue(value: unknown): string {
  return JSON.stringify(value ?? "unknown");
}
