import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];

function createFakeGh(): string {
  const dir = mkdtempSync(join(tmpdir(), "openclaw-pr-metadata-"));
  const gh = join(dir, "gh");
  tempDirs.push(dir);
  writeFileSync(
    gh,
    `#!/usr/bin/env bash
set -euo pipefail

if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  if [[ "$*" == *changedFiles* ]]; then
    printf '{"number":42,"url":"https://example.test/pr/42","headRefOid":"head-a","changedFiles":%s}\n' "\${FAKE_CHANGED_FILES:-101}"
  else
    printf '{"headRefOid":"%s"}\n' "\${FAKE_HEAD_AFTER:-head-a}"
  fi
  exit 0
fi

if [ "$1" = "api" ] && [ "$2" = "--paginate" ]; then
  [ "$3" = 'repos/{owner}/{repo}/pulls/42/files?per_page=100' ] || { echo "unexpected endpoint: $3" >&2; exit 4; }
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
  options: { changedFiles?: string; filesApiFailure?: boolean; headAfter?: string } = {},
) {
  return spawnSync(
    "bash",
    ["-c", "set -euo pipefail; source scripts/pr-lib/worktree.sh; pr_meta_json 42"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        FAKE_CHANGED_FILES: options.changedFiles ?? "101",
        FAKE_FILES_API_FAILURE: options.filesApiFailure ? "1" : "0",
        FAKE_HEAD_AFTER: options.headAfter ?? "head-a",
        PATH: `${fakeGhDir}:${process.env.PATH}`,
      },
      encoding: "utf8",
    },
  );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("PR metadata", () => {
  it("paginates all changed files and preserves the GraphQL file shape", () => {
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
});
