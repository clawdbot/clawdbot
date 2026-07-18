// Config gateway methods: validation, redaction, secrets, reload planning.
import { isDeepStrictEqual } from "node:util";
import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateConfigApplyParams,
  validateConfigGetParams,
  validateConfigPatchParams,
  validateConfigSchemaLookupParams,
  validateConfigSchemaLookupResult,
  validateConfigSchemaParams,
  validateConfigSetParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  createConfigIO,
  parseConfigJson5,
  readConfigFileSnapshot,
  readConfigFileSnapshotForWrite,
  resolveConfigSnapshotHash,
} from "../../config/io.js";
import { createMergePatch, projectSourceOntoRuntimeShape } from "../../config/io.write-prepare.js";
import { formatConfigIssueLines } from "../../config/issue-format.js";
import { applyMergePatch, isMergePatchObjectKeyAllowed } from "../../config/merge-patch.js";
import { normalizeConfigPatchReplacePaths } from "../../config/patch-replace-paths.js";
import { redactConfigObject, restoreRedactedValues } from "../../config/redact-snapshot.js";
import { loadGatewayRuntimeConfigSchema } from "../../config/runtime-schema.js";
import { lookupConfigSchema, type ConfigSchemaResponse } from "../../config/schema.js";
import type { ConfigValidationIssue, OpenClawConfig } from "../../config/types.openclaw.js";
import {
  validateConfigObjectRawWithPlugins,
  validateConfigObjectWithPlugins,
} from "../../config/validation.js";
import { isBuiltInModelProviderOverlayId } from "../../config/zod-schema.core.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { isPlainObject } from "../../infra/plain-object.js";
import {
  prepareSecretsRuntimeSnapshot,
  type PreparedSecretsRuntimeSnapshot,
} from "../../secrets/runtime.js";
import { diffConfigPaths } from "../config-diff.js";
import { createConfigGetResponse } from "../config-get-response.js";
import { resolveConfigReloadMetadata } from "../config-reload-plan.js";
import {
  formatControlPlaneActor,
  resolveControlPlaneActor,
  summarizeChangedPaths,
} from "../control-plane-audit.js";
import { resolveBaseHashParam } from "./base-hash.js";
import {
  commitGatewayConfigWrite,
  didActiveSharedGatewayAuthChange,
  didSharedGatewayAuthChange,
  resolveGatewayConfigPath,
  resolveGatewayConfigRestartWriteResult,
} from "./config-write-flow.js";
import {
  execOpenPath,
  formatOpenPathError,
  isHeadlessOpenPathError,
  resolveOpenPathCommand,
  sanitizePathForLog,
} from "./open-path.js";
import type { GatewayRequestContext, GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

const MAX_CONFIG_ISSUES_IN_ERROR_MESSAGE = 3;
const CONFIG_SCHEMA_RESPONSE_CACHE_TTL_MS = 5_000;

let configSchemaResponseCache: {
  expiresAtMs: number;
  response: ConfigSchemaResponse;
} | null = null;

type ConfigRedactionHints = Parameters<typeof redactConfigObject>[1];
type ConfigWriteCommitResult = Awaited<ReturnType<typeof commitGatewayConfigWrite>>;
type ConfigRestartWriteKind = Parameters<typeof resolveGatewayConfigRestartWriteResult>[0]["kind"];
type ConfigRestartWriteMode = Parameters<typeof resolveGatewayConfigRestartWriteResult>[0]["mode"];

function requireConfigBaseHash(
  params: unknown,
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>,
  respond: RespondFn,
): boolean {
  if (!snapshot.exists) {
    return true;
  }
  const snapshotHash = resolveConfigSnapshotHash(snapshot);
  if (!snapshotHash) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "config base hash unavailable; re-run config.get and retry",
      ),
    );
    return false;
  }
  const baseHash = resolveBaseHashParam(params);
  if (!baseHash) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "config base hash required; re-run config.get and retry",
      ),
    );
    return false;
  }
  if (baseHash !== snapshotHash) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "config changed since last load; re-run config.get and retry",
      ),
    );
    return false;
  }
  return true;
}

function formatConfigPatchPath(parentPath: string, key: string): string {
  return parentPath ? `${parentPath}.${key}` : key;
}

