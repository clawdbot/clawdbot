import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Selectable } from "kysely";
import type { DB as OpenClawStateDatabase } from "../state/openclaw-state-db.generated.js";
import type { NodeWorkerProcessIdentity } from "./node-worker-process-identity.js";

type NodeWorkerLaunchState =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "cancelled";
export type NodeWorkerTerminalState = Exclude<NodeWorkerLaunchState, "pending" | "running">;

export type NodeWorkerContainerIdentity = {
  engine: "docker" | "podman";
  containerId: string;
  engineTarget: string;
};

export type NodeWorkerLaunchRow = Selectable<OpenClawStateDatabase["node_worker_launches"]> & {
  container_json?: string | null;
};

export type NodeWorkerLaunchReceipt = {
  launchId: string;
  planHash: string;
  gatewayNamespace: string;
  environmentId: string;
  sessionId: string;
  ownerEpoch: number;
  placementGeneration: number;
  runId: string;
  state: NodeWorkerLaunchState;
  supervisor: NodeWorkerProcessIdentity;
  worker: NodeWorkerProcessIdentity | null;
  container?: NodeWorkerContainerIdentity;
  resultJson: string | null;
  errorText: string | null;
  completedAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
};

export function isNodeWorkerTerminalState(value: string): value is NodeWorkerTerminalState {
  return (
    value === "completed" || value === "failed" || value === "interrupted" || value === "cancelled"
  );
}

export function validateNodeWorkerContainerIdentity(identity: NodeWorkerContainerIdentity): void {
  if (identity.engine !== "docker" && identity.engine !== "podman") {
    throw new Error("node worker container engine must be docker or podman");
  }
  if (!/^[a-f0-9]{64}$/u.test(identity.containerId)) {
    throw new Error(
      "node worker container id must contain exactly 64 lowercase hexadecimal digits",
    );
  }
  if (!/^[a-f0-9]{64}$/u.test(identity.engineTarget)) {
    throw new Error(
      "node worker container engine target must contain exactly 64 lowercase hexadecimal digits",
    );
  }
}

function containerIdentity(value: string | null | undefined): NodeWorkerContainerIdentity | null {
  if (value == null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("invalid node worker container identity");
  }
  if (
    !isRecord(parsed) ||
    Object.keys(parsed).length !== 3 ||
    (parsed.engine !== "docker" && parsed.engine !== "podman") ||
    typeof parsed.containerId !== "string" ||
    typeof parsed.engineTarget !== "string"
  ) {
    throw new Error("invalid node worker container identity");
  }
  const identity: NodeWorkerContainerIdentity = {
    engine: parsed.engine,
    containerId: parsed.containerId,
    engineTarget: parsed.engineTarget,
  };
  validateNodeWorkerContainerIdentity(identity);
  return identity;
}

export function nodeWorkerLaunchReceiptFromRow(row: NodeWorkerLaunchRow): NodeWorkerLaunchReceipt {
  if (row.state !== "pending" && row.state !== "running" && !isNodeWorkerTerminalState(row.state)) {
    throw new Error(`invalid node worker launch state ${row.state}`);
  }
  const container = containerIdentity(row.container_json);
  return {
    launchId: row.launch_id,
    planHash: row.plan_hash,
    gatewayNamespace: row.gateway_namespace,
    environmentId: row.environment_id,
    sessionId: row.session_id,
    ownerEpoch: row.owner_epoch,
    placementGeneration: row.placement_generation,
    runId: row.run_id,
    state: row.state,
    supervisor: { pid: row.supervisor_pid, startTime: row.supervisor_start_time },
    worker:
      row.worker_pid === null || row.worker_start_time === null
        ? null
        : { pid: row.worker_pid, startTime: row.worker_start_time },
    ...(container ? { container } : {}),
    resultJson: row.result_json,
    errorText: row.error_text,
    completedAtMs: row.completed_at_ms,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}
