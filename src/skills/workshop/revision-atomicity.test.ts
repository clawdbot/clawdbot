import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";

const revisionFault = vi.hoisted(() => ({
  boundary: undefined as string | undefined,
  directorySyncOutcome: undefined as
    | { status: "synced" }
    | { status: "unsupported"; code?: string }
    | undefined,
  trip(boundary: string) {
    if (this.boundary !== boundary) {
      return;
    }
    this.boundary = undefined;
    throw new Error(`injected crash at ${boundary}`);
  },
}));

vi.mock("../../infra/fs-safe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/fs-safe.js")>();
  return {
    ...actual,
    root: async (...args: Parameters<typeof actual.root>) => {
      const opened = await actual.root(...args);
      return new Proxy(opened, {
        get(target, property, receiver) {
          if (property === "mkdir") {
            return async (...mkdirArgs: Parameters<typeof target.mkdir>) => {
              await target.mkdir(...mkdirArgs);
              revisionFault.trip("generation staging start");
            };
          }
          if (property === "create") {
            return async (...createArgs: Parameters<typeof target.create>) => {
              await target.create(...createArgs);
              revisionFault.trip("generation exclusive create");
            };
          }
          if (property === "openWritable") {
            return async (...openArgs: Parameters<typeof target.openWritable>) => {
              const writable = await target.openWritable(...openArgs);
              const handle = new Proxy(writable.handle, {
                get(handleTarget, handleProperty, handleReceiver) {
                  if (handleProperty === "sync") {
                    return async () => {
                      await handleTarget.sync();
                      revisionFault.trip("generation file durability sync");
                    };
                  }
                  const handleValue = Reflect.get(
                    handleTarget,
                    handleProperty,
                    handleReceiver,
                  ) as unknown;
                  return typeof handleValue === "function"
                    ? handleValue.bind(handleTarget)
                    : handleValue;
                },
              });
              return { ...writable, handle };
            };
          }
          if (property === "move") {
            return async (...moveArgs: Parameters<typeof target.move>) => {
              await target.move(...moveArgs);
              revisionFault.trip("generation finalization");
            };
          }
          if (property === "list") {
            return async (...listArgs: Parameters<typeof target.list>) => {
              const entries = await target.list(...listArgs);
              revisionFault.trip("recovery cleanup");
              return entries;
            };
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
});

vi.mock("../../infra/directory-durability.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/directory-durability.js")>();
  return {
    ...actual,
    syncDirectoryIfSupported: async (
      ...args: Parameters<typeof actual.syncDirectoryIfSupported>
    ) => {
      revisionFault.trip("generation parent durability sync");
      return revisionFault.directorySyncOutcome ?? (await actual.syncDirectoryIfSupported(...args));
    },
  };
});

vi.mock("../../infra/fs-safe-remove.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/fs-safe-remove.js")>();
  return {
    ...actual,
    removePathWithinRoot: async (...args: Parameters<typeof actual.removePathWithinRoot>) => {
      revisionFault.trip("prior generation retirement");
      return await actual.removePathWithinRoot(...args);
    },
  };
});

vi.mock("./store-sqlite-transition.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./store-sqlite-transition.js")>();
  return {
    ...actual,
    commitPendingSkillProposalTransition: (
      ...args: Parameters<typeof actual.commitPendingSkillProposalTransition>
    ) => {
      revisionFault.trip("CAS before commit");
      const result = actual.commitPendingSkillProposalTransition(...args);
      revisionFault.trip("CAS after commit");
      return result;
    },
  };
});

import {
  evaluateSkillProposal,
  inspectSkillProposal,
  listSkillProposalEvents,
  proposeCreateSkill,
  reviseSkillProposal,
} from "./service.js";
import type { SkillProposalReadResult } from "./types.js";

const tempDirs = createTrackedTempDirs();
let testState: OpenClawTestState;

beforeAll(async () => {
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-workshop-revision-atomicity-",
  });
});

afterEach(async () => {
  revisionFault.boundary = undefined;
  revisionFault.directorySyncOutcome = undefined;
  await tempDirs.cleanup();
});

afterAll(async () => {
  await testState.cleanup();
});

