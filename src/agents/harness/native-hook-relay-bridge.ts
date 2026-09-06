import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { isPidDefinitelyDead } from "../../shared/pid-alive.js";
import {
  isNativeHookRelayBridgeStaleRegistrationError,
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
  NATIVE_HOOK_BRIDGE_REPLACEMENT_RECORD_GRACE_MS,
  NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR,
} from "./native-hook-relay-client.js";

const { relays, relayBridges } = nativeHookRelayState;

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

export function registerNativeHookRelayBridge(
  registration: ActiveNativeHookRelayRegistration,
  stateDbPath: string,
  invokeRelay: InvokeNativeHookRelay,
): void {
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
  unregisterNativeHookRelayBridge(registration.relayId);
  const token = randomUUID();
  const server = createServer();
  const bridge: NativeHookRelayBridgeRegistration = {
    relayId: registration.relayId,
    stateDbPath,
    token,
    server,
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
  });
  server.listen(0, "127.0.0.1", () => {
    if (relayBridges.get(registration.relayId) !== bridge) {
      return;
    }
    try {
      writeNativeHookRelayBridgeRecordForRegistration(registration, bridge);
    } catch (error) {
      log.debug("failed to publish native hook relay bridge record", {
        error,
        relayId: registration.relayId,
      });
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
    return;
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
  for (const relayId of relayBridges.keys()) {
    unregisterNativeHookRelayBridge(relayId);
  }
  clearNativeHookRelayBridgeRecordsForTests();
}
