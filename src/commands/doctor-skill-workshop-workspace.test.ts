import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LEGACY_WORKSPACE_ATTESTATION_HEADER,
  resolveLegacyWorkspaceSourcePaths,
} from "../agents/workspace-legacy-state.js";
import { resetLegacyWorkspaceStateCheckForTest } from "../agents/workspace-legacy-state.test-support.js";
import {
  deleteWorkspaceState,
  prepareWorkspaceStateDeletion,
  readWorkspaceStateSnapshot,
  replaceWorkspaceAttestation,
  WORKSPACE_CONTENT_RELOCATION_MIGRATION_KIND,
} from "../agents/workspace-state-store.js";
import { ensureAgentWorkspace, WORKSPACE_VANISHED_ERROR_CODE } from "../agents/workspace.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  autoMigrateLegacyState,
  detectLegacyStateMigrations,
  runLegacyStateMigrations,
} from "../infra/state-migrations.doctor.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import {
  renderProposalMarkdown,
  stripProposalFrontmatterForSkill,
} from "../skills/workshop/frontmatter.js";
import { resolveWorkshopSkillsDir } from "../skills/workshop/skills-root.js";
import { hashSkillProposalContent } from "../skills/workshop/store.js";
import { SKILL_WORKSHOP_SCHEMA, type SkillProposalRecord } from "../skills/workshop/types.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { migrateLegacySkillWorkshopProposals } from "./doctor-skill-workshop-sqlite.js";
import { seedLegacyV15ProposalRows } from "./doctor-skill-workshop-sqlite.test-support.js";

let state: OpenClawTestState;

beforeEach(async () => {
  resetLegacyWorkspaceStateCheckForTest();
  state = await createOpenClawTestState({ label: "workshop-workspace-relocation" });
});

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  resetLegacyWorkspaceStateCheckForTest();
  await state.cleanup();
});

async function createLegacyWorkspace(userContent = false, skillsPath = "skills") {
  const workspaceDir = state.workspaceDir;
  const config: OpenClawConfig = {
    agents: {
      defaults: { skipBootstrap: true },
      entries: { main: { workspace: workspaceDir } },
    },
  };
  await state.writeConfig(config);
  const name = "workspace-relocation";
  const now = "2026-09-01T00:00:00.000Z";
  const draft = renderProposalMarkdown({
    name,
    description: "Procedure moved out of the workspace",
    content: "# Procedure\n\nCheck the saved result.\n",
    date: now,
  });
  const content = stripProposalFrontmatterForSkill(draft);
  const skillDir = path.join(workspaceDir, skillsPath, name);
  const skillFile = path.join(skillDir, "SKILL.md");
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(skillFile, content);
  if (userContent) {
    await fs.writeFile(path.join(workspaceDir, "README.md"), "# User project\n");
  }
  await ensureAgentWorkspace({ dir: workspaceDir, ensureBootstrapFiles: false });
  const before = readWorkspaceStateSnapshot(workspaceDir);
  expect(before.attestation).toBeDefined();
  expect(before.attestation?.generatedHashes.size).toBe(0);
  expect(before.setupExists).toBe(false);
  const created: SkillProposalRecord = {
    schema: SKILL_WORKSHOP_SCHEMA,
    id: "workspace-create-20260901-1234567890",
    kind: "create",
    status: "applied",
    title: "Create relocation procedure",
    description: "Procedure moved out of the workspace",
    createdAt: now,
    updatedAt: now,
    createdBy: "cli",
    proposedVersion: "v1",
    draftFile: "PROPOSAL.md",
    draftHash: hashSkillProposalContent(draft),
    target: {
      skillName: name,
      skillKey: name,
      skillDir,
      skillFile,
      source: "openclaw-workspace",
    },
    scan: { state: "clean", scannedAt: now, critical: 0, warn: 0, info: 0, findings: [] },
    appliedAt: now,
  };
  const pending: SkillProposalRecord = {
    ...created,
    id: "workspace-update-20260901-1234567890",
    kind: "update",
    status: "pending",
    appliedAt: undefined,
    target: { ...created.target, currentContentHash: hashSkillProposalContent(content) },
  };
  for (const record of [created, pending]) {
    await state.writeText(
      path.join("skill-workshop", "proposals", record.id, "PROPOSAL.md"),
      draft,
    );
  }
  seedLegacyV15ProposalRows(state.env, [
    { record: created, workspaceDir, claimReleasedTime: null },
    { record: pending, workspaceDir, claimReleasedTime: null },
  ]);
  const destination = path.join(resolveWorkshopSkillsDir(config, "main", state.env), name);
  return { config, workspaceDir, created, pending, content, destination, before };
}

type LegacyWorkspace = Awaited<ReturnType<typeof createLegacyWorkspace>>;

