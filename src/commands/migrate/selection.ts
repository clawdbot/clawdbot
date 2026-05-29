import path from "node:path";
import { markMigrationItemSkipped, summarizeMigrationItems } from "../../plugin-sdk/migration.js";
import type { MigrationItem, MigrationPlan } from "../../plugins/types.js";
import { isRecord } from "../../shared/record-coerce.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { uniqueStrings } from "../../shared/string-normalization.js";
import { MIGRATION_CONFLICT_REASON_PHRASES } from "./output.js";

export const MIGRATION_SKILL_NOT_SELECTED_REASON = "not selected for migration";
export const MIGRATION_PLUGIN_NOT_SELECTED_REASON = "not selected for migration";
export const MIGRATION_SELECTION_ACCEPT = "__openclaw_migrate_accept_recommended__";
export const MIGRATION_SELECTION_TOGGLE_ALL_ON = "__openclaw_migrate_toggle_all_on__";
export const MIGRATION_SELECTION_TOGGLE_ALL_OFF = "__openclaw_migrate_toggle_all_off__";
export const MIGRATION_SKILL_SELECTION_ACCEPT = MIGRATION_SELECTION_ACCEPT;
export const MIGRATION_SKILL_SELECTION_TOGGLE_ALL_ON = MIGRATION_SELECTION_TOGGLE_ALL_ON;
export const MIGRATION_SKILL_SELECTION_TOGGLE_ALL_OFF = MIGRATION_SELECTION_TOGGLE_ALL_OFF;

type InteractiveMigrationSelection = { action: "select"; selectedItemIds: Set<string> };
export type InteractiveMigrationSkillSelection = InteractiveMigrationSelection;
export type InteractiveMigrationPluginSelection = InteractiveMigrationSelection;

function normalizeSelectionRef(value: string): string {
  return value.trim().toLowerCase();
}

function readMigrationSkillName(item: MigrationItem): string | undefined {
  return normalizeOptionalString(item.details?.skillName);
}

function readMigrationSkillSourceLabel(item: MigrationItem): string | undefined {
  return normalizeOptionalString(item.details?.sourceLabel);
}

function readMigrationPluginName(item: MigrationItem): string | undefined {
  return normalizeOptionalString(item.details?.pluginName);
}

function readMigrationPluginConfigKey(item: MigrationItem): string | undefined {
  return normalizeOptionalString(item.details?.configKey);
}

function readMigrationPluginMarketplaceName(item: MigrationItem): string | undefined {
  return normalizeOptionalString(item.details?.marketplaceName);
}

function migrationSkillRefs(item: MigrationItem): string[] {
  const skillName = readMigrationSkillName(item);
  const idSuffix = item.id.startsWith("skill:") ? item.id.slice("skill:".length) : undefined;
  const sourceBase = item.source ? path.basename(item.source) : undefined;
  const targetBase = item.target ? path.basename(item.target) : undefined;
  return [item.id, idSuffix, skillName, sourceBase, targetBase].filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
}

function migrationPluginRefs(item: MigrationItem): string[] {
  const pluginName = readMigrationPluginName(item);
  const configKey = readMigrationPluginConfigKey(item);
  const idSuffix = item.id.startsWith("plugin:") ? item.id.slice("plugin:".length) : undefined;
  const sourceBase = item.source ? path.basename(item.source) : undefined;
  const targetBase = item.target ? path.basename(item.target) : undefined;
  return [item.id, idSuffix, pluginName, configKey, sourceBase, targetBase].filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
}

function formatSelectionRefList(values: readonly string[]): string {
  if (values.length === 0) {
    return "none";
  }
  return values.map((value) => `"${value}"`).join(", ");
}

function buildSelectionIndex(
  items: readonly MigrationItem[],
  refsForItem: (item: MigrationItem) => readonly string[],
): Map<string, ReadonlySet<string>> {
  const index = new Map<string, Set<string>>();
  for (const item of items) {
    for (const ref of refsForItem(item)) {
      const normalized = normalizeSelectionRef(ref);
      if (!normalized) {
        continue;
      }
      const existing = index.get(normalized) ?? new Set<string>();
      existing.add(item.id);
      index.set(normalized, existing);
    }
  }
  return index;
}

