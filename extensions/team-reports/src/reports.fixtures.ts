import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { GithubCounts } from "./types.js";

export type Complete = OpenClawPluginApi["runtime"]["llm"]["complete"];

export function githubCounts(total = 0): GithubCounts {
  return {
    total,
    commits: total,
    prsOpened: 0,
    prsMerged: 0,
    prsClosed: 0,
    issuesOpened: 0,
    issuesClosed: 0,
    issueComments: 0,
    reviewComments: 0,
    securityAdvisories: 0,
    repos: total ? { "example/project": total } : {},
  };
}

export function completion(text: string): Awaited<ReturnType<Complete>> {
  return {
    text,
    provider: "openai",
    model: "gpt-5.6-sol",
    agentId: "main",
    usage: {},
    execution: { mode: "direct-provider", owner: { kind: "provider", id: "openai" } },
    audit: { caller: { kind: "plugin", id: "team-reports" } },
  };
}
