import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { assertLegacyOperatorCronOwners } from "../../scripts/e2e/lib/upgrade-survivor/legacy-operator-state.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const assertions = resolve("scripts/e2e/lib/upgrade-survivor/assertions.mjs");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("authors the default cron job before adding ops and retains both CLI creation receipts", () => {
  const root = tempDirs.make("survivor-operator-lifecycle-");
  const bin = join(root, "bin");
  const artifacts = join(root, "artifacts");
  const workspace = join(root, "workspace");
  const state = join(root, "state");
  const configPath = join(root, "openclaw.json");
  const ledgerPath = join(artifacts, "legacy-operator-baseline.json");
  mkdirSync(bin);
  mkdirSync(artifacts);
  mkdirSync(state);
  writeFileSync(configPath, "{}");
  const cliPath = join(bin, "openclaw");
  // Model the shipped API boundary: ownerless creation needs an unambiguous
  // roster, an explicit owner must exist, and global listing may fail later.
  writeFileSync(
    cliPath,
    `#!${process.execPath}
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const configPath = process.env.OPENCLAW_CONFIG_PATH;
const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
const approvalPath = path.join(process.env.OPENCLAW_STATE_DIR, "exec-approvals.json");
if (args[0] === "--help") {
  process.stdout.write("  approvals Manage exec approvals\\n");
} else if (args[0] === "setup" && args[1] === "--help") {
  process.stdout.write("  --baseline Create baseline state\\n");
} else if (args[0] === "setup") {
  cfg.agents = { entries: { main: {} }, defaults: {} };
  fs.writeFileSync(configPath, JSON.stringify(cfg));
} else if (args[0] === "config" && args[1] === "set") {
  const keys = args[2].split(".");
  let target = cfg;
  for (const key of keys.slice(0, -1)) target = target[key] ??= {};
  target[keys.at(-1)] = JSON.parse(args[3]);
  fs.writeFileSync(configPath, JSON.stringify(cfg));
} else if (args[0] === "approvals" && args[1] === "set") {
  fs.copyFileSync(args[args.indexOf("--file") + 1], approvalPath);
} else if (args[0] === "approvals" && args[1] === "allowlist") {
  const agent = args[args.indexOf("--agent") + 1];
  assert(cfg.agents.entries[agent], "baseline approvals reject unknown agents");
  const policy = JSON.parse(fs.readFileSync(approvalPath, "utf8"));
  policy.agents[agent] = { allowlist: [{ pattern: args[args.indexOf("--agent") + 2] }] };
  fs.writeFileSync(approvalPath, JSON.stringify(policy));
} else if (args[0] === "approvals" && args[1] === "get") {
  const file = JSON.parse(fs.readFileSync(approvalPath, "utf8"));
  for (const agent of Object.values(file.agents)) {
    for (const entry of agent.allowlist ?? []) entry.id ??= crypto.randomUUID();
  }
  process.stdout.write(JSON.stringify({ file }));
} else if (args[0] === "cron" && args[1] === "add") {
  const explicitAgent = args.includes("--agent") ? args[args.indexOf("--agent") + 1] : undefined;
  assert(explicitAgent ? cfg.agents.entries[explicitAgent] : Object.keys(cfg.agents.entries).length === 1,
    "baseline cannot resolve the requested cron owner");
  const name = args[args.indexOf("--name") + 1];
  process.stdout.write(JSON.stringify({ id: "native-" + name, name, ...(explicitAgent ? { agentId: explicitAgent } : {}) }));
} else if (args[0] === "agents" && args[1] === "add") {
  cfg.agents.entries[args[2]] = {};
  cfg.agents.defaults.systemAgent = { agentId: "main" };
  fs.writeFileSync(configPath, JSON.stringify(cfg));
} else if (args[0] === "config" && args[1] === "unset") {
  delete cfg.agents.defaults.systemAgent;
  fs.writeFileSync(configPath, JSON.stringify(cfg));
} else {
  throw new Error("baseline global cron reads are unavailable with unresolved owners");
}
`,
  );
  chmodSync(cliPath, 0o755);
  const run = (command: string) =>
    spawnSync(process.execPath, [assertions, command], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
        OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: "legacy-operator-state",
        OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT: artifacts,
        OPENCLAW_UPGRADE_SURVIVOR_ASSERT_STAGE: "baseline",
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_TEST_WORKSPACE_DIR: workspace,
        OPENCLAW_STATE_DIR: state,
        GATEWAY_AUTH_TOKEN_REF: "survivor-test-token",
      },
    });
  const initialized = run("seed-legacy-operator");
  expect(initialized.status, initialized.stderr).toBe(0);
  const earlyAgent = run("seed-legacy-operator-agent");
  expect(earlyAgent.status).toBe(1);
  expect(earlyAgent.stderr).toContain("create the default-owner cron job before adding ops");
  for (const command of [
    "seed-legacy-operator-default-cron",
    "seed-legacy-operator-agent",
    "seed-legacy-operator-gateway",
    "assert-exec-approvals",
  ]) {
    const result = run(command);
    expect(result.status, result.stderr).toBe(0);
  }
  expect(JSON.parse(readFileSync(ledgerPath, "utf8")).jobs).toEqual([
    { id: "native-survivor-default-owner", name: "survivor-default-owner" },
    { id: "native-survivor-ops-owner", name: "survivor-ops-owner", agentId: "ops" },
  ]);
  expect(JSON.parse(readFileSync(ledgerPath, "utf8"))).toMatchObject({
    approvalsJsonEra: true,
    approvals: {
      agents: {
        main: { allowlist: [{ pattern: "/usr/bin/uname" }] },
        ops: { allowlist: [{ pattern: "/usr/bin/date" }] },
      },
    },
  });
  expect(JSON.parse(readFileSync(configPath, "utf8")).agents.defaults.systemAgent).toBeUndefined();
});

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

  it("allows candidate maintenance jobs but rejects duplicated operator jobs", () => {
    const jobs = [
      ...migratedJobs(),
      { id: "heartbeat", name: "heartbeat-main", agentId: "main", effectiveAgentId: "main" },
    ];
    expect(() => assertLegacyOperatorCronOwners({ jobs }, { jobs: baselineJobs })).not.toThrow();
    jobs.push({ ...jobs[0]!, id: "duplicate-default" });
    expect(() => assertLegacyOperatorCronOwners({ jobs }, { jobs: baselineJobs })).toThrow(
      "cron job count changed",
    );
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
  it("accepts JSON-era null usage placeholders in the baseline policy", () => {
    const { policy, legacyPath, run } = approvalFixture();
    Object.assign(policy.agents.main.allowlist[0]!, {
      lastUsedAt: null,
      lastUsedCommand: null,
      lastResolvedPath: null,
    });
    writeFileSync(legacyPath, JSON.stringify(policy));
    const result = run("baseline");
    expect(result.status, result.stderr).toBe(0);
  });

  it.each(["lastUsedAt", "lastUsedCommand", "lastResolvedPath"])(
    "rejects unmigrated null %s in canonical SQLite policy",
    (field) => {
      const { policy, writeCanonical, run } = approvalFixture();
      Object.assign(policy.agents.main.allowlist[0]!, { [field]: null });
      writeCanonical(policy);
      const result = run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("legacy operator exec approvals changed");
    },
  );

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