function resolveSelectedMigrationItemIds(params: {
  items: readonly MigrationItem[];
  selectedRefs: readonly string[];
  refsForItem: (item: MigrationItem) => readonly string[];
  formatSelectionLabel: (item: MigrationItem) => string;
  kindLabel: "skill" | "plugin";
  availableLabel: "skills" | "plugins";
}): Set<string> {
  const index = buildSelectionIndex(params.items, params.refsForItem);
  const selectedIds = new Set<string>();
  const unknownRefs: string[] = [];
  const ambiguousRefs: string[] = [];
  for (const ref of params.selectedRefs) {
    const normalized = normalizeSelectionRef(ref);
    if (!normalized) {
      continue;
    }
    const matches = index.get(normalized);
    if (!matches) {
      unknownRefs.push(ref);
      continue;
    }
    if (matches.size > 1) {
      ambiguousRefs.push(ref);
      continue;
    }
    const [id] = matches;
    if (id) {
      selectedIds.add(id);
    }
  }

  if (unknownRefs.length > 0 || ambiguousRefs.length > 0) {
    const available = params.items
      .map(params.formatSelectionLabel)
      .toSorted((a, b) => a.localeCompare(b));
    const titleKind = params.kindLabel[0].toUpperCase() + params.kindLabel.slice(1);
    const parts: string[] = [];
    if (unknownRefs.length > 0) {
      parts.push(
        `No migratable ${params.kindLabel} matched ${formatSelectionRefList(unknownRefs)}.`,
      );
    }
    if (ambiguousRefs.length > 0) {
      parts.push(`${titleKind} selection ${formatSelectionRefList(ambiguousRefs)} was ambiguous.`);
    }
    parts.push(
      `Available ${params.availableLabel}: ${available.length > 0 ? available.join(", ") : "none"}.`,
    );
    throw new Error(parts.join(" "));
  }

  return selectedIds;
}

function resolveSelectedSkillItemIds(
  items: readonly MigrationItem[],
  selectedRefs: readonly string[],
): Set<string> {
  return resolveSelectedMigrationItemIds({
    items,
    selectedRefs,
    refsForItem: migrationSkillRefs,
    formatSelectionLabel: formatMigrationSkillSelectionLabel,
    kindLabel: "skill",
    availableLabel: "skills",
  });
}

function resolveSelectedPluginItemIds(
  items: readonly MigrationItem[],
  selectedRefs: readonly string[],
): Set<string> {
  return resolveSelectedMigrationItemIds({
    items,
    selectedRefs,
    refsForItem: migrationPluginRefs,
    formatSelectionLabel: formatMigrationPluginSelectionLabel,
    kindLabel: "plugin",
    availableLabel: "plugins",
  });
}

export function getSelectableMigrationSkillItems(plan: MigrationPlan): MigrationItem[] {
  return plan.items.filter(
    (item) =>
      item.kind === "skill" &&
      item.action === "copy" &&
      (item.status === "planned" || item.status === "conflict"),
  );
}

export function getSelectableMigrationPluginItems(plan: MigrationPlan): MigrationItem[] {
  // Only source-installed curated Codex plugins become selectable install items.
  // Cached/manual-review plugin bundles are emitted as manual items, the aggregate
  // Codex plugin config write is a config item, and already skipped/applied/error
  // items are no longer user-actionable in the selector. Conflicts stay selectable
  // so the user can explicitly choose or deselect them before apply.
  return plan.items.filter(
    (item) =>
      item.kind === "plugin" &&
      item.action === "install" &&
      (item.status === "planned" || item.status === "conflict"),
  );
}

export function getMigrationSkillSelectionValue(item: MigrationItem): string {
  return item.id;
}

export function getMigrationPluginSelectionValue(item: MigrationItem): string {
  return item.id;
}

export function formatMigrationPluginSelectionLabel(item: MigrationItem): string {
  return readMigrationPluginName(item) ?? item.id.replace(/^plugin:/u, "");
}

export function getDefaultMigrationSkillSelectionValues(items: readonly MigrationItem[]): string[] {
  return items.filter((item) => item.status === "planned").map(getMigrationSkillSelectionValue);
}

export function getDefaultMigrationPluginSelectionValues(
  items: readonly MigrationItem[],
): string[] {
  return items.filter((item) => item.status === "planned").map(getMigrationPluginSelectionValue);
}

export function formatMigrationSkillSelectionLabel(item: MigrationItem): string {
  return readMigrationSkillName(item) ?? item.id.replace(/^skill:/u, "");
}

function humanizeMigrationConflictReason(reason: string | undefined): string {
  if (!reason) {
    return "conflict";
  }
  return MIGRATION_CONFLICT_REASON_PHRASES[reason] ?? reason;
}

export function formatMigrationSkillSelectionHint(item: MigrationItem): string | undefined {
  if (item.status !== "conflict") {
    return undefined;
  }
  const sourceLabel = readMigrationSkillSourceLabel(item);
  const reason = humanizeMigrationConflictReason(item.reason);
  return sourceLabel ? `${sourceLabel} ${reason}` : reason;
}

