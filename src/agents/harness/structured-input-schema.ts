import {
  boundStructuredInputText as boundText,
  hasUnsafeVisibleCharacters,
  isStructuredInputRecord,
  quoteStructuredInputValue as quote,
  readStructuredInputText,
  structuredInputArray as ownArray,
  structuredInputEntries,
  structuredInputFiniteNumber as ownFiniteNumber,
  structuredInputInteger as ownInteger,
  structuredInputRecord as ownRecord,
  structuredInputString as ownString,
  structuredInputValue as ownValue,
} from "./structured-input-boundary.js";
import type {
  StructuredInputAnswerValue,
  StructuredInputCompilerOptions,
  StructuredInputField,
  StructuredInputRecord,
} from "./structured-input-boundary.js";
import type { AgentHarnessUserInputOption } from "./user-input-bridge.js";

const MAX_SCHEMA_KEYS = 24;
const MAX_FIELD_TEXT = 512;
const MAX_CHOICE_COUNT = 4;
const MAX_CHOICE_LABEL = 64;
const MAX_CHOICE_VALUE = 256;
const MAX_IMAGE_PICKER_ID = 128;
const MAX_INPUT_TEXT = 4_096;

type FieldContext = {
  fieldId: string;
  questionId: string;
  required: boolean;
  secret: boolean;
  otherFieldId?: string;
};

type Choice = { value: string; label: string; description?: string };
type DecodeValue =
  | { kind: "absent" }
  | { kind: "invalid"; message: string }
  | { kind: "present"; value: StructuredInputAnswerValue };

export function compileStructuredInputField(
  context: FieldContext,
  schema: StructuredInputRecord,
  options: StructuredInputCompilerOptions,
): StructuredInputField | string {
  if (!structuredInputEntries(schema, MAX_SCHEMA_KEYS)) {
    return "has an over-limit schema.";
  }
  const type = ownString(schema, "type");
  if (type === "openai/imagePicker") {
    return options.allowImagePicker === true
      ? compileImagePickerField(context, schema)
      : `uses unsupported type ${quote(type)}.`;
  }
  if (type === "boolean") {
    return compileBooleanField(context, schema, options);
  }
  if (type === "number" || type === "integer") {
    return compileNumberField(context, schema, type);
  }
  if (type === "array") {
    return compileMultiSelectField(context, schema, options);
  }
  if (type !== "string") {
    return `uses unsupported type ${quote(type)}.`;
  }
  const choices = readChoices(schema, options);
  if (typeof choices === "string") {
    return choices;
  }
  return choices
    ? compileChoiceField(context, schema, choices)
    : compileStringField(context, schema);
}

function compileStringField(
  context: FieldContext,
  schema: StructuredInputRecord,
): StructuredInputField | string {
  const minLength = ownInteger(schema, "minLength", 0);
  const maxLength = ownInteger(schema, "maxLength", 0);
  if (
    minLength === null ||
    maxLength === null ||
    (minLength !== undefined && minLength > MAX_INPUT_TEXT) ||
    (maxLength !== undefined && maxLength > MAX_INPUT_TEXT) ||
    (minLength !== undefined && maxLength !== undefined && minLength > maxLength)
  ) {
    return "has invalid string length constraints.";
  }
  const pattern = ownValue(schema, "pattern");
  if (pattern !== undefined && pattern !== null) {
    return "uses an unsupported pattern constraint.";
  }
  const format = ownString(schema, "format");
  if (format && !["email", "uri", "date", "date-time"].includes(format)) {
    return `uses unsupported string format ${quote(format)}.`;
  }
  const defaultValue = ownValue(schema, "default");
  if (defaultValue !== undefined && defaultValue !== null && typeof defaultValue !== "string") {
    return "has a non-string default.";
  }
  const defaultText = typeof defaultValue === "string" ? defaultValue : undefined;
  const validate = (value: string): string | undefined => {
    if (value.length > MAX_INPUT_TEXT) {
      return `must contain at most ${MAX_INPUT_TEXT} characters.`;
    }
    if (minLength !== undefined && value.length < minLength) {
      return `must contain at least ${minLength} characters.`;
    }
    if (maxLength !== undefined && value.length > maxLength) {
      return `must contain at most ${maxLength} characters.`;
    }
    if (format && !matchesStringFormat(value, format)) {
      return `is not a valid ${format} value.`;
    }
    return undefined;
  };
  if (defaultText !== undefined) {
    const error = validate(defaultText);
    if (error) {
      return `has a default that ${error}`;
    }
  }
  return buildField(context, schema, {
    constraints: [
      minLength !== undefined ? `minimum ${minLength} characters` : undefined,
      `maximum ${maxLength ?? MAX_INPUT_TEXT} characters`,
      format ? `format: ${format}` : undefined,
    ],
    options: null,
    isOther: true,
    defaultValue: defaultText,
    decode: (values) => {
      const missing = decodeMissing(context, values, defaultText);
      if (missing) {
        return missing;
      }
      const value = values[0] ?? "";
      const error = validate(value);
      return error ? invalid(context, error) : { kind: "present", value };
    },
  });
}

