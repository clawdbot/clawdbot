import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applySkillProposal,
  listSkillProposals,
  proposeCreateSkill,
  proposeUpdateSkill,
} from "../skills/workshop/service.js";
import { resolveWorkshopSkillsDir } from "../skills/workshop/skills-root.js";
import {
  writeSkillProposalRollback,
  readSkillProposalRollback,
} from "../skills/workshop/store-sqlite-rollback.js";
import { hashSkillProposalContent, importLegacySkillProposal } from "../skills/workshop/store.js";
import * as workshopStore from "../skills/workshop/store.js";
import {
  SKILL_WORKSHOP_ROLLBACK_SCHEMA,
  SKILL_WORKSHOP_SCHEMA,
  type SkillProposalRecord,
  type SkillProposalRollback,
} from "../skills/workshop/types.js";
import { repairOpenClawStateDatabaseSchemaIfNeeded } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { planWorkshopRelocation } from "./doctor-skill-workshop-relocation.js";
import {
  inspectLegacySkillWorkshopMigration,
  migrateLegacySkillWorkshopProposals,
} from "./doctor-skill-workshop-sqlite.js";
import {
  createAppliedLegacyProposal,
  expectRelocationWriteFailure,
  expectWorkshopMigrationConverged,
  readSkillProposalRecord,
  seedLegacyV15ProposalRows,
} from "./doctor-skill-workshop-sqlite.test-support.js";

const tempDirs = createTrackedTempDirs();
let testState: OpenClawTestState;

beforeEach(async () => {
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-doctor-workshop-sqlite-",
  });
});

