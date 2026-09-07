import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import { resolveAdmittedRunActiveAssertion } from "../../agents/admitted-run-context.js";
import { resolveSessionLane } from "../../agents/embedded-agent-runner/lanes.js";
import type {
  RunEmbeddedAgentParams,
  EmbeddedForegroundPromptContext,
} from "../../agents/embedded-agent-runner/run/params.js";
import { resolveSessionBoundaryPromptCacheKey } from "../../agents/embedded-agent-runner/run/session-boundary-prompt-cache-key.js";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import { resolveAgentRunSessionTarget } from "../../agents/run-session-target.js";
import { SessionManager } from "../../agents/sessions/index.js";
import { createWriteTool } from "../../agents/sessions/tools/write.js";
import { createSkillWorkshopTool } from "../../agents/tools/skill-workshop-tool.js";
import {
  createSessionEntryWithTranscript,
  deleteSessionEntryLifecycle,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
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
    () => ({
      ok: true,
      entry: {
        sessionId: source.sessionId,
        updatedAt: Date.now(),
        permissionMode: fixture.ctx.foregroundPromptContext.permissionMode,
      },
    }),
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

async function runSkillExperienceReview(fixture: ExperienceReviewFixture): Promise<void> {
  await runCapturedExperienceReview(await captureReviewFixture(fixture));
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
    prefix: "openclaw-experience-maintenance-state-",
  });
});

afterEach(async () => {
  runEmbeddedAgent.mockReset();
  await testState.cleanup();
  await tempDirs.cleanup();
});

