import type { ConfigUiHints } from "../../api/types.ts";
import {
  isSettingsNavigationRouteVisible,
  settingsSearchTextMatches,
  type SettingsSearchBlock,
} from "../../app-navigation.ts";
import { pathForMemoryTab } from "../../app-route-paths.ts";
import { SECTION_META } from "../../components/config-form.meta.ts";
import {
  matchesConfigSectionSearch,
  parseConfigSearchQuery,
} from "../../components/config-form.search.ts";
import { splitConfigSchemaByTier } from "../../components/config-form.tiers.ts";
import { t } from "../../i18n/index.ts";
import { schemaType, type JsonSchema } from "../../lib/config-form-utils.ts";
import { configPageForSection } from "./config-sections.ts";
import { memoryVisibleSchemaKeys } from "./memory-schema.ts";
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

// Curated pages render only a subset of their section's schema; search must
// promise exactly what the destination page can edit, or the result is a
// dead-end (e.g. update.checkOnStart matched search but was editable nowhere).
const CURATED_ROUTE_VISIBLE_KEYS: Partial<Record<string, () => readonly string[]>> = {
  memory: memoryVisibleSchemaKeys,
  updates: () => ["channel", "auto"],
};

function visibleSectionSchema(routeId: string, sectionSchema: JsonSchema): JsonSchema {
  const visibleKeys = CURATED_ROUTE_VISIBLE_KEYS[routeId];
  const properties = sectionSchema.properties;
  if (!visibleKeys || !properties) {
    return sectionSchema;
  }
  const visible = new Set(visibleKeys());
  return {
    ...sectionSchema,
    properties: Object.fromEntries(
      Object.entries(properties).filter(([child]) => visible.has(child)),
    ),
  };
}

export function findSettingsSearchBlocks(params: {
  query: string;
  schema: unknown;
  value: Record<string, unknown> | null;
  uiHints: ConfigUiHints;
  identityAvailable?: boolean;
  basePath?: string;
  canAdmin?: boolean;
}): SettingsSearchBlock[] {
  if (!params.query.trim()) {
    return [];
  }
  const criteria = parseConfigSearchQuery(params.query);
  const matches: SettingsSearchBlock[] =
    criteria.tags.length === 0 && criteria.text
      ? STATIC_SETTINGS_BLOCKS.filter(
          (block) =>
            (params.identityAvailable || !block.requiresIdentity) &&
            isSettingsNavigationRouteVisible(block.routeId, params.canAdmin !== false),
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
    if (!isSettingsNavigationRouteVisible(routeId, params.canAdmin !== false)) {
      continue;
    }
    const sectionSchema = visibleSectionSchema(routeId, rawSectionSchema);
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
    const destination = { search: "", hash: editorHash };
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
