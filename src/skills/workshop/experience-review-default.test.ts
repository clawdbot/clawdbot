import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentEndCancellation } from "../../agents/harness/agent-end-cancellation.js";
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

  it("cancels existing work and consumes the stopped run terminal event", async () => {
    const sessionKey = "agent:main:stopped-default-review";
    const reservation = agentEndCancellation.reserve(sessionKey, ["stopped-run"]);
    agentEndCancellation.reconcile(reservation, ["stopped-run"]);

    expect(schedulerMocks.cancel).toHaveBeenCalledWith(sessionKey);

    const params = {
      event: { success: false, messages: [] },
      ctx: { sessionKey, runId: "stopped-run" },
    } as Parameters<typeof scheduleSkillExperienceReview>[0];
    await scheduleSkillExperienceReview(params);
    expect(schedulerMocks.schedule).not.toHaveBeenCalled();

    await scheduleSkillExperienceReview(params);
    expect(schedulerMocks.schedule).toHaveBeenCalledWith(params);
  });

  it("does not let another failed run consume the stopped run marker", async () => {
    const sessionKey = "agent:main:reordered-terminals";
    const reservation = agentEndCancellation.reserve(sessionKey, ["stopped-run"]);
    agentEndCancellation.reconcile(reservation, ["stopped-run"]);
    const unrelated = {
      event: { success: false, messages: [] },
      ctx: { sessionKey, runId: "unrelated-run" },
    } as Parameters<typeof scheduleSkillExperienceReview>[0];
    const stopped = {
      event: { success: false, messages: [] },
      ctx: { sessionKey, runId: "stopped-run" },
    } as Parameters<typeof scheduleSkillExperienceReview>[0];

    await scheduleSkillExperienceReview(unrelated);
    expect(schedulerMocks.schedule).toHaveBeenCalledWith(unrelated);
    schedulerMocks.schedule.mockClear();

    await scheduleSkillExperienceReview(stopped);
    expect(schedulerMocks.schedule).not.toHaveBeenCalled();
  });
});
