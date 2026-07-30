import {
  createSkillExperienceReviewScheduler,
  type ExperienceReviewCandidate,
  prepareSkillExperienceReviewCandidate,
  runSkillExperienceReview,
  type SkillExperienceReviewParams,
} from "./experience-review.js";

const defaultScheduler = createSkillExperienceReviewScheduler({
  isSystemActive: async () => {
    const [{ getActiveEmbeddedRunCount }, { getActiveReplyRunCount }] = await Promise.all([
      import("../../agents/embedded-agent-runner/runs.js"),
      import("../../auto-reply/reply/reply-run-registry.js"),
    ]);
    // The embedded count already folds in reply-backed runs. Keep the direct
    // reply check explicit so this idle gate cannot regress if that contract changes.
    return getActiveEmbeddedRunCount() > 0 || getActiveReplyRunCount() > 0;
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