function readConfigPatchReplacePaths(params: unknown): Set<string> {
  const rawPaths = (params as { replacePaths?: unknown }).replacePaths;
  return normalizeConfigPatchReplacePaths(Array.isArray(rawPaths) ? rawPaths : undefined);
}

function collectDestructiveArrayPatchPaths(params: {
  base: unknown;
  patch: unknown;
  merged: unknown;
  path?: string;
}): string[] {
  if (!isPlainObject(params.patch) || !isPlainObject(params.base)) {
    return [];
  }

  const merged = isPlainObject(params.merged) ? params.merged : {};
  const paths: string[] = [];
  for (const [key, patchValue] of Object.entries(params.patch)) {
    const path = formatConfigPatchPath(params.path ?? "", key);
    if (!isMergePatchObjectKeyAllowed(key, params.path)) {
      continue;
    }
    const baseValue = params.base[key];
    const mergedValue = merged[key];

    if (Array.isArray(baseValue)) {
      if (patchValue === null || !Array.isArray(patchValue)) {
        paths.push(path);
        continue;
      }
      if (Array.isArray(mergedValue)) {
        if (isConfigPatchIdKeyedArray(baseValue)) {
          if (!idKeyedArrayPreservesBaseIds(baseValue, mergedValue)) {
            paths.push(path);
            continue;
          }
          paths.push(
            ...collectDestructiveIdKeyedArrayEntryPatchPaths({
              base: baseValue,
              patch: patchValue,
              merged: mergedValue,
              path,
            }),
          );
        } else if (!arrayPreservesBaseEntries(baseValue, mergedValue)) {
          paths.push(path);
          continue;
        }
      }
    } else if (isPlainObject(baseValue) && !isPlainObject(patchValue)) {
      paths.push(...collectBaseArrayPaths(baseValue, path));
      continue;
    }

    if (isPlainObject(patchValue)) {
      paths.push(
        ...collectDestructiveArrayPatchPaths({
          base: baseValue,
          patch: patchValue,
          merged: mergedValue,
          path,
        }),
      );
    }
  }
  return paths;
}

function collectBaseArrayPaths(base: unknown, path: string): string[] {
  if (Array.isArray(base)) {
    return [path];
  }
  if (!isPlainObject(base)) {
    return [];
  }
  const paths: string[] = [];
  for (const [key, value] of Object.entries(base)) {
    const childPath = formatConfigPatchPath(path, key);
    if (!isMergePatchObjectKeyAllowed(key, path)) {
      continue;
    }
    paths.push(...collectBaseArrayPaths(value, childPath));
  }
  return paths;
}

function isConfigPatchObjectWithStringId(
  value: unknown,
): value is Record<string, unknown> & { id: string } {
  return isPlainObject(value) && typeof value.id === "string" && value.id.length > 0;
}

function isConfigPatchIdKeyedArray(
  value: unknown[],
): value is Array<Record<string, unknown> & { id: string }> {
  return value.every(isConfigPatchObjectWithStringId);
}

function idKeyedArrayPreservesBaseIds(
  base: Array<Record<string, unknown> & { id: string }>,
  merged: unknown[],
): boolean {
  const mergedIds = new Set(
    merged.filter(isConfigPatchObjectWithStringId).map((entry) => entry.id),
  );
  return base.every((entry) => mergedIds.has(entry.id));
}

function arrayPreservesBaseEntries(base: unknown[], merged: unknown[]): boolean {
  const unmatchedMerged = [...merged];
  for (const baseEntry of base) {
    const matchIndex = unmatchedMerged.findIndex((mergedEntry) =>
      isDeepStrictEqual(mergedEntry, baseEntry),
    );
    if (matchIndex === -1) {
      return false;
    }
    unmatchedMerged.splice(matchIndex, 1);
  }
  return true;
}

function collectDestructiveIdKeyedArrayEntryPatchPaths(params: {
  base: unknown[];
  patch: unknown[];
  merged: unknown[];
  path: string;
}): string[] {
  if (!isConfigPatchIdKeyedArray(params.base)) {
    return [];
  }
  const baseById = new Map(params.base.map((entry) => [entry.id, entry]));
  const mergedById = new Map(
    params.merged.filter(isConfigPatchObjectWithStringId).map((entry) => [entry.id, entry]),
  );
  const paths: string[] = [];
  for (const patchEntry of params.patch) {
    if (!isConfigPatchObjectWithStringId(patchEntry)) {
      continue;
    }
    const baseEntry = baseById.get(patchEntry.id);
    const mergedEntry = mergedById.get(patchEntry.id);
    if (!baseEntry || !mergedEntry) {
      continue;
    }
    paths.push(
      ...collectDestructiveArrayPatchPaths({
        base: baseEntry,
        patch: patchEntry,
        merged: mergedEntry,
        path: `${params.path}[]`,
      }),
    );
  }
  return paths;
}

