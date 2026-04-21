type JsonSchemaObject = {
  type?: string | string[];
  properties?: Record<string, JsonSchemaObject>;
  additionalProperties?: JsonSchemaObject | boolean;
  items?: JsonSchemaObject | JsonSchemaObject[];
  anyOf?: JsonSchemaObject[];
  allOf?: JsonSchemaObject[];
  oneOf?: JsonSchemaObject[];
};

export function cloneSchema<T>(value: T): T {
  return structuredClone(value);
}

export function asSchemaObject(value: unknown): object | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value;
}

export function schemaHasChildren(schema: JsonSchemaObject): boolean {
  if (schema.properties && Object.keys(schema.properties).length > 0) {
    return true;
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    return true;
  }
  if (Array.isArray(schema.items)) {
    return schema.items.some((entry) => typeof entry === "object" && entry !== null);
  }
  for (const branch of [schema.oneOf, schema.anyOf, schema.allOf]) {
    if (branch?.some((entry) => entry && typeof entry === "object" && schemaHasChildren(entry))) {
      return true;
    }
  }
  return Boolean(schema.items && typeof schema.items === "object");
}

export function findWildcardHintMatch<T>(params: {
  uiHints: Record<string, T>;
  path: string;
  splitPath: (path: string) => string[];
}): { path: string; hint: T } | null {
  const targetParts = params.splitPath(params.path);
  let bestMatch:
    | {
        path: string;
        hint: T;
        wildcardCount: number;
      }
    | undefined;

  for (const [hintPath, hint] of Object.entries(params.uiHints)) {
    const hintParts = params.splitPath(hintPath);
    if (hintParts.length !== targetParts.length) {
      continue;
    }

    let wildcardCount = 0;
    let matches = true;
    for (let index = 0; index < hintParts.length; index += 1) {
      const hintPart = hintParts[index];
      const targetPart = targetParts[index];
      if (hintPart === targetPart) {
        continue;
      }
      if (hintPart === "*") {
        wildcardCount += 1;
        continue;
      }
      matches = false;
      break;
    }

    if (!matches) {
      continue;
    }
    if (!bestMatch || wildcardCount < bestMatch.wildcardCount) {
      bestMatch = { path: hintPath, hint, wildcardCount };
    }
  }

  return bestMatch ? { path: bestMatch.path, hint: bestMatch.hint } : null;
}
