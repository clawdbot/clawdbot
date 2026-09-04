import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { replaceFileAtomicSync } from "./replace-file.js";
import type { RestartAuditInfo } from "./restart-intent.js";
import type { SchedulerPressureSnapshot } from "./scheduler-pressure.js";

const GATEWAY_RESTART_REQUEST_EVIDENCE_FILENAME = "gateway-restart-request.json";
const restartLog = createSubsystemLogger("restart");

export type GatewayRestartRequestEvidence = {
  reason?: string;
  audit?: RestartAuditInfo;
  preflight: {
    counts: {
      queueSize: number;
      pendingReplies: number;
      embeddedRuns: number;
      cronRuns: number;
      backgroundExecSessions: number;
      rootRequests: number;
      activeTasks: number;
      totalActive: number;
    };
    blockers: Array<{ kind: string; count: number; message: string }>;
  };
  schedulerPressure: SchedulerPressureSnapshot;
};

export function writeGatewayRestartRequestEvidenceSync(params: {
  env?: NodeJS.ProcessEnv;
  evidence: GatewayRestartRequestEvidence;
}): boolean {
  try {
    replaceFileAtomicSync({
      filePath: path.join(
        resolveStateDir(params.env ?? process.env),
        GATEWAY_RESTART_REQUEST_EVIDENCE_FILENAME,
      ),
      content: `${JSON.stringify({
        kind: "gateway-restart-request",
        pid: process.pid,
        requestedAt: Date.now(),
        ...params.evidence,
      })}\n`,
      mode: 0o600,
      tempPrefix: ".gateway-restart-request",
    });
    return true;
  } catch (err) {
    restartLog.warn(`failed to write gateway restart request evidence: ${String(err)}`);
    return false;
  }
}
