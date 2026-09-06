import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  renderProposalMarkdown,
  stripProposalFrontmatterForSkill,
} from "../skills/workshop/frontmatter.js";
import {
  applySkillProposal,
  listSkillProposals,
  proposeCreateSkill,
  proposeUpdateSkill,
} from "../skills/workshop/service.js";
import { resolveWorkshopSkillsDir } from "../skills/workshop/skills-root.js";
import { readStoredProposal } from "../skills/workshop/store-sqlite-record.js";
import {
  readSkillProposalRollback,
  writeSkillProposalRollback,
} from "../skills/workshop/store-sqlite-rollback.js";
import { hashSkillProposalContent, updateSkillProposalRecord } from "../skills/workshop/store.js";
import {
  SKILL_WORKSHOP_ROLLBACK_SCHEMA,
  type SkillProposalRecord,
  type SkillProposalRollback,
} from "../skills/workshop/types.js";
import { repairOpenClawStateDatabaseSchemaIfNeeded } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { migrateLegacySkillWorkshopProposals } from "./doctor-skill-workshop-sqlite.js";
import {
  createAppliedLegacyProposal,
  expectRelocationWriteFailure,
  expectWorkshopMigrationConverged,
  seedLegacyV15ProposalRows,
} from "./doctor-skill-workshop-sqlite.test-support.js";

const tempDirs = createTrackedTempDirs();
let testState: OpenClawTestState;

beforeEach(async () => {
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-workshop-relocation-atomicity-",
  });
});

afterEach(async () => {
  await testState.cleanup();
  await tempDirs.cleanup();
});

function appliedCreate(params: { id: string; skillName: string; skillDir: string }) {
  const content = `---\nname: ${params.skillName}\ndescription: Relocation procedure\n---\n\n# Procedure\n`;
  const record = createAppliedLegacyProposal({
    id: params.id,
    title: `Create ${params.skillName}`,
    description: "Relocation procedure",
    content,
    target: { skillKey: params.skillName, skillDir: params.skillDir },
  });
  return { record, content };
}