afterEach(async () => {
  await testState.cleanup();
  await tempDirs.cleanup();
});
describe("doctor Skill Workshop SQLite relocation conflicts and recovery", () => {
  it.each(["create", "update"] as const)(
    "retires a missing %s draft without losing valid drafts or recovery files",
    async (kind) => {
      const options = {
        config: {},
        env: testState.env,
        agentId: "main",
        workspaceDir: testState.workspaceDir,
      };
      const targetDir = path.join(
        resolveWorkshopSkillsDir({}, "main", testState.env),
        "missing-draft",
      );
      const installed =
        "---\nname: missing-draft\ndescription: Existing procedure\n---\n\nKeep the existing procedure.\n";
      if (kind === "update") {
        await fs.mkdir(targetDir, { recursive: true });
        await fs.writeFile(path.join(targetDir, "SKILL.md"), installed);
      }
      const input = {
        ...options,
        description: "Missing draft fixture",
        content: "# Proposed procedure\n",
        supportFiles: [{ path: "references/proof.md", content: "Keep recovery evidence.\n" }],
      };
      const missing =
        kind === "create"
          ? await proposeCreateSkill({ ...input, name: "missing-draft" })
          : await proposeUpdateSkill({ ...input, skillName: "missing-draft" });
      const valid = await proposeCreateSkill({
        ...options,
        name: "valid-draft",
        description: "Valid sibling",
        content: "# Valid procedure\n\nKeep this draft.\n",
      });
      const draftFile = path.join(
        testState.stateDir,
        "skill-workshop",
        "proposals",
        missing.record.id,
        missing.record.draftFile,
      );
      await fs.unlink(draftFile);

      expect(
        (await listSkillProposals(options)).proposals.find(
          (record) => record.id === missing.record.id,
        ),
      ).toMatchObject({ status: "pending", degradedState: "draft-missing" });
      await migrateLegacySkillWorkshopProposals(options);
      expect((await readSkillProposalRecord(missing.record.id, options))?.status).toBe("pending");
      const repaired = await migrateLegacySkillWorkshopProposals({
        ...options,
        retireMissingDrafts: true,
      });
      expect(repaired.warnings).toEqual([]);
      expect(repaired.changes.join("\n")).toContain("marked 1 stale");
      expect(await readSkillProposalRecord(missing.record.id, options)).toMatchObject({
        status: "stale",
        draftHash: missing.record.draftHash,
        supportFiles: missing.record.supportFiles,
        statusReason: expect.stringContaining("draft is missing"),
      });
      await expect(
        fs.readFile(path.join(path.dirname(draftFile), "references/proof.md"), "utf8"),
      ).resolves.toBe("Keep recovery evidence.\n");
      const unchanged = await workshopStore.readSkillProposal(valid.record.id, options, options, {
        config: {},
      });
      expect(unchanged?.record).toEqual(valid.record);
      expect(unchanged?.content).toBe(valid.content);
      if (kind === "update") {
        await expect(fs.readFile(path.join(targetDir, "SKILL.md"), "utf8")).resolves.toBe(
          installed,
        );
      } else {
        await expect(fs.access(targetDir)).rejects.toThrow();
      }
      await expect(
        migrateLegacySkillWorkshopProposals({ ...options, retireMissingDrafts: true }),
      ).resolves.toEqual({ changes: [], warnings: [], detected: 2, migrated: 0 });
    },
  );

  it("preserves unfinished apply recovery when its draft is missing", async () => {
    const options = {
      config: {},
      env: testState.env,
      agentId: "main",
      workspaceDir: testState.workspaceDir,
    };
    const proposal = await proposeCreateSkill({
      ...options,
      name: "unfinished-draft",
      description: "Unfinished apply",
      content: "# Pending procedure\n",
    });
    const rollback: SkillProposalRollback = {
      schema: SKILL_WORKSHOP_ROLLBACK_SCHEMA,
      proposalId: proposal.record.id,
      writtenAt: proposal.record.createdAt,
      targetSkillFile: proposal.record.target.skillFile,
      action: "create",
    };
    await writeSkillProposalRollback({ proposalId: proposal.record.id, rollback, store: options });
    await fs.unlink(
      path.join(
        testState.stateDir,
        "skill-workshop",
        "proposals",
        proposal.record.id,
        proposal.record.draftFile,
      ),
    );

    const result = await migrateLegacySkillWorkshopProposals({
      ...options,
      retireMissingDrafts: true,
    });
    expect(result.changes).toEqual([]);
    expect(result.warnings.join("\n")).toContain("unfinished apply recovery");
    expect((await readSkillProposalRecord(proposal.record.id, options))?.status).toBe("pending");
    expect(await readSkillProposalRollback(proposal.record.id, options)).toEqual(rollback);
  });

  it("stales an applied legacy directory without a loadable skill file", async () => {
    const workspaceDir = await fs.realpath(
      await tempDirs.make("openclaw-workshop-invalid-relocation-workspace-"),
    );
    const skillDir = path.join(workspaceDir, "skills", "invalid-relocation");
    const record = createAppliedLegacyProposal({
      id: "invalid-relocation-20260901-1234567890",
      title: "Create Invalid Relocation",
      description: "Invalid relocation",
      content: "invalid relocation",
      target: { skillKey: "invalid-relocation", skillDir },
    });
    await fs.mkdir(skillDir, { recursive: true });
    seedLegacyV15ProposalRows(testState.env, [{ record, workspaceDir, claimReleasedTime: null }]);

    const result = await migrateLegacySkillWorkshopProposals({
      config: {},
      env: testState.env,
    });

    expect(result.changes.join("\n")).toContain(
      "Relocated 0 Skill Workshop skills, retargeted 0 proposals, marked 1 stale",
    );
    await expect(fs.access(skillDir)).resolves.toBeUndefined();
    await expect(
      fs.access(
        path.join(resolveWorkshopSkillsDir({}, "main", testState.env), "invalid-relocation"),
      ),
    ).rejects.toThrow();
    await expect(readSkillProposalRecord(record.id, { env: testState.env })).resolves.toMatchObject(
      {
        status: "stale",
        statusReason: expect.stringContaining("could not load"),
        target: { skillDir },
      },
    );
  });

  it
    .runIf(process.platform !== "win32")
    .each([
      "skill leaf",
      "external parent",
      "destination parent",
      "contained parent",
      "workspace root",
    ] as const)("preserves relocation ownership through a linked %s", async (linkedComponent) => {
    const workspaceDir = await fs.realpath(
      await tempDirs.make("openclaw-workshop-symlink-workspace-"),
    );
    const externalRoot = await fs.realpath(
      await tempDirs.make("openclaw-workshop-symlink-target-"),
    );
    const rootAlias = linkedComponent === "workspace root";
    const configuredWorkspace = rootAlias
      ? path.join(externalRoot, "workspace-alias")
      : workspaceDir;
    const config = {
      agents: { entries: { main: { workspace: configuredWorkspace } } },
    };
    const workshopRoot = resolveWorkshopSkillsDir(config, "main", testState.env);
    const skillsDir = path.join(workspaceDir, "skills");
    const symlinkedSkillName = "linked-workshop";
    const normalSkillName = "normal-workshop";
    const symlinkedSkillDir = path.join(skillsDir, symlinkedSkillName);
    const symlinkedSkillFile = path.join(symlinkedSkillDir, "SKILL.md");
    const normalSkillDir = path.join(workspaceDir, ".agents", "skills", normalSkillName);
    const normalSkillFile = path.join(normalSkillDir, "SKILL.md");
    const linkedRoot =
      linkedComponent === "destination parent"
        ? workshopRoot
        : linkedComponent === "contained parent"
          ? path.join(workspaceDir, "shared-skills")
          : rootAlias
            ? skillsDir
            : externalRoot;
    const realSkillDir =
      linkedComponent === "skill leaf" ? linkedRoot : path.join(linkedRoot, symlinkedSkillName);
    const symlinkPath = rootAlias
      ? configuredWorkspace
      : linkedComponent === "skill leaf"
        ? symlinkedSkillDir
        : skillsDir;
    const symlinkTarget = rootAlias ? workspaceDir : linkedRoot;
    const symlinkedContent =
      "---\nname: linked-workshop\ndescription: Linked procedure\n---\n\n# Linked\n";
    const supportContent = "Shared support data must survive relocation.\n";
    const sentinelContent = "Unrelated shared content.\n";
    const normalContent =
      "---\nname: normal-workshop\ndescription: Normal procedure\n---\n\n# Normal\n";
    const records = [
      {
        id: "linked-workshop-20260901-1234567890",
        skillName: "linked-workshop",
        skillDir: symlinkedSkillDir,
        content: symlinkedContent,
      },
      {
        id: "normal-workshop-20260901-1234567890",
        skillName: "normal-workshop",
        skillDir: normalSkillDir,
        content: normalContent,
      },
    ].map(({ id, skillName, skillDir, content }) => ({
      record: createAppliedLegacyProposal({
        id,
        title: `Create ${skillName}`,
        description: `${skillName} procedure`,
        content,
        target: {
          skillKey: skillName,
          skillDir,
          source: skillName === normalSkillName ? "agents-skills-project" : "openclaw-workspace",
        },
      }),
      workspaceDir,
    }));

    await fs.mkdir(path.join(realSkillDir, "references"), { recursive: true });
    await fs.writeFile(path.join(realSkillDir, "SKILL.md"), symlinkedContent, "utf8");
    await fs.writeFile(path.join(realSkillDir, "references", "data.txt"), supportContent);
    await fs.writeFile(path.join(linkedRoot, "unrelated.txt"), sentinelContent);
    await fs.mkdir(normalSkillDir, { recursive: true });
    await fs.writeFile(normalSkillFile, normalContent, "utf8");
    await fs.mkdir(path.dirname(symlinkPath), { recursive: true });
    await fs.symlink(symlinkTarget, symlinkPath, "dir");
    seedLegacyV15ProposalRows(
      testState.env,
      records.map(({ record, workspaceDir: recordWorkspaceDir }) => ({
        record,
        workspaceDir: recordWorkspaceDir,
        claimReleasedTime: null,
      })),
    );

    const symlinkedReason = `Skill Workshop no longer writes through symlinked skills; ${symlinkedSkillDir} stays a workspace skill.`;
    const first = await migrateLegacySkillWorkshopProposals({
      config,
      env: testState.env,
    });
    expect(first.changes.join("\n")).toContain(
      rootAlias
        ? "Relocated 2 Skill Workshop skills, retargeted 2 proposals, marked 0 stale"
        : "Relocated 1 Skill Workshop skill, retargeted 1 proposal, marked 1 stale",
    );
    await expect(fs.lstat(symlinkPath)).resolves.toSatisfy((stat) => stat.isSymbolicLink());
    await expect(fs.readlink(symlinkPath)).resolves.toBe(symlinkTarget);
    const preservedSkillDir = rootAlias
      ? path.join(workshopRoot, symlinkedSkillName)
      : realSkillDir;
    await expect(fs.readFile(path.join(preservedSkillDir, "SKILL.md"), "utf8")).resolves.toBe(
      symlinkedContent,
    );
    await expect(
      fs.readFile(path.join(preservedSkillDir, "references", "data.txt"), "utf8"),
    ).resolves.toBe(supportContent);
    await expect(fs.readFile(path.join(linkedRoot, "unrelated.txt"), "utf8")).resolves.toBe(
      sentinelContent,
    );
    if (!rootAlias && linkedComponent !== "destination parent") {
      await expect(fs.access(path.join(workshopRoot, symlinkedSkillName))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
    await expect(
      fs.readFile(path.join(workshopRoot, normalSkillName, "SKILL.md"), "utf8"),
    ).resolves.toBe(normalContent);
    const firstRecord = await readSkillProposalRecord("linked-workshop-20260901-1234567890", {
      env: testState.env,
    });
    expect(firstRecord).toMatchObject({
      status: rootAlias ? "applied" : "stale",
      ...(rootAlias ? {} : { statusReason: symlinkedReason }),
      target: {
        skillDir: rootAlias ? preservedSkillDir : symlinkedSkillDir,
        skillFile: rootAlias ? path.join(preservedSkillDir, "SKILL.md") : symlinkedSkillFile,
        source: rootAlias ? "openclaw-workshop" : "openclaw-workspace",
      },
    });
    await expect(
      inspectLegacySkillWorkshopMigration({ config, env: testState.env }),
    ).resolves.toEqual({
      externalProposalCount: 0,
      externalProposalCountsByAgent: {},
      legacyBackupRootCount: 0,
      preservedLegacyBackupRootCount: 0,
    });
    await expectWorkshopMigrationConverged({ config, env: testState.env });
    await expect(
      readSkillProposalRecord("linked-workshop-20260901-1234567890", { env: testState.env }),
    ).resolves.toEqual(firstRecord);
  });

  it("stales an adoption when the destination is a different skill", async () => {
    const workspaceDir = await fs.realpath(
      await tempDirs.make("openclaw-workshop-unverified-adoption-workspace-"),
    );
    const legacySkillDir = path.join(workspaceDir, "skills", "verified-adoption");
    const destination = path.join(
      resolveWorkshopSkillsDir({}, "main", testState.env),
      "verified-adoption",
    );
    const expectedContent =
      "---\nname: verified-adoption\ndescription: Verified procedure\n---\n\n# Verified\n";
    const destinationContent =
      "---\nname: unrelated-skill\ndescription: Unrelated procedure\n---\n\n# Unrelated\n";
    const record = createAppliedLegacyProposal({
      id: "verified-adoption-20260901-1234567890",
      title: "Create Verified Adoption",
      description: "Verified procedure",
      content: expectedContent,
      target: { skillKey: "verified-adoption", skillDir: legacySkillDir },
    });
    await fs.mkdir(destination, { recursive: true });
    await fs.writeFile(path.join(destination, "SKILL.md"), destinationContent, "utf8");
    seedLegacyV15ProposalRows(testState.env, [{ record, workspaceDir, claimReleasedTime: null }]);

    const result = await migrateLegacySkillWorkshopProposals({ config: {}, env: testState.env });

    expect(result.changes.join("\n")).toContain(
      "Relocated 0 Skill Workshop skills, retargeted 0 proposals, marked 1 stale",
    );
    await expect(fs.readFile(path.join(destination, "SKILL.md"), "utf8")).resolves.toBe(
      destinationContent,
    );
    await expect(readSkillProposalRecord(record.id, { env: testState.env })).resolves.toMatchObject(
      {
        status: "stale",
        statusReason: expect.stringContaining("identity mismatch"),
        target: { skillDir: legacySkillDir, skillFile: record.target.skillFile },
      },
    );
  });

  it.each([false, true])(
    "shares adoption proof across historical creates (matching first: %s)",
    async (matchingFirst) => {
      const workspaceDir = await fs.realpath(
        await tempDirs.make("openclaw-workshop-repeated-adoption-workspace-"),
      );
      const workshopRoot = resolveWorkshopSkillsDir({}, "main", testState.env);
      const now = "2026-09-01T00:00:00.000Z";
      const records = ["first-adoption", "second-adoption", "first-adoption", "first-adoption"].map(
        (name, index) => {
          const skillDir = path.join(workspaceDir, "skills", name);
          const content = `---\nname: ${name}\ndescription: ${name} procedure\n---\n\n# ${name}\n`;
          return {
            content,
            record: {
              ...createAppliedLegacyProposal({
                id: `${name}-20260901-123456789${index}`,
                title: `Create ${name}`,
                description: `${name} procedure`,
                content: index === 0 ? "unmatched content" : content,
                createdAt: now,
                target: { skillKey: name, skillDir },
              }),
              kind: index === 3 ? "update" : "create",
              status: index === 3 ? "pending" : "applied",
              appliedAt: index === 3 ? undefined : now,
            } satisfies SkillProposalRecord,
          };
        },
      );
      for (const { record, content } of records.slice(0, 2)) {
        const destination = path.join(workshopRoot, record.target.skillKey);
        await fs.mkdir(destination, { recursive: true });
        await fs.writeFile(path.join(destination, "SKILL.md"), content);
      }

      const ordered = matchingFirst
        ? [records[2]!, records[1]!, records[0]!, records[3]!]
        : records;
      const plan = await planWorkshopRelocation(
        ordered.map(({ record }) => ({ record, ownerAgentId: "main" })),
        {},
        testState.env,
      );

      expect(
        plan.moves
          .map(({ operation, destination, updates }) => ({
            operation,
            destination,
            proposalIds: updates.map(({ record }) => record.id).toSorted(),
          }))
          .toSorted((left, right) => left.destination.localeCompare(right.destination)),
      ).toEqual([
        {
          operation: "adopt",
          destination: path.join(workshopRoot, "first-adoption"),
          proposalIds: [records[0]!.record.id, records[2]!.record.id, records[3]!.record.id],
        },
        {
          operation: "adopt",
          destination: path.join(workshopRoot, "second-adoption"),
          proposalIds: [records[1]!.record.id],
        },
      ]);
      expect(plan.updates).toEqual([]);
    },
  );

  it.each(["removed source", "retained source", "changed source metadata"])(
    "recovers a real applied proposal with %s after an interrupted relocation",
    async (sourceState) => {
      const workspaceDir = await fs.realpath(
        await tempDirs.make("openclaw-workshop-real-adoption-workspace-"),
      );
      const proposal = await proposeCreateSkill({
        workspaceDir,
        config: {},
        agentId: "main",
        env: testState.env,
        name: "real-adoption",
        description: "Real applied proposal",
        content: "# Real adoption\n",
      });
      const applied = await applySkillProposal({
        workspaceDir,
        config: {},
        agentId: "main",
        env: testState.env,
        proposalId: proposal.record.id,
        expectedRevisionHash: proposal.revisionHash,
      });
      await expect(fs.access(applied.record.target.skillFile)).resolves.toBeUndefined();
      const legacySkillDir = path.join(workspaceDir, "skills", "real-adoption");
      const legacyRecord = {
        ...applied.record,
        target: {
          ...applied.record.target,
          skillDir: legacySkillDir,
          skillFile: path.join(legacySkillDir, "SKILL.md"),
          source: "openclaw-workspace",
        },
      } satisfies SkillProposalRecord;
      await workshopStore.updateSkillProposalRecord({
        record: legacyRecord,
        store: { env: testState.env },
      });
      if (sourceState !== "removed source") {
        await fs.mkdir(path.dirname(legacySkillDir), { recursive: true });
        await fs.cp(applied.record.target.skillDir, legacySkillDir, { recursive: true });
      }
      if (sourceState === "changed source metadata") {
        await fs.mkdir(path.join(legacySkillDir, ".clawhub"));
        await fs.writeFile(
          path.join(legacySkillDir, ".clawhub", "origin.json"),
          "operator metadata",
        );
      }

      const result = await migrateLegacySkillWorkshopProposals({
        config: {},
        env: testState.env,
      });

      if (sourceState === "changed source metadata") {
        await expect(
          readSkillProposalRecord(applied.record.id, { env: testState.env }),
        ).resolves.toMatchObject({
          status: "stale",
          target: { skillDir: legacySkillDir },
        });
        expect(
          await fs.readFile(path.join(legacySkillDir, ".clawhub", "origin.json"), "utf8"),
        ).toBe("operator metadata");
        return;
      }
      expect(result.warnings).toEqual([]);
      await expect(
        readSkillProposalRecord(applied.record.id, { env: testState.env }),
      ).resolves.toMatchObject({
        status: "applied",
        target: {
          skillFile: applied.record.target.skillFile,
          source: "openclaw-workshop",
        },
      });
      await expect(fs.access(legacySkillDir)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        migrateLegacySkillWorkshopProposals({ config: {}, env: testState.env }),
      ).resolves.toMatchObject({ changes: [], warnings: [] });
    },
  );

  it("adopts a skill moved before its proposal persistence and converges on rerun", async () => {
    const workspaceDir = await fs.realpath(
      await tempDirs.make("openclaw-workshop-relocation-failure-workspace-"),
    );
    const records = ["first-relocation", "second-relocation"].map((name) => {
      const skillDir = path.join(workspaceDir, "skills", name);
      const content = `---\nname: ${name}\ndescription: ${name} procedure\n---\n\n# ${name}\n`;
      return {
        content,
        record: createAppliedLegacyProposal({
          id: `${name}-20260901-1234567890`,
          title: `Create ${name}`,
          description: `${name} procedure`,
          content,
          target: { skillKey: name, skillDir },
        }),
      };
    });
    for (const { record, content } of records) {
      await fs.mkdir(record.target.skillDir, { recursive: true });
      await fs.writeFile(record.target.skillFile, content, "utf8");
    }

    seedLegacyV15ProposalRows(
      testState.env,
      records.map((record) => ({ record: record.record, workspaceDir, claimReleasedTime: null })),
    );

    const workshopRoot = resolveWorkshopSkillsDir({}, "main", testState.env);
    repairOpenClawStateDatabaseSchemaIfNeeded({ env: testState.env });
    await expectRelocationWriteFailure({
      env: testState.env,
      proposalId: records[0]!.record.id,
      status: "applied",
      message: "injected relocation persistence failure",
    });

    await expect(
      fs.readFile(path.join(workshopRoot, "first-relocation", "SKILL.md"), "utf8"),
    ).resolves.toBe(records[0]!.content);
    await expect(fs.access(records[0]!.record.target.skillDir)).rejects.toThrow();
    await expect(
      readSkillProposalRecord(records[0]!.record.id, { env: testState.env }),
    ).resolves.toMatchObject({
      target: {
        skillDir: records[0]!.record.target.skillDir,
        skillFile: records[0]!.record.target.skillFile,
        source: "openclaw-workspace",
      },
    });

    await expect(
      inspectLegacySkillWorkshopMigration({ config: {}, env: testState.env }),
    ).resolves.toMatchObject({
      externalProposalCount: 2,
      externalProposalCountsByAgent: { main: 2 },
    });

    const repaired = await migrateLegacySkillWorkshopProposals({
      config: {},
      env: testState.env,
    });
    expect(repaired.changes.join("\n")).toContain(
      "Relocated 1 Skill Workshop skill, retargeted 2 proposals, marked 0 stale",
    );
    for (const { record } of records) {
      const targetDir = path.join(workshopRoot, path.basename(record.target.skillDir));
      await expect(fs.access(path.join(targetDir, "SKILL.md"))).resolves.toBeUndefined();
      await expect(
        readSkillProposalRecord(record.id, { env: testState.env }),
      ).resolves.toMatchObject({
        target: {
          skillDir: targetDir,
          skillFile: path.join(targetDir, "SKILL.md"),
          source: "openclaw-workshop",
        },
      });
    }
    await expectWorkshopMigrationConverged({ env: testState.env });
  });

  it("quarantines a non-empty legacy directory missing proposal.json so Doctor converges", async () => {
    const workspaceDir = await tempDirs.make("openclaw-workshop-missing-json-");
    const proposalId = "missing-json-workshop-20260829-1234567890";
    const proposalDir = path.join(testState.stateDir, "skill-workshop", "proposals", proposalId);
    await fs.mkdir(path.join(proposalDir, "references"), { recursive: true });
    await fs.writeFile(
      path.join(proposalDir, "references", "proof.md"),
      "# Orphan proof\n",
      "utf8",
    );
    const previousRecoveryDir = path.join(
      testState.stateDir,
      "skill-workshop",
      "recovery",
      "proposals",
      proposalId,
    );
    await fs.mkdir(previousRecoveryDir, { recursive: true });
    await fs.writeFile(path.join(previousRecoveryDir, "prior.md"), "prior recovery\n", "utf8");

    const result = await migrateLegacySkillWorkshopProposals({
      config: {
        agents: {
          entries: {
            main: { default: true, workspace: workspaceDir },
          },
        },
      },
    });

    expect(result).toMatchObject({ detected: 1, migrated: 0, warnings: [] });
    expect(result.changes.join("\n")).toContain(
      `Quarantined incomplete Skill Workshop proposal ${proposalId}`,
    );
    const second = await migrateLegacySkillWorkshopProposals({
      config: {
        agents: {
          entries: {
            main: { default: true, workspace: workspaceDir },
          },
        },
      },
    });
    expect(second).toEqual({ changes: [], warnings: [], detected: 0, migrated: 0 });
    await expect(fs.access(proposalDir)).rejects.toThrow();
    await expect(fs.readFile(path.join(previousRecoveryDir, "prior.md"), "utf8")).resolves.toBe(
      "prior recovery\n",
    );
    const recoveryRoot = path.dirname(previousRecoveryDir);
    const recoveryDirs = (await fs.readdir(recoveryRoot)).filter((name) =>
      name.startsWith(`${proposalId}-`),
    );
    expect(recoveryDirs).toHaveLength(1);
    const recoveredProposalDir = recoveryDirs[0]!;
    await expect(
      fs.readFile(path.join(recoveryRoot, recoveredProposalDir, "references", "proof.md"), "utf8"),
    ).resolves.toBe("# Orphan proof\n");
  });

  it("quarantines a legacy directory with proposal.json but no PROPOSAL.md", async () => {
    const workspaceDir = await tempDirs.make("openclaw-workshop-missing-draft-");
    const proposalId = "missing-draft-workshop-20260829-1234567890";
    const proposalDir = path.join(testState.stateDir, "skill-workshop", "proposals", proposalId);
    const targetDir = path.join(workspaceDir, "skills", "missing-draft");
    const now = "2026-08-29T00:00:00.000Z";
    const record: SkillProposalRecord = {
      schema: SKILL_WORKSHOP_SCHEMA,
      id: proposalId,
      kind: "create",
      status: "pending",
      title: "Create Missing Draft",
      description: "Proposal whose PROPOSAL.md was removed",
      createdAt: now,
      updatedAt: now,
      createdBy: "cli",
      origin: { agentId: "main", runId: "missing-draft-run" },
      originRunIds: ["missing-draft-run"],
      originRunMutationCounts: { "missing-draft-run": 1 },
      proposedVersion: "v1",
      draftFile: "PROPOSAL.md",
      draftHash: hashSkillProposalContent("# Missing Draft\n"),
      supportFiles: [],
      target: {
        skillName: "Missing Draft",
        skillKey: "missing-draft",
        skillDir: targetDir,
        skillFile: path.join(targetDir, "SKILL.md"),
        source: "openclaw-workspace",
      },
      scan: {
        state: "clean",
        scannedAt: now,
        critical: 0,
        warn: 0,
        info: 0,
        findings: [],
      },
    };
    await fs.mkdir(proposalDir, { recursive: true });
    await fs.writeFile(path.join(proposalDir, "proposal.json"), JSON.stringify(record), "utf8");

    const result = await migrateLegacySkillWorkshopProposals({
      config: {
        agents: {
          entries: {
            main: { default: true, workspace: workspaceDir },
          },
        },
      },
    });

    expect(result).toMatchObject({ detected: 1, migrated: 0, warnings: [] });
    expect(result.changes.join("\n")).toContain(
      `Quarantined incomplete Skill Workshop proposal ${proposalId}`,
    );
    await expect(fs.access(proposalDir)).rejects.toThrow();
    const recoveryRoot = path.join(testState.stateDir, "skill-workshop", "recovery", "proposals");
    const recoveryDirs = (await fs.readdir(recoveryRoot)).filter((name) =>
      name.startsWith(`${proposalId}-`),
    );
    expect(recoveryDirs).toHaveLength(1);
    const recoveryDir = recoveryDirs[0]!;
    await expect(
      fs.access(path.join(recoveryRoot, recoveryDir, "proposal.json")),
    ).resolves.toBeUndefined();

    importLegacySkillProposal({ record, ownerAgentId: "main" });
    await fs.mkdir(path.join(proposalDir, "references"), { recursive: true });
    await fs.writeFile(path.join(proposalDir, "references", "leftover.md"), "leftover\n", "utf8");
    await expect(
      migrateLegacySkillWorkshopProposals({
        config: {
          agents: {
            entries: {
              main: { default: true, workspace: workspaceDir },
            },
          },
        },
      }),
    ).resolves.toMatchObject({
      changes: [
        expect.stringContaining(
          "Relocated 0 Skill Workshop skills, retargeted 1 proposal, marked 0 stale",
        ),
      ],
      warnings: [],
      detected: 1,
      migrated: 0,
    });
    await expect(
      fs.access(path.join(proposalDir, "references", "leftover.md")),
    ).resolves.toBeUndefined();
  });

  it("removes an empty orphaned legacy proposal directory directly", async () => {
    const workspaceDir = await tempDirs.make("openclaw-workshop-empty-dir-");
    const proposalId = "empty-dir-workshop-20260829-1234567890";
    const proposalDir = path.join(testState.stateDir, "skill-workshop", "proposals", proposalId);
    await fs.mkdir(proposalDir, { recursive: true });

    const result = await migrateLegacySkillWorkshopProposals({
      config: {
        agents: {
          entries: {
            main: { default: true, workspace: workspaceDir },
          },
        },
      },
    });

    expect(result).toMatchObject({ detected: 1, migrated: 0, warnings: [] });
    expect(result.changes.join("\n")).toContain(
      `Removed empty legacy Skill Workshop proposal directory ${proposalId}`,
    );
    await expect(fs.access(proposalDir)).rejects.toThrow();
  });
});
