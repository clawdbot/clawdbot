import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveOpenClawPackageRootSync } from "../../infra/openclaw-root.js";
import { privateFileStoreSync } from "../../infra/private-file-store.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { PluginApprovalResolutions } from "../../plugins/types.js";
import { runBeforeToolCallHook } from "../pi-tools.before-tool-call.js";
import { normalizeToolName } from "../tool-policy.js";
import { callGatewayTool } from "../tools/gateway.js";
import { runAgentHarnessAfterToolCallHook } from "./hook-helpers.js";
import { runAgentHarnessBeforeAgentFinalizeHook } from "./lifecycle-hook-helpers.js";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

const NATIVE_HOOK_RELAY_EVENTS = [
  "pre_tool_use",
  "post_tool_use",
  "permission_request",
  "before_agent_finalize",
] as const;

const NATIVE_HOOK_RELAY_PROVIDERS = ["codex"] as const;

export type NativeHookRelayEvent = (typeof NATIVE_HOOK_RELAY_EVENTS)[number];
export type NativeHookRelayProvider = (typeof NATIVE_HOOK_RELAY_PROVIDERS)[number];

export type NativeHookRelayInvocation = {
  provider: NativeHookRelayProvider;
  relayId: string;
  event: NativeHookRelayEvent;
  nativeEventName?: string;
  agentId?: string;
  sessionId: string;
  sessionKey?: string;
  runId: string;
  cwd?: string;
  model?: string;
  turnId?: string;
  transcriptPath?: string;
  permissionMode?: string;
  stopHookActive?: boolean;
  lastAssistantMessage?: string;
  toolName?: string;
  toolUseId?: string;
  rawPayload: JsonValue;
  receivedAt: string;
};

export type NativeHookRelayProcessResponse = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type NativeHookRelayRegistration = {
  relayId: string;
  provider: NativeHookRelayProvider;
  agentId?: string;
  sessionId: string;
  sessionKey?: string;
  config?: OpenClawConfig;
  runId: string;
  allowedEvents: readonly NativeHookRelayEvent[];
  expiresAtMs: number;
  signal?: AbortSignal;
};

export type NativeHookRelayRegistrationHandle = NativeHookRelayRegistration & {
  commandForEvent: (event: NativeHookRelayEvent) => string;
  unregister: () => void;
};

export type RegisterNativeHookRelayParams = {
  provider: NativeHookRelayProvider;
  relayId?: string;
  agentId?: string;
  sessionId: string;
  sessionKey?: string;
  config?: OpenClawConfig;
  runId: string;
  allowedEvents?: readonly NativeHookRelayEvent[];
  ttlMs?: number;
  command?: NativeHookRelayCommandOptions;
  signal?: AbortSignal;
};

export type NativeHookRelayCommandOptions = {
  executable?: string;
  nodeExecutable?: string;
  timeoutMs?: number;
};

export type InvokeNativeHookRelayParams = {
  provider: unknown;
  relayId: unknown;
  event: unknown;
  rawPayload: unknown;
};

export type InvokeNativeHookRelayBridgeParams = InvokeNativeHookRelayParams & {
  registrationTimeoutMs?: number;
  timeoutMs?: number;
};

type NativeHookRelayInvocationMetadata = Partial<
  Pick<
    NativeHookRelayInvocation,
    | "nativeEventName"
    | "cwd"
    | "model"
    | "turnId"
    | "transcriptPath"
    | "permissionMode"
    | "stopHookActive"
    | "lastAssistantMessage"
    | "toolName"
    | "toolUseId"
  >
>;

type NativeHookRelayProviderAdapter = {
  normalizeMetadata: (rawPayload: JsonValue) => NativeHookRelayInvocationMetadata;
  readToolInput: (rawPayload: JsonValue) => Record<string, JsonValue>;
  readToolResponse: (rawPayload: JsonValue) => unknown;
  renderNoopResponse: (event: NativeHookRelayEvent) => NativeHookRelayProcessResponse;
  renderPreToolUseBlockResponse: (reason: string) => NativeHookRelayProcessResponse;
  renderBeforeAgentFinalizeReviseResponse: (reason: string) => NativeHookRelayProcessResponse;
  renderBeforeAgentFinalizeStopResponse: (reason?: string) => NativeHookRelayProcessResponse;
  renderPermissionDecisionResponse: (
    decision: NativeHookRelayPermissionDecision,
    message?: string,
  ) => NativeHookRelayProcessResponse;
};

const DEFAULT_RELAY_TTL_MS = 30 * 60 * 1000;
const DEFAULT_RELAY_TIMEOUT_MS = 5_000;
const DEFAULT_PERMISSION_TIMEOUT_MS = 120_000;
const PERMISSION_ALLOW_ALWAYS_TTL_MS = 30 * 60 * 1000;
const MAX_NATIVE_HOOK_RELAY_INVOCATIONS = 200;
const MAX_NATIVE_HOOK_RELAY_JSON_DEPTH = 64;
const MAX_NATIVE_HOOK_RELAY_JSON_NODES = 20_000;
const MAX_NATIVE_HOOK_RELAY_STRING_LENGTH = 1_000_000;
const MAX_NATIVE_HOOK_RELAY_TOTAL_STRING_LENGTH = 4_000_000;
const MAX_NATIVE_HOOK_RELAY_HISTORY_STRING_LENGTH = 4_000;
const MAX_NATIVE_HOOK_RELAY_HISTORY_TOTAL_STRING_LENGTH = 20_000;
const MAX_NATIVE_HOOK_RELAY_HISTORY_ARRAY_ITEMS = 50;
const MAX_NATIVE_HOOK_RELAY_HISTORY_OBJECT_KEYS = 50;
const MAX_PERMISSION_FALLBACK_KEYS = 200;
const MAX_PERMISSION_FALLBACK_KEY_CHARS = 240;
const MAX_PERMISSION_FINGERPRINT_SORT_KEYS = 200;
const MAX_APPROVAL_TITLE_LENGTH = 80;
const MAX_APPROVAL_DESCRIPTION_LENGTH = 700;
const MAX_PERMISSION_APPROVALS_PER_WINDOW = 12;
const PERMISSION_APPROVAL_WINDOW_MS = 60_000;
const MAX_PERMISSION_ALLOW_ALWAYS_ENTRIES = 512;
const MAX_NATIVE_HOOK_BRIDGE_BODY_BYTES = 5_000_000;
const MAX_NATIVE_HOOK_BRIDGE_RESPONSE_BYTES = 5_000_000;
const NATIVE_HOOK_BRIDGE_RETRY_INTERVAL_MS = 25;
const ANSI_ESCAPE_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");
const relays = new Map<string, NativeHookRelayRegistration>();
const relayBridges = new Map<string, NativeHookRelayBridgeRegistration>();
const invocations: NativeHookRelayInvocation[] = [];
const pendingPermissionApprovals = new Map<
  string,
  Promise<NativeHookRelayPermissionApprovalResult>
