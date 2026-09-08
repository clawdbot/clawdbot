import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];

function createFakeGh(): string {
  const dir = mkdtempSync(join(tmpdir(), "openclaw-pr-metadata-"));
  const gh = join(dir, "gh");
  tempDirs.push(dir);
  writeFileSync(join(dir, "pr-view-count"), "0\n");
  writeFileSync(join(dir, "pr-view-count.sleeps"), "");
  writeFileSync(
    gh,
    `#!/usr/bin/env bash
set -euo pipefail

if [[ "$*" == *'{owner}'* || "$*" == *'{repo}'* ]]; then
  echo "protected gh: unresolved repository placeholder" >&2
  exit 19
fi
if [ "$1 $2" = "repo view" ]; then
  printf 'base-owner/base-repo\\n'
  exit 0
fi

if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  pr_view_count=0
  if [ -f "$FAKE_PR_VIEW_COUNT_FILE" ]; then
    IFS= read -r pr_view_count < "$FAKE_PR_VIEW_COUNT_FILE"
  fi
  pr_view_count=$((pr_view_count + 1))
  printf '%s\n' "$pr_view_count" > "$FAKE_PR_VIEW_COUNT_FILE"

  failure_target_matches=0
  if [ "\${FAKE_PR_VIEW_FAILURE_TARGET:-all}" = "all" ] || {
    [ "\${FAKE_PR_VIEW_FAILURE_TARGET:-all}" = "head" ] && [[ "$*" != *changedFiles* ]]
  }; then
    failure_target_matches=1
  fi
  if [ -n "\${FAKE_PR_VIEW_FAILURE_MODE:-}" ] && [ "$failure_target_matches" = "1" ] && {
    [ "\${FAKE_PR_VIEW_FAILURE_COUNT:--1}" = "-1" ] || [ "$pr_view_count" -le "\${FAKE_PR_VIEW_FAILURE_COUNT}" ]
  }; then
    echo "HTTP 503: No server is currently available to service your request. (https://api.github.com/graphql)" >&2
    case "$FAKE_PR_VIEW_FAILURE_MODE" in
      empty) exit 0 ;;
      exit) exit 7 ;;
      non-json) printf 'upstream unavailable\n'; exit 0 ;;
      null) printf 'null\n'; exit 0 ;;
    esac
  fi

  if [[ "$*" == *changedFiles* ]]; then
    if [ "\${FAKE_REJECT_REVIEW_REQUESTS:-0}" = "1" ] && [[ "$*" == *reviewRequests* ]]; then
      echo "GraphQL: Resource not accessible by integration (repository.pullRequest.reviewRequests.nodes.0.requestedReviewer)" >&2
      exit 1
    fi
    jq -nc --arg headRefOid "\${FAKE_HEAD_BEFORE-head-a}" --argjson changedFiles "\${FAKE_CHANGED_FILES:-101}" --argjson fileCount "\${FAKE_GRAPHQL_FILE_COUNT:-100}" --argjson includeChangeType "\${FAKE_GRAPHQL_CHANGE_TYPE:-true}" '
      {
        number: 42,
        url: "https://example.test/pr/42",
        headRefOid: $headRefOid,
        headRepository: {nameWithOwner: "fork-owner/fork-repo"},
        changedFiles: $changedFiles,
        files: [
          range(0; $fileCount)
          | ({
              path: ("src/graphql-file-" + (tostring) + ".ts"),
              additions: 1,
              deletions: 0,
              originalPath: ""
            } + if $includeChangeType then {
              changeType: (if . == ($fileCount - 1) then "removed" else "modified" end)
            } else {} end)
        ]
      }
    '
  else
    printf '{"headRefOid":"%s"}\n' "\${FAKE_HEAD_AFTER:-head-a}"
  fi
  exit 0
fi

if [ "$1" = "api" ] && [ "$2" = "--paginate" ]; then
  [[ "$*" == *'repos/base-owner/base-repo/pulls/42/files?per_page=100'* ]] || { echo "unexpected repository" >&2; exit 4; }
  [[ "$*" == *'Cache-Control: max-age=0'* ]] || { echo "authoritative files require revalidation" >&2; exit 18; }
  if [ "\${FAKE_REST_FILE_COUNT:-101}" = "2" ]; then
    jq -nc '[range(0; 2) | {filename: ("src/file-" + (tostring) + ".ts"), status: (if . == 1 then "removed" else "modified" end), additions: 1, deletions: 0}]'
    exit 0
  fi
  jq -nc '[range(0; 100) | {filename: ("src/file-" + (tostring) + ".ts"), status: "modified", additions: 1, deletions: 0}]'
  if [ "\${FAKE_FILES_API_FAILURE:-0}" = "1" ]; then
    echo "files API failed" >&2
    exit 5
  fi
  jq -nc '[{filename: "src/file-100.ts", status: "removed", additions: 0, deletions: 1}]'
  exit 0
fi

echo "unexpected gh command: $*" >&2
exit 2
`,
  );
  chmodSync(gh, 0o755);
  return dir;
}

