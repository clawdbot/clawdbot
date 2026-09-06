import { afterEach, describe, expect, it, vi } from "vitest";
import type { EmbeddedRunTrigger } from "../../agents/embedded-agent-runner/run/params.js";
import {
  getPreparedModelRuntimePluginGeneration,
  withPreparedModelRuntimePluginGenerationScope,
} from "../../agents/prepared-model-runtime-generation-scope.js";
import type { PreparedModelRuntimePluginGeneration } from "../../agents/prepared-model-runtime.types.js";
import {
  createNestedToolActivity,
  projectNestedToolActivityForHooks,
} from "../../sessions/nested-tool-activity.js";
import { buildSkillExperienceReviewPrompt } from "./experience-review-prompt.js";
import {
  createSkillExperienceReviewScheduler,
  type ExperienceReviewCandidate,
  type SkillExperienceReviewParams,
} from "./experience-review-scheduler.js";
import { prepareSkillExperienceReviewCandidate } from "./experience-review.js";

function completedRun(
  options: {
    messages?: number;
    modelIterations?: number;
    success?: boolean;
    error?: string;
    agentId?: string;
    sessionKey?: string;
    runId?: string;
    mode?: "off" | "propose" | "auto";
    trigger?: EmbeddedRunTrigger;
    skillWorkshopAvailable?: boolean;
  } = {},
): SkillExperienceReviewParams {
  const messageCount = options.messages ?? options.modelIterations ?? 10;
  return {
    event: {
      success: options.success ?? true,
      ...(options.error ? { error: options.error } : {}),
      messages: [
        { role: "user", content: "Repair the workflow." },
        ...Array.from({ length: messageCount }, () => ({
          role: "assistant",
          content: "work",
        })),
      ],
    },
    ctx: {
      agentId: options.agentId ?? "main",
      runId: options.runId ?? "run-1",
      sessionId: "session-1",
      sessionKey: options.sessionKey ?? "agent:main:main",
      workspaceDir: "/workspace",
      modelProviderId: "openai",
      modelId: "gpt-test",
      authProfileId: "openai:work",
      modelIterations: options.modelIterations,
      skillWorkshopAvailable: options.skillWorkshopAvailable ?? true,
      foregroundPromptContext: {
        agentId: options.agentId ?? "main",
        agentDir: "/agent",
        workspaceDir: "/workspace",
        cwd: "/workspace",
        sandboxSessionKey: options.sessionKey ?? "agent:main:main",
        trigger: options.trigger ?? "user",
        reasoningLevel: "on",
      },
    },
    config: { skills: { workshop: { autonomous: { mode: options.mode ?? "propose" } } } },
    source: {
      agentId: options.agentId ?? "main",
      sessionId: "session-1",
      sessionKey: options.sessionKey ?? "agent:main:main",
      storePath: "/session-store",
      entryId: "completed-message",
      generation: "generation-1",
      rawSeq: 1,
      effectiveParentId: null,
      activeMessagePosition: 0,
    },
  };
}