function rejectDestructiveArrayPatchWithoutIntent(params: {
  currentConfig: OpenClawConfig;
  mergedConfig: unknown;
  patch: unknown;
  replacePaths: Set<string>;
  respond: RespondFn;
}): boolean {
  const destructivePaths = collectDestructiveArrayPatchPaths({
    base: params.currentConfig,
    patch: params.patch,
    merged: params.mergedConfig,
  });
  const unconfirmedPaths = destructivePaths.filter((path) => !params.replacePaths.has(path));
  if (unconfirmedPaths.length === 0) {
    return false;
  }
  params.respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      `config.patch would remove entries from array path(s): ${unconfirmedPaths.join(", ")}. ` +
        `Pass replacePaths with the exact path(s) when this is intentional, or use config.apply for full-config replacement.`,
    ),
  );
  return true;
}

async function readConfigWriteSnapshotOrRespond(
  params: unknown,
  respond: RespondFn,
): Promise<Awaited<ReturnType<typeof readConfigFileSnapshotForWrite>> | null> {
  const result = await readConfigFileSnapshotForWrite();
  if (!requireConfigBaseHash(params, result.snapshot, respond)) {
    return null;
  }
  return result;
}

function parseRawConfigOrRespond(
  params: unknown,
  requestName: string,
  respond: RespondFn,
): string | null {
  const rawValue = (params as { raw?: unknown }).raw;
  if (typeof rawValue !== "string") {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `invalid ${requestName} params: raw (string) required`,
      ),
    );
    return null;
  }
  return rawValue;
}

function hasOwnRecordValue(value: unknown, key: string): boolean {
  return isRecord(value) && Object.hasOwn(value, key);
}

function stripBundledProviderRuntimeDefaults(params: {
  candidate: unknown;
  sourceConfig: unknown;
}): unknown {
  if (!isRecord(params.candidate)) {
    return params.candidate;
  }
  const models = params.candidate.models;
  if (!isRecord(models) || !isRecord(models.providers)) {
    return params.candidate;
  }
  const sourceModels = isRecord(params.sourceConfig) ? params.sourceConfig.models : undefined;
  const sourceProviders = isRecord(sourceModels) ? sourceModels.providers : undefined;

  let nextProviders: Record<string, unknown> | undefined;
  for (const [providerId, provider] of Object.entries(models.providers)) {
    // Runtime overlays can materialize empty defaults that should not become persisted config.
    if (!isBuiltInModelProviderOverlayId(providerId) || !isRecord(provider)) {
      continue;
    }
    const sourceProvider = isRecord(sourceProviders) ? sourceProviders[providerId] : undefined;
    let nextProvider: Record<string, unknown> | undefined;
    if (provider.baseUrl === "" && !hasOwnRecordValue(sourceProvider, "baseUrl")) {
      nextProvider = { ...provider };
      delete nextProvider.baseUrl;
    }
    if (
      Array.isArray(provider.models) &&
      provider.models.length === 0 &&
      !hasOwnRecordValue(sourceProvider, "models")
    ) {
      nextProvider ??= { ...provider };
      delete nextProvider.models;
    }
    if (nextProvider) {
      nextProviders ??= { ...models.providers };
      nextProviders[providerId] = nextProvider;
    }
  }
  if (!nextProviders) {
    return params.candidate;
  }
  return {
    ...params.candidate,
    models: {
      ...models,
      providers: nextProviders,
    },
  };
}

