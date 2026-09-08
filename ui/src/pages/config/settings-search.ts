import type { ConfigUiHints } from "../../api/types.ts";
import {
  isSettingsNavigationRouteVisible,
  settingsSearchTextMatches,
  type SettingsSearchBlock,
} from "../../app-navigation.ts";
import { pathForMemoryTab } from "../../app-route-paths.ts";
import type {
  NativeDeviceSettingsCapability,
  NativeDeviceSettingsSnapshot,
} from "../../app/native-device-settings.ts";
import { SECTION_META } from "../../components/config-form.meta.ts";
import {
  matchesConfigSectionSearch,
  parseConfigSearchQuery,
} from "../../components/config-form.search.ts";
import { splitConfigSchemaByTier } from "../../components/config-form.tiers.ts";
import { t } from "../../i18n/index.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { schemaType, type JsonSchema } from "../../lib/config-form-utils.ts";
import { configPageForSection } from "./config-sections.ts";
import { memoryVisibleSchemaKeys } from "./memory-schema.ts";
import { SETTINGS_SEARCH_TARGETS, type SettingsSearchTarget } from "./settings-targets.ts";
import { setupVisibleSchema } from "./setup-schema.ts";

registerSettingsEnglish();

type StaticSettingsBlock = SettingsSearchBlock & {
  searchText: string;
};

const STATIC_SETTINGS_BLOCKS: readonly SettingsSearchTarget[] =
  Object.values(SETTINGS_SEARCH_TARGETS);

function resolveStaticSettingsBlock(
  block: SettingsSearchTarget,
  snapshot: NativeDeviceSettingsSnapshot | null,
): StaticSettingsBlock {
  const label = t(block.labelKey);
  const nativeKeys = snapshot
    ? Object.entries(block.nativeSearchKeys ?? {})
        .filter(([, available]) => available(snapshot))
        .map(([key]) => key)
    : [];
  return {
    routeId: block.routeId,
    ...(block.search === undefined ? {} : { search: block.search }),
    hash: block.hash,
    label,
    searchText: [
      label,
      ...[...block.searchKeys, ...nativeKeys].map((key) => t(key)),
      block.aliases ?? "",
    ].join(" "),
  };
}

// Curated pages render only a subset of their section's schema; search must
// promise exactly what the destination page can edit, or the result is a
// dead-end.
const CURATED_ROUTE_VISIBLE_KEYS: Partial<Record<string, () => readonly string[]>> = {
  memory: memoryVisibleSchemaKeys,
  updates: () => ["channel", "checkOnStart", "auto"],
};

const preparedSectionsBySchema = new WeakMap<
  JsonSchema,
  {
    hints: ConfigUiHints;
    sections: Map<
      string,
      { schema: JsonSchema; tiers: ReturnType<typeof splitConfigSchemaByTier> }
    >;
  }
>();

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
  nativeDeviceSettings?: NativeDeviceSettingsCapability | null;
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
            (params.nativeDeviceSettings || !block.requiresNativeDeviceSettings) &&
            isSettingsNavigationRouteVisible(
              block.routeId,
              params.canAdmin !== false,
              params.nativeDeviceSettings,
            ),
        )
          .map((block) =>
            resolveStaticSettingsBlock(block, params.nativeDeviceSettings?.snapshot ?? null),
          )
          .filter((block) => settingsSearchTextMatches(block.searchText, criteria.text))
      : [];
  const schema =
    params.schema && typeof params.schema === "object" && !Array.isArray(params.schema)
      ? (params.schema as JsonSchema)
      : null;
  if (!schema || schemaType(schema) !== "object" || !schema.properties) {
    return matches;
  }
  let prepared = preparedSectionsBySchema.get(schema);
  // Schema responses replace both objects. Keep only the current hint revision;
  // draft values, query text, locale, and route visibility are evaluated below.
  if (!prepared || prepared.hints !== params.uiHints) {
    prepared = { hints: params.uiHints, sections: new Map() };
    preparedSectionsBySchema.set(schema, prepared);
  }
  const value = params.value ?? {};
  for (const [key, rawSectionSchema] of Object.entries(schema.properties)) {
    const routeId = configPageForSection(key);
    if (
      !isSettingsNavigationRouteVisible(
        routeId,
        params.canAdmin !== false,
        params.nativeDeviceSettings,
      )
    ) {
      continue;
    }
    let section = prepared.sections.get(key);
    if (!section) {
      const sectionSchema =
        key === "wizard"
          ? setupVisibleSchema(rawSectionSchema)
          : visibleSectionSchema(routeId, rawSectionSchema);
      section = {
        schema: sectionSchema,
        tiers: splitConfigSchemaByTier({
          schema: sectionSchema,
          path: [key],
          hints: params.uiHints,
        }),
      };
      prepared.sections.set(key, section);
    }
    const { schema: sectionSchema, tiers: tierSplit } = section;
    const meta = SECTION_META[key];
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
            search: `?section=${encodedKey}${matchesAdvanced || key === "wizard" ? "&advanced=1" : ""}`,
            hash: destination.hash,
          },
    );
  }
  return matches;
}
