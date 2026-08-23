import { truncateUtf16Safe } from "../../utils.js";
import {
  boundStructuredInputText as boundText,
  hasUnsafeVisibleCharacters,
  isStructuredInputRecord,
  quoteStructuredInputValue as quote,
  readStructuredInputText,
  snapshotStructuredInput,
  structuredInputEntries,
  structuredInputRecord as ownRecord,
  structuredInputString as ownString,
  structuredInputValue as ownValue,
} from "./structured-input-boundary.js";
import type {
  StructuredInputCompileResult,
  StructuredInputCompilerOptions,
  StructuredInputField,
  StructuredInputRecord,
  StructuredInputValue,
} from "./structured-input-boundary.js";
import { compileStructuredInputField } from "./structured-input-schema.js";
import type { AgentHarnessUserInputQuestion } from "./user-input-bridge.js";

const MAX_FORM_FIELDS = 12;
const MAX_SCHEMA_KEYS = 24;
const MAX_FIELD_NAME = 256;
const MAX_MESSAGE_TEXT = 1_024;
const MAX_URL_TEXT = 2_048;
const MAX_URL_QUESTION_TEXT = 3_200;

export { isStructuredInputRecord, snapshotStructuredInput };
export type {
  StructuredInputAnswerValue,
  StructuredInputCompileResult,
  StructuredInputField,
  StructuredInputRecord,
  StructuredInputValue,
} from "./structured-input-boundary.js";

type FieldMetadata = {
  secret: boolean;
  otherAnswer: boolean;
  otherQuestionId?: string;
};

/** Wraps already bounded protocol questions in the shared execution plan. */
export function compileStructuredInputQuestions(params: {
  questions: readonly AgentHarnessUserInputQuestion[];
  intro: string;
}): StructuredInputCompileResult {
  const fields: StructuredInputField[] = params.questions.map((question) => ({
    question,
    decode: (values) =>
      values.length === 0
        ? { kind: "absent" }
        : {
            kind: "present",
            entries: [[question.id, question.multiSelect ? [...values] : (values[0] ?? "")]],
          },
  }));
  return { kind: "ready", plan: { kind: "form", intro: params.intro, fields } };
}

/** Compiles a bounded object schema into Gateway questions plus answer decoders. */
export function compileStructuredInputForm(params: {
  schema: unknown;
  message: string | undefined;
  fallbackMessage: string;
  options: StructuredInputCompilerOptions;
}): StructuredInputCompileResult {
  const { options } = params;
  const protocol = options.protocolName;
  const schema = isStructuredInputRecord(params.schema) ? params.schema : undefined;
  const properties = schema ? ownRecord(schema, "properties") : undefined;
  if (!schema || ownString(schema, "type") !== "object" || !properties) {
    return unsupported(
      `OpenClaw cannot show this ${protocol} form because its schema is not an object with properties.`,
    );
  }
  if (!structuredInputEntries(schema, MAX_SCHEMA_KEYS)) {
    return unsupported(`OpenClaw declined an over-limit ${protocol} form schema.`);
  }
  const propertyEntries = structuredInputEntries(properties, MAX_FORM_FIELDS);
  if (!propertyEntries) {
    return unsupported(
      `OpenClaw supports at most ${MAX_FORM_FIELDS} fields in one ${protocol} form.`,
    );
  }
  if (propertyEntries.length === 0 && options.allowEmptyForm !== true) {
    return unsupported(`OpenClaw cannot show an empty ${protocol} form.`);
  }
  const required = readRequired(schema, properties, protocol);
  if (typeof required === "string") {
    return unsupported(required);
  }
  const intro = readStructuredInputText(params.message ?? params.fallbackMessage, MAX_MESSAGE_TEXT);
  if (!intro) {
    return unsupported(
      `OpenClaw declined ${protocol} form display text that is invalid or over-limit.`,
    );
  }

  const metadata = new Map<string, FieldMetadata>();
  const otherFields = new Map<string, { fieldId: string; secret: boolean }>();
  for (const [fieldId, rawSchema] of propertyEntries) {
    if (!validFieldName(fieldId) || !isStructuredInputRecord(rawSchema)) {
      return unsupported(`${protocol} form field ${quote(fieldId)} has an invalid schema.`);
    }
    const fieldMetadata = readFieldMetadata(rawSchema, options.metadata);
    if (typeof fieldMetadata === "string") {
      return unsupported(`${protocol} form field ${quote(fieldId)} ${fieldMetadata}`);
    }
    metadata.set(fieldId, fieldMetadata);
    if (fieldMetadata.otherAnswer) {
      const target = fieldMetadata.otherQuestionId;
      if (!target || otherFields.has(target)) {
        return unsupported(`OpenClaw declined invalid ${protocol} Other-field metadata.`);
      }
      otherFields.set(target, { fieldId, secret: fieldMetadata.secret });
    }
  }
  for (const target of otherFields.keys()) {
    if (!Object.hasOwn(properties, target)) {
      return unsupported(`OpenClaw declined ${protocol} Other-field metadata without its target.`);
    }
  }

  const usedQuestionIds = new Set<string>();
  const fields: StructuredInputField[] = [];
  for (const [fieldId, rawSchema] of propertyEntries) {
    const fieldMetadata = metadata.get(fieldId)!;
    if (fieldMetadata.otherAnswer) {
      continue;
    }
    if (!isStructuredInputRecord(rawSchema)) {
      return unsupported(`${protocol} form field ${quote(fieldId)} has an invalid schema.`);
    }
    const other = otherFields.get(fieldId);
    const field = compileStructuredInputField(
      {
        fieldId,
        questionId: normalizeQuestionId(fieldId, usedQuestionIds),
        required: required.has(fieldId),
        secret: fieldMetadata.secret || other?.secret === true,
        otherFieldId: other?.fieldId,
      },
      rawSchema,
      options,
    );
    if (typeof field === "string") {
      return unsupported(`${protocol} form field ${quote(fieldId)} ${field}`);
    }
    fields.push(field);
  }
  if (fields.length === 0 && propertyEntries.length > 0) {
    return unsupported(`OpenClaw cannot show a ${protocol} form containing only synthetic fields.`);
  }
  return { kind: "ready", plan: { kind: "form", intro, fields } };
}