function parseValidateConfigFromRawOrRespond(
  params: unknown,
  requestName: string,
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>,
  respond: RespondFn,
): { config: OpenClawConfig; writeConfig: OpenClawConfig; schema: ConfigSchemaResponse } | null {
  const rawValue = parseRawConfigOrRespond(params, requestName, respond);
  if (!rawValue) {
    return null;
  }
  const parsedRes = parseConfigJson5(rawValue);
  if (!parsedRes.ok) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, parsedRes.error));
    return null;
  }
  const schema = loadSchemaWithPlugins();
  const restored = restoreRedactedValues(parsedRes.parsed, snapshot.config, schema.uiHints);
  if (!restored.ok) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, restored.humanReadableMessage ?? "invalid config"),
    );
    return null;
  }
  // Validate against runtime shape, but write the source-shaped config the operator submitted.
  const projectedValidationCandidate = snapshot.valid
    ? applyMergePatch(
        projectSourceOntoRuntimeShape(snapshot.resolved, snapshot.config),
        createMergePatch(snapshot.config, restored.result),
      )
    : restored.result;
  const validationCandidate = stripBundledProviderRuntimeDefaults({
    candidate: projectedValidationCandidate,
    sourceConfig: snapshot.sourceConfig,
  });
  const sourceValidated = validateConfigObjectRawWithPlugins(validationCandidate);
  if (!sourceValidated.ok) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        summarizeConfigValidationIssues(sourceValidated.issues),
        {
          details: { issues: sourceValidated.issues },
        },
      ),
    );
    return null;
  }
  const validated = validateConfigObjectWithPlugins(validationCandidate);
  if (!validated.ok) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, summarizeConfigValidationIssues(validated.issues), {
        details: { issues: validated.issues },
      }),
    );
    return null;
  }
  return {
    config: validated.config,
    writeConfig: validationCandidate as OpenClawConfig,
    schema,
  };
}

function summarizeConfigValidationIssues(issues: ReadonlyArray<ConfigValidationIssue>): string {
  const trimmed = issues.slice(0, MAX_CONFIG_ISSUES_IN_ERROR_MESSAGE);
  const lines = normalizeStringEntries(
    formatConfigIssueLines(trimmed, "", { normalizeRoot: true }),
  );
  if (lines.length === 0) {
    return "invalid config";
  }
  const hiddenCount = Math.max(0, issues.length - lines.length);
  return `invalid config: ${lines.join("; ")}${
    hiddenCount > 0 ? ` (+${hiddenCount} more issue${hiddenCount === 1 ? "" : "s"})` : ""
  }`;
}

async function ensureResolvableSecretRefsOrRespond(params: {
  config: OpenClawConfig;
  respond: RespondFn;
}): Promise<PreparedSecretsRuntimeSnapshot | null> {
  try {
    return await prepareSecretsRuntimeSnapshot({
      config: params.config,
      includeAuthStoreRefs: false,
    });
  } catch (error) {
    const details = formatErrorMessage(error);
    params.respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `invalid config: active SecretRef resolution failed (${details})`,
      ),
    );
    return null;
  }
}

export function clearConfigSchemaResponseCacheForTests() {
  configSchemaResponseCache = null;
}

export function loadConfigSchemaResponseForTests(): ConfigSchemaResponse {
  return loadSchemaWithPlugins();
}

function clearConfigSchemaResponseCache() {
  configSchemaResponseCache = null;
}

/**
 * Hash-only change notice so connected operator clients can refresh their
 * config snapshot (e.g. live ui.prefs sync after an agent-approved write).
 * Config content never rides the event; readers fetch via config.get.
 */
function broadcastConfigChanged(
  context: GatewayRequestContext | undefined,
  writeResult: Pick<ConfigWriteCommitResult, "path" | "hash">,
): void {
  // Test doubles and embedded hosts may omit broadcast; the notice is
  // best-effort either way.
  context?.broadcast?.(
    "config.changed",
    {
      path: writeResult.path,
      hash: writeResult.hash ?? null,
      ts: Date.now(),
    },
    { dropIfSlow: true },
  );
}

async function respondWithConfigRestartWrite(params: {
  requestParams: unknown;
  kind: ConfigRestartWriteKind;
  mode: ConfigRestartWriteMode;
  writeResult: ConfigWriteCommitResult;
  changedPaths: string[];
  actor: ReturnType<typeof resolveControlPlaneActor>;
  context: GatewayRequestContext | undefined;
  respond: RespondFn;
  uiHints: ConfigRedactionHints;
}): Promise<void> {
  clearConfigSchemaResponseCache();
  const { payload, sentinelPersisted, restart } = await resolveGatewayConfigRestartWriteResult({
    requestParams: params.requestParams,
    kind: params.kind,
    mode: params.mode,
    configPath: params.writeResult.path,
    changedPaths: params.changedPaths,
    nextConfig: params.writeResult.config,
    actor: params.actor,
    context: params.context,
  });
  params.respond(
    true,
    {
      ok: true,
      path: params.writeResult.path,
      // Additive ack hash: matches the hash config.get would report for the
      // persisted bytes, so writers can adopt it without a reload.
      ...(params.writeResult.hash ? { hash: params.writeResult.hash } : {}),
      config: redactConfigObject(params.writeResult.config, params.uiHints),
      restart,
      sentinel: {
        persisted: sentinelPersisted,
        payload,
      },
    },
    undefined,
  );
  broadcastConfigChanged(params.context, params.writeResult);
  params.writeResult.queueFollowUp();
}

