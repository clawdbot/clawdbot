#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_GITHUB_API_TIMEOUT_MS,
  evaluateClawSweeperExactHeadProof,
  evaluateRealBehaviorProof,
  isMaintainerTeamMember,
  withGitHubApiTimeout,
} from "./real-behavior-proof-policy.mjs";

function escapeCommandValue(value) {
  return String(value)
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A")
    .replace(/:/g, "%3A");
}

export async function fetchProofComments({
  owner,
  repo,
  issueNumber,
  tokens,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_GITHUB_API_TIMEOUT_MS,
}) {
  let lastError;
  for (const token of tokens.filter(Boolean)) {
    const comments = [];
    try {
      for (let page = 1; page <= 10; page += 1) {
        const url = new URL(
          `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
        );
        url.searchParams.set("per_page", "100");
        url.searchParams.set("page", String(page));
        const response = await withGitHubApiTimeout(
          `proof comment lookup page ${page}`,
          timeoutMs,
          (signal) =>
            fetchImpl(url, {
              headers: {
                Accept: "application/vnd.github+json",
                Authorization: `Bearer ${token}`,
                "X-GitHub-Api-Version": "2022-11-28",
              },
              signal,
            }),
        );
        if (!response.ok) {
          throw new Error(`comments API returned ${response.status}`);
        }
        const pageComments = await withGitHubApiTimeout(
          `proof comment response page ${page}`,
          timeoutMs,
          () => response.json(),
        );
        comments.push(...pageComments);
        if (pageComments.length < 100) {
          break;
        }
      }
      return comments;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("No GitHub token available for proof comment lookup.");
}

function isMainModule() {
  return Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);
}

async function main(env = process.env) {
  const eventPath = env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    console.error("::error title=Real behavior proof failed::GITHUB_EVENT_PATH is not set.");
    process.exit(1);
  }

  const event = JSON.parse(readFileSync(eventPath, "utf8"));
  const pullRequest = event.pull_request;
  if (!pullRequest) {
    console.log("No pull_request payload found; skipping real behavior proof gate.");
    process.exit(0);
  }

  const appToken = env.GH_APP_TOKEN;
  const org = event.repository?.owner?.login;
  const authorLogin = pullRequest.user?.login;
  if (appToken && org && authorLogin) {
    try {
      if (await isMaintainerTeamMember({ token: appToken, org, login: authorLogin })) {
        console.log(
          `PR author @${authorLogin} is an active member of the ${org}/maintainer team; skipping real behavior proof gate.`,
        );
        process.exit(0);
      }
    } catch (error) {
      console.warn(
        `::warning title=Maintainer membership check failed::${escapeCommandValue(error?.message ?? String(error))}`,
      );
    }
  }

  const evaluation = evaluateRealBehaviorProof({ pullRequest });
  if (evaluation.passed) {
    console.log(evaluation.reason);
    process.exit(0);
  }

  const repository = env.GITHUB_REPOSITORY;
  if ((appToken || env.GITHUB_TOKEN) && repository && pullRequest.number) {
    const [owner, repo] = repository.split("/");
    try {
      const comments = await fetchProofComments({
        owner,
        repo,
        issueNumber: pullRequest.number,
        tokens: [appToken, env.GITHUB_TOKEN],
      });

      const clawSweeperEvaluation = evaluateClawSweeperExactHeadProof({
        pullRequest,
        comments,
      });
      if (clawSweeperEvaluation.passed) {
        console.log(clawSweeperEvaluation.reason);
        process.exit(0);
      }
    } catch (error) {
      console.warn(
        `::warning title=Proof verdict comment lookup failed::${escapeCommandValue(error?.message ?? String(error))}`,
      );
    }
  }

  const message = `${evaluation.reason} Add after-fix evidence from a real OpenClaw setup in the PR body. Screenshots, recordings, terminal screenshots, console output, redacted runtime logs, linked artifacts, or copied live output count. Unit tests, mocks, snapshots, lint, typechecks, and CI are supplemental only. A maintainer can apply proof: override when appropriate.`;
  console.error(`::error title=Real behavior proof required::${escapeCommandValue(message)}`);
  process.exit(1);
}

export const testing = {
  fetchProofComments,
};

if (isMainModule()) {
  await main();
}
