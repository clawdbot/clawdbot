import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { assertLegacyOperatorCronOwners } from "../../scripts/e2e/lib/upgrade-survivor/legacy-operator-state.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const assertions = resolve("scripts/e2e/lib/upgrade-survivor/assertions.mjs");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const baselineJobs = [
  { id: "job-default", name: "survivor-default-owner" },
  { id: "job-ops", name: "survivor-ops-owner", agentId: "ops" },
];

function migratedJobs() {
  return baselineJobs.map((job) => ({ ...job, effectiveAgentId: job.agentId ?? "main" }));
}

// These checks protect the lane's independent acceptance contract: merely
// retaining cron rows must not conceal a lost effective owner after Doctor.
describe("legacy operator cron acceptance", () => {
  it("requires both unchanged jobs with their resolved runtime owners", () => {
    expect(() =>
      assertLegacyOperatorCronOwners({ jobs: migratedJobs() }, { jobs: baselineJobs }),
    ).not.toThrow();
  });

  it.each([null, undefined, "ops"])("rejects default-owner projection %s", (effectiveAgentId) => {
    const jobs = migratedJobs();
    Object.assign(jobs[0]!, { effectiveAgentId });
    expect(() => assertLegacyOperatorCronOwners({ jobs }, { jobs: baselineJobs })).toThrow(
      "cron owner unresolved or changed: survivor-default-owner",
    );
  });

  it("rejects a missing job and an explicit owner rewritten behind a correct projection", () => {
    expect(() =>
      assertLegacyOperatorCronOwners({ jobs: migratedJobs().slice(1) }, { jobs: baselineJobs }),
    ).toThrow("cron job count changed");
    const jobs = migratedJobs();
    jobs[1]!.agentId = "main";
    expect(() => assertLegacyOperatorCronOwners({ jobs }, { jobs: baselineJobs })).toThrow(
      "cron explicit owner changed",
    );
  });
});

function approvalFixture() {
  const root = tempDirs.make("survivor-legacy-operator-");
  const state = join(root, "state");
  const artifactRoot = join(root, "artifacts");
  const policy = {
    version: 1,
    defaults: { security: "allowlist", ask: "off", askFallback: "deny" },
    agents: {
      main: { allowlist: [{ id: "main-command", pattern: "/usr/bin/uname" }] },
      ops: { allowlist: [{ id: "ops-command", pattern: "/usr/bin/date" }] },
    },
  };
  mkdirSync(artifactRoot);
  mkdirSync(join(state, "state"), { recursive: true });
  writeFileSync(
    join(artifactRoot, "legacy-operator-baseline.json"),
    JSON.stringify({ approvals: policy, approvalsJsonEra: true }),
  );
  const dbPath = join(state, "state", "openclaw.sqlite");
  const legacyPath = join(state, "exec-approvals.json");
  const writeCanonical = (value: unknown) => {
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("CREATE TABLE exec_approvals_config (config_key TEXT PRIMARY KEY, raw_json TEXT)");
      db.prepare("INSERT INTO exec_approvals_config VALUES ('current', ?)").run(
        JSON.stringify(value),
      );
    } finally {
      db.close();
    }
  };
  const run = (stage = "survival") => {
    const dbBefore = existsSync(dbPath) ? readFileSync(dbPath) : null;
    const result = spawnSync(process.execPath, [assertions, "assert-exec-approvals"], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: "legacy-operator-state",
        OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT: artifactRoot,
        OPENCLAW_UPGRADE_SURVIVOR_ASSERT_STAGE: stage,
        OPENCLAW_STATE_DIR: state,
      },
    });
    if (dbBefore) {
      expect(readFileSync(dbPath).equals(dbBefore)).toBe(true);
    } else {
      expect(existsSync(dbPath)).toBe(false);
    }
    expect(result.stdout + result.stderr).not.toContain("private-runtime-socket-token");
    return result;
  };
  return { policy, legacyPath, writeCanonical, run };
}

describe("legacy operator approvals acceptance", () => {
  it("accepts baseline JSON but rejects the retained file after SQLite import", () => {
    const { policy, legacyPath, writeCanonical, run } = approvalFixture();
    writeFileSync(legacyPath, JSON.stringify(policy));
    const baseline = run("baseline");
    expect(baseline.status, baseline.stderr).toBe(0);
    // The real importer owns retirement. This independent fixture supplies its output.
    writeCanonical({ ...policy, socket: { token: "private-runtime-socket-token" } });
    const retainedLegacy = run();
    expect(retainedLegacy.status).toBe(1);
    expect(retainedLegacy.stderr).toContain("legacy exec approvals file was not retired");
  });

  it("accepts the exact policy without comparing runtime socket credentials", () => {
    const { policy, writeCanonical, run } = approvalFixture();
    writeCanonical({ ...policy, socket: { token: "private-runtime-socket-token" } });
    const result = run();
    expect(result.status, result.stderr).toBe(0);
  });

  it.each(["allowlist", "mode", "agent"])("rejects altered %s without repairing it", (field) => {
    const { policy, writeCanonical, run } = approvalFixture();
    if (field === "allowlist") {
      policy.agents.main.allowlist.pop();
    } else if (field === "mode") {
      policy.defaults.security = "full";
    } else {
      policy.agents.ops.allowlist[0]!.pattern = "/usr/bin/other";
    }
    writeCanonical(policy);
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("legacy operator exec approvals changed");
  });

  it("rejects missing canonical storage instead of importing the legacy specimen", () => {
    const { policy, legacyPath, run } = approvalFixture();
    writeFileSync(legacyPath, JSON.stringify(policy));
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("legacy operator approvals database missing");
    expect(JSON.parse(readFileSync(legacyPath, "utf8"))).toEqual(policy);
  });
});
