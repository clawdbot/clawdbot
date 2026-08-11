import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  WorkerDesktopEndpoint,
  WorkerLease,
  WorkerLeaseStatus,
  WorkerSshEndpoint,
} from "../../plugins/types.js";
import { normalizeWorkerDesktopEndpoint, normalizeWorkerSshEndpoint } from "./store.js";

export function requireWorkerLeaseStatus(value: unknown): WorkerLeaseStatus {
  if (!isRecord(value)) {
    throw new Error("Worker provider returned an invalid inspection result");
  }
  const status = value.status;
  if (status !== "active" && status !== "destroyed" && status !== "unknown") {
    throw new Error("Worker provider returned an invalid inspection status");
  }
  if (status === "active") {
    if (value.sharedHost !== undefined && typeof value.sharedHost !== "boolean") {
      throw new Error("Worker provider returned an invalid inspection result");
    }
    return { status, sharedHost: value.sharedHost === true };
  }
  if (value.sharedHost !== undefined) {
    throw new Error("Worker provider returned an invalid inspection result");
  }
  return { status };
}

export function requireWorkerLease(value: unknown): WorkerLease {
  if (
    !isRecord(value) ||
    typeof value.leaseId !== "string" ||
    !value.leaseId.trim() ||
    !isRecord(value.ssh) ||
    (value.sharedHost !== undefined && typeof value.sharedHost !== "boolean")
  ) {
    throw new Error("Worker provider returned an invalid provision result");
  }
  return {
    leaseId: value.leaseId.trim(),
    ssh: normalizeWorkerSshEndpoint(value.ssh as WorkerSshEndpoint),
    ...(value.sharedHost === true ? { sharedHost: true } : {}),
    ...(value.desktop === undefined
      ? {}
      : { desktop: normalizeWorkerDesktopEndpoint(value.desktop as WorkerDesktopEndpoint) }),
  };
}
