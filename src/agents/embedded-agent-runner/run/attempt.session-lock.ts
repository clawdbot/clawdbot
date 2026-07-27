/**
 * Coordinates embedded-attempt session ownership, takeover, and prompt locks.
 */
export {
  createEmbeddedAttemptSessionLockController,
  type EmbeddedAttemptSessionLockController,
} from "./attempt.session-lock.controller.js";
export { EmbeddedAttemptSessionTakeoverError } from "./attempt.session-lock.fence-controller.js";
export {
  acquireEmbeddedAttemptSessionFileOwner,
  type EmbeddedAttemptSessionFileOwner,
} from "./attempt.session-lock.owner.js";
export { installPromptSubmissionLockRelease } from "./attempt.session-lock.prompt.js";
