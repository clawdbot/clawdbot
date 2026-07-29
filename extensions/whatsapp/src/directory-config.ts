// Whatsapp helper module supports directory config behavior.
import {
  listResolvedDirectoryGroupEntriesFromMapKeys,
  listResolvedDirectoryUserEntriesFromAllowFrom,
  type ChannelDirectoryEntry,
  type DirectoryConfigParams,
} from "openclaw/plugin-sdk/directory-config-runtime";
import { resolveMergedWhatsAppAccountConfig } from "./account-config.js";
import type { WhatsAppAccountConfig } from "./account-types.js";
import { resolveWhatsAppAuthDir } from "./accounts.js";
import { resolveWebAccountId } from "./active-listener.js";
import { readWebAuthExistsForDecision } from "./auth-store.js";
import {
  getWhatsAppConnectionController,
  hasPendingWhatsAppConnectionOwner,
} from "./connection-controller-runtime-context.js";
import {
  acquireWhatsAppStandaloneConnectionOwner,
  WhatsAppConnectionOwnerBusyError,
  type WhatsAppConnectionOwnerLease,
} from "./connection-owner.js";
import { isWhatsAppGroupJid, normalizeWhatsAppTarget } from "./normalize.js";
import {
  createWaDirectorySocket,
  waitForCredsSaveQueueWithTimeout,
  waitForWaConnection,
} from "./session.js";
import { closeWhatsAppSocketAndWait } from "./socket-close.js";

type WhatsAppDirectoryAccount = WhatsAppAccountConfig & { accountId: string };

function resolveWhatsAppDirectoryAccount(
  cfg: DirectoryConfigParams["cfg"],
  accountId?: string | null,
): WhatsAppDirectoryAccount {
  return resolveMergedWhatsAppAccountConfig({ cfg, accountId });
}

export async function listWhatsAppDirectoryPeersFromConfig(params: DirectoryConfigParams) {
  return listResolvedDirectoryUserEntriesFromAllowFrom<WhatsAppDirectoryAccount>({
    ...params,
    resolveAccount: resolveWhatsAppDirectoryAccount,
    resolveAllowFrom: (account) => account.allowFrom,
    normalizeId: (entry) => {
      const normalized = normalizeWhatsAppTarget(entry);
      if (!normalized || isWhatsAppGroupJid(normalized)) {
        return null;
      }
      return normalized;
    },
  });
}

export async function listWhatsAppDirectoryGroupsFromConfig(params: DirectoryConfigParams) {
  return listResolvedDirectoryGroupEntriesFromMapKeys<WhatsAppDirectoryAccount>({
    ...params,
    resolveAccount: resolveWhatsAppDirectoryAccount,
    resolveGroups: (account) => account.groups,
  });
}

export const WHATSAPP_DIRECTORY_UNAVAILABLE_CODE = "whatsapp_directory_unavailable";

export type WhatsAppDirectoryUnavailableReason =
  | "active_owner_unavailable"
  | "connection_owner_busy"
  | "not_linked"
  | "auth_unstable"
  | "connection_failed"
  | "lookup_failed"
  | "cleanup_failed";

export class WhatsAppDirectoryUnavailableError extends Error {
  readonly code = WHATSAPP_DIRECTORY_UNAVAILABLE_CODE;

  constructor(
    public readonly reason: WhatsAppDirectoryUnavailableReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WhatsAppDirectoryUnavailableError";
  }
}

type GroupFetchSocket = {
  groupFetchAllParticipating(): Promise<
    Record<string, { id: string; subject?: string } | undefined>
  >;
};

async function fetchLiveGroups(
  sock: GroupFetchSocket,
  params: DirectoryConfigParams,
): Promise<ChannelDirectoryEntry[]> {
  const groups = await sock.groupFetchAllParticipating();
  const query = params.query?.trim().toLowerCase() ?? "";
  const limit = typeof params.limit === "number" && params.limit > 0 ? params.limit : undefined;
  const entries = Object.entries(groups)
    .map(([jid, metadata]) => ({
      kind: "group" as const,
      id: jid,
      name: metadata?.subject?.trim() || undefined,
    }))
    .filter((entry) => {
      if (!query) {
        return true;
      }
      return entry.id.toLowerCase().includes(query) || entry.name?.toLowerCase().includes(query);
    })
    .toSorted((left, right) => left.id.localeCompare(right.id));
  return limit ? entries.slice(0, limit) : entries;
}

