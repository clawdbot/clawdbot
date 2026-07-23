import { normalizeConfiguredMcpServers } from "../config/mcp-config-normalize.js";
import { setConfiguredMcpServer, unsetConfiguredMcpServer } from "../config/mcp-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import {
  CLAW_MCP_REF_SCHEMA_VERSION,
  deleteClawMcpServerRef,
  digestClawMcpServer,
  planClawMcpServerRemoval,
  readClawMcpServerRefs,
  upsertClawMcpServerRef,
  type PersistedClawMcpServerRef,
} from "./mcp.js";
import type { ClawManifest } from "./types.js";
import type { ClawUpdatePlan } from "./update-plan.js";

export type ClawMcpUpdateExecution = {
  appliedNames: string[];
  rollback: () => Promise<void>;
};

export class ClawMcpUpdateError extends Error {
  constructor(
    message: string,
    readonly partial = false,
  ) {
    super(message);
    this.name = "ClawMcpUpdateError";
  }
}

export async function applyClawMcpUpdate(
  updatePlan: ClawUpdatePlan,
  targetManifest: ClawManifest,
  options: OpenClawStateDatabaseOptions & {
    config: OpenClawConfig;
    sourceMcpServers: Record<string, Record<string, unknown>>;
    nowMs?: number;
    setServer?: typeof setConfiguredMcpServer;
    unsetServer?: typeof unsetConfiguredMcpServer;
    readRefs?: typeof readClawMcpServerRefs;
    planRemoval?: (
      ref: PersistedClawMcpServerRef,
      options: OpenClawStateDatabaseOptions,
    ) => { action: "remove" | "release" };
    upsertRef?: typeof upsertClawMcpServerRef;
    deleteRef?: typeof deleteClawMcpServerRef;
  },
): Promise<ClawMcpUpdateExecution> {
  const actions = updatePlan.actions.filter(
    (action) => action.kind === "mcpServer" && action.action !== "unchanged",
  );
  if (actions.length === 0) {
    return { appliedNames: [], rollback: async () => undefined };
  }
  const setServer = options.setServer ?? setConfiguredMcpServer;
  const unsetServer = options.unsetServer ?? unsetConfiguredMcpServer;
  const readRefs = options.readRefs ?? readClawMcpServerRefs;
  const planRemoval = options.planRemoval ?? planClawMcpServerRemoval;
  const upsertRef = options.upsertRef ?? upsertClawMcpServerRef;
  const deleteRef = options.deleteRef ?? deleteClawMcpServerRef;
  const currentRefs = new Map(readRefs(updatePlan.agentId, options).map((ref) => [ref.name, ref]));
  const currentServers = normalizeConfiguredMcpServers(options.sourceMcpServers);
  const undo: Array<() => Promise<void>> = [];
  const appliedNames: string[] = [];
  const nowMs = options.nowMs ?? Date.now();
  let configMutationUncertain = false;

  const rollback = async () => {
    const failures: string[] = [];
    for (const revert of undo.toReversed()) {
      try {
        await revert();
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (failures.length > 0) {
      throw new ClawMcpUpdateError(failures.join("; "));
    }
  };

  try {
    for (const action of actions) {
      const name = action.id;
      const previousRef = currentRefs.get(name);
      const previousServer = currentServers[name];
      if (action.action === "add" && (previousServer || previousRef)) {
        throw new ClawMcpUpdateError(
          `MCP server ${JSON.stringify(name)} appeared after planning and was not claimed.`,
        );
      }
      if (previousServer && !previousRef) {
        throw new ClawMcpUpdateError(
          `MCP server ${JSON.stringify(name)} is not owned by this Claw.`,
        );
      }
      if (action.action === "release") {
        if (!previousRef) {
          throw new ClawMcpUpdateError(`MCP reference ${JSON.stringify(name)} disappeared.`);
        }
        const exactLiveConfig =
          previousServer !== undefined &&
          digestClawMcpServer(previousServer) === previousRef.configDigest;
        if (exactLiveConfig && planRemoval(previousRef, options).action !== "release") {
          throw new ClawMcpUpdateError(
            `MCP server ${JSON.stringify(name)} is no longer safely releasable.`,
          );
        }
        deleteRef(updatePlan.agentId, name, options);
        undo.push(async () => upsertRef(previousRef, options));
        appliedNames.push(name);
        continue;
      }
      if (action.action === "remove") {
        if (!previousServer || !previousRef) {
          throw new ClawMcpUpdateError(`MCP server ${JSON.stringify(name)} disappeared.`);
        }
        if (planRemoval(previousRef, options).action !== "remove") {
          throw new ClawMcpUpdateError(
            `MCP server ${JSON.stringify(name)} gained another owner after planning.`,
          );
        }
        upsertRef({ ...previousRef, status: "pending", updatedAtMs: nowMs }, options);
        configMutationUncertain = true;
        const removed = await unsetServer({ name, expectedServer: previousServer });
        configMutationUncertain = false;
        if (!removed.ok) {
          throw new Error(removed.error);
        }
        undo.push(async () => {
          const restored = await setServer({
            name,
            server: previousServer,
            createOnly: true,
            recordIndependentOwner: false,
          });
          if (!restored.ok) {
            throw new Error(restored.error);
          }
          upsertRef(previousRef, options);
        });
        deleteRef(updatePlan.agentId, name, options);
        appliedNames.push(name);
        continue;
      }

      const targetServer = targetManifest.mcpServers[name];
      if (!targetServer) {
        throw new ClawMcpUpdateError(`Target MCP declaration ${JSON.stringify(name)} is missing.`);
      }
      const targetRef: PersistedClawMcpServerRef = {
        schemaVersion: CLAW_MCP_REF_SCHEMA_VERSION,
        agentId: updatePlan.agentId,
        name,
        configDigest: digestClawMcpServer(targetServer),
        relationship: previousRef?.relationship ?? "managed",
        origin: previousRef?.origin ?? "claw-introduced",
        independentOwner: previousRef?.independentOwner ?? false,
        status: "pending",
        createdAtMs: previousRef?.createdAtMs ?? nowMs,
        updatedAtMs: nowMs,
      };
      upsertRef(targetRef, options);
      configMutationUncertain = true;
      const written = await setServer({
        name,
        server: targetServer,
        ...(previousServer ? { expectedServer: previousServer } : { createOnly: true }),
        recordIndependentOwner: false,
      });
      configMutationUncertain = false;
      if (!written.ok) {
        throw new Error(written.error);
      }
      undo.push(async () => {
        if (previousServer && previousRef) {
          const restored = await setServer({
            name,
            server: previousServer,
            expectedServer: targetServer,
            recordIndependentOwner: false,
          });
          if (!restored.ok) {
            throw new Error(restored.error);
          }
          upsertRef(previousRef, options);
        } else {
          const removed = await unsetServer({ name, expectedServer: targetServer });
          if (!removed.ok) {
            throw new Error(removed.error);
          }
          deleteRef(updatePlan.agentId, name, options);
        }
      });
      upsertRef({ ...targetRef, status: "complete" }, options);
      appliedNames.push(name);
    }
  } catch (error) {
    try {
      await rollback();
    } catch (rollbackError) {
      throw new ClawMcpUpdateError(
        `${error instanceof Error ? error.message : String(error)}; rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        true,
      );
    }
    throw new ClawMcpUpdateError(
      error instanceof Error ? error.message : String(error),
      configMutationUncertain || (error instanceof ClawMcpUpdateError && error.partial),
    );
  }
  return { appliedNames, rollback };
}
