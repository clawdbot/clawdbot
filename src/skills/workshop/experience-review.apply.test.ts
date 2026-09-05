import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import { resolveSessionLane } from "../../agents/embedded-agent-runner/lanes.js";
import type { EmbeddedForegroundPromptContext } from "../../agents/embedded-agent-runner/run/params.js";
import { resolveSessionBoundaryPromptCacheKey } from "../../agents/embedded-agent-runner/run/session-boundary-prompt-cache-key.js";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import { resolveAgentRunSessionTarget } from "../../agents/run-session-target.js";
import { SessionManager } from "../../agents/sessions/index.js";
import { runWithCanonicalSkillWorkspace } from "../../agents/skill-workshop-workspace-context.js";
import { createSkillWorkshopTool } from "../../agents/tools/skill-workshop-tool.js";
import {
  createSessionEntryWithTranscript,
  deleteSessionEntryLifecycle,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { emitAgentEvent, onAgentRuntimeEvent } from "../../infra/agent-events.js";
import { getAgentRunContext } from "../../infra/agent-run-registry.js";
import * as agentRunRegistry from "../../infra/agent-run-registry.js";
import { enqueueCommandInLane } from "../../process/command-queue.js";
import {
  isGatewaySubordinateWorkAdmissionClosed,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { readSkillReviewOutcomes } from "./collection-review-state.js";
import type { ExperienceReviewCandidate } from "./experience-review-scheduler.js";
import { runSkillExperienceReview as runCapturedExperienceReview } from "./experience-review.js";
import { inspectSkillProposal, listSkillProposals, proposeCreateSkill } from "./service.js";
import * as workshopService from "./service.js";
import { resolveWorkshopSkillsDir } from "./skills-root.js";

const runEmbeddedAgent = vi.hoisted(() => vi.fn());

vi.mock("../../agents/embedded-agent.js", () => ({ runEmbeddedAgent }));
type ExperienceReviewFixture = Omit<ExperienceReviewCandidate, "ctx" | "source"> & {
  ctx: ExperienceReviewCandidate["ctx"] & {
    sessionId: string;
    sessionKey: string;
  };
};

async function captureReviewFixture(
  fixture: ExperienceReviewFixture,
): Promise<ExperienceReviewCandidate> {
  const { sessionId, sessionKey, ...ctx } = fixture.ctx;
  const agentId = fixture.ctx.foregroundPromptContext.agentId;
  const source = await resolveAgentRunSessionTarget({
    agentId,
    config: fixture.config,
    sessionId,
    sessionKey,
    missingSessionKey: "create",
  });
  const created = await createSessionEntryWithTranscript(
    source,
    () => ({ ok: true, entry: { sessionId: source.sessionId, updatedAt: Date.now() } }),
    { cwd: fixture.ctx.workspaceDir },
  );
  if (!created.ok) {
    throw new Error(`Could not create review source: ${created.error}`);
  }
  const terminal = SessionManager.open(
    source,
    fixture.ctx.workspaceDir,
  ).appendMessageWithTranscriptAnchor({
    role: "user",
    content: "Review the completed fixture.",
    timestamp: Date.now(),
  });
  if (!terminal.anchor) {
    throw new Error("Review fixture requires a completed message");
  }
  return {
    ...fixture,
    ctx,
    source: terminal.anchor,
  };
}

async function runSkillExperienceReview(
  fixture: ExperienceReviewFixture,
  deps: Parameters<typeof runCapturedExperienceReview>[1],
): Promise<void> {
  await runCapturedExperienceReview(await captureReviewFixture(fixture), deps);
}

function foregroundPromptContext(
  workspaceDir: string,
  sandboxSessionKey = "agent:main:main",
): EmbeddedForegroundPromptContext {
  return {
    agentId: "main",
    agentDir: workspaceDir,
    workspaceDir,
    cwd: workspaceDir,
    sandboxSessionKey,
    trigger: "user",
  };
}

const tempDirs = createTrackedTempDirs();
let testState: OpenClawTestState;

beforeEach(async () => {
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-experience-auto-apply-state-",
  });
});

afterEach(async () => {
  runEmbeddedAgent.mockReset();
  await testState.cleanup();
  await tempDirs.cleanup();
});

