/** Moonshot flavored JSON schema requires `type` inside anyOf/oneOf/allOf branches. */

const SCHEMA_MAP_KEYS = new Set([
  "$defs",
  "definitions",
  "dependentSchemas",
  "patternProperties",
  "properties",
]);

const SCHEMA_CHILD_KEYS = new Set([
  "additionalItems",
  "additionalProperties",
  "contains",
  "else",
  "if",
  "items",
  "not",
  "prefixItems",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);

const COMBINATOR_KEYS = ["allOf", "anyOf", "oneOf"] as const;

function isSchemaRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasNonEmptyCombinator(node: Record<string, unknown>): boolean {
  return COMBINATOR_KEYS.some((key) => {
    const value = node[key];
    return Array.isArray(value) && value.length > 0;
  });
}

function cleanSchemaNode(node: unknown): unknown {
  if (Array.isArray(node)) {
    let changed = false;
    const entries = node.map((entry) => {
      const next = cleanSchemaNode(entry);
      changed ||= next !== entry;
      return next;
    });
    return changed ? entries : node;
  }
  if (!isSchemaRecord(node)) {
    return node;
  }

  let changed = false;
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    let next = value;
    if (SCHEMA_MAP_KEYS.has(key) && isSchemaRecord(value)) {
      let mapChanged = false;
      next = Object.fromEntries(
        Object.entries(value).map(([childKey, childValue]) => {
          const cleanedChild = cleanSchemaNode(childValue);
          mapChanged ||= cleanedChild !== childValue;
          return [childKey, cleanedChild];
        }),
      );
      if (!mapChanged) {
        next = value;
      }
    } else if (SCHEMA_CHILD_KEYS.has(key)) {
      next = cleanSchemaNode(value);
    } else if (
      COMBINATOR_KEYS.includes(key as (typeof COMBINATOR_KEYS)[number]) &&
      Array.isArray(value)
    ) {
      next = value.map((entry) => cleanSchemaNode(entry));
    }
    cleaned[key] = next;
    changed ||= next !== value;
  }

  // Moonshot rejects a `type` declared next to anyOf/oneOf/allOf; it must live
  // inside each branch instead. Distribute the parent `type` into branches that
  // lack their own, then drop it from the parent.
  if ("type" in cleaned && hasNonEmptyCombinator(cleaned)) {
    for (const key of COMBINATOR_KEYS) {
      const branches = cleaned[key];
      if (!Array.isArray(branches)) {
        continue;
      }
      const nextBranches: unknown[] = [];
      for (const branch of branches) {
        if (isSchemaRecord(branch) && !("type" in branch)) {
          nextBranches.push({ ...branch, type: cleaned.type });
        } else {
          nextBranches.push(branch);
        }
      }
      cleaned[key] = nextBranches;
    }
    delete cleaned.type;
    changed = true;
  }

  return changed ? cleaned : node;
}

/** Rewrites Moonshot-flavored schemas so every anyOf/oneOf/allOf branch declares its own `type`. */
export function cleanSchemaForMoonshot(schema: unknown): unknown {
  return cleanSchemaNode(schema);
}
