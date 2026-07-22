import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import {
  captureFinalRecoveryPoint,
  FinalRecoveryPointError,
  parseFinalRecoveryPointRequest,
  type FinalRecoveryPointFailureCode,
  type FinalRecoveryPointResult,
} from "../snapshot/final-recovery-point.js";

const MAX_REQUEST_BYTES = 1024 * 1024;

export type FinalRecoveryPointCommandResult =
  | FinalRecoveryPointResult
  | {
      version: "openclaw-final-recovery-point-result/v1";
      ok: false;
      code: FinalRecoveryPointFailureCode;
      disposition: "hold" | "quarantine";
    };

export async function backupCaptureFinalCommand(
  runtime: RuntimeEnv,
  rawRequest?: string,
): Promise<FinalRecoveryPointCommandResult> {
  try {
    const requestText = rawRequest ?? (await readFinalRecoveryPointRequestFromStdin());
    const result = await captureFinalRecoveryPoint(parseFinalRecoveryPointRequest(requestText));
    writeRuntimeJson(runtime, result);
    return result;
  } catch (error) {
    if (!(error instanceof FinalRecoveryPointError)) {
      throw error;
    }
    const result: FinalRecoveryPointCommandResult = {
      version: "openclaw-final-recovery-point-result/v1",
      ok: false,
      code: error.code,
      disposition: error.disposition,
    };
    writeRuntimeJson(runtime, result);
    runtime.exit(1);
    return result;
  }
}

export async function readFinalRecoveryPointRequestFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_REQUEST_BYTES) {
      throw new FinalRecoveryPointError(
        "final-capture.request-invalid",
        "quarantine",
        "Final recovery-point request is too large.",
      );
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
