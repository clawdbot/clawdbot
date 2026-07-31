// Shared validation for plugin-owned keyed JSON and blob stores.
const MAX_PLUGIN_STORE_NAMESPACE_BYTES = 128;
const MAX_PLUGIN_STORE_KEY_BYTES = 512;
const MAX_PLUGIN_STORE_JSON_BYTES = 65_536;
const MAX_PLUGIN_STORE_JSON_DEPTH = 64;

const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9._-]*$/iu;
const textEncoder = new TextEncoder();

type PluginStoreValidationErrors = {
  invalid(message: string): Error;
  limit(message: string): Error;
};

function assertMaxUtf8Bytes(params: {
  label: string;
  value: string;
  maxBytes: number;
  errors: PluginStoreValidationErrors;
}): void {
  if (textEncoder.encode(params.value).byteLength > params.maxBytes) {
    throw params.errors.invalid(`${params.label} must be <= ${params.maxBytes} bytes`);
  }
}

export function validatePluginStoreNamespace(params: {
  value: string;
  label: string;
  errors: PluginStoreValidationErrors;
}): string {
  const trimmed = params.value.trim();
  if (!NAMESPACE_PATTERN.test(trimmed)) {
    throw params.errors.invalid(
      `${params.label} namespace must be a safe path segment: ${params.value}`,
    );
  }
  assertMaxUtf8Bytes({
    label: `${params.label} namespace`,
    value: trimmed,
    maxBytes: MAX_PLUGIN_STORE_NAMESPACE_BYTES,
    errors: params.errors,
  });
  return trimmed;
}

export function validatePluginStoreKey(params: {
  value: string;
  label: string;
  errors: PluginStoreValidationErrors;
}): string {
  const trimmed = params.value.trim();
  if (!trimmed) {
    throw params.errors.invalid(`${params.label} entry key must not be empty`);
  }
  assertMaxUtf8Bytes({
    label: `${params.label} entry key`,
    value: trimmed,
    maxBytes: MAX_PLUGIN_STORE_KEY_BYTES,
    errors: params.errors,
  });
  return trimmed;
}

export function validatePluginStorePositiveInteger(params: {
  value: number;
  label: string;
  errors: PluginStoreValidationErrors;
}): number {
  if (!Number.isSafeInteger(params.value) || params.value < 1) {
    throw params.errors.invalid(`${params.label} must be a positive safe integer`);
  }
  return params.value;
}

export function validateOptionalPluginStoreTtlMs(params: {
  value: number | undefined;
  label: string;
  errors: PluginStoreValidationErrors;
}): number | undefined {
  const value = params.value;
  if (value == null) {
    return undefined;
  }
  return validatePluginStorePositiveInteger({ ...params, value });
}

function assertPlainJsonValue(
  value: unknown,
  params: {
    label: string;
    errors: PluginStoreValidationErrors;
    seen: WeakSet<object>;
    path: string;
    depth: number;
  },
): void {
  if (params.depth > MAX_PLUGIN_STORE_JSON_DEPTH) {
    throw params.errors.limit(
      `${params.label} nesting exceeds maximum depth of ${MAX_PLUGIN_STORE_JSON_DEPTH}`,
    );
  }
  if (value === null) {
    return;
  }
  const valueType = typeof value;
  if (valueType === "string" || valueType === "boolean") {
    return;
  }
  if (valueType === "number") {
    if (!Number.isFinite(value)) {
      throw params.errors.invalid(`${params.label} at ${params.path} must be a finite number`);
    }
    return;
  }
  if (valueType !== "object") {
    throw params.errors.invalid(`${params.label} at ${params.path} must be JSON-serializable`);
  }

  const objectValue = value as object;
  if (params.seen.has(objectValue)) {
    throw params.errors.invalid(
      `${params.label} at ${params.path} must not contain circular references`,
    );
  }
  params.seen.add(objectValue);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) {
          throw params.errors.invalid(`${params.label} array at ${params.path} must not be sparse`);
        }
        assertPlainJsonValue(value[index], {
          ...params,
          path: `${params.path}[${index}]`,
          depth: params.depth + 1,
        });
      }
      return;
    }

    if (Object.getPrototypeOf(objectValue) !== Object.prototype) {
      throw params.errors.invalid(
        `${params.label} object at ${params.path} must be a plain object`,
      );
    }
    const descriptorEntries = Object.entries(Object.getOwnPropertyDescriptors(objectValue));
    if (Object.getOwnPropertySymbols(objectValue).length > 0) {
      throw params.errors.invalid(
        `${params.label} object at ${params.path} must not use symbol keys`,
      );
    }
    if (descriptorEntries.length !== Object.keys(objectValue).length) {
      throw params.errors.invalid(
        `${params.label} object at ${params.path} must not use non-enumerable properties`,
      );
    }
    for (const [key, descriptor] of descriptorEntries) {
      if (descriptor.get || descriptor.set || !("value" in descriptor)) {
        throw params.errors.invalid(
          `${params.label} object at ${params.path}.${key} must use data properties`,
        );
      }
      assertPlainJsonValue(descriptor.value, {
        ...params,
        path: `${params.path}.${key}`,
        depth: params.depth + 1,
      });
    }
  } finally {
    params.seen.delete(objectValue);
  }
}

export function serializePluginStoreJson(params: {
  value: unknown;
  label: string;
  errors: PluginStoreValidationErrors;
  maxBytes?: number;
}): string {
  assertPlainJsonValue(params.value, {
    label: params.label,
    errors: params.errors,
    seen: new WeakSet<object>(),
    path: "value",
    depth: 0,
  });
  const json = JSON.stringify(params.value);
  if (json === undefined) {
    throw params.errors.invalid(`${params.label} must be JSON-serializable`);
  }
  const maxBytes = params.maxBytes ?? MAX_PLUGIN_STORE_JSON_BYTES;
  if (textEncoder.encode(json).byteLength > maxBytes) {
    throw params.errors.limit(`${params.label} exceeds ${maxBytes} byte limit`);
  }
  return json;
}
