/** Exact migration item selection for embedded and non-interactive callers. */
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { markMigrationItemSkipped, summarizeMigrationItems } from "../../plugin-sdk/migration.js";
import type { MigrationPlan } from "../../plugins/types.js";

const MIGRATION_NOT_SELECTED_REASON = "not selected for migration";

function formatSelectionRefList(values: readonly string[]): string {
  return values.length === 0 ? "none" : values.map((value) => `"${value}"`).join(", ");
}

/** Applies an exact item-id selection to planned/conflicting migration items. */
export function applyMigrationItemSelection(
  plan: MigrationPlan,
  selectedItemIds: readonly string[] | undefined,
): MigrationPlan {
  if (selectedItemIds === undefined) {
    return plan;
  }
  const selectable = plan.items.filter(
    (item) => item.status === "planned" || item.status === "conflict",
  );
  const selectableIds = new Set(selectable.map((item) => item.id));
  const unknown = uniqueStrings(selectedItemIds).filter((id) => !selectableIds.has(id));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown or unavailable migration item ids: ${formatSelectionRefList(unknown)}.`,
    );
  }
  const selected = new Set(selectedItemIds);
  const items = plan.items.map((item) =>
    selectableIds.has(item.id) && !selected.has(item.id)
      ? markMigrationItemSkipped(item, MIGRATION_NOT_SELECTED_REASON)
      : item,
  );
  return { ...plan, items, summary: summarizeMigrationItems(items) };
}