async function interruptPendingWrite(fixture: LegacyWorkspace) {
  const database = openOpenClawStateDatabase({ env: state.env });
  database.db.exec(`
    CREATE TEMP TRIGGER reject_workspace_pending_relocation
    BEFORE UPDATE OF record_json ON main.skill_workshop_proposals
    WHEN OLD.proposal_id = '${fixture.pending.id}'
      AND NEW.status = 'pending'
      AND json_extract(NEW.record_json, '$.target.source') = 'openclaw-workshop'
    BEGIN
      SELECT RAISE(ABORT, 'workspace pending relocation unavailable');
    END;
  `);
  try {
    await expect(
      migrateLegacySkillWorkshopProposals({ config: fixture.config, env: state.env }),
    ).rejects.toThrow("workspace pending relocation unavailable");
  } finally {
    database.db.exec("DROP TRIGGER reject_workspace_pending_relocation");
  }
  await expect(fs.access(fixture.created.target.skillDir)).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(fs.readFile(path.join(fixture.destination, "SKILL.md"), "utf8")).resolves.toBe(
    fixture.content,
  );
  expect(readWorkspaceStateSnapshot(fixture.workspaceDir).attestation).toEqual(
    fixture.before.attestation,
  );
}

async function expectWorkspaceUsable(workspaceDir: string) {
  await expect(
    ensureAgentWorkspace({ dir: workspaceDir, ensureBootstrapFiles: false }),
  ).resolves.toMatchObject({ dir: workspaceDir, bootstrapPending: false });
  await expect(
    ensureAgentWorkspace({ dir: workspaceDir, ensureBootstrapFiles: false }),
  ).resolves.toMatchObject({ dir: workspaceDir, bootstrapPending: false });
  await expect(fs.access(path.join(workspaceDir, "BOOTSTRAP.md"))).rejects.toMatchObject({
    code: "ENOENT",
  });
}

