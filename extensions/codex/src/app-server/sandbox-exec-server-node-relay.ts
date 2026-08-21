import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { redactToolPayloadText } from "openclaw/plugin-sdk/logging-core";
import { sanitizeEnvVars } from "openclaw/plugin-sdk/sandbox";
import { formatErrorMessage, redactSensitiveText } from "openclaw/plugin-sdk/security-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { RawData, WebSocket } from "ws";
import type { CodexNodeExecServerLease } from "./sandbox-exec-server/types.js";

const CODEX_NODE_EXEC_SERVER_MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
const CODEX_NODE_EXEC_SERVER_MAX_FAILURE_DETAIL_CHARS = 240;
const CODEX_NODE_HTTP_CREDENTIAL_BODY_MAX_BYTES = 1024 * 1024;
const CODEX_NODE_HTTP_CREDENTIAL_SCAN_MAX_FIELDS = 256;
const CODEX_NODE_HTTP_CREDENTIAL_SCAN_MAX_DEPTH = 8;
// Plugin SDK exposes no credential classifiers; mirror canonical names without deep core imports.
const CODEX_NODE_HTTP_CREDENTIAL_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "apikey",
  "x-auth-token",
  "auth-token",
  "x-access-token",
  "access-token",
  "x-secret-key",
  "secret-key",
  "x-goog-api-key",
  "x-vault-token",
  "x-api-token",
]);
const CODEX_NODE_HTTP_CREDENTIAL_HEADER_NAME_PATTERN =
  /(?:^|[-_])(?:auth(?:orization|entication)?|token|secret|api[-_]?key|apikey|key|password|passwd|pwd|passphrase|passcode|credentials?|session|jwt|assertion|verifier|sig(?:nature)?|hmac|bearer|ticket|challenge|proof|dpop|otp|totp|pin|mfa)(?:[-_]|$)/iu;
const CODEX_NODE_HTTP_CREDENTIAL_FIELD_NAME_PATTERN =
  /^(?:(?:[a-z\d]+_)*(?:token|secret|password|passwd|pwd|passphrase|passcode|credentials?|authorization|api_?key|private_key|secret_key|secret_access_key|jwt|assertion|verifier|signature|hmac|bearer|ticket|(?:oauth|consumer|auth|access)_key|otp|totp|pin)|(?:device|authorization|auth|verification|mfa)_code|session(?:_id)?|jsessionid|saml(?:_?response|_?assertion)?|auth|jwt|code|sig|signature|hmac|key|pass)$/u;
const nodeExecServerTextDecoder = new TextDecoder("utf-8", { fatal: true });

/** Produces the bounded, redacted terminal failure shared by pending and claimed node leases. */
export function createCodexNodeExecServerDisconnectError(reason: string, cause?: unknown): Error {
  const detail =
    cause === undefined
      ? ""
      : `: ${truncateUtf16Safe(
          redactSensitiveText(formatErrorMessage(cause), { mode: "tools" }),
          CODEX_NODE_EXEC_SERVER_MAX_FAILURE_DETAIL_CHARS,
        )}`;
  return new Error(
    `Codex paired execution device disconnected; start a fresh attempt. (${reason}${detail})`,
  );
}

