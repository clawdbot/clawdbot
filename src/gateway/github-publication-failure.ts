import type { SessionGitHubPublicationResult } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";

export function resolveGitHubPublicationFailure(error: unknown): {
  code: Extract<SessionGitHubPublicationResult, { status: "failed" }>["code"];
  nextAction: string;
} {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("identity")) {
    return {
      code: message.includes("changed") ? "identity_changed" : "identity_unavailable",
      nextAction:
        "Reconnect the GitHub identity in Agents → Tools, then request publication again.",
    };
  }
  if (message.includes("session") || message.includes("worktree owner")) {
    return {
      code: "session_changed",
      nextAction: "Open the current session worktree and request publication again.",
    };
  }
  if (message.includes("workspace") || message.includes("branch changed")) {
    return {
      code: "workspace_changed",
      nextAction:
        "Wait for the current turn to finish, inspect the reconciled workspace, and retry.",
    };
  }
  if (message.includes("not a git")) {
    return { code: "not_git", nextAction: "Use a session-owned Git worktree to publish." };
  }
  if (message.includes("GitHub remote")) {
    return { code: "not_github", nextAction: "Use a GitHub repository remote to publish." };
  }
  if (message.includes("no changes")) {
    return { code: "no_changes", nextAction: "Make or restore a repository change, then retry." };
  }
  if (message.includes("push")) {
    return {
      code: "push_rejected",
      nextAction:
        "Check repository write access and branch drift, then retry without force-pushing.",
    };
  }
  if (message.includes("pull request was closed")) {
    return {
      code: "github_rejected",
      nextAction: "Reopen the closed pull request or retry to create a new publication request.",
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
