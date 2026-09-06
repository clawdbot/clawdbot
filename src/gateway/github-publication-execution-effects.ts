import type { SessionGitHubPublicationResult } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";

export type GitHubPublicationMutableFacts = {
  status?: string;
  head_commit?: string | null;
  pull_request_url?: string | null;
  error_code?: string | null;
  next_action?: string | null;
  last_effect?: string | null;
  effect_state?: string | null;
};

/** A receipt's execution closure records effects even when their awaited response outlives admission. */
export function createGitHubPublicationExecutionEffects<Row>(params: {
  write: (facts: GitHubPublicationMutableFacts, requireAction: boolean) => Row;
  interruptedStatus: "requested" | "needs_confirmation";
}) {
  const { write } = params;
  return {
    updateHead(headCommit: string): Row {
      return write({ head_commit: headCommit }, true);
    },
    complete(result: SessionGitHubPublicationResult): Row {
      if (result.status === "published") {
        return write(
          {
            status: "published",
            head_commit: result.headCommit,
            pull_request_url: result.url,
            error_code: null,
            next_action: null,
          },
          true,
        );
      }
      if (result.status !== "failed") {
        throw new Error("GitHub publication result is not terminal.");
      }
      return write(
        { status: "failed", error_code: result.code, next_action: result.nextAction },
        // Closing the session stops actions, but its exact execution still records
        // the terminal non-outcome after an already-dispatched effect is observed.
        result.code !== "session_changed",
      );
    },
    recordEffect(
      effect: "push" | "pull_request",
      observed?: { headCommit?: string; url?: string },
    ): void {
      // Recording an observation grants no further action after revocation.
      write(
        {
          last_effect: effect,
          effect_state: observed?.headCommit || observed?.url ? "observed" : "dispatched",
          ...(observed?.headCommit ? { head_commit: observed.headCommit } : {}),
          ...(observed?.url ? { pull_request_url: observed.url } : {}),
        },
        !observed,
      );
    },
    interrupt(): Row {
      return write(
        { status: params.interruptedStatus, error_code: null, next_action: null },
        false,
      );
    },
  };
}
