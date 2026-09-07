import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import {
  assertNoOpenClawAgentDatabaseLeases,
  claimOpenClawAgentDatabaseLease,
  releaseOpenClawAgentDatabaseLease,
} from "./openclaw-agent-db-lease.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";

const processIdentity = vi.hoisted(() => ({ startedAt: 200 }));

vi.mock("../shared/pid-alive.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../shared/pid-alive.js")>()),
  getFileLockProcessStartTime: () => processIdentity.startedAt,
  isPidDefinitelyDead: () => false,
}));

const tempDirs: string[] = [];

beforeEach(() => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
});

function createLegacyLease(openedAt: number): {
  env: NodeJS.ProcessEnv;
  leaseId: string;
} {
  const stateDir = makeTempDir(tempDirs, "agent-db-lease-");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const leaseId = claimOpenClawAgentDatabaseLease({
    agentId: "worker-1",
    path: path.join(stateDir, "worker-1.sqlite"),
    env,
  });
  runOpenClawStateWriteTransaction(
    ({ db }) =>
      db
        .prepare(
          "UPDATE agent_database_leases SET owner_start_time = NULL, opened_at = ? WHERE lease_id = ?",
        )
        .run(openedAt, leaseId),
    { env },
  );
  return { env, leaseId };
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  cleanupTempDirs(tempDirs);
  processIdentity.startedAt = 200;
  vi.restoreAllMocks();
});

describe("agent database lease recovery", () => {
  it("reclaims a legacy lease when the live PID started after the lease opened", () => {
    const { env, leaseId } = createLegacyLease(100);

    expect(() => assertNoOpenClawAgentDatabaseLeases("worker-1", { env })).not.toThrow();
    expect(
      openOpenClawStateDatabase({ env })
        .db.prepare("SELECT lease_id FROM agent_database_leases WHERE lease_id = ?")
        .get(leaseId),
    ).toBeUndefined();
  });

  it("keeps a legacy lease when the live PID could still own it", () => {
    const { env, leaseId } = createLegacyLease(300);

    expect(() => assertNoOpenClawAgentDatabaseLeases("worker-1", { env })).toThrow(
      "database is still open",
    );

    releaseOpenClawAgentDatabaseLease(leaseId, { env });
  });
});