function captureCandidate(params: SkillExperienceReviewParams): ExperienceReviewCandidate {
  const source = params.source!;
  return {
    ctx: {
      runId: params.ctx.runId,
      workspaceDir: params.ctx.workspaceDir!,
      modelProviderId: params.ctx.modelProviderId!,
      modelId: params.ctx.modelId!,
      authProfileId: params.ctx.authProfileId,
      foregroundPromptContext: params.ctx.foregroundPromptContext,
    },
    config: params.config,
    source,
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => vi.useRealTimers());

describe("skill experience review scheduler", () => {
  it("runs detached review work outside the foreground prepared generation", async () => {
    const generation: PreparedModelRuntimePluginGeneration = {
      configuredCatalogEntries: [],
      inlineProviderModels: [],
      pluginMetadataSnapshot: {} as never,
    };
    const observedGenerations: Array<PreparedModelRuntimePluginGeneration | undefined> = [];
    let finishReview: (() => void) | undefined;
    const reviewFinished = new Promise<void>((resolve) => {
      finishReview = resolve;
    });
    const scheduler = createSkillExperienceReviewScheduler({
      isSystemActive: () => {
        observedGenerations.push(getPreparedModelRuntimePluginGeneration());
        return false;
      },
      runReview: async (candidate) => {
        observedGenerations.push(getPreparedModelRuntimePluginGeneration());
        await prepareSkillExperienceReviewCandidate(candidate, candidate.config);
        observedGenerations.push(getPreparedModelRuntimePluginGeneration());
        finishReview?.();
      },
      setTimer: (callback) => setTimeout(callback, 0),
    });

    withPreparedModelRuntimePluginGenerationScope(generation, () => {
      scheduler.schedule(completedRun());
    });
    await reviewFinished;

    expect(observedGenerations).toEqual([undefined, undefined, undefined]);
    scheduler.clear();
  });

  it("runs one deep turn after the idle window", async () => {
    vi.useFakeTimers();
    const runReview = vi.fn().mockResolvedValue(undefined);
    const scheduler = createSkillExperienceReviewScheduler({
      isSystemActive: () => false,
      runReview,
    });
    scheduler.schedule(completedRun({ modelIterations: 10 }));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(runReview).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(runReview).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({
          sessionId: "session-1",
          sessionKey: "agent:main:main",
        }),
        ctx: expect.objectContaining({
          foregroundPromptContext: expect.objectContaining({ reasoningLevel: "on" }),
        }),
      }),
    );
    expect(runReview.mock.calls[0]?.[0]).not.toHaveProperty("transcript");
    scheduler.clear();
  });

  it("does not count nested tool activity as model iterations", async () => {
    vi.useFakeTimers();
    const runReview = vi.fn().mockResolvedValue(undefined);
    const scheduler = createSkillExperienceReviewScheduler({
      isSystemActive: () => false,
      runReview,
    });
    const run = completedRun({ messages: 2 });
    const activities = Array.from({ length: 8 }, (_, index) =>
      createNestedToolActivity({
        runId: "run-1",
        scopeId: "scope-1",
        afterEntryId: null,
        startOrder: index,
        parentToolCallId: "outer-exec",
        toolCallId: `nested-${index}`,
        toolName: "read",
        input: {},
        result: { content: [{ type: "text", text: "file contents" }] },
        isError: false,
        startedAt: index,
        timestamp: index + 1,
      }),
    );
    run.event.messages = projectNestedToolActivityForHooks(run.event.messages, activities);

    scheduler.schedule(run);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(runReview).not.toHaveBeenCalled();
    scheduler.clear();
  });

  it("uses the exact harness iteration count when messages diverge", async () => {
    vi.useFakeTimers();
    const runReview = vi.fn().mockResolvedValue(undefined);
    const scheduler = createSkillExperienceReviewScheduler({
      isSystemActive: () => false,
      runReview,
    });

    scheduler.schedule(completedRun({ messages: 1, modelIterations: 10 }));
    await vi.advanceTimersByTimeAsync(30_000);

    expect(runReview).toHaveBeenCalledOnce();
    expect(runReview.mock.calls[0]?.[0]).not.toHaveProperty("modelIterations");
    scheduler.clear();
  });

  it.each([
    { modelIterations: 0, completions: 12 },
    { modelIterations: 4, completions: 3 },
  ])("does not pool $modelIterations-iteration turns", async ({ modelIterations, completions }) => {
    vi.useFakeTimers();
    const runReview = vi.fn().mockResolvedValue(undefined);
    const scheduler = createSkillExperienceReviewScheduler({
      isSystemActive: () => false,
      runReview,
    });

    for (let index = 0; index < completions; index += 1) {
      scheduler.schedule(completedRun({ messages: 10, modelIterations, runId: `run-${index}` }));
    }
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runReview).not.toHaveBeenCalled();
    scheduler.clear();
  });

  it("defers while the system is active", async () => {
    vi.useFakeTimers();
    const runReview = vi.fn().mockResolvedValue(undefined);
    const isSystemActive = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    const scheduler = createSkillExperienceReviewScheduler({ isSystemActive, runReview });
    scheduler.schedule(completedRun());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(runReview).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(runReview).toHaveBeenCalledOnce();
    scheduler.clear();
  });

  it("rechecks current autonomy and tool policy before a delayed review", async () => {
    vi.useFakeTimers();
    const runReview = vi.fn().mockResolvedValue(undefined);
    const review = vi.fn(async (candidate: ExperienceReviewCandidate) => {
      const prepared = await prepareSkillExperienceReviewCandidate(candidate, {
        skills: { workshop: { autonomous: { mode: "propose" } } },
        tools: { deny: ["skill_workshop"] },
      });
      if (prepared) {
        await runReview(prepared);
      }
    });
    const scheduler = createSkillExperienceReviewScheduler({
      isSystemActive: () => false,
      runReview: review,
    });

    scheduler.schedule(completedRun());
    await vi.advanceTimersByTimeAsync(30_000);

    expect(review).toHaveBeenCalledOnce();
    expect(runReview).not.toHaveBeenCalled();
    scheduler.clear();
  });

  it("rechecks group policy while preserving main-session sandbox identity", async () => {
    const groupParams = completedRun({ sessionKey: "agent:main:whatsapp:group:safe-room" });
    groupParams.ctx.foregroundPromptContext.messageProvider = "whatsapp";
    groupParams.ctx.foregroundPromptContext.groupId = "safe-room";
    await expect(
      prepareSkillExperienceReviewCandidate(captureCandidate(groupParams), {
        skills: { workshop: { autonomous: { mode: "propose" } } },
        channels: {
          whatsapp: { groups: { "safe-room": { tools: { deny: ["skill_workshop"] } } } },
        },
      }),
    ).resolves.toBeUndefined();

    const mainParams = completedRun();
    await expect(
      prepareSkillExperienceReviewCandidate(captureCandidate(mainParams), {
        skills: { workshop: { autonomous: { mode: "propose" } } },
        agents: { defaults: { sandbox: { mode: "non-main" } } },
      }),
    ).resolves.toBeDefined();
  });

  it("extends quiet time and replaces the pending candidate after later work", async () => {
    vi.useFakeTimers();
    const runReview = vi.fn().mockResolvedValue(undefined);
    const scheduler = createSkillExperienceReviewScheduler({
      isSystemActive: () => false,
      runReview,
    });

    scheduler.schedule(completedRun({ runId: "older" }));
    await vi.advanceTimersByTimeAsync(29_000);
    scheduler.schedule(completedRun({ runId: "newer", messages: 12, modelIterations: 12 }));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(runReview).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(runReview).toHaveBeenCalledWith(
      expect.objectContaining({ ctx: expect.objectContaining({ runId: "newer" }) }),
    );
    scheduler.clear();
  });

  it("replaces queued evidence when the same run later aborts", async () => {
    vi.useFakeTimers();
    const runReview = vi.fn().mockResolvedValue(undefined);
    const scheduler = createSkillExperienceReviewScheduler({
      isSystemActive: () => false,
      runReview,
    });

    scheduler.schedule(completedRun({ runId: "retried-run" }));
    scheduler.schedule(
      completedRun({ runId: "retried-run", messages: 12, modelIterations: 12, success: false }),
    );
    await vi.advanceTimersByTimeAsync(30_000);

    expect(runReview).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({ runId: "retried-run" }),
        turnAborted: true,
      }),
    );
    scheduler.clear();
  });

  it.each([
    { agentId: "qa", reviewCount: 0 },
    { agentId: "beta", reviewCount: 1 },
  ])("limits cancellation by $agentId to its own queued run", async ({ agentId, reviewCount }) => {
    vi.useFakeTimers();
    const runReview = vi.fn().mockResolvedValue(undefined);
    const scheduler = createSkillExperienceReviewScheduler({
      isSystemActive: () => false,
      runReview,
    });

    const run = { sessionKey: "global", runId: "retried-run" };
    scheduler.schedule(completedRun({ ...run, agentId: "qa" }));
    scheduler.schedule(completedRun({ ...run, agentId, success: false, error: "boom" }));
    await vi.runAllTimersAsync();

    expect(runReview).toHaveBeenCalledTimes(reviewCount);
    scheduler.clear();
  });

  it("forwards every member role through delayed policy checks", async () => {
    vi.useFakeTimers();
    const memberRoleIds = Array.from({ length: 150 }, (_, index) => `role-${index}`);
    const params = completedRun();
    params.ctx.foregroundPromptContext.memberRoleIds = memberRoleIds;
    const reviewed: ExperienceReviewCandidate[] = [];
    const scheduler = createSkillExperienceReviewScheduler({
      isSystemActive: () => false,
      runReview: async (candidate) => {
        const prepared = await prepareSkillExperienceReviewCandidate(candidate, params.config);
        if (prepared) {
          reviewed.push(prepared);
        }
      },
    });

    scheduler.schedule(params);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(reviewed[0]?.ctx.foregroundPromptContext.memberRoleIds).toEqual(memberRoleIds);
    scheduler.clear();
  });

  it("discards a stale timer callback when a later completion rearms the session", async () => {
    vi.useFakeTimers();
    let resolveActivity: ((active: boolean) => void) | undefined;
    const runReview = vi.fn().mockResolvedValue(undefined);
    const isSystemActive = vi
      .fn()
      .mockReturnValueOnce(
        new Promise<boolean>((resolve) => {
          resolveActivity = resolve;
        }),
      )
      .mockReturnValue(false);
    const scheduler = createSkillExperienceReviewScheduler({ isSystemActive, runReview });

    scheduler.schedule(completedRun({ runId: "older" }));
    await vi.advanceTimersByTimeAsync(30_000);
    scheduler.schedule(completedRun({ runId: "newer" }));
    resolveActivity?.(false);
    await Promise.resolve();
    expect(runReview).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(runReview).toHaveBeenCalledOnce();
    expect(runReview.mock.calls[0]?.[0].ctx.runId).toBe("newer");
    scheduler.clear();
  });

  it("does not re-arm evidence during asynchronous review preparation", async () => {
    vi.useFakeTimers();
    let finishPreparation: (() => void) | undefined;
    const runReview = vi.fn().mockResolvedValue(undefined);
    const review = vi.fn(async (candidate: ExperienceReviewCandidate) => {
      const prepared = await prepareSkillExperienceReviewCandidate(candidate, candidate.config);
      await new Promise<void>((resolve) => {
        finishPreparation = resolve;
      });
      if (prepared) {
        await runReview(prepared);
      }
    });
    const scheduler = createSkillExperienceReviewScheduler({
      isSystemActive: () => false,
      runReview: review,
    });

    scheduler.schedule(completedRun({ runId: "deep-turn" }));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(review).toHaveBeenCalledOnce();
    expect(runReview).not.toHaveBeenCalled();

    scheduler.schedule(completedRun({ runId: "shallow-turn", modelIterations: 1 }));
    finishPreparation?.();
    await flushMicrotasks();
    expect(runReview).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(runReview).toHaveBeenCalledOnce();
    scheduler.clear();
  });

  it.each([
    {
      name: "distinct session keys",
      first: { agentId: "main", sessionKey: "agent:main:first" },
      second: { agentId: "main", sessionKey: "agent:main:second" },
    },
    {
      name: "distinct owners of global",
      first: { agentId: "qa", sessionKey: "global" },
      second: { agentId: "beta", sessionKey: "global" },
    },
  ])("serializes reviews for $name", async ({ first, second }) => {
    vi.useFakeTimers();
    let finishFirst: (() => void) | undefined;
    const runReview = vi
      .fn()
      .mockReturnValueOnce(
        new Promise<void>((resolve) => {
          finishFirst = resolve;
        }),
      )
      .mockResolvedValue(undefined);
    const scheduler = createSkillExperienceReviewScheduler({
      isSystemActive: () => false,
      runReview,
    });

    scheduler.schedule(completedRun(first));
    scheduler.schedule(completedRun(second));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(runReview).toHaveBeenCalledOnce();
    expect(runReview.mock.calls[0]?.[0].source).toMatchObject(first);

    finishFirst?.();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(runReview).toHaveBeenCalledTimes(2);
    expect(runReview.mock.calls[1]?.[0].source).toMatchObject(second);
    scheduler.clear();
  });

  it("drops the pending review after a failure", async () => {
    const callbacks: Array<() => void> = [];
    const setTimer = vi.fn((callback: () => void) => {
      callbacks.push(callback);
      const timer = setTimeout(() => {}, 60_000);
      timer.unref();
      return timer;
    });
    const runReview = vi.fn().mockRejectedValue(new Error("provider unavailable"));
    const scheduler = createSkillExperienceReviewScheduler({
      isSystemActive: () => false,
      runReview,
      setTimer,
    });
    scheduler.schedule(completedRun());
    callbacks[0]?.();
    await flushMicrotasks();
    expect(runReview).toHaveBeenCalledOnce();
    expect(setTimer).toHaveBeenCalledOnce();
    callbacks[0]?.();
    await flushMicrotasks();
    expect(runReview).toHaveBeenCalledOnce();
    scheduler.clear();
  });

  it("skips errored, disabled, unavailable, and internal runs", async () => {
    vi.useFakeTimers();
    const runReview = vi.fn().mockResolvedValue(undefined);
    const scheduler = createSkillExperienceReviewScheduler({
      isSystemActive: () => false,
      runReview,
    });
    scheduler.schedule(completedRun({ success: false, error: "failed" }));
    scheduler.schedule(completedRun({ mode: "off", sessionKey: "agent:main:off" }));
    scheduler.schedule(
      completedRun({ skillWorkshopAvailable: false, sessionKey: "agent:main:hidden" }),
    );
    scheduler.schedule(completedRun({ trigger: "cron", sessionKey: "agent:main:cron-run" }));
    await vi.runAllTimersAsync();
    expect(runReview).not.toHaveBeenCalled();
    scheduler.clear();
  });

  it("marks an interrupted deep turn", async () => {
    vi.useFakeTimers();
    const runReview = vi.fn().mockResolvedValue(undefined);
    const scheduler = createSkillExperienceReviewScheduler({
      isSystemActive: () => false,
      runReview,
    });
    scheduler.schedule(completedRun({ success: false }));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(runReview).toHaveBeenCalledWith(expect.objectContaining({ turnAborted: true }));
    scheduler.clear();
  });
});

