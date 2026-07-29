import type { ConfigUiHints } from "../../api/types.ts";
import { settingsSearchTextMatches, type SettingsSearchBlock } from "../../app-navigation.ts";
import { pathForMemoryTab } from "../../app-route-paths.ts";
import { SECTION_META } from "../../components/config-form.meta.ts";
import {
  matchesConfigSectionSearch,
  parseConfigSearchQuery,
} from "../../components/config-form.search.ts";
import { schemaType, type JsonSchema } from "../../components/config-form.shared.ts";
import { splitConfigSchemaByTier } from "../../components/config-form.tiers.ts";
import { t } from "../../i18n/index.ts";
import { configPageForSection } from "./config-sections.ts";
import {
  memoryVisibleSchemaKeys,
  resolveMemoryBackend,
  MEMORY_BACKEND_ANCHOR_ID,
  MEMORY_CURATED_SCHEMA_KEYS,
} from "./memory-schema.ts";
import { SETTINGS_SEARCH_TARGETS, type SettingsSearchTarget } from "./settings-targets.ts";

type StaticSettingsBlock = SettingsSearchBlock & {
  searchText: string;
};

const STATIC_SETTINGS_BLOCKS: readonly SettingsSearchTarget[] =
  Object.values(SETTINGS_SEARCH_TARGETS);

function resolveStaticSettingsBlock(block: SettingsSearchTarget): StaticSettingsBlock {
  const label = t(block.labelKey);
  return {
    routeId: block.routeId,
    ...(block.search === undefined ? {} : { search: block.search }),
    hash: block.hash,
    label,
    searchText: [label, ...block.searchKeys.map((key) => t(key)), block.aliases ?? ""].join(" "),
  };
}

/**
 * The Memory page hides `memory.*` children the current engine/backend makes
 * inapplicable — `memory.qmd` only renders once qmd is the selected backend.
 * Matching the raw section would offer a destination whose editor omits the very
 * field that matched, so search sees only what the page can show.
 */
function visibleMemorySchema(
  sectionSchema: JsonSchema,
  config: Record<string, unknown>,
): JsonSchema {
  const properties = sectionSchema.properties;
  if (!properties) {
    return sectionSchema;
  }
  const visible = new Set(memoryVisibleSchemaKeys(resolveMemoryBackend(config)));
  return {
    ...sectionSchema,
    properties: Object.fromEntries(
      Object.entries(properties).filter(([child]) => visible.has(child)),
    ),
  };
}

/**
 * Every memory schema field lives on Settings. Backend remains a curated row,
 * so its unique matches use that row's anchor instead of the editor section.
 */
function memoryDestination(params: {
  key: string;
  schema: JsonSchema;
  value: unknown;
  hints: ConfigUiHints;
  query: string;
  editorHash: string;
}): { hash: string } {
  const properties = params.schema.properties;
  if (!properties) {
    return { hash: params.editorHash };
  }
  const sliceMatches = (keys: readonly string[]) => {
    const sliced = Object.fromEntries(
      Object.entries(properties).filter(([child]) => keys.includes(child)),
    );
    return (
      Object.keys(sliced).length > 0 &&
      matchesConfigSectionSearch({
        key: params.key,
        schema: { ...params.schema, properties: sliced },
        value: params.value,
        hints: params.hints,
        query: params.query,
        textMatcher: settingsSearchTextMatches,
      })
    );
  };
  const onlySliceMatches = (keys: readonly string[]) =>
    sliceMatches(keys) &&
    !sliceMatches(Object.keys(properties).filter((child) => !keys.includes(child)));
  // memoryVisibleSchemaKeys drops `backend` when no engine renders the curated
  // row, so a match here always has the anchor on the page to scroll to.
  if (onlySliceMatches(MEMORY_CURATED_SCHEMA_KEYS)) {
    return { hash: `#${MEMORY_BACKEND_ANCHOR_ID}` };
  }
  return { hash: params.editorHash };
}

export function findSettingsSearchBlocks(params: {
  query: string;
  schema: unknown;
  value: Record<string, unknown> | null;
  uiHints: ConfigUiHints;
  identityAvailable?: boolean;
  basePath?: string;
}): SettingsSearchBlock[] {
  if (!params.query.trim()) {
    return [];
  }
  const criteria = parseConfigSearchQuery(params.query);
  const matches: SettingsSearchBlock[] =
    criteria.tags.length === 0 && criteria.text
      ? STATIC_SETTINGS_BLOCKS.filter(
          (block) => params.identityAvailable || !block.requiresIdentity,
        )
          .map(resolveStaticSettingsBlock)
          .filter((block) => settingsSearchTextMatches(block.searchText, criteria.text))
      : [];
  const schema =
    params.schema && typeof params.schema === "object" && !Array.isArray(params.schema)
      ? (params.schema as JsonSchema)
      : null;
  if (!schema || schemaType(schema) !== "object" || !schema.properties) {
    return matches;
  }
  const value = params.value ?? {};
  for (const [key, rawSectionSchema] of Object.entries(schema.properties)) {
    const routeId = configPageForSection(key);
    const sectionSchema =
      routeId === "memory" ? visibleMemorySchema(rawSectionSchema, value) : rawSectionSchema;
    const meta = SECTION_META[key];
    const tierSplit = splitConfigSchemaByTier({
      schema: sectionSchema,
      path: [key],
      hints: params.uiHints,
    });
    const matchesTier = (tierSchema: JsonSchema | null) =>
      Boolean(
        tierSchema &&
        matchesConfigSectionSearch({
          key,
          schema: tierSchema,
          value: value[key],
          hints: params.uiHints,
          query: params.query,
          label: meta?.label,
          description: meta?.description,
          textMatcher: settingsSearchTextMatches,
        }),
      );
    const matchesCommon = matchesTier(tierSplit.common);
    const matchesAdvanced = matchesTier(tierSplit.advanced);
    if (!matchesCommon && !matchesAdvanced) {
      continue;
    }
    const encodedKey = encodeURIComponent(key);
    const editorHash = `#config-section-${encodedKey}`;
    const destination =
      routeId === "memory"
        ? memoryDestination({
            key,
            schema: sectionSchema,
            value: value[key],
            hints: params.uiHints,
            query: params.query,
            editorHash,
          })
        : { search: "", hash: editorHash };
    matches.push(
      routeId === "memory"
        ? {
            routeId,
            label: meta?.label ?? sectionSchema.title ?? key,
            pathname: pathForMemoryTab("settings", params.basePath),
            hash: destination.hash,
          }
        : {
            routeId,
            label: meta?.label ?? sectionSchema.title ?? key,
            search: `?section=${encodedKey}${matchesAdvanced ? "&advanced=1" : ""}`,
            hash: destination.hash,
          },
    );
  }
  return matches;
}
