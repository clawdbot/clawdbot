import fs from "node:fs/promises";
// Whatsapp connection-owner lease serializes auth-backed Baileys sockets across processes.
import {
  acquireFileLock,
  FILE_LOCK_STALE_ERROR_CODE,
  FILE_LOCK_TIMEOUT_ERROR_CODE,
  type FileLockHandle,
} from "openclaw/plugin-sdk/file-lock";
import { resolveUserPath } from "openclaw/plugin-sdk/text-utility-runtime";

const WHATSAPP_CONNECTION_OWNER_BUSY_CODE = "whatsapp_connection_owner_busy";

export class WhatsAppConnectionOwnerBusyError extends Error {
  readonly code = WHATSAPP_CONNECTION_OWNER_BUSY_CODE;

  constructor(
    public readonly authDir: string,
    options?: ErrorOptions,
  ) {
    super("Another process owns this WhatsApp connection.", options);
    this.name = "WhatsAppConnectionOwnerBusyError";
  }
}

export type WhatsAppConnectionOwnerLease = Pick<FileLockHandle, "release">;

const OWNER_LOCK_STALE_MS = 5 * 60_000;
const GATEWAY_LOCAL_OWNER_WAIT_MS = 150_000;

type ProcessOwner = {
  released: Promise<void>;
  resolveReleased: () => void;
  token: symbol;
};

const processOwners = new Map<string, ProcessOwner>();

function ownershipCancelledError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  return reason instanceof Error
    ? reason
    : new Error(
        "WhatsApp connection ownership cancelled",
        reason === undefined ? {} : { cause: reason },
      );
}

async function waitForAbortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw ownershipCancelledError(signal);
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(ownershipCancelledError(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function reserveProcessOwner(params: {
  authDir: string;
  ownerPath: string;
  signal?: AbortSignal;
  waitForLocalOwner: boolean;
}): Promise<ProcessOwner> {
  while (true) {
    if (params.signal?.aborted) {
      throw ownershipCancelledError(params.signal);
    }
    const current = processOwners.get(params.ownerPath);
    if (!current) {
      let resolveReleased = () => {};
      const owner: ProcessOwner = {
        released: new Promise<void>((resolve) => {
          resolveReleased = resolve;
        }),
        resolveReleased,
        token: Symbol(params.ownerPath),
      };
      processOwners.set(params.ownerPath, owner);
      return owner;
    }
    if (!params.waitForLocalOwner) {
      throw new WhatsAppConnectionOwnerBusyError(params.authDir);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const outcome = await Promise.race([
      current.released.then(() => "released" as const),
      new Promise<"timed_out">((resolve) => {
        timer = setTimeout(() => resolve("timed_out"), GATEWAY_LOCAL_OWNER_WAIT_MS);
        timer.unref?.();
      }),
      new Promise<"aborted">((resolve) => {
        onAbort = () => resolve("aborted");
        params.signal?.addEventListener("abort", onAbort, { once: true });
      }),
    ]).finally(() => {
      if (timer) {
        clearTimeout(timer);
      }
      if (onAbort) {
        params.signal?.removeEventListener("abort", onAbort);
      }
    });
    if (outcome === "aborted") {
      throw ownershipCancelledError(params.signal);
    }
    if (outcome === "timed_out") {
      throw new WhatsAppConnectionOwnerBusyError(params.authDir);
    }
  }
}

function abandonProcessOwner(ownerPath: string, owner: ProcessOwner): void {
  if (processOwners.get(ownerPath)?.token !== owner.token) {
    return;
  }
  processOwners.delete(ownerPath);
  owner.resolveReleased();
}

async function acquireOwnerLease(params: {
  authDir: string;
  retries: number;
  signal?: AbortSignal;
  waitForLocalOwner: boolean;
}): Promise<WhatsAppConnectionOwnerLease> {
  const resolvedOwnerPath = resolveUserPath(params.authDir);
  await fs.mkdir(resolvedOwnerPath, { recursive: true });
  const ownerPath = await fs.realpath(resolvedOwnerPath);
  // Reserve before awaiting the filesystem so concurrent callers cannot use the
  // underlying file lock's intentionally re-entrant mode for two sockets.
  const processOwner = await reserveProcessOwner({
    authDir: params.authDir,
    ownerPath,
    signal: params.signal,
    waitForLocalOwner: params.waitForLocalOwner,
  });
  let fileLock: FileLockHandle;
  let attempt = 0;
  while (true) {
    if (params.signal?.aborted) {
      abandonProcessOwner(ownerPath, processOwner);
      throw ownershipCancelledError(params.signal);
    }
    try {
      fileLock = await acquireFileLock(ownerPath, {
        retries: { retries: 0, factor: 1, minTimeout: 1, maxTimeout: 1 },
        stale: OWNER_LOCK_STALE_MS,
        // The shared lock wrapper reclaims only a definitely dead PID and removes
        // the exact unchanged sidecar. Live or ambiguous owners remain fail-closed.
        staleRecovery: "remove-if-unchanged",
      });
      break;
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === FILE_LOCK_STALE_ERROR_CODE) {
        abandonProcessOwner(ownerPath, processOwner);
        throw new WhatsAppConnectionOwnerBusyError(params.authDir, { cause: error });
      }
      if (code !== FILE_LOCK_TIMEOUT_ERROR_CODE || attempt >= params.retries) {
        abandonProcessOwner(ownerPath, processOwner);
        if (code === FILE_LOCK_TIMEOUT_ERROR_CODE) {
          throw new WhatsAppConnectionOwnerBusyError(params.authDir, { cause: error });
        }
        throw error;
      }
      const delayMs = Math.min(100 * 1.5 ** attempt, 1_000);
      attempt += 1;
      await waitForAbortableDelay(delayMs, params.signal).catch((delayError: unknown) => {
        abandonProcessOwner(ownerPath, processOwner);
        throw delayError;
      });
    }
  }
  let releasePromise: Promise<void> | null = null;
  return {
    release: async () => {
      if (!releasePromise) {
        releasePromise = fileLock
          .release()
          .then(() => {
            abandonProcessOwner(ownerPath, processOwner);
          })
          .catch((releaseError: unknown) => {
            releasePromise = null;
            throw releaseError;
          });
      }
      await releasePromise;
    },
  };
}

/** Gateway owner waits for a bounded standalone lookup to finish before startup. */
export async function acquireWhatsAppGatewayConnectionOwner(
  authDir: string,
  signal?: AbortSignal,
): Promise<WhatsAppConnectionOwnerLease> {
  // Gateway lifecycle stops an account before restarting it. A timed-out incumbent
  // must keep same-auth restarts blocked; handoff would permit concurrent sockets.
  return await acquireOwnerLease({ authDir, retries: 150, signal, waitForLocalOwner: true });
}

/** Standalone lookup fails quickly when a gateway already owns the account. */
export async function acquireWhatsAppStandaloneConnectionOwner(
  authDir: string,
): Promise<WhatsAppConnectionOwnerLease> {
  return await acquireOwnerLease({ authDir, retries: 3, waitForLocalOwner: false });
}
