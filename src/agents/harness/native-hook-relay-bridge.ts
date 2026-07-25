import { randomUUID } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { toErrorObject } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { DEFAULT_RELAY_TIMEOUT_MS } from "./native-hook-relay-command.js";
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
  InvokeNativeHookRelayBridgeParams,
  InvokeNativeHookRelayParams,
  NativeHookRelayBridgeRegistration,
  NativeHookRelayProcessResponse,
  NativeHookRelayProvider,
} from "./native-hook-relay-types.js";
import {
  isJsonObject,
  normalizePositiveInteger,
  readNativeHookRelayEvent,
  readNativeHookRelayProvider,
  readNonEmptyString,
} from "./native-hook-relay-utils.js";

const MAX_NATIVE_HOOK_BRIDGE_BODY_BYTES = 5_000_000;
const MAX_NATIVE_HOOK_BRIDGE_RESPONSE_BYTES = 5_000_000;
const NATIVE_HOOK_BRIDGE_RETRY_INTERVAL_MS = 25;
export const NATIVE_HOOK_BRIDGE_REPLACEMENT_RECORD_GRACE_MS = 250;
export const NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR =
  "native hook relay bridge stale registration";
const log = createSubsystemLogger("agents/harness/native-hook-relay");

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

function isNativeHookRelayBridgePidDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
  }
}

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
      isPidDead: isNativeHookRelayBridgePidDead,
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
  options?: { deferBridgeRecordRemovalMs?: number },
): void {
  const bridge = relayBridges.get(relayId);
  if (!bridge) {
    return;
  }
  relayBridges.delete(relayId);
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

function readNativeHookRelayBridgeRecord(
  relayId: string,
  stateDbPath?: string,
): NativeHookRelayBridgeRecord {
  const record = readNativeHookRelayBridgeRecordIfExists(relayId, stateDbPath);
  if (!record) {
    throw new Error("native hook relay bridge not found");
  }
  return record;
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

export async function invokeNativeHookRelayBridge(
  params: InvokeNativeHookRelayBridgeParams,
): Promise<NativeHookRelayProcessResponse> {
  const provider = readNativeHookRelayProvider(params.provider);
  const relayId = readNonEmptyString(params.relayId, "relayId");
  const event = readNativeHookRelayEvent(params.event);
  const timeoutMs = normalizePositiveInteger(params.timeoutMs, DEFAULT_RELAY_TIMEOUT_MS);
  const registrationTimeoutMs = normalizePositiveInteger(params.registrationTimeoutMs, timeoutMs);
  const startedAt = Date.now();
  let lastError: unknown = new Error("native hook relay bridge not found");
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const record = readNativeHookRelayBridgeRecord(relayId, params.stateDbPath);
      if (Date.now() > record.expiresAtMs) {
        throw new Error("native hook relay bridge expired");
      }
      return await postNativeHookRelayBridgeRecord({
        record,
        timeoutMs: Math.max(1, timeoutMs - (Date.now() - startedAt)),
        payload: {
          provider,
          relayId,
          event,
          generation: params.generation,
          rawPayload: params.rawPayload,
        },
      });
    } catch (error) {
      lastError = error;
      if (
        error instanceof Error &&
        error.message === "native hook relay bridge not found" &&
        Date.now() - startedAt >= registrationTimeoutMs
      ) {
        break;
      }
      if (
        !isRetryableNativeHookRelayBridgeLookupError({
          error,
          elapsedMs: Date.now() - startedAt,
        })
      ) {
        break;
      }
      await delay(
        Math.min(NATIVE_HOOK_BRIDGE_RETRY_INTERVAL_MS, timeoutMs - (Date.now() - startedAt)),
      );
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function postNativeHookRelayBridgeRecord(params: {
  record: NativeHookRelayBridgeRecord;
  timeoutMs: number;
  payload: InvokeNativeHookRelayParams;
}): Promise<NativeHookRelayProcessResponse> {
  const body = JSON.stringify(params.payload);
  return new Promise((resolve, reject) => {
    let settled = false;
    const resolveOnce = (value: NativeHookRelayProcessResponse) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const rejectOnce = (error: unknown) => {
      if (!settled) {
        settled = true;
        reject(toErrorObject(error, "Non-Error rejection"));
      }
    };
    const req = httpRequest(
      {
        hostname: params.record.hostname,
        method: "POST",
        path: "/invoke",
        port: params.record.port,
        timeout: params.timeoutMs,
        headers: {
          authorization: `Bearer ${params.record.token}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let responseText = "";
        let responseBytes = 0;
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          const chunkText = typeof chunk === "string" ? chunk : String(chunk);
          responseBytes += Buffer.byteLength(chunkText);
          if (responseBytes > MAX_NATIVE_HOOK_BRIDGE_RESPONSE_BYTES) {
            rejectOnce(new Error("native hook relay bridge response too large"));
            res.destroy();
            return;
          }
          responseText += chunkText;
        });
        res.on("error", rejectOnce);
        res.on("end", () => {
          if (settled) {
            return;
          }
          try {
            const parsed = JSON.parse(responseText) as
              | { ok: true; result: NativeHookRelayProcessResponse }
              | { ok: false; error?: string };
            if (parsed.ok) {
              resolveOnce(parsed.result);
              return;
            }
            rejectOnce(new Error(parsed.error || "native hook relay bridge failed"));
          } catch (error) {
            rejectOnce(error);
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("native hook relay bridge timed out"));
    });
    req.on("error", rejectOnce);
    req.end(body);
  });
}

function isRetryableNativeHookRelayBridgeError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === "ENOENT" ||
    code === "ECONNREFUSED" ||
    code === "EAGAIN" ||
    (error instanceof Error && error.message === "native hook relay bridge not found")
  );
}

export function isRetryableNativeHookRelayBridgeLookupError(params: {
  error: unknown;
  elapsedMs: number;
}): boolean {
  return (
    isRetryableNativeHookRelayBridgeError(params.error) ||
    (params.elapsedMs < NATIVE_HOOK_BRIDGE_REPLACEMENT_RECORD_GRACE_MS &&
      isNativeHookRelayBridgeStaleRegistrationError(params.error))
  );
}

export function isNativeHookRelayBridgeStaleRegistrationError(error: unknown): boolean {
  return (
    error instanceof Error && error.message === NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

export function clearNativeHookRelayBridgesForTests(): void {
  for (const relayId of relayBridges.keys()) {
    unregisterNativeHookRelayBridge(relayId);
  }
  clearNativeHookRelayBridgeRecordsForTests();
}
