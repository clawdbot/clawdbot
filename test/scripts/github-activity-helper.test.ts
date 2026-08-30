import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createScriptTestHarness } from "./test-helpers.ts";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const helperPath = path.join(
  repoRoot,
  ".agents/skills/openclaw-pr-maintainer/scripts/github-activity.sh",
);
const { createTempDir } = createScriptTestHarness();

type Fixture = {
  blockActivity?: boolean;
  now?: string;
  profile?: unknown;
  search?: unknown[];
  global?: unknown;
  fail?: string[];
};
type Request = { route: string; args: string[]; output: string };

function requiredAt<T>(items: T[], index: number): T {
  const item = items[index];
  assert(item !== undefined, `Missing fixture item at index ${index}`);
  return item;
}

function runHelper(args: string[], fixture: Fixture = {}) {
  const dir = createTempDir("github-activity-helper-");
  const binDir = path.join(dir, "bin");
  const logPath = path.join(dir, "gh.log");
  const outputPath = path.join(dir, "stdout");
  const fixturePath = path.join(dir, "fixture.json");
  mkdirSync(binDir);
  writeFileSync(logPath, "");
  writeFileSync(fixturePath, JSON.stringify(fixture));
  const ghPath = path.join(binDir, "gh");
  const bypassPath = path.join(binDir, "gh-plain");
  const epoch = Date.parse(fixture.now ?? "2026-08-26T12:34:56Z") / 1000;
  writeFileSync(
    path.join(binDir, "date"),
    `#!/bin/sh
if [ "$*" = "-u +%s" ]; then printf '%s\\n' '${epoch}'; else exec /bin/date "$@"; fi
`,
    { mode: 0o755 },
  );
  writeFileSync(
    ghPath,
    `#!/bin/bash
set -euo pipefail
jq -cn --arg route "\${0##*/}" --rawfile output "$OUTPUT" --args \
  '{route: $route, args: $ARGS.positional, output: $output}' -- "$@" >> "$REQUEST_LOG"
if body=$(jq -cn --slurpfile fixtures "$FIXTURE" --slurpfile requests "$REQUEST_LOG" --args '
  $fixtures[0] as $fixture | $ARGS.positional as $args |
  if any($fixture.fail[]?; . as $needle | any($args[]; contains($needle))) then
    null | halt_error(1)
  elif $fixture.blockActivity and $args[0] == "api" and ($args[1] | startswith("users/") | not) then
    null | halt_error(124)
  elif $args[0] == "api" and ($args[1] | startswith("users/")) then
    if $fixture | has("profile") then $fixture.profile else
      {login: "Canonical", name: "Example Author", created_at: "2010-09-21T00:00:00Z", type: "User"}
    end
  elif $args[0] == "api" and ($args[1] | startswith("search/")) then
    ((([$requests[] | select(.args[1] | startswith("search/"))] | length) - 1) % 3) as $index |
    if $fixture.search and $index < ($fixture.search | length) then $fixture.search[$index] else
      {total_count: ([2345, 0, 9876][$index]), incomplete_results: false, items: []}
    end
  elif $args[0] == "api" and $args[1] == "graphql" then
    if $fixture | has("global") then $fixture.global else
      {data: {user: {contributionsCollection: {
        totalCommitContributions: 8, totalIssueContributions: 1,
        totalPullRequestContributions: 3, totalPullRequestReviewContributions: 2
      }}}}
    end
  else null | halt_error(64) end
' -- "$@" 2>/dev/null); then
  jq_filter=""
  previous=""
  for arg in "$@"; do
    if [[ "$previous" == "--jq" ]]; then jq_filter="$arg"; fi
    previous="$arg"
  done
  if [[ -n "$jq_filter" ]]; then
    printf '%s\\n' "$body" | jq -cr "$jq_filter"
  else
    printf '%s\\n' "$body"
  fi
else
  response_code=$?
  # Bound the blocked-scan reproduction without network or a surviving child process.
  if [[ "$response_code" == 124 ]]; then sleep 0.5; fi
  exit "$response_code"
fi
`,
    { mode: 0o755 },
  );
  writeFileSync(bypassPath, readFileSync(ghPath), { mode: 0o755 });
  const output = openSync(outputPath, "w");
  let result;
  try {
    result = spawnSync("bash", [helperPath, ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", output, "pipe"],
      // Only CLI fixtures and command lookup cross this boundary; no live auth/config.
      env: {
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        HOME: dir,
        GH_TOKEN: "offline-fixture",
        OPENCLAW_GH_BIN: bypassPath,
        FIXTURE: fixturePath,
        REQUEST_LOG: logPath,
        OUTPUT: outputPath,
      },
    });
  } finally {
    closeSync(output);
  }
  return {
    result,
    stdout: readFileSync(outputPath, "utf8"),
    requests: readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Request),
  };
}

