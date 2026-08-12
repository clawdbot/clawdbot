import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";

const hookMocks = vi.hoisted(() => ({ evaluate: vi.fn() }));
const dependencyMocks = vi.hoisted(() => ({
  pauseBundleBuild: undefined as undefined | (() => Promise<void>),
  pauseFinalRead: undefined as undefined | (() => Promise<void>),
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => ({
    hasHooks: (hookName: string) => hookName === "skill_proposal_evaluate",
    runSkillProposalEvaluate: hookMocks.evaluate,
  }),
}));

vi.mock("./proposal-bundle.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./proposal-bundle.js")>();
  return {
    ...original,
    buildSkillProposalEvaluationBundles: async (
      ...args: Parameters<typeof original.buildSkillProposalEvaluationBundles>
    ) => {
      await dependencyMocks.pauseBundleBuild?.();
      return original.buildSkillProposalEvaluationBundles(...args);
    },
  };
});

vi.mock("./service-query.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./service-query.js")>();
  return {
    ...original,
    readRequiredProposal: async (...args: Parameters<typeof original.readRequiredProposal>) => {
      if (args[4]?.reconcile === false) {
        await dependencyMocks.pauseFinalRead?.();
      }
      return original.readRequiredProposal(...args);
    },
  };
});

import { skillProposalApplyAbortSignal } from "./apply-transition.js";
import {
  evaluateSkillProposal,
  inspectSkillProposal,
  listSkillProposalEvents,
  proposeCreateSkill,
  proposeUpdateSkill,
} from "./service.js";

const tempDirs = createTrackedTempDirs();
let testState: OpenClawTestState;

beforeAll(async () => {
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-skill-evaluation-abort-boundaries-",
  });
});

beforeEach(() => {
  testState.applyEnv();
  hookMocks.evaluate.mockReset();
  dependencyMocks.pauseBundleBuild = undefined;
  dependencyMocks.pauseFinalRead = undefined;
});

afterEach(async () => {
  await tempDirs.cleanup();
});

afterAll(async () => {
  await testState.cleanup();
});

describe("Skill Workshop evaluation abort boundaries", () => {
  it.each(["create", "update"] as const)(
    "does not dispatch a held %s evaluation cancelled after snapshot construction",
    async (kind) => {
      const { workspaceDir, proposal, beforeTarget } = await createProposal(kind, "pre-dispatch");
      const bundleGate = createGate();
      dependencyMocks.pauseBundleBuild = async () => {
        dependencyMocks.pauseBundleBuild = undefined;
        bundleGate.markHeld();
        await bundleGate.released;
      };
      hookMocks.evaluate.mockResolvedValue([]);
      const abortController = new AbortController();
      const evaluating = evaluateSkillProposal({
        workspaceDir,
        agentId: "main",
        proposalId: proposal.record.id,
        expectedRevisionHash: proposal.revisionHash,
        [skillProposalApplyAbortSignal]: abortController.signal,
      } as Parameters<typeof evaluateSkillProposal>[0]);

      await bundleGate.held;
      abortController.abort(new Error("stopped before evaluator dispatch"));
      bundleGate.release();

      await expect(evaluating).rejects.toThrow("stopped before evaluator dispatch");
      expect(hookMocks.evaluate).not.toHaveBeenCalled();
      await expectUnchanged(workspaceDir, proposal, beforeTarget);
    },
  );

  it.each(["create", "update"] as const)(
    "does not persist a held %s evaluation cancelled inside the final target lock",
    async (kind) => {
      const { workspaceDir, proposal, beforeTarget } = await createProposal(kind, "final-lock");
      const finalReadGate = createGate();
      hookMocks.evaluate.mockImplementation(async () => {
        dependencyMocks.pauseFinalRead = async () => {
          dependencyMocks.pauseFinalRead = undefined;
          finalReadGate.markHeld();
          await finalReadGate.released;
        };
        return [];
      });
      const abortController = new AbortController();
      const evaluating = evaluateSkillProposal({
        workspaceDir,
        agentId: "main",
        proposalId: proposal.record.id,
        expectedRevisionHash: proposal.revisionHash,
        [skillProposalApplyAbortSignal]: abortController.signal,
      } as Parameters<typeof evaluateSkillProposal>[0]);

      await finalReadGate.held;
      abortController.abort(new Error("stopped before evaluation persistence"));
      finalReadGate.release();

      await expect(evaluating).rejects.toThrow("stopped before evaluation persistence");
      expect(hookMocks.evaluate).toHaveBeenCalledOnce();
      await expectUnchanged(workspaceDir, proposal, beforeTarget);
    },
  );
});

function createGate() {
  let markHeld!: () => void;
  let release!: () => void;
  return {
    held: new Promise<void>((resolve) => {
      markHeld = resolve;
    }),
    released: new Promise<void>((resolve) => {
      release = resolve;
    }),
    markHeld: () => markHeld(),
    release: () => release(),
  };
}

async function createProposal(kind: "create" | "update", phase: string) {
  const workspaceDir = await tempDirs.make(`openclaw-skill-evaluation-${phase}-${kind}-`);
  const skillName = `${phase} cancelled ${kind}`;
  if (kind === "update") {
    const skillDir = path.join(workspaceDir, "skills", `${phase}-cancelled-update`);
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      `---\nname: ${phase}-cancelled-update\ndescription: Existing skill\n---\n\n# Before\n`,
    );
  }
  const proposal =
    kind === "create"
      ? await proposeCreateSkill({
          workspaceDir,
          agentId: "main",
          name: skillName,
          description: "Stop evaluation at an abort boundary",
          content: `# ${skillName}\n`,
        })
      : await proposeUpdateSkill({
          workspaceDir,
          agentId: "main",
          skillName,
          description: "Stop evaluation at an abort boundary",
          content: "# After\n",
        });
  const beforeTarget = await fs
    .readFile(proposal.record.target.skillFile, "utf8")
    .catch(() => null);
  return { workspaceDir, proposal, beforeTarget };
}

async function expectUnchanged(
  workspaceDir: string,
  proposal: Awaited<ReturnType<typeof proposeCreateSkill>>,
  beforeTarget: string | null,
) {
  const inspected = await inspectSkillProposal(proposal.record.id, { workspaceDir });
  expect(inspected?.record.status).toBe("pending");
  expect(inspected?.record.evaluation).toBeUndefined();
  expect(
    listSkillProposalEvents({ workspaceDir, proposalId: proposal.record.id }).events.map(
      (event) => event.type,
    ),
  ).toEqual(["created"]);
  await expect(
    fs.readFile(proposal.record.target.skillFile, "utf8").catch(() => null),
  ).resolves.toBe(beforeTarget);
}
