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
  if (
    status !== "active" &&
    status !== "dormant" &&
    status !== "destroyed" &&
    status !== "unknown"
  ) {
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
  const hasSsh = isRecord(value) && Object.hasOwn(value, "ssh");
  const hasNode = isRecord(value) && Object.hasOwn(value, "node");
  if (
    !isRecord(value) ||
    typeof value.leaseId !== "string" ||
    !value.leaseId.trim() ||
    hasSsh === hasNode ||
    (hasSsh && !isRecord(value.ssh)) ||
    (hasNode && !isRecord(value.node)) ||
    (value.sharedHost !== undefined && typeof value.sharedHost !== "boolean")
  ) {
    throw new Error("Worker provider returned an invalid provision result");
  }
  const common = {
    leaseId: value.leaseId.trim(),
    ...(value.sharedHost === true ? { sharedHost: true } : {}),
    ...(value.desktop === undefined
      ? {}
      : { desktop: normalizeWorkerDesktopEndpoint(value.desktop as WorkerDesktopEndpoint) }),
  };
  if (hasSsh) {
    return {
      ...common,
      ssh: normalizeWorkerSshEndpoint(value.ssh as WorkerSshEndpoint),
    };
  }
  const deviceId = (value.node as { deviceId?: unknown }).deviceId;
  if (typeof deviceId !== "string" || !deviceId.trim()) {
    throw new Error("Worker provider returned an invalid node device id");
  }
  return { ...common, node: { deviceId: deviceId.trim() } };
}
