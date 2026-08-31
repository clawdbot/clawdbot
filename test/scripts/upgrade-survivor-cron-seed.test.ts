import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("keeps legacy cron ownership specimens out of baseline roster authoring", () => {
  const root = mkdtempSync(join(tmpdir(), "openclaw-survivor-cron-seed-"));
  const stateDir = join(root, "state");
  const configPath = join(stateDir, "openclaw.json");
  const cronPath = join(stateDir, "cron", "jobs.json");
  mkdirSync(stateDir);
  const run = (command: string) =>
    execFileSync(process.execPath, ["scripts/e2e/lib/upgrade-survivor/assertions.mjs", command], {
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_TEST_WORKSPACE_DIR: join(root, "workspace"),
        OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: "cron-scheduled-authority",
      },
      stdio: "pipe",
    });
  try {
    run("seed");
    // Published 8.1 refuses the multi-agent config transition with ownerless legacy jobs.
    expect(existsSync(cronPath)).toBe(false);
    const authoredConfig = JSON.stringify({
      agents: { ownership: "explicit", entries: { main: {}, ops: {} } },
    });
    writeFileSync(configPath, authoredConfig);
    run("seed-cron-scheduled-authority");
    expect(readFileSync(configPath, "utf8")).toBe(authoredConfig);
    const jobs = JSON.parse(readFileSync(cronPath, "utf8")).jobs;
    expect(jobs.map((job: { id: string }) => job.id)).toEqual([
      "cron-pre-cap",
      "cron-ownerless-cap",
      "cron-owner-session",
      "cron-encoded-account",
      "cron-agent-mismatch",
    ]);
    expect(jobs.every((job: { scheduledToolPolicy?: unknown }) => !job.scheduledToolPolicy)).toBe(
      true,
    );
    expect(jobs[3].owner.sessionKey).toBe("agent:main:discord:personal:direct:user-1");
    expect(jobs[4].owner.agentId).toBe("other");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
