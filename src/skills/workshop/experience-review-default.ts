import {
  createSkillExperienceReviewScheduler,
  type SkillExperienceReviewParams,
} from "./experience-review-scheduler.js";

const defaultScheduler = createSkillExperienceReviewScheduler({
  isSystemActive: async () => {
    const { getActiveEmbeddedRunCount } =
      await import("../../agents/embedded-agent-runner/active-run-projections.js");
    return getActiveEmbeddedRunCount() > 0;
  },
  runReview: async (candidate) => {
    const { getRuntimeConfig } = await import("../../config/config.js");
    const { prepareSkillExperienceReviewCandidate, runSkillExperienceReview } =
      await import("./experience-review.js");
    const prepared = await prepareSkillExperienceReviewCandidate(candidate, getRuntimeConfig());
    if (prepared) {
      await runSkillExperienceReview(prepared);
    }
  },
});

/** Queues a conservative, post-run learning review after the agent system becomes idle. */
export function scheduleSkillExperienceReview(params: SkillExperienceReviewParams): void {
  defaultScheduler.schedule(params);
}
