// One-time legacy session state migration before SQLite-backed session reads.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { autoMigrateLegacyState, resetAutoMigrateLegacyStateForTest } from "./state-migrations.js";

let sessionStateMigrationPromise: Promise<void> | null = null;

export async function ensureSessionStateMigrated(cfg: OpenClawConfig): Promise<void> {
  sessionStateMigrationPromise ??= autoMigrateLegacyState({ cfg, env: process.env }).then(
    () => undefined,
  );
  await sessionStateMigrationPromise;
}

export function resetSessionStateMigratedForTest(): void {
  sessionStateMigrationPromise = null;
  resetAutoMigrateLegacyStateForTest();
}