export function formatMigrationPluginSelectionHint(item: MigrationItem): string | undefined {
  if (item.status !== "conflict") {
    return undefined;
  }
  const marketplace = readMigrationPluginMarketplaceName(item);
  const reason = humanizeMigrationConflictReason(item.reason);
  return marketplace ? `${marketplace} plugin ${reason}` : reason;
}

export function applyMigrationSelectedSkillItemIds(
  plan: MigrationPlan,
  selectedItemIds: ReadonlySet<string>,
): MigrationPlan {
  const selectableIds = new Set(getSelectableMigrationSkillItems(plan).map((item) => item.id));
  const items = plan.items.map((item) => {
    if (!selectableIds.has(item.id) || selectedItemIds.has(item.id)) {
      return item;
    }
    return markMigrationItemSkipped(item, MIGRATION_SKILL_NOT_SELECTED_REASON);
  });
  return {
    ...plan,
    items,
    summary: summarizeMigrationItems(items),
  };
}

export function applyMigrationSkillSelection(
  plan: MigrationPlan,
  selectedSkillRefs: readonly string[] | undefined,
): MigrationPlan {
  if (selectedSkillRefs === undefined) {
    return plan;
  }
  const selectable = getSelectableMigrationSkillItems(plan);
  const selectedIds = resolveSelectedSkillItemIds(selectable, selectedSkillRefs);
  return applyMigrationSelectedSkillItemIds(plan, selectedIds);
}

export function applyMigrationPluginSelection(
  plan: MigrationPlan,
  selectedPluginRefs: readonly string[] | undefined,
): MigrationPlan {
  if (selectedPluginRefs === undefined) {
    return plan;
  }
  const selectable = getSelectableMigrationPluginItems(plan);
  const selectedIds = resolveSelectedPluginItemIds(selectable, selectedPluginRefs);
  return applyMigrationSelectedPluginItemIds(plan, selectedIds);
}

export function applyMigrationSelectedPluginItemIds(
  plan: MigrationPlan,
  selectedItemIds: ReadonlySet<string>,
): MigrationPlan {
  const selectable = getSelectableMigrationPluginItems(plan);
  const selectableIds = new Set(selectable.map((item) => item.id));
  const selectedConfigKeys = new Set(
    selectable
      .filter((item) => selectedItemIds.has(item.id))
      .map(readMigrationPluginConfigKey)
      .filter((value): value is string => value !== undefined),
  );
  const items = plan.items.map((item) => {
    if (isCodexPluginConfigItem(item)) {
      return applyCodexPluginConfigSelection(item, selectedConfigKeys);
    }
    if (!selectableIds.has(item.id) || selectedItemIds.has(item.id)) {
      return item;
    }
    return markMigrationItemSkipped(item, MIGRATION_PLUGIN_NOT_SELECTED_REASON);
  });
  return {
    ...plan,
    items,
    summary: summarizeMigrationItems(items),
  };
}

function isCodexPluginConfigItem(item: MigrationItem): boolean {
  if (item.kind !== "config" || item.action !== "merge") {
    return false;
  }
  const value = item.details?.value;
  if (!isRecord(value)) {
    return false;
  }
  const config = value.config;
  if (!isRecord(config)) {
    return false;
  }
  const codexPlugins = config.codexPlugins;
  if (!isRecord(codexPlugins)) {
    return false;
  }
  return isRecord(codexPlugins.plugins);
}

function applyCodexPluginConfigSelection(
  item: MigrationItem,
  selectedConfigKeys: ReadonlySet<string>,
): MigrationItem {
  const value = item.details?.value;
  if (!isRecord(value)) {
    return item;
  }
  const config = value.config;
  if (!isRecord(config)) {
    return item;
  }
  const codexPlugins = config.codexPlugins;
  if (!isRecord(codexPlugins) || !isRecord(codexPlugins.plugins)) {
    return item;
  }
  const plugins = Object.fromEntries(
    Object.entries(codexPlugins.plugins).filter(([configKey]) => selectedConfigKeys.has(configKey)),
  );
  if (Object.keys(plugins).length === 0) {
    return markMigrationItemSkipped(item, MIGRATION_PLUGIN_NOT_SELECTED_REASON);
  }
  return {
    ...item,
    details: {
      ...item.details,
      value: {
        ...value,
        config: {
          ...config,
          codexPlugins: {
            ...codexPlugins,
            plugins,
          },
        },
      },
    },
  };
}

