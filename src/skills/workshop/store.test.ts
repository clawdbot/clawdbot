import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import {
  closeOpenClawStateDatabaseForTest,
  OPENCLAW_STATE_SCHEMA_VERSION,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createSkillProposalEvent } from "./plugin-hooks.js";
import { listSkillProposalEvents, listSkillProposals, proposeCreateSkill } from "./service.js";
import { parseSkillProposalEvaluation } from "./store-record.js";
import { updateSkillProposalRecord } from "./store.js";

let testState: OpenClawTestState;

beforeEach(async () => {
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-workshop-store-",
  });
});

afterEach(async () => {
  await testState.cleanup();
});

describe("Skill Workshop SQLite store", () => {
  it("lazily ensures additive tables without changing the schema version", async () => {
    const databasePath = openOpenClawStateDatabase().path;
    closeOpenClawStateDatabaseForTest();
    const { DatabaseSync } = requireNodeSqlite();
    const existing = new DatabaseSync(databasePath);
    existing.exec(`
      DROP TABLE skill_workshop_proposal_events;
      DROP TABLE skill_workshop_proposal_origin_runs;
      DROP TABLE skill_workshop_proposal_rollbacks;
      DROP TABLE skill_workshop_proposals;
    `);
    existing.close();

    const reopened = openOpenClawStateDatabase();
    expect(
      reopened.db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("skill_workshop_proposals"),
    ).toBeUndefined();
    await expect(listSkillProposals()).resolves.toMatchObject({ proposals: [] });
    expect(
      reopened.db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("skill_workshop_proposals"),
    ).toEqual({ name: "skill_workshop_proposals" });
    expect(
      reopened.db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("skill_workshop_proposal_events"),
    ).toEqual({ name: "skill_workshop_proposal_events" });
    expect(reopened.db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_STATE_SCHEMA_VERSION,
    });
  });

  it("keeps arbitrary payload keys disjoint from durable evaluations", async () => {
    const proposal = await proposeCreateSkill({
      workspaceDir: testState.stateDir,
      agentId: "main",
      name: "Event Envelope",
      description: "Exercise event payload encoding",
      content: "# Event Envelope\n",
    });
    const evaluation = {
      id: "evaluation-envelope",
      proposedVersion: proposal.record.proposedVersion,
      revisionHash: proposal.revisionHash,
      trigger: "manual" as const,
      startedAt: "2026-07-29T00:00:00.000Z",
      completedAt: "2026-07-29T00:00:01.000Z",
      outcomes: [],
    };
    await updateSkillProposalRecord({
      record: proposal.record,
      event: createSkillProposalEvent({
        record: proposal.record,
        type: "evaluation_completed",
        payload: { evaluation: "manual", outcomeCount: 0 },
        evaluation,
      }),
    });

    expect(
      listSkillProposalEvents({
        workspaceDir: testState.stateDir,
        proposalId: proposal.record.id,
      }).events[1],
    ).toMatchObject({
      payload: { evaluation: "manual", outcomeCount: 0 },
      evaluation: { id: evaluation.id },
    });
  });

  it("rejects non-string evaluation tree hashes", () => {
    expect(
      parseSkillProposalEvaluation({
        id: "evaluation-invalid-tree-hash",
        proposedVersion: "v1",
        revisionHash: "a".repeat(64),
        trigger: "manual",
        startedAt: "2026-07-29T00:00:00.000Z",
        completedAt: "2026-07-29T00:00:01.000Z",
        targetTreeSha256: ["b".repeat(64)],
        outcomes: [],
      }),
    ).toBeNull();
  });

  it("paginates durable evaluations before the response byte budget", async () => {
    const proposal = await proposeCreateSkill({
      workspaceDir: testState.stateDir,
      agentId: "main",
      name: "Event Page Budget",
      description: "Bound replay response size",
      content: "# Event Page Budget\n",
    });
    const findings = Array.from({ length: 80 }, (_, index) => ({
      ruleId: `large-${index}`,
      severity: "info" as const,
      message: "x".repeat(4_000),
    }));
    for (let index = 0; index < 7; index += 1) {
      const evaluation = {
        id: `evaluation-page-${index}`,
        proposedVersion: proposal.record.proposedVersion,
        revisionHash: proposal.revisionHash,
        trigger: "manual" as const,
        startedAt: "2026-07-29T00:00:00.000Z",
        completedAt: "2026-07-29T00:00:01.000Z",
        outcomes: [
          {
            evaluatorId: "page-budget",
            pluginId: "store-tests",
            status: "completed" as const,
            result: { findings },
          },
        ],
      };
      await updateSkillProposalRecord({
        record: proposal.record,
        event: createSkillProposalEvent({
          record: proposal.record,
          type: "evaluation_completed",
          evaluation,
        }),
      });
    }

    const firstPage = listSkillProposalEvents({
      workspaceDir: testState.stateDir,
      proposalId: proposal.record.id,
      limit: 200,
    });
    expect(firstPage.events.length).toBeLessThan(8);
    expect(firstPage.nextSequence).toBeDefined();
    expect(Buffer.byteLength(JSON.stringify(firstPage), "utf8")).toBeLessThanOrEqual(
      2 * 1024 * 1024 + 1_024,
    );
    const secondPage = listSkillProposalEvents({
      workspaceDir: testState.stateDir,
      proposalId: proposal.record.id,
      afterSequence: firstPage.nextSequence,
      limit: 200,
    });
    expect(secondPage.events.length).toBeGreaterThan(0);
  });

  it("fails replay explicitly for oversized stored event data", async () => {
    const proposal = await proposeCreateSkill({
      workspaceDir: testState.stateDir,
      agentId: "main",
      name: "Oversized Stored Event",
      description: "Reject silent audit data loss",
      content: "# Oversized Stored Event\n",
    });
    openOpenClawStateDatabase()
      .db.prepare(
        "UPDATE skill_workshop_proposal_events SET payload_json = ? WHERE proposal_id = ?",
      )
      .run("x".repeat(600 * 1024), proposal.record.id);

    expect(() =>
      listSkillProposalEvents({
        workspaceDir: testState.stateDir,
        proposalId: proposal.record.id,
      }),
    ).toThrow(/Stored Skill Workshop event .* cannot be replayed safely/);
  });
});
