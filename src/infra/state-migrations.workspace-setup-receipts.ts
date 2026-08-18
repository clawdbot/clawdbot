// Receipt lookup and source-removal bookkeeping for legacy workspace migration.
import {
  readLegacyMigrationReceipt,
  resolveLegacyMigrationSourceKey,
} from "./state-migrations.receipts.js";
import type { LegacyWorkspaceStateSource } from "./state-migrations.workspace-setup.types.js";

export { markLegacyMigrationSourceRemoved } from "./state-migrations.receipts.js";

export type MigrationReceipt = {
  sourceKey: string;
  sha256: string | null;
  removedSource: boolean;
};

export function resolveWorkspaceMigrationSourceKey(source: LegacyWorkspaceStateSource): string {
  return resolveLegacyMigrationSourceKey(
    `workspace-${source.kind}`,
    source.sourcePath,
    source.workspaceKey,
  );
}

export function readReceipt(
  source: LegacyWorkspaceStateSource,
  env: NodeJS.ProcessEnv,
): MigrationReceipt | null {
  const receipt = readLegacyMigrationReceipt(resolveWorkspaceMigrationSourceKey(source), env);
  return receipt
    ? {
        sourceKey: receipt.sourceKey,
        sha256: receipt.sourceSha256,
        removedSource: receipt.removedSource,
      }
    : null;
}
