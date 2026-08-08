// Verifies agent-end side effects keep plugin hooks independent from experience review.
import { beforeEach, describe, expect, it, vi } from "vitest";
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

describe("agent end side effects", () => {
  beforeEach(() => {
    mockExperienceReview.mockReset();
    mockAwaitAgentEndHook.mockReset();
    mockRunAgentEndHook.mockReset();
  });

  it("fires plugin agent_end hooks alongside experience review scheduling", async () => {
    runAgentEndSideEffects({
      event: {
        messages: [],
        success: true,
      },
      ctx: {
        runId: "run-1",
        sessionKey: "agent:main:main",
        workspaceDir: "/workspace",
        trigger: "user",
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
    await vi.waitFor(() => expect(mockExperienceReview).toHaveBeenCalledTimes(1));
  });

  it("still runs agent_end hooks when experience review scheduling fails", async () => {
    mockExperienceReview.mockImplementationOnce(() => {
      throw new Error("scheduling failed");
    });

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

    expect(mockExperienceReview).toHaveBeenCalledTimes(1);
    expect(mockAwaitAgentEndHook).toHaveBeenCalledTimes(1);
  });
});
