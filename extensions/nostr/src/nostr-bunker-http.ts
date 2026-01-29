/**
 * Nostr Bunker HTTP Handler
 *
 * Handles HTTP requests for bunker management:
 * - GET /api/channels/nostr/:accountId/bunker - List all bunker account statuses
 * - GET /api/channels/nostr/:accountId/bunker/:index - Get specific bunker status
 * - POST /api/channels/nostr/:accountId/bunker/:index - Connect specific bunker
 * - DELETE /api/channels/nostr/:accountId/bunker/:index - Disconnect specific bunker
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import {
  isBunkerConnected,
  loadPersistedState,
  clearPersistedState,
  disconnectBunker,
  connectBunker,
  getBunkerConnection,
  getAllBunkerConnections,
  BunkerAuthUrlError,
  stripBunkerSecret,
} from "./bunker-store.js";
import { getSharedPool } from "./nostr-bus.js";
import type { BunkerAccountConfig } from "./config-schema.js";

// ============================================================================
// Types
// ============================================================================

export interface NostrBunkerHttpContext {
  /** Get bunker accounts from config */
  getBunkerAccounts: (accountId: string) => BunkerAccountConfig[];
  /** Update a bunker account in config (after successful connect) */
  updateBunkerAccount: (
    accountId: string,
    bunkerIndex: number,
    update: Partial<BunkerAccountConfig>
  ) => Promise<void>;
  /** Clear bunkerUrl from config for a specific bunker */
  clearConfigBunkerUrl: (accountId: string, bunkerIndex: number) => Promise<void>;
  /** Logger */
  log?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}

// ============================================================================
// Request Helpers
// ============================================================================

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage, maxBytes = 16 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    req.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf-8");
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });

    req.on("error", reject);
  });
}

interface BunkerPathParams {
  accountId: string;
  bunkerIndex?: number;
}

function parseBunkerPathParams(pathname: string): BunkerPathParams | null {
  // Match: /api/channels/nostr/:accountId/bunker/:index (specific bunker)
  const indexMatch = pathname.match(/^\/api\/channels\/nostr\/([^/]+)\/bunker\/(\d+)$/);
  if (indexMatch) {
    return {
      accountId: indexMatch[1],
      bunkerIndex: parseInt(indexMatch[2], 10),
    };
  }

  // Match: /api/channels/nostr/:accountId/bunker (all bunkers)
  const allMatch = pathname.match(/^\/api\/channels\/nostr\/([^/]+)\/bunker$/);
  if (allMatch) {
    return {
      accountId: allMatch[1],
    };
  }

  return null;
}

// ============================================================================
// HTTP Handler
// ============================================================================

export function createNostrBunkerHttpHandler(
  ctx: NostrBunkerHttpContext
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    // Only handle /api/channels/nostr/:accountId/bunker paths
    if (!url.pathname.includes("/bunker")) {
      return false;
    }

    const params = parseBunkerPathParams(url.pathname);
    if (!params) {
      return false;
    }

    const { accountId, bunkerIndex } = params;

    // Handle different HTTP methods
    try {
      if (req.method === "GET") {
        if (bunkerIndex !== undefined) {
          return handleGetBunkerStatus(accountId, bunkerIndex, ctx, res);
        } else {
          return handleGetAllBunkerStatus(accountId, ctx, res);
        }
      }

      if (req.method === "POST" && bunkerIndex !== undefined) {
        return await handleConnectBunker(accountId, bunkerIndex, ctx, req, res);
      }

      if (req.method === "DELETE" && bunkerIndex !== undefined) {
        return await handleDisconnectBunker(accountId, bunkerIndex, ctx, res);
      }

      // Method not allowed
      sendJson(res, 405, { ok: false, error: "Method not allowed" });
      return true;
    } catch (err) {
      ctx.log?.error(`Bunker HTTP error: ${String(err)}`);
      sendJson(res, 500, { ok: false, error: "Internal server error" });
      return true;
    }
  };
}

// ============================================================================
// GET /api/channels/nostr/:accountId/bunker - List all bunkers
// ============================================================================

function handleGetAllBunkerStatus(
  accountId: string,
  ctx: NostrBunkerHttpContext,
  res: ServerResponse
): true {
  const bunkerAccounts = ctx.getBunkerAccounts(accountId);
  const connections = getAllBunkerConnections(accountId);

  const bunkers = bunkerAccounts.map((account, index) => {
    const connected = isBunkerConnected(accountId, index);
    const connection = connections.find((c) => c.bunkerIndex === index);
    const persistedState = loadPersistedState(accountId, index);

    return {
      index,
      name: account.name,
      bunkerUrl: account.bunkerUrl ? stripBunkerSecret(account.bunkerUrl) : null,
      connected,
      userPubkey: connection?.userPubkey ?? account.userPubkey ?? null,
      connectedAt: connection?.connectedAt ?? account.connectedAt ?? null,
      lastBunkerUrl: persistedState?.lastBunkerUrl ?? null,
    };
  });

  sendJson(res, 200, {
    ok: true,
    bunkers,
  });
  return true;
}

// ============================================================================
// GET /api/channels/nostr/:accountId/bunker/:index - Get specific bunker status
// ============================================================================

