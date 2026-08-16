import type {
  WorkerConnectParams,
  WorkerProtocolCloseReason,
} from "../../../../packages/gateway-protocol/src/index.js";
import { AUTH_RATE_LIMIT_SCOPE_WORKER_ADMISSION } from "../../auth-rate-limit.js";
import { withSerializedRateLimitAttempt } from "../../rate-limit-attempt-serialization.js";
import type { WorkerConnectionIdentity } from "../../worker-environments/connection-identity.js";
import type { PublicWorkerIngressContext } from "../public-worker-ingress-context.js";

type WorkerAdmissionService = {
  admitWorker(
    admission: WorkerConnectParams["admission"],
  ): Promise<
    | { ok: true; identity: WorkerConnectionIdentity }
    | { ok: false; reason: WorkerProtocolCloseReason }
  >;
  validateWorkerConnection(identity: WorkerConnectionIdentity): WorkerProtocolCloseReason | null;
};

type WorkerAdmissionBoundaryResult =
  | { ok: true; identity: WorkerConnectionIdentity }
  | { ok: false; reason: WorkerProtocolCloseReason | "rate-limited" | "claim-rejected" };

/** Serialize public credential checks and charge only failed admission attempts. */
export async function runWorkerAdmissionBoundary(params: {
  service: WorkerAdmissionService | undefined;
  admission: WorkerConnectParams["admission"];
  publicAdmission: PublicWorkerIngressContext | undefined;
  claim(identity: WorkerConnectionIdentity): boolean;
}): Promise<WorkerAdmissionBoundaryResult> {
  const run = async (): Promise<WorkerAdmissionBoundaryResult> => {
    const publicAdmission = params.publicAdmission;
    const rateCheck = publicAdmission?.rateLimiter?.check(
      publicAdmission.clientIp,
      AUTH_RATE_LIMIT_SCOPE_WORKER_ADMISSION,
    );
    if (rateCheck && !rateCheck.allowed) {
      return { ok: false, reason: "rate-limited" };
    }
    const admission =
      (await params.service?.admitWorker(params.admission)) ??
      ({ ok: false, reason: "environment-unavailable" } as const);
    if (!admission.ok) {
      publicAdmission?.rateLimiter?.recordFailure(
        publicAdmission.clientIp,
        AUTH_RATE_LIMIT_SCOPE_WORKER_ADMISSION,
      );
      return admission;
    }
    const ownershipFailure = params.service?.validateWorkerConnection(admission.identity);
    if (ownershipFailure) {
      publicAdmission?.rateLimiter?.recordFailure(
        publicAdmission.clientIp,
        AUTH_RATE_LIMIT_SCOPE_WORKER_ADMISSION,
      );
      return { ok: false, reason: ownershipFailure };
    }
    if (!params.claim(admission.identity)) {
      return { ok: false, reason: "claim-rejected" };
    }
    publicAdmission?.rateLimiter?.reset(
      publicAdmission.clientIp,
      AUTH_RATE_LIMIT_SCOPE_WORKER_ADMISSION,
    );
    return admission;
  };

  if (!params.publicAdmission?.rateLimiter) {
    return await run();
  }
  return await withSerializedRateLimitAttempt({
    ip: params.publicAdmission.clientIp,
    scope: AUTH_RATE_LIMIT_SCOPE_WORKER_ADMISSION,
    run,
  });
}
