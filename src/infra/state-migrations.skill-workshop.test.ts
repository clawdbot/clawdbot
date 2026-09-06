import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import {
  inspectSkillProposal,
  listSkillProposals,
  proposeCreateSkill,
} from "../skills/workshop/service.js";
import { updateSkillProposalRecord } from "../skills/workshop/store.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { autoMigrateLegacyState } from "./state-migrations.doctor.js";

describe("automatic Skill Workshop migration", () => {
  let state: OpenClawTestState;

  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "workshop-startup-migration" });
  });

  afterEach(async () => {
    await state.cleanup();
  });

  it.each([15, 16])(
    "keeps pending proposals readable after migrating legacy targets from schema %i",
    async (schemaVersion) => {
      const agentDir = state.path("custom-agent");
      const config: OpenClawConfig = {
        agents: {
          entries: {
            main: { default: true, workspace: state.workspaceDir, agentDir },
          },
        },
      };
      await state.writeConfig(config);
      const proposal = await proposeCreateSkill({
        config,
        agentId: "main",
        workspaceDir: state.workspaceDir,
        env: state.env,
        name: "upgrade-procedure",
        description: "Keep a pending procedure across upgrades",
        content: "# Procedure\n\nVerify the saved proposal after upgrading.\n",
      });
      const legacySkillDir = path.join(state.workspaceDir, "skills", "upgrade-procedure");
      await updateSkillProposalRecord({
        record: {
          ...proposal.record,
          target: {
            ...proposal.record.target,
            skillDir: legacySkillDir,
            skillFile: path.join(legacySkillDir, "SKILL.md"),
            source: "openclaw-workspace",
          },
        },
        store: { config, agentId: "main", env: state.env },
      });
      const databasePath = openOpenClawStateDatabase({ env: state.env }).path;
      closeOpenClawStateDatabaseForTest();
      if (schemaVersion === 15) {
        const legacy = openNodeSqliteDatabase(databasePath);
        try {
          legacy.exec(`
            ALTER TABLE skill_workshop_proposals ADD COLUMN workspace_dir TEXT NOT NULL DEFAULT '';
            ALTER TABLE skill_workshop_proposals ADD COLUMN claim_released_time INTEGER;
            DROP TABLE skill_workshop_collection_reviews;
            CREATE TABLE skill_workshop_collection_reviews (
              review_id TEXT NOT NULL PRIMARY KEY,
              workspace_dir TEXT NOT NULL,
              backup_id TEXT NOT NULL,
              create_time INTEGER NOT NULL,
              kept_names_json TEXT NOT NULL,
              written_names_json TEXT NOT NULL,
              dropped_json TEXT NOT NULL
            ) STRICT;
            PRAGMA user_version = 15;
            UPDATE schema_meta SET schema_version = 15 WHERE meta_key = 'primary';
          `);
          legacy
            .prepare("UPDATE skill_workshop_proposals SET workspace_dir = ?")
            .run(state.workspaceDir);
        } finally {
          legacy.close();
        }
      }

      const migration = await autoMigrateLegacyState({
        cfg: config,
        env: state.env,
        homedir: () => state.home,
        legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
      });
      expect(migration.warnings).toEqual([]);
      const scope = { config, agentId: "main", env: state.env };
      const listed = await listSkillProposals(scope);
      expect(listed.proposals).toEqual([
        expect.objectContaining({ id: proposal.record.id, status: "pending" }),
      ]);
      const skillDir = path.join(agentDir, "workshop-skills", "upgrade-procedure");
      await expect(inspectSkillProposal(proposal.record.id, scope)).resolves.toMatchObject({
        content: proposal.content,
        record: {
          id: proposal.record.id,
          status: "pending",
          target: {
            skillDir,
            skillFile: path.join(skillDir, "SKILL.md"),
            source: "openclaw-workshop",
          },
        },
      });
    },
  );
});
