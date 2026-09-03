import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const assertions = resolve("scripts/e2e/lib/upgrade-survivor/assertions.mjs");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

// Independent persisted output contract: v2026.7.1-2's authored policy, with
// only historical null usage removed by the frozen candidate's Doctor importer.
function canonicalPolicy() {
  return {
    version: 1,
    socket: { path: "/synthetic/exec.sock", token: "synthetic-socket-value-must-not-be-logged" },
    defaults: {
      security: "allowlist",
      ask: "on-miss",
      askFallback: "deny",
      autoAllowSkills: false,
    },
    agents: {
      main: {
        security: "allowlist",
        ask: "always",
        askFallback: "deny",
        autoAllowSkills: true,
        allowlist: [
          {
            id: "survivor-unused-command",
            pattern: "/opt/upgrade-survivor/bin/report",
            argPattern: "--summary",
          },
          {
            id: "survivor-used-command",
            pattern: "/opt/upgrade-survivor/bin/check",
            lastUsedAt: 1782864000000,
            lastUsedCommand: "/opt/upgrade-survivor/bin/check --synthetic",
            lastResolvedPath: "/opt/upgrade-survivor/bin/check",
          },
        ],
      },
      auditor: {
        security: "deny",
        ask: "off",
        askFallback: "deny",
        autoAllowSkills: false,
        allowlist: [{ id: "survivor-auditor-command", pattern: "/opt/upgrade-survivor/bin/audit" }],
      },
    },
  };
}

function fixture() {
  const home = tempDirs.make("survivor-exec-policy-");
  const state = join(home, "state");
  const env = {
    HOME: home,
    USERPROFILE: home,
    OPENCLAW_HOME: home,
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: join(state, "openclaw.json"),
    OPENCLAW_TEST_WORKSPACE_DIR: join(home, "workspace"),
    OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: "base",
  };
  const run = (command: string, stage = "survival") =>
    spawnSync(process.execPath, [assertions, command], {
      env: { ...env, OPENCLAW_UPGRADE_SURVIVOR_ASSERT_STAGE: stage },
      encoding: "utf8",
      timeout: 10_000,
    });
  const seeded = run("seed");
  expect(seeded.status, seeded.stderr).toBe(0);
  const legacyPath = join(state, "exec-approvals.json");
  const legacyBytes = readFileSync(legacyPath);
  const dbDir = join(state, "state");
  const dbPath = join(dbDir, "openclaw.sqlite");
  function writeCanonical(raw: string | null) {
    mkdirSync(dbDir, { recursive: true });
    const db = new DatabaseSync(dbPath);
    try {
      // Only the canonical reader's two columns are needed for this query fixture.
      db.exec(
        "CREATE TABLE exec_approvals_config (config_key TEXT PRIMARY KEY, raw_json TEXT NOT NULL)",
      );
      if (raw !== null) {
        db.prepare("INSERT INTO exec_approvals_config VALUES (?, ?)").run("current", raw);
      }
    } finally {
      db.close();
    }
  }
  function observe() {
    const before = existsSync(dbPath) ? readFileSync(dbPath) : null;
    const entries = readdirSync(state, { recursive: true });
    const result = run("assert-exec-approvals");
    expect(readFileSync(legacyPath).equals(legacyBytes)).toBe(true);
    expect(readdirSync(state, { recursive: true })).toEqual(entries);
    if (before) {
      expect(readFileSync(dbPath).equals(before)).toBe(true);
    } else {
      expect(existsSync(dbPath)).toBe(false);
    }
    expect(result.stdout + result.stderr).not.toContain(
      "synthetic-socket-value-must-not-be-logged",
    );
    expect(result.stdout + result.stderr).not.toContain("/opt/upgrade-survivor/bin");
    return result;
  }
  return { run, legacyBytes, writeCanonical, observe };
}

describe("survivor exec approval policy observation", () => {
  it("seeds the populated tagged policy with historical null usage", () => {
    const { run, legacyBytes } = fixture();
    const expected = canonicalPolicy();
    const { socket: _socket, ...legacy } = expected;
    Object.assign(legacy.agents.main.allowlist[0]!, { lastUsedAt: null, lastUsedCommand: null });
    expect(JSON.parse(legacyBytes.toString())).toEqual(legacy);
    const result = run("assert-exec-approvals", "baseline");
    expect(result.status, result.stderr).toBe(0);
  });

  it("accepts preserved canonical policy without importing the retained legacy file", () => {
    const { writeCanonical, observe } = fixture();
    writeCanonical(JSON.stringify(canonicalPolicy()));
    const result = observe();
    expect(result.status, result.stderr).toBe(0);
  });

  it.each(["database", "row"])(
    "rejects missing canonical %s without importing legacy policy",
    (missing) => {
      const { writeCanonical, observe } = fixture();
      if (missing === "row") {
        writeCanonical(null);
      }
      const result = observe();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("missing after update");
    },
  );

  it.each([
    [
      "defaults",
      (policy: ReturnType<typeof canonicalPolicy>) => {
        policy.defaults.security = "full";
      },
    ],
    [
      "agent policy",
      (policy: ReturnType<typeof canonicalPolicy>) => {
        policy.agents.auditor.ask = "always";
      },
    ],
    [
      "skill consent",
      (policy: ReturnType<typeof canonicalPolicy>) => {
        policy.agents.main.autoAllowSkills = false;
      },
    ],
    [
      "allowlist",
      (policy: ReturnType<typeof canonicalPolicy>) => {
        policy.agents.main.allowlist.pop();
      },
    ],
    [
      "argument restriction",
      (policy: ReturnType<typeof canonicalPolicy>) => {
        policy.agents.main.allowlist[0]!.argPattern = "*";
      },
    ],
    [
      "usage",
      (policy: ReturnType<typeof canonicalPolicy>) => {
        policy.agents.main.allowlist[1]!.lastUsedAt = 0;
      },
    ],
    [
      "unrepaired null usage",
      (policy: ReturnType<typeof canonicalPolicy>) => {
        Object.assign(policy.agents.main.allowlist[0]!, {
          lastUsedAt: null,
          lastUsedCommand: null,
        });
      },
    ],
  ] as const)("rejects altered %s without repairing canonical policy", (_name, alter) => {
    const { writeCanonical, observe } = fixture();
    const policy = canonicalPolicy();
    alter(policy);
    writeCanonical(JSON.stringify(policy));
    const result = observe();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("exec approval");
    expect(result.stderr).toContain("changed");
  });

  it("rejects malformed canonical JSON without leaking or rewriting it", () => {
    const { writeCanonical, observe } = fixture();
    writeCanonical("synthetic-socket-value-must-not-be-logged {");
    const result = observe();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("exec approval policy is not valid JSON");
  });
});