describe("doctor Workshop relocation ownership and commit boundaries", () => {
  it("recovers an applied update with no pending proposal after relocation commit failure", async () => {
    const workspaceDir = await fs.realpath(
      await tempDirs.make("workshop-applied-update-recovery-"),
    );
    const options = { workspaceDir, config: {}, agentId: "main", env: testState.env };
    const name = "applied-update-recovery";
    const create = await proposeCreateSkill({
      ...options,
      name,
      description: "Recover an improved procedure",
      content: "# Original procedure\n",
    });
    const created = await applySkillProposal({
      ...options,
      proposalId: create.record.id,
      expectedRevisionHash: create.revisionHash,
    });
    const update = await proposeUpdateSkill({
      ...options,
      skillName: name,
      content: "# Updated procedure\n\nVerify the final result.\n",
    });
    const updated = await applySkillProposal({
      ...options,
      proposalId: update.record.id,
      expectedRevisionHash: update.revisionHash,
    });
    expect([created.record.status, updated.record.status]).toEqual(["applied", "applied"]);
    const liveContent = await fs.readFile(updated.targetSkillFile, "utf8");
    expect(liveContent).toContain("# Updated procedure");
    const legacySkillDir = path.join(workspaceDir, "skills", name);
    const legacySkillFile = path.join(legacySkillDir, "SKILL.md");
    await fs.mkdir(path.dirname(legacySkillDir), { recursive: true });
    await fs.cp(created.record.target.skillDir, legacySkillDir, { recursive: true });
    await fs.rm(created.record.target.skillDir, { recursive: true });
    const legacyRecords: SkillProposalRecord[] = [];
    for (const record of [created.record, updated.record]) {
      const legacy: SkillProposalRecord = {
        ...record,
        target: {
          ...record.target,
          skillDir: legacySkillDir,
          skillFile: legacySkillFile,
          source: "openclaw-workspace",
        },
      };
      legacyRecords.push(legacy);
      await updateSkillProposalRecord({ record: legacy, store: { env: testState.env } });
    }
    await expectRelocationWriteFailure({
      env: testState.env,
      proposalId: created.record.id,
      message: "applied create relocation metadata unavailable",
    });
    await expect(fs.access(legacySkillDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(updated.targetSkillFile, "utf8")).resolves.toBe(liveContent);
    expect(readStoredProposal(created.record.id, { env: testState.env })?.record).toEqual(
      legacyRecords[0],
    );

    const recovered = await migrateLegacySkillWorkshopProposals({
      config: {},
      env: testState.env,
    });

    expect(recovered.warnings).toEqual([]);
    expect(readStoredProposal(created.record.id, { env: testState.env })?.record).toMatchObject({
      status: "applied",
      target: created.record.target,
    });
    expect(readStoredProposal(updated.record.id, { env: testState.env })?.record).toEqual(
      legacyRecords[1],
    );
    await expect(fs.readFile(updated.targetSkillFile, "utf8")).resolves.toBe(liveContent);
    await expect(
      migrateLegacySkillWorkshopProposals({ config: {}, env: testState.env }),
    ).resolves.toMatchObject({ changes: [], warnings: [], migrated: 0 });
  });

  it.each([
    { version: "original", state: "unstarted", relocation: "retry" },
    { version: "improved", state: "unstarted", relocation: "retry" },
    { version: "display-name", state: "unstarted", relocation: "retry" },
    { version: "original", state: "partial", relocation: "direct" },
    { version: "original", state: "complete", relocation: "direct" },
    { version: "original", state: "partial", relocation: "retry" },
    { version: "original", state: "complete", relocation: "retry" },
    { version: "original", state: "wrong-target", relocation: "direct" },
    { version: "original", state: "foreign-support", relocation: "direct" },
    { version: "original", state: "missing-source", relocation: "direct" },
  ] as const)(
    "handles $state $version update recovery after $relocation relocation",
    async ({ version, state, relocation }) => {
      const workspaceDir = await fs.realpath(await tempDirs.make("workshop-metadata-failure-"));
      const options = { config: {}, agentId: "main", env: testState.env };
      const created = appliedCreate({
        id: "atomic-create-20260901-1234567890",
        skillName: "atomic-skill",
        skillDir: path.join(workspaceDir, "skills", "atomic-skill"),
      });
      const previousContent =
        version === "display-name"
          ? '---\nname: Atomic Guide\ndescription: Relocation procedure\nmetadata: {"openclaw":{"skillKey":"atomic-skill"}}\n---\n\n# Improved procedure\n'
          : version === "improved"
            ? `${created.content}\nVerify the result before continuing.\n`
            : created.content;
      const skillName =
        version === "display-name" ? "Atomic Guide" : created.record.target.skillName;
      const draft = renderProposalMarkdown({
        name: skillName,
        description: created.record.description,
        content: "# Updated procedure\n\nRecord the verified result.\n",
        fallbackFrontmatterContent: previousContent,
        date: created.record.createdAt,
      });
      const proposedContent = stripProposalFrontmatterForSkill(draft);
      const previousSupport = "Original verification steps.\n";
      const proposedSupport = "Updated verification steps.\n";
      const supportPath = "references/verification.md";
      const liveContent =
        state === "unstarted" || state === "partial" ? previousContent : proposedContent;
      const pending: SkillProposalRecord = {
        ...created.record,
        id: "atomic-update-20260901-1234567890",
        kind: "update",
        status: "pending",
        appliedAt: undefined,
        draftHash: hashSkillProposalContent(
          state === "unstarted" ? `${created.content}\nRecord the result.\n` : draft,
        ),
        ...(state === "unstarted"
          ? {}
          : {
              supportFiles: [
                {
                  path: supportPath,
                  sizeBytes: Buffer.byteLength(proposedSupport),
                  hash: hashSkillProposalContent(proposedSupport),
                  targetExisted: true,
                  targetContentHash: hashSkillProposalContent(previousSupport),
                },
              ],
            }),
        target: {
          ...created.record.target,
          skillName,
          currentContentHash: hashSkillProposalContent(previousContent),
        },
      };
      const rollback: SkillProposalRollback = {
        schema: SKILL_WORKSHOP_ROLLBACK_SCHEMA,
        proposalId: pending.id,
        action: "update",
        writtenAt: created.record.createdAt,
        targetSkillFile:
          state === "wrong-target"
            ? path.join(workspaceDir, "skills", "unrelated", "SKILL.md")
            : pending.target.skillFile,
        previousContent,
        previousContentHash: hashSkillProposalContent(previousContent),
        supportFiles: [
          {
            path: supportPath,
            existed: true,
            previousContent: previousSupport,
            previousContentHash: hashSkillProposalContent(previousSupport),
          },
        ],
      };
      await fs.mkdir(created.record.target.skillDir, { recursive: true });
      await fs.writeFile(created.record.target.skillFile, liveContent);
      if (state !== "unstarted") {
        await fs.mkdir(path.join(created.record.target.skillDir, "references"), {
          recursive: true,
        });
        await fs.writeFile(
          path.join(created.record.target.skillDir, supportPath),
          state === "foreign-support" ? "External verification steps.\n" : proposedSupport,
        );
        const proposalDir = path.join(
          testState.stateDir,
          "skill-workshop",
          "proposals",
          pending.id,
        );
        await fs.mkdir(path.join(proposalDir, "references"), { recursive: true });
        await fs.writeFile(path.join(proposalDir, pending.draftFile), draft);
        await fs.writeFile(path.join(proposalDir, supportPath), proposedSupport);
      }
      seedLegacyV15ProposalRows(testState.env, [
        { record: created.record, workspaceDir, claimReleasedTime: null },
        { record: pending, workspaceDir, claimReleasedTime: null },
      ]);
      repairOpenClawStateDatabaseSchemaIfNeeded({ env: testState.env });
      if (state !== "unstarted") {
        await writeSkillProposalRollback({ proposalId: pending.id, rollback, store: options });
      }
      const destinationDir = path.join(
        resolveWorkshopSkillsDir({}, "main", testState.env),
        "atomic-skill",
      );
      const relocatedTarget = {
        skillDir: destinationDir,
        skillFile: path.join(destinationDir, "SKILL.md"),
        source: "openclaw-workshop",
      };
      const destinationSupportFile = path.join(destinationDir, supportPath);
      if (state === "missing-source") {
        await fs.mkdir(path.dirname(destinationDir), { recursive: true });
        await fs.rename(created.record.target.skillDir, destinationDir);
      }
      if (relocation === "retry") {
        await expectRelocationWriteFailure({
          env: testState.env,
          proposalId: state === "complete" ? created.record.id : pending.id,
          status: state === "complete" ? "applied" : "pending",
          message: "relocation metadata unavailable",
        });
        expect(readStoredProposal(created.record.id, options)?.record).toEqual(created.record);
        if (state === "complete") {
          expect(readStoredProposal(pending.id, options)?.record).toMatchObject({
            status: "applied",
            target: pending.target,
          });
        } else {
          expect(readStoredProposal(pending.id, options)?.record).toEqual(pending);
        }
        await expect(readSkillProposalRollback(pending.id, options)).resolves.toEqual(
          state === "complete" ? rollback : null,
        );
        await expect(fs.access(created.record.target.skillDir)).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(fs.readFile(relocatedTarget.skillFile, "utf8")).resolves.toBe(
          state === "partial" ? previousContent : liveContent,
        );
      }

      const migration = await migrateLegacySkillWorkshopProposals(options);
      const deferred =
        state === "wrong-target" || state === "foreign-support" || state === "missing-source";
      if (deferred) {
        expect(migration).toMatchObject({
          changes: [],
          warnings: [expect.stringContaining(pending.id)],
        });
        expect(readStoredProposal(created.record.id, options)?.record).toEqual(created.record);
        expect(readStoredProposal(pending.id, options)?.record).toEqual(pending);
        await expect(readSkillProposalRollback(pending.id, options)).resolves.toEqual(rollback);
        const retainedDir =
          state === "missing-source" ? destinationDir : created.record.target.skillDir;
        await expect(fs.readFile(path.join(retainedDir, "SKILL.md"), "utf8")).resolves.toBe(
          liveContent,
        );
        await expect(fs.readFile(path.join(retainedDir, supportPath), "utf8")).resolves.toBe(
          state === "foreign-support" ? "External verification steps.\n" : proposedSupport,
        );
        await expect(
          fs.access(state === "missing-source" ? created.record.target.skillDir : destinationDir),
        ).rejects.toMatchObject({ code: "ENOENT" });
        await expect(listSkillProposals(options)).resolves.toMatchObject({
          proposals: expect.arrayContaining([
            expect.objectContaining({ id: pending.id, status: "pending" }),
          ]),
        });
        return;
      }
      expect(migration.warnings).toEqual([]);
      await expect(fs.access(created.record.target.skillDir)).rejects.toMatchObject({
        code: "ENOENT",
      });
      const expectedStatus = state === "complete" ? "applied" : "pending";
      await expect(listSkillProposals(options)).resolves.toMatchObject({
        proposals: expect.arrayContaining([
          expect.objectContaining({ id: pending.id, status: expectedStatus }),
        ]),
      });
      expect(readStoredProposal(created.record.id, options)?.record).toMatchObject({
        status: "applied",
        target: relocatedTarget,
      });
      expect(readStoredProposal(pending.id, options)?.record).toMatchObject({
        status: expectedStatus,
        target: state === "complete" ? pending.target : relocatedTarget,
      });
      await expect(fs.readFile(relocatedTarget.skillFile, "utf8")).resolves.toBe(
        state === "partial" ? previousContent : liveContent,
      );
      if (state !== "unstarted") {
        await expect(fs.readFile(destinationSupportFile, "utf8")).resolves.toBe(
          state === "partial" ? previousSupport : proposedSupport,
        );
      }
      await expect(readSkillProposalRollback(pending.id, options)).resolves.toEqual(
        state === "complete" ? rollback : null,
      );
      if (state === "partial") {
        await expect(
          applySkillProposal({ ...options, workspaceDir, proposalId: pending.id }),
        ).resolves.toMatchObject({ record: { status: "applied" } });
        await expect(fs.readFile(relocatedTarget.skillFile, "utf8")).resolves.toBe(proposedContent);
        await expect(fs.readFile(destinationSupportFile, "utf8")).resolves.toBe(proposedSupport);
      }
      if (state === "unstarted") {
        await expectWorkshopMigrationConverged({ env: testState.env });
      } else {
        await expect(migrateLegacySkillWorkshopProposals(options)).resolves.toEqual({
          changes: [],
          warnings: [],
          detected: 1,
          migrated: 0,
        });
      }
    },
  );

  it.each(["partial", "complete"] as const)(
    "recovers a %s pending create before assigning relocation ownership",
    async (state) => {
      const workspaceDir = await fs.realpath(await tempDirs.make("workshop-create-recovery-"));
      const options = { config: {}, agentId: "main", env: testState.env };
      const legacy = appliedCreate({
        id: "interrupted-create-20260901-1234567890",
        skillName: "interrupted-create",
        skillDir: path.join(workspaceDir, "skills", "interrupted-create"),
      });
      const draft = renderProposalMarkdown({
        name: legacy.record.target.skillKey,
        description: legacy.record.description,
        content: "# Procedure\n\nVerify the input before continuing.\n",
        date: legacy.record.createdAt,
      });
      const proposedContent = stripProposalFrontmatterForSkill(draft);
      const supportPath = "references/verification.md";
      const supportContent = "Created verification steps.\n";
      const pending: SkillProposalRecord = {
        ...legacy.record,
        status: "pending",
        appliedAt: undefined,
        draftHash: hashSkillProposalContent(draft),
        supportFiles: [
          {
            path: supportPath,
            sizeBytes: Buffer.byteLength(supportContent),
            hash: hashSkillProposalContent(supportContent),
          },
        ],
      };
      const rollback: SkillProposalRollback = {
        schema: SKILL_WORKSHOP_ROLLBACK_SCHEMA,
        proposalId: pending.id,
        action: "create",
        writtenAt: pending.createdAt,
        targetSkillFile: pending.target.skillFile,
        supportFiles: [{ path: supportPath, existed: false }],
      };
      await fs.mkdir(path.join(pending.target.skillDir, "references"), { recursive: true });
      await fs.writeFile(path.join(pending.target.skillDir, supportPath), supportContent);
      const unrelatedFile = path.join(pending.target.skillDir, "references", "operator-notes.md");
      if (state === "complete") {
        await fs.writeFile(pending.target.skillFile, proposedContent);
      } else {
        await fs.writeFile(unrelatedFile, "Operator-owned notes.\n");
      }
      const proposalDir = path.join(testState.stateDir, "skill-workshop", "proposals", pending.id);
      await fs.mkdir(path.join(proposalDir, "references"), { recursive: true });
      await fs.writeFile(path.join(proposalDir, pending.draftFile), draft);
      await fs.writeFile(path.join(proposalDir, supportPath), supportContent);
      seedLegacyV15ProposalRows(testState.env, [
        { record: pending, workspaceDir, claimReleasedTime: null },
      ]);
      repairOpenClawStateDatabaseSchemaIfNeeded({ env: testState.env });
      await writeSkillProposalRollback({ proposalId: pending.id, rollback, store: options });
      expect(readStoredProposal(pending.id, options)?.record).toEqual(pending);
      const destinationDir = path.join(
        resolveWorkshopSkillsDir({}, "main", testState.env),
        pending.target.skillKey,
      );
      const destinationSkillFile = path.join(destinationDir, "SKILL.md");
      await expect(fs.access(destinationDir)).rejects.toMatchObject({ code: "ENOENT" });

      const migration = await migrateLegacySkillWorkshopProposals(options);

      expect(migration.warnings).toEqual([]);
      await expect(listSkillProposals(options)).resolves.toMatchObject({
        proposals: [
          expect.objectContaining({
            id: pending.id,
            status: state === "complete" ? "applied" : "pending",
          }),
        ],
      });
      expect(readStoredProposal(pending.id, options)?.record).toMatchObject({
        target: {
          skillDir: destinationDir,
          skillFile: destinationSkillFile,
          source: "openclaw-workshop",
        },
      });
      await expect(readSkillProposalRollback(pending.id, options)).resolves.toEqual(
        state === "complete" ? rollback : null,
      );
      if (state === "partial") {
        await expect(
          fs.access(path.join(pending.target.skillDir, supportPath)),
        ).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.access(pending.target.skillFile)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.readFile(unrelatedFile, "utf8")).resolves.toBe("Operator-owned notes.\n");
        await expect(fs.access(destinationDir)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(
          applySkillProposal({ ...options, workspaceDir, proposalId: pending.id }),
        ).resolves.toMatchObject({ record: { status: "applied" } });
        await expect(fs.readFile(unrelatedFile, "utf8")).resolves.toBe("Operator-owned notes.\n");
      } else {
        await expect(fs.access(pending.target.skillDir)).rejects.toMatchObject({ code: "ENOENT" });
      }
      await expect(fs.readFile(destinationSkillFile, "utf8")).resolves.toBe(proposedContent);
      await expect(fs.readFile(path.join(destinationDir, supportPath), "utf8")).resolves.toBe(
        supportContent,
      );
      await expect(migrateLegacySkillWorkshopProposals(options)).resolves.toEqual({
        changes: [],
        warnings: [],
        detected: 1,
        migrated: 0,
      });
    },
  );

  it("leaves one source untouched when applied records claim different agent destinations", async () => {
    const workspaceDir = await fs.realpath(await tempDirs.make("workshop-conflicting-owners-"));
    const skillDir = path.join(workspaceDir, "skills", "shared-skill");
    const config = {
      agents: {
        ownership: "explicit" as const,
        entries: {
          alpha: { workspace: workspaceDir, agentDir: path.join(workspaceDir, ".alpha") },
          beta: { workspace: workspaceDir, agentDir: path.join(workspaceDir, ".beta") },
        },
      },
    };
    const claims = ["alpha", "beta"].map((agentId) => {
      const { record, content } = appliedCreate({
        id: `shared-${agentId}-20260901-1234567890`,
        skillName: "shared-skill",
        skillDir,
      });
      return { agentId, record, content };
    });
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), claims[0]!.content);
    seedLegacyV15ProposalRows(
      testState.env,
      claims.map(({ record, agentId }) => ({
        record,
        workspaceDir,
        ownerAgentId: agentId,
        claimReleasedTime: null,
      })),
    );

    await migrateLegacySkillWorkshopProposals({ config, env: testState.env });

    await expect(fs.readFile(path.join(skillDir, "SKILL.md"), "utf8")).resolves.toBe(
      claims[0]!.content,
    );
    for (const { record, agentId } of claims) {
      const stored = readStoredProposal(record.id, { env: testState.env })?.record;
      expect(stored).toMatchObject({ status: "stale", target: record.target });
      expect(stored?.statusReason).toContain("relocation conflict");
      await expect(
        fs.access(
          path.join(resolveWorkshopSkillsDir(config, agentId, testState.env), "shared-skill"),
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
    }
    await expectWorkshopMigrationConverged({ config, env: testState.env });
  });

  it.each([
    { order: "parent first", childFirst: false, childClaim: true },
    { order: "child first", childFirst: true, childClaim: true },
    { order: "no child claim", childFirst: false, childClaim: false },
  ])(
    "preserves overlapping sources across configured workspaces ($order)",
    async ({ childFirst, childClaim }) => {
      const workspaceDir = await fs.realpath(await tempDirs.make("workshop-nested-workspaces-"));
      const nestedWorkspace = path.join(workspaceDir, "skills", "parent-skill");
      const config = {
        agents: {
          ownership: "explicit" as const,
          entries: {
            alpha: { workspace: workspaceDir },
            beta: { workspace: nestedWorkspace },
          },
        },
      };
      const claims = [
        {
          agentId: "alpha",
          workspaceDir,
          ...appliedCreate({
            id: "nested-parent-20260901-1234567890",
            skillName: "parent-skill",
            skillDir: nestedWorkspace,
          }),
        },
        {
          agentId: "beta",
          workspaceDir: nestedWorkspace,
          ...appliedCreate({
            id: "nested-child-20260901-1234567890",
            skillName: "child-skill",
            skillDir: path.join(nestedWorkspace, "skills", "child-skill"),
          }),
        },
      ];
      for (const { record, content } of claims) {
        await fs.mkdir(record.target.skillDir, { recursive: true });
        await fs.writeFile(record.target.skillFile, content);
      }
      const active = childClaim ? claims : [claims[0]!];
      const ordered = childFirst ? active.toReversed() : active;
      seedLegacyV15ProposalRows(
        testState.env,
        ordered.map(({ record, agentId, workspaceDir: sourceWorkspace }) => ({
          record,
          workspaceDir: sourceWorkspace,
          ownerAgentId: agentId,
          claimReleasedTime: null,
        })),
      );

      const result = await migrateLegacySkillWorkshopProposals({ config, env: testState.env });

      expect(result.warnings).toEqual([]);
      expect(result.changes.join("\n")).toContain(`marked ${active.length} stale`);
      for (const { record, content, agentId } of claims) {
        await expect(fs.readFile(record.target.skillFile, "utf8")).resolves.toBe(content);
        if (!active.some((claim) => claim.record.id === record.id)) {
          expect(readStoredProposal(record.id, { env: testState.env })).toBeNull();
          continue;
        }
        expect(readStoredProposal(record.id, { env: testState.env })?.record).toMatchObject({
          status: "stale",
          target: record.target,
          statusReason: expect.stringContaining("relocation conflict"),
        });
        await expect(
          fs.access(
            path.join(
              resolveWorkshopSkillsDir(config, agentId, testState.env),
              record.target.skillKey,
            ),
          ),
        ).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
  );
});
