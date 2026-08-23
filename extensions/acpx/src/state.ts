// ACPX plugin state keys shared by runtime and doctor migration.
export const ACPX_PROCESS_LEASE_NAMESPACE = "process-leases";
export const ACPX_PROCESS_LEASE_MAX_ENTRIES = 4096;
export const ACPX_LEGACY_PROCESS_LEASE_FILE = "process-leases.json";

export const ACPX_GATEWAY_INSTANCE_NAMESPACE = "gateway-instance";
export const ACPX_GATEWAY_INSTANCE_KEY = "current";
export const ACPX_GATEWAY_INSTANCE_MAX_ENTRIES = 1;
export const ACPX_LEGACY_GATEWAY_INSTANCE_FILE = "gateway-instance-id";

export type AcpxGatewayInstanceRecord = {
  instanceId: string;
  createdAt: number;
};

export function normalizeAcpxGatewayInstanceRecord(
  value: unknown,
): AcpxGatewayInstanceRecord | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.instanceId !== "string" || !record.instanceId.trim()) {
    return undefined;
  }
  const createdAt =
    typeof record.createdAt === "number" && Number.isFinite(record.createdAt)
      ? Math.trunc(record.createdAt)
      : 0;
  return {
    instanceId: record.instanceId.trim(),
    createdAt,
  };
}
