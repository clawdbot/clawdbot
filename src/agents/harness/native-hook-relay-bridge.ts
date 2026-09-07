import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { isPidDefinitelyDead } from "../../shared/pid-alive.js";
import {
  isNativeHookRelayBridgeStaleRegistrationError,
  NATIVE_HOOK_BRIDGE_REPLACEMENT_RECORD_GRACE_MS,
  NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR,
} from "./native-hook-relay-client.js";
import { nativeHookRelayState } from "./native-hook-relay-state.js";
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
  NativeHookRelayBridgeReplacement,
  NativeHookRelayProcessResponse,
  NativeHookRelayProvider,
} from "./native-hook-relay-types.js";
import { isJsonObject, readNonEmptyString } from "./native-hook-relay-utils.js";

const MAX_NATIVE_HOOK_BRIDGE_BODY_BYTES = 5_000_000;
const log = createSubsystemLogger("agents/harness/native-hook-relay");

export {
  isRetryableNativeHookRelayBridgeLookupError,
  NATIVE_HOOK_BRIDGE_REPLACEMENT_RECORD_GRACE_MS,
  NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR,
} from "./native-hook-relay-client.js";

const { relays, relayBridges, relayBridgeReplacements, closingRelayBridges } = nativeHookRelayState;

type InvokeNativeHookRelay = (
  params: InvokeNativeHookRelayParams,
) => Promise<NativeHookRelayProcessResponse>;

type NativeHookRelayBridgeRequestAuth = {
  provider: NativeHookRelayProvider;
  relayId: string;
  token: string;
  registration: ActiveNativeHookRelayRegistration;
  bridge: NativeHookRelayBridgeRegistration;
  invokeRelay: InvokeNativeHookRelay;
};

/** Transfer outstanding predecessor cleanup to this exact replacement attempt. */
export function beginNativeHookRelayBridgeReplacement(
  relayId: string,
): NativeHookRelayBridgeReplacement {
  const replacement: NativeHookRelayBridgeReplacement = {
    retired: relayBridgeReplacements.get(relayId)?.retired ?? new Set(),
  };
  const bridge = relayBridges.get(relayId);
  if (bridge) {
    replacement.retired.add(bridge);
  }
  relayBridgeReplacements.set(relayId, replacement);
  return replacement;
}

export function assertNativeHookRelayBridgeReplacementCurrent(
  relayId: string,
  replacement: NativeHookRelayBridgeReplacement,
): void {
  if (relayBridgeReplacements.get(relayId) !== replacement) {
    throw new Error("native hook relay bridge replacement is no longer current");
  }
}

export function registerNativeHookRelayBridge(
  registration: ActiveNativeHookRelayRegistration,
  stateDbPath: string,
  invokeRelay: InvokeNativeHookRelay,
  replacement: NativeHookRelayBridgeReplacement,
): void {
  assertNativeHookRelayBridgeReplacementCurrent(registration.relayId, replacement);
  // Liveness checks stay outside the write transaction. The store rereads each
  // authoritative row before deletion so renewal or replacement wins the race.
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
  const token = randomUUID();
  const server = createServer();
  const bridge: NativeHookRelayBridgeRegistration = {
    relayId: registration.relayId,
    stateDbPath,
    token,
    server,
    replacement,
  };
  server.on("request", (req, res) => {
    void handleNativeHookRelayBridgeRequest(req, res, {
      provider: registration.provider,
      relayId: registration.relayId,
      token,
      registration,
      bridge,
      invokeRelay,
    });
  });
  relayBridges.set(registration.relayId, bridge);
  server.on("error", (error) => {
    log.debug("native hook relay bridge server error", { error, relayId: registration.relayId });
    unregisterNativeHookRelayBridge(registration.relayId, { expectedBridge: bridge });
  });
  server.listen(0, "127.0.0.1", () => {
    if (relayBridges.get(registration.relayId) !== bridge) {
      // Closing before asynchronous listen completes does not cancel every
      // pending start. A canceled bridge must never publish or retain a port.
      closeNativeHookRelayBridge(bridge);
      return;
    }
    try {
      writeNativeHookRelayBridgeRecordForRegistration(registration, bridge);
      // Publication owns handoff; this interval drains already-read locators,
      // rather than guessing how long successor startup will take.
      for (const retired of replacement.retired) {
        if (closingRelayBridges.has(retired)) {
          continue;
        }
        retired.closeTimer ??= setTimeout(
          () => closeNativeHookRelayBridge(retired),
          NATIVE_HOOK_BRIDGE_REPLACEMENT_RECORD_GRACE_MS,
        );
        retired.closeTimer.unref();
      }
    } catch (error) {
      log.debug("failed to publish native hook relay bridge record", {
        error,
        relayId: registration.relayId,
      });
      disposeNativeHookRelayBridgeReplacement(registration.relayId, replacement);
    }
  });
  server.unref();
}

