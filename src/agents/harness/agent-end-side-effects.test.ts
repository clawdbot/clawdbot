// Verifies agent-end side effects keep plugin hooks independent from auto-capture.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runSkillResearchAutoCapture } from "../../skills/research/autocapture.js";
import { scheduleSkillExperienceReview } from "../../skills/workshop/experience-review-default.js";
import { awaitAgentEndSideEffects, runAgentEndSideEffects } from "./agent-end-side-effects.js";
import {
  awaitAgentHarnessAgentEndHook,
  runAgentHarnessAgentEndHook,
} from "./lifecycle-hook-helpers.js";

vi.mock("../../skills/research/autocapture.js", () => ({
  runSkillResearchAutoCapture: vi.fn(),
}));

vi.mock("../../skills/workshop/experience-review-default.js", () => ({
  scheduleSkillExperienceReview: vi.fn(),
}));

vi.mock("./lifecycle-hook-helpers.js", () => ({
  awaitAgentHarnessAgentEndHook: vi.fn(),
  runAgentHarnessAgentEndHook: vi.fn(),
}));

const mockAutoCapture = vi.mocked(runSkillResearchAutoCapture);
const mockExperienceReview = vi.mocked(scheduleSkillExperienceReview);
const mockAwaitAgentEndHook = vi.mocked(awaitAgentHarnessAgentEndHook);
const mockRunAgentEndHook = vi.mocked(runAgentHarnessAgentEndHook);

describe("agent end side effects", () => {
  beforeEach(() => {
    mockAutoCapture.mockReset();
    mockExperienceReview.mockReset();
    mockAwaitAgentEndHook.mockReset();
    mockRunAgentEndHook.mockReset();
  });

  it("fires plugin agent_end hooks without waiting for Skill Research auto-capture", async () => {
    let resolveCapture: (() => void) | undefined;
    mockAutoCapture.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveCapture = resolve;
      }),
    );

    // Plugin hooks are user-visible lifecycle behavior; auto-capture is
    // opportunistic and must not delay fire-and-forget agent_end dispatch.
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
                enabled: true,
              },
            },
          },
        },
      },
    });

    expect(mockRunAgentEndHook).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(mockExperienceReview).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => {
      expect(mockAutoCapture).toHaveBeenCalledWith({
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
                  enabled: true,
                },
              },
            },
          },
        },
        config: {
          skills: {
            workshop: {
              autonomous: {
                enabled: true,
              },
            },
          },
        },
      });
    });

    resolveCapture?.();
  });

  it("still runs agent_end hooks when Skill Research auto-capture fails", async () => {
    mockAutoCapture.mockRejectedValueOnce(new Error("capture failed"));

    // Awaiting callers still get hook completion even when optional research
    // capture rejects.
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

    expect(mockAutoCapture).toHaveBeenCalledWith({
      event: {
        messages: [],
        success: true,
      },
      ctx: {
        runId: "run-1",
        workspaceDir: "/workspace",
      },
    });
    expect(mockAwaitAgentEndHook).toHaveBeenCalledTimes(1);
    expect(mockExperienceReview).toHaveBeenCalledTimes(1);
  });
});