describe("Workshop relocation and workspace survival", () => {
  it.each(["skills", ".agents/skills"])(
    "keeps a skill-only workspace usable after moving its last skill from %s",
    async (skillsPath) => {
      const fixture = await createLegacyWorkspace(false, skillsPath);

      await migrateLegacySkillWorkshopProposals({ config: fixture.config, env: state.env });

      await expect(fs.readFile(path.join(fixture.destination, "SKILL.md"), "utf8")).resolves.toBe(
        fixture.content,
      );
      expect(readWorkspaceStateSnapshot(fixture.workspaceDir).attestation).toBeUndefined();
      await expectWorkspaceUsable(fixture.workspaceDir);
    },
  );

  it.each([false, true])(
    "imports legacy workspace evidence before relocating (Doctor preflight: %s)",
    async (doctorOnlyStateMigrations) => {
      const fixture = await createLegacyWorkspace();
      deleteWorkspaceState(prepareWorkspaceStateDeletion(fixture.workspaceDir));
      const marker = resolveLegacyWorkspaceSourcePaths(fixture.workspaceDir, {
        env: state.env,
        homedir: () => state.home,
      }).stateDirAttestationPaths[0]!;
      const attestedAt = new Date();
      await fs.mkdir(path.dirname(marker), { recursive: true });
      await fs.writeFile(
        marker,
        `${LEGACY_WORKSPACE_ATTESTATION_HEADER}\n${attestedAt.toISOString()}\n`,
      );
      await fs.utimes(marker, attestedAt, attestedAt);
      const migrationInput = {
        cfg: fixture.config,
        env: state.env,
        homedir: () => state.home,
        legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
        doctorOnlyStateMigrations,
      };

      await autoMigrateLegacyState(migrationInput);

      await expect(fs.readFile(fixture.created.target.skillFile, "utf8")).resolves.toBe(
        fixture.content,
      );
      expect(readWorkspaceStateSnapshot(fixture.workspaceDir).attestation).toBeUndefined();
      const detected = await detectLegacyStateMigrations({
        ...migrationInput,
        mode: "doctor",
        doctorOnlyStateMigrations: true,
      });
      await runLegacyStateMigrations({
        detected,
        config: fixture.config,
        env: state.env,
        doctorOnlyStateMigrations: true,
        legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
      });

      await expect(fs.access(marker)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readFile(path.join(fixture.destination, "SKILL.md"), "utf8")).resolves.toBe(
        fixture.content,
      );
      await expectWorkspaceUsable(fixture.workspaceDir);
      expect(readWorkspaceStateSnapshot(fixture.workspaceDir).attestation).toBeUndefined();
    },
  );

  it("resumes saved workspace cleanup after a pending proposal write interrupts relocation", async () => {
    const fixture = await createLegacyWorkspace();
    await interruptPendingWrite(fixture);
    closeOpenClawStateDatabaseForTest();

    await migrateLegacySkillWorkshopProposals({ config: fixture.config, env: state.env });

    await expectWorkspaceUsable(fixture.workspaceDir);
    expect(readWorkspaceStateSnapshot(fixture.workspaceDir).attestation).toBeUndefined();
  });

  it("revokes pending relocation cleanup when the workspace is reset", async () => {
    const fixture = await createLegacyWorkspace();
    await interruptPendingWrite(fixture);
    const database = openOpenClawStateDatabase({ env: state.env });
    const receipts = database.db.prepare(
      "SELECT source_key, status FROM migration_sources WHERE migration_kind = ? AND source_path = ?",
    );
    expect(receipts.all(WORKSPACE_CONTENT_RELOCATION_MIGRATION_KIND, fixture.workspaceDir)).toEqual(
      [expect.objectContaining({ status: "prepared" })],
    );

    deleteWorkspaceState(prepareWorkspaceStateDeletion(fixture.workspaceDir));

    expect(receipts.all(WORKSPACE_CONTENT_RELOCATION_MIGRATION_KIND, fixture.workspaceDir)).toEqual(
      [],
    );
    expect(readWorkspaceStateSnapshot(fixture.workspaceDir).attestation).toBeUndefined();
    const projectFile = path.join(fixture.workspaceDir, "README.md");
    await fs.writeFile(projectFile, "# Project created after reset\n");
    await ensureAgentWorkspace({ dir: fixture.workspaceDir, ensureBootstrapFiles: false });
    const refreshed = readWorkspaceStateSnapshot(fixture.workspaceDir).attestation;
    expect(refreshed).toBeDefined();
    await fs.rm(projectFile);
    closeOpenClawStateDatabaseForTest();

    await migrateLegacySkillWorkshopProposals({ config: fixture.config, env: state.env });

    expect(readWorkspaceStateSnapshot(fixture.workspaceDir).attestation).toEqual(refreshed);
    await expect(
      ensureAgentWorkspace({ dir: fixture.workspaceDir, ensureBootstrapFiles: false }),
    ).rejects.toMatchObject({ code: WORKSPACE_VANISHED_ERROR_CODE });
  });

  it.each(["missing", "recreated"] as const)(
    "does not clear the guard when the workspace is %s after interruption",
    async (condition) => {
      const fixture = await createLegacyWorkspace();
      await interruptPendingWrite(fixture);
      const replacement = state.path("replacement-workspace");
      if (condition === "recreated") {
        await fs.mkdir(replacement);
      }
      await fs.rm(fixture.workspaceDir, { recursive: true, force: true });
      if (condition === "recreated") {
        await fs.rename(replacement, fixture.workspaceDir);
      }
      closeOpenClawStateDatabaseForTest();

      await migrateLegacySkillWorkshopProposals({ config: fixture.config, env: state.env });

      expect(readWorkspaceStateSnapshot(fixture.workspaceDir).attestation).toEqual(
        fixture.before.attestation,
      );
      await expect(
        ensureAgentWorkspace({ dir: fixture.workspaceDir, ensureBootstrapFiles: false }),
      ).rejects.toMatchObject({ code: WORKSPACE_VANISHED_ERROR_CODE });
      if (condition === "missing") {
        await expect(fs.access(fixture.workspaceDir)).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
  );

  it("preserves ordinary project content and its attestation", async () => {
    const fixture = await createLegacyWorkspace(true);

    await migrateLegacySkillWorkshopProposals({ config: fixture.config, env: state.env });

    expect(readWorkspaceStateSnapshot(fixture.workspaceDir).attestation).toEqual(
      fixture.before.attestation,
    );
    await expect(fs.readFile(path.join(fixture.workspaceDir, "README.md"), "utf8")).resolves.toBe(
      "# User project\n",
    );
    await expectWorkspaceUsable(fixture.workspaceDir);
  });

  it.each([0, 60_000])(
    "preserves an attestation refreshed after interruption (clock offset: %i)",
    async (clockOffsetMs) => {
      const fixture = await createLegacyWorkspace();
      await interruptPendingWrite(fixture);
      const refreshedAtMs =
        Math.max(Date.now(), fixture.before.attestation!.attestedAtMs + 1) + clockOffsetMs;
      const refreshed = replaceWorkspaceAttestation({
        workspaceDir: fixture.workspaceDir,
        attestedAtMs: refreshedAtMs,
        generatedHashes: new Map(),
        nowMs: refreshedAtMs,
      });
      closeOpenClawStateDatabaseForTest();

      await migrateLegacySkillWorkshopProposals({ config: fixture.config, env: state.env });

      expect(readWorkspaceStateSnapshot(fixture.workspaceDir).attestation).toEqual(refreshed);
      await expect(
        ensureAgentWorkspace({ dir: fixture.workspaceDir, ensureBootstrapFiles: false }),
      ).rejects.toMatchObject({ code: WORKSPACE_VANISHED_ERROR_CODE });
    },
  );
});