function writeNativeHookRelayBridgeRecordForRegistration(
  registration: ActiveNativeHookRelayRegistration,
  bridge: NativeHookRelayBridgeRegistration,
): void {
  const record = resolveNativeHookRelayBridgeRecord(registration, bridge);
  if (!record) {
    throw new Error("native hook relay bridge address unavailable during publication");
  }
  writeNativeHookRelayBridgeRecord({ record, stateDbPath: bridge.stateDbPath });
}

function resolveNativeHookRelayBridgeRecord(
  registration: ActiveNativeHookRelayRegistration,
  bridge: NativeHookRelayBridgeRegistration,
  expiresAtMs = registration.expiresAtMs,
): NativeHookRelayBridgeRecord | undefined {
  const address = bridge.server.address();
  if (!address || typeof address === "string") {
    log.debug("native hook relay bridge server address unavailable", {
      relayId: registration.relayId,
    });
    return undefined;
  }
  return {
    relayId: registration.relayId,
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
  const record = resolveNativeHookRelayBridgeRecord(registration, bridge, expiresAtMs);
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
    bridgeReplacement?: NativeHookRelayBridgeReplacement;
    expectedBridge?: NativeHookRelayBridgeRegistration;
  },
): void {
  const replacement = options?.bridgeReplacement;
  if (replacement && relayBridgeReplacements.get(relayId) !== replacement) {
    return;
  }
  const bridge = options?.expectedBridge ?? relayBridges.get(relayId);
  if (!bridge) {
    return;
  }
  if (relayBridges.get(relayId) === bridge) {
    relayBridges.delete(relayId);
  }
  if (replacement) {
    if (bridge.server.listening) {
      replacement.retired.add(bridge);
    } else {
      closeNativeHookRelayBridge(bridge);
    }
    return;
  }
  closeNativeHookRelayBridge(bridge);
  disposeNativeHookRelayBridgeReplacement(relayId, bridge.replacement);
}

/** Dispose only the replacement attempt that still owns this relay's cleanup. */
export function disposeNativeHookRelayBridgeReplacement(
  relayId: string,
  replacement: NativeHookRelayBridgeReplacement,
): void {
  if (relayBridgeReplacements.get(relayId) !== replacement) {
    return;
  }
  relayBridgeReplacements.delete(relayId);
  const bridge = relayBridges.get(relayId);
  if (bridge?.replacement === replacement) {
    relayBridges.delete(relayId);
    closeNativeHookRelayBridge(bridge);
  }
  for (const retired of replacement.retired) {
    closeNativeHookRelayBridge(retired);
  }
}

function closeNativeHookRelayBridge(bridge: NativeHookRelayBridgeRegistration): void {
  // Keep closing transports reachable until their connections drain. A late
  // canceled listen may reopen the server and must still be closed again.
  if (closingRelayBridges.has(bridge) && !bridge.server.listening) {
    return;
  }
  closingRelayBridges.add(bridge);
  clearTimeout(bridge.closeTimer);
  bridge.closeTimer = undefined;
  try {
    deleteNativeHookRelayBridgeRecordIfOwned({ ...bridge, pid: process.pid });
  } catch (error) {
    log.debug("failed to remove native hook relay bridge record", {
      error,
      relayId: bridge.relayId,
    });
  }
  bridge.server.close(() => {
    bridge.replacement.retired.delete(bridge);
    closingRelayBridges.delete(bridge);
  });
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
        retryable: true,
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
        retryable: true,
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
  return (
    relays.get(auth.relayId) === auth.registration && relayBridges.get(auth.relayId) === auth.bridge
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
  for (const [relayId, replacement] of relayBridgeReplacements) {
    disposeNativeHookRelayBridgeReplacement(relayId, replacement);
  }
  for (const bridge of closingRelayBridges) {
    bridge.server.closeAllConnections();
    closeNativeHookRelayBridge(bridge);
  }
  clearNativeHookRelayBridgeRecordsForTests();
}
