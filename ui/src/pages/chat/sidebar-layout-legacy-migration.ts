import { isRecord } from "@openclaw/normalization-core";
import { patchSettings, type UiSettings } from "../../app/settings.ts";
import { updateSidebarSessionLayout } from "./sidebar-layout-persistence.ts";
import { openSlot, type SidebarLayout, type SidebarSlotId } from "./sidebar-layout.ts";

const MIGRATION_MARKER_KEY = "openclaw.chat.sidePanel.legacyDockVisibility.v1";

const LEGACY_DOCKS = [
  { storageKey: "openclaw.browser.panel.v1", slot: "browser" },
  { storageKey: "openclaw.desktopPanel", slot: "desktop" },
] as const satisfies ReadonlyArray<{ storageKey: string; slot: SidebarSlotId }>;

function legacyDockWasOpen(storage: Storage, storageKey: string): boolean {
  try {
    const raw = storage.getItem(storageKey);
    if (!raw) {
      return false;
    }
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) && parsed.open === true;
  } catch {
    return false;
  }
}

function markMigrationComplete(storage: Storage): void {
  try {
    storage.setItem(MIGRATION_MARKER_KEY, "1");
  } catch {
    // Best effort: a persisted session layout still prevents duplicate migration.
  }
}

function migrationIsComplete(storage: Storage): boolean {
  try {
    return storage.getItem(MIGRATION_MARKER_KEY) === "1";
  } catch {
    return false;
  }
}

function defaultStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Move the shipped global Browser/Desktop visibility into the current session
 * once. A marker prevents that global preference from opening unrelated future
 * sessions, while an existing per-session layout always wins unchanged.
 */
export function migrateLegacyDockVisibility(params: {
  settings: UiSettings;
  sessionKey: string;
  browserAvailable: boolean;
  desktopAvailable: boolean;
  storage?: Storage | null;
}): UiSettings {
  const sessionKey = params.sessionKey.trim();
  const storage = params.storage === undefined ? defaultStorage() : params.storage;
  if (!sessionKey || !storage || migrationIsComplete(storage)) {
    return params.settings;
  }
  if (params.settings.sidebarSessionLayouts?.[sessionKey] !== undefined) {
    markMigrationComplete(storage);
    return params.settings;
  }
  const available = new Set<SidebarSlotId>([
    ...(params.browserAvailable ? (["browser"] as const) : []),
    ...(params.desktopAvailable ? (["desktop"] as const) : []),
  ]);
  let layout: SidebarLayout = { columns: [] };
  for (const legacy of LEGACY_DOCKS) {
    if (available.has(legacy.slot) && legacyDockWasOpen(storage, legacy.storageKey)) {
      layout = openSlot(layout, legacy.slot);
    }
  }
  const settings =
    layout.columns.length > 0
      ? patchSettings({
          sidebarSessionLayouts: updateSidebarSessionLayout(
            params.settings.sidebarSessionLayouts,
            sessionKey,
            layout,
          ),
        })
      : params.settings;
  markMigrationComplete(storage);
  return settings;
}
