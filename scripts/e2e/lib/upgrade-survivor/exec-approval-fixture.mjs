import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";

function expectedPolicy() {
  return {
    version: 1,
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

function legacyPolicy() {
  const policy = expectedPolicy();
  // v2026.7.1-2's JSON owner preserves null usage metadata. Doctor's landed
  // importer removes only these null fields before canonical policy validation.
  Object.assign(policy.agents.main.allowlist[0], { lastUsedAt: null, lastUsedCommand: null });
  return policy;
}

export function seedLegacyExecApprovalPolicy(stateDir) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "exec-approvals.json"),
    `${JSON.stringify(legacyPolicy(), null, 2)}\n`,
    { mode: 0o600 },
  );
}

function parsePolicy(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("exec approval policy is not valid JSON");
  }
}

export function assertExecApprovalPolicySurvived(stateDir, stage) {
  let policy;
  if (stage === "baseline") {
    policy = parsePolicy(fs.readFileSync(path.join(stateDir, "exec-approvals.json"), "utf8"));
  } else {
    // Observe the canonical owner directly. Runtime readers or an approvals CLI
    // could create default state and conceal an import missed by the first update.
    const dbPath = path.join(stateDir, "state", "openclaw.sqlite");
    assert(fs.existsSync(dbPath), "exec approval canonical database missing after update");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db
        .prepare("SELECT raw_json FROM exec_approvals_config WHERE config_key = ?")
        .get("current");
      assert(row, "exec approval canonical policy missing after update");
      policy = parsePolicy(row.raw_json);
    } finally {
      db.close();
    }
  }
  const expected = stage === "baseline" ? legacyPolicy() : expectedPolicy();
  // Socket credentials are runtime-owned; compare the complete authored policy
  // without printing command text or any other state values on failure.
  for (const field of ["version", "defaults", "agents"]) {
    assert(isDeepStrictEqual(policy?.[field], expected[field]), `exec approval ${field} changed`);
  }
}
