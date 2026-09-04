import type { SessionGitHubPublicationResult } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";

type PublicationFailure = Pick<
  Extract<SessionGitHubPublicationResult, { status: "failed" }>,
  "code" | "nextAction"
>;

/** An owner observed a definitive outcome; an unavailable probe is not this failure. */
export class GitHubPublicationKnownFailure extends Error {
  constructor(
    message: string,
    readonly failure: PublicationFailure,
  ) {
    super(message);
  }
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

export function resolveGitHubPublicationFailure(error: unknown): PublicationFailure {
  if (error instanceof GitHubPublicationKnownFailure) {
    return error.failure;
  }
  const message = error instanceof Error ? error.message : "";
  if (message.includes("identity")) {
    return {
      code: message.includes("changed") ? "identity_changed" : "identity_unavailable",
      nextAction:
        "Reconnect My GitHub or System GitHub in Settings → Profile → GitHub connections (agent overrides: Agents → Tools), then request publication again.",
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