>();
const permissionApprovalWindows = new Map<string, number[]>();
const permissionAllowAlwaysApprovals = new Map<string, { expiresAtMs: number }>();
const log = createSubsystemLogger("agents/harness/native-hook-relay");

type NativeHookRelayPermissionDecision = "allow" | "deny";

type NativeHookRelayPermissionApprovalResult =
  | NativeHookRelayPermissionDecision
  | "allow-always"
  | "defer";

type NativeHookRelayPermissionApprovalRequest = {
  provider: NativeHookRelayProvider;
  agentId?: string;
  sessionId: string;
  sessionKey?: string;
  runId: string;
  toolName: string;
  toolCallId?: string;
  cwd?: string;
  model?: string;
  toolInput: Record<string, JsonValue>;
  signal?: AbortSignal;
};

type NativeHookRelayPermissionApprovalRequester = (
  request: NativeHookRelayPermissionApprovalRequest,
) => Promise<NativeHookRelayPermissionApprovalResult>;

type NativeHookRelayBridgeRegistration = {
  relayId: string;
  registryPath: string;
  token: string;
  server: Server;
};

type NativeHookRelayBridgeRecord = {
  version: 1;
  relayId: string;
  pid: number;
  hostname: string;
  port: number;
  token: string;
  expiresAtMs: number;
};

let nativeHookRelayPermissionApprovalRequester: NativeHookRelayPermissionApprovalRequester =
  requestNativeHookRelayPermissionApproval;

const nativeHookRelayProviderAdapters: Record<
  NativeHookRelayProvider,
  NativeHookRelayProviderAdapter
> = {
  codex: {
    normalizeMetadata: normalizeCodexHookMetadata,
    readToolInput: readCodexToolInput,
    readToolResponse: readCodexToolResponse,
    renderNoopResponse: () => {
      // Codex treats empty stdout plus exit 0 as no decision/no additional context.
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    renderPreToolUseBlockResponse: (reason) => ({
      stdout: `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      })}\n`,
      stderr: "",
      exitCode: 0,
    }),
    renderBeforeAgentFinalizeReviseResponse: (reason) => ({
      stdout: `${JSON.stringify({
        decision: "block",
        reason,
      })}\n`,
      stderr: "",
      exitCode: 0,
    }),
    renderBeforeAgentFinalizeStopResponse: (reason) => ({
      stdout: `${JSON.stringify({
        continue: false,
        ...(reason?.trim() ? { stopReason: reason.trim() } : {}),
      })}\n`,
      stderr: "",
      exitCode: 0,
    }),
    renderPermissionDecisionResponse: (decision, message) => ({
      stdout: `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision:
            decision === "allow"
              ? { behavior: "allow" }
              : {
                  behavior: "deny",
                  message: message?.trim() || "Denied by OpenClaw",
                },
        },
      })}\n`,
      stderr: "",
      exitCode: 0,
    }),
  },
};

export function registerNativeHookRelay(
  params: RegisterNativeHookRelayParams,
): NativeHookRelayRegistrationHandle {
  pruneExpiredNativeHookRelays();
  pruneNativeHookRelayPermissionAllowAlways();
  const relayId = normalizeRelayId(params.relayId) ?? randomUUID();
  const allowedEvents = normalizeAllowedEvents(params.allowedEvents);
  unregisterNativeHookRelay(relayId);
  const registration: NativeHookRelayRegistration = {
    relayId,
    provider: params.provider,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionId: params.sessionId,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(params.config ? { config: params.config } : {}),
    runId: params.runId,
    allowedEvents,
    expiresAtMs: Date.now() + normalizePositiveInteger(params.ttlMs, DEFAULT_RELAY_TTL_MS),
    ...(params.signal ? { signal: params.signal } : {}),
  };
  relays.set(relayId, registration);
  registerNativeHookRelayBridge(registration);
  return {
    ...registration,
    commandForEvent: (event) =>
      buildNativeHookRelayCommand({
        provider: params.provider,
        relayId,
        event,
        timeoutMs: params.command?.timeoutMs,
        executable: params.command?.executable,
        nodeExecutable: params.command?.nodeExecutable,
      }),
    unregister: () => unregisterNativeHookRelay(relayId),
  };
}

function unregisterNativeHookRelay(relayId: string): void {
  unregisterNativeHookRelayBridge(relayId);
  relays.delete(relayId);
  removeNativeHookRelayInvocations(relayId);
  removeNativeHookRelayPermissionState(relayId);
}

function normalizeRelayId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length > 160 || !/^[A-Za-z0-9._:-]+$/u.test(trimmed)) {
    throw new Error("native hook relay id must be non-empty, compact, and URL-safe");
  }
  return trimmed;
}

export function buildNativeHookRelayCommand(params: {
  provider: NativeHookRelayProvider;
  relayId: string;
  event: NativeHookRelayEvent;
  timeoutMs?: number;
  executable?: string;
  nodeExecutable?: string;
}): string {
  const timeoutMs = normalizePositiveInteger(params.timeoutMs, DEFAULT_RELAY_TIMEOUT_MS);
  const executable = params.executable ?? resolveOpenClawCliExecutable();
  const argv =
    executable === "openclaw"
      ? ["openclaw"]
      : [params.nodeExecutable ?? process.execPath, executable];
  return shellQuoteArgs([
    ...argv,
    "hooks",
    "relay",
    "--provider",
    params.provider,
    "--relay-id",
    params.relayId,
    "--event",
    params.event,
    "--timeout",
    String(timeoutMs),
  ]);
}

