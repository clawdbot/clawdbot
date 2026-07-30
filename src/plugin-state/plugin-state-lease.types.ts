// Public plugin lease contracts. Lease ownership stays host-managed; plugins
// receive cancellation plus an exact-owner checkpoint for the critical section.
export type PluginStateLeaseDatabase = { scope: "shared" } | { scope: "agent"; agentId: string };

export type PluginStateLeaseOptions = {
  namespace: string;
  key: string;
  database: PluginStateLeaseDatabase;
  leaseMs: number;
  waitMs: number;
  signal?: AbortSignal;
};

export type PluginStateLeaseContext = {
  signal: AbortSignal;
  /** Verify that this exact owner holds a non-expired lease at this instant. */
  assertOwned(): void;
};

export type PluginStateLeaseRunner = <T>(
  options: PluginStateLeaseOptions,
  run: (lease: PluginStateLeaseContext) => Promise<T>,
) => Promise<T>;

export type PluginStateLeaseErrorCode =
  | "PLUGIN_STATE_LEASE_INVALID_INPUT"
  | "PLUGIN_STATE_LEASE_TIMEOUT"
  | "PLUGIN_STATE_LEASE_ABORTED"
  | "PLUGIN_STATE_LEASE_LOST"
  | "PLUGIN_STATE_LEASE_STORAGE_FAILED";

export class PluginStateLeaseError extends Error {
  readonly code: PluginStateLeaseErrorCode;

  constructor(message: string, options: { code: PluginStateLeaseErrorCode; cause?: unknown }) {
    super(message, { cause: options.cause });
    this.name = "PluginStateLeaseError";
    this.code = options.code;
  }
}