describe("Skill Workshop revision generation atomicity", () => {
  async function createProposal() {
    const workspaceDir = await tempDirs.make("openclaw-workshop-revision-workspace-");
    const proposal = await proposeCreateSkill({
      workspaceDir,
      env: testState.env,
      name: "Atomic Revision",
      description: "Keep proposal revisions whole across crashes",
      content: "# Atomic Revision\n\nVersion 1.\n",
      supportFiles: [{ path: "references/version.txt", content: "version 1\n" }],
    });
    return { proposal, workspaceDir };
  }

  async function reviseToVersion(
    proposal: SkillProposalReadResult,
    workspaceDir: string,
    version: number,
  ) {
    return await reviseSkillProposal({
      workspaceDir,
      env: testState.env,
      proposalId: proposal.record.id,
      expectedRevisionHash: proposal.revisionHash,
      content: `# Atomic Revision\n\nVersion ${version}.\n`,
      supportFiles: [{ path: "references/version.txt", content: `version ${version}\n` }],
    });
  }

  async function expectCompleteVersion(params: {
    proposal: SkillProposalReadResult;
    contentVersion: number;
    workspaceDir: string;
  }) {
    await expect(
      evaluateSkillProposal({
        workspaceDir: params.workspaceDir,
        env: testState.env,
        proposalId: params.proposal.record.id,
        expectedRevisionHash: params.proposal.revisionHash,
      }),
    ).resolves.toMatchObject({
      record: { proposedVersion: params.proposal.record.proposedVersion },
    });
    await expect(
      inspectSkillProposal(params.proposal.record.id, {
        workspaceDir: params.workspaceDir,
        env: testState.env,
      }),
    ).resolves.toMatchObject({
      record: { proposedVersion: params.proposal.record.proposedVersion },
      content: expect.stringContaining(`Version ${params.contentVersion}.`),
      supportFiles: [
        { path: "references/version.txt", content: `version ${params.contentVersion}\n` },
      ],
    });
  }

  it.each([
    "generation staging start",
    "generation exclusive create",
    "generation file durability sync",
    "generation finalization",
    "generation parent durability sync",
    "CAS before commit",
  ])("keeps the complete previous generation after a crash at %s", async (boundary) => {
    const { proposal, workspaceDir } = await createProposal();
    revisionFault.boundary = boundary;

    await expect(reviseToVersion(proposal, workspaceDir, 2)).rejects.toThrow(
      `injected crash at ${boundary}`,
    );
    expect(
      listSkillProposalEvents({
        workspaceDir,
        proposalId: proposal.record.id,
        env: testState.env,
      }).events.map((event) => event.type),
    ).toEqual(["created"]);

    await expectCompleteVersion({
      proposal,
      contentVersion: 1,
      workspaceDir,
    });
  });

  it("commits when generation directory sync is explicitly unsupported", async () => {
    const { proposal, workspaceDir } = await createProposal();
    revisionFault.directorySyncOutcome = { status: "unsupported", code: "EINVAL" };

    const revised = await reviseToVersion(proposal, workspaceDir, 2);
    expect(
      listSkillProposalEvents({
        workspaceDir,
        proposalId: proposal.record.id,
        env: testState.env,
      }).events.map((event) => event.type),
    ).toEqual(["created", "revised"]);
    await expectCompleteVersion({
      proposal: revised,
      contentVersion: 2,
      workspaceDir,
    });
  });

  it("recovers a committed record and event after the transaction reports failure", async () => {
    const { proposal, workspaceDir } = await createProposal();
    revisionFault.boundary = "CAS after commit";

    const revised = await reviseToVersion(proposal, workspaceDir, 2);
    expect(
      listSkillProposalEvents({
        workspaceDir,
        proposalId: proposal.record.id,
        env: testState.env,
      }).events.map((event) => event.type),
    ).toEqual(["created", "revised"]);

    await expectCompleteVersion({
      proposal: revised,
      contentVersion: 2,
      workspaceDir,
    });
  });

  it("keeps committed generations complete when retirement and recovery cleanup fail", async () => {
    const { proposal, workspaceDir } = await createProposal();
    revisionFault.boundary = "prior generation retirement";
    const second = await reviseToVersion(proposal, workspaceDir, 2);
    await expectCompleteVersion({
      proposal: second,
      contentVersion: 2,
      workspaceDir,
    });

    revisionFault.boundary = "recovery cleanup";
    const third = await reviseToVersion(second, workspaceDir, 3);
    await expectCompleteVersion({
      proposal: third,
      contentVersion: 3,
      workspaceDir,
    });

    const fourth = await reviseToVersion(third, workspaceDir, 4);
    const proposalDir = path.join(
      testState.stateDir,
      "skill-workshop",
      "proposals",
      proposal.record.id,
    );
    await expect(fs.access(path.join(proposalDir, "PROPOSAL.md"))).rejects.toThrow();
    await expect(fs.readdir(path.join(proposalDir, "generations"))).resolves.toEqual([
      fourth.record.draftFile.split("/")[1],
    ]);
  });
});
