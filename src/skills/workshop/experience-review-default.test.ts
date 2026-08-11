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

  it("cancels existing work and consumes the stopped run terminal event", () => {
    const sessionKey = "agent:main:stopped-default-review";
    skillExperienceReviewCancellation.cancel(sessionKey, true);

    expect(schedulerMocks.cancel).toHaveBeenCalledWith(sessionKey);

    const params = {
      event: { success: false, messages: [] },
      ctx: { sessionKey },
    } as Parameters<typeof scheduleSkillExperienceReview>[0];
    scheduleSkillExperienceReview(params);
    expect(schedulerMocks.schedule).not.toHaveBeenCalled();

    scheduleSkillExperienceReview(params);
    expect(schedulerMocks.schedule).toHaveBeenCalledWith(params);
  });
});