/** Relays one authorized, single-use Codex exec-server channel without interpreting its protocol. */
export async function startCodexNodeExecServerRelay(params: {
  lease: CodexNodeExecServerLease;
  socket: WebSocket;
}): Promise<void> {
  const { channel } = params.lease;
  const { socket } = params;
  let closed = false;
  const { promise: finished, resolve: finish } = createDeferred<void>();
  let unsubscribe = () => {};

  const closeBoth = (code = 1001, reason = "execution channel closed") => {
    if (closed) {
      return;
    }
    closed = true;
    unsubscribe();
    params.lease.closeRelay = undefined;
    params.lease.onChannelClosed = undefined;
    if (!params.lease.closed) {
      params.lease.closed = true;
      channel.close();
    }
    if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) {
      socket.close(code, reason);
    }
    finish();
  };
  // The shared loopback server can outlive this lease, so release owns its exact socket.
  params.lease.closeRelay = closeBoth;

  const failUnexpectedly = (code: number, reason: string, cause?: unknown) => {
    if (!closed && !params.lease.closed) {
      params.lease.onDisconnected?.(createCodexNodeExecServerDisconnectError(reason, cause));
    }
    closeBoth(code, reason);
  };

  params.lease.onChannelClosed = ({ failed, error }) =>
    failUnexpectedly(
      failed ? 1011 : 1001,
      failed ? "execution device failed" : "execution device disconnected",
      error,
    );
  socket.once("close", () => failUnexpectedly(1001, "execution socket closed"));
  socket.once("error", () => failUnexpectedly(1011, "execution socket failed"));

  let toNode = Promise.resolve();
  socket.on("message", (data: RawData) => {
    if (closed) {
      return;
    }
    // Stop reading the app-server socket until node-carrier backpressure clears.
    socket.pause();
    toNode = toNode
      .then(async () => {
        const frame = normalizeCodexExecServerFrame(data);
        const request = validateCodexExecServerMessage(frame);
        const rejection = rejectCredentialedCodexNodeHttpRequest(request);
        if (rejection) {
          await sendCodexExecServerFrame(socket, rejection);
        } else {
          await channel.send(sanitizeCodexExecServerRequest(frame, request));
        }
        if (!closed) {
          socket.resume();
        }
      })
      .catch((error: unknown) => {
        failUnexpectedly(error instanceof RangeError ? 1009 : 1007, "invalid execution message");
      });
  });

  unsubscribe = channel.onMessage(async (message) => {
    if (closed) {
      return;
    }
    try {
      const frame = normalizeCodexExecServerFrame(message);
      validateCodexExecServerMessage(frame);
      await sendCodexExecServerFrame(socket, frame);
    } catch (error) {
      failUnexpectedly(error instanceof RangeError ? 1009 : 1007, "invalid device message");
    }
  });

  await finished;
}

