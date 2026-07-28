#!/usr/bin/env node
// Checks external PR body context and evidence.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  evaluatePullRequestContext,
  isMaintainerTeamMember,
} from "./real-behavior-proof-policy.mjs";

function escapeCommandValue(value) {
  return String(value)
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A")
    .replace(/:/g, "%3A");
}

function isMainModule() {
  return Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);
}

async function main(env = process.env) {
  const eventPath = env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    console.error("::error title=PR context check failed::GITHUB_EVENT_PATH is not set.");
    process.exit(1);
  }

  const event = JSON.parse(readFileSync(eventPath, "utf8"));
  const pullRequest = event.pull_request;
  if (!pullRequest) {
    console.log("No pull_request payload found; skipping PR context check.");
    process.exit(0);
  }

  const appToken = env.GH_APP_TOKEN;
  const org = event.repository?.owner?.login;
  const authorLogin = pullRequest.user?.login;
  if (appToken && org && authorLogin) {
    try {
      if (await isMaintainerTeamMember({ token: appToken, org, login: authorLogin })) {
        console.log(
          `PR author @${authorLogin} is an active member of the ${org}/maintainer team; skipping PR context check.`,
        );
        process.exit(0);
      }
    } catch (error) {
      console.warn(
        `::warning title=Maintainer membership check failed::${escapeCommandValue(error?.message ?? String(error))}`,
      );
    }
  }

  const evaluation = evaluatePullRequestContext({ pullRequest });
  if (evaluation.passed) {
    console.log(evaluation.reason);
    process.exit(0);
  }

  const message = `${evaluation.reason} Add a concise problem statement and the most useful validation evidence to the PR body. Focused tests, CI results, screenshots, recordings, terminal output, live observations, redacted logs, and artifact links all count.`;
  console.error(`::error title=PR context required::${escapeCommandValue(message)}`);
  process.exit(1);
}

if (isMainModule()) {
  await main();
}