/** Compiles a literal, non-fetching HTTP(S) confirmation question. */
export function compileStructuredInputUrl(params: {
  url: unknown;
  elicitationId: unknown;
  message: unknown;
  fallbackMessage: string;
  protocolName: string;
}): StructuredInputCompileResult {
  const url = typeof params.url === "string" ? params.url : undefined;
  const elicitationId = readStructuredInputText(params.elicitationId, MAX_FIELD_NAME);
  const message = readStructuredInputText(
    typeof params.message === "string" ? params.message : params.fallbackMessage,
    MAX_MESSAGE_TEXT,
  );
  if (
    !url ||
    url.length > MAX_URL_TEXT ||
    url.trim() !== url ||
    hasUnsafeVisibleCharacters(url) ||
    !elicitationId ||
    !message
  ) {
    return unsupported(
      `OpenClaw declined an invalid or over-limit ${params.protocolName} elicitation URL.`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return unsupported(`OpenClaw declined an invalid ${params.protocolName} elicitation URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return unsupported(
      `OpenClaw only presents http or https ${params.protocolName} elicitation URLs.`,
    );
  }
  if (parsed.username || parsed.password) {
    return unsupported(
      `OpenClaw does not present ${params.protocolName} elicitation URLs containing credentials.`,
    );
  }
  return {
    kind: "ready",
    plan: {
      kind: "url",
      question: {
        id: "continue",
        header: "Continue",
        question: boundText(
          `${message}\n\n${url}\n\nContinue with this URL?`,
          MAX_URL_QUESTION_TEXT,
        ),
        isOther: false,
        isSecret: false,
        options: [{ label: "Continue" }, { label: "Decline" }],
      },
    },
  };
}

function readRequired(
  schema: StructuredInputRecord,
  properties: StructuredInputRecord,
  protocol: string,
): Set<string> | string {
  const value = ownValue(schema, "required");
  if (value === undefined || value === null) {
    return new Set();
  }
  if (!Array.isArray(value) || value.length > MAX_FORM_FIELDS) {
    return `OpenClaw declined a ${protocol} form with an invalid required list.`;
  }
  const required = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || !Object.hasOwn(properties, entry)) {
      return `OpenClaw declined a ${protocol} form with an invalid required field.`;
    }
    required.add(entry);
  }
  return required;
}

function readFieldMetadata(
  schema: StructuredInputRecord,
  policy: StructuredInputCompilerOptions["metadata"],
): FieldMetadata | string {
  const secret = readMetadataValue(schema, policy?.secretPath);
  const otherAnswer = readMetadataValue(schema, policy?.otherAnswerPath);
  const otherQuestionId = readMetadataValue(schema, policy?.otherQuestionIdPath);
  if (secret !== undefined && typeof secret !== "boolean") {
    return "has invalid secret metadata.";
  }
  if (otherAnswer !== undefined && typeof otherAnswer !== "boolean") {
    return "has invalid Other-field metadata.";
  }
  if (
    otherQuestionId !== undefined &&
    (typeof otherQuestionId !== "string" || !validFieldName(otherQuestionId))
  ) {
    return "has an invalid Other-field target.";
  }
  return {
    secret: secret === true,
    otherAnswer: otherAnswer === true,
    ...(typeof otherQuestionId === "string" ? { otherQuestionId } : {}),
  };
}

function readMetadataValue(
  record: StructuredInputRecord,
  path: readonly string[] | undefined,
): StructuredInputValue | undefined {
  if (!path || path.length === 0) {
    return undefined;
  }
  let current: StructuredInputValue = record;
  for (const key of path) {
    if (!isStructuredInputRecord(current)) {
      return undefined;
    }
    const value = ownValue(current, key);
    if (value === undefined) {
      return undefined;
    }
    current = value;
  }
  return current;
}

function normalizeQuestionId(value: string, used: Set<string>): string {
  const normalized = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  const stem =
    boundText(/^[a-z]/u.test(normalized) ? normalized : `field_${normalized}`, 48) || "field";
  let candidate = stem;
  let suffix = 2;
  while (used.has(candidate)) {
    const tail = `_${suffix}`;
    candidate = `${truncateUtf16Safe(stem, 48 - tail.length)}${tail}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function validFieldName(value: string): boolean {
  return Boolean(value) && value.length <= MAX_FIELD_NAME && !hasUnsafeVisibleCharacters(value);
}

function unsupported(message: string): StructuredInputCompileResult {
  return { kind: "unsupported", message: boundText(message, 400) };
}