export async function invokeNativeHookRelay(
  params: InvokeNativeHookRelayParams,
): Promise<NativeHookRelayProcessResponse> {
  const provider = readNativeHookRelayProvider(params.provider);
  const relayId = readNonEmptyString(params.relayId, "relayId");
  const event = readNativeHookRelayEvent(params.event);
  const registration = relays.get(relayId);
  if (!registration) {
    pruneExpiredNativeHookRelays();
    throw new Error("native hook relay not found");
  }
  if (Date.now() > registration.expiresAtMs) {
    relays.delete(relayId);
    removeNativeHookRelayInvocations(relayId);
    throw new Error("native hook relay expired");
  }
  if (registration.provider !== provider) {
    throw new Error("native hook relay provider mismatch");
  }
  if (!registration.allowedEvents.includes(event)) {
    throw new Error("native hook relay event not allowed");
  }
  if (!isJsonValue(params.rawPayload)) {
    throw new Error("native hook relay payload must be JSON-compatible");
  }

  const normalized = normalizeNativeHookInvocation({
    registration,
    event,
    rawPayload: params.rawPayload,
  });
  recordNativeHookRelayInvocation(normalized);
  return processNativeHookRelayInvocation({
    registration,
    invocation: normalized,
    adapter: getNativeHookRelayProviderAdapter(provider),
  });
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
      const record = readNativeHookRelayBridgeRecord(relayId);
      if (Date.now() > record.expiresAtMs) {
        throw new Error("native hook relay bridge expired");
      }
      return await invokeNativeHookRelayBridgeRecord({
        record,
        timeoutMs: Math.max(1, timeoutMs - (Date.now() - startedAt)),
        payload: {
          provider,
          relayId,
          event,
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
      if (!isRetryableNativeHookRelayBridgeError(error)) {
        break;
      }
      await delay(
        Math.min(NATIVE_HOOK_BRIDGE_RETRY_INTERVAL_MS, timeoutMs - (Date.now() - startedAt)),
      );
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function renderNativeHookRelayUnavailableResponse(params: {
  provider: unknown;
  event: unknown;
  message?: string;
}): NativeHookRelayProcessResponse {
  const provider = readNativeHookRelayProvider(params.provider);
  const event = readNativeHookRelayEvent(params.event);
  const adapter = getNativeHookRelayProviderAdapter(provider);
  const message = params.message?.trim() || "Native hook relay unavailable";
  if (event === "pre_tool_use") {
    return adapter.renderPreToolUseBlockResponse(message);
  }
  if (event === "permission_request") {
    return adapter.renderPermissionDecisionResponse("deny", message);
  }
  return adapter.renderNoopResponse(event);
}

function recordNativeHookRelayInvocation(invocation: NativeHookRelayInvocation): void {
  invocations.push({
    ...invocation,
    rawPayload: snapshotNativeHookRelayPayload(invocation.rawPayload),
  });
  if (invocations.length > MAX_NATIVE_HOOK_RELAY_INVOCATIONS) {
    invocations.splice(0, invocations.length - MAX_NATIVE_HOOK_RELAY_INVOCATIONS);
  }
}

function removeNativeHookRelayInvocations(relayId: string): void {
  for (let index = invocations.length - 1; index >= 0; index -= 1) {
    if (invocations[index]?.relayId === relayId) {
      invocations.splice(index, 1);
    }
  }
}

function pruneExpiredNativeHookRelays(now = Date.now()): void {
  for (const [relayId, registration] of relays) {
    if (now > registration.expiresAtMs) {
      relays.delete(relayId);
      unregisterNativeHookRelayBridge(relayId);
      removeNativeHookRelayInvocations(relayId);
    }
  }
}

function registerNativeHookRelayBridge(registration: NativeHookRelayRegistration): void {
  unregisterNativeHookRelayBridge(registration.relayId);
  const token = randomUUID();
  const bridgeDir = ensureNativeHookRelayBridgeDir();
  const bridgeKey = nativeHookRelayBridgeKey(registration.relayId);
  const registryPath = path.join(bridgeDir, `${bridgeKey}.json`);
  const server = createServer((req, res) => {
    void handleNativeHookRelayBridgeRequest(req, res, {
      provider: registration.provider,
      relayId: registration.relayId,
      token,
    });
  });
  const bridge: NativeHookRelayBridgeRegistration = {
    relayId: registration.relayId,
    registryPath,
    token,
    server,
  };
  relayBridges.set(registration.relayId, bridge);
  server.on("error", (error) => {
    log.debug("native hook relay bridge server error", { error, relayId: registration.relayId });
  });
  server.listen(0, "127.0.0.1", () => {
    if (relayBridges.get(registration.relayId) !== bridge) {
      return;
    }
    const address = server.address();
    if (!address || typeof address === "string") {
      log.debug("native hook relay bridge server address unavailable", {
        relayId: registration.relayId,
      });
      return;
    }
    const record: NativeHookRelayBridgeRecord = {
      version: 1,
      relayId: registration.relayId,
      pid: process.pid,
      hostname: "127.0.0.1",
      port: address.port,
      token,
      expiresAtMs: registration.expiresAtMs,
    };
    writeNativeHookRelayBridgeRecord(registryPath, record);
  });
  server.unref();
}

function unregisterNativeHookRelayBridge(relayId: string): void {
  const bridge = relayBridges.get(relayId);
  if (!bridge) {
    return;
  }
  relayBridges.delete(relayId);
  bridge.server.close();
  const record = readNativeHookRelayBridgeRecordIfExists(relayId);
  if (record?.token === bridge.token) {
    rmSync(bridge.registryPath, { force: true });
  }
}

async function handleNativeHookRelayBridgeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  auth: { provider: NativeHookRelayProvider; relayId: string; token: string },
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
    const body = await readNativeHookRelayBridgeBody(req);
    const payload = readNativeHookRelayBridgePayload(JSON.parse(body));
    if (payload.provider !== auth.provider || payload.relayId !== auth.relayId) {
      writeNativeHookRelayBridgeJson(res, 403, {
        ok: false,
        error: "native hook relay bridge target mismatch",
      });
      return;
    }
    const result = await invokeNativeHookRelay(payload);
    writeNativeHookRelayBridgeJson(res, 200, { ok: true, result });
  } catch (error) {
    writeNativeHookRelayBridgeJson(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
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

function readNativeHookRelayBridgeRecord(relayId: string): NativeHookRelayBridgeRecord {
  const record = readNativeHookRelayBridgeRecordIfExists(relayId);
  if (!record) {
    throw new Error("native hook relay bridge not found");
  }
  return record;
}

function readNativeHookRelayBridgeRecordIfExists(
  relayId: string,
): NativeHookRelayBridgeRecord | undefined {
  const registryPath = nativeHookRelayBridgeRegistryPath(relayId);
  try {
    const parsed: unknown = JSON.parse(readFileSync(registryPath, "utf8"));
    if (isNativeHookRelayBridgeRecord(parsed, relayId)) {
      return parsed;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      log.debug("failed to read native hook relay bridge registry", { error, relayId });
    }
  }
  return undefined;
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

async function invokeNativeHookRelayBridgeRecord(params: {
  record: NativeHookRelayBridgeRecord;
  timeoutMs: number;
  payload: InvokeNativeHookRelayParams;
}): Promise<NativeHookRelayProcessResponse> {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < params.timeoutMs) {
    try {
      return await postNativeHookRelayBridgeRecord({
        ...params,
        timeoutMs: Math.max(1, params.timeoutMs - (Date.now() - startedAt)),
      });
    } catch (error) {
      lastError = error;
      if (!isRetryableNativeHookRelayBridgeError(error)) {
        break;
      }
      await delay(
        Math.min(NATIVE_HOOK_BRIDGE_RETRY_INTERVAL_MS, params.timeoutMs - (Date.now() - startedAt)),
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
        reject(error);
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

function nativeHookRelayBridgeDir(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : "nouid";
  return path.join(tmpdir(), `openclaw-native-hook-relays-${uid}`);
}

function ensureNativeHookRelayBridgeDir(): string {
  const bridgeDir = nativeHookRelayBridgeDir();
  mkdirSync(bridgeDir, { recursive: true, mode: 0o700 });
  const stats = lstatSync(bridgeDir);
  const expectedUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("unsafe native hook relay bridge directory");
  }
  if (expectedUid !== undefined && stats.uid !== expectedUid) {
    throw new Error("unsafe native hook relay bridge directory owner");
  }
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
    chmodSync(bridgeDir, 0o700);
    const repaired = lstatSync(bridgeDir);
    if ((repaired.mode & 0o077) !== 0) {
      throw new Error("unsafe native hook relay bridge directory permissions");
    }
  }
  return bridgeDir;
}

function writeNativeHookRelayBridgeRecord(
  registryPath: string,
  record: NativeHookRelayBridgeRecord,
): void {
  privateFileStoreSync(path.dirname(registryPath)).writeText(
    path.basename(registryPath),
    `${JSON.stringify(record)}\n`,
  );
}

function nativeHookRelayBridgeRegistryPath(relayId: string): string {
  return path.join(nativeHookRelayBridgeDir(), `${nativeHookRelayBridgeKey(relayId)}.json`);
}

function nativeHookRelayBridgeKey(relayId: string): string {
  return createHash("sha256").update(relayId).digest("hex").slice(0, 32);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

async function processNativeHookRelayInvocation(params: {
  registration: NativeHookRelayRegistration;
  invocation: NativeHookRelayInvocation;
  adapter: NativeHookRelayProviderAdapter;
}): Promise<NativeHookRelayProcessResponse> {
  if (params.invocation.event === "pre_tool_use") {
    return runNativeHookRelayPreToolUse(params);
  }
  if (params.invocation.event === "post_tool_use") {
    return runNativeHookRelayPostToolUse(params);
  }
  if (params.invocation.event === "before_agent_finalize") {
    return runNativeHookRelayBeforeAgentFinalize(params);
  }
  return runNativeHookRelayPermissionRequest(params);
}

async function runNativeHookRelayPreToolUse(params: {
  registration: NativeHookRelayRegistration;
  invocation: NativeHookRelayInvocation;
  adapter: NativeHookRelayProviderAdapter;
}): Promise<NativeHookRelayProcessResponse> {
  const toolName = normalizeNativeHookToolName(params.invocation.toolName);
  const toolInput = params.adapter.readToolInput(params.invocation.rawPayload);
  const outcome = await runBeforeToolCallHook({
    toolName,
    params: toolInput,
    ...(params.invocation.toolUseId ? { toolCallId: params.invocation.toolUseId } : {}),
    signal: params.registration.signal,
    ctx: {
      ...(params.registration.agentId ? { agentId: params.registration.agentId } : {}),
      sessionId: params.registration.sessionId,
      ...(params.registration.sessionKey ? { sessionKey: params.registration.sessionKey } : {}),
      ...(params.registration.config ? { config: params.registration.config } : {}),
      runId: params.registration.runId,
      ...(params.invocation.cwd ? { cwd: params.invocation.cwd } : {}),
    },
  });
  if (outcome.blocked) {
    return params.adapter.renderPreToolUseBlockResponse(outcome.reason);
  }
  // Codex PreToolUse supports block/allow, not argument mutation. If an
  // OpenClaw plugin returns adjusted params here, we intentionally ignore them.
  return params.adapter.renderNoopResponse(params.invocation.event);
}

async function runNativeHookRelayPostToolUse(params: {
  registration: NativeHookRelayRegistration;
  invocation: NativeHookRelayInvocation;
  adapter: NativeHookRelayProviderAdapter;
}): Promise<NativeHookRelayProcessResponse> {
  const toolName = normalizeNativeHookToolName(params.invocation.toolName);
  const toolCallId =
    params.invocation.toolUseId ?? `${params.invocation.event}:${params.invocation.receivedAt}`;
  await runAgentHarnessAfterToolCallHook({
    toolName,
    toolCallId,
    runId: params.registration.runId,
    ...(params.registration.agentId ? { agentId: params.registration.agentId } : {}),
    sessionId: params.registration.sessionId,
    ...(params.registration.sessionKey ? { sessionKey: params.registration.sessionKey } : {}),
    startArgs: params.adapter.readToolInput(params.invocation.rawPayload),
    result: params.adapter.readToolResponse(params.invocation.rawPayload),
  });
  return params.adapter.renderNoopResponse(params.invocation.event);
}

async function runNativeHookRelayPermissionRequest(params: {
  registration: NativeHookRelayRegistration;
  invocation: NativeHookRelayInvocation;
  adapter: NativeHookRelayProviderAdapter;
}): Promise<NativeHookRelayProcessResponse> {
  const request: NativeHookRelayPermissionApprovalRequest = {
    provider: params.registration.provider,
    ...(params.registration.agentId ? { agentId: params.registration.agentId } : {}),
    sessionId: params.registration.sessionId,
    ...(params.registration.sessionKey ? { sessionKey: params.registration.sessionKey } : {}),
    runId: params.registration.runId,
    toolName: normalizeNativeHookToolName(params.invocation.toolName),
    ...(params.invocation.toolUseId ? { toolCallId: params.invocation.toolUseId } : {}),
    ...(params.invocation.cwd ? { cwd: params.invocation.cwd } : {}),
    ...(params.invocation.model ? { model: params.invocation.model } : {}),
    toolInput: params.adapter.readToolInput(params.invocation.rawPayload),
    ...(params.registration.signal ? { signal: params.registration.signal } : {}),
  };
  const approvalKey = nativeHookRelayPermissionApprovalKey({
    registration: params.registration,
    request,
  });
  const allowAlwaysKey = nativeHookRelayPermissionAllowAlwaysKey({
    registration: params.registration,
    request,
  });
  if (hasNativeHookRelayPermissionAllowAlways(allowAlwaysKey)) {
    return params.adapter.renderPermissionDecisionResponse("allow");
  }
  const pendingApproval = pendingPermissionApprovals.get(approvalKey);
  try {
    const decision = await (pendingApproval ??
      startNativeHookRelayPermissionApprovalWithBudget({
        registration: params.registration,
        approvalKey,
        request,
      }));
    if (decision === "allow") {
      return params.adapter.renderPermissionDecisionResponse("allow");
    }
    if (decision === "allow-always") {
      rememberNativeHookRelayPermissionAllowAlways(allowAlwaysKey);
      return params.adapter.renderPermissionDecisionResponse("allow");
    }
    if (decision === "deny") {
      return params.adapter.renderPermissionDecisionResponse("deny", "Denied by user");
    }
  } catch (error) {
    log.warn(
      `native hook permission approval failed; deferring to provider approval path: ${String(error)}`,
    );
  }
  // A PermissionRequest no-op is not an allow decision. Codex interprets it as
  // "no hook decision" and falls through to its normal guardian/user approval path.
  return params.adapter.renderNoopResponse(params.invocation.event);
}

async function runNativeHookRelayBeforeAgentFinalize(params: {
  registration: NativeHookRelayRegistration;
  invocation: NativeHookRelayInvocation;
  adapter: NativeHookRelayProviderAdapter;
}): Promise<NativeHookRelayProcessResponse> {
  const outcome = await runAgentHarnessBeforeAgentFinalizeHook({
    event: {
      runId: params.registration.runId,
      sessionId: params.registration.sessionId,
      ...(params.registration.sessionKey ? { sessionKey: params.registration.sessionKey } : {}),
      ...(params.invocation.turnId ? { turnId: params.invocation.turnId } : {}),
      provider: params.registration.provider,
      ...(params.invocation.model ? { model: params.invocation.model } : {}),
      ...(params.invocation.cwd ? { cwd: params.invocation.cwd } : {}),
      ...(params.invocation.transcriptPath
        ? { transcriptPath: params.invocation.transcriptPath }
        : {}),
      stopHookActive: params.invocation.stopHookActive === true,
      ...(params.invocation.lastAssistantMessage
        ? { lastAssistantMessage: params.invocation.lastAssistantMessage }
        : {}),
    },
    ctx: {
      ...(params.registration.agentId ? { agentId: params.registration.agentId } : {}),
      sessionId: params.registration.sessionId,
      ...(params.registration.sessionKey ? { sessionKey: params.registration.sessionKey } : {}),
      runId: params.registration.runId,
      ...(params.invocation.cwd ? { workspaceDir: params.invocation.cwd } : {}),
      ...(params.invocation.model ? { modelId: params.invocation.model } : {}),
    },
  });
  if (outcome.action === "revise") {
    return params.adapter.renderBeforeAgentFinalizeReviseResponse(outcome.reason);
  }
  if (outcome.action === "finalize") {
    return params.adapter.renderBeforeAgentFinalizeStopResponse(outcome.reason);
  }
  return params.adapter.renderNoopResponse(params.invocation.event);
}

async function startNativeHookRelayPermissionApprovalWithBudget(params: {
  registration: NativeHookRelayRegistration;
  approvalKey: string;
  request: NativeHookRelayPermissionApprovalRequest;
}): Promise<NativeHookRelayPermissionApprovalResult> {
  if (!consumeNativeHookRelayPermissionBudget(params.registration.relayId)) {
    log.warn(
      `native hook permission approval rate limit exceeded; deferring to provider approval path: relay=${params.registration.relayId} run=${params.registration.runId}`,
    );
    return "defer";
  }
  const approval = nativeHookRelayPermissionApprovalRequester(params.request).finally(() => {
    pendingPermissionApprovals.delete(params.approvalKey);
  });
  pendingPermissionApprovals.set(params.approvalKey, approval);
  return approval;
}

function nativeHookRelayPermissionApprovalKey(params: {
  registration: NativeHookRelayRegistration;
  request: NativeHookRelayPermissionApprovalRequest;
}): string {
  return [
    params.registration.relayId,
    params.registration.runId,
    params.request.toolCallId
      ? `call:${params.request.toolCallId}`
      : permissionRequestFallbackKey(params.request),
    permissionRequestContentFingerprint(params.request),
  ].join(":");
}

function nativeHookRelayPermissionAllowAlwaysKey(params: {
  registration: NativeHookRelayRegistration;
  request: NativeHookRelayPermissionApprovalRequest;
}): string {
  const hash = createHash("sha256");
  hash.update("openclaw:native-hook-relay:permission-allow-always:v2");
  hash.update("\0");
  hash.update(params.registration.relayId);
  hash.update("\0");
  hash.update(params.request.provider);
  hash.update("\0");
  hash.update(params.request.agentId ?? "");
  hash.update("\0");
  hash.update(params.request.sessionKey ?? params.request.sessionId);
  hash.update("\0");
  hash.update(permissionRequestContentFingerprint(params.request));
  return hash.digest("hex");
}

function permissionRequestFallbackKey(request: NativeHookRelayPermissionApprovalRequest): string {
  const command = readOptionalString(request.toolInput.command);
  if (command) {
    return `${request.toolName}:command:${truncateText(command, 240)}`;
  }
  return `${request.toolName}:keys:${permissionRequestToolInputKeyFingerprint(request.toolInput)}`;
}

function permissionRequestToolInputKeyFingerprint(toolInput: Record<string, unknown>): string {
  let fingerprint = "";
  const { keys, truncated } = readBoundedOwnKeys(toolInput, MAX_PERMISSION_FALLBACK_KEYS);
  for (const key of keys) {
    const separator = fingerprint ? "," : "";
    const remaining = MAX_PERMISSION_FALLBACK_KEY_CHARS - fingerprint.length - separator.length;
    if (remaining <= 0) {
      break;
    }
    fingerprint += `${separator}${key.slice(0, remaining)}`;
  }
  if (truncated && fingerprint.length < MAX_PERMISSION_FALLBACK_KEY_CHARS) {
    const marker = `${fingerprint ? "," : ""}...`;
    fingerprint += marker.slice(0, MAX_PERMISSION_FALLBACK_KEY_CHARS - fingerprint.length);
  }
  return fingerprint || "none";
}

function permissionRequestContentFingerprint(
  request: NativeHookRelayPermissionApprovalRequest,
): string {
  const hash = createHash("sha256");
  hash.update(request.toolName);
  hash.update("\0");
  hash.update(request.cwd ?? "");
  hash.update("\0");
  updateJsonHash(hash, request.toolInput);
  return hash.digest("hex");
}

function updateJsonHash(hash: ReturnType<typeof createHash>, value: JsonValue): void {
  if (value === null) {
    hash.update("null");
    return;
  }
  if (typeof value === "string") {
    hash.update("string:");
    hash.update(JSON.stringify(value));
    return;
  }
  if (typeof value === "number") {
    hash.update(`number:${String(value)}`);
    return;
  }
  if (typeof value === "boolean") {
    hash.update(`boolean:${String(value)}`);
    return;
  }
  if (Array.isArray(value)) {
    hash.update("[");
    for (const item of value) {
      updateJsonHash(hash, item);
      hash.update(",");
    }
    hash.update("]");
    return;
  }
  hash.update("{");
  const { keys, truncated } = readBoundedOwnKeys(value, MAX_PERMISSION_FINGERPRINT_SORT_KEYS);
  for (const key of keys) {
    hash.update(JSON.stringify(key));
    hash.update(":");
    updateJsonHash(hash, value[key]);
    hash.update(",");
  }
  if (truncated) {
    // Keep ordinary objects order-independent without sorting a broad native
    // hook payload. The tail remains content-sensitive in traversal order.
    const sortedKeySet = new Set(keys);
    hash.update("#object-tail:");
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key) || sortedKeySet.has(key)) {
        continue;
      }
      hash.update(JSON.stringify(key));
      hash.update(":");
      updateJsonHash(hash, value[key]);
      hash.update(",");
    }
  }
  hash.update("}");
}

function readBoundedOwnKeys(
  value: Record<string, unknown>,
  maxKeys: number,
): { keys: string[]; truncated: boolean } {
  const keys: string[] = [];
  let truncated = false;
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      continue;
    }
    if (keys.length >= maxKeys) {
      truncated = true;
      break;
    }
    keys.push(key);
  }
  keys.sort();
  return { keys, truncated };
}

function consumeNativeHookRelayPermissionBudget(relayId: string, now = Date.now()): boolean {
  const windowStart = now - PERMISSION_APPROVAL_WINDOW_MS;
  const timestamps = (permissionApprovalWindows.get(relayId) ?? []).filter(
    (timestamp) => timestamp >= windowStart,
  );
  if (timestamps.length >= MAX_PERMISSION_APPROVALS_PER_WINDOW) {
    permissionApprovalWindows.set(relayId, timestamps);
    return false;
  }
  timestamps.push(now);
  permissionApprovalWindows.set(relayId, timestamps);
  return true;
}

function hasNativeHookRelayPermissionAllowAlways(key: string, now = Date.now()): boolean {
  const entry = permissionAllowAlwaysApprovals.get(key);
  if (!entry) {
    return false;
  }
  if (entry.expiresAtMs <= now) {
    permissionAllowAlwaysApprovals.delete(key);
    return false;
  }
  return true;
}

function rememberNativeHookRelayPermissionAllowAlways(key: string, now = Date.now()): void {
  pruneNativeHookRelayPermissionAllowAlways(now);
  permissionAllowAlwaysApprovals.set(key, {
    expiresAtMs: now + PERMISSION_ALLOW_ALWAYS_TTL_MS,
  });
  while (permissionAllowAlwaysApprovals.size > MAX_PERMISSION_ALLOW_ALWAYS_ENTRIES) {
    const oldestKey = permissionAllowAlwaysApprovals.keys().next().value;
    if (typeof oldestKey !== "string") {
      break;
    }
    permissionAllowAlwaysApprovals.delete(oldestKey);
  }
}

function pruneNativeHookRelayPermissionAllowAlways(now = Date.now()): void {
  for (const [key, entry] of permissionAllowAlwaysApprovals) {
    if (entry.expiresAtMs <= now) {
      permissionAllowAlwaysApprovals.delete(key);
    }
  }
}

function removeNativeHookRelayPermissionState(relayId: string): void {
  permissionApprovalWindows.delete(relayId);
  for (const key of pendingPermissionApprovals.keys()) {
    if (key.startsWith(`${relayId}:`)) {
      pendingPermissionApprovals.delete(key);
    }
  }
}

function snapshotNativeHookRelayPayload(payload: JsonValue): JsonValue {
  return snapshotJsonValue(payload, {
    remainingStringLength: MAX_NATIVE_HOOK_RELAY_HISTORY_TOTAL_STRING_LENGTH,
  });
}

function snapshotJsonValue(value: JsonValue, state: { remainingStringLength: number }): JsonValue {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return snapshotString(value, state);
  }
  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_NATIVE_HOOK_RELAY_HISTORY_ARRAY_ITEMS)
      .map((item) => snapshotJsonValue(item, state));
    if (value.length > MAX_NATIVE_HOOK_RELAY_HISTORY_ARRAY_ITEMS) {
      items.push("[truncated]");
    }
    return items;
  }
  const snapshot: Record<string, JsonValue> = {};
  const keys = Object.keys(value);
  for (const key of keys.slice(0, MAX_NATIVE_HOOK_RELAY_HISTORY_OBJECT_KEYS)) {
    snapshot[snapshotString(key, state)] = snapshotJsonValue(value[key], state);
  }
  if (keys.length > MAX_NATIVE_HOOK_RELAY_HISTORY_OBJECT_KEYS) {
    snapshot["[truncated]"] = keys.length - MAX_NATIVE_HOOK_RELAY_HISTORY_OBJECT_KEYS;
  }
  return snapshot;
}

