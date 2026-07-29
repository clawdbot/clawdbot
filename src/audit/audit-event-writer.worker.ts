/** Worker-thread entrypoint for serialized audit writes and retention maintenance. */
import { parentPort, workerData } from "node:worker_threads";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { pruneExpiredAuditEvents, recordAuditEvent } from "./audit-event-store.js";
import type { AuditEventInput } from "./audit-event-types.js";

const AUDIT_MAINTENANCE_INTERVAL_MS = 60 * 60_000;

type AuditWriterRequest = { type: "record"; input: AuditEventInput } | { type: "stop" };

const stateDir =
  workerData && typeof workerData === "object" && typeof workerData.stateDir === "string"
    ? workerData.stateDir
    : undefined;
if (!parentPort || !stateDir) {
  throw new Error("audit event writer requires a parent port and state directory");
}
const port = parentPort;
const database = { env: { OPENCLAW_STATE_DIR: stateDir } };

function reportMaintenance(): void {
  try {
    pruneExpiredAuditEvents({ database });
  } catch (error) {
    port.postMessage({ type: "maintenance-error", error: String(error) });
  }
}

reportMaintenance();
const maintenanceTimer = setInterval(reportMaintenance, AUDIT_MAINTENANCE_INTERVAL_MS);
port.postMessage({ type: "ready" });

port.on("message", (message: AuditWriterRequest) => {
  if (message.type === "record") {
    try {
      recordAuditEvent(message.input, database);
      port.postMessage({ type: "recorded" });
    } catch (error) {
      port.postMessage({ type: "record-error", error: String(error) });
    }
    return;
  }
  clearInterval(maintenanceTimer);
  reportMaintenance();
  try {
    closeOpenClawStateDatabase();
  } catch (error) {
    port.postMessage({ type: "maintenance-error", error: String(error) });
  }
  port.postMessage({ type: "stopped" });
  port.close();
});