function compileNumberField(
  context: FieldContext,
  schema: StructuredInputRecord,
  type: "number" | "integer",
): StructuredInputField | string {
  const minimum = ownFiniteNumber(schema, "minimum");
  const maximum = ownFiniteNumber(schema, "maximum");
  if (
    minimum === null ||
    maximum === null ||
    (minimum !== undefined && maximum !== undefined && minimum > maximum)
  ) {
    return "has invalid numeric constraints.";
  }
  const rawDefault = ownValue(schema, "default");
  const defaultValue = typeof rawDefault === "number" ? rawDefault : undefined;
  if (rawDefault !== undefined && rawDefault !== null && defaultValue === undefined) {
    return "has a non-numeric default.";
  }
  const validate = (value: number): string | undefined => {
    if (!Number.isFinite(value)) {
      return "must be a finite number.";
    }
    if (type === "integer" && !Number.isInteger(value)) {
      return "must be an integer.";
    }
    if (minimum !== undefined && value < minimum) {
      return `must be at least ${minimum}.`;
    }
    if (maximum !== undefined && value > maximum) {
      return `must be at most ${maximum}.`;
    }
    return undefined;
  };
  if (defaultValue !== undefined && validate(defaultValue)) {
    return "has a default outside its numeric constraints.";
  }
  return buildField(context, schema, {
    constraints: [
      type === "integer" ? "whole number" : "number",
      minimum !== undefined ? `minimum ${minimum}` : undefined,
      maximum !== undefined ? `maximum ${maximum}` : undefined,
    ],
    options: null,
    isOther: true,
    defaultValue,
    decode: (values) => {
      const missing = decodeMissing(context, values, defaultValue);
      if (missing) {
        return missing;
      }
      const raw = values[0]?.trim() ?? "";
      if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(raw)) {
        return invalid(context, type === "integer" ? "must be an integer." : "must be a number.");
      }
      const value = Number(raw);
      const error = validate(value);
      return error ? invalid(context, error) : { kind: "present", value };
    },
  });
}

function compileBooleanField(
  context: FieldContext,
  schema: StructuredInputRecord,
  options: StructuredInputCompilerOptions,
): StructuredInputField | string {
  const rawDefault = ownValue(schema, "default");
  const defaultValue = typeof rawDefault === "boolean" ? rawDefault : undefined;
  if (rawDefault !== undefined && rawDefault !== null && defaultValue === undefined) {
    return "has a non-boolean default.";
  }
  const [positive, negative] = options.booleanLabels ?? ["Yes", "No"];
  const choices = [
    { label: positive, value: "true" },
    { label: negative, value: "false" },
  ];
  return buildField(context, schema, {
    constraints: [],
    options: choices,
    isOther: false,
    defaultValue,
    decode: (values) => {
      const missing = decodeMissing(context, values, defaultValue);
      if (missing) {
        return missing;
      }
      const selected = findChoice(choices, values[0]);
      return selected
        ? { kind: "present", value: selected.value === "true" }
        : invalid(context, `must be ${positive} or ${negative}.`);
    },
  });
}