function snapshotString(value: string, state: { remainingStringLength: number }): string {
  if (state.remainingStringLength <= 0) {
    return "[truncated]";
  }
  const limit = Math.min(
    value.length,
    MAX_NATIVE_HOOK_RELAY_HISTORY_STRING_LENGTH,
    state.remainingStringLength,
  );
  state.remainingStringLength -= limit;
  if (limit >= value.length) {
    return value;
  }
  return `${value.slice(0, limit)}...[truncated]`;
}

function normalizeNativeHookInvocation(params: {
  registration: NativeHookRelayRegistration;
  event: NativeHookRelayEvent;
  rawPayload: JsonValue;
}): NativeHookRelayInvocation {
  const metadata = getNativeHookRelayProviderAdapter(
    params.registration.provider,
  ).normalizeMetadata(params.rawPayload);
  return {
    provider: params.registration.provider,
    relayId: params.registration.relayId,
    event: params.event,
    ...metadata,
    ...(params.registration.agentId ? { agentId: params.registration.agentId } : {}),
    sessionId: params.registration.sessionId,
    ...(params.registration.sessionKey ? { sessionKey: params.registration.sessionKey } : {}),
    runId: params.registration.runId,
    rawPayload: params.rawPayload,
    receivedAt: new Date().toISOString(),
  };
}

