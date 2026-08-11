import { beforeEach, describe, expect, it, vi } from "vitest";
import { skillExperienceReviewCancellation } from "./experience-review-cancellation.js";
import { scheduleSkillExperienceReview } from "./experience-review-default.js";

const schedulerMocks = vi.hoisted(() => ({
  cancel: vi.fn(() => false),
  schedule: vi.fn(),
}));

vi.mock("./experience-review.js", () => ({
  createSkillExperienceReviewScheduler: () => schedulerMocks,
  prepareSkillExperienceReviewCandidate: vi.fn(),
  runSkillExperienceReview: vi.fn(),
}));

describe("default skill experience review cancellation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("suppresses only the stopped run when another terminal arrives first", () => {
    const sessionKey = "agent:main:stopped-default-review";
    skillExperienceReviewCancellation.cancel(sessionKey, "run-stopped");

    expect(schedulerMocks.cancel).toHaveBeenCalledWith(sessionKey);

    const otherRun = {
      event: { success: false, messages: [] },
      ctx: { sessionKey, runId: "run-other" },
    } as Parameters<typeof scheduleSkillExperienceReview>[0];
    scheduleSkillExperienceReview(otherRun);
    expect(schedulerMocks.schedule).toHaveBeenCalledWith(otherRun);

    schedulerMocks.schedule.mockClear();
    const stoppedRun = {
      event: { success: false, messages: [] },
      ctx: { sessionKey, runId: "run-stopped" },
    } as Parameters<typeof scheduleSkillExperienceReview>[0];
    scheduleSkillExperienceReview(stoppedRun);
    expect(schedulerMocks.schedule).not.toHaveBeenCalled();
  });
});
