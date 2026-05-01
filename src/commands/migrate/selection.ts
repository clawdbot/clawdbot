import path from "node:path";
import { markMigrationItemSkipped, summarizeMigrationItems } from "../../plugin-sdk/migration.js";
import type { MigrationItem, MigrationPlan } from "../../plugins/types.js";

export const MIGRATION_SKILL_NOT_SELECTED_REASON = "not selected for migration";

function normalizeSelectionRef(value: string): string {
  return value.trim().toLowerCase();
}

function readMigrationSkillName(item: MigrationItem): string | undefined {
  const value = item.details?.skillName;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readMigrationSkillSourceLabel(item: MigrationItem): string | undefined {
  const value = item.details?.sourceLabel;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
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

function formatSelectionRefList(values: readonly string[]): string {
  if (values.length === 0) {
    return "none";
  }
  return values.map((value) => `"${value}"`).join(", ");
}

function buildSkillSelectionIndex(
  items: readonly MigrationItem[],
): Map<string, ReadonlySet<string>> {
  const index = new Map<string, Set<string>>();
  for (const item of items) {
    for (const ref of migrationSkillRefs(item)) {
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

function resolveSelectedSkillItemIds(
  items: readonly MigrationItem[],
  selectedRefs: readonly string[],
): Set<string> {
  const index = buildSkillSelectionIndex(items);
  const selectedIds = new Set<string>();
  const unknownRefs: string[] = [];
  const ambiguousRefs: string[] = [];
  for (const ref of selectedRefs) {
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
    const available = items
      .map(formatMigrationSkillSelectionLabel)
      .toSorted((a, b) => a.localeCompare(b));
    const parts: string[] = [];
    if (unknownRefs.length > 0) {
      parts.push(`No migratable skill matched ${formatSelectionRefList(unknownRefs)}.`);
    }
    if (ambiguousRefs.length > 0) {
      parts.push(`Skill selection ${formatSelectionRefList(ambiguousRefs)} was ambiguous.`);
    }
    parts.push(`Available skills: ${available.length > 0 ? available.join(", ") : "none"}.`);
    throw new Error(parts.join(" "));
  }

  return selectedIds;
}

export function getSelectableMigrationSkillItems(plan: MigrationPlan): MigrationItem[] {
  return plan.items.filter(
    (item) =>
      item.kind === "skill" &&
      item.action === "copy" &&
      (item.status === "planned" || item.status === "conflict"),
  );
}

export function getMigrationSkillSelectionValue(item: MigrationItem): string {
  return item.id;
}

export function formatMigrationSkillSelectionLabel(item: MigrationItem): string {
  return readMigrationSkillName(item) ?? item.id.replace(/^skill:/u, "");
}

export function formatMigrationSkillSelectionHint(item: MigrationItem): string | undefined {
  const parts = [readMigrationSkillSourceLabel(item)];
  if (item.status === "conflict") {
    parts.push(item.reason ? `conflict: ${item.reason}` : "conflict");
  }
  return (
    parts
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join("; ") || undefined
  );
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