describe("skill experience review prompt", () => {
  it("caps used and existing skill lists", () => {
    const skills = Array.from({ length: 120 }, (_, index) => ({
      name: `skill-${String(index).padStart(3, "0")}-${"x".repeat(180)}`,
      source: "workspace" as const,
      activation: "read" as const,
    }));
    const prompt = buildSkillExperienceReviewPrompt({
      usedSkills: skills,
      existingSkills: skills,
    });
    expect(prompt).toContain("more used skills omitted");
    expect(prompt).toContain("(+70 more not shown)");
    expect(Math.max(...prompt.split("\n").map((line) => line.length))).toBeLessThanOrEqual(2_000);
  });

  it("renders a deterministic and capped used-skills receipt", () => {
    const usedSkills = Array.from({ length: 120 }, (_, index) => ({
      name: `skill-${String(index).padStart(3, "0")}-${"x".repeat(180)}`,
      source: index % 2 === 0 ? ("workspace" as const) : ("bundled" as const),
      activation: index % 3 === 0 ? ("command" as const) : ("read" as const),
    }));
    const build = (skills: typeof usedSkills) =>
      buildSkillExperienceReviewPrompt({ usedSkills: skills });
    const prompt = build(usedSkills.toReversed());

    expect(prompt).toBe(build(usedSkills));
    const receipt = prompt.slice(
      prompt.indexOf("Skills actually used in this trajectory"),
      prompt.indexOf("\n\nExisting Workshop-generated skills:"),
    );
    expect(receipt).toContain(
      "Skills actually used in this trajectory (authoritative runtime receipt):",
    );
    expect(receipt.length).toBeLessThanOrEqual(2_000);
    expect(receipt).toContain("- skill-000-");
    expect(receipt).toContain("more used skills omitted");
  });

  it("caps existing skills by entry count and line length", () => {
    const prompt = buildSkillExperienceReviewPrompt({
      existingSkills: Array.from({ length: 120 }, (_, index) => ({
        name: `skill-${String(index)}`,
        description: "d".repeat(500),
      })),
    });

    expect(prompt).toContain("- skill-49");
    expect(prompt).not.toContain("- skill-50");
    expect(prompt).toContain("(+70 more not shown)");
    for (const line of prompt.split("\n")) {
      if (line.startsWith("- skill-")) {
        expect(line.length).toBeLessThanOrEqual(200);
      }
    }
  });

  it("adds the interrupted-run instruction", () => {
    const prompt = buildSkillExperienceReviewPrompt({ turnAborted: true });
    expect(prompt).toContain("Only capture procedures that visibly worked");
  });
});

describe("skill experience review preparation", () => {
  it.each([
    { agentId: "direct", eligible: true },
    { agentId: "isolated", eligible: false },
  ])("rechecks $agentId sandbox policy for global reviews", async ({ agentId, eligible }) => {
    const params = completedRun({ sessionKey: "global" });
    params.ctx.agentId = agentId;
    params.ctx.foregroundPromptContext.agentId = agentId;
    const result = await prepareSkillExperienceReviewCandidate(captureCandidate(params), {
      session: { scope: "global" },
      agents: {
        entries: {
          direct: { sandbox: { mode: "off" } },
          isolated: { sandbox: { mode: "all" } },
        },
      },
      skills: { workshop: { autonomous: { mode: "propose" } } },
    });

    expect(result !== undefined).toBe(eligible);
  });

  it("keeps an eligible foreground candidate", async () => {
    const params = completedRun();
    await expect(
      prepareSkillExperienceReviewCandidate(captureCandidate(params), params.config),
    ).resolves.toBeDefined();
  });
});
