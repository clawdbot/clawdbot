import { request as httpRequest } from "node:http";
import { toErrorObject } from "../../infra/errors.js";
import { readNativeHookRelayClientBridgeRecord } from "./native-hook-relay-client-store.js";
import { DEFAULT_RELAY_TIMEOUT_MS } from "./native-hook-relay-constants.js";
import { codexNativeHookRelayResponseCodec } from "./native-hook-relay-response-codec.js";
import type {
  InvokeNativeHookRelayBridgeParams,
  InvokeNativeHookRelayParams,
  NativeHookRelayProcessResponse,
} from "./native-hook-relay-types.js";
import {
  normalizePositiveInteger,
  readNativeHookRelayEvent,
  readNativeHookRelayProvider,
  readNonEmptyString,
} from "./native-hook-relay-utils.js";

const MAX_NATIVE_HOOK_BRIDGE_RESPONSE_BYTES = 5_000_000;
const NATIVE_HOOK_BRIDGE_RETRY_INTERVAL_MS = 25;
export const NATIVE_HOOK_BRIDGE_REPLACEMENT_RECORD_GRACE_MS = 250;
export const NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR =
  "native hook relay bridge stale registration";

/** Invoke a registered native relay through its read-only SQLite locator. */
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
      const record = readNativeHookRelayClientBridgeRecord({
        relayId,
        stateDbPath: params.stateDbPath,
      });
      if (!record) {
        throw new Error("native hook relay bridge not found");
      }
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
      const elapsedMs = Date.now() - startedAt;
      if (
        error instanceof Error &&
        error.message === "native hook relay bridge not found" &&
        elapsedMs >= registrationTimeoutMs
      ) {
        break;
      }
      if (!isRetryableNativeHookRelayBridgeLookupError({ error, elapsedMs })) {
        break;
      }
      await delay(Math.min(NATIVE_HOOK_BRIDGE_RETRY_INTERVAL_MS, timeoutMs - elapsedMs));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function postNativeHookRelayBridgeRecord(params: {
  record: {
    hostname: "127.0.0.1";
    port: number;
    token: string;
  };
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

/** Detect a stale locator response that must not fall back to the Gateway. */
export function isNativeHookRelayBridgeStaleRegistrationError(error: unknown): boolean {
  return (
    error instanceof Error && error.message === NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR
  );
}

/** Render the provider response used when both relay transports are unavailable. */
export function renderNativeHookRelayUnavailableResponse(params: {
  provider: unknown;
  event: unknown;
  preToolUseUnavailable?: unknown;
  message?: string;
}): NativeHookRelayProcessResponse {
  readNativeHookRelayProvider(params.provider);
  const event = readNativeHookRelayEvent(params.event);
  const message = params.message?.trim() || "Native hook relay unavailable";
  if (event === "pre_tool_use") {
    // The cold CLI cannot reconstruct relay policy after lookup fails. Fail
    // closed unless the generated command recorded that no local policy exists.
    if (params.preToolUseUnavailable === "noop") {
      return codexNativeHookRelayResponseCodec.renderNoopResponse();
    }
    return codexNativeHookRelayResponseCodec.renderPreToolUseBlockResponse(message);
  }
  if (event === "permission_request") {
    return codexNativeHookRelayResponseCodec.renderPermissionDecisionResponse("deny", message);
  }
  return codexNativeHookRelayResponseCodec.renderNoopResponse();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}