function unavailable(
  reason: WhatsAppDirectoryUnavailableReason,
  message: string,
  cause?: unknown,
): WhatsAppDirectoryUnavailableError {
  return new WhatsAppDirectoryUnavailableError(reason, message, cause ? { cause } : undefined);
}

type StandaloneSocket = Awaited<ReturnType<typeof createWaDirectorySocket>>;

type ManagedStandaloneCleanup = {
  authDir: string;
  inFlight: Promise<void> | null;
  ownerLease: WhatsAppConnectionOwnerLease;
  retryTimer: ReturnType<typeof setTimeout> | null;
  sock: StandaloneSocket | null;
  socketClosed: boolean;
};

const pendingStandaloneCleanups = new Map<string, ManagedStandaloneCleanup>();
const STANDALONE_CLEANUP_RETRY_MS = 1_000;

async function completeStandaloneCleanup(cleanup: ManagedStandaloneCleanup): Promise<void> {
  if (cleanup.sock && !cleanup.socketClosed) {
    await closeWhatsAppSocketAndWait(
      cleanup.sock,
      "OpenClaw WhatsApp standalone directory socket close",
    );
    cleanup.socketClosed = true;
  }
  if (cleanup.sock) {
    const queueResult = await waitForCredsSaveQueueWithTimeout(cleanup.authDir);
    if (queueResult === "timed_out") {
      throw new Error("WhatsApp credential persistence did not drain before socket release");
    }
  }
  await cleanup.ownerLease.release();
  if (pendingStandaloneCleanups.get(cleanup.authDir) === cleanup) {
    pendingStandaloneCleanups.delete(cleanup.authDir);
  }
  if (cleanup.retryTimer) {
    clearTimeout(cleanup.retryTimer);
    cleanup.retryTimer = null;
  }
}

function runStandaloneCleanup(cleanup: ManagedStandaloneCleanup): Promise<void> {
  if (cleanup.inFlight) {
    return cleanup.inFlight;
  }
  const task = completeStandaloneCleanup(cleanup).finally(() => {
    if (cleanup.inFlight === task) {
      cleanup.inFlight = null;
    }
  });
  cleanup.inFlight = task;
  return task;
}

function scheduleStandaloneCleanupRetry(cleanup: ManagedStandaloneCleanup): void {
  if (cleanup.retryTimer) {
    return;
  }
  cleanup.retryTimer = setTimeout(() => {
    cleanup.retryTimer = null;
    void runStandaloneCleanup(cleanup).catch(() => {
      scheduleStandaloneCleanupRetry(cleanup);
    });
  }, STANDALONE_CLEANUP_RETRY_MS);
  // Gateway processes stay alive and retry; standalone CLI processes may exit.
  // A later process safely reclaims the unchanged lock from the definitely dead PID.
  cleanup.retryTimer.unref?.();
}

function retainStandaloneCleanup(cleanup: ManagedStandaloneCleanup): void {
  pendingStandaloneCleanups.set(cleanup.authDir, cleanup);
  scheduleStandaloneCleanupRetry(cleanup);
}

async function finishStandaloneCleanupOrThrow(
  cleanup: ManagedStandaloneCleanup,
  operationError?: unknown,
): Promise<void> {
  try {
    await runStandaloneCleanup(cleanup);
  } catch (cleanupError) {
    retainStandaloneCleanup(cleanup);
    const cause =
      operationError === undefined
        ? cleanupError
        : new AggregateError(
            [operationError, cleanupError],
            "WhatsApp live group lookup and cleanup failed",
            { cause: operationError },
          );
    throw cleanupUnavailable(cause);
  }
}