function getNativeHookRelayProviderAdapter(
  provider: NativeHookRelayProvider,
): NativeHookRelayProviderAdapter {
  return nativeHookRelayProviderAdapters[provider];
}

function normalizeCodexHookMetadata(rawPayload: JsonValue): NativeHookRelayInvocationMetadata {
  const payload = isJsonObject(rawPayload) ? rawPayload : {};
  const metadata: NativeHookRelayInvocationMetadata = {};
  const nativeEventName = readOptionalString(payload.hook_event_name);
  if (nativeEventName) {
    metadata.nativeEventName = nativeEventName;
  }
  const cwd = readOptionalString(payload.cwd);
  if (cwd) {
    metadata.cwd = cwd;
  }
  const model = readOptionalString(payload.model);
  if (model) {
    metadata.model = model;
  }
  const turnId = readOptionalString(payload.turn_id);
  if (turnId) {
    metadata.turnId = turnId;
  }
  const transcriptPath = readOptionalString(payload.transcript_path);
  if (transcriptPath) {
    metadata.transcriptPath = transcriptPath;
  }
  const permissionMode = readOptionalString(payload.permission_mode);
  if (permissionMode) {
    metadata.permissionMode = permissionMode;
  }
  const stopHookActive = readOptionalBoolean(payload.stop_hook_active);
  if (stopHookActive !== undefined) {
    metadata.stopHookActive = stopHookActive;
  }
  const lastAssistantMessage = readOptionalString(payload.last_assistant_message);
  if (lastAssistantMessage) {
    metadata.lastAssistantMessage = lastAssistantMessage;
  }
  const toolName = readOptionalString(payload.tool_name);
  if (toolName) {
    metadata.toolName = toolName;
  }
  const toolUseId = readOptionalString(payload.tool_use_id);
  if (toolUseId) {
    metadata.toolUseId = toolUseId;
  }
  return metadata;
}

