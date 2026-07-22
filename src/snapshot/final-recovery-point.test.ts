import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { stableStringify } from "../agents/stable-stringify.js";
import { sha256Hex } from "../infra/crypto-digest.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../state/openclaw-agent-schema.generated.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.generated.js";
import {
  captureFinalRecoveryPoint,
  FINAL_RECOVERY_POINT_REQUEST_VERSION,
  parseFinalRecoveryPointRequest,
  type FinalRecoveryPointRequest,
} from "./final-recovery-point.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let previousStateDir: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.OPENCLAW_STATE_DIR;
});

afterEach(() => {
  if (previousStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = previousStateDir;
  }
});

describe("final recovery-point capture", () => {
  it("captures closed global and agent state and replays the exact committed result", async () => {
    const fixture = await createFixture();

    const first = await captureFinalRecoveryPoint(fixture.request);
    const replay = await captureFinalRecoveryPoint(fixture.request);

    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      ok: true,
      runtimeLineage: "runtime/tenant-7",
      handoffId: "handoff-7",
      sourceGeneration: "generation-7",
      closureEvidenceId: "supervisor-stop-7",
    });
    expect(first.components.map((component) => component.componentId)).toEqual([
      "sqlite/global",
      "sqlite/agent/main",
    ]);
    expect(JSON.parse(await fs.readFile(first.aggregateManifestPath, "utf8"))).toMatchObject({
      recoveryPointId: first.recoveryPointId,
      protection: { mode: "host-protected" },
    });
    await expect(countCommittedSnapshots(first.recoveryPointPath)).resolves.toBe(2);
  });

  it("quarantines a changed request under the same handoff and generation", async () => {
    const fixture = await createFixture();
    await captureFinalRecoveryPoint(fixture.request);

    await expect(
      captureFinalRecoveryPoint({
        ...fixture.request,
        closure: { ...fixture.request.closure, evidenceId: "different-stop" },
      }),
    ).rejects.toMatchObject({
      code: "final-capture.operation-conflict",
      disposition: "quarantine",
    });
  });

  it("quarantines durable intent without a committed result", async () => {
    const fixture = await createFixture();
    const operationPath = path.join(fixture.request.repositoryPath, operationId(fixture.request));
    await fs.mkdir(operationPath, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      path.join(operationPath, "intent.json"),
      `${stableStringify(fixture.request)}\n`,
      { mode: 0o600 },
    );

    await expect(captureFinalRecoveryPoint(fixture.request)).rejects.toMatchObject({
      code: "final-capture.operation-conflict",
      disposition: "quarantine",
    });
    await expect(fs.access(path.join(operationPath, "components"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("quarantines a committed recovery point whose component bytes changed", async () => {
    const fixture = await createFixture();
    const result = await captureFinalRecoveryPoint(fixture.request);
    await fs.appendFile(path.join(result.components[0]!.snapshotPath, "database.sqlite"), "x");

    await expect(captureFinalRecoveryPoint(fixture.request)).rejects.toMatchObject({
      code: "final-capture.verification-failed",
      disposition: "quarantine",
    });
  });

  it("requires explicit closed-writer evidence and canonical owner inventory", () => {
    const base = {
      version: FINAL_RECOVERY_POINT_REQUEST_VERSION,
      runtimeLineage: "runtime/tenant-7",
      handoffId: "handoff-7",
      sourceGeneration: "generation-7",
      capturedAt: "2026-07-22T18:00:00.000Z",
      repositoryPath: path.resolve("final-recovery-points"),
      expectedAgentIds: ["research", "main"],
      closure: {
        gateway: "cleanly-stopped",
        authoritativeWriters: "stopped",
        evidenceId: "supervisor-stop-7",
      },
    };
    expect(() => parseFinalRecoveryPointRequest(JSON.stringify(base))).toThrow(
      "unique, normalized, and sorted",
    );
    expect(() =>
      parseFinalRecoveryPointRequest(
        JSON.stringify({ ...base, expectedAgentIds: ["main"], closure: undefined }),
      ),
    ).toThrow("request is invalid");
  });
});

async function createFixture(): Promise<{ request: FinalRecoveryPointRequest }> {
  const tempDir = tempDirs.make("openclaw-final-recovery-point-");
  const stateDir = path.join(tempDir, "state");
  process.env.OPENCLAW_STATE_DIR = stateDir;
  const globalPath = resolveOpenClawStateSqlitePath();
  const agentPath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
  await fs.mkdir(path.dirname(globalPath), { recursive: true });
  await fs.mkdir(path.dirname(agentPath), { recursive: true });
  createDatabase(globalPath, "global");
  createDatabase(agentPath, "agent", "main");
  return {
    request: {
      version: FINAL_RECOVERY_POINT_REQUEST_VERSION,
      runtimeLineage: "runtime/tenant-7",
      handoffId: "handoff-7",
      sourceGeneration: "generation-7",
      capturedAt: "2026-07-22T18:00:00.000Z",
      repositoryPath: path.join(tempDir, "recovery-points"),
      expectedAgentIds: ["main"],
      closure: {
        gateway: "cleanly-stopped",
        authoritativeWriters: "stopped",
        evidenceId: "supervisor-stop-7",
      },
    },
  };
}

function createDatabase(databasePath: string, role: "global" | "agent", agentId?: string): void {
  const sqlite = requireNodeSqlite();
  const database = new sqlite.DatabaseSync(databasePath);
  const schema = role === "global" ? OPENCLAW_STATE_SCHEMA_SQL : OPENCLAW_AGENT_SCHEMA_SQL;
  const version = role === "global" ? OPENCLAW_STATE_SCHEMA_VERSION : OPENCLAW_AGENT_SCHEMA_VERSION;
  try {
    database.exec(`${schema}\nPRAGMA user_version = ${version};`);
    database
      .prepare(
        `INSERT INTO schema_meta (
          meta_key, role, schema_version, agent_id, app_version, created_at, updated_at
        ) VALUES ('primary', ?, ?, ?, NULL, 1, 1)`,
      )
      .run(role, version, role === "agent" ? agentId : null);
  } finally {
    database.close();
  }
}

async function countCommittedSnapshots(recoveryPointPath: string): Promise<number> {
  const global = await fs.readdir(path.join(recoveryPointPath, "components", "global"));
  const agent = await fs.readdir(path.join(recoveryPointPath, "components", "agents", "main"));
  return (
    global.filter((entry) => !entry.startsWith(".tmp-")).length +
    agent.filter((entry) => !entry.startsWith(".tmp-")).length
  );
}

function operationId(request: FinalRecoveryPointRequest): string {
  return sha256Hex(
    stableStringify({
      runtimeLineage: request.runtimeLineage,
      handoffId: request.handoffId,
      sourceGeneration: request.sourceGeneration,
    }),
  );
}
