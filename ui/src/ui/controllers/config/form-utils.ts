import JSON5 from "json5";

export function cloneConfigObject<T>(value: T): T {
  return structuredClone(value);
}

export function serializeConfigForm(form: Record<string, unknown>): string {
  return `${JSON.stringify(form, null, 2).trimEnd()}\n`;
}

const REDACTED_SENTINEL = "__OPENCLAW_REDACTED__";
type SanitizeResult = { omitted: true } | { omitted: false; value: unknown };

const OMIT_VALUE: SanitizeResult = { omitted: true };

function keepValue(value: unknown): SanitizeResult {
  return { omitted: false, value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOwnRecordValue(record: Record<string, unknown> | null, key: string): boolean {
  return record != null && Object.prototype.hasOwnProperty.call(record, key);
}

function sanitizeRedactedValue(params: {
  value: unknown;
  originalFormValue: unknown;
  originalRawValue: unknown;
  originalRawPathExists: boolean;
  canOmit: boolean;
}): SanitizeResult {
  if (params.value === REDACTED_SENTINEL) {
    if (params.originalFormValue !== REDACTED_SENTINEL) {
      return keepValue(params.value);
    }
    if (params.originalRawPathExists) {
      return keepValue(params.value);
    }
    return params.canOmit ? OMIT_VALUE : keepValue(params.value);
  }

  if (Array.isArray(params.value)) {
    const originalFormItems = Array.isArray(params.originalFormValue)
      ? params.originalFormValue
      : [];
    const originalRawItems = Array.isArray(params.originalRawValue) ? params.originalRawValue : [];
    return keepValue(
      params.value.map((item, index) => {
        const sanitized = sanitizeRedactedValue({
          value: item,
          originalFormValue: originalFormItems[index],
          originalRawValue: originalRawItems[index],
          originalRawPathExists: index in originalRawItems,
          canOmit: false,
        });
        return sanitized.omitted ? item : sanitized.value;
      }),
    );
  }

  if (!isRecord(params.value)) {
    return keepValue(params.value);
  }

  const originalFormRecord = isRecord(params.originalFormValue) ? params.originalFormValue : null;
  const originalRawRecord = isRecord(params.originalRawValue) ? params.originalRawValue : null;
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(params.value)) {
    const originalFormValue =
      originalFormRecord != null && Object.prototype.hasOwnProperty.call(originalFormRecord, key)
        ? originalFormRecord[key]
        : undefined;
    const originalRawPathExists = hasOwnRecordValue(originalRawRecord, key);
    const sanitized = sanitizeRedactedValue({
      value: item,
      originalFormValue,
      originalRawValue: originalRawPathExists ? originalRawRecord?.[key] : undefined,
      originalRawPathExists,
      canOmit: true,
    });
    if (!sanitized.omitted) {
      next[key] = sanitized.value;
    }
  }

  if (params.canOmit && Object.keys(next).length === 0 && !params.originalRawPathExists) {
    return OMIT_VALUE;
  }
  return keepValue(next);
}

export function sanitizeRedactedFormForSubmit(
  form: Record<string, unknown>,
  originalForm: Record<string, unknown> | null | undefined,
  originalRaw: string,
): Record<string, unknown> {
  if (!originalForm || !originalRaw) {
    return form;
  }

  let parsedOriginalRaw: unknown;
  try {
    parsedOriginalRaw = JSON5.parse(originalRaw);
  } catch {
    return form;
  }
  if (!isRecord(parsedOriginalRaw)) {
    return form;
  }

  const sanitized = sanitizeRedactedValue({
    value: form,
    originalFormValue: originalForm,
    originalRawValue: parsedOriginalRaw,
    originalRawPathExists: true,
    canOmit: false,
  });
  return !sanitized.omitted && isRecord(sanitized.value) ? sanitized.value : form;
}

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function isForbiddenKey(key: string | number): boolean {
  return typeof key === "string" && FORBIDDEN_KEYS.has(key);
}

type PathContainer = {
  current: Record<string, unknown> | unknown[];
  lastKey: string | number;
};

function resolvePathContainer(
  obj: Record<string, unknown> | unknown[],
  path: Array<string | number>,
  createMissing: boolean,
): PathContainer | null {
  if (path.length === 0 || path.some(isForbiddenKey)) {
    return null;
  }

  let current: Record<string, unknown> | unknown[] = obj;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i];
    const nextKey = path[i + 1];
    if (typeof key === "number") {
      if (!Array.isArray(current)) {
        return null;
      }
      if (current[key] == null) {
        if (!createMissing) {
          return null;
        }
        current[key] = typeof nextKey === "number" ? [] : ({} as Record<string, unknown>);
      }
      current = current[key] as Record<string, unknown> | unknown[];
      continue;
    }

    if (typeof current !== "object" || current == null) {
      return null;
    }
    const record = current as Record<string, unknown>;
    if (record[key] == null) {
      if (!createMissing) {
        return null;
      }
      record[key] = typeof nextKey === "number" ? [] : ({} as Record<string, unknown>);
    }
    current = record[key] as Record<string, unknown> | unknown[];
  }

  return {
    current,
    lastKey: path[path.length - 1],
  };
}

export function setPathValue(
  obj: Record<string, unknown> | unknown[],
  path: Array<string | number>,
  value: unknown,
) {
  const container = resolvePathContainer(obj, path, true);
  if (!container) {
    return;
  }

  if (typeof container.lastKey === "number") {
    if (Array.isArray(container.current)) {
      container.current[container.lastKey] = value;
    }
    return;
  }
  if (typeof container.current === "object" && container.current != null) {
    (container.current as Record<string, unknown>)[container.lastKey] = value;
  }
}

export function removePathValue(
  obj: Record<string, unknown> | unknown[],
  path: Array<string | number>,
) {
  const container = resolvePathContainer(obj, path, false);
  if (!container) {
    return;
  }

  if (typeof container.lastKey === "number") {
    if (Array.isArray(container.current)) {
      container.current.splice(container.lastKey, 1);
    }
    return;
  }
  if (typeof container.current === "object" && container.current != null) {
    delete (container.current as Record<string, unknown>)[container.lastKey];
  }
}