function sendCodexExecServerFrame(socket: WebSocket, frame: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.send(frame, { binary: false }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function normalizeCodexExecServerFrame(data: RawData | Uint8Array): Buffer {
  const frame = Array.isArray(data)
    ? Buffer.concat(data)
    : Buffer.isBuffer(data)
      ? data
      : data instanceof Uint8Array
        ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
        : Buffer.from(data);
  if (frame.length > CODEX_NODE_EXEC_SERVER_MAX_MESSAGE_BYTES) {
    throw new RangeError("Codex exec-server message exceeds its 64 MiB limit.");
  }
  if (frame.includes(10) || frame.includes(13)) {
    throw new Error("Codex exec-server messages must occupy exactly one stdio line.");
  }
  return frame;
}

function validateCodexExecServerMessage(frame: Buffer): Record<string, unknown> {
  const parsed: unknown = JSON.parse(nodeExecServerTextDecoder.decode(frame));
  if (!isRecord(parsed)) {
    throw new Error("Codex exec-server message must be a JSON object.");
  }
  return parsed;
}

function rejectCredentialedCodexNodeHttpRequest(
  request: Record<string, unknown>,
): Buffer | undefined {
  if (request.method !== "http/request") {
    return undefined;
  }
  if (!isRecord(request.params)) {
    throw new Error("Codex http/request params must be an object.");
  }
  const headers = request.params.headers ?? [];
  if (!Array.isArray(headers)) {
    throw new Error("Codex http/request headers must be an array.");
  }
  if (headers.length > CODEX_NODE_HTTP_CREDENTIAL_SCAN_MAX_FIELDS) {
    return createCredentialedCodexNodeHttpRejection(request);
  }
  let credentialBearing = false;
  let contentType: string | undefined;
  for (const header of headers) {
    if (!isRecord(header) || typeof header.name !== "string" || typeof header.value !== "string") {
      throw new Error("Codex http/request headers must contain string names and values.");
    }
    const name = header.name.trim().toLowerCase();
    if (
      CODEX_NODE_HTTP_CREDENTIAL_HEADER_NAMES.has(name) ||
      CODEX_NODE_HTTP_CREDENTIAL_HEADER_NAME_PATTERN.test(name) ||
      hasSensitiveCodexNodeText(header.value)
    ) {
      credentialBearing = true;
    }
    if (name === "content-type") {
      const declared = header.value.split(";", 1)[0]?.trim().toLowerCase();
      credentialBearing ||= Boolean(contentType && contentType !== declared);
      contentType = declared;
    }
  }
  if (!credentialBearing && typeof request.params.url === "string") {
    credentialBearing = hasCredentialedCodexNodeHttpUrl(request.params.url);
  }
  if (!credentialBearing && request.params.bodyBase64 != null) {
    credentialBearing = hasCredentialedCodexNodeHttpBody(request.params.bodyBase64, contentType);
  }
  return credentialBearing ? createCredentialedCodexNodeHttpRejection(request) : undefined;
}

function hasCredentialedCodexNodeHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Codex http/request URL must be valid.");
  }
  if (url.username || url.password || hasSensitiveCodexNodeText(value)) {
    return true;
  }
  let fields = 0;
  const hasCredentialedParameter = (name: string, parameterValue: string): boolean =>
    ++fields > CODEX_NODE_HTTP_CREDENTIAL_SCAN_MAX_FIELDS ||
    isCodexNodeCredentialField(name) ||
    hasSensitiveCodexNodeText(parameterValue);
  for (const parameters of [url.searchParams, new URLSearchParams(url.hash.slice(1))]) {
    for (const [name, parameterValue] of parameters) {
      if (hasCredentialedParameter(name, parameterValue)) {
        return true;
      }
    }
  }
  for (const initial of [url.pathname, url.hash.slice(1), ...url.searchParams.values()]) {
    let component = initial;
    for (let depth = 0; depth <= CODEX_NODE_HTTP_CREDENTIAL_SCAN_MAX_DEPTH; depth += 1) {
      for (const nestedQuery of component.split(/[?#]/u).slice(1)) {
        for (const [name, parameterValue] of new URLSearchParams(nestedQuery)) {
          if (hasCredentialedParameter(name, parameterValue)) {
            return true;
          }
        }
      }
      for (const segment of component.split("/")) {
        for (const parameter of segment.split(";").slice(1)) {
          const separator = parameter.indexOf("=");
          const name = separator < 0 ? parameter : parameter.slice(0, separator);
          const parameterValue = separator < 0 ? "" : parameter.slice(separator + 1);
          if (hasCredentialedParameter(name, parameterValue)) {
            return true;
          }
        }
      }
      if (!/%[\da-f]{2}/iu.test(component)) {
        break;
      }
      if (depth === CODEX_NODE_HTTP_CREDENTIAL_SCAN_MAX_DEPTH) {
        return true;
      }
      try {
        component = decodeURIComponent(component);
      } catch {
        return true;
      }
    }
  }
  return false;
}

function hasCredentialedCodexNodeHttpBody(
  value: unknown,
  contentType: string | undefined,
): boolean {
  if (typeof value !== "string") {
    throw new Error("Codex http/request bodyBase64 must be a string.");
  }
  const declaredText = contentType === "text/plain";
  if (
    !declaredText &&
    value.length > Math.ceil(CODEX_NODE_HTTP_CREDENTIAL_BODY_MAX_BYTES / 3) * 4
  ) {
    // Missing content-type or binary disguise must not bypass bounded credential inspection.
    return true;
  }
  let body: string;
  try {
    const decoded = Buffer.from(value, "base64");
    if (
      (!declaredText && decoded.length > CODEX_NODE_HTTP_CREDENTIAL_BODY_MAX_BYTES) ||
      decoded.toString("base64") !== value
    ) {
      return true;
    }
    body = nodeExecServerTextDecoder.decode(decoded);
  } catch {
    return true;
  }
  if (!body) {
    return false;
  }
  if (hasSensitiveCodexNodeText(body)) {
    return true;
  }
  const declaredJson =
    contentType === "application/json" || contentType?.endsWith("+json") === true;
  const declaredForm = contentType === "application/x-www-form-urlencoded";
  if (contentType && !declaredJson && !declaredForm && !declaredText) {
    return true;
  }
  const trimmed = body.trimStart();
  if (trimmed.startsWith("<")) {
    return true;
  }
  if (declaredJson || trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      if (hasCredentialedCodexNodeRawJsonStrings(body)) {
        return true;
      }
      const json: unknown = JSON.parse(body);
      return hasCredentialedCodexNodeJsonFields(json);
    } catch {
      if (!declaredText) {
        return true;
      }
    }
  }
  if (!declaredForm && !body.includes("=")) {
    return !declaredText;
  }
  let fields = 0;
  for (const [name, parameterValue] of new URLSearchParams(body)) {
    if (
      ++fields > CODEX_NODE_HTTP_CREDENTIAL_SCAN_MAX_FIELDS ||
      isCodexNodeCredentialField(name) ||
      hasSensitiveCodexNodeText(parameterValue)
    ) {
      return true;
    }
  }
  return false;
}

function hasCredentialedCodexNodeRawJsonStrings(body: string): boolean {
  const tokens = body.matchAll(/("(?:\\.|[^"\\])*")(\s*:)?/gu);
  let fields = 0;
  for (const match of tokens) {
    const value: unknown = JSON.parse(match[1]!);
    if (
      ++fields > CODEX_NODE_HTTP_CREDENTIAL_SCAN_MAX_FIELDS ||
      typeof value !== "string" ||
      hasSensitiveCodexNodeText(value) ||
      (match[2] !== undefined && isCodexNodeCredentialField(value))
    ) {
      return true;
    }
  }
  return false;
}

function hasCredentialedCodexNodeJsonFields(value: unknown): boolean {
  const pending = [{ value, depth: 0 }];
  let fields = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current?.value === "string" && hasSensitiveCodexNodeText(current.value)) {
      return true;
    }
    if (!current || (!Array.isArray(current.value) && !isRecord(current.value))) {
      continue;
    }
    if (current.depth >= CODEX_NODE_HTTP_CREDENTIAL_SCAN_MAX_DEPTH) {
      return true;
    }
    const entries = Array.isArray(current.value)
      ? current.value.map((entry) => [undefined, entry] as const)
      : Object.entries(current.value);
    for (const [name, nested] of entries) {
      if (
        ++fields > CODEX_NODE_HTTP_CREDENTIAL_SCAN_MAX_FIELDS ||
        (typeof name === "string" && isCodexNodeCredentialField(name))
      ) {
        return true;
      }
      pending.push({ value: nested, depth: current.depth + 1 });
    }
  }
  return false;
}