describe("experience review maintenance", () => {
  it("keeps completed maintenance edits when the Gateway resets", async () => {
    const workspaceDir = await tempDirs.make("openclaw-experience-reset-");
    const written = createDeferred();
    const release = createDeferred();
    const config = { skills: { workshop: { autonomous: { mode: "auto" as const } } } };
    const skillFile = path.join(resolveWorkshopSkillsDir(config, "main"), "procedure", "SKILL.md");
    const content = "# Procedure\n\nVerify the public generation.\n";
    runEmbeddedAgent.mockImplementation(async (params: RunEmbeddedAgentParams) => {
      await createWriteTool(params.workspaceDir).execute("review-write", {
        path: "procedure/SKILL.md",
        content,
      });
      written.resolve();
      await release.promise;
      return { meta: { durationMs: 1 } };
    });
    const review = runSkillExperienceReview({
      ctx: {
        sessionId: "foreground-session",
        sessionKey: "agent:main:reset",
        workspaceDir,
        modelProviderId: "openai",
        modelId: "gpt-test",
        foregroundPromptContext: foregroundPromptContext(workspaceDir),
      },
      config,
    });
    const settled = review.then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await Promise.race([written.promise, settled]);
      resetGatewayWorkAdmission();
      release.resolve();
      expect(await settled).toMatchObject({ message: "gateway runtime reset" });
      await expect(fs.readFile(skillFile, "utf8")).resolves.toBe(content);
      expect(Object.values(readSkillReviewOutcomes().experienceReviews)[0]).toMatchObject({
        outcome: "failed",
        error: expect.stringContaining("gateway runtime reset"),
      });
    } finally {
      release.resolve();
      await settled;
    }
  });

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
      await expect(runCapturedExperienceReview(candidate)).rejects.toThrow(
        "Completed-turn transcript anchor changed",
      );
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
        await expect(runCapturedExperienceReview(candidate)).rejects.toThrow(
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

  it.each(["delete", "replace", "permission", "restore", "append"] as const)(
    "revalidates source authority after a foreground %s",
    async (change) => {
      const workspaceDir = await tempDirs.make("openclaw-experience-live-source-");
      const candidate = await captureReviewFixture({
        ctx: {
          sessionId: "foreground-session",
          sessionKey: "agent:main:live-source",
          workspaceDir,
          modelProviderId: "openai",
          modelId: "gpt-test",
          foregroundPromptContext: {
            ...foregroundPromptContext(workspaceDir),
            permissionMode: "guarded",
            execOverrides: { security: "deny", ask: "always" },
          },
        },
        config: { skills: { workshop: { autonomous: { mode: "auto" } } } },
      });
      let retainedAssertion: (() => void) | undefined;
      runEmbeddedAgent.mockImplementation(async (params: RunEmbeddedAgentParams) => {
        expect(params.permissionMode).toBe("guarded");
        expect(params.execOverrides).toEqual({ security: "deny", ask: "always" });
        if (!params.preparedRunAdmission) {
          throw new Error("Review did not prepare run authority.");
        }
        const admitted = await params.preparedRunAdmission.admit("embedded");
        retainedAssertion = resolveAdmittedRunActiveAssertion(admitted, params.abortSignal);
        if (!retainedAssertion) {
          throw new Error("Review did not retain live source authority.");
        }
        retainedAssertion();
        if (change === "delete") {
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
        } else if (change === "replace") {
          await upsertSessionEntryCore(candidate.source, {
            sessionId: "replacement-session",
            updatedAt: Date.now(),
          });
        } else if (change === "permission" || change === "restore") {
          await upsertSessionEntryCore(candidate.source, {
            permissionMode: "read-only",
            updatedAt: Date.now(),
          });
        } else {
          SessionManager.open(candidate.source).appendMessage({
            role: "user",
            content: "Continue the foreground task.",
            timestamp: Date.now(),
          });
        }
        await Promise.resolve();
        if (change === "append") {
          retainedAssertion();
        } else {
          expect(retainedAssertion).toThrow("no longer active");
        }
        if (change === "restore") {
          await upsertSessionEntryCore(candidate.source, {
            permissionMode: "guarded",
            updatedAt: Date.now(),
          });
          expect(retainedAssertion).toThrow("no longer active");
        }
        return { meta: { durationMs: 1 } };
      });

      const review = runCapturedExperienceReview(candidate);
      if (change === "append") {
        await review;
      } else {
        await expect(review).rejects.toThrow("source");
      }
      expect(Object.values(readSkillReviewOutcomes().experienceReviews)[0]).toMatchObject({
        outcome: change === "append" ? "completed" : "failed",
      });
      expect(retainedAssertion).toBeDefined();
      expect(() => retainedAssertion?.()).toThrow("no longer active");
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

    const review = runSkillExperienceReview({
      ctx: {
        sessionId: "foreground-session",
        sessionKey: foregroundSessionKey,
        workspaceDir,
        modelProviderId: "openai",
        modelId: "gpt-test",
        foregroundPromptContext: foregroundPromptContext(workspaceDir),
      },
      config: { skills: { workshop: { autonomous: { mode: "propose" } } } },
    });
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
      await runSkillExperienceReview({
        ctx: {
          sessionId: "foreground-session",
          sessionKey: "agent:main:main",
          workspaceDir,
          modelProviderId: "openai",
          modelId: "gpt-test",
          foregroundPromptContext: foregroundPromptContext(workspaceDir),
        },
        config,
      });
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
      name: "keeps the isolated proposal pending after a successful draft review",
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
        skills: { workshop: { autonomous: { mode: "propose" as const } } },
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

      const review = runSkillExperienceReview(candidate);
      if (error) {
        await expect(review).rejects.toThrow(error);
      } else {
        await review;
      }

      const manifest = await listSkillProposals({ config: candidate.config, agentId: "main" });
      expect(manifest.proposals).toHaveLength(1);
      expect(manifest.proposals[0]).toMatchObject({
        skillKey: "deployment-preflight",
        status: "pending",
      });
      const skillFile = path.join(
        resolveWorkshopSkillsDir(config, "main", testState.env),
        "deployment-preflight",
        "SKILL.md",
      );
      await expect(fs.stat(skillFile)).rejects.toMatchObject({ code: "ENOENT" });
      if (error) {
        expect(Object.values(readSkillReviewOutcomes().experienceReviews)[0]).toMatchObject({
          outcome: "failed",
          error: expect.stringContaining(error),
        });
      } else {
        expect(Object.values(readSkillReviewOutcomes().experienceReviews)[0]).toMatchObject({
          outcome: "proposed",
          proposalId: manifest.proposals[0]?.id,
        });
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

  it.each(["auto", "propose"] as const)(
    "records %s completion with provider usage",
    async (mode) => {
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
      const config = { skills: { workshop: { autonomous: { mode } } } };

      await runSkillExperienceReview({
        ctx: {
          sessionId: "foreground-session",
          sessionKey: "agent:main:usage",
          workspaceDir,
          modelProviderId: "openai",
          modelId: "gpt-test",
          foregroundPromptContext: foregroundPromptContext(workspaceDir, "agent:main:usage"),
        },
        config,
      });

      expect(Object.values(readSkillReviewOutcomes().experienceReviews)[0]).toMatchObject({
        outcome: mode === "auto" ? "completed" : "nothing",
        usage: { inputTokens: 12_243, cachedInputTokens: 12_000, outputTokens: 91 },
      });
    },
  );

  it("edits the agent Workshop directory from a session worktree", async () => {
    const canonicalWorkspaceDir = await tempDirs.make("openclaw-experience-canonical-");
    const worktreeWorkspaceDir = await tempDirs.make("openclaw-experience-worktree-");
    const config = {
      agents: { entries: { main: { default: true, workspace: canonicalWorkspaceDir } } },
      skills: { workshop: { autonomous: { mode: "auto" as const } } },
    };
    const content = "# Deployment preflight\n\nRead the manifest before deploying.\n";
    runEmbeddedAgent.mockImplementation(async (params: RunEmbeddedAgentParams) => {
      await createWriteTool(params.workspaceDir).execute("review-write", {
        path: "deployment-preflight/SKILL.md",
        content,
      });
      return { meta: { durationMs: 1 } };
    });
    await runSkillExperienceReview({
      ctx: {
        runId: "foreground-run",
        sessionId: "foreground-session",
        sessionKey: "agent:main:main",
        workspaceDir: canonicalWorkspaceDir,
        modelProviderId: "openai",
        modelId: "gpt-test",
        foregroundPromptContext: foregroundPromptContext(worktreeWorkspaceDir),
      },
      config,
    });
    await expect(
      fs.readFile(
        path.join(resolveWorkshopSkillsDir(config, "main"), "deployment-preflight", "SKILL.md"),
        "utf8",
      ),
    ).resolves.toBe(content);
    await expect(
      fs.access(path.join(worktreeWorkspaceDir, "deployment-preflight")),
    ).rejects.toThrow();
    await expect(
      fs.access(path.join(canonicalWorkspaceDir, "deployment-preflight")),
    ).rejects.toThrow();
    expect(runEmbeddedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        bootstrapWorkspaceDir: canonicalWorkspaceDir,
        cwd: resolveWorkshopSkillsDir(config, "main"),
        sessionRoot: resolveWorkshopSkillsDir(config, "main"),
        requireWorkspaceOnly: true,
        requireWritableSandbox: true,
        skillsSnapshot: { prompt: "", skills: [] },
      }),
    );
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
      await runSkillExperienceReview(candidate);
    });

    expect(runEmbeddedAgent).toHaveBeenCalledTimes(1);
    expect(subordinateClosedInsideRun).toBe(false);
  });

  it("keeps a draft pending when auto mode is enabled during review", async () => {
    const workspaceDir = await tempDirs.make("openclaw-experience-mode-change-");
    const config: OpenClawConfig = {
      skills: { workshop: { autonomous: { mode: "propose" } } },
    };
    runEmbeddedAgent.mockImplementation(
      async (params: RunEmbeddedAgentParams & { config: OpenClawConfig; agentId: string }) => {
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
        config.skills = { workshop: { autonomous: { mode: "auto" } } };
        return { meta: { durationMs: 1 } };
      },
    );
    await runSkillExperienceReview({
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
    });
    expect((await listSkillProposals({ config, agentId: "main" })).proposals[0]).toMatchObject({
      status: "pending",
    });
    await expect(
      fs.access(
        path.join(resolveWorkshopSkillsDir(config, "main"), "deployment-preflight", "SKILL.md"),
      ),
    ).rejects.toThrow();
    expect(Object.values(readSkillReviewOutcomes().experienceReviews)[0]).toMatchObject({
      outcome: "proposed",
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
    const config = { skills: { workshop: { autonomous: { mode: "propose" as const } } } };

    await runSkillExperienceReview({
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
    });

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
