const INTERNAL_PROTOCOL_FIELD = "x-openclaw-internal";

/**
 * Schema-specific record guard matching `@openclaw/normalization-core/record-coerce`.
 *
 * Deliberately inlined rather than imported: `gateway-protocol` does not
 * otherwise depend on `normalization-core`, and adding that package edge is a
 * dependency-graph change that upstream's `dependency-guard` CI job blocks
 * without a secops override. The predicate is a three-line pure type guard with
 * no dependencies of its own, so duplicating it is far cheaper than carrying an
 * unmergeable manifest edit. Keep this in sync with the canonical definition.
 */
function isProtocolSchemaRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function internalProtocolField<T extends object>(schema: T): T {
  Object.defineProperty(schema, INTERNAL_PROTOCOL_FIELD, {
    value: true,
    enumerable: false,
  });
  return schema;
}

function isInternalProtocolField(schema: unknown): boolean {
  return isProtocolSchemaRecord(schema) && schema[INTERNAL_PROTOCOL_FIELD] === true;
}

type StripResult = {
  value: unknown;
  changed: boolean;
  removed: boolean;
};

function cloneSchemaNode(value: unknown): StripResult {
  if (Array.isArray(value)) {
    let changed = false;
    const cloned: unknown[] = [];
    for (const entry of value) {
      const result = cloneSchemaNode(entry);
      if (result.removed) {
        changed = true;
        continue;
      }
      changed ||= result.changed;
      cloned.push(result.value);
    }
    return { value: changed ? cloned : value, changed, removed: false };
  }
  if (!isProtocolSchemaRecord(value)) {
    return { value, changed: false, removed: false };
  }
  if (isInternalProtocolField(value)) {
    return { value: undefined, changed: true, removed: true };
  }

  const removedProperties = new Set<string>();
  const properties = value.properties;
  let clonedProperties: Record<string, unknown> | undefined;
  let propertiesChanged = false;
  if (isProtocolSchemaRecord(properties)) {
    clonedProperties = {};
    for (const [name, propertySchema] of Object.entries(properties)) {
      if (isInternalProtocolField(propertySchema)) {
        removedProperties.add(name);
        propertiesChanged = true;
        continue;
      }
      const result = cloneSchemaNode(propertySchema);
      if (result.removed) {
        removedProperties.add(name);
        propertiesChanged = true;
        continue;
      }
      propertiesChanged ||= result.changed;
      clonedProperties[name] = result.value;
    }
  }

  let otherFieldsChanged = false;
  const cloned: Record<string, unknown> = {};
  if (isProtocolSchemaRecord(properties)) {
    cloned.properties = propertiesChanged ? clonedProperties : properties;
  }
  for (const [key, raw] of Object.entries(value)) {
    if (key === "properties" || key === INTERNAL_PROTOCOL_FIELD) {
      continue;
    }
    if (key === "required" && Array.isArray(raw)) {
      if (removedProperties.size > 0) {
        const required = raw.filter(
          (entry): entry is string => typeof entry === "string" && !removedProperties.has(entry),
        );
        otherFieldsChanged ||= required.length !== raw.length;
        cloned.required = required;
      } else {
        cloned.required = raw;
      }
      continue;
    }
    const result = cloneSchemaNode(raw);
    if (result.removed) {
      otherFieldsChanged = true;
      continue;
    }
    otherFieldsChanged ||= result.changed;
    cloned[key] = result.value;
  }

  const changed = propertiesChanged || otherFieldsChanged;
  return { value: changed ? cloned : value, changed, removed: false };
}

export function stripInternalProtocolFields<T>(schema: T): T | undefined {
  const result = cloneSchemaNode(schema);
  // SAFETY: cloneSchemaNode recursively rebuilds the exact input shape (minus internal-only fields), so a non-removed result.value always matches the original generic T.
  return result.removed ? undefined : (result.value as T);
}
