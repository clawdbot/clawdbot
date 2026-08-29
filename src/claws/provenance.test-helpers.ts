import { join } from "node:path";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { parseClawManifest } from "./schema.js";
import type { ClawOpenClawProfile, ClawSourceIdentity } from "./types.js";

export async function makeProvenancePlan(
  root: string,
  manifestValue: unknown,
  options: {
    workspace?: string;
    adoptExistingWorkspace?: boolean;
    openClawProfile?: ClawOpenClawProfile;
    packagePreflight?: NonNullable<
      Parameters<typeof buildClawAddPlan>[0]["context"]
    >["packagePreflight"];
  } = {},
) {
  const parsed = parseClawManifest(manifestValue);
  if (!parsed.ok) {
    throw new Error(JSON.stringify(parsed.diagnostics));
  }
  const source: ClawSourceIdentity = {
    kind: "package",
    name: "@acme/worker",
    version: "1.0.0",
    packageRoot: root,
    manifestPath: join(root, "openclaw.claw.json"),
    integrityKind: "artifact",
    integrity: "sha256:manifest",
    byteLength: 123,
  };
  const plan = await buildClawAddPlan({
    manifest: parsed.manifest,
    openClawProfile: options.openClawProfile,
    source,
    context: {
      workspace: options.workspace ?? join(root, "workspace-worker"),
      ...(options.adoptExistingWorkspace ? { adoptExistingWorkspace: true } : {}),
      ...(options.packagePreflight ? { packagePreflight: options.packagePreflight } : {}),
    },
  });
  return { root, plan };
}

export function stateEnv(root: string) {
  return { OPENCLAW_STATE_DIR: join(root, "state") };
}

export function readInstallRow(agentId: string, root: string) {
  return openOpenClawStateDatabase({ env: stateEnv(root) })
    .db.prepare(
      `SELECT agent_id, schema_version, claw_name, claw_version, integrity, plan_integrity,
              workspace, agent_config_digest, agent_owned_paths_json, status, added_at_ms
         FROM claw_installs
        WHERE agent_id = ?`,
    )
    .get(agentId) as
    | {
        agent_id: string;
        schema_version: string;
        claw_name: string;
        claw_version: string;
        integrity: string;
        plan_integrity: string;
        workspace: string;
        agent_config_digest: string;
        agent_owned_paths_json: string;
        status: string;
        added_at_ms: number | bigint;
      }
    | undefined;
}
