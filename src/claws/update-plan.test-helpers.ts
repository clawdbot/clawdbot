import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { McpServerConfig } from "../config/types.mcp.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { applyClawAddPlan } from "./add.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { installClawMcpServers } from "./mcp.js";
import { persistClawPackageRef } from "./provenance.js";
import { parseClawManifest } from "./schema.js";
import type { ClawSourceIdentity, ResolvedClawPackage } from "./types.js";

export const packagePreflight = async (pkg: { kind: "skill" | "plugin"; ref: string }) => ({
  ok: true as const,
  action: "install" as const,
  integrity: `sha256:${"a".repeat(64)}`,
  ...(pkg.kind === "plugin" ? { installId: pkg.ref } : {}),
});

export async function createUpdatePlanFixture(root: string) {
  await writeFile(join(root, "SOUL.md"), "base soul\n", "utf8");
  await writeFile(join(root, "OLD.md"), "old\n", "utf8");
  const raw = {
    schemaVersion: 1,
    agent: { id: "worker", name: "Worker" },
    workspace: {
      bootstrapFiles: { "SOUL.md": { source: "SOUL.md" } },
      files: [{ source: "OLD.md", path: "OLD.md" }],
    },
    packages: [
      {
        kind: "skill",
        source: "clawhub",
        ref: "triage",
        version: "1.0.0",
      },
      {
        kind: "plugin",
        source: "clawhub",
        ref: "obsolete",
        version: "1.0.0",
      },
    ],
    mcpServers: { docs: { command: "uvx", args: ["docs-mcp"] } },
    cronJobs: [
      {
        id: "daily",
        schedule: { cron: "0 9 * * *", timezone: "UTC" },
        session: "isolated",
        message: "Base report",
      },
    ],
  };
  const parsed = parseClawManifest(raw);
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
    integrity: "sha256:base",
    byteLength: 100,
  };
  const env = { OPENCLAW_STATE_DIR: join(root, "state") };
  const addPlan = await buildClawAddPlan({
    manifest: parsed.manifest,
    source,
    context: { workspace: join(root, "workspace-worker"), packagePreflight },
  });
  if (addPlan.blockers.length > 0) {
    throw new Error(JSON.stringify(addPlan.blockers));
  }
  let config: OpenClawConfig = {};
  await applyClawAddPlan(addPlan, {
    consentPlanIntegrity: addPlan.planIntegrity,
    env,
    commitConfig: async (transform) => {
      config = transform(config);
    },
    installPackages: async (plan, options) =>
      plan.actions
        .filter((action) => action.kind === "package")
        .map((action) =>
          persistClawPackageRef(plan, action.details as ResolvedClawPackage, options),
        ),
    installMcpServers: async (plan, options) =>
      await installClawMcpServers(plan, {
        ...options,
        setMcpServer: async ({ name, server }) => {
          const servers = { ...config.mcp?.servers, [name]: server as McpServerConfig };
          config.mcp = { ...config.mcp, servers };
          return { ok: true, path: "config", config, mcpServers: servers };
        },
        listMcpServers: async () => ({ ok: true, path: "config", config, mcpServers: {} }),
      }),
    cronGateway: { add: async () => ({ id: "scheduler-daily" }) },
  });
  return { root, env, config, manifest: parsed.manifest, source, addPlan };
}

export function targetSource(root: string, version: string, integrity: string): ClawSourceIdentity {
  return {
    kind: "package",
    name: "@acme/worker",
    version,
    packageRoot: root,
    manifestPath: join(root, "openclaw.claw.json"),
    integrityKind: "artifact",
    integrity,
    byteLength: 100,
  };
}