function shouldDisconnectSharedAuthClientsForConfigWrite(params: {
  prevConfig: OpenClawConfig;
  nextConfig: OpenClawConfig;
  preparedSecretsSnapshot: PreparedSecretsRuntimeSnapshot;
}): boolean {
  return (
    didSharedGatewayAuthChange(params.prevConfig, params.nextConfig) ||
    didActiveSharedGatewayAuthChange({
      fallbackPrev: params.prevConfig,
      next: params.preparedSecretsSnapshot.config,
    })
  );
}

function respondConfigPatchNoop(params: {
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>;
  config: OpenClawConfig;
  uiHints: ConfigRedactionHints;
  actor: ReturnType<typeof resolveControlPlaneActor>;
  context: GatewayRequestContext | undefined;
  respond: RespondFn;
}): void {
  params.context?.logGateway?.info(
    `config.patch noop ${formatControlPlaneActor(params.actor)} (no changed paths)`,
  );
  params.respond(
    true,
    {
      ok: true,
      noop: true,
      path: resolveGatewayConfigPath(params.snapshot),
      config: redactConfigObject(params.config, params.uiHints),
    },
    undefined,
  );
}

function loadSchemaWithPlugins(): ConfigSchemaResponse {
  const now = asDateTimestampMs(Date.now());
  const cachedExpiresAt =
    configSchemaResponseCache === null
      ? undefined
      : asDateTimestampMs(configSchemaResponseCache.expiresAtMs);
  if (
    configSchemaResponseCache &&
    now !== undefined &&
    cachedExpiresAt !== undefined &&
    cachedExpiresAt > now
  ) {
    return configSchemaResponseCache.response;
  }
  if (configSchemaResponseCache) {
    configSchemaResponseCache = null;
  }

  // Plugin schema loading is process-local; short caching avoids repeated UI lookups per render.
  const response = loadGatewayRuntimeConfigSchema();
  const expiresAtMs = resolveExpiresAtMsFromDurationMs(CONFIG_SCHEMA_RESPONSE_CACHE_TTL_MS);
  if (expiresAtMs !== undefined) {
    configSchemaResponseCache = {
      expiresAtMs,
      response,
    };
  }
  return response;
}