function cleanupUnavailable(error: unknown): WhatsAppDirectoryUnavailableError {
  return unavailable(
    "cleanup_failed",
    "WhatsApp live group lookup could not safely close its standalone connection.",
    error,
  );
}

async function finishPriorStandaloneCleanup(authDir: string): Promise<void> {
  const cleanup = pendingStandaloneCleanups.get(authDir);
  if (!cleanup) {
    return;
  }
  try {
    await runStandaloneCleanup(cleanup);
  } catch (error) {
    scheduleStandaloneCleanupRetry(cleanup);
    throw cleanupUnavailable(error);
  }
}

async function listGroupsThroughStandaloneOwner(
  params: DirectoryConfigParams,
): Promise<ChannelDirectoryEntry[]> {
  const account = resolveWhatsAppDirectoryAccount(params.cfg, params.accountId);
  const authDir = resolveWhatsAppAuthDir({
    cfg: params.cfg,
    accountId: account.accountId,
  }).authDir;
  await finishPriorStandaloneCleanup(authDir);
  let ownerLease: WhatsAppConnectionOwnerLease;
  try {
    ownerLease = await acquireWhatsAppStandaloneConnectionOwner(authDir);
  } catch (error) {
    if (error instanceof WhatsAppConnectionOwnerBusyError) {
      throw unavailable(
        "connection_owner_busy",
        "WhatsApp live groups are unavailable because the account is owned by another process.",
        error,
      );
    }
    throw unavailable(
      "connection_failed",
      "WhatsApp live groups are unavailable because connection ownership failed.",
      error,
    );
  }

  const cleanup: ManagedStandaloneCleanup = {
    authDir,
    inFlight: null,
    ownerLease,
    retryTimer: null,
    sock: null,
    socketClosed: true,
  };
  let groups: ChannelDirectoryEntry[];
  try {
    let authState: Awaited<ReturnType<typeof readWebAuthExistsForDecision>>;
    try {
      authState = await readWebAuthExistsForDecision(authDir);
    } catch (error) {
      throw unavailable(
        "auth_unstable",
        "WhatsApp live groups are unavailable because linked credentials could not be read.",
        error,
      );
    }
    if (authState.outcome === "unstable") {
      throw unavailable(
        "auth_unstable",
        "WhatsApp live groups are unavailable while linked credentials are changing.",
      );
    }
    if (!authState.exists) {
      throw unavailable(
        "not_linked",
        "WhatsApp live groups are unavailable because this account is not linked.",
      );
    }

    try {
      cleanup.sock = await createWaDirectorySocket(authDir);
      cleanup.socketClosed = false;
      await waitForWaConnection(cleanup.sock, { timeoutMs: 30_000 });
    } catch (error) {
      throw unavailable(
        "connection_failed",
        "WhatsApp live groups are unavailable because the standalone connection failed.",
        error,
      );
    }

    try {
      groups = await fetchLiveGroups(cleanup.sock, params);
    } catch (error) {
      throw unavailable("lookup_failed", "WhatsApp live group lookup failed.", error);
    }
  } catch (error) {
    await finishStandaloneCleanupOrThrow(cleanup, error);
    throw error;
  }
  await finishStandaloneCleanupOrThrow(cleanup);
  return groups;
}

export async function listWhatsAppDirectoryGroupsLive(
  params: DirectoryConfigParams,
): Promise<ChannelDirectoryEntry[]> {
  const accountId = resolveWebAccountId({ cfg: params.cfg, accountId: params.accountId });
  const controller = getWhatsAppConnectionController(accountId);
  if (!controller && !hasPendingWhatsAppConnectionOwner(accountId)) {
    return await listGroupsThroughStandaloneOwner(params);
  }

  const sock = controller?.getCurrentSock();
  if (!sock) {
    throw unavailable(
      "active_owner_unavailable",
      "WhatsApp live groups are unavailable while the gateway connection is offline.",
    );
  }
  try {
    return await fetchLiveGroups(sock, params);
  } catch (error) {
    throw unavailable("lookup_failed", "WhatsApp live group lookup failed.", error);
  }
}
