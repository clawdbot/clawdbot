import {
  createSkillExperienceReviewScheduler,
  type ExperienceReviewCandidate,
  prepareSkillExperienceReviewCandidate,
  runSkillExperienceReview,
  type SkillExperienceReviewParams,
} from "./experience-review.js";

const defaultScheduler = createSkillExperienceReviewScheduler({
  isSystemActive: async () => {
    const { getActiveEmbeddedRunCount } =
      await import("../../agents/embedded-agent-runner/active-run-projections.js");
    return getActiveEmbeddedRunCount() > 0;
  },
  prepareReview: async (candidate: ExperienceReviewCandidate) => {
    const { getRuntimeConfig } = await import("../../config/config.js");
    return prepareSkillExperienceReviewCandidate(candidate, getRuntimeConfig());
  },
  runReview: runSkillExperienceReview,
});

/** Queues a conservative, post-run learning review after the agent system becomes idle. */
export function scheduleSkillExperienceReview(params: SkillExperienceReviewParams): void {
  defaultScheduler.schedule(params);
}
