import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { generateSecretKey } from "nostr-tools";
import { bytesToHex, hexToBytes } from "nostr-tools/utils";
import { BunkerSigner, parseBunkerInput } from "nostr-tools/nip46";
import { RelayList } from "nostr-tools/kinds";
import type { SimplePool } from "nostr-tools";
import os from "node:os";

import { getNostrRuntime } from "./runtime.js";

// ============================================================================
// Persistence - client key survives process restarts to maintain bunker session
// ============================================================================

const BUNKER_STATE_DIR = "nostr";

export interface PersistedBunkerState {
  clientSecretKeyHex: string;
  lastBunkerUrl?: string; // Without secret
}

/**
 * Generate a unique key for the bunker connection map.
 */
function makeBunkerKey(accountId: string, bunkerIndex: number): string {
  return `${accountId}-${bunkerIndex}`;
}

function getBunkerStatePath(accountId: string, bunkerIndex: number): string {
  const stateDir = getNostrRuntime().state.resolveStateDir(process.env, os.homedir);
  return join(stateDir, BUNKER_STATE_DIR, `bunker-state-${accountId}-${bunkerIndex}.json`);
}

export function loadPersistedState(accountId: string, bunkerIndex: number): PersistedBunkerState | null {
  try {
    const path = getBunkerStatePath(accountId, bunkerIndex);
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, "utf-8"));
    }
  } catch {
    // Fail silently - will generate new key
  }
  return null;
}

export function savePersistedState(accountId: string, bunkerIndex: number, state: PersistedBunkerState): void {
  try {
    const path = getBunkerStatePath(accountId, bunkerIndex);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state, null, 2));
  } catch {
    // Fail silently - persistence is best-effort
  }
}

/**
 * Strip the one-time secret from a bunker URL for storage/comparison.
 * Bunker secrets are single-use, so we don't persist them.
 */
export function stripBunkerSecret(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete("secret");
    return parsed.toString();
  } catch {
    return url;
  }
}

// ============================================================================
// Connection types
// ============================================================================

export interface BunkerConnection {
  signer: BunkerSigner;
  userPubkey: string; // The user's pubkey (from getPublicKey, NOT bunker pubkey)
  bunkerPubkey: string; // The bunker's pubkey (from bunker URL)
  relays: string[]; // From bunker URL
  userWriteRelays: string[]; // From user's kind:10002 (NIP-65) - for publishing
  userReadRelays: string[]; // From user's kind:10002 (NIP-65) - for fetching
  connectedAt: number;
  accountId: string;
  bunkerIndex: number;
}

// Per-account bunker connections
const activeBunkers = new Map<string, BunkerConnection>();

// Per-account client secret keys
const clientSecretKeys = new Map<string, Uint8Array>();

/**
 * Get or generate the client secret key for a specific bunker.
 * Persists key to disk so reconnects use the same identity (bunker sees same client).
 */
export function getClientSecretKey(accountId: string, bunkerIndex: number): Uint8Array {
  const key = makeBunkerKey(accountId, bunkerIndex);
  let secretKey = clientSecretKeys.get(key);
  if (!secretKey) {
    const persisted = loadPersistedState(accountId, bunkerIndex);
    if (persisted?.clientSecretKeyHex) {
      secretKey = hexToBytes(persisted.clientSecretKeyHex);
    } else {
      secretKey = generateSecretKey();
      savePersistedState(accountId, bunkerIndex, { clientSecretKeyHex: bytesToHex(secretKey) });
    }
    clientSecretKeys.set(key, secretKey);
  }
  return secretKey;
}

/** Connection timeout (ms) - increased to 90s because auth_url flows require user interaction in signer app */
const BUNKER_CONNECT_TIMEOUT_MS = 90000;

/** Timeout for fetching user's relay list (ms) */
const RELAY_FETCH_TIMEOUT_MS = 5000;

/**
 * Fetch user's relays from their NIP-65 relay list (kind:10002).
 * Returns both read and write relays separately.
 */
