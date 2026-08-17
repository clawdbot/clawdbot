import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Value } from "typebox/value";
import { WorkerMachineOptionsSchema } from "../../../packages/gateway-protocol/src/schema/environments.js";
import {
  WorkerProviderError,
  type WorkerDesktopEndpoint,
  type WorkerLease,
  type WorkerLeaseStatus,
  type WorkerMachineOption,
  type WorkerSshEndpoint,
} from "../../plugins/types.js";
import { normalizeWorkerDesktopEndpoint, normalizeWorkerSshEndpoint } from "./store.js";

export function requireProviderProvisionTimeoutMs(
  timeoutMs: number | undefined,
): number | undefined {
  if (timeoutMs === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMER_TIMEOUT_MS) {
    throw new WorkerProviderError(
      `Worker provider provision timeout must be an integer from 1 through ${MAX_TIMER_TIMEOUT_MS}ms`,
    );
  }
  return timeoutMs;
}

function isWorkerMachineOptions(value: unknown): value is readonly WorkerMachineOption[] {
  return Value.Check(WorkerMachineOptionsSchema, value);
}

export function normalizeWorkerMachineOptions(
  value: unknown,
): readonly WorkerMachineOption[] | undefined {
  if (!isWorkerMachineOptions(value)) {
    return undefined;
  }
  const ids = new Set<string>();
  let hasDefault = false;
  for (const option of value) {
    if (
      option.id.trim() !== option.id ||
      option.label.trim() !== option.label ||
      (option.description !== undefined && option.description.trim() !== option.description) ||
      ids.has(option.id) ||
      (option.default === true && hasDefault)
    ) {
      return undefined;
    }
    ids.add(option.id);
    hasDefault ||= option.default === true;
  }
  return value.map((option) => ({
    id: option.id,
    label: option.label,
    ...(option.description === undefined ? {} : { description: option.description }),
    ...(option.default === undefined ? {} : { default: option.default }),
  }));
}

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
