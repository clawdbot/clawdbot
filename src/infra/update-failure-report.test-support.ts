import { vi } from "vitest";
import type { GithubIssueSubmitHooks, PreparedGithubIssue } from "./github-issue.js";

export function mockCreatedIssue(url: string) {
  return vi.fn(async (_issue: PreparedGithubIssue, hooks: GithubIssueSubmitHooks) => {
    await hooks.afterAuthPreflight?.();
    const commitIssueCreate = await hooks.beforeIssueCreate?.();
    commitIssueCreate?.();
    return { status: "created" as const, url };
  });
}

export function mockFallbackIssue(fallbackUrl: string | undefined) {
  if (!fallbackUrl) {
    throw new Error("expected an available browser handoff");
  }
  return vi.fn(async (_issue: PreparedGithubIssue, hooks: GithubIssueSubmitHooks) => {
    await hooks.afterAuthPreflight?.();
    return {
      url: fallbackUrl,
      reason: "cli-unavailable" as const,
      status: "browser-fallback" as const,
    };
  });
}

export function mockFallbackAfterIssueCreateNoStart(fallbackUrl: string | undefined) {
  if (!fallbackUrl) {
    throw new Error("expected an available browser handoff");
  }
  return vi.fn(async (_issue: PreparedGithubIssue, hooks: GithubIssueSubmitHooks) => {
    await hooks.afterAuthPreflight?.();
    const commitIssueCreate = await hooks.beforeIssueCreate?.();
    commitIssueCreate?.();
    return {
      url: fallbackUrl,
      reason: "transport-unavailable" as const,
      status: "browser-fallback" as const,
    };
  });
}