async function fetchUserRelays(
  pool: SimplePool,
  pubkey: string,
  queryRelays: string[]
): Promise<{ readRelays: string[]; writeRelays: string[] }> {
  try {
    // Query bunker relays for the user's kind:10002 event
    const relayListEvent = await Promise.race([
      pool.get(queryRelays, {
        kinds: [RelayList], // 10002
        authors: [pubkey],
      }),
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), RELAY_FETCH_TIMEOUT_MS)
      ),
    ]);

    if (!relayListEvent) return { readRelays: [], writeRelays: [] };

    // Parse "r" tags
    const readRelays: string[] = [];
    const writeRelays: string[] = [];
    for (const tag of relayListEvent.tags) {
      if (tag[0] !== "r" || !tag[1]) continue;
      const relay = tag[1];
      const marker = tag[2];
      // No marker = both read and write
      if (!marker) {
        readRelays.push(relay);
        writeRelays.push(relay);
      } else if (marker === "read") {
        readRelays.push(relay);
      } else if (marker === "write") {
        writeRelays.push(relay);
      }
    }
    return { readRelays, writeRelays };
  } catch {
    return { readRelays: [], writeRelays: [] }; // Fail silently - relay list is optional
  }
}

export interface ConnectBunkerResult {
  connection: BunkerConnection;
  isReconnect: boolean;
}

/**
 * Custom error thrown when bunker requires auth_url approval.
 * The user needs to open the URL to approve the connection in their signer app.
 */
export class BunkerAuthUrlError extends Error {
  constructor(public readonly authUrl: string) {
    super(`Bunker requires approval. Open this URL in your browser: ${authUrl}`);
    this.name = "BunkerAuthUrlError";
  }
}

export async function connectBunker(opts: {
  accountId: string;
  bunkerIndex: number;
  bunkerUrl: string;
  pool: SimplePool;
  /** If false, treats this as a reconnect and won't send the secret */
  isInitialConnection?: boolean;
}): Promise<ConnectBunkerResult> {
  const key = makeBunkerKey(opts.accountId, opts.bunkerIndex);

  // Disconnect existing local connection first
  const existingConnection = activeBunkers.get(key);
  if (existingConnection) {
    await disconnectBunker(opts.accountId, opts.bunkerIndex);
  }

  // parseBunkerInput returns null on error (no throw)
  const bp = await parseBunkerInput(opts.bunkerUrl);
  if (!bp) {
    throw new Error("Invalid bunker URL format");
  }
  if (bp.relays.length === 0) {
    throw new Error("No relays in bunker URL");
  }

  // Track if we received an auth_url during connection
  let pendingAuthUrl: string | null = null;

  // fromBunker() is SYNCHRONOUS - returns immediately
  const signer = BunkerSigner.fromBunker(getClientSecretKey(opts.accountId, opts.bunkerIndex), bp, {
    pool: opts.pool,
    onauth: (authUrl: string) => {
      // Bunker is requesting authorization - store the URL
      pendingAuthUrl = authUrl;
    },
  });

  // Helper to send connect request with timeout
  const connectWithSecret = async (secret: string | null) => {
    const connectPromise = signer.sendRequest("connect", [bp.pubkey, secret || ""]);
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        // If we have an auth_url pending, throw that instead of generic timeout
        if (pendingAuthUrl) {
          reject(new BunkerAuthUrlError(pendingAuthUrl));
        } else {
          reject(new Error("Bunker connection timeout"));
        }
      }, BUNKER_CONNECT_TIMEOUT_MS);
    });
    await Promise.race([connectPromise, timeoutPromise]);
  };

  // Determine if this is initial connection or reconnect
  const isInitial = opts.isInitialConnection !== false;
  const secret = isInitial ? bp.secret : null;
  let isReconnect = !isInitial;

  try {
    await connectWithSecret(secret);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    // Retry without secret (for one-time secrets already consumed, or reconnects)
    // Pidgeon pattern: try without secret if the bunker rejects
    if (secret && (msg.includes("already connected") || msg.includes("invalid secret"))) {
      try {
        await connectWithSecret(null);
      } catch (retryErr) {
        const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        // If retry also says "already connected", that's fine - bunker still knows us
        if (!retryMsg.includes("already connected")) {
          throw retryErr;
        }
      }
      isReconnect = true; // If we retried without secret, it's effectively a reconnect
    } else if (msg.includes("already connected")) {
      // Bunker has existing session with this client pubkey - that's OK, continue
      isReconnect = true;
    } else {
      throw err;
    }
  }

  // getPublicKey() returns the USER's pubkey (cached after first call)
  const userPubkey = await signer.getPublicKey();

  // Fetch user's NIP-65 relay list for better publishing/fetching coverage
  const { readRelays, writeRelays } = await fetchUserRelays(
    opts.pool,
    userPubkey,
    bp.relays
  );

  const connection: BunkerConnection = {
    signer,
    userPubkey,
    bunkerPubkey: bp.pubkey,
    relays: bp.relays,
    userWriteRelays: writeRelays,
    userReadRelays: readRelays,
    connectedAt: Date.now(),
    accountId: opts.accountId,
    bunkerIndex: opts.bunkerIndex,
  };

  activeBunkers.set(key, connection);

  // Persist state after successful connect (strip secret from URL)
  const strippedUrl = stripBunkerSecret(opts.bunkerUrl);
  savePersistedState(opts.accountId, opts.bunkerIndex, {
    clientSecretKeyHex: bytesToHex(getClientSecretKey(opts.accountId, opts.bunkerIndex)),
    lastBunkerUrl: strippedUrl,
  });

  return { connection, isReconnect };
}