function readCodexToolInput(rawPayload: JsonValue): Record<string, JsonValue> {
  const payload = isJsonObject(rawPayload) ? rawPayload : {};
  const toolInput = payload.tool_input;
  if (isJsonObject(toolInput)) {
    return toolInput as Record<string, JsonValue>;
  }
  if (toolInput === undefined) {
    return {};
  }
  return { value: toolInput as JsonValue };
}

function readCodexToolResponse(rawPayload: JsonValue): unknown {
  const payload = isJsonObject(rawPayload) ? rawPayload : {};
  return payload.tool_response;
}

function normalizeNativeHookToolName(toolName: string | undefined): string {
  return normalizeToolName(toolName ?? "tool");
}

async function requestNativeHookRelayPermissionApproval(
  request: NativeHookRelayPermissionApprovalRequest,
): Promise<NativeHookRelayPermissionApprovalResult> {
  const timeoutMs = DEFAULT_PERMISSION_TIMEOUT_MS;
  const requestResult: {
    id?: string;
    decision?: string | null;
  } = await callGatewayTool(
    "plugin.approval.request",
    { timeoutMs: timeoutMs + 10_000 },
    {
      pluginId: `openclaw-native-hook-relay-${request.provider}`,
      title: truncateText(
        `${nativeHookRelayProviderDisplayName(request.provider)} permission request`,
        MAX_APPROVAL_TITLE_LENGTH,
      ),
      description: truncateText(
        formatPermissionApprovalDescription(request),
        MAX_APPROVAL_DESCRIPTION_LENGTH,
      ),
      severity: "warning",
      toolName: request.toolName,
      toolCallId: request.toolCallId,
      allowedDecisions: [
        PluginApprovalResolutions.ALLOW_ONCE,
        PluginApprovalResolutions.ALLOW_ALWAYS,
        PluginApprovalResolutions.DENY,
      ],
      agentId: request.agentId,
      sessionKey: request.sessionKey,
      timeoutMs,
      twoPhase: true,
    },
    { expectFinal: false },
  );
  const approvalId = requestResult?.id;
  if (!approvalId) {
    return "defer";
  }
  let decision: string | null | undefined;
  if (Object.prototype.hasOwnProperty.call(requestResult ?? {}, "decision")) {
    decision = requestResult.decision;
  } else {
    const waitResult = await waitForNativeHookRelayApprovalDecision({
      approvalId,
      signal: request.signal,
      timeoutMs,
    });
    decision = waitResult?.decision;
  }
  if (decision === PluginApprovalResolutions.ALLOW_ONCE) {
    return "allow";
  }
  if (decision === PluginApprovalResolutions.ALLOW_ALWAYS) {
    return "allow-always";
  }
  if (decision === PluginApprovalResolutions.DENY) {
    return "deny";
  }
  return "defer";
}

