import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import {
  parseRestoredRecoveryPointRequest,
  restoreAcceptedRecoveryPoint,
  RestoredRecoveryPointError,
  type RestoredRecoveryPointFailureCode,
  type RestoredRecoveryPointResult,
} from "../snapshot/restored-recovery-point.js";

const MAX_REQUEST_BYTES = 1024 * 1024;

type RestoredRecoveryPointCommandResult =
  | RestoredRecoveryPointResult
  | {
      version: "openclaw-restored-recovery-point-result/v1";
      ok: false;
      code: RestoredRecoveryPointFailureCode;
      disposition: "hold" | "quarantine";
    };

export async function backupRestoreAcceptedCommand(
  runtime: RuntimeEnv,
  rawRequest?: string,
): Promise<RestoredRecoveryPointCommandResult> {
  try {
    const requestText = rawRequest ?? (await readRestoredRecoveryPointRequestFromStdin());
    const result = await restoreAcceptedRecoveryPoint(
      parseRestoredRecoveryPointRequest(requestText),
    );
    writeRuntimeJson(runtime, result);
    return result;
  } catch (error) {
    if (!(error instanceof RestoredRecoveryPointError)) {
      throw error;
    }
    const result: RestoredRecoveryPointCommandResult = {
      version: "openclaw-restored-recovery-point-result/v1",
      ok: false,
      code: error.code,
      disposition: error.disposition,
    };
    writeRuntimeJson(runtime, result);
    runtime.exit(1);
    return result;
  }
}

async function readRestoredRecoveryPointRequestFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_REQUEST_BYTES) {
      throw new RestoredRecoveryPointError(
        "restored-admission.request-invalid",
        "quarantine",
        "Restored recovery-point request is too large.",
      );
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
