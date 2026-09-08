import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hasActiveCronJobsForAgent } from "../cron/active-jobs.js";
import { getSuspensionVisibleCronTaskRunCount } from "../cron/service/active-run-cancellation.js";
import { hasPendingCronSessionCleanupForAgent } from "../cron/service/locked.js";
import { buildClawAddPlan } from "./lifecycle.js";
import type { ClawMonitorCleanupGateway } from "./monitor-cleanup-contract.js";
import { parseClawManifest } from "./schema.js";
import type { ClawSourceIdentity } from "./types.js";

async function verifyQuiescentFixture(agentId: string): Promise<void> {
  if (
    hasActiveCronJobsForAgent(agentId) ||
    getSuspensionVisibleCronTaskRunCount({ agentId }) > 0 ||
    hasPendingCronSessionCleanupForAgent(agentId)
  ) {
    throw new Error("Claw unit fixture unexpectedly owns pending scheduled work.");
  }
}

// These Claw unit fixtures have no scheduler or workers. The serving-owner integration
// suite proves cancellation, actual settlement, persistence, and lifecycle fencing.
export const quiescentClawMonitorGateway: ClawMonitorCleanupGateway = {
  inspect: async () => [],
  quiesce: verifyQuiescentFixture,
  drain: verifyQuiescentFixture,
};

export async function buildClawRemovalFixture(
  root: string,
  params: {
    id?: string;
    name?: string;
    withFile?: boolean;
    withBootstrap?: boolean;
    withCron?: boolean;
    withMcp?: boolean;
  } = {},
) {
  if (params.withFile) {
    await writeFile(join(root, "SOUL.md"), "managed\n", "utf8");
  }
  if (params.withBootstrap) {
    await writeFile(join(root, "BOOTSTRAP.md"), "managed\n", "utf8");
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
    ...(params.withBootstrap
      ? {
          packageBootstrap: {
            sourcePath: "BOOTSTRAP.md",
            realPath: join(root, "BOOTSTRAP.md"),
            byteLength: Buffer.byteLength("managed\n"),
            digest: `sha256:${createHash("sha256").update("managed\n").digest("hex")}`,
          },
        }
      : {}),
    source,
    context: { workspace: join(root, `workspace-${params.id ?? "worker"}`) },
  });
  return { root, plan, env: { OPENCLAW_STATE_DIR: join(root, "state") } };
}
