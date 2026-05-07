import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const helperPath = path.join(
  repoRoot,
  ".agents/skills/openclaw-pr-maintainer/scripts/github-activity.sh",
);
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function runHelper(args: string[]) {
  const dir = mkdtempSync(path.join(tmpdir(), "github-activity-helper-"));
  tempDirs.push(dir);
  const binDir = path.join(dir, "bin");
  const logPath = path.join(dir, "gh.log");
  const ghPath = path.join(binDir, "gh");
  mkdirSync(binDir);
  writeFileSync(
    ghPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\t' "$@" >> "$FAKE_GH_LOG"
printf '\\n' >> "$FAKE_GH_LOG"
if [[ "$1" == "api" && "$2" == users/* ]]; then
  printf '{"login":"kevinslin","name":"Kevin Lin","created_at":"2010-09-21T00:00:00Z","type":"User"}\\n'
  exit 0
fi
if [[ "$1" == "api" && "$2" == "--paginate" && "$3" == repos/*/issues* ]]; then
  printf 'pr\\nissue\\npr\\n'
  exit 0
fi
if [[ "$1" == "api" && "$2" == "--paginate" && "$3" == repos/*/commits* ]]; then
  printf 'sha-one\\nsha-two\\n'
  exit 0
fi
if [[ "$1" == "api" && "$2" == "graphql" ]]; then
  printf '{"totalCommitContributions":8,"totalIssueContributions":1,"totalPullRequestContributions":3,"totalPullRequestReviewContributions":2}\\n'
  exit 0
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 64
`,
  );
  chmodSync(ghPath, 0o755);
  const result = spawnSync("bash", [helperPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      FAKE_GH_LOG: logPath,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    },
  });
  return {
    log: readFileSync(logPath, "utf8"),
    result,
  };
}

describe("openclaw-pr-maintainer github activity helper", () => {
  it("counts PRs and issues from one paginated issues response", () => {
    const { log, result } = runHelper(["--months", "1", "kevinslin"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Kevin Lin (@kevinslin, User, account created 2010-09-21");
    expect(result.stdout).toContain("openclaw/openclaw last 1mo: 2 PRs, 1 issues, 2 commits");
    expect(log.match(/repos\/openclaw\/openclaw\/issues/g)).toHaveLength(1);
    expect(log.match(/repos\/openclaw\/openclaw\/commits/g)).toHaveLength(1);
    expect(log).toMatch(/since=\d{4}-\d{2}-\d{2}T00:00:00Z/);
  });

  it("uses the hourly global activity window for cacheable GraphQL reads", () => {
    const { log, result } = runHelper(["--months", "1", "--global", "kevinslin"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "GitHub public last 1mo: 8 commits, 3 PRs, 1 issues, 2 reviews",
    );
    expect(log.match(/api\tgraphql/g)).toHaveLength(1);
    expect(log).toMatch(/to=\d{4}-\d{2}-\d{2}T\d{2}:00:00Z/);
  });
});