export function getBunkerConnection(accountId: string, bunkerIndex: number): BunkerConnection | null {
  return activeBunkers.get(makeBunkerKey(accountId, bunkerIndex)) ?? null;
}

/**
 * Get the first connected bunker for an account (convenience for single-bunker usage).
 */
export function getFirstBunkerConnection(accountId: string): BunkerConnection | null {
  // Check bunker index 0 first (most common case)
  const first = activeBunkers.get(makeBunkerKey(accountId, 0));
  if (first) return first;

  // Search for any connected bunker for this account
  for (const [key, conn] of activeBunkers.entries()) {
    if (key.startsWith(`${accountId}-`)) {
      return conn;
    }
  }
  return null;
}

/**
 * Get all connected bunkers for an account.
 */
export function getAllBunkerConnections(accountId: string): BunkerConnection[] {
  const connections: BunkerConnection[] = [];
  for (const [key, conn] of activeBunkers.entries()) {
    if (key.startsWith(`${accountId}-`)) {
      connections.push(conn);
    }
  }
  return connections.sort((a, b) => a.bunkerIndex - b.bunkerIndex);
}

export async function disconnectBunker(accountId: string, bunkerIndex: number): Promise<boolean> {
  const key = makeBunkerKey(accountId, bunkerIndex);
  const connection = activeBunkers.get(key);
  if (!connection) return false;
  await connection.signer.close();
  activeBunkers.delete(key);
  return true;
}

/**
 * Disconnect all bunkers for an account.
 */
export async function disconnectAllBunkers(accountId: string): Promise<number> {
  const keysToDelete: string[] = [];
  for (const [key, conn] of activeBunkers.entries()) {
    if (key.startsWith(`${accountId}-`)) {
      keysToDelete.push(key);
      await conn.signer.close();
    }
  }
  for (const key of keysToDelete) {
    activeBunkers.delete(key);
  }
  return keysToDelete.length;
}

export function isBunkerConnected(accountId: string, bunkerIndex: number): boolean {
  return activeBunkers.has(makeBunkerKey(accountId, bunkerIndex));
}

/**
 * Check if any bunker is connected for an account.
 */
export function hasAnyBunkerConnected(accountId: string): boolean {
  for (const key of activeBunkers.keys()) {
    if (key.startsWith(`${accountId}-`)) {
      return true;
    }
  }
  return false;
}

/**
 * Reset the client secret key for a specific bunker - useful for testing
 */
export function resetClientSecretKey(accountId: string, bunkerIndex: number): void {
  clientSecretKeys.delete(makeBunkerKey(accountId, bunkerIndex));
}

/**
 * Clear all persisted bunker state for a specific bunker and reset in-memory client key.
 * This is a full reset - next connect will generate a fresh identity.
 */
export function clearPersistedState(accountId: string, bunkerIndex: number): void {
  try {
    const path = getBunkerStatePath(accountId, bunkerIndex);
    if (existsSync(path)) {
      unlinkSync(path);
    }
  } catch {
    // Fail silently
  }
  // Also reset the in-memory client key so next connect generates fresh identity
  clientSecretKeys.delete(makeBunkerKey(accountId, bunkerIndex));
}