function resolveInteractiveMigrationSelection(
  items: readonly MigrationItem[],
  selectedValues: readonly string[],
  getSelectionValue: (item: MigrationItem) => string,
): InteractiveMigrationSelection {
  const selectableIds = new Set(items.map(getSelectionValue));
  const selectedItemIds = new Set(selectedValues.filter((value) => selectableIds.has(value)));
  if (selectedItemIds.size > 0) {
    return { action: "select", selectedItemIds };
  }

  const selectedValueSet = new Set(selectedValues);
  if (selectedValueSet.has(MIGRATION_SELECTION_TOGGLE_ALL_OFF)) {
    return { action: "select", selectedItemIds: new Set() };
  }
  if (selectedValueSet.has(MIGRATION_SELECTION_TOGGLE_ALL_ON)) {
    return { action: "select", selectedItemIds: selectableIds };
  }

  return {
    action: "select",
    selectedItemIds,
  };
}

function isMigrationSelectionToggleValue(value: string): boolean {
  return (
    value === MIGRATION_SELECTION_TOGGLE_ALL_ON || value === MIGRATION_SELECTION_TOGGLE_ALL_OFF
  );
}

function selectedMigrationItemValues(selectedValues: readonly string[]): string[] {
  return selectedValues.filter((value) => !isMigrationSelectionToggleValue(value));
}

function resolveMigrationSelectionBulkToggleValues(
  activatedValue: string | undefined,
  selectableValues: readonly string[],
): string[] | undefined {
  if (activatedValue === MIGRATION_SELECTION_TOGGLE_ALL_ON) {
    return [MIGRATION_SELECTION_TOGGLE_ALL_ON, ...selectableValues];
  }
  if (activatedValue === MIGRATION_SELECTION_TOGGLE_ALL_OFF) {
    return [MIGRATION_SELECTION_TOGGLE_ALL_OFF];
  }
  return undefined;
}

export function resolveInteractiveMigrationSkillSelection(
  items: readonly MigrationItem[],
  selectedValues: readonly string[],
): InteractiveMigrationSkillSelection {
  return resolveInteractiveMigrationSelection(
    items,
    selectedValues,
    getMigrationSkillSelectionValue,
  );
}

export function resolveInteractiveMigrationPluginSelection(
  items: readonly MigrationItem[],
  selectedValues: readonly string[],
): InteractiveMigrationPluginSelection {
  return resolveInteractiveMigrationSelection(
    items,
    selectedValues,
    getMigrationPluginSelectionValue,
  );
}

export function reconcileInteractiveMigrationSkillToggleValues(
  selectedValues: readonly string[],
  activatedValue: string | undefined,
  selectableValues: readonly string[],
): string[] {
  const bulkValues = resolveMigrationSelectionBulkToggleValues(activatedValue, selectableValues);
  if (bulkValues !== undefined) {
    return bulkValues;
  }
  if (activatedValue !== undefined && selectableValues.includes(activatedValue)) {
    return selectedMigrationItemValues(selectedValues);
  }
  return selectedValues.filter(
    (value) =>
      value !== MIGRATION_SELECTION_TOGGLE_ALL_ON ||
      !selectedValues.includes(MIGRATION_SELECTION_TOGGLE_ALL_OFF),
  );
}

export function reconcileInteractiveMigrationEnterValues(
  selectedValues: readonly string[],
  activatedValue: string | undefined,
  selectableValues: readonly string[],
  opts: { preserveDeselectedActivatedValue?: boolean } = {},
): string[] {
  const bulkValues = resolveMigrationSelectionBulkToggleValues(activatedValue, selectableValues);
  if (bulkValues !== undefined) {
    return bulkValues;
  }
  if (activatedValue !== undefined && selectableValues.includes(activatedValue)) {
    const selectedSelectableValues = selectedMigrationItemValues(selectedValues);
    if (opts.preserveDeselectedActivatedValue && !selectedValues.includes(activatedValue)) {
      return selectedSelectableValues;
    }
    return uniqueStrings([...selectedSelectableValues, activatedValue]);
  }
  return [...selectedValues];
}

export function reconcileInteractiveMigrationShortcutValues(
  previousValues: readonly string[],
  selectedValues: readonly string[],
  selectableValues: readonly string[],
  key: "a" | "i",
): string[] {
  const previousSelectable = previousValues.filter((value) => selectableValues.includes(value));
  if (key === "a" && previousSelectable.length === selectableValues.length) {
    return [MIGRATION_SELECTION_TOGGLE_ALL_OFF];
  }

  const selectedSelectable = selectedValues.filter((value) => selectableValues.includes(value));
  if (selectedSelectable.length === selectableValues.length) {
    return [MIGRATION_SELECTION_TOGGLE_ALL_ON, ...selectableValues];
  }
  if (selectedSelectable.length === 0) {
    return [MIGRATION_SELECTION_TOGGLE_ALL_OFF];
  }
  return selectedSelectable;
}