describe("experience review auto apply", () => {
  it.each(["model result", "configuration", "proposal inspection"] as const)(
    "leaves a proposal pending when reset during %s",
    async (boundary) => {
      const workspaceDir = await tempDirs.make("openclaw-experience-apply-reset-");
      const acquired = createDeferred();
      const release = createDeferred();
      const config = { skills: { workshop: { autonomous: { mode: "auto" as const } } } };
      const waitForReset = async () => {
        acquired.resolve();
        await release.promise;
      };
      const apply = vi.spyOn(workshopService, "applySkillProposal");
      const originalInspect = workshopService.inspectSkillProposal;
      const inspect = vi.spyOn(workshopService, "inspectSkillProposal");
      if (boundary === "proposal inspection") {
        inspect.mockImplementationOnce(async (...args) => {
          const proposal = await originalInspect(...args);
          await waitForReset();
          return proposal;
        });
      }
      runEmbeddedAgent.mockImplementation(async (params) => {
        const tool = createSkillWorkshopTool({
          workspaceDir: params.workspaceDir,
          config: params.config,
          agentId: params.agentId,
          origin: params.skillWorkshopOrigin,
          proposalOnly: params.skillWorkshopProposalOnly,
          autonomousCapture: params.skillWorkshopAutonomousCapture,
          proposalMutationBudget: params.skillWorkshopProposalMutationBudget,
        });
        await tool.execute("review-create", {
          action: "create",
          name: "deployment-preflight",
          description: "Check deployment prerequisites before retrying.",
          proposal_content: "# Deployment Preflight\n\nVerify prerequisites before deploy.\n",
        });
        if (boundary === "model result") {
          await waitForReset();
        }
        return { meta: { durationMs: 1 } };
      });
      const review = runSkillExperienceReview(
        {
          ctx: {
            sessionId: "foreground-session",
            sessionKey: "agent:main:apply-reset",
            workspaceDir,
            modelProviderId: "openai",
            modelId: "gpt-test",
            foregroundPromptContext: foregroundPromptContext(workspaceDir),
          },
          config,
        },
        {
          getCurrentConfig: async () => {
            if (boundary === "configuration") {
              await waitForReset();
            }
            return config;
          },
        },
      );
      const settled = review.then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        await Promise.race([acquired.promise, settled]);
        resetGatewayWorkAdmission();
        release.resolve();
        expect(await settled).toMatchObject({ message: "gateway runtime reset" });
        expect(apply).not.toHaveBeenCalled();
        expect((await listSkillProposals({ config, agentId: "main" })).proposals[0]).toMatchObject({
          status: "pending",
        });
        await expect(
          fs.stat(
            path.join(resolveWorkshopSkillsDir(config, "main"), "deployment-preflight", "SKILL.md"),
          ),
        ).rejects.toMatchObject({ code: "ENOENT" });
        expect(Object.values(readSkillReviewOutcomes().experienceReviews)[0]).toMatchObject({
          outcome: "failed",
          error: expect.stringContaining("gateway runtime reset"),
        });
      } finally {
        release.resolve();
        await settled;
        inspect.mockRestore();
        apply.mockRestore();
      }
    },
  );

  it("does not review a captured session after its source is deleted", async () => {
    const workspaceDir = await tempDirs.make("openclaw-experience-read-failure-");
    const registration = vi.spyOn(agentRunRegistry, "registerAgentRunContext");
    const candidate = await captureReviewFixture({
      ctx: {
        sessionId: "foreground-session",
        sessionKey: "agent:main:read-failure",
        workspaceDir,
        modelProviderId: "openai",
        modelId: "gpt-test",
        foregroundPromptContext: foregroundPromptContext(workspaceDir),
      },
      config: { skills: { workshop: { autonomous: { mode: "propose" } } } },
    });
    await deleteSessionEntryLifecycle({
      agentId: candidate.source.agentId,
      storePath: candidate.source.storePath,
      archiveTranscript: true,
      deleteTranscriptWithoutArchive: true,
      target: {
        canonicalKey: candidate.source.sessionKey,
        storeKeys: [candidate.source.sessionKey],
      },
    });
    try {
      await expect(
        runCapturedExperienceReview(candidate, { getCurrentConfig: () => ({}) }),
      ).rejects.toThrow("Completed-turn transcript anchor changed");
      expect(runEmbeddedAgent).not.toHaveBeenCalled();
      expect(registration).toHaveBeenCalledOnce();
      expect(getAgentRunContext(registration.mock.calls[0]![0])).toBeUndefined();
      expect(Object.values(readSkillReviewOutcomes().experienceReviews)[0]).toMatchObject({
        outcome: "failed",
        error: "WorkerTaskError: Completed-turn transcript anchor changed",
      });
    } finally {
      registration.mockRestore();
    }
  });

  it.each(["session", "transcript"] as const)(
    "rejects a changed %s after context preparation",
    async (change) => {
      const workspaceDir = await tempDirs.make("openclaw-experience-source-rotation-");
      const candidate = await captureReviewFixture({
        ctx: {
          sessionId: "foreground-session",
          sessionKey: "agent:main:source-rotation",
          workspaceDir,
          modelProviderId: "openai",
          modelId: "gpt-test",
          foregroundPromptContext: foregroundPromptContext(workspaceDir),
        },
        config: { skills: { workshop: { autonomous: { mode: "propose" } } } },
      });
      const readContext = SessionManager.openModelContextAsync.bind(SessionManager);
      const contextRead = vi
        .spyOn(SessionManager, "openModelContextAsync")
        .mockImplementationOnce(async (...args) => {
          const pendingContext = readContext(...args);
          if (change === "session") {
            await upsertSessionEntryCore(candidate.source, {
              sessionId: "replacement-session",
              updatedAt: Date.now(),
            });
          }
          const context = await pendingContext;
          if (change === "transcript") {
            SessionManager.open(candidate.source).removeTrailingEntries(
              (entry) => entry.type === "message",
            );
          }
          return context;
        });
      runEmbeddedAgent.mockResolvedValue({ meta: { durationMs: 1 } });
      try {
        await expect(
          runCapturedExperienceReview(candidate, { getCurrentConfig: () => candidate.config }),
        ).rejects.toThrow(
          change === "session"
            ? "source session was deleted or replaced"
            : "Completed-turn transcript anchor changed",
        );
        expect(runEmbeddedAgent).not.toHaveBeenCalled();
        expect(
          SessionManager.openModelContext(candidate.source).buildSessionContext().messages,
        ).toEqual(
          change === "session"
            ? [expect.objectContaining({ role: "user", content: "Review the completed fixture." })]
            : [],
        );
      } finally {
        contextRead.mockRestore();
      }
    },
  );

  it("does not occupy the foreground session lane", async () => {
    const workspaceDir = await tempDirs.make("openclaw-experience-session-lane-");
    const foregroundSessionKey = "agent:main:main";
    const reviewStarted = createDeferred();
    const releaseReview = createDeferred();
    runEmbeddedAgent.mockImplementation(async (params) =>
      enqueueCommandInLane(resolveSessionLane(params.sessionKey ?? params.sessionId), async () => {
        reviewStarted.resolve();
        await releaseReview.promise;
        return { meta: { durationMs: 1 } };
      }),
    );

    const review = runSkillExperienceReview(
      {
        ctx: {
          sessionId: "foreground-session",
          sessionKey: foregroundSessionKey,
          workspaceDir,
          modelProviderId: "openai",
          modelId: "gpt-test",
          foregroundPromptContext: foregroundPromptContext(workspaceDir),
        },
        config: { skills: { workshop: { autonomous: { mode: "propose" } } } },
      },
      { getCurrentConfig: () => ({}) },
    );
    await reviewStarted.promise;

    const foregroundStarted = createDeferred();
    const foreground = enqueueCommandInLane(resolveSessionLane(foregroundSessionKey), async () => {
      foregroundStarted.resolve();
    });
    try {
      await withTestTimeout(
        foregroundStarted.promise,
        1_000,
        "foreground work did not start while the review was active",
      );
    } finally {
      releaseReview.resolve();
      await Promise.all([review, foreground]);
    }
  });

  it("keeps detached review events out of foreground session presentation", async () => {
    const workspaceDir = await tempDirs.make("openclaw-experience-hidden-events-");
    const observed: Array<
      [
        stream: string,
        controlUiVisible?: boolean,
        projectSessionLifecycle?: boolean,
        projectSessionMessages?: boolean,
        sessionKey?: string,
      ]
    > = [];
    let reviewRunId = "";
    const unsubscribe = onAgentRuntimeEvent((event) => {
      if (event.runId !== reviewRunId) {
        return;
      }
      observed.push([
        event.stream,
        event.controlUiVisible,
        event.projectSessionLifecycle,
        event.projectSessionMessages,
        event.sessionKey,
      ]);
    });
    runEmbeddedAgent.mockImplementation(async (params) => {
      reviewRunId = params.runId;
      emitAgentEvent({
        runId: params.runId,
        stream: "assistant",
        data: { text: "NOTHING_TO_LEARN" },
      });
      emitAgentEvent({
        runId: params.runId,
        stream: "tool",
        data: { phase: "start", name: "skill_workshop", toolCallId: "review-tool" },
      });
      emitAgentEvent({
        runId: params.runId,
        stream: "lifecycle",
        data: { phase: "start", startedAt: Date.now() },
      });
      return { meta: { durationMs: 1 } };
    });
    const config = { skills: { workshop: { autonomous: { mode: "auto" as const } } } };

    try {
      await runSkillExperienceReview(
        {
          ctx: {
            sessionId: "foreground-session",
            sessionKey: "agent:main:main",
            workspaceDir,
            modelProviderId: "openai",
            modelId: "gpt-test",
            foregroundPromptContext: foregroundPromptContext(workspaceDir),
          },
          config,
        },
        { getCurrentConfig: () => config },
      );
    } finally {
      unsubscribe();
    }

    expect(observed.slice(0, 2)).toEqual([
      ["assistant", false, false, false, undefined],
      ["tool", false, false, false, undefined],
    ]);
    expect(observed[2]?.slice(0, 4)).toEqual(["lifecycle", false, false, false]);
    expect(observed[2]?.[4]).toMatch(
      /^agent:main:internal-session-effects:skill-workshop-review_/u,
    );
    expect(getAgentRunContext(reviewRunId)).toBeUndefined();
  });

  it.each([
    {
      name: "applies the isolated proposal after a successful review",
      result: { meta: { durationMs: 1 } },
      error: undefined,
    },
    {
      name: "keeps the proposal pending when the review returns terminal error metadata",
      result: {
        meta: {
          durationMs: 1,
          error: { kind: "retry_limit", message: "review retries exhausted" },
        },
      },
      error: "review retries exhausted",
    },
    {
      name: "keeps the proposal pending when the review returns a failure signal",
      result: {
        meta: {
          durationMs: 1,
          failureSignal: {
            kind: "execution_denied",
            source: "tool",
            toolName: "exec",
            code: "SYSTEM_RUN_DENIED",
            message: "review execution denied",
            fatalForCron: true,
          },
        },
      },
      error: "review execution denied",
    },
    {
      name: "keeps the proposal pending when the review is aborted",
      result: { meta: { durationMs: 1, aborted: true } },
      error: "Skill review model run aborted.",
    },
    {
      name: "keeps the proposal pending when the review returns an error payload",
      result: { meta: { durationMs: 1 }, payloads: [{ isError: true, text: "provider failed" }] },
      error: "provider failed",
    },
  ] satisfies Array<{ name: string; result: EmbeddedAgentRunResult; error: string | undefined }>)(
    "$name",
    async ({ result, error }) => {
      const workspaceDir = await tempDirs.make("openclaw-experience-auto-apply-workspace-");
      const agentDir = await tempDirs.make("openclaw-experience-auto-apply-agent-dir-");
      const config = {
        agents: { entries: { main: { default: true, agentDir } } },
        skills: { workshop: { autonomous: { mode: "auto" as const } } },
      };
      const foregroundPromptCacheKey = resolveSessionBoundaryPromptCacheKey({
        api: "openai-responses",
        boundaryCount: 0,
        sessionId: "foreground-session",
      });
      runEmbeddedAgent.mockImplementation(async (params) => {
        const tool = createSkillWorkshopTool({
          workspaceDir: params.workspaceDir,
          config: params.config,
          agentId: params.agentId,
          origin: params.skillWorkshopOrigin,
          proposalOnly: params.skillWorkshopProposalOnly,
          autonomousCapture: params.skillWorkshopAutonomousCapture,
          proposalMutationBudget: params.skillWorkshopProposalMutationBudget,
        });
        await tool.execute("review-create", {
          action: "create",
          name: "deployment-preflight",
          description: "Check deployment prerequisites before retrying.",
          proposal_content:
            "# Deployment Preflight\n\nRead the manifest and verify prerequisites before deploy.\n",
        });
        return result;
      });
      const candidate: ExperienceReviewFixture = {
        ctx: {
          runId: "foreground-run",
          sessionId: "foreground-session",
          sessionKey: "agent:main:main",
          workspaceDir,
          modelProviderId: "openai",
          modelId: "gpt-test",
          foregroundPromptContext: {
            agentId: "main",
            agentDir: workspaceDir,
            workspaceDir,
            cwd: workspaceDir,
            sandboxSessionKey: "agent:main:main",
            trigger: "user",
            promptCacheKey: foregroundPromptCacheKey,
            messageActionTurnCapability: "closed-foreground-capability",
            reasoningLevel: "on",
          },
        },
        config,
      };

      const review = runSkillExperienceReview(candidate, {
        getCurrentConfig: () => config,
      });
      if (error) {
        await expect(review).rejects.toThrow(error);
      } else {
        await review;
      }

      const manifest = await listSkillProposals({ config: candidate.config, agentId: "main" });
      expect(manifest.proposals).toHaveLength(1);
      expect(manifest.proposals[0]).toMatchObject({
        skillKey: "deployment-preflight",
        status: error ? "pending" : "applied",
      });
      const skillFile = path.join(
        resolveWorkshopSkillsDir(config, "main", testState.env),
        "deployment-preflight",
        "SKILL.md",
      );
      if (error) {
        await expect(fs.stat(skillFile)).rejects.toMatchObject({ code: "ENOENT" });
        expect(Object.values(readSkillReviewOutcomes().experienceReviews)[0]).toMatchObject({
          outcome: "failed",
          error: expect.stringContaining(error),
        });
      } else {
        await expect(fs.readFile(skillFile, "utf8")).resolves.toContain("Read the manifest");
      }
      expect(runEmbeddedAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          skillWorkshopProposalOnly: true,
          skillWorkshopAutonomousCapture: true,
          toolExecutionAllow: ["skill_workshop"],
          sessionPersistence: "detached",
          silentExpected: true,
          allowEmptyAssistantReplyAsSilent: true,
          cleanupBundleMcpOnRunEnd: true,
          terminalReplyExpectation: "optional",
          promptCacheKey: foregroundPromptCacheKey,
          sandboxSessionKey: "agent:main:main",
          sessionId: expect.stringMatching(/^internal-session-effects-skill-workshop-review_/u),
          sessionKey: expect.stringMatching(
            /^agent:main:internal-session-effects:skill-workshop-review_/u,
          ),
          skillWorkshopOrigin: {
            agentId: "main",
            runId: "foreground-run",
            sessionKey: "agent:main:main",
          },
          trigger: "user",
          reasoningLevel: "on",
        }),
      );
      const reviewSessionKey = runEmbeddedAgent.mock.calls[0]?.[0].sessionKey;
      expect(reviewSessionKey).not.toBe("agent:main:main");
      expect(runEmbeddedAgent.mock.calls[0]?.[0].messageActionTurnCapability).toBeUndefined();
      expect(runEmbeddedAgent.mock.calls[0]?.[0]).not.toHaveProperty("sessionTarget");
      expect(runEmbeddedAgent.mock.calls[0]?.[0]).not.toHaveProperty("disableMessageTool");
    },
  );

  it("records normal NO_REPLY as nothing learned with provider usage", async () => {
    const workspaceDir = await tempDirs.make("openclaw-experience-usage-");
    runEmbeddedAgent.mockResolvedValue({
      payloads: [{ text: "NO_REPLY" }],
      meta: {
        durationMs: 1,
        stopReason: "stop",
        agentMeta: {
          usage: { input: 43, cacheRead: 12_000, cacheWrite: 200, output: 91 },
        },
      },
    });
    const config = { skills: { workshop: { autonomous: { mode: "auto" as const } } } };

    await runSkillExperienceReview(
      {
        ctx: {
          sessionId: "foreground-session",
          sessionKey: "agent:main:usage",
          workspaceDir,
          modelProviderId: "openai",
          modelId: "gpt-test",
          foregroundPromptContext: foregroundPromptContext(workspaceDir, "agent:main:usage"),
        },
        config,
      },
      { getCurrentConfig: () => config },
    );

    expect(Object.values(readSkillReviewOutcomes().experienceReviews)[0]).toMatchObject({
      outcome: "nothing",
      usage: { inputTokens: 12_243, cachedInputTokens: 12_000, outputTokens: 91 },
    });
  });

  it("auto-applies updates to the agent Workshop directory from a session worktree", async () => {
    const canonicalWorkspaceDir = await tempDirs.make("openclaw-experience-canonical-");
    const worktreeWorkspaceDir = await tempDirs.make("openclaw-experience-worktree-");
    const skillDir = path.join(
      resolveWorkshopSkillsDir({}, "main", testState.env),
      "deployment-preflight",
    );
    const seedTool = createSkillWorkshopTool({
      workspaceDir: canonicalWorkspaceDir,
      agentId: "main",
      config: { skills: { workshop: { approvalPolicy: "auto" } } },
    });
    const seeded = await seedTool.execute("seed-create", {
      action: "create",
      name: "deployment-preflight",
      description: "Check deployment prerequisites before retrying.",
      proposal_content: "# Deployment Preflight\n\nOperator-authored preflight steps.\n",
    });
    await seedTool.execute("seed-apply", {
      action: "apply",
      proposal_id: (seeded.details as { id: string }).id,
      reason: "seed live skill",
    });
    runEmbeddedAgent.mockImplementation(async (params) => {
      expect(params.skillWorkshopUpdateProposals).toBe(true);
      const tool = createSkillWorkshopTool({
        workspaceDir: params.workspaceDir,
        config: params.config,
        agentId: params.agentId,
        origin: params.skillWorkshopOrigin,
        proposalOnly: params.skillWorkshopProposalOnly,
        updateProposals: params.skillWorkshopUpdateProposals,
        autonomousCapture: params.skillWorkshopAutonomousCapture,
        proposalMutationBudget: params.skillWorkshopProposalMutationBudget,
      });
      await tool.execute("review-read", {
        action: "read",
        skill_name: "deployment-preflight",
      });
      await tool.execute("review-update", {
        action: "update",
        skill_name: "deployment-preflight",
        proposal_content: "# Deployment Preflight\n\nReviewer-rewritten steps.\n",
      });
      return { meta: { durationMs: 1 } };
    });
    const candidate: ExperienceReviewFixture = {
      ctx: {
        runId: "foreground-run",
        sessionId: "foreground-session",
        sessionKey: "agent:main:main",
        workspaceDir: worktreeWorkspaceDir,
        modelProviderId: "openai",
        modelId: "gpt-test",
        foregroundPromptContext: foregroundPromptContext(worktreeWorkspaceDir),
      },
      config: {
        agents: { list: [{ id: "main", default: true, workspace: canonicalWorkspaceDir }] },
        skills: { workshop: { autonomous: { mode: "auto" as const } } },
      },
    };

    await runWithCanonicalSkillWorkspace(canonicalWorkspaceDir, () =>
      runSkillExperienceReview(candidate, {
        getCurrentConfig: () => candidate.config,
      }),
    );

    const manifest = await listSkillProposals({
      agentId: "main",
      config: candidate.config,
    });
    const updateEntry = manifest.proposals.find((entry) => entry.kind === "update");
    expect(updateEntry).toMatchObject({
      skillKey: "deployment-preflight",
      status: "applied",
    });
    const inspected = await inspectSkillProposal(updateEntry?.id ?? "", {
      agentId: "main",
      config: candidate.config,
    });
    expect(inspected?.record.target.skillFile).toBe(path.join(skillDir, "SKILL.md"));
    await expect(fs.readFile(path.join(skillDir, "SKILL.md"), "utf8")).resolves.toContain(
      "Reviewer-rewritten steps.",
    );
    await expect(
      fs.access(path.join(worktreeWorkspaceDir, "skills", "deployment-preflight", "SKILL.md")),
    ).rejects.toThrow();
  });

  it("auto-applies reviewer patch proposals composed from the live body", async () => {
    const workspaceDir = await tempDirs.make("openclaw-experience-auto-apply-extend-");
    const seedTool = createSkillWorkshopTool({
      workspaceDir,
      agentId: "main",
      config: { skills: { workshop: { approvalPolicy: "auto" } } },
    });
    const seeded = await seedTool.execute("seed-create", {
      action: "create",
      name: "deployment-preflight",
      description: "Check deployment prerequisites before retrying.",
      proposal_content: "# Deployment Preflight\n\nOperator-authored preflight steps.\n",
    });
    await seedTool.execute("seed-apply", {
      action: "apply",
      proposal_id: (seeded.details as { id: string }).id,
      reason: "seed live skill",
    });

    runEmbeddedAgent.mockImplementation(async (params) => {
      const tool = createSkillWorkshopTool({
        workspaceDir: params.workspaceDir,
        config: params.config,
        agentId: params.agentId,
        origin: params.skillWorkshopOrigin,
        proposalOnly: params.skillWorkshopProposalOnly,
        updateProposals: params.skillWorkshopUpdateProposals,
        autonomousCapture: params.skillWorkshopAutonomousCapture,
        proposalMutationBudget: params.skillWorkshopProposalMutationBudget,
      });
      await tool.execute("review-read", { action: "read", skill_name: "deployment-preflight" });
      await tool.execute("review-patch", {
        action: "patch",
        skill_name: "deployment-preflight",
        old_string: "",
        new_string: "## Learned\n\nCheck alerts and timing before retrying.",
      });
      return { meta: { durationMs: 1 } };
    });
    const candidate: ExperienceReviewFixture = {
      ctx: {
        runId: "foreground-run",
        sessionId: "foreground-session",
        sessionKey: "agent:main:main",
        workspaceDir,
        modelProviderId: "openai",
        modelId: "gpt-test",
        foregroundPromptContext: foregroundPromptContext(workspaceDir),
      },
      config: { skills: { workshop: { autonomous: { mode: "auto" } } } },
    };

    await runSkillExperienceReview(candidate, {
      getCurrentConfig: () => candidate.config,
    });

    const manifest = await listSkillProposals({ config: candidate.config, agentId: "main" });
    const updateEntry = manifest.proposals.find((entry) => entry.kind === "update");
    expect(updateEntry).toMatchObject({
      skillKey: "deployment-preflight",
      status: "applied",
    });
    const liveSkill = await fs.readFile(
      path.join(
        resolveWorkshopSkillsDir({}, "main", testState.env),
        "deployment-preflight",
        "SKILL.md",
      ),
      "utf8",
    );
    expect(liveSkill).toContain("Operator-authored preflight steps.");
    expect(liveSkill).toContain("Check alerts and timing before retrying.");
  });

  it("re-enters gateway admission when fired from a released request root", async () => {
    const workspaceDir = await tempDirs.make("openclaw-experience-admission-workspace-");
    let subordinateClosedInsideRun: boolean | undefined;
    runEmbeddedAgent.mockImplementation(async () => {
      subordinateClosedInsideRun = isGatewaySubordinateWorkAdmissionClosed();
      return { meta: { durationMs: 1 } };
    });
    const candidate: ExperienceReviewFixture = {
      ctx: {
        runId: "foreground-run",
        sessionId: "foreground-session",
        sessionKey: "agent:main:main",
        workspaceDir,
        modelProviderId: "openai",
        modelId: "gpt-test",
        foregroundPromptContext: foregroundPromptContext(workspaceDir),
      },
      config: { skills: { workshop: { autonomous: { mode: "propose" } } } },
    };

    // The scheduler's idle timer inherits the foreground run's root-work ALS
    // context, which is already released when the timer fires. The review must
    // re-enter admission instead of being refused as GatewayDrainingError.
    const admission = tryBeginGatewayRootWorkAdmission();
    expect(admission).not.toBeNull();
    await admission?.run(async () => {
      admission.release();
      await runSkillExperienceReview(candidate, {
        getCurrentConfig: () => candidate.config,
      });
    });

    expect(runEmbeddedAgent).toHaveBeenCalledTimes(1);
    expect(subordinateClosedInsideRun).toBe(false);
  });

  it("leaves the capture pending when auto mode is disabled during review", async () => {
    const workspaceDir = await tempDirs.make("openclaw-experience-mode-change-workspace-");
    runEmbeddedAgent.mockImplementation(async (params) => {
      const tool = createSkillWorkshopTool({
        workspaceDir: params.workspaceDir,
        config: params.config,
        agentId: params.agentId,
        origin: params.skillWorkshopOrigin,
        proposalOnly: params.skillWorkshopProposalOnly,
        autonomousCapture: params.skillWorkshopAutonomousCapture,
        proposalMutationBudget: params.skillWorkshopProposalMutationBudget,
      });
      await tool.execute("review-create", {
        action: "create",
        name: "deployment-preflight",
        description: "Check deployment prerequisites before retrying.",
        proposal_content: "# Deployment Preflight\n\nVerify prerequisites before deploy.\n",
      });
      return { meta: { durationMs: 1 } };
    });
    const candidate: ExperienceReviewFixture = {
      ctx: {
        runId: "foreground-run",
        sessionId: "foreground-session",
        sessionKey: "agent:main:main",
        workspaceDir,
        modelProviderId: "openai",
        modelId: "gpt-test",
        foregroundPromptContext: foregroundPromptContext(workspaceDir),
      },
      config: { skills: { workshop: { autonomous: { mode: "auto" } } } },
    };

    await runSkillExperienceReview(candidate, {
      getCurrentConfig: () => ({
        skills: { workshop: { autonomous: { mode: "propose" } } },
      }),
    });

    expect(
      (await listSkillProposals({ config: candidate.config, agentId: "main" })).proposals[0],
    ).toMatchObject({
      status: "pending",
    });
  });

  it("records a failed apply and leaves the capture pending without retrying", async () => {
    const workspaceDir = await tempDirs.make("openclaw-experience-apply-failure-workspace-");
    // A file where the skill directory must go makes the live write fail after the proposal exists.
    const workshopSkillsDir = resolveWorkshopSkillsDir({}, "main", testState.env);
    await fs.mkdir(workshopSkillsDir, { recursive: true });
    await fs.writeFile(path.join(workshopSkillsDir, "deployment-preflight"), "blocker");
    runEmbeddedAgent.mockImplementation(async (params) => {
      const tool = createSkillWorkshopTool({
        workspaceDir: params.workspaceDir,
        config: params.config,
        agentId: params.agentId,
        origin: params.skillWorkshopOrigin,
        proposalOnly: params.skillWorkshopProposalOnly,
        autonomousCapture: params.skillWorkshopAutonomousCapture,
        proposalMutationBudget: params.skillWorkshopProposalMutationBudget,
      });
      await tool.execute("review-create", {
        action: "create",
        name: "deployment-preflight",
        description: "Check deployment prerequisites before retrying.",
        proposal_content: "# Deployment Preflight\n\nVerify prerequisites before deploy.\n",
      });
      return { meta: { durationMs: 1 } };
    });
    const candidate: ExperienceReviewFixture = {
      ctx: {
        runId: "foreground-run",
        sessionId: "foreground-session",
        sessionKey: "agent:main:main",
        workspaceDir,
        modelProviderId: "openai",
        modelId: "gpt-test",
        foregroundPromptContext: foregroundPromptContext(workspaceDir),
      },
      config: { skills: { workshop: { autonomous: { mode: "auto" } } } },
    };

    await expect(
      runSkillExperienceReview(candidate, { getCurrentConfig: () => candidate.config }),
    ).rejects.toThrow();

    expect(runEmbeddedAgent).toHaveBeenCalledTimes(1);
    expect(
      (await listSkillProposals({ config: candidate.config, agentId: "main" })).proposals[0],
    ).toMatchObject({
      status: "pending",
    });
    expect(Object.values(readSkillReviewOutcomes().experienceReviews)[0]).toMatchObject({
      outcome: "failed",
      error: expect.stringContaining("directory"),
    });
  });

  it("does not auto-apply a manual proposal revised by the reviewer", async () => {
    const workspaceDir = await tempDirs.make("openclaw-experience-manual-workspace-");
    const manual = await proposeCreateSkill({
      workspaceDir,
      config: {},
      agentId: "main",
      name: "deployment-preflight",
      description: "Manual deployment proposal.",
      content: "# Deployment Preflight\n\nReview this manually.\n",
      createdBy: "cli",
    });
    runEmbeddedAgent.mockImplementation(async (params) => {
      const tool = createSkillWorkshopTool({
        workspaceDir: params.workspaceDir,
        config: params.config,
        agentId: params.agentId,
        origin: params.skillWorkshopOrigin,
        proposalOnly: params.skillWorkshopProposalOnly,
        autonomousCapture: params.skillWorkshopAutonomousCapture,
        proposalMutationBudget: params.skillWorkshopProposalMutationBudget,
      });
      await tool.execute("review-revise", {
        action: "revise",
        proposal_id: manual.record.id,
        proposal_content: "# Deployment Preflight\n\nKeep this manual revision pending.\n",
      });
      return { meta: { durationMs: 1 } };
    });
    const config = { skills: { workshop: { autonomous: { mode: "auto" as const } } } };

    await runSkillExperienceReview(
      {
        ctx: {
          runId: "foreground-run",
          sessionId: "foreground-session",
          sessionKey: "agent:main:main",
          workspaceDir,
          modelProviderId: "openai",
          modelId: "gpt-test",
          foregroundPromptContext: foregroundPromptContext(workspaceDir),
        },
        config,
      },
      { getCurrentConfig: () => config },
    );

    const inspected = await inspectSkillProposal(manual.record.id, {
      config,
      agentId: "main",
    });
    expect(inspected).toMatchObject({
      record: { status: "pending" },
      content: expect.stringContaining("Keep this manual revision pending"),
    });
    expect(inspected?.record.autonomousCapture).toBeUndefined();
  });
});
