import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { isPidDefinitelyDead } from "../../shared/pid-alive.js";
import {
  isNativeHookRelayBridgeStaleRegistrationError,
  NATIVE_HOOK_BRIDGE_REPLACEMENT_RECORD_GRACE_MS,
  NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR,
} from "./native-hook-relay-client.js";
import {
  nativeHookRelayRegistrationsById,
  nativeHookRelayState,
} from "./native-hook-relay-state.js";
import {
  clearNativeHookRelayBridgeRecordsForTests,
  deleteNativeHookRelayBridgeRecordIfOwned,
  pruneNativeHookRelayBridgeRecords,
  readNativeHookRelayBridgeRecord as readNativeHookRelayBridgeRecordFromStore,
  renewOrRestoreNativeHookRelayBridgeRecord,
  writeNativeHookRelayBridgeRecord,
  type NativeHookRelayBridgeRecord,
} from "./native-hook-relay-store.js";
import type {
  ActiveNativeHookRelayRegistration,
  InvokeNativeHookRelayParams,
  NativeHookRelayBridgeRegistration,
  NativeHookRelayProcessResponse,
  NativeHookRelayProvider,
} from "./native-hook-relay-types.js";
import {
  isJsonObject,
  normalizePositiveInteger,
  readNonEmptyString,
} from "./native-hook-relay-utils.js";

const MAX_NATIVE_HOOK_BRIDGE_BODY_BYTES = 5_000_000;
const log = createSubsystemLogger("agents/harness/native-hook-relay");

export {
  isRetryableNativeHookRelayBridgeLookupError,
  NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR,
} from "./native-hook-relay-client.js";

const { relays, relayBridges } = nativeHookRelayState;
const relayRegistrationsById = nativeHookRelayRegistrationsById;

type InvokeNativeHookRelay = (
  params: InvokeNativeHookRelayParams,
) => Promise<NativeHookRelayProcessResponse>;

type NativeHookRelayBridgeRequestAuth = {
  provider: NativeHookRelayProvider;
  relayId: string;
  token: string;
  bridge: NativeHookRelayBridgeRegistration;
  invokeRelay: InvokeNativeHookRelay;
};

export function registerNativeHookRelayBridge(
  registration: ActiveNativeHookRelayRegistration,
  stateDbPath: string,
  invokeRelay: InvokeNativeHookRelay,
): void {
  const relayId = registration.relayId;
  const existing = relayBridges.get(relayId);
  if (existing) {
    if (existing.server.listening) {
      // Reuse the live bridge so re-registration never interrupts in-flight
      // hook subprocesses from sibling runs on the same relayId. Refresh the
      // record so its expiry covers the new registration.
      refreshNativeHookRelayBridgeRecord(relayId);
      return;
    }
    if (existing.pendingListen) {
      // Server is still starting; its listen callback publishes the record
      // with relay-wide expiry once bound.
      return;
    }
    // The previous bridge server closed or failed. Replace it, leaving the old
    // record in place briefly so racing hook subprocesses retry instead of
    // observing a missing relay.
    unregisterNativeHookRelayBridge(relayId, {
      deferBridgeRecordRemovalMs: NATIVE_HOOK_BRIDGE_REPLACEMENT_RECORD_GRACE_MS,
      expectedBridge: existing,
    });
  } else {
    // Liveness checks stay outside the write transaction. The store rereads
    // each authoritative row before deletion so renewal or replacement wins
    // the race.
    try {
      const pruned = pruneNativeHookRelayBridgeRecords({
        currentPid: process.pid,
        isPidDead: isPidDefinitelyDead,
        stateDbPath,
      });
      for (const row of pruned) {
        log.debug("pruned stale native hook relay bridge record", {
          relayId: row.relayId,
          stalePid: row.pid,
          currentPid: process.pid,
          reason: row.reason,
        });
      }
    } catch (error) {
      log.debug("native hook relay bridge record prune skipped", { error });
    }
  }
  const token = randomUUID();
  const server = createServer();
  const bridge: NativeHookRelayBridgeRegistration = {
    relayId,
    stateDbPath,
    token,
    server,
    pendingListen: true,
  };
  server.on("request", (req, res) => {
    void handleNativeHookRelayBridgeRequest(req, res, {
      provider: registration.provider,
      relayId,
      token,
      bridge,
      invokeRelay,
    });
  });
  relayBridges.set(relayId, bridge);
  server.on("error", (error) => {
    bridge.pendingListen = false;
    log.debug("native hook relay bridge server error", { error, relayId });
  });
  server.listen(0, "127.0.0.1", () => {
    bridge.pendingListen = false;
    if (relayBridges.get(relayId) !== bridge) {
      return;
    }
    try {
      writeNativeHookRelayBridgeRecordForRelay(relayId, bridge);
    } catch (error) {
      log.debug("failed to publish native hook relay bridge record", {
        error,
        relayId,
      });
    }
  });
  server.unref();
}