describe("openclaw-pr-maintainer github activity helper", () => {
  it("prints canonical identity before the first activity request, even when a scan blocks", () => {
    const { requests } = runHelper(["alias"], { blockActivity: true });
    expect(requiredAt(requests, 0).args[1]).toBe("users/alias");
    expect(requiredAt(requests, 1).output).toContain(
      "Example Author (@Canonical, User, account created 2010-09-21",
    );
  });

  it("uses three single-page search aggregates regardless of row count", () => {
    const { result, stdout, requests } = runHelper(["alias"]);
    expect(result.status).toBe(0);
    expect(stdout).toContain("2345 PRs, 0 issues, 9876 commits");
    expect(requests).toHaveLength(4);
    expect(requests.every((request) => request.route === "gh")).toBe(true);
    const searches = requests.slice(1).map(({ args }) => {
      expect(args[0]).toBe("api");
      expect(args).not.toContain("--paginate");
      expect(args).not.toContain("-f");
      expect(args).not.toContain("-F");
      const url = new URL(requiredAt(args, 1), "https://api.github.test/");
      expect(url.searchParams.get("per_page")).toBe("1");
      expect(url.searchParams.get("q")).toContain("repo:openclaw/openclaw author:Canonical");
      return url;
    });
    expect(searches.map((url) => url.pathname)).toEqual([
      "/search/issues",
      "/search/issues",
      "/search/commits",
    ]);
    expect(requiredAt(searches, 0).searchParams.get("q")).toContain("is:pr");
    expect(requiredAt(searches, 1).searchParams.get("q")).toContain("is:issue");
    expect(requiredAt(searches, 2).searchParams.get("q")).toContain("committer-date:");
    expect(stdout).toContain("index/cache may lag");
  });

  it("distinguishes incomplete, missing, and failed searches from a valid zero", () => {
    const { result, stdout, requests } = runHelper(["alias"], {
      search: [{ total_count: 7, incomplete_results: true }, {}, {}],
      fail: ["search/commits"],
    });
    expect(result.status).toBe(1);
    expect(requests).toHaveLength(4);
    expect(stdout).toContain("incomplete (reported 7) PRs");
    expect(stdout).toContain("unavailable (invalid response) issues");
    expect(stdout).toContain("unavailable (request failed) commits");
    expect(stdout).not.toContain("0 commits");
  });

  it.each([
    null,
    { total_count: -1, incomplete_results: false },
    { total_count: 0 },
    { total_count: "0", incomplete_results: false },
  ])("rejects malformed aggregate %j", (bad) => {
    const { result, stdout } = runHelper(["alias"], { search: [bad, bad, bad] });
    expect(result.status).toBe(1);
    expect(stdout).toContain("unavailable (invalid response)");
  });

  it("keeps a longer repo window separate from the capped global window", () => {
    const { result, stdout, requests } = runHelper(["--months", "24", "--global", "alias"]);
    expect(result.status).toBe(0);
    expect(requests).toHaveLength(5);
    expect(requests.map(({ args }) => args[args.indexOf("--cache") + 1])).toEqual(
      Array(5).fill("1h"),
    );
    const repoArgs = requiredAt(requests, 1).args;
    const repoQuery =
      new URL(requiredAt(repoArgs, 1), "https://api.github.test").searchParams.get("q") ?? "";
    const repoRange = /created:([^ ]+)\.\.([^ ]+)/.exec(repoQuery);
    expect(repoRange).not.toBeNull();
    const graphql = requiredAt(requests, 4).args;
    const from = graphql.find((arg) => arg.startsWith("from="))?.slice(5) ?? "";
    const to = graphql.find((arg) => arg.startsWith("to="))?.slice(3) ?? "";
    expect(repoRange?.slice(1)).toEqual(["2024-08-26T00:00:00Z", "2026-08-25T23:59:59Z"]);
    expect(from).toBe("2025-08-26T00:00:00Z");
    expect(to).toBe("2026-08-26T00:00:00Z");
    expect(Date.parse(to) - Date.parse(from)).toBeLessThanOrEqual(366 * 86400000);
    expect(stdout).toContain("GitHub contributions last 12mo");
    expect(stdout).toContain("requested 24mo");
    expect(stdout).toContain("8 commits, 3 PRs, 1 issues, 2 reviews");
    expect(stdout).not.toContain("GitHub public");
  });

  it.each([
    { data: { user: null } },
    {
      data: {
        user: {
          contributionsCollection: {
            totalCommitContributions: "0",
            totalIssueContributions: 0,
            totalPullRequestContributions: 0,
            totalPullRequestReviewContributions: 0,
          },
        },
      },
    },
    { data: { user: { contributionsCollection: {} } } },
    { errors: [{ message: "unavailable" }], data: { user: null } },
  ])("does not turn unavailable contributions into zero: %j", (global) => {
    const { result, stdout, requests } = runHelper(["--global", "alias"], { global });
    expect(result.status).toBe(1);
    expect(requests).toHaveLength(5);
    expect(stdout).toMatch(/GitHub contributions.*unavailable/);
    expect(stdout).not.toContain("0 reviews");
  });

  it("continues other logins after profile failure without activity for the unknown identity", () => {
    const { result, stdout, requests } = runHelper(["missing", "alias"], {
      fail: ["users/missing"],
    });
    expect(result.status).toBe(1);
    expect(stdout).toContain("@missing (profile unavailable; account age unknown)");
    expect(stdout).toContain("Example Author (@Canonical");
    expect(requests).toHaveLength(5);
    expect(requiredAt(requests, 1).args[1]).toBe("users/alias");
  });
  it("continues later logins after a failed global request without falling back to scans", () => {
    const { result, stdout, requests } = runHelper(["--global", "first", "second"], {
      fail: ["graphql"],
    });
    expect(result.status).toBe(1);
    expect(requests).toHaveLength(10);
    expect(stdout.match(/unavailable \(request failed\)/g)).toHaveLength(2);
    expect(requiredAt(requests, 5).args[1]).toBe("users/second");
  });

  it("keeps valid contribution zeroes without inferring inactivity or scanning other endpoints", () => {
    const { result, stdout, requests } = runHelper(["--global", "alias"], {
      global: {
        data: {
          user: {
            contributionsCollection: {
              totalCommitContributions: 0,
              totalIssueContributions: 0,
              totalPullRequestContributions: 0,
              totalPullRequestReviewContributions: 0,
            },
          },
        },
      },
    });
    expect(result.status).toBe(0);
    expect(requests).toHaveLength(5);
    expect(stdout).toContain("0 commits, 0 PRs, 0 issues, 0 reviews");
    expect(stdout).toContain("Zero does not prove inactivity");
  });

  it.each([null, {}, { login: null }])("skips activity for malformed identity %j", (profile) => {
    const { result, stdout, requests } = runHelper(["alias"], { profile });
    expect(result.status).toBe(1);
    expect(requests).toHaveLength(1);
    expect(stdout).toContain("account age unknown");
  });

  it("preserves a nameless bot profile with an unknown creation date", () => {
    const { result, stdout } = runHelper(["alias"], {
      profile: { login: "helper[bot]", name: null, created_at: "invalid", type: "Bot" },
    });
    expect(result.status).toBe(0);
    expect(stdout).toContain("@helper[bot] (Bot, account age unknown)");
  });

  it.each([
    ["2024-03-31T15:00:00Z", "1", "2024-02-29T00:00:00Z"],
    ["2024-02-29T15:00:00Z", "12", "2023-02-28T00:00:00Z"],
    ["2025-03-31T15:00:00Z", "1", "2025-02-28T00:00:00Z"],
  ])("bounds calendar subtraction at month ends: %s", (now, months, from) => {
    const { result, requests } = runHelper(["--months", months, "--global", "alias"], { now });
    expect(result.status).toBe(0);
    const repoArgs = requiredAt(requests, 1).args;
    const query = new URL(requiredAt(repoArgs, 1), "https://api.github.test").searchParams.get("q");
    expect(query).toContain(`created:${from}..`);
    const graphql = requiredAt(requests, 4).args;
    expect(graphql).toContain(`from=${from}`);
    const to = graphql.find((arg) => arg.startsWith("to="))?.slice(3) ?? "";
    expect(Date.parse(to) - Date.parse(from)).toBeLessThanOrEqual(366 * 86400000);
  });
});
