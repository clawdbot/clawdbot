import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect } from "vitest";
import type {
  LegacyStateMigrationPlan,
  LegacyStateMigrationStepReceipt,
} from "./state-migrations.types.js";

export function writeLegacyStateSchemaV1(stateDatabasePath: string): void {
  fs.mkdirSync(path.dirname(stateDatabasePath), { recursive: true });
  const database = new DatabaseSync(stateDatabasePath);
  try {
    database.exec(`
      PRAGMA user_version = 1;
      CREATE TABLE audit_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        source_id TEXT NOT NULL UNIQUE,
        source_sequence INTEGER NOT NULL,
        occurred_at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        error_code TEXT,
        actor_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        session_key TEXT,
        session_id TEXT,
        run_id TEXT NOT NULL,
        tool_call_id TEXT,
        tool_name TEXT
      );
    `);
  } finally {
    database.close();
  }
}

export function snapshotFiles(root: string): Record<string, string> {
  const result: Record<string, string> = { ".": "directory" };
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const pathname = path.join(directory, entry.name);
      const relativePath = path.relative(root, pathname);
      if (entry.isSymbolicLink()) {
        result[relativePath] = `symlink:${fs.readlinkSync(pathname)}`;
      } else if (entry.isDirectory()) {
        result[relativePath] = "directory";
        visit(pathname);
      } else {
        const digest = createHash("sha256").update(fs.readFileSync(pathname)).digest("hex");
        result[relativePath] = `file:sha256:${digest}`;
      }
    }
  };
  visit(root);
  return result;
}

export function expectBlockedTailInPlanOrder(params: {
  plan: LegacyStateMigrationPlan;
  receipts: readonly LegacyStateMigrationStepReceipt[];
  blockerId: string;
}): void {
  expect(params.receipts.map((receipt) => receipt.id)).toEqual(
    params.plan.steps.map((step) => step.id),
  );
  const blockerIndex = params.plan.steps.findIndex((step) => step.id === params.blockerId);
  expect(blockerIndex).toBeGreaterThanOrEqual(0);
  expect(
    params.receipts.slice(blockerIndex + 1).map((receipt) => ({
      id: receipt.id,
      outcome: receipt.outcome,
      refusalCode: receipt.refusal?.code,
    })),
  ).toEqual(
    params.plan.steps.slice(blockerIndex + 1).map((step) => ({
      id: step.id,
      outcome: "refused",
      refusalCode: "blocked-by-prior-refusal",
    })),
  );
}

function stableStepDescriptor(
  step: LegacyStateMigrationPlan["steps"][number] | LegacyStateMigrationStepReceipt,
) {
  return {
    id: step.id,
    phase: step.phase,
    source: step.source,
    target: step.target,
    requiredness: step.requiredness,
    reversibility: step.reversibility,
  };
}

export function expectPlanReceiptDescriptorsToMatch(params: {
  plan: LegacyStateMigrationPlan;
  receipts: readonly LegacyStateMigrationStepReceipt[];
}): void {
  expect(params.receipts.map(stableStepDescriptor)).toEqual(
    params.plan.steps.map(stableStepDescriptor),
  );
}

export function createCallerModeSnapshot(
  fixture: Pick<LegacyStateMigrationPlan["snapshot"], "homeDir" | "configPath" | "stateDir">,
): LegacyStateMigrationPlan["snapshot"] {
  return {
    homeDir: fixture.homeDir,
    configPath: fixture.configPath,
    stateDir: fixture.stateDir,
  };
}