function handleGetBunkerStatus(
  accountId: string,
  bunkerIndex: number,
  ctx: NostrBunkerHttpContext,
  res: ServerResponse
): true {
  const bunkerAccounts = ctx.getBunkerAccounts(accountId);
  const account = bunkerAccounts[bunkerIndex];

  if (!account) {
    sendJson(res, 404, { ok: false, error: `Bunker index ${bunkerIndex} not found` });
    return true;
  }

  const connected = isBunkerConnected(accountId, bunkerIndex);
  const connection = getBunkerConnection(accountId, bunkerIndex);
  const persistedState = loadPersistedState(accountId, bunkerIndex);

  sendJson(res, 200, {
    ok: true,
    index: bunkerIndex,
    name: account.name,
    bunkerUrl: account.bunkerUrl ? stripBunkerSecret(account.bunkerUrl) : null,
    connected,
    userPubkey: connection?.userPubkey ?? account.userPubkey ?? null,
    bunkerPubkey: connection?.bunkerPubkey ?? null,
    relays: connection?.relays ?? [],
    userWriteRelays: connection?.userWriteRelays ?? [],
    userReadRelays: connection?.userReadRelays ?? [],
    connectedAt: connection?.connectedAt ?? account.connectedAt ?? null,
    lastBunkerUrl: persistedState?.lastBunkerUrl ?? null,
  });
  return true;
}

// ============================================================================
// POST /api/channels/nostr/:accountId/bunker/:index - Connect bunker
// ============================================================================

async function handleConnectBunker(
  accountId: string,
  bunkerIndex: number,
  ctx: NostrBunkerHttpContext,
  req: IncomingMessage,
  res: ServerResponse
): Promise<true> {
  // Parse request body
  let body: { bunkerUrl?: string };
  try {
    body = (await readJsonBody(req)) as { bunkerUrl?: string };
  } catch (err) {
    sendJson(res, 400, { ok: false, error: String(err) });
    return true;
  }

  // Get bunker URL from request or config
  const bunkerAccounts = ctx.getBunkerAccounts(accountId);
  const account = bunkerAccounts[bunkerIndex];

  const bunkerUrl = body.bunkerUrl ?? account?.bunkerUrl;
  if (!bunkerUrl) {
    sendJson(res, 400, { ok: false, error: "No bunker URL provided" });
    return true;
  }

  // Check if this is a reconnect (same URL minus secret)
  const persistedState = loadPersistedState(accountId, bunkerIndex);
  const strippedUrl = stripBunkerSecret(bunkerUrl);
  const isInitialConnection =
    !persistedState?.lastBunkerUrl || strippedUrl !== persistedState.lastBunkerUrl;

  ctx.log?.info(`[${accountId}] Connecting bunker ${bunkerIndex}${isInitialConnection ? "" : " (reconnect)"}`);

  try {
    const pool = getSharedPool();
    const { connection, isReconnect } = await connectBunker({
      accountId,
      bunkerIndex,
      bunkerUrl,
      pool,
      isInitialConnection,
    });

    // Update config with user pubkey and connected timestamp
    const urlWithoutSecret = stripBunkerSecret(bunkerUrl);
    await ctx.updateBunkerAccount(accountId, bunkerIndex, {
      bunkerUrl: urlWithoutSecret,
      userPubkey: connection.userPubkey,
      connectedAt: connection.connectedAt,
    });

    ctx.log?.info(
      `[${accountId}] Bunker ${bunkerIndex} connected${isReconnect ? " (reconnected)" : ""} as ${connection.userPubkey.slice(0, 8)}...`
    );

    sendJson(res, 200, {
      ok: true,
      userPubkey: connection.userPubkey,
      bunkerPubkey: connection.bunkerPubkey,
      relays: connection.relays,
      userWriteRelays: connection.userWriteRelays,
      userReadRelays: connection.userReadRelays,
      connectedAt: connection.connectedAt,
      isReconnect,
    });
  } catch (err) {
    if (err instanceof BunkerAuthUrlError) {
      ctx.log?.info(`[${accountId}] Bunker ${bunkerIndex} requires auth_url approval`);
      sendJson(res, 200, {
        ok: false,
        needsAuth: true,
        authUrl: err.authUrl,
        error: "Bunker requires approval",
      });
    } else {
      ctx.log?.error(`[${accountId}] Bunker ${bunkerIndex} connect error: ${String(err)}`);
      sendJson(res, 400, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return true;
}

// ============================================================================
// DELETE /api/channels/nostr/:accountId/bunker/:index - Disconnect bunker
// ============================================================================

async function handleDisconnectBunker(
  accountId: string,
  bunkerIndex: number,
  ctx: NostrBunkerHttpContext,
  res: ServerResponse
): Promise<true> {
  ctx.log?.info(`[${accountId}] Disconnecting bunker ${bunkerIndex}`);

  // Disconnect in-memory connection
  const wasConnected = await disconnectBunker(accountId, bunkerIndex);

  // Clear persisted state file (clientSecretKeyHex + lastBunkerUrl)
  clearPersistedState(accountId, bunkerIndex);

  // Clear bunkerUrl from config
  await ctx.clearConfigBunkerUrl(accountId, bunkerIndex);

  ctx.log?.info(`[${accountId}] Bunker ${bunkerIndex} disconnected and state cleared`);

  sendJson(res, 200, { ok: true, wasConnected });
  return true;
}
