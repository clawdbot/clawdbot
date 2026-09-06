import type { SessionMutationAuthorization } from "./types.js";

/** Keep the host lifetime and operator target policy on the same commit boundary. */
export function withSessionMutationCommitGuard(
  authorization: SessionMutationAuthorization | undefined,
  assertCommitAllowed: (() => void) | undefined,
): SessionMutationAuthorization | undefined {
  if (!assertCommitAllowed) {
    return authorization;
  }
  return {
    ...authorization,
    assertCurrent: () => {
      assertCommitAllowed();
      authorization?.assertCurrent();
    },
    assertTargetCurrent: (target) => {
      assertCommitAllowed();
      authorization?.assertTargetCurrent(target);
    },
  };
}
