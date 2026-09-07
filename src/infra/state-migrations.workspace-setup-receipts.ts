// Receipt lookup and source-removal bookkeeping for legacy workspace migration.
import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
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
  archivePath?: string;
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
  const archivePath = receipt ? safeParseJsonRecord(receipt.reportJson)?.archivePath : undefined;
  return receipt
    ? {
        sourceKey: receipt.sourceKey,
        sha256: receipt.sourceSha256,
        removedSource: receipt.removedSource,
        ...(typeof archivePath === "string" ? { archivePath } : {}),
      }
    : null;
}