async function waitForNativeHookRelayApprovalDecision(params: {
  approvalId: string;
  signal?: AbortSignal;
  timeoutMs: number;
}): Promise<{ id?: string; decision?: string | null } | undefined> {
  const waitPromise: Promise<{ id?: string; decision?: string | null } | undefined> =
    callGatewayTool(
      "plugin.approval.waitDecision",
      { timeoutMs: params.timeoutMs + 10_000 },
      { id: params.approvalId },
    );
  if (!params.signal) {
    return waitPromise;
  }
  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    if (params.signal!.aborted) {
      reject(params.signal!.reason);
      return;
    }
    onAbort = () => reject(params.signal!.reason);
    params.signal!.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([waitPromise, abortPromise]);
  } finally {
    if (onAbort) {
      params.signal.removeEventListener("abort", onAbort);
    }
  }
}

function formatPermissionApprovalDescription(
  request: NativeHookRelayPermissionApprovalRequest,
): string {
  const lines = [
    `Tool: ${sanitizeApprovalText(request.toolName)}`,
    request.cwd ? `Cwd: ${sanitizeApprovalText(request.cwd)}` : undefined,
    request.model ? `Model: ${sanitizeApprovalText(request.model)}` : undefined,
    formatToolInputPreview(request.toolInput),
  ].filter((line): line is string => Boolean(line));
  return lines.join("\n");
}

function formatToolInputPreview(toolInput: Record<string, unknown>): string | undefined {
  const command = readOptionalString(toolInput.command);
  if (command) {
    return `Command: ${truncateText(sanitizeApprovalText(command), 240)}`;
  }
  const keys = Object.keys(toolInput).map(sanitizeApprovalText).filter(Boolean).toSorted();
  if (!keys.length) {
    return undefined;
  }
  const shownKeys = keys.slice(0, 12).join(", ");
  const omitted = keys.length > 12 ? ` (${keys.length - 12} omitted)` : "";
  return `Input keys: ${shownKeys}${omitted}`;
}

