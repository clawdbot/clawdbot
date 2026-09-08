import {
  GatewayErrorDetailCodes,
  type GitHubPublicationSelectionRejectedErrorDetails,
} from "../../packages/gateway-protocol/src/gateway-error-details.js";
import type { SessionGitHubPublicationResult } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";

type PublicationFailure = Pick<
  Extract<SessionGitHubPublicationResult, { status: "failed" }>,
  "code" | "nextAction"
>;

export type GitHubPublicationPreparation = {
  idempotencyKey: string;
  hasRequest: () => boolean;
};
const identityNextAction =
  "Reconnect My GitHub or System GitHub in Settings → Profile → GitHub connections (agent overrides: Agents → Tools), then request publication again.";

/** An owner observed a definitive outcome; an unavailable probe is not this failure. */
export class GitHubPublicationKnownFailure extends Error {
  constructor(
    message: string,
    readonly failure: PublicationFailure,
    readonly rejection?: GitHubPublicationSelectionRejectedErrorDetails,
  ) {
    super(message);
  }
}

export function rejectGitHubPublicationSelection(
  message: string,
  preparation?: GitHubPublicationPreparation,
): never {
  let rejection: GitHubPublicationSelectionRejectedErrorDetails | undefined;
  try {
    // Check at rejection, not before awaited preparation. Another invocation may have admitted.
    if (preparation && !preparation.hasRequest()) {
      rejection = {
        code: GatewayErrorDetailCodes.GITHUB_PUBLICATION_SELECTION_REJECTED,
        idempotencyKey: preparation.idempotencyKey,
      };
    }
  } catch {
    // An unreadable receipt cannot establish that publication was not admitted.
  }
  throw new GitHubPublicationKnownFailure(
    message,
    { code: "identity_changed", nextAction: identityNextAction },
    rejection,
  );
}

export class GitHubPublicationWorkspaceChangedError extends GitHubPublicationKnownFailure {
  constructor(message: string) {
    super(message, {
      code: "workspace_changed",
      nextAction:
        "Inspect the reconciled workspace and any recorded GitHub effects, then request a new publication after reviewing the changes.",
    });
  }
}

export class GitHubPublicationSessionChangedError extends GitHubPublicationKnownFailure {
  constructor() {
    super("GitHub publication session lifecycle changed.", {
      code: "session_changed",
      nextAction:
        "Review any recorded GitHub effects, then request publication from the current session.",
    });
  }
}

export function resolveGitHubPublicationFailure(error: unknown): PublicationFailure {
  if (error instanceof GitHubPublicationKnownFailure) {
    return error.failure;
  }
  const message = error instanceof Error ? error.message : "";
  if (message.includes("identity")) {
    return {
      code: message.includes("changed") ? "identity_changed" : "identity_unavailable",
      nextAction: identityNextAction,
    };
  }
  if (message.includes("session") || message.includes("worktree owner")) {
    return {
      code: "session_changed",
      nextAction: "Open the current session worktree and request publication again.",
    };
  }
  if (message.includes("transport configuration") || message.includes("replacement metadata")) {
    return {
      code: "workspace_changed",
      nextAction:
        "Remove the unsupported Git transport or replacement configuration from the session worktree, then retry.",
    };
  }
  if (message.includes("workspace") || message.includes("branch changed")) {
    return {
      code: "workspace_changed",
      nextAction:
        "Inspect the reconciled workspace and any recorded GitHub effects, then request a new publication after reviewing the changes.",
    };
  }
  if (message.includes("not a git")) {
    return { code: "not_git", nextAction: "Use a session-owned Git worktree to publish." };
  }
  if (message.includes("GitHub remote")) {
    return { code: "not_github", nextAction: "Use a GitHub repository remote to publish." };
  }
  if (message.includes("push")) {
    return {
      code: "push_rejected",
      nextAction:
        "Check repository write access and branch drift, then retry without force-pushing.",
    };
  }
  if (message.includes("pull request") || message.includes("GitHub")) {
    return {
      code: "github_rejected",
      nextAction: "Check pull-request permission for the effective account, then retry.",
    };
  }
  return { code: "unavailable", nextAction: "Retry after the Gateway and GitHub are available." };
}