/**
 * One bridge serves every live registration for the relayId, so the record
 * must outlive the longest-lived one. A shared-state registration written by
 * an older module copy lives only in `relays`; keep the record alive for it
 * too.
 */
export function resolveNativeHookRelayBridgeRecordExpiresAtMs(
  relayId: string,
  floorExpiresAtMs?: number,
): number | undefined {
  let expiresAtMs = floorExpiresAtMs;
  for (const registration of relayRegistrationsById.get(relayId) ?? []) {
    if (expiresAtMs === undefined || registration.expiresAtMs > expiresAtMs) {
      expiresAtMs = registration.expiresAtMs;
    }
  }
  const current = relays.get(relayId);
  if (current && (expiresAtMs === undefined || current.expiresAtMs > expiresAtMs)) {
    expiresAtMs = current.expiresAtMs;
  }
  return expiresAtMs;
}

function writeNativeHookRelayBridgeRecordForRelay(
  relayId: string,
  bridge: NativeHookRelayBridgeRegistration,
): void {
  const expiresAtMs = resolveNativeHookRelayBridgeRecordExpiresAtMs(relayId);
  if (expiresAtMs === undefined) {
    return;
  }
  const record = resolveNativeHookRelayBridgeRecord(relayId, bridge, expiresAtMs);
  if (!record) {
    return;
  }
  writeNativeHookRelayBridgeRecord({ record, stateDbPath: bridge.stateDbPath });
}

/** Republish the shared record after registration-set changes on a live bridge. */
export function refreshNativeHookRelayBridgeRecord(relayId: string): void {
  const bridge = relayBridges.get(relayId);
  if (!bridge || !bridge.server.listening) {
    return;
  }
  try {
    writeNativeHookRelayBridgeRecordForRelay(relayId, bridge);
  } catch (error) {
    log.debug("failed to publish native hook relay bridge record", { error, relayId });
  }
}

function resolveNativeHookRelayBridgeRecord(
  relayId: string,
  bridge: NativeHookRelayBridgeRegistration,
  expiresAtMs: number,
): NativeHookRelayBridgeRecord | undefined {
  const address = bridge.server.address();
  if (!address || typeof address === "string") {
    log.debug("native hook relay bridge server address unavailable", {
      relayId,
    });
    return undefined;
  }
  return {
    relayId,
    pid: process.pid,
    hostname: "127.0.0.1",
    port: address.port,
    token: bridge.token,
    expiresAtMs,
  };
}

export function renewNativeHookRelayBridgeRecord(
  registration: ActiveNativeHookRelayRegistration,
  bridge: NativeHookRelayBridgeRegistration,
  expiresAtMs: number,
): "renewed" | "unavailable" | "ownership-changed" {
  const record = resolveNativeHookRelayBridgeRecord(registration.relayId, bridge, expiresAtMs);
  if (!record) {
    return "unavailable";
  }
  return renewOrRestoreNativeHookRelayBridgeRecord({
    record,
    stateDbPath: bridge.stateDbPath,
  })
    ? "renewed"
    : "ownership-changed";
}