function compileChoiceField(
  context: FieldContext,
  schema: StructuredInputRecord,
  choices: Choice[],
): StructuredInputField | string {
  const rawDefault = ownValue(schema, "default");
  const defaultValue = typeof rawDefault === "string" ? rawDefault : undefined;
  if (
    rawDefault !== undefined &&
    rawDefault !== null &&
    (defaultValue === undefined || !choices.some((choice) => choice.value === defaultValue))
  ) {
    return "has a default outside its declared choices.";
  }
  return buildField(context, schema, {
    constraints: [],
    options: choices,
    isOther: context.otherFieldId !== undefined,
    defaultValue,
    decode: (values) => {
      const missing = decodeMissing(context, values, defaultValue);
      if (missing) {
        return missing;
      }
      const selected = findChoice(choices, values[0]);
      if (selected) {
        return { kind: "present", value: selected.value };
      }
      return context.otherFieldId
        ? { kind: "present", value: values[0] ?? "" }
        : invalid(context, "contains an undeclared choice.");
    },
  });
}

function compileMultiSelectField(
  context: FieldContext,
  schema: StructuredInputRecord,
  options: StructuredInputCompilerOptions,
): StructuredInputField | string {
  const items = ownRecord(schema, "items");
  if (!items) {
    return "has no string choice schema for its array items.";
  }
  const choices = readArrayChoices(items, options);
  if (typeof choices === "string") {
    return choices;
  }
  const minItems = ownInteger(schema, "minItems", 0);
  const maxItems = ownInteger(schema, "maxItems", 0);
  if (
    minItems === null ||
    maxItems === null ||
    (minItems !== undefined && maxItems !== undefined && minItems > maxItems) ||
    (maxItems !== undefined && maxItems > choices.length)
  ) {
    return "has invalid multi-select limits.";
  }
  const rawDefault = ownValue(schema, "default");
  const defaultEntries =
    rawDefault === null ? undefined : ownArray(schema, "default", choices.length);
  const defaultValue = defaultEntries?.filter(
    (value): value is string => typeof value === "string",
  );
  if (
    rawDefault !== undefined &&
    rawDefault !== null &&
    (!defaultEntries ||
      defaultValue?.length !== defaultEntries.length ||
      defaultValue.some((value) => !choices.some((choice) => choice.value === value)) ||
      (minItems !== undefined && defaultValue.length < minItems) ||
      (maxItems !== undefined && defaultValue.length > maxItems))
  ) {
    return "has an invalid multi-select default.";
  }
  return buildField(context, schema, {
    constraints: [
      minItems !== undefined ? `choose at least ${minItems}` : undefined,
      maxItems !== undefined ? `choose at most ${maxItems}` : undefined,
    ],
    options: choices,
    isOther: false,
    multiSelect: true,
    defaultValue,
    decode: (values) => {
      const missing = decodeMissing(context, values, defaultValue);
      if (missing) {
        return missing;
      }
      const decoded = values.flatMap((value) => {
        const choice = findChoice(choices, value);
        return choice ? [choice.value] : [];
      });
      if (decoded.length !== values.length || new Set(decoded).size !== decoded.length) {
        return invalid(context, "contains an invalid or duplicate choice.");
      }
      if (minItems !== undefined && decoded.length < minItems) {
        return invalid(context, `requires at least ${minItems} choices.`);
      }
      if (maxItems !== undefined && decoded.length > maxItems) {
        return invalid(context, `allows at most ${maxItems} choices.`);
      }
      return { kind: "present", value: decoded };
    },
  });
}

function compileImagePickerField(
  context: FieldContext,
  schema: StructuredInputRecord,
): StructuredInputField | string {
  const items = ownArray(schema, "items", MAX_CHOICE_COUNT);
  if (!items || items.length === 0) {
    return `must contain 1 to ${MAX_CHOICE_COUNT} image choices.`;
  }
  const choices: Choice[] = [];
  for (const item of items) {
    if (!isStructuredInputRecord(item)) {
      return "has an invalid image choice.";
    }
    const id = ownString(item, "id");
    const title = ownString(item, "title");
    if (
      !id ||
      !title ||
      id.length > MAX_IMAGE_PICKER_ID ||
      title.length > MAX_CHOICE_LABEL ||
      hasUnsafeVisibleCharacters(id) ||
      hasUnsafeVisibleCharacters(title)
    ) {
      return "has an image choice with an invalid or over-limit id/title.";
    }
    choices.push({ value: id, label: title });
  }
  const error = validateChoices(choices);
  return error ?? compileChoiceField(context, schema, choices);
}

