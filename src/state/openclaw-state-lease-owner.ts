export type OpenClawStateLeaseProcessOwner = {
  pid: number;
  startTime: number | null;
  isAlive(pid: number): boolean;
  readStartTime(pid: number): number | null;
};

export type OpenClawStateLeaseOwnerPayload = Readonly<{
  pid: number;
  starttime?: number;
}>;

export type OpenClawStateLeaseErrorCode =
  | "OPENCLAW_STATE_LEASE_INVALID_INPUT"
  | "OPENCLAW_STATE_LEASE_TIMEOUT"
  | "OPENCLAW_STATE_LEASE_ABORTED"
  | "OPENCLAW_STATE_LEASE_LOST"
  | "OPENCLAW_STATE_LEASE_STORAGE_FAILED";

export class OpenClawStateLeaseError extends Error {
  readonly code: OpenClawStateLeaseErrorCode;
  declare readonly ownerPayload?: OpenClawStateLeaseOwnerPayload;

  constructor(
    message: string,
    options: {
      code: OpenClawStateLeaseErrorCode;
      cause?: unknown;
      ownerPayload?: OpenClawStateLeaseOwnerPayload;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = "OpenClawStateLeaseError";
    this.code = options.code;
    if (options.ownerPayload) {
      this.ownerPayload = options.ownerPayload;
    }
  }
}

export function parseOpenClawStateLeaseOwnerPayload(
  payloadJson: string | null,
): OpenClawStateLeaseOwnerPayload | undefined {
  let payload: { pid?: unknown; starttime?: unknown } | undefined;
  try {
    payload = payloadJson ? (JSON.parse(payloadJson) as typeof payload) : undefined;
  } catch {
    return undefined;
  }
  const pid = payload?.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return undefined;
  }
  const starttime = payload?.starttime;
  return typeof starttime === "number" && Number.isInteger(starttime) && starttime >= 0
    ? { pid, starttime }
    : { pid };
}

export function processLeaseIsReclaimable(
  row: { expires_at: number | null; payload_json: string | null },
  processOwner: OpenClawStateLeaseProcessOwner,
): boolean {
  const payload = parseOpenClawStateLeaseOwnerPayload(row.payload_json);
  if (!payload) {
    // A malformed owner can only be reclaimed after its persisted deadline.
    return Number(row.expires_at) <= Date.now();
  }
  if (!processOwner.isAlive(payload.pid)) {
    return true;
  }
  const observedStartTime = processOwner.readStartTime(payload.pid);
  return (
    payload.starttime !== undefined &&
    observedStartTime !== null &&
    payload.starttime !== observedStartTime
  );
}