function readPrMetadata(
  fakeGhDir: string,
  options: {
    changedFiles?: string;
    filesApiFailure?: boolean;
    graphqlChangeType?: boolean;
    graphqlFileCount?: string;
    headAfter?: string;
    headBefore?: string;
    prViewFailureCount?: string;
    prViewFailureMode?: "empty" | "exit" | "non-json" | "null";
    prViewFailureTarget?: "all" | "head";
    rejectReviewRequests?: boolean;
    restFileCount?: string;
  } = {},
) {
  const result = spawnSync(
    "bash",
    [
      "-c",
      [
        "set -euo pipefail",
        "source scripts/lib/plain-gh.sh",
        "source scripts/pr-lib/worktree.sh",
        "source scripts/pr-lib/common.sh",
        // Keep the real retry loop, but record its delays in this child shell only.
        'sleep() { printf "%s\\n" "$*" >> "$FAKE_PR_VIEW_COUNT_FILE.sleeps"; }',
        "pr_meta_json 42",
      ].join("; "),
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        FAKE_CHANGED_FILES: options.changedFiles ?? "101",
        FAKE_FILES_API_FAILURE: options.filesApiFailure ? "1" : "0",
        FAKE_GRAPHQL_CHANGE_TYPE: options.graphqlChangeType === false ? "false" : "true",
        FAKE_GRAPHQL_FILE_COUNT: options.graphqlFileCount ?? "100",
        FAKE_HEAD_AFTER: options.headAfter ?? "head-a",
        FAKE_HEAD_BEFORE: options.headBefore ?? "head-a",
        FAKE_PR_VIEW_COUNT_FILE: join(fakeGhDir, "pr-view-count"),
        FAKE_PR_VIEW_FAILURE_COUNT: options.prViewFailureCount ?? "-1",
        FAKE_PR_VIEW_FAILURE_MODE: options.prViewFailureMode ?? "",
        FAKE_PR_VIEW_FAILURE_TARGET: options.prViewFailureTarget ?? "all",
        FAKE_REJECT_REVIEW_REQUESTS: options.rejectReviewRequests ? "1" : "0",
        FAKE_REST_FILE_COUNT: options.restFileCount ?? "101",
        OPENCLAW_GH_BIN: "",
        PATH: `${fakeGhDir}:${process.env.PATH}`,
      },
      encoding: "utf8",
    },
  );
  return {
    ...result,
    prViewAttempts: Number(readFileSync(join(fakeGhDir, "pr-view-count"), "utf8")),
    retryDelays: readFileSync(join(fakeGhDir, "pr-view-count.sleeps"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(Number),
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("PR metadata", () => {
  it("does not request reviewer metadata that GitHub App tokens cannot read", () => {
    const result = readPrMetadata(createFakeGh(), {
      changedFiles: "2",
      graphqlFileCount: "2",
      rejectReviewRequests: true,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.prViewAttempts).toBe(2);
    expect(result.retryDelays).toEqual([]);
  });

  it("uses cacheable GraphQL file metadata when the complete list fits", () => {
    const result = readPrMetadata(createFakeGh(), {
      changedFiles: "2",
      filesApiFailure: true,
      graphqlFileCount: "2",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const metadata = JSON.parse(result.stdout) as {
      files: Array<{ changeType: string; path: string }>;
    };
    expect(metadata.files).toEqual([
      { path: "src/graphql-file-0.ts", additions: 1, deletions: 0, changeType: "MODIFIED" },
      { path: "src/graphql-file-1.ts", additions: 1, deletions: 0, changeType: "DELETED" },
    ]);
  });

  it("falls back to REST when cacheable file metadata lacks change types", () => {
    const result = readPrMetadata(createFakeGh(), {
      changedFiles: "2",
      graphqlChangeType: false,
      graphqlFileCount: "2",
      restFileCount: "2",
    });

    expect(result.status).toBe(0);
    const metadata = JSON.parse(result.stdout) as {
      files: Array<{ changeType: string; path: string }>;
    };
    expect(metadata.files).toEqual([
      { path: "src/file-0.ts", additions: 1, deletions: 0, changeType: "MODIFIED" },
      { path: "src/file-1.ts", additions: 1, deletions: 0, changeType: "DELETED" },
    ]);
  });

  it("paginates fresh base-repository files through protected gh and preserves the GraphQL shape", () => {
    const result = readPrMetadata(createFakeGh());

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const metadata = JSON.parse(result.stdout) as {
      changedFiles: number;
      files: Array<{
        path: string;
        additions: number;
        deletions: number;
        changeType: string;
      }>;
    };
    expect(metadata.changedFiles).toBe(101);
    expect(metadata.files).toHaveLength(101);
    expect(metadata.files[0]).toEqual({
      path: "src/file-0.ts",
      additions: 1,
      deletions: 0,
      changeType: "MODIFIED",
    });
    expect(metadata.files[100]).toEqual({
      path: "src/file-100.ts",
      additions: 0,
      deletions: 1,
      changeType: "DELETED",
    });
  });

  it("rejects incomplete paginated file metadata", () => {
    const result = readPrMetadata(createFakeGh(), { changedFiles: "102" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Incomplete PR file metadata for #42: expected 102 changed files, received 101 from paginated REST.",
    );
  });

  it("fails closed when the paginated files API fails after emitting a page", () => {
    const result = readPrMetadata(createFakeGh(), { filesApiFailure: true });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("files API failed");
    expect(result.stderr).toContain("Failed to collect paginated PR file metadata for #42.");
    expect(result.stdout).toBe("");
  });

  it("rejects files collected while the PR head changes", () => {
    const result = readPrMetadata(createFakeGh(), { headAfter: "head-b" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "PR head changed while collecting file metadata for #42 (started at head-a, ended at head-b). Retry review initialization.",
    );
  });

  it("rejects metadata without an observed initial head SHA", () => {
    const result = readPrMetadata(createFakeGh(), {
      changedFiles: "2",
      graphqlFileCount: "2",
      headBefore: "",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "GitHub PR metadata for #42 did not include a head SHA. Retry review initialization.",
    );
    expect(result.stderr).not.toContain("PR head changed");
  });

  it("rejects a non-numeric changed file count before shell comparison", () => {
    const result = readPrMetadata(createFakeGh(), { changedFiles: "null" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Invalid PR metadata for #42: changedFiles must be a non-negative integer.",
    );
    expect(result.stderr).not.toContain("integer expected");
    expect(result.stderr).not.toContain("integer expression expected");
  });

  it.each([
    ["empty stdout", "empty", "returned empty stdout"],
    ["a non-zero exit", "exit", "exited with status 7"],
    ["non-JSON stdout", "non-json", "did not return one JSON object"],
    ["a non-object JSON value", "null", "did not return one JSON object"],
  ] as const)("reports a GitHub API failure for %s", (_label, prViewFailureMode, detail) => {
    const result = readPrMetadata(createFakeGh(), { prViewFailureMode });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.prViewAttempts).toBe(3);
    expect(result.retryDelays).toEqual([1, 2]);
    expect(result.stderr).toContain(
      `GitHub API failure while reading PR #42: gh pr view ${detail} after 3 attempts.`,
    );
    expect(result.stderr).toContain("HTTP 503: No server is currently available");
    expect(result.stderr).not.toContain("integer expected");
    expect(result.stderr).not.toContain("PR head changed");
  });

  it("reports an API failure when the post-collection head read fails", () => {
    const result = readPrMetadata(createFakeGh(), {
      changedFiles: "2",
      graphqlFileCount: "2",
      prViewFailureMode: "empty",
      prViewFailureTarget: "head",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.prViewAttempts).toBe(4);
    expect(result.retryDelays).toEqual([1, 2]);
    expect(result.stderr).toContain(
      "GitHub API failure while reading PR #42: gh pr view returned empty stdout after 3 attempts.",
    );
    expect(result.stderr).not.toContain("PR head changed");
  });

  it("recovers when a transient API failure is followed by a valid PR object", () => {
    const result = readPrMetadata(createFakeGh(), {
      changedFiles: "2",
      graphqlFileCount: "2",
      prViewFailureCount: "1",
      prViewFailureMode: "empty",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.prViewAttempts).toBe(3);
    expect(result.retryDelays).toEqual([1]);
    expect(JSON.parse(result.stdout)).toMatchObject({ headRefOid: "head-a", changedFiles: 2 });
  });
});
