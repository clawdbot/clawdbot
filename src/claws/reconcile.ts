// Resolves Claw-managed drift without a target manifest: adopting local
// content re-records the on-disk digest as the owned content, so the file or
// agent stops surfacing as "modified" and a later update can move forward.
// Restoring original content is intentionally out of scope here: only digests
// are recorded after install, so a restore needs a fresh update package.
import { createHash } from "node:crypto";
import { listAgentEntries } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { root as fsSafeRoot } from "../infra/fs-safe.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { digestClawAgentConfig } from "./agent-config-digest.js";
import { readClawStatus } from "./lifecycle-status.js";

type ClawReconcileFileDrift = {
  path: string;
  state: string;
  workspace: string;
};

export type ClawReconcileDrift = {
  agentId: string;
  agentDrifted: boolean;
  files: ClawReconcileFileDrift[];
};

export async function planClawReconcile(
  target: string,
  options: OpenClawStateDatabaseOptions & { config?: OpenClawConfig } = {},
): Promise<ClawReconcileDrift> {
  const status = await readClawStatus(target, options);
  const record = status.records[0];
  if (!record) {
    throw new Error(`No installed Claw matches ${JSON.stringify(target)}.`);
  }
  return {
    agentId: record.install.agentId,
    agentDrifted: record.agentState === "modified",
    files: record.workspaceFiles
      .filter((file) => file.state === "modified" || file.state === "unsafe")
      .map((file) => ({ path: file.path, state: file.state, workspace: file.workspace })),
  };
}

async function computeDiskDigest(workspace: string, path: string): Promise<string> {
  const root = await fsSafeRoot(workspace, {
    hardlinks: "reject",
    maxBytes: 1024 * 1024,
    symlinks: "reject",
  });
  const content = await root.readBytes(path, { maxBytes: 1024 * 1024 });
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

export async function applyClawReconcileKeepLocal(
  drift: ClawReconcileDrift,
  params: {
    paths?: string[];
    config: OpenClawConfig;
  },
  options: OpenClawStateDatabaseOptions & { nowMs?: number } = {},
): Promise<{ adoptedFiles: string[]; adoptedAgent: boolean }> {
  const selected = params.paths && params.paths.length > 0 ? new Set(params.paths) : undefined;
  const adoptAgent = drift.agentDrifted && selected === undefined;
  // Unsafe files cannot be adopted: reading them through the fs-safe root is
  // exactly what failed, so adopting would bless an unverifiable path.
  const blocked = drift.files.filter((file) => file.state !== "modified");
  if (blocked.length > 0 && (!selected || blocked.some((file) => selected.has(file.path)))) {
    throw new Error(
      `Unsafe workspace files cannot be adopted: ${blocked.map((file) => file.path).join(", ")}`,
    );
  }
  const candidates = drift.files.filter(
    (file) => file.state === "modified" && (!selected || selected.has(file.path)),
  );
  const digests = new Map<string, string>();
  for (const file of candidates) {
    digests.set(file.path, await computeDiskDigest(file.workspace, file.path));
  }
  const adoptedFiles: string[] = [];
  let adoptedAgent = false;
  const nowMs = options.nowMs ?? Date.now();
  runOpenClawStateWriteTransaction(
    ({ db: sqlite }) => {
      const db =
        getNodeSqliteKysely<
          Pick<OpenClawStateKyselyDatabase, "claw_installs" | "claw_workspace_files">
        >(sqlite);
      for (const file of candidates) {
        const digest = digests.get(file.path);
        if (!digest) {
          continue;
        }
        executeSqliteQuerySync(
          sqlite,
          db
            .updateTable("claw_workspace_files")
            .set({ content_digest: digest, updated_at_ms: nowMs })
            .where("agent_id", "=", drift.agentId)
            .where("target_path", "=", file.path),
        );
        adoptedFiles.push(file.path);
      }
      if (adoptAgent) {
        const agent = listAgentEntries(params.config).find(
          (candidate) => candidate.id === drift.agentId,
        );
        if (agent) {
          executeSqliteQuerySync(
            sqlite,
            db
              .updateTable("claw_installs")
              .set({ agent_config_digest: digestClawAgentConfig(agent), updated_at_ms: nowMs })
              .where("agent_id", "=", drift.agentId),
          );
          adoptedAgent = true;
        }
      }
    },
    options,
    { operationLabel: "claw-reconcile.keep-local" },
  );
  return { adoptedFiles, adoptedAgent };
}