function buildField(
  context: FieldContext,
  schema: StructuredInputRecord,
  params: {
    constraints: Array<string | undefined>;
    options: Choice[] | null;
    isOther: boolean;
    multiSelect?: boolean;
    defaultValue?: StructuredInputAnswerValue;
    decode: (values: readonly string[]) => DecodeValue;
  },
): StructuredInputField {
  const title =
    readStructuredInputText(ownString(schema, "title") ?? context.fieldId, MAX_FIELD_TEXT) ??
    "Field";
  const description =
    readStructuredInputText(ownString(schema, "description") ?? "", MAX_FIELD_TEXT) ?? "";
  const details = [
    description,
    context.required ? "Required." : "Optional.",
    params.defaultValue !== undefined ? `Default: ${displayDefault(params.defaultValue)}.` : "",
    params.constraints.filter(Boolean).join("; "),
  ].filter(Boolean);
  return {
    question: {
      id: context.questionId,
      header: boundText(title, 12),
      question: boundText(
        details.length > 0 ? `${title}\n${details.join(" ")}` : title,
        MAX_FIELD_TEXT,
      ),
      ...(params.multiSelect ? { multiSelect: true } : {}),
      isOther: params.isOther,
      isSecret: context.secret,
      options:
        params.options?.map((choice): AgentHarnessUserInputOption => ({
          label: choice.label,
          ...(choice.description ? { description: choice.description } : {}),
        })) ?? null,
    },
    decode: (values) => {
      const decoded = params.decode(values);
      if (decoded.kind !== "present") {
        return decoded;
      }
      const selectedDeclaredChoice = params.options?.some(
        (choice) => choice.label.toLowerCase() === values[0]?.trim().toLowerCase(),
      );
      const selectedOther =
        context.otherFieldId &&
        params.options &&
        values.some((value) => value !== "") &&
        !selectedDeclaredChoice;
      return {
        kind: "present",
        entries: [[selectedOther ? context.otherFieldId! : context.fieldId, decoded.value]],
      };
    },
  };
}

function readChoices(
  schema: StructuredInputRecord,
  options: StructuredInputCompilerOptions,
): Choice[] | string | undefined {
  const enumValue = ownValue(schema, "enum");
  const oneOfValue = ownValue(schema, "oneOf");
  if (
    enumValue !== undefined &&
    enumValue !== null &&
    oneOfValue !== undefined &&
    oneOfValue !== null
  ) {
    return "declares both enum and oneOf choices.";
  }
  if (enumValue !== undefined && enumValue !== null) {
    if (!Array.isArray(enumValue)) {
      return "has an invalid enum.";
    }
    const enumNames = options.allowEnumNames ? ownValue(schema, "enumNames") : undefined;
    if (
      enumNames !== undefined &&
      (!Array.isArray(enumNames) || enumNames.length !== enumValue.length)
    ) {
      return "has invalid enumNames.";
    }
    return normalizeChoices(
      enumValue.map((value, index) => ({
        value,
        label: Array.isArray(enumNames) ? enumNames[index] : value,
      })),
      options.minimumChoiceCount ?? 1,
    );
  }
  if (oneOfValue !== undefined && oneOfValue !== null) {
    if (!Array.isArray(oneOfValue)) {
      return "has an invalid oneOf.";
    }
    return normalizeChoices(
      oneOfValue.map((entry) => ({
        value: isStructuredInputRecord(entry) ? ownValue(entry, "const") : undefined,
        label: isStructuredInputRecord(entry) ? ownValue(entry, "title") : undefined,
        description: isStructuredInputRecord(entry) ? ownValue(entry, "description") : undefined,
      })),
      options.minimumChoiceCount ?? 1,
    );
  }
  return undefined;
}