function sanitizeApprovalText(value: string): string {
  let sanitized = "";
  for (const char of value.replace(ANSI_ESCAPE_PATTERN, "")) {
    const codePoint = char.codePointAt(0);
    sanitized += codePoint != null && isUnsafeApprovalCodePoint(codePoint) ? " " : char;
  }
  return sanitized.replace(/\s+/g, " ").trim();
}

function isUnsafeApprovalCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0 && codePoint <= 8) ||
    codePoint === 11 ||
    codePoint === 12 ||
    (codePoint >= 14 && codePoint <= 31) ||
    (codePoint >= 127 && codePoint <= 159) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

function nativeHookRelayProviderDisplayName(provider: NativeHookRelayProvider): string {
  if (provider === "codex") {
    return "Codex";
  }
  return provider;
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function resolveOpenClawCliExecutable(): string {
  const envPath = process.env.OPENCLAW_CLI_PATH?.trim();
  if (envPath && existsSync(envPath)) {
    return envPath;
  }
  const packageRoot = resolveOpenClawPackageRootSync({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
    cwd: process.cwd(),
  });
  if (packageRoot) {
    for (const candidate of [
      path.join(packageRoot, "openclaw.mjs"),
      path.join(packageRoot, "dist", "entry.js"),
      path.join(packageRoot, "scripts", "run-node.mjs"),
    ]) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  const argvEntry = process.argv[1];
  if (argvEntry) {
    const resolved = path.resolve(argvEntry);
    if (existsSync(resolved)) {
      return resolved;
    }
  }
  throw new Error("Cannot resolve OpenClaw CLI executable path for native hook relay");
}

function normalizeAllowedEvents(
  events: readonly NativeHookRelayEvent[] | undefined,
): readonly NativeHookRelayEvent[] {
  if (!events?.length) {
    return NATIVE_HOOK_RELAY_EVENTS;
  }
  return [...new Set(events)];
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function shellQuoteArgs(args: readonly string[]): string {
  return args.map((arg) => shellQuoteArg(arg, process.platform)).join(" ");
}

function shellQuoteArg(value: string, platform: NodeJS.Platform): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) {
    return value;
  }
  if (platform === "win32") {
    return `"${value.replaceAll('"', '\\"')}"`;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function readNativeHookRelayProvider(value: unknown): NativeHookRelayProvider {
  if (value === "codex") {
    return value;
  }
  throw new Error("unsupported native hook relay provider");
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
  throw new Error("unsupported native hook relay event");
}

function readNonEmptyString(value: unknown, name: string): string {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  throw new Error(`native hook relay ${name} is required`);
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function isJsonValue(value: unknown): value is JsonValue {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  let totalStringLength = 0;
  while (stack.length) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_NATIVE_HOOK_RELAY_JSON_NODES) {
      return false;
    }
    if (current.depth > MAX_NATIVE_HOOK_RELAY_JSON_DEPTH) {
      return false;
    }
    if (current.value === null) {
      continue;
    }
    if (typeof current.value === "string") {
      if (current.value.length > MAX_NATIVE_HOOK_RELAY_STRING_LENGTH) {
        return false;
      }
      totalStringLength += current.value.length;
      if (totalStringLength > MAX_NATIVE_HOOK_RELAY_TOTAL_STRING_LENGTH) {
        return false;
      }
      continue;
    }
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value)) {
        return false;
      }
      continue;
    }
    if (typeof current.value === "boolean") {
      continue;
    }
    if (Array.isArray(current.value)) {
      for (let index = 0; index < current.value.length; index += 1) {
        if (nodes + stack.length + 1 > MAX_NATIVE_HOOK_RELAY_JSON_NODES) {
          return false;
        }
        stack.push({ value: current.value[index], depth: current.depth + 1 });
      }
      continue;
    }
    if (!isJsonObject(current.value)) {
      return false;
    }
    try {
      for (const key in current.value) {
        if (!Object.prototype.hasOwnProperty.call(current.value, key)) {
          continue;
        }
        if (key.length > MAX_NATIVE_HOOK_RELAY_STRING_LENGTH) {
          return false;
        }
        totalStringLength += key.length;
        if (totalStringLength > MAX_NATIVE_HOOK_RELAY_TOTAL_STRING_LENGTH) {
          return false;
        }
        if (nodes + stack.length + 1 > MAX_NATIVE_HOOK_RELAY_JSON_NODES) {
          return false;
        }
        stack.push({ value: current.value[key], depth: current.depth + 1 });
      }
    } catch {
      return false;
    }
  }
  return true;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

export const __testing = {
  clearNativeHookRelaysForTests(): void {
    for (const relayId of relayBridges.keys()) {
      unregisterNativeHookRelayBridge(relayId);
    }
    relays.clear();
    invocations.length = 0;
    pendingPermissionApprovals.clear();
    permissionApprovalWindows.clear();
    permissionAllowAlwaysApprovals.clear();
    nativeHookRelayPermissionApprovalRequester = requestNativeHookRelayPermissionApproval;
  },
  getNativeHookRelayInvocationsForTests(): NativeHookRelayInvocation[] {
    return [...invocations];
  },
  getNativeHookRelayRegistrationForTests(relayId: string): NativeHookRelayRegistration | undefined {
    return relays.get(relayId);
  },
  getNativeHookRelayBridgeDirForTests(): string {
    return nativeHookRelayBridgeDir();
  },
  getNativeHookRelayBridgeRegistryPathForTests(relayId: string): string {
    return nativeHookRelayBridgeRegistryPath(relayId);
  },
  getNativeHookRelayBridgeRecordForTests(relayId: string): Record<string, unknown> | undefined {
    const record = readNativeHookRelayBridgeRecordIfExists(relayId);
    return record ? { ...record } : undefined;
  },
  formatPermissionApprovalDescriptionForTests(
    request: NativeHookRelayPermissionApprovalRequest,
  ): string {
    return formatPermissionApprovalDescription(request);
  },
  permissionRequestContentFingerprintForTests(
    request: NativeHookRelayPermissionApprovalRequest,
  ): string {
    return permissionRequestContentFingerprint(request);
  },
  permissionRequestToolInputKeyFingerprintForTests(toolInput: Record<string, unknown>): string {
    return permissionRequestToolInputKeyFingerprint(toolInput);
  },
  setNativeHookRelayPermissionApprovalRequesterForTests(
    requester: NativeHookRelayPermissionApprovalRequester,
  ): void {
    nativeHookRelayPermissionApprovalRequester = requester;
  },
} as const;
