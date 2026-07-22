/**
 * Some model backends emit numeric MCP tool arguments as JSON strings (e.g. the
 * literal "10" instead of 10) even when the tool's own inputSchema types the
 * field as `number`/`integer`. OpenClaw forwards model-supplied arguments to the
 * MCP server verbatim, so the string reaches the wire and strict servers reject
 * the call -- Notion's data source API, for one, answers "Number values must be
 * JavaScript numbers" (#107648).
 *
 * `coerceMcpToolInputToSchema` narrows that gap conservatively: it converts a
 * string argument to a number ONLY when the tool's inputSchema declares the field
 * `number`/`integer` and the string is a faithful, finite representation of that
 * number (round-tripping through `String(...)`, and an exact integer where the
 * schema says `integer`). It never throws, never touches a non-numeric schema
 * type, and leaves already-correct arguments untouched -- so well-typed calls are
 * unaffected and only the exact reported failure mode is rescued.
 */

interface JsonSchemaLike {
  type?: unknown;
  properties?: unknown;
  items?: unknown;
}

function schemaTypeIncludes(type: unknown, wanted: string): boolean {
  if (type === wanted) return true;
  if (Array.isArray(type)) return type.includes(wanted);
  return false;
}

function coerceNumericString(value: string, integer: boolean): number | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return undefined;
  if (integer && !Number.isInteger(n)) return undefined;
  // Only coerce when the string is a faithful representation of the parsed
  // number, so values like "0x10", "1,000", "1e3", "10abc", or " 1 2 " are left
  // as-is rather than silently rewritten.
  if (String(n) !== trimmed) return undefined;
  return n;
}

function coerceValue(value: unknown, schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return value;
  const s = schema as JsonSchemaLike;

  if (typeof value === "string") {
    if (schemaTypeIncludes(s.type, "integer")) {
      const n = coerceNumericString(value, true);
      return n ?? value;
    }
    if (schemaTypeIncludes(s.type, "number")) {
      const n = coerceNumericString(value, false);
      return n ?? value;
    }
    return value;
  }

  if (Array.isArray(value) && s.items && typeof s.items === "object") {
    return value.map((item) => coerceValue(item, s.items));
  }

  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    s.properties &&
    typeof s.properties === "object"
  ) {
    const props = s.properties as Record<string, unknown>;
    const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    for (const [key, propSchema] of Object.entries(props)) {
      if (key in out) out[key] = coerceValue(out[key], propSchema);
    }
    return out;
  }

  return value;
}

export function coerceMcpToolInputToSchema(input: unknown, inputSchema: unknown): unknown {
  try {
    return coerceValue(input, inputSchema);
  } catch {
    return input;
  }
}