function readArrayChoices(
  items: StructuredInputRecord,
  options: StructuredInputCompilerOptions,
): Choice[] | string {
  if (ownString(items, "type") === "string") {
    return readChoices(items, options) ?? "must declare enum or oneOf array choices.";
  }
  const entries = ownValue(items, "anyOf") ?? ownValue(items, "oneOf");
  if (!Array.isArray(entries)) {
    return "must declare string enum, anyOf, or oneOf array choices.";
  }
  return normalizeChoices(
    entries.map((entry) => ({
      value: isStructuredInputRecord(entry) ? ownValue(entry, "const") : undefined,
      label: isStructuredInputRecord(entry) ? ownValue(entry, "title") : undefined,
      description: isStructuredInputRecord(entry) ? ownValue(entry, "description") : undefined,
    })),
    options.minimumChoiceCount ?? 1,
  );
}

function normalizeChoices(
  raw: Array<{ value: unknown; label: unknown; description?: unknown }>,
  minimum: number,
): Choice[] | string {
  if (raw.length < minimum || raw.length > MAX_CHOICE_COUNT) {
    return `must declare between ${minimum} and ${MAX_CHOICE_COUNT} choices; choices are never truncated.`;
  }
  const choices: Choice[] = [];
  for (const entry of raw) {
    const description =
      entry.description === undefined || entry.description === null
        ? undefined
        : readStructuredInputText(entry.description, MAX_FIELD_TEXT);
    if (
      typeof entry.value !== "string" ||
      typeof entry.label !== "string" ||
      !entry.value ||
      !entry.label ||
      entry.value.length > MAX_CHOICE_VALUE ||
      entry.label.length > MAX_CHOICE_LABEL ||
      hasUnsafeVisibleCharacters(entry.value) ||
      hasUnsafeVisibleCharacters(entry.label) ||
      (entry.description !== undefined && entry.description !== null && !description)
    ) {
      return "contains an invalid or over-limit choice.";
    }
    choices.push({
      value: entry.value,
      label: entry.label,
      ...(description ? { description } : {}),
    });
  }
  return validateChoices(choices) ?? choices;
}

function validateChoices(choices: readonly Choice[]): string | undefined {
  const values = new Set<string>();
  const labels = new Set<string>();
  for (const choice of choices) {
    const value = choice.value.toLowerCase();
    const label = choice.label.trim().toLowerCase();
    if (values.has(value) || labels.has(label) || values.has(label) || labels.has(value)) {
      return "contains duplicate choice values or titles.";
    }
    values.add(value);
    labels.add(label);
  }
  return undefined;
}

function decodeMissing(
  context: FieldContext,
  values: readonly string[],
  defaultValue: StructuredInputAnswerValue | undefined,
): DecodeValue | undefined {
  if (values.some((value) => value !== "")) {
    return undefined;
  }
  if (defaultValue !== undefined) {
    return { kind: "present", value: defaultValue };
  }
  return context.required ? invalid(context, "is required.") : { kind: "absent" };
}

function invalid(context: FieldContext, message: string): DecodeValue {
  return {
    kind: "invalid",
    message: boundText(`Field ${quote(context.fieldId)} ${message}`, 400),
  };
}

function matchesStringFormat(value: string, format: string): boolean {
  if (format === "email") {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
  }
  if (format === "uri") {
    try {
      return Boolean(new URL(value).protocol);
    } catch {
      return false;
    }
  }
  if (format === "date") {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
      return false;
    }
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.valueOf()) && date.toISOString().startsWith(value);
  }
  return /^\d{4}-\d{2}-\d{2}T/u.test(value) && !Number.isNaN(Date.parse(value));
}

function findChoice(choices: readonly Choice[], raw: string | undefined): Choice | undefined {
  const value = raw?.trim().toLowerCase();
  return choices.find(
    (choice) => choice.label.toLowerCase() === value || choice.value.toLowerCase() === value,
  );
}

function displayDefault(value: StructuredInputAnswerValue): string {
  return boundText(Array.isArray(value) ? value.join(", ") : String(value), 80);
}
