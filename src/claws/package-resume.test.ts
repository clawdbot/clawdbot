import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  findResumableIntroducedPluginRequirement,
  readClawResumeStateReadOnly,
} from "./package-resume.js";
import type { PersistedClawPackageRef } from "./provenance.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => closeOpenClawStateDatabaseForTest());

/** Reproduces a current-main same-version database that predates the additive columns. */
function createBaseShapeClawState(env: { OPENCLAW_STATE_DIR: string }): string {
  const database = openOpenClawStateDatabase({ env });
  const databasePath = database.path;
  database.db.exec(`
    INSERT INTO claw_installs (
      agent_id, schema_version, source_kind, claw_name, claw_version, package_root,
      manifest_path, integrity_kind, integrity, source_byte_length, manifest_schema_version,
      plan_integrity, workspace, agent_config_digest, agent_owned_paths_json, status,
      added_at_ms, updated_at_ms
    ) VALUES (
      'incident-2', 'openclaw.clawInstallRecord.v1', 'package', 'incident-claw', '1.0.0',
      '/packages/incident', '/packages/incident/CLAW.md', 'artifact', 'sha256:aa', 10, 1,
      'sha256:bb', '/workspaces/incident', 'sha256:cc', '[]', 'config_committed', 1000, 2000
    );
    INSERT INTO claw_package_refs (
      agent_id, package_kind, package_source, package_ref, package_version, package_integrity,
      schema_version, claw_name, package_status, relationship, origin, independent_owner,
      installed_at_ms, updated_at_ms
    ) VALUES (
      'incident-2', 'plugin', 'clawhub', '@owner/audit', '2.0.1',
      'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'openclaw.clawPackageRef.v1', 'incident-claw', 'complete', 'referenced',
      'claw-introduced', 0, 1000, 2000
    );
    ALTER TABLE claw_installs DROP COLUMN bootstrap_source_path;
    ALTER TABLE claw_installs DROP COLUMN bootstrap_content_digest;
    ALTER TABLE claw_package_refs DROP COLUMN extension_id;
    ALTER TABLE claw_package_refs DROP COLUMN extension_format;
    ALTER TABLE claw_package_refs DROP COLUMN extension_detected_format;
    ALTER TABLE claw_package_refs DROP COLUMN extension_mapped_json;
    ALTER TABLE claw_package_refs DROP COLUMN extension_unavailable_json;
    ALTER TABLE claw_package_refs DROP COLUMN extension_adapter_identity;
  `);
  closeOpenClawStateDatabaseForTest();
  return databasePath;
}

const integrity = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const pkg = {
  kind: "plugin" as const,
  source: "clawhub" as const,
  ref: "@owner/audit",
  version: "2.0.1",
};
const preflight = {
  ok: true as const,
  action: "reuse" as const,
  integrity,
  installedIntegrity: integrity,
  installedAt: new Date(1_500).toISOString(),
  detectedFormat: "claude" as const,
  mapped: ["commands", "skills"],
  unavailable: ["agents"],
  adapterIdentity: "openclaw/v1",
};
const ref: PersistedClawPackageRef = {
  schemaVersion: "openclaw.clawPackageRef.v1",
  agentId: "incident-2",
  clawName: "incident-claw",
  ...pkg,
  integrity,
  status: "complete",
  relationship: "referenced",
  origin: "claw-introduced",
  independentOwner: false,
  extension: {
    id: "audit-tools",
    format: "claude",
    detectedFormat: "claude",
    mapped: ["commands", "skills"],
    unavailable: ["agents"],
    adapterIdentity: "openclaw/v1",
  },
  installedAtMs: 1_000,
  updatedAtMs: 2_000,
};

describe("findResumableIntroducedPluginRequirement", () => {
  it("recognizes an exact retained requirement from the incomplete attempt", () => {
    expect(
      findResumableIntroducedPluginRequirement({
        agentId: "incident-2",
        pkg,
        preflight,
        refs: [ref],
      }),
    ).toEqual(ref);
  });

  it("rejects independently owned and newer plugin installations", () => {
    expect(
      findResumableIntroducedPluginRequirement({
        agentId: "incident-2",
        pkg,
        preflight,
        refs: [{ ...ref, independentOwner: true }],
      }),
    ).toBeUndefined();
    expect(
      findResumableIntroducedPluginRequirement({
        agentId: "incident-2",
        pkg,
        preflight: { ...preflight, installedAt: new Date(3_000).toISOString() },
        refs: [ref],
      }),
    ).toBeUndefined();
  });

  it("rejects changed extension capability mappings", () => {
    expect(
      findResumableIntroducedPluginRequirement({
        agentId: "incident-2",
        pkg,
        preflight: { ...preflight, mapped: ["skills"] },
        refs: [ref],
      }),
    ).toBeUndefined();
  });
  it("does not create a state database while checking for a resumable preview", async () => {
    const databasePath = join(tempDirs.make("openclaw-claw-resume-"), "missing.sqlite");

    await expect(
      readClawResumeStateReadOnly("incident-2", { path: databasePath }),
    ).resolves.toBeUndefined();
    await expect(access(databasePath)).rejects.toThrow();
  });

  it("previews a same-version base-shape database without mutating it", async () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-claw-resume-base-") };
    const databasePath = createBaseShapeClawState(env);
    const before = await readFile(databasePath);

    const state = await readClawResumeStateReadOnly("incident-2", { path: databasePath });

    expect(state?.record).toMatchObject({ agentId: "incident-2", status: "config_committed" });
    expect(state?.record.bootstrap).toBeUndefined();
    expect(state?.packageRefs).toHaveLength(1);
    expect(state?.packageRefs[0]?.extension).toBeUndefined();
    expect(before.equals(await readFile(databasePath))).toBe(true);
  });
});
