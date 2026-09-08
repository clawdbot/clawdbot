import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeStringEntries,
  uniqueStrings,
} from "@openclaw/normalization-core/string-normalization";
import { levenshteinDistance } from "../shared/levenshtein-distance.js";
import { resolveAgentToolExecutionSchema } from "./agent-tool-availability.js";
import { compactToolInputHint } from "./tool-schema-hints.js";
import type {
  ToolSearchCatalogEntry,
  ToolSearchToolContext,
  UnknownToolErrorOptions,
} from "./tool-search-types.js";

function tokenizeLookupValue(input: string): Set<string> {
  return new Set(normalizeStringEntries(input.toLowerCase().split(/[^a-z0-9]+/u)));
}

function scoreUnknownToolSuggestion(needle: string, entry: ToolSearchCatalogEntry): number {
  const normalizedNeedle = needle.toLowerCase();
  const name = entry.name.toLowerCase();
  const id = entry.id.toLowerCase();
  const label = (entry.label ?? "").toLowerCase();
  const description = entry.description.toLowerCase();
  const needleTokens = tokenizeLookupValue(needle);
  const entryTokens = tokenizeLookupValue(
    `${entry.name} ${entry.id} ${entry.label ?? ""} ${entry.description}`,
  );
  let score = 0;
  if ((name && normalizedNeedle.includes(name)) || id.includes(normalizedNeedle)) {
    score += 40;
  }
  if (name && needleTokens.has(name)) {
    score += 40;
  }
  for (const token of needleTokens) {
    if (entryTokens.has(token)) {
      score += 12;
    }
  }
  if (label.includes(normalizedNeedle) || description.includes(normalizedNeedle)) {
    score += 8;
  }
  return score;
}

export type ToolLookupErrorOptions = UnknownToolErrorOptions &
  Pick<ToolSearchToolContext, "codeModeSkills">;

export function formatUnknownToolIdError(
  needle: string,
  entries: readonly ToolSearchCatalogEntry[],
  options: ToolLookupErrorOptions = {},
): string {
  const skill = options.codeModeSkills?.find((candidate) => candidate.name === needle);
  const canReadSkills = entries.some(
    (entry) => entry.source === "openclaw" && entry.sourceName === "core" && entry.name === "read",
  );
  if (skill && canReadSkills) {
    // Use admitted, mapped prompt locations; never load a skill as a side effect of recovery.
    const quotedLocation = JSON.stringify(skill.location);
    const location = quotedLocation.length <= 1_024 ? quotedLocation : "its listed location";
    return `This id names a skill, not a callable tool. Load its complete instructions from ${location} using the skill-loading guidance in your system prompt.`;
  }
  const nameCounts = new Map<string, number>();
  for (const entry of entries) {
    nameCounts.set(entry.name, (nameCounts.get(entry.name) ?? 0) + 1);
  }
  const suggestions = uniqueStrings(
    entries
      .map((entry) => ({
        value: options.exactIdOnly || (nameCounts.get(entry.name) ?? 0) > 1 ? entry.id : entry.name,
        score: scoreUnknownToolSuggestion(needle, entry),
      }))
      .filter((candidate) => candidate.score > 0)
      .toSorted((a, b) => b.score - a.score || a.value.localeCompare(b.value))
      .map((candidate) => candidate.value),
  ).slice(0, 3);
  const recoveryText =
    options.recoverySurface === "code-mode"
      ? "Use openclaw.tools.search to find a tool, openclaw.tools.describe to inspect it, then openclaw.tools.call with the exact id or name."
      : options.recoverySurface === "catalog"
        ? "Use catalog.search to find a callable tool handle, then call the handle or use its describe method."
        : "Use tool_search to find a tool, tool_describe to inspect it, then tool_call with the exact id or name.";
  if (suggestions.length === 0) {
    return `Unknown tool id: ${needle}. ${recoveryText}`;
  }
  return `Unknown tool id: ${needle}. Did you mean: ${suggestions.join(", ")}? ${recoveryText}`;
}

export function formatCatalogInputError(
  entry: ToolSearchCatalogEntry,
  errors: import("../plugins/schema-validator.js").JsonSchemaValidationError[],
  value: unknown,
): string {
  const executionSchema = resolveAgentToolExecutionSchema(entry.tool, entry.parameters);
  const schema = isRecord(executionSchema) ? executionSchema : undefined;
  const propertyNames = isRecord(schema?.properties) ? Object.keys(schema.properties) : [];
  const knownProperties = new Set(propertyNames);
  const unexpectedProperties =
    schema?.additionalProperties === false && isRecord(value)
      ? Object.keys(value).filter((name) => !knownProperties.has(name))
      : errors.flatMap((error) => (error.additionalProperty ? [error.additionalProperty] : []));
  const suggestions = uniqueStrings(
    unexpectedProperties.flatMap((unexpected) => {
      const nearest = propertyNames
        .map((name) => ({ name, distance: levenshteinDistance(unexpected, name) }))
        .filter(
          ({ distance }) => distance <= Math.min(3, Math.max(1, Math.ceil(unexpected.length / 3))),
        )
        .toSorted(
          (left, right) => left.distance - right.distance || left.name.localeCompare(right.name),
        )[0];
      return nearest ? [nearest.name] : [];
    }),
  ).slice(0, 3);
  const details = errors.map((error) => error.text).join("; ");
  const hint = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}?` : "";
  const input = compactToolInputHint(schema);
  const signature = input === "unknown" ? "" : ` Expected input: ${input}.`;
  return `Invalid arguments for tool "${entry.id}": ${details}.${hint}${signature}`;
}