export const configHandlers: GatewayRequestHandlers = {
  "config.get": async ({ params, respond }) => {
    if (!assertValidParams(params, validateConfigGetParams, "config.get", respond)) {
      return;
    }
    const snapshot = await readConfigFileSnapshot();
    const schema = loadSchemaWithPlugins();
    respond(true, createConfigGetResponse(snapshot, schema.uiHints), undefined);
  },
  "config.schema": ({ params, respond }) => {
    if (!assertValidParams(params, validateConfigSchemaParams, "config.schema", respond)) {
      return;
    }
    respond(true, loadSchemaWithPlugins(), undefined);
  },
  "config.schema.lookup": ({ params, respond, context }) => {
    if (
      !assertValidParams(params, validateConfigSchemaLookupParams, "config.schema.lookup", respond)
    ) {
      return;
    }
    const path = (params as { path: string }).path;
    const schema = loadSchemaWithPlugins();
    const result = lookupConfigSchema(schema, path, resolveConfigReloadMetadata);
    if (!result) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "config schema path not found"),
      );
      return;
    }
    if (!validateConfigSchemaLookupResult(result)) {
      const errors = validateConfigSchemaLookupResult.errors ?? [];
      context.logGateway.warn(
        `config.schema.lookup produced invalid payload for ${sanitizePathForLog(path)}: ${formatValidationErrors(errors)}`,
      );
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "config.schema.lookup returned invalid payload", {
          details: { errors },
        }),
      );
      return;
    }
    respond(true, result, undefined);
  },
  "config.set": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateConfigSetParams, "config.set", respond)) {
      return;
    }
    const writeSnapshot = await readConfigWriteSnapshotOrRespond(params, respond);
    if (!writeSnapshot) {
      return;
    }
    const { snapshot, writeOptions } = writeSnapshot;
    const parsed = parseValidateConfigFromRawOrRespond(params, "config.set", snapshot, respond);
    if (!parsed) {
      return;
    }
    if (!(await ensureResolvableSecretRefsOrRespond({ config: parsed.config, respond }))) {
      return;
    }
    const writeResult = await commitGatewayConfigWrite({
      snapshot,
      writeOptions,
      nextConfig: parsed.writeConfig,
      context,
    });
    clearConfigSchemaResponseCache();
    respond(
      true,
      {
        ok: true,
        path: writeResult.path,
        // Additive ack hash: matches the hash config.get would report for the
        // persisted bytes, so writers can adopt it without a reload.
        ...(writeResult.hash ? { hash: writeResult.hash } : {}),
        config: redactConfigObject(writeResult.config, parsed.schema.uiHints),
      },
      undefined,
    );
    broadcastConfigChanged(context, writeResult);
    writeResult.queueFollowUp();
  },
  "config.patch": async ({ params, respond, client, context }) => {
    if (!assertValidParams(params, validateConfigPatchParams, "config.patch", respond)) {
      return;
    }
    const writeSnapshot = await readConfigWriteSnapshotOrRespond(params, respond);
    if (!writeSnapshot) {
      return;
    }
    const { snapshot, writeOptions } = writeSnapshot;
    if (!snapshot.valid) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid config; fix before patching"),
      );
      return;
    }
    const rawValue = (params as { raw?: unknown }).raw;
    if (typeof rawValue !== "string") {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "invalid config.patch params: raw (string) required",
        ),
      );
      return;
    }
    const parsedRes = parseConfigJson5(rawValue);
    if (!parsedRes.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, parsedRes.error));
      return;
    }
    if (
      !parsedRes.parsed ||
      typeof parsedRes.parsed !== "object" ||
      Array.isArray(parsedRes.parsed)
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "config.patch raw must be an object"),
      );
      return;
    }
    const replacePaths = readConfigPatchReplacePaths(params);
    const merged = applyMergePatch(snapshot.config, parsedRes.parsed, {
      // Arrays with stable ids behave like maps for partial control-plane edits.
      mergeObjectArraysById: true,
      replaceArrayPaths: replacePaths,
    });
    const schemaPatch = loadSchemaWithPlugins();
    const restoredMerge = restoreRedactedValues(merged, snapshot.config, schemaPatch.uiHints);
    if (!restoredMerge.ok) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          restoredMerge.humanReadableMessage ?? "invalid config",
        ),
      );
      return;
    }
    if (
      rejectDestructiveArrayPatchWithoutIntent({
        currentConfig: snapshot.config,
        mergedConfig: restoredMerge.result,
        patch: parsedRes.parsed,
        replacePaths,
        respond,
      })
    ) {
      return;
    }
    const restoredChangedPaths = diffConfigPaths(snapshot.config, restoredMerge.result);
    const actor = resolveControlPlaneActor(client);
    if (restoredChangedPaths.length === 0) {
      respondConfigPatchNoop({
        snapshot,
        config: snapshot.config,
        uiHints: schemaPatch.uiHints,
        actor,
        context,
        respond,
      });
      return;
    }
    const validationCandidate = stripBundledProviderRuntimeDefaults({
      candidate: restoredMerge.result,
      sourceConfig: snapshot.sourceConfig,
    });
    const sourceValidated = validateConfigObjectRawWithPlugins(validationCandidate);
    if (!sourceValidated.ok) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          summarizeConfigValidationIssues(sourceValidated.issues),
          {
            details: { issues: sourceValidated.issues },
          },
        ),
      );
      return;
    }
    const writeConfig = validationCandidate as OpenClawConfig;
    const validated = validateConfigObjectWithPlugins(validationCandidate);
    if (!validated.ok) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, summarizeConfigValidationIssues(validated.issues), {
          details: { issues: validated.issues },
        }),
      );
      return;
    }
    const preparedSecretsSnapshot = await ensureResolvableSecretRefsOrRespond({
      config: validated.config,
      respond,
    });
    if (!preparedSecretsSnapshot) {
      return;
    }
    const changedPaths = diffConfigPaths(snapshot.config, validated.config);

    // No-op: if the validated config is identical to the current config,
    // skip the file write and SIGUSR1 restart entirely. This avoids a full
    // gateway restart (and the resulting connection drop) when a control-plane
    // client re-sends the same config (e.g. hot-apply with no actual changes).
    if (changedPaths.length === 0) {
      respondConfigPatchNoop({
        snapshot,
        config: validated.config,
        uiHints: schemaPatch.uiHints,
        actor,
        context,
        respond,
      });
      return;
    }

    context?.logGateway?.info(
      `config.patch write ${formatControlPlaneActor(actor)} changedPaths=${summarizeChangedPaths(changedPaths)} restartReason=config.patch`,
    );
    // Compare before the write so we invalidate clients authenticated against the
    // previous shared secret immediately after the config update succeeds.
    const disconnectSharedAuthClients = shouldDisconnectSharedAuthClientsForConfigWrite({
      prevConfig: snapshot.config,
      nextConfig: validated.config,
      preparedSecretsSnapshot,
    });
    const writeResult = await commitGatewayConfigWrite({
      snapshot,
      writeOptions,
      nextConfig: writeConfig,
      context,
      disconnectSharedAuthClients,
    });
    await respondWithConfigRestartWrite({
      requestParams: params,
      kind: "config-patch",
      mode: "config.patch",
      writeResult,
      changedPaths,
      actor,
      context,
      respond,
      uiHints: schemaPatch.uiHints,
    });
  },
  "config.apply": async ({ params, respond, client, context }) => {
    if (!assertValidParams(params, validateConfigApplyParams, "config.apply", respond)) {
      return;
    }
    const writeSnapshot = await readConfigWriteSnapshotOrRespond(params, respond);
    if (!writeSnapshot) {
      return;
    }
    const { snapshot, writeOptions } = writeSnapshot;
    const parsed = parseValidateConfigFromRawOrRespond(params, "config.apply", snapshot, respond);
    if (!parsed) {
      return;
    }
    const preparedSecretsSnapshot = await ensureResolvableSecretRefsOrRespond({
      config: parsed.config,
      respond,
    });
    if (!preparedSecretsSnapshot) {
      return;
    }
    const changedPaths = diffConfigPaths(snapshot.config, parsed.config);
    const actor = resolveControlPlaneActor(client);
    context?.logGateway?.info(
      `config.apply write ${formatControlPlaneActor(actor)} changedPaths=${summarizeChangedPaths(changedPaths)} restartReason=config.apply`,
    );
    // Compare before the write so we invalidate clients authenticated against the
    // previous shared secret immediately after the config update succeeds.
    const disconnectSharedAuthClients = shouldDisconnectSharedAuthClientsForConfigWrite({
      prevConfig: snapshot.config,
      nextConfig: parsed.config,
      preparedSecretsSnapshot,
    });
    const writeResult = await commitGatewayConfigWrite({
      snapshot,
      writeOptions,
      nextConfig: parsed.writeConfig,
      context,
      disconnectSharedAuthClients,
    });
    await respondWithConfigRestartWrite({
      requestParams: params,
      kind: "config-apply",
      mode: "config.apply",
      writeResult,
      changedPaths,
      actor,
      context,
      respond,
      uiHints: parsed.schema.uiHints,
    });
  },
  "config.openFile": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateConfigGetParams, "config.openFile", respond)) {
      return;
    }
    const configPath = createConfigIO().configPath;
    try {
      await execOpenPath(resolveOpenPathCommand(configPath));
      respond(true, { ok: true, path: configPath }, undefined);
    } catch (error) {
      const errorMessage = formatOpenPathError(error);
      const isHeadlessError = isHeadlessOpenPathError(errorMessage);
      const detailedError = isHeadlessError
        ? `Cannot open file in headless environment. File path: ${configPath}. This environment appears to lack a graphical or terminal browser handler.`
        : `Failed to open config file: ${errorMessage}`;
      context?.logGateway?.warn(
        `config.openFile failed path=${sanitizePathForLog(configPath)}: ${errorMessage}`,
      );
      respond(true, { ok: false, path: configPath, error: detailedError }, undefined);
    }
  },
};
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
