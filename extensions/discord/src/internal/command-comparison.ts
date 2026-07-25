const unorderedCommandArrayFields = new Set(["channel_types", "contexts", "integration_types"]);
const optionComparisonOmittedFields = new Set([
  "contexts",
  "default_member_permissions",
  "description_localized",
  "integration_types",
  "name_localized",
]);
const nullableLocalizationFields = new Set(["description_localizations", "name_localizations"]);

function comparableCommand(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }
  const omit = new Set([
    "application_id",
    "description_localized",
    "dm_permission",
    "guild_id",
    "id",
    "name_localized",
    "nsfw",
    "version",
    "default_permission",
  ]);
  return stableComparableObject(
    Object.fromEntries(
      Object.entries(value).filter(([key, entry]) => !omit.has(key) && entry !== undefined),
    ),
  );
}

export function stableComparableObject(value: unknown, pathValue: string[] = []): unknown {
  if (Array.isArray(value)) {
    const normalized = value.map((entry) => stableComparableObject(entry, pathValue));
    const key = pathValue.at(-1);
    if (
      key &&
      unorderedCommandArrayFields.has(key) &&
      normalized.every(
        (entry) =>
          typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean",
      )
    ) {
      return normalized.toSorted((left, right) => String(left).localeCompare(String(right)));
    }
    return normalized;
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key, entry]) => {
        if (entry === undefined) {
          return false;
        }
        if (entry === null && nullableLocalizationFields.has(key)) {
          return false;
        }
        if (pathValue.includes("options") && optionComparisonOmittedFields.has(key)) {
          return false;
        }
        if ((key === "required" || key === "autocomplete") && entry === false) {
          return false;
        }
        return true;
      })
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [
        key,
        shouldNormalizeDescriptionValue(pathValue, key, entry)
          ? normalizeDescriptionForComparison(entry)
          : stableComparableObject(entry, [...pathValue, key]),
      ]),
  );
}

function shouldNormalizeDescriptionValue(
  pathLocal: string[],
  key: string,
  entry: unknown,
): entry is string {
  return (
    typeof entry === "string" &&
    (key === "description" || pathLocal.at(-1) === "description_localizations")
  );
}

/**
 * Normalize descriptions to match Discord's server-side storage semantics.
 * Discord collapses whitespace and removes whitespace between CJK characters.
 */
function normalizeDescriptionForComparison(description: string): string {
  const collapsed = description.replace(/\s+/g, " ");
  const cjkBoundaryWhitespace =
    /([\u3000-\u303F\u4E00-\u9FFF\uFF00-\uFFEF])\s+([\u3000-\u303F\u4E00-\u9FFF\uFF00-\uFFEF])/g;
  return collapsed
    .replace(cjkBoundaryWhitespace, "$1$2")
    .replace(cjkBoundaryWhitespace, "$1$2")
    .trim();
}

export function commandsEqual(a: unknown, b: unknown) {
  return JSON.stringify(comparableCommand(a)) === JSON.stringify(comparableCommand(b));
}
