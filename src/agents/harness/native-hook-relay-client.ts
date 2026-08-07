// Cold-process client for invoking the local native hook relay bridge.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

const DEFAULT_RELAY_TIMEOUT_MS = 5_000;
const MAX_NATIVE_HOOK_BRIDGE_RESPONSE_BYTES = 5_000_000;
const NATIVE_HOOK_BRIDGE_RETRY_INTERVAL_MS = 25;
export const NATIVE_HOOK_BRIDGE_REPLACEMENT_RECORD_GRACE_MS = 250;
export const NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR =
  "native hook relay bridge stale registration";

type NativeHookRelayEvent =
  | "pre_tool_use"
  | "post_tool_use"
  | "permission_request"
  | "before_agent_finalize";

export type NativeHookRelayProcessResponse = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

type NativeHookRelayBridgeRecord = {
  version: 1;
  relayId: string;
  pid: number;
  hostname: "127.0.0.1";
  port: number;
  token: string;
  expiresAtMs: number;
};

type InvokeNativeHookRelayBridgeParams = {
  provider: unknown;
  relayId: unknown;
  generation?: unknown;
  event: unknown;
  rawPayload: unknown;
  registrationTimeoutMs?: number;
  timeoutMs?: number;
};

/** Invoke a registered relay without loading the Gateway or harness runtime. */
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
      const record = readNativeHookRelayBridgeRecord(relayId);
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
  throw toError(lastError);
}

/** Render the Codex response used when neither local relay transport is available. */
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
    if (params.preToolUseUnavailable === "noop") {
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    return {
      stdout: `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: message,
        },
      })}\n`,
      stderr: "",
      exitCode: 0,
    };
  }
  if (event === "permission_request") {
    return {
      stdout: `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: { behavior: "deny", message },
        },
      })}\n`,
      stderr: "",
      exitCode: 0,
    };
  }
  return { stdout: "", stderr: "", exitCode: 0 };
}

export function isNativeHookRelayBridgeStaleRegistrationError(error: unknown): boolean {
  return (
    error instanceof Error && error.message === NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR
  );
}

function readNativeHookRelayBridgeRecord(relayId: string): NativeHookRelayBridgeRecord {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(nativeHookRelayBridgeRegistryPath(relayId), "utf8"),
    );
    if (isNativeHookRelayBridgeRecord(parsed, relayId)) {
      return parsed;
    }
  } catch {
    // A relay process may be replacing its short-lived local registration.
  }
  throw new Error("native hook relay bridge not found");
}

function isNativeHookRelayBridgeRecord(
  value: unknown,
  relayId: string,
): value is NativeHookRelayBridgeRecord {
  return (
    isJsonObject(value) &&
    value.version === 1 &&
    value.relayId === relayId &&
    typeof value.pid === "number" &&
    Number.isInteger(value.pid) &&
    value.hostname === "127.0.0.1" &&
    typeof value.port === "number" &&
    Number.isInteger(value.port) &&
    value.port > 0 &&
    value.port <= 65_535 &&
    typeof value.token === "string" &&
    value.token.length > 0 &&
    typeof value.expiresAtMs === "number"
  );
}

function postNativeHookRelayBridgeRecord(params: {
  record: NativeHookRelayBridgeRecord;
  timeoutMs: number;
  payload: {
    provider: "codex";
    relayId: string;
    generation?: unknown;
    event: NativeHookRelayEvent;
    rawPayload: unknown;
  };
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
        reject(toError(error));
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
    req.on("timeout", () => req.destroy(new Error("native hook relay bridge timed out")));
    req.on("error", rejectOnce);
    req.end(body);
  });
}

function isRetryableNativeHookRelayBridgeLookupError(params: {
  error: unknown;
  elapsedMs: number;
}): boolean {
  const code = (params.error as NodeJS.ErrnoException).code;
  return (
    code === "ENOENT" ||
    code === "ECONNREFUSED" ||
    code === "EAGAIN" ||
    (params.error instanceof Error &&
      params.error.message === "native hook relay bridge not found") ||
    (params.elapsedMs < NATIVE_HOOK_BRIDGE_REPLACEMENT_RECORD_GRACE_MS &&
      isNativeHookRelayBridgeStaleRegistrationError(params.error))
  );
}

function nativeHookRelayBridgeRegistryPath(relayId: string): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : "nouid";
  const key = createHash("sha256").update(relayId).digest("hex").slice(0, 32);
  return path.join(tmpdir(), `openclaw-native-hook-relays-${uid}`, `${key}.json`);
}

function readNativeHookRelayProvider(value: unknown): "codex" {
  if (value !== "codex") {
    throw new Error("native hook relay provider is not supported");
  }
  return value;
}

function readNativeHookRelayEvent(value: unknown): NativeHookRelayEvent {
  if (
    value === "pre_tool_use" ||
    value === "post_tool_use" ||
    value === "permission_request" ||
    value === "before_agent_finalize"
  ) {
    return value;
  }
  throw new Error("native hook relay event is not supported");
}

function readNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be non-empty string`);
  }
  return value.trim();
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}
