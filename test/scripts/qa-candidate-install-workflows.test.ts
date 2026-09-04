import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each([
  ["openclaw-release-telegram-qa", "build_candidate"],
  ["qa-profile-evidence", "plan_qa_profile"],
  ["qa-profile-evidence", "run_qa_profile_shard"],
  ["qa-profile-evidence", "aggregate_qa_profile"],
])("%s/%s installs an isolated copy of its dependencies", (workflowName, jobName) => {
  const workflow = parse(readFileSync(`.github/workflows/${workflowName}.yml`, "utf8")) as {
    jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
  };
  const install = workflow.jobs[jobName]?.steps.find((step) =>
    /^Install (candidate|selected) dependencies/u.test(step.name ?? ""),
  );
  expect(install?.run).toBeTruthy();

  const root = tempDirs.make("qa-candidate-install-");
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "pnpm"),
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  importMethod: process.env.PNPM_CONFIG_PACKAGE_IMPORT_METHOD,
  githubToken: process.env.GH_TOKEN,
  args: process.argv.slice(2),
}));
`,
    { mode: 0o755 },
  );
  const result = spawnSync("bash", ["-c", install!.run!], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GH_TOKEN: "test-runner-token",
      PATH: `${bin}:${process.env.PATH}`,
      PNPM_CONFIG_PACKAGE_IMPORT_METHOD: "hardlink",
      RUNNER_TEMP: root,
    },
    timeout: 10_000,
  });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    importMethod: "copy",
    args: expect.arrayContaining(["install", "--frozen-lockfile"]),
  });
});
