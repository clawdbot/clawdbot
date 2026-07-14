/**
 * Persistent lease store for ACPX wrapper processes. Leases let OpenClaw attach
 * gateway/session identity to spawned ACP processes and clean them up later.
 */
import { randomUUID, createHash } from "node:crypto";
import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { ACPX_PROCESS_LEASE_MAX_ENTRIES, ACPX_PROCESS_LEASE_NAMESPACE } from "./state.js";

/** Environment variable carrying the ACPX process lease id. */
export const OPENCLAW_ACPX_LEASE_ID_ENV = "OPENCLAW_ACPX_LEASE_ID";
/** Environment variable carrying the owning gateway instance id. */
const OPENCLAW_GATEWAY_INSTANCE_ID_ENV = "OPENCLAW_GATEWAY_INSTANCE_ID";
/** CLI argument carrying the ACPX process lease id for platforms without env wrapping. */
export const OPENCLAW_ACPX_LEASE_ID_ARG = "--openclaw-acpx-lease-id";
/** CLI argument carrying the owning gateway instance id. */
export const OPENCLAW_GATEWAY_INSTANCE_ID_ARG = "--openclaw-gateway-instance-id";

/** Lifecycle state for a tracked ACPX wrapper process. */
type AcpxProcessLeaseState = "open" | "closing" | "closed" | "lost";

/** Persisted identity and command metadata for one ACPX wrapper process. */
export type AcpxProcessLease = {
  leaseId: string;
  gatewayInstanceId: string;
  sessionKey: string;
  wrapperRoot: string;
  wrapperPath: string;
  rootPid: number;
  processGroupId?: number;
  commandHash: string;
  startedAt: number;
  state: AcpxProcessLeaseState;
};

/** Async lease store used by runtime sessions and cleanup routines. */
export type AcpxProcessLeaseStore = {
  load(leaseId: string): Promise<AcpxProcessLease | undefined>;
  listOpen(gatewayInstanceId?: string): Promise<AcpxProcessLease[]>;
  save(lease: AcpxProcessLease): Promise<void>;
  markState(leaseId: string, state: AcpxProcessLeaseState): Promise<void>;
};

type AcpxProcessLeaseFile = {
  version: 1;
  leases: AcpxProcessLease[];
};

export function normalizeAcpxProcessLease(value: unknown): AcpxProcessLease | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.leaseId !== "string" ||
    typeof record.gatewayInstanceId !== "string" ||
    typeof record.sessionKey !== "string" ||
    typeof record.wrapperRoot !== "string" ||
    typeof record.wrapperPath !== "string" ||
    typeof record.rootPid !== "number" ||
    typeof record.commandHash !== "string" ||
    typeof record.startedAt !== "number" ||
    !["open", "closing", "closed", "lost"].includes(String(record.state))
  ) {
    return undefined;
  }
  return {
    leaseId: record.leaseId,
    gatewayInstanceId: record.gatewayInstanceId,
    sessionKey: record.sessionKey,
    wrapperRoot: record.wrapperRoot,
    wrapperPath: record.wrapperPath,
    rootPid: record.rootPid,
    ...(typeof record.processGroupId === "number" ? { processGroupId: record.processGroupId } : {}),
    commandHash: record.commandHash,
    startedAt: record.startedAt,
    state: record.state as AcpxProcessLeaseState,
  };
}

export function normalizeAcpxProcessLeaseFile(value: unknown): AcpxProcessLeaseFile {
  const root =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const leases = Array.isArray(root.leases)
    ? root.leases
        .map(normalizeAcpxProcessLease)
        .filter((lease): lease is AcpxProcessLease => Boolean(lease))
    : [];
  return { version: 1, leases };
}

export function openAcpxProcessLeaseStateStore(
  openKeyedStore: <T>(options: OpenKeyedStoreOptions) => PluginStateKeyedStore<T>,
): PluginStateKeyedStore<AcpxProcessLease> {
  return openKeyedStore<AcpxProcessLease>({
    namespace: ACPX_PROCESS_LEASE_NAMESPACE,
    maxEntries: ACPX_PROCESS_LEASE_MAX_ENTRIES,
  });
}

/** Create a serialized SQLite-backed ACPX process lease store. */
export function createAcpxProcessLeaseStore(params: {
  store: PluginStateKeyedStore<AcpxProcessLease>;
}): AcpxProcessLeaseStore {
  let updateQueue: Promise<void> = Promise.resolve();

  async function update(mutator: () => Promise<void>): Promise<void> {
    const run = updateQueue.then(async () => {
      await mutator();
    });
    updateQueue = run.catch(() => {});
    await run;
  }

  async function readCurrent(): Promise<AcpxProcessLease[]> {
    await updateQueue;
    const entries = await params.store.entries();
    return entries
      .map((entry) => normalizeAcpxProcessLease(entry.value))
      .filter((lease): lease is AcpxProcessLease => Boolean(lease));
  }

  return {
    async load(leaseId) {
      await updateQueue;
      return normalizeAcpxProcessLease(await params.store.lookup(leaseId));
    },
    async listOpen(gatewayInstanceId) {
      const leases = await readCurrent();
      return leases.filter(
        (lease) =>
          (lease.state === "open" || lease.state === "closing") &&
          (!gatewayInstanceId || lease.gatewayInstanceId === gatewayInstanceId),
      );
    },
    async save(lease) {
      await update(async () => {
        await params.store.register(lease.leaseId, lease);
      });
    },
    async markState(leaseId, state) {
      await update(async () => {
        if (state === "closed" || state === "lost") {
          await params.store.delete(leaseId);
          return;
        }
        const lease = normalizeAcpxProcessLease(await params.store.lookup(leaseId));
        if (lease) {
          await params.store.register(leaseId, { ...lease, state });
        }
      });
    },
  };
}

/** Create a unique lease id for one ACPX wrapper process. */
export function createAcpxProcessLeaseId(): string {
  return randomUUID();
}

/** Hash a wrapper command so process leases can detect command drift. */
export function hashAcpxProcessCommand(command: string): string {
  return createHash("sha256").update(command).digest("hex");
}

function quoteEnvValue(value: string): string {
  return /^[A-Za-z0-9_./:=@+-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

function appendAcpxLeaseArgs(params: {
  command: string;
  leaseId: string;
  gatewayInstanceId: string;
}): string {
  return [
    params.command,
    OPENCLAW_ACPX_LEASE_ID_ARG,
    quoteEnvValue(params.leaseId),
    OPENCLAW_GATEWAY_INSTANCE_ID_ARG,
    quoteEnvValue(params.gatewayInstanceId),
  ].join(" ");
}

/** Add ACPX lease identity to a command through env vars and portable args. */
export function withAcpxLeaseEnvironment(params: {
  command: string;
  leaseId: string;
  gatewayInstanceId: string;
  platform?: NodeJS.Platform;
}): string {
  if ((params.platform ?? process.platform) === "win32") {
    return appendAcpxLeaseArgs(params);
  }
  return [
    "env",
    `${OPENCLAW_ACPX_LEASE_ID_ENV}=${quoteEnvValue(params.leaseId)}`,
    `${OPENCLAW_GATEWAY_INSTANCE_ID_ENV}=${quoteEnvValue(params.gatewayInstanceId)}`,
    appendAcpxLeaseArgs(params),
  ].join(" ");
}
