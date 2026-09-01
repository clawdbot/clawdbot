import * as crypto from "node:crypto";
import {
  isJsonObject,
  type CodexDynamicToolSpec,
  type CodexTurnEnvironmentParams,
  type JsonObject,
  type JsonValue,
} from "./protocol.js";
import { hashCodexAppServerBindingFingerprint } from "./session-binding.js";
import { resolveCodexGpt56MultiAgentVersion } from "./thread-binding-policy.js";

export function codexDynamicToolsFingerprint(dynamicTools: readonly JsonValue[]): string {
  return fingerprintDynamicTools(dynamicTools);
}

export function codexLegacyDynamicToolsFingerprint(dynamicTools: CodexDynamicToolSpec[]): string {
  return legacyFingerprintDynamicTools(dynamicTools);
}

export function areCodexDynamicToolFingerprintsCompatible(params: {
  previous?: string;
  next: string;
  nextLegacy?: string;
}): boolean {
  return areDynamicToolFingerprintsCompatible(params.previous, params.next, params.nextLegacy);
}

function fingerprintDynamicTools(dynamicTools: readonly JsonValue[]): string {
  return hashCodexAppServerBindingFingerprint(legacyFingerprintDynamicTools(dynamicTools));
}

function legacyFingerprintDynamicTools(dynamicTools: readonly JsonValue[]): string {
  return JSON.stringify(
    dynamicTools.map(fingerprintDynamicToolSpec).toSorted(compareJsonFingerprint),
  );
}

export function legacyFingerprintUserMcpServersConfigPatch(
  configPatch: JsonObject | undefined,
): string | undefined {
  return configPatch ? JSON.stringify(stabilizeJsonValue(configPatch)) : undefined;
}

export function fingerprintUserMcpServersConfigPatch(
  configPatch: JsonObject | undefined,
): string | undefined {
  return configPatch
    ? hashCodexAppServerBindingFingerprint(
        JSON.stringify(stabilizeJsonValue(redactUserMcpServersFingerprintSecrets(configPatch))),
      )
    : undefined;
}

function redactUserMcpServersFingerprintSecrets(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(redactUserMcpServersFingerprintSecrets);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const next: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "http_headers" && entry && typeof entry === "object" && !Array.isArray(entry)) {
      next[key] = Object.fromEntries(
        Object.entries(entry).map(([header, headerValue]) => [
          header,
          header.toLowerCase() === "authorization"
            ? fingerprintUserMcpServersAuthorizationHeader(headerValue)
            : headerValue,
        ]),
      ) as JsonObject;
      continue;
    }
    next[key] = redactUserMcpServersFingerprintSecrets(entry);
  }
  return next;
}

function fingerprintUserMcpServersAuthorizationHeader(value: unknown): string {
  return typeof value === "string" && value.length > 0
    ? `<redacted:sha256:${crypto.createHash("sha256").update(value).digest("hex")}>`
    : "<redacted>";
}

export function fingerprintJsonObject(value: JsonObject): string {
  return JSON.stringify(stabilizeJsonValue(value));
}

/** Hash thread-creation identity; settings already applied by turn/start must not restart Codex. */
export function fingerprintCodexThreadConfig(
  request: JsonObject,
  authProfileId?: string,
  dynamicToolsFingerprint?: string,
): string {
  return hashCodexAppServerBindingFingerprint(
    fingerprintJsonObject({
      authProfileId: authProfileId ?? null,
      dynamicToolsFingerprint: dynamicToolsFingerprint ?? null,
      // Codex fixes its model-selected native multi-agent generation for the
      // whole session; only same-generation model changes are turn-mutable.
      nativeMultiAgentVersion:
        resolveCodexGpt56MultiAgentVersion(
          typeof request.requestedModel === "string"
            ? request.requestedModel
            : typeof request.model === "string"
              ? request.model
              : undefined,
        ) ?? null,
      modelProvider: request.modelProvider ?? null,
      requestedModelProvider:
        request.requestedModelProvider === undefined
          ? (request.modelProvider ?? null)
          : request.requestedModelProvider,
      // Named permission profiles are not currently forwarded by turn/start,
      // so changing one still requires recreating the native thread.
      permissions: request.permissions ?? null,
      baseInstructions: request.baseInstructions ?? null,
      developerInstructions: request.developerInstructions ?? null,
      config: request.config ?? {},
    }),
  );
}

export function fingerprintEnvironmentSelection(
  environments: CodexTurnEnvironmentParams[] | undefined,
): string | undefined {
  return environments ? JSON.stringify(environments.map(stabilizeJsonValue)) : undefined;
}

function fingerprintDynamicToolSpec(tool: JsonValue): JsonValue {
  // Codex persists the complete model-visible schema at thread/start; resume
  // cannot refresh changed tool or nested input descriptions.
  return stabilizeJsonValue(tool);
}

function stabilizeJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(stabilizeJsonValue);
  }
  if (!isJsonObject(value)) {
    return value;
  }
  const stable: JsonObject = {};
  for (const [key, child] of Object.entries(value).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    stable[key] = stabilizeJsonValue(child);
  }
  return stable;
}

function readActiveCodexTurnIds(thread: unknown): string[] {
  const turns = (thread as { turns?: Array<{ id?: unknown; status?: unknown }> }).turns;
  return (turns ?? [])
    .filter((turn) => turn.status === "inProgress")
    .map((turn) => (typeof turn.id === "string" ? turn.id : ""))
    .filter((turnId) => turnId.trim().length > 0);
}

export function readActiveCodexTurnIdsFromResume(response: {
  thread: unknown;
  initialTurnsPage?: { data?: unknown[] } | null;
}): string[] {
  const pagedTurns = response.initialTurnsPage?.data;
  return readActiveCodexTurnIds(
    Array.isArray(pagedTurns) ? { turns: pagedTurns } : response.thread,
  );
}

const LEGACY_EMPTY_DYNAMIC_TOOLS_FINGERPRINT = legacyFingerprintDynamicTools([]);
const EMPTY_DYNAMIC_TOOLS_FINGERPRINT = hashCodexAppServerBindingFingerprint(
  LEGACY_EMPTY_DYNAMIC_TOOLS_FINGERPRINT,
);

export function areDynamicToolFingerprintsCompatible(
  previous: string | undefined,
  next: string,
  nextLegacy?: string,
): boolean {
  return !previous || previous === next || previous === nextLegacy;
}

export function areUserMcpServersFingerprintsCompatible(params: {
  previous?: string;
  next?: string;
  nextLegacy?: string;
}): boolean {
  // Beta 5 stored raw stabilized JSON, while doctor hashes those exact bytes.
  // A successful resume rewrites either legacy form to the current redacted hash.
  return (
    params.previous === params.next ||
    params.previous === params.nextLegacy ||
    (params.nextLegacy !== undefined &&
      params.previous === hashCodexAppServerBindingFingerprint(params.nextLegacy))
  );
}

export function shouldStartTransientNoToolThread(params: {
  previous: string | undefined;
  nextHasDynamicTools: boolean;
}): boolean {
  return Boolean(
    params.previous &&
    !isEmptyDynamicToolsFingerprint(params.previous) &&
    !params.nextHasDynamicTools,
  );
}

function isEmptyDynamicToolsFingerprint(fingerprint: string): boolean {
  return (
    fingerprint === EMPTY_DYNAMIC_TOOLS_FINGERPRINT ||
    fingerprint === LEGACY_EMPTY_DYNAMIC_TOOLS_FINGERPRINT
  );
}

function compareJsonFingerprint(left: JsonValue, right: JsonValue): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}
