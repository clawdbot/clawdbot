import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as transcriptAnchor from "../../config/sessions/session-accessor.sqlite-transcript-anchor.js";
import { recordRunSkillUsage } from "../../skills/runtime/run-usage.js";
import { scheduleSkillExperienceReview } from "../../skills/workshop/experience-review-default.js";
import { awaitAgentEndSideEffects, runAgentEndSideEffects } from "./agent-end-side-effects.js";
import {
  awaitAgentHarnessAgentEndHook,
  runAgentHarnessAgentEndHook,
} from "./lifecycle-hook-helpers.js";

vi.mock("../../skills/workshop/experience-review-default.js", () => ({
  scheduleSkillExperienceReview: vi.fn(),
}));

vi.mock("./lifecycle-hook-helpers.js", () => ({
  awaitAgentHarnessAgentEndHook: vi.fn(),
  runAgentHarnessAgentEndHook: vi.fn(),
}));

const mockExperienceReview = vi.mocked(scheduleSkillExperienceReview);
const mockAwaitAgentEndHook = vi.mocked(awaitAgentHarnessAgentEndHook);
const mockRunAgentEndHook = vi.mocked(runAgentHarnessAgentEndHook);
const skillExperienceReviewSource = {
  agentId: "main",
  sessionId: "session-1",
  sessionKey: "agent:main:main",
  storePath: "/session-store",
  entryId: "completed-message",
  generation: "generation-1",
  rawSeq: 1,
  effectiveParentId: null,
  activeMessagePosition: 0,
};

describe("agent end side effects", () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    vi.spyOn(transcriptAnchor, "readActiveTranscriptEntryAnchor").mockReturnValue(
      skillExperienceReviewSource,
    );
    mockExperienceReview.mockReset();
    mockAwaitAgentEndHook.mockReset();
    mockRunAgentEndHook.mockReset();
  });

  it("schedules experience review synchronously alongside plugin agent_end hooks", () => {
    recordRunSkillUsage({
      runId: "run-1",
      name: "release-runbook",
      source: "workspace",
      activation: "read",
    });
    runAgentEndSideEffects({
      skillExperienceReviewSource,
      event: {
        messages: [],
        success: true,
      },
      ctx: {
        runId: "run-1",
        sessionKey: "agent:main:main",
        workspaceDir: "/workspace",
        trigger: "user",
        foregroundPromptContext: {
          agentId: "main",
          agentDir: "/agent",
          workspaceDir: "/workspace",
          sandboxSessionKey: "agent:main:main",
          trigger: "user",
        },
        config: {
          skills: {
            workshop: {
              autonomous: {
                mode: "propose",
              },
            },
          },
        },
      },
    });

    expect(mockRunAgentEndHook).toHaveBeenCalledTimes(1);
    expect(mockExperienceReview).toHaveBeenCalledTimes(1);
    expect(mockExperienceReview).toHaveBeenCalledWith(
      expect.objectContaining({
        usedSkills: [{ name: "release-runbook", source: "workspace", activation: "read" }],
        source: skillExperienceReviewSource,
      }),
    );
  });

  it.each(["scheduling", "anchor read"])(
    "still runs agent_end hooks when %s fails",
    async (phase) => {
      const fail =
        phase === "scheduling"
          ? mockExperienceReview
          : vi.mocked(transcriptAnchor.readActiveTranscriptEntryAnchor);
      fail.mockImplementationOnce(() => {
        throw new Error(`${phase} failed`);
      });

      await awaitAgentEndSideEffects({
        skillExperienceReviewSource,
        event: {
          messages: [],
          success: true,
        },
        ctx: {
          runId: "run-1",
          workspaceDir: "/workspace",
          foregroundPromptContext: {
            agentId: "main",
            agentDir: "/agent",
            workspaceDir: "/workspace",
            sandboxSessionKey: "agent:main:main",
            trigger: "user",
          },
        },
      });

      expect(mockExperienceReview).toHaveBeenCalledTimes(phase === "scheduling" ? 1 : 0);
      expect(mockAwaitAgentEndHook).toHaveBeenCalledTimes(1);
    },
  );

  it("skips experience review for CLI hook contexts", async () => {
    await awaitAgentEndSideEffects({
      event: {
        messages: [],
        success: true,
      },
      ctx: {
        runId: "run-1",
        workspaceDir: "/workspace",
      },
    });

    expect(mockExperienceReview).not.toHaveBeenCalled();
    expect(mockAwaitAgentEndHook).toHaveBeenCalledTimes(1);
  });
});