export function unregisterNativeHookRelayBridge(
  relayId: string,
  options?: {
    deferBridgeRecordRemovalMs?: number;
    expectedBridge?: NativeHookRelayBridgeRegistration;
  },
): void {
  const bridge = options?.expectedBridge ?? relayBridges.get(relayId);
  if (!bridge) {
    return;
  }
  if (relayBridges.get(relayId) === bridge) {
    relayBridges.delete(relayId);
  }
  bridge.server.close();
  const removeRecord = () => {
    try {
      deleteNativeHookRelayBridgeRecordIfOwned({ ...bridge, pid: process.pid });
    } catch (error) {
      log.debug("failed to remove native hook relay bridge record", { error, relayId });
    }
  };
  const deferBridgeRecordRemovalMs = normalizePositiveInteger(
    options?.deferBridgeRecordRemovalMs,
    0,
  );
  if (deferBridgeRecordRemovalMs > 0) {
    // During stable-id replacement, retain the old locator until the successor
    // upserts. The token-scoped timer cannot delete that successor.
    const timeout = setTimeout(removeRecord, deferBridgeRecordRemovalMs);
    timeout.unref();
    return;
  }
  removeRecord();
}

async function handleNativeHookRelayBridgeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  auth: NativeHookRelayBridgeRequestAuth,
): Promise<void> {
  try {
    if (req.method !== "POST" || req.url !== "/invoke") {
      writeNativeHookRelayBridgeJson(res, 404, { ok: false, error: "not found" });
      return;
    }
    if (req.headers.authorization !== `Bearer ${auth.token}`) {
      writeNativeHookRelayBridgeJson(res, 403, { ok: false, error: "forbidden" });
      return;
    }
    if (!isCurrentNativeHookRelayBridgeRequest(auth)) {
      writeNativeHookRelayBridgeJson(res, 410, {
        ok: false,
        error: NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR,
      });
      return;
    }
    const body = await readNativeHookRelayBridgeBody(req);
    const payload = readNativeHookRelayBridgePayload(JSON.parse(body));
    if (payload.provider !== auth.provider || payload.relayId !== auth.relayId) {
      writeNativeHookRelayBridgeJson(res, 403, {
        ok: false,
        error: "native hook relay bridge target mismatch",
      });
      return;
    }
    if (!isCurrentNativeHookRelayBridgeRequest(auth)) {
      writeNativeHookRelayBridgeJson(res, 410, {
        ok: false,
        error: NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR,
      });
      return;
    }
    const result = await auth.invokeRelay({ ...payload, requireGeneration: true });
    writeNativeHookRelayBridgeJson(res, 200, { ok: true, result });
  } catch (error) {
    writeNativeHookRelayBridgeJson(
      res,
      isNativeHookRelayBridgeStaleRegistrationError(error) ? 410 : 500,
      { ok: false, error: error instanceof Error ? error.message : String(error) },
    );
  }
}

function isCurrentNativeHookRelayBridgeRequest(auth: NativeHookRelayBridgeRequestAuth): boolean {
  // The bridge outlives individual registrations; a request is current while
  // this bridge is still installed and any registration is live. Per-request
  // generation resolution happens in invokeNativeHookRelay and fails closed.
  // `relays` alone can hold a registration written by an older module copy.
  return (
    relayBridges.get(auth.relayId) === auth.bridge &&
    ((relayRegistrationsById.get(auth.relayId)?.size ?? 0) > 0 || relays.has(auth.relayId))
  );
}

async function readNativeHookRelayBridgeBody(req: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_NATIVE_HOOK_BRIDGE_BODY_BYTES) {
      throw new Error("native hook relay bridge payload too large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function readNativeHookRelayBridgePayload(value: unknown): InvokeNativeHookRelayParams {
  if (!isJsonObject(value)) {
    throw new Error("native hook relay bridge payload must be an object");
  }
  return {
    provider: value.provider,
    relayId: value.relayId,
    generation: readNonEmptyString(value.generation, "generation"),
    event: value.event,
    rawPayload: value.rawPayload,
  };
}

function writeNativeHookRelayBridgeJson(
  res: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

export function readNativeHookRelayBridgeRecordIfExists(
  relayId: string,
  stateDbPath?: string,
): NativeHookRelayBridgeRecord | undefined {
  try {
    return readNativeHookRelayBridgeRecordFromStore({ relayId, stateDbPath });
  } catch (error) {
    log.debug("failed to read native hook relay bridge record", { error, relayId });
  }
  return undefined;
}

export function clearNativeHookRelayBridgesForTests(): void {
  for (const relayId of relayBridges.keys()) {
    unregisterNativeHookRelayBridge(relayId);
  }
  clearNativeHookRelayBridgeRecordsForTests();
}
