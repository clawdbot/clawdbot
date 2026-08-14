// Shared Claw install fixtures for the remove-lifecycle test files.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { applyClawAddPlan } from "./add.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { parseClawManifest } from "./schema.js";
import type { ClawSourceIdentity } from "./types.js";

type TempDirTracker = { make: (prefix: string) => string };

export function clawRemoveFixtures(tempDirs: TempDirTracker) {
  async function fixture(
    params: {
      id?: string;
      name?: string;
      withFile?: boolean;
      withCron?: boolean;
      withMcp?: boolean;
    } = {},
  ) {
    const root = tempDirs.make("openclaw-claw-remove-");
    if (params.withFile) {
      await writeFile(join(root, "SOUL.md"), "managed\n", "utf8");
    }
    const parsed = parseClawManifest({
      schemaVersion: 1,
      agent: { id: params.id ?? "worker", name: "Worker" },
      workspace: params.withFile ? { bootstrapFiles: { "SOUL.md": { source: "SOUL.md" } } } : {},
      mcpServers: params.withMcp
        ? {
            docs: {
              command: "uvx",
              args: ["docs-mcp"],
              env: { DOCS_TOKEN: "${DOCS_TOKEN}" },
            },
          }
        : {},
      cronJobs: params.withCron
        ? [
            {
              id: "daily-report",
              schedule: { cron: "0 9 * * *", timezone: "UTC" },
              session: "isolated",
              message: "Prepare report",
            },
          ]
        : [],
    });
    if (!parsed.ok) {
      throw new Error(JSON.stringify(parsed.diagnostics));
    }
    const source: ClawSourceIdentity = {
      kind: "package",
      name: params.name ?? "@acme/worker",
      version: "1.0.0",
      packageRoot: root,
      manifestPath: join(root, "openclaw.claw.json"),
      integrityKind: "artifact",
      integrity: "sha256:manifest",
      byteLength: 100,
    };
    const plan = await buildClawAddPlan({
      manifest: parsed.manifest,
      source,
      context: { workspace: join(root, `workspace-${params.id ?? "worker"}`) },
    });
    return { root, plan, env: { OPENCLAW_STATE_DIR: join(root, "state") } };
  }

  async function addFixture(
    params: { withFile?: boolean; withCron?: boolean; withMcp?: boolean } = {},
  ) {
    const current = await fixture(params);
    let config: OpenClawConfig = {};
    await applyClawAddPlan(current.plan, {
      consentPlanIntegrity: current.plan.planIntegrity,
      env: current.env,
      commitConfig: async (transform) => {
        config = transform(config);
      },
      cronGateway: { add: async () => ({ id: "scheduler-daily" }) },
      ...(params.withMcp ? { installMcpServers: async () => [] } : {}),
    });
    return {
      ...current,
      getConfig: () => config,
      commitConfig: async (transform: (current: OpenClawConfig) => OpenClawConfig) => {
        config = transform(config);
      },
    };
  }

  return { fixture, addFixture };
}
