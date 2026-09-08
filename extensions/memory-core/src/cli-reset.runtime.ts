import fs from "node:fs";
import { resolveAgentConfig } from "openclaw/plugin-sdk/agent-scope-runtime";
import {
  resolveAgentWorkspaceDir,
  resolveUserPath,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { createClackPrompter } from "openclaw/plugin-sdk/setup-runtime";
import {
  assertOpenClawAgentDatabaseForMaintenance,
  resolveOpenClawAgentSqlitePath,
} from "openclaw/plugin-sdk/sqlite-runtime";
import { resolveMemoryAgentIds } from "./cli-runtime-common.js";
import { defaultRuntime, getRuntimeConfig } from "./cli.host.runtime.js";
import type { MemoryResetCommandOptions } from "./cli.types.js";
import {
  closeMemoryDatabase,
  openMemoryDatabaseAtPath,
  resetMemoryDatabase,
} from "./memory/manager-db.js";

export async function runMemoryReset(opts: MemoryResetCommandOptions): Promise<void> {
  // Reset needs no embedding provider or credentials, including when search is disabled.
  const cfg = getRuntimeConfig({ skipPluginValidation: true });
  const agentIds = resolveMemoryAgentIds(cfg, opts.agent);
  if (!opts.yes) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error(
        "Memory reset requires confirmation. Re-run with --yes in non-interactive mode.",
      );
    }
    const confirmed = await createClackPrompter().confirm({
      message: `Reset the derived memory index and embedding cache for ${agentIds.join(", ")}? Sessions and memory files will be preserved.`,
      initialValue: false,
    });
    if (!confirmed) {
      defaultRuntime.log("Memory reset cancelled.");
      return;
    }
  }
  for (const agentId of agentIds) {
    const dbPath = resolveOpenClawAgentSqlitePath({ agentId });
    if (!fs.existsSync(dbPath)) {
      defaultRuntime.log(`No memory index to reset (${agentId}).`);
      continue;
    }
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const extensionPath =
      resolveAgentConfig(cfg, agentId)?.memory?.search?.store?.vector?.extensionPath ??
      cfg.memory?.search?.store?.vector?.extensionPath;
    // Validate only: normal manager opens may repair unrelated session schema.
    const db = openMemoryDatabaseAtPath(dbPath, true);
    try {
      assertOpenClawAgentDatabaseForMaintenance(db, { agentId, pathname: dbPath });
      const changed = await resetMemoryDatabase({
        targetDb: db,
        dbPath,
        workspaceDir,
        vectorExtensionPath: extensionPath ? resolveUserPath(extensionPath) : undefined,
      });
      defaultRuntime.log(
        changed
          ? `Memory index reset (${agentId}). Sessions preserved. Rebuild with: openclaw memory index --agent ${agentId}`
          : `No memory index to reset (${agentId}).`,
      );
      defaultRuntime.log(
        `Reset does not shrink the database file. To reclaim space, back up data and stop the Gateway and other writers, then run: openclaw doctor --session-sqlite compact --session-sqlite-agent ${agentId}`,
      );
    } finally {
      closeMemoryDatabase(db);
    }
  }
}