function hasSensitiveCodexNodeText(value: string): boolean {
  let decoded = value;
  for (let depth = 0; depth <= CODEX_NODE_HTTP_CREDENTIAL_SCAN_MAX_DEPTH; depth += 1) {
    if (redactToolPayloadText(decoded) !== decoded) {
      return true;
    }
    if (!/%[\da-f]{2}/iu.test(decoded)) {
      return false;
    }
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      return true;
    }
  }
  return true;
}

function isCodexNodeCredentialField(value: string): boolean {
  let decoded = value;
  for (let depth = 0; depth < CODEX_NODE_HTTP_CREDENTIAL_SCAN_MAX_DEPTH; depth += 1) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return true;
    }
    if (next === decoded) {
      break;
    }
    decoded = next;
  }
  const normalized = decoded
    .replace(/[\p{C}\p{Z}\u115F\u1160\u3164\uFFA0+]/gu, "")
    .replace(/([a-z\d])([A-Z])/gu, "$1_$2")
    .replaceAll("-", "_")
    .toLowerCase();
  return (
    normalized.length > CODEX_NODE_HTTP_CREDENTIAL_SCAN_MAX_FIELDS ||
    normalized
      .split(/[.[\]]+/u)
      .some((component) => CODEX_NODE_HTTP_CREDENTIAL_FIELD_NAME_PATTERN.test(component))
  );
}

function createCredentialedCodexNodeHttpRejection(request: Record<string, unknown>): Buffer {
  if (typeof request.id !== "string" && typeof request.id !== "number") {
    throw new Error("Codex http/request must have a JSON-RPC request id.");
  }
  return Buffer.from(
    JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: -32602,
        message:
          "Authenticated remote HTTP is unavailable on paired devices; run on Gateway or use an intentionally credential-free endpoint.",
      },
    }),
  );
}

function sanitizeCodexExecServerRequest(frame: Buffer, request: Record<string, unknown>): Buffer {
  if (request.method !== "process/start") {
    return frame;
  }
  if (!isRecord(request.params)) {
    throw new Error("Codex process/start params must be an object.");
  }
  sanitizeCodexExecServerEnvironment(request.params, "env");
  if (request.params.envPolicy !== undefined) {
    if (!isRecord(request.params.envPolicy)) {
      throw new Error("Codex process/start envPolicy must be an object.");
    }
    sanitizeCodexExecServerEnvironment(request.params.envPolicy, "set");
  }
  return normalizeCodexExecServerFrame(Buffer.from(JSON.stringify(request)));
}

function sanitizeCodexExecServerEnvironment(
  record: Record<string, unknown>,
  key: "env" | "set",
): void {
  const environment = record[key];
  if (environment === undefined) {
    return;
  }
  if (!isRecord(environment)) {
    throw new Error(`Codex process/start ${key} must be an object.`);
  }
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment)) {
    if (typeof value !== "string") {
      throw new Error(`Codex process/start ${key} values must be strings.`);
    }
    try {
      const url = new URL(value);
      if (url.username || url.password) {
        continue;
      }
    } catch {
      // Ordinary environment values need not be URLs.
    }
    values[name] = value;
  }
  record[key] = sanitizeEnvVars(values).allowed;
}
