// Config gateway methods: validation, redaction, secrets, reload planning.
import { isDeepStrictEqual } from "node:util";
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
import { readAgentRosterProperty } from "../../agents/agent-scope-config.js";
import {
  createConfigIoContext,
  resolveModelIdNormalizationPolicies,
} from "../../config/io.context.js";
import {
  createConfigIO,
  parseConfigJson5,
  readConfigFileSnapshot,
  readConfigFileSnapshotForWrite,
  resolveConfigSnapshotHash,
} from "../../config/io.js";
import { formatConfigIssueLines } from "../../config/issue-format.js";
import {
  applyMergePatch,
  createMergePatch,
  isMergePatchObjectKeyAllowed,
} from "../../config/merge-patch.js";
import { normalizeSubmittedConfigModelRefs } from "../../config/model-input-normalization.js";
import { ConfigMutationConflictError } from "../../config/mutation-conflict.js";
import { normalizeConfigPatchReplacePaths } from "../../config/patch-replace-paths.js";
import { redactConfigObject, restoreRedactedValues } from "../../config/redact-snapshot.js";
import { loadGatewayRuntimeConfigSchema } from "../../config/runtime-schema.js";
import { projectSourceOntoRuntimeShape } from "../../config/runtime-source-projection.js";
import { lookupConfigSchema, type ConfigSchemaResponse } from "../../config/schema.js";
import type { ConfigValidationIssue, OpenClawConfig } from "../../config/types.openclaw.js";
import {
  validateConfigObjectRawWithPlugins,
  validateConfigObjectWithPlugins,
} from "../../config/validation.js";
import { isBuiltInModelProviderOverlayId } from "../../config/zod-schema.core.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { isPlainObject } from "../../infra/plain-object.js";
import type { PreparedPluginMetadata } from "../../plugins/plugin-metadata-collection.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import {
  isRetryableSecretDegradationReason,
  redactSecretDegradationReason,
} from "../../secrets/runtime-degraded-state.js";
import {
  prepareSecretsRuntimeSnapshot,
  type PreparedSecretsRuntimeSnapshot,
} from "../../secrets/runtime.js";
import { diffConfigPaths } from "../config-diff.js";
import { readConfigGetResponse } from "../config-get-response.js";
import { resolveConfigReloadMetadata } from "../config-reload-plan.js";
import type { GatewayConfigRevisionProjector } from "../config-revision-token.js";
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
  shouldAwaitGatewayConfigApplication,
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
// ui.prefs is the cross-device Control UI preference surface documented in docs/web/control-ui.md.
// Leaf preferences are LWW so independent tabs/devices do not CAS-conflict on the whole config;
// every other path keeps strict document CAS.
const HASHLESS_PATCH_LWW_PATH_PREFIXES = ["ui.prefs"] as const;

type ConfigRedactionHints = Parameters<typeof redactConfigObject>[1];
type ConfigWriteCommitResult = Awaited<ReturnType<typeof commitGatewayConfigWrite>>;
type ConfigRestartWriteKind = Parameters<typeof resolveGatewayConfigRestartWriteResult>[0]["kind"];
type ConfigRestartWriteMode = Parameters<typeof resolveGatewayConfigRestartWriteResult>[0]["mode"];

function requireConfigBaseHash(
  params: unknown,
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>,
  respond: RespondFn,
  revisionProjector: GatewayConfigRevisionProjector,
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
  if (baseHash !== revisionProjector.projectRawHash(snapshotHash)) {
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

function assertNoDuplicateConfigPatchIds(params: {
  patch: unknown;
  current: unknown;
  replacePaths: ReadonlySet<string>;
  path?: string;
}): void {
  const path = params.path ?? "";
  if (Array.isArray(params.patch)) {
    if (
      !Array.isArray(params.current) ||
      params.replacePaths.has(path) ||
      !isConfigPatchIdKeyedArray(params.current)
    ) {
      return;
    }
    // ID-keyed merge is sequential and would silently let the last duplicate win.
    // Reject only arrays using that merge contract; explicit replacements may contain duplicates.
    const currentIds = new Set<string>();
    for (const entry of params.current) {
      if (currentIds.has(entry.id)) {
        throw new Error(
          `Cannot ID-merge array at ${path || "<root>"}: current config contains duplicate ID ${entry.id}; use replacePaths for an explicit replacement.`,
        );
      }
      currentIds.add(entry.id);
    }
    const ids = new Set<string>();
    for (const entry of params.patch) {
      if (!isConfigPatchObjectWithStringId(entry)) {
        continue;
      }
      if (ids.has(entry.id)) {
        throw new Error(`Ambiguous duplicate ID ${entry.id} in array at ${path || "<root>"}.`);
      }
      ids.add(entry.id);
    }
    const currentById = new Map(params.current.map((entry) => [entry.id, entry] as const));
    for (const entry of params.patch) {
      if (!isConfigPatchObjectWithStringId(entry)) {
        continue;
      }
      const currentEntry = currentById.get(entry.id);
      if (currentEntry) {
        assertNoDuplicateConfigPatchIds({
          patch: entry,
          current: currentEntry,
          replacePaths: params.replacePaths,
          path: `${path}[]`,
        });
      }
    }
    return;
  }
  if (!isRecord(params.patch) || !isRecord(params.current)) {
    return;
  }
  for (const [key, child] of Object.entries(params.patch)) {
    assertNoDuplicateConfigPatchIds({
      patch: child,
      current: params.current[key],
      replacePaths: params.replacePaths,
      path: formatConfigPatchPath(path, key),
    });
  }
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
  revisionProjector: GatewayConfigRevisionProjector,
): Promise<Awaited<ReturnType<typeof readConfigFileSnapshotForWrite>> | null> {
  const result = await readConfigFileSnapshotForWrite();
  if (!requireConfigBaseHash(params, result.snapshot, respond, revisionProjector)) {
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
  modelIdNormalizationPolicies?: Parameters<typeof normalizeSubmittedConfigModelRefs>[1],
): {
  config: OpenClawConfig;
  writeConfig: OpenClawConfig;
  schema: ConfigSchemaResponse;
  pluginMetadata?: PreparedPluginMetadata;
} | null {
  const rawValue = parseRawConfigOrRespond(params, requestName, respond);
  if (!rawValue) {
    return null;
  }
  const parsedRes = parseConfigJson5(rawValue);
  if (!parsedRes.ok) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, parsedRes.error));
    return null;
  }
  const schema = loadGatewayRuntimeConfigSchema();
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
  const validatedSubmission = validateSubmittedConfigOrRespond({
    candidate: projectedValidationCandidate,
    sourceConfig: snapshot.sourceConfig,
    modelIdNormalizationPolicies,
    respond,
  });
  if (!validatedSubmission) {
    return null;
  }
  return {
    config: validatedSubmission.config,
    writeConfig: validatedSubmission.validationCandidate,
    schema,
    pluginMetadata: validatedSubmission.pluginMetadata,
  };
}

function listExplicitAgentRosterIds(config: OpenClawConfig): string[] {
  const roster = readAgentRosterProperty(config);
  if (roster?.kind === "entries" && isRecord(roster.value)) {
    return Object.keys(roster.value);
  }
  if (roster?.kind !== "list" || !Array.isArray(roster.value)) {
    return [];
  }
  return roster.value.flatMap((entry) =>
    isRecord(entry) && typeof entry.id === "string" ? [entry.id] : [],
  );
}

function rejectDroppedAgentRosterEntries(params: {
  currentConfig: OpenClawConfig;
  submittedConfig: OpenClawConfig;
  respond: RespondFn;
}): boolean {
  const submittedIds = new Set(
    listExplicitAgentRosterIds(params.submittedConfig).map((agentId) => normalizeAgentId(agentId)),
  );
  const droppedIds = listExplicitAgentRosterIds(params.currentConfig)
    .filter((agentId) => !submittedIds.has(normalizeAgentId(agentId)))
    .toSorted();
  if (droppedIds.length === 0) {
    return false;
  }
  params.respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      `config.set would remove existing agent entries: ${droppedIds.join(", ")}. ` +
        "Use the agents.delete RPC or `openclaw agents delete <id>` for intentional deletion.",
    ),
  );
  return true;
}

/** Shared normalize -> raw-validate -> plugin-validate pipeline for submitted configs; responds on failure. */
function validateSubmittedConfigOrRespond(params: {
  candidate: unknown;
  sourceConfig: OpenClawConfig | undefined;
  modelIdNormalizationPolicies: Parameters<typeof normalizeSubmittedConfigModelRefs>[1];
  respond: RespondFn;
}): {
  validationCandidate: OpenClawConfig;
  config: OpenClawConfig;
  pluginMetadata?: PreparedPluginMetadata;
} | null {
  const validationCandidate = normalizeSubmittedConfigModelRefs(
    stripBundledProviderRuntimeDefaults({
      candidate: params.candidate,
      sourceConfig: params.sourceConfig,
    }) as OpenClawConfig,
    params.modelIdNormalizationPolicies,
  );
  const respondInvalid = (issues: ReadonlyArray<ConfigValidationIssue>) => {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, summarizeConfigValidationIssues(issues), {
        details: { issues },
      }),
    );
  };
  // Submitted workspaces and plugin policy can differ from the applied generation.
  // The loader prepares them after core validation without activating the candidate.
  const pluginMetadata = createConfigIoContext().createValidationPluginMetadataSnapshotLoader({
    env: process.env,
  });
  const validationOptions = { loadPluginMetadataSnapshot: pluginMetadata.load };
  const sourceValidated = validateConfigObjectRawWithPlugins(
    validationCandidate,
    validationOptions,
  );
  if (!sourceValidated.ok) {
    respondInvalid(sourceValidated.issues);
    return null;
  }
  const validated = validateConfigObjectWithPlugins(validationCandidate, validationOptions);
  if (!validated.ok) {
    respondInvalid(validated.issues);
    return null;
  }
  return {
    validationCandidate,
    config: validated.config,
    pluginMetadata: pluginMetadata.getMetadata(),
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
  pluginMetadata?: PreparedPluginMetadata;
  respond: RespondFn;
}): Promise<PreparedSecretsRuntimeSnapshot | null> {
  try {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: params.config,
      includeAuthStoreRefs: false,
      allowUnavailableSecretOwners: true,
      ...(params.pluginMetadata
        ? { manifestRegistry: params.pluginMetadata.manifestRegistry }
        : {}),
    });
    for (const owner of snapshot.degradedOwners ?? []) {
      const reason = redactSecretDegradationReason(owner.reason);
      if (!isRetryableSecretDegradationReason(reason)) {
        throw new Error(reason);
      }
    }
    return snapshot;
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

function listPreparedSecretDegradations(snapshot: PreparedSecretsRuntimeSnapshot) {
  return (snapshot.degradedOwners ?? []).map((owner) => ({
    ownerKind: owner.ownerKind,
    ownerId: owner.ownerId,
    state: owner.degradationState ?? "cold",
    paths: [...owner.paths],
    reason: redactSecretDegradationReason(owner.reason),
  }));
}

function preparedSecretDegradationPayload(snapshot: PreparedSecretsRuntimeSnapshot) {
  const degradedSecretOwners = listPreparedSecretDegradations(snapshot);
  return degradedSecretOwners.length > 0 ? { degradedSecretOwners } : {};
}

async function respondWithConfigRestartWrite(params: {
  requestParams: unknown;
  kind: ConfigRestartWriteKind;
  mode: ConfigRestartWriteMode;
  writeResult: ConfigWriteCommitResult;
  changedPaths: string[];
  actor: ReturnType<typeof resolveControlPlaneActor>;
  context: GatewayRequestContext;
  respond: RespondFn;
  uiHints: ConfigRedactionHints;
  preparedSecretsSnapshot: PreparedSecretsRuntimeSnapshot;
}): Promise<void> {
  if (params.writeResult.application) {
    const outcome = await params.writeResult.application;
    if (outcome !== "applied") {
      const message =
        outcome === "applied-restart-required"
          ? `${params.mode} persisted and updated the active Gateway, but a recovery restart is required; wait for the Gateway to restart, then run config.get to confirm the active revision`
          : outcome === "restart-pending"
            ? `${params.mode} persisted and was accepted for restart; wait for the Gateway to restart, then run config.get to confirm the active revision`
            : `${params.mode} persisted but was not applied to the active Gateway (${outcome}); run config.get, then use config.apply to reapply the saved config or restart the Gateway`;
      params.respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, message));
      params.writeResult.queueFollowUp();
      return;
    }
  }
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
      ...(params.writeResult.hash
        ? { hash: params.context.configRevisionProjector.projectRawHash(params.writeResult.hash) }
        : {}),
      config: redactConfigObject(params.writeResult.config, params.uiHints),
      ...preparedSecretDegradationPayload(params.preparedSecretsSnapshot),
      restart,
      sentinel: {
        persisted: sentinelPersisted,
        payload,
      },
    },
    undefined,
  );
  params.writeResult.queueFollowUp();
}

function shouldDisconnectSharedAuthClientsForConfigWrite(params: {
  prevConfig: OpenClawConfig;
  prevSourceConfig: OpenClawConfig;
  nextConfig: OpenClawConfig;
  preparedSecretsSnapshot: PreparedSecretsRuntimeSnapshot;
}): boolean {
  return (
    didSharedGatewayAuthChange(params.prevConfig, params.nextConfig) ||
    didActiveSharedGatewayAuthChange({
      fallbackPrev: params.prevConfig,
      fallbackSource: params.prevSourceConfig,
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

async function commitGatewayConfigWriteOrRespond(
  params: Parameters<typeof commitGatewayConfigWrite>[0] & { respond: RespondFn },
): Promise<Awaited<ReturnType<typeof commitGatewayConfigWrite>> | null> {
  try {
    return await commitGatewayConfigWrite(params);
  } catch (error) {
    if (!(error instanceof ConfigMutationConflictError)) {
      throw error;
    }
    // Non-retryable conflicts (e.g. path ownership) will fail the retry too;
    // only advise it when a fresh base hash can actually resolve the conflict.
    params.respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        error.retryable ? `${error.message}; re-run config.get and retry` : error.message,
      ),
    );
    return null;
  }
}

function isHashlessPatchLwwPath(path: string): boolean {
  return HASHLESS_PATCH_LWW_PATH_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}.`),
  );
}

// Hash-free LWW is a per-leaf protocol. Container replacement or deletion requires document CAS
// so a stale client cannot wipe preference keys added by a concurrent writer.
function hasHashlessPatchLwwStructure(patch: unknown): boolean {
  return HASHLESS_PATCH_LWW_PATH_PREFIXES.every((prefix) => {
    let node = patch;
    for (const segment of prefix.split(".")) {
      if (!isPlainObject(node)) {
        return false;
      }
      if (!Object.hasOwn(node, segment)) {
        return true;
      }
      node = node[segment];
      if (!isPlainObject(node)) {
        return false;
      }
    }
    return true;
  });
}

function diffConfigLeafPaths(prev: unknown, next: unknown, prefix = ""): string[] {
  if (isPlainObject(prev) || isPlainObject(next)) {
    const prevRecord = isPlainObject(prev) ? prev : {};
    const nextRecord = isPlainObject(next) ? next : {};
    const keys = [...new Set([...Object.keys(prevRecord), ...Object.keys(nextRecord)])];
    if (keys.length === 0) {
      return isDeepStrictEqual(prev, next) ? [] : [prefix || "<root>"];
    }
    return keys.flatMap((key) =>
      diffConfigLeafPaths(prevRecord[key], nextRecord[key], prefix ? `${prefix}.${key}` : key),
    );
  }
  return diffConfigPaths(prev, next, prefix);
}

export const configHandlers: GatewayRequestHandlers = {
  "config.get": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateConfigGetParams, "config.get", respond)) {
      return;
    }
    respond(
      true,
      await readConfigGetResponse({
        getHotReloadStatus: context.getConfigReloaderHotReloadStatus,
        loadUiHints: () => loadGatewayRuntimeConfigSchema().uiHints,
        revisionProjector: context.configRevisionProjector,
      }),
      undefined,
    );
  },
  "config.schema": ({ params, respond }) => {
    if (!assertValidParams(params, validateConfigSchemaParams, "config.schema", respond)) {
      return;
    }
    respond(true, loadGatewayRuntimeConfigSchema(), undefined);
  },
  "config.schema.lookup": ({ params, respond, context }) => {
    if (
      !assertValidParams(params, validateConfigSchemaLookupParams, "config.schema.lookup", respond)
    ) {
      return;
    }
    const path = (params as { path: string }).path;
    const schema = loadGatewayRuntimeConfigSchema();
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
    const writeSnapshot = await readConfigWriteSnapshotOrRespond(
      params,
      respond,
      context.configRevisionProjector,
    );
    if (!writeSnapshot) {
      return;
    }
    const { snapshot, writeOptions } = writeSnapshot;
    const parsed = parseValidateConfigFromRawOrRespond(
      params,
      "config.set",
      snapshot,
      respond,
      resolveModelIdNormalizationPolicies(writeOptions.basePluginMetadata),
    );
    if (!parsed) {
      return;
    }
    if (
      rejectDroppedAgentRosterEntries({
        currentConfig: snapshot.config,
        submittedConfig: parsed.config,
        respond,
      })
    ) {
      return;
    }
    const preparedSecretsSnapshot = await ensureResolvableSecretRefsOrRespond({
      config: parsed.config,
      pluginMetadata: parsed.pluginMetadata,
      respond,
    });
    if (!preparedSecretsSnapshot) {
      return;
    }
    const writeResult = await commitGatewayConfigWriteOrRespond({
      snapshot,
      writeOptions,
      nextConfig: parsed.writeConfig,
      context,
      respond,
    });
    if (!writeResult) {
      return;
    }
    respond(
      true,
      {
        ok: true,
        path: writeResult.path,
        // Additive ack hash: matches the hash config.get would report for the
        // persisted bytes, so writers can adopt it without a reload.
        ...(writeResult.hash
          ? { hash: context.configRevisionProjector.projectRawHash(writeResult.hash) }
          : {}),
        config: redactConfigObject(writeResult.config, parsed.schema.uiHints),
        ...preparedSecretDegradationPayload(preparedSecretsSnapshot),
      },
      undefined,
    );
    writeResult.queueFollowUp();
  },
  "config.patch": async ({ params, respond, client, context }) => {
    if (!assertValidParams(params, validateConfigPatchParams, "config.patch", respond)) {
      return;
    }
    const hashlessPatch = resolveBaseHashParam(params) === null;
    // Hash-free writes do not retry: only the client can replay fresh intent after a lost race;
    // server re-merge would replay frozen stale intent over the winner. A paused handler can still
    // commit stale state, an accepted residual instead of adding connection-liveness plumbing.
    const writeSnapshot = hashlessPatch
      ? await readConfigFileSnapshotForWrite()
      : await readConfigWriteSnapshotOrRespond(params, respond, context.configRevisionProjector);
    if (!writeSnapshot) {
      return;
    }
    const { snapshot, writeOptions } = writeSnapshot;
    const modelIdNormalizationPolicies = resolveModelIdNormalizationPolicies(
      writeOptions.basePluginMetadata,
    );
    if (!snapshot.valid) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `${summarizeConfigValidationIssues(snapshot.issues)}; fix (openclaw doctor) before patching`,
          { details: { issues: snapshot.issues } },
        ),
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
    const normalizedPatch = normalizeSubmittedConfigModelRefs(
      parsedRes.parsed as OpenClawConfig,
      modelIdNormalizationPolicies,
    );
    if (hashlessPatch && !hasHashlessPatchLwwStructure(normalizedPatch)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "config base hash required; re-run config.get and retry",
        ),
      );
      return;
    }
    const replacePaths = readConfigPatchReplacePaths(params);
    try {
      assertNoDuplicateConfigPatchIds({
        patch: normalizedPatch,
        current: snapshot.config,
        replacePaths,
      });
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatErrorMessage(error)));
      return;
    }
    // Merge authored rows first; merging runtime rows would persist catalog defaults
    // from untouched siblings whenever an ID-keyed array changes.
    const sourceConfig = normalizeSubmittedConfigModelRefs(
      snapshot.sourceConfig,
      modelIdNormalizationPolicies,
    );
    const mergedSource = applyMergePatch(sourceConfig, normalizedPatch, {
      // Arrays with stable ids behave like maps for partial control-plane edits.
      mergeObjectArraysById: true,
      replaceArrayPaths: replacePaths,
    });
    const merged = applyMergePatch(snapshot.config, createMergePatch(sourceConfig, mergedSource));
    const schemaPatch = loadGatewayRuntimeConfigSchema();
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
        patch: normalizedPatch,
        replacePaths,
        respond,
      })
    ) {
      return;
    }
    const restoredChangedPaths = diffConfigLeafPaths(snapshot.config, restoredMerge.result);
    if (hashlessPatch && !restoredChangedPaths.every(isHashlessPatchLwwPath)) {
      const guardedPaths = restoredChangedPaths.filter((path) => !isHashlessPatchLwwPath(path));
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `config base hash required for ${guardedPaths.join(", ")}; re-run config.get and retry with baseHash`,
        ),
      );
      return;
    }
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
    const validatedSubmission = validateSubmittedConfigOrRespond({
      candidate: restoredMerge.result,
      sourceConfig: snapshot.sourceConfig,
      modelIdNormalizationPolicies,
      respond,
    });
    if (!validatedSubmission) {
      return;
    }
    const writeConfig = validatedSubmission.validationCandidate;
    const validatedConfig = validatedSubmission.config;
    const preparedSecretsSnapshot = await ensureResolvableSecretRefsOrRespond({
      config: validatedConfig,
      pluginMetadata: validatedSubmission.pluginMetadata,
      respond,
    });
    if (!preparedSecretsSnapshot) {
      return;
    }
    const changedPaths = diffConfigPaths(snapshot.config, validatedConfig);

    // No-op: if the validated config is identical to the current config,
    // skip the file write and SIGUSR1 restart entirely. This avoids a full
    // gateway restart (and the resulting connection drop) when a control-plane
    // client re-sends the same config (e.g. hot-apply with no actual changes).
    if (changedPaths.length === 0) {
      respondConfigPatchNoop({
        snapshot,
        config: validatedConfig,
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
      prevSourceConfig: snapshot.sourceConfig,
      nextConfig: validatedConfig,
      preparedSecretsSnapshot,
    });
    const writeResult = await commitGatewayConfigWriteOrRespond({
      snapshot,
      writeOptions,
      nextConfig: writeConfig,
      context,
      disconnectSharedAuthClients,
      awaitRuntimeApplication: shouldAwaitGatewayConfigApplication({
        changedPaths,
        nextConfig: writeConfig,
      }),
      respond,
    });
    if (!writeResult) {
      return;
    }
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
      preparedSecretsSnapshot,
    });
  },
  "config.apply": async ({ params, respond, client, context }) => {
    if (!assertValidParams(params, validateConfigApplyParams, "config.apply", respond)) {
      return;
    }
    const writeSnapshot = await readConfigWriteSnapshotOrRespond(
      params,
      respond,
      context.configRevisionProjector,
    );
    if (!writeSnapshot) {
      return;
    }
    const { snapshot, writeOptions } = writeSnapshot;
    const parsed = parseValidateConfigFromRawOrRespond(
      params,
      "config.apply",
      snapshot,
      respond,
      resolveModelIdNormalizationPolicies(writeOptions.basePluginMetadata),
    );
    if (!parsed) {
      return;
    }
    const preparedSecretsSnapshot = await ensureResolvableSecretRefsOrRespond({
      config: parsed.config,
      pluginMetadata: parsed.pluginMetadata,
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
      prevSourceConfig: snapshot.sourceConfig,
      nextConfig: parsed.config,
      preparedSecretsSnapshot,
    });
    const writeResult = await commitGatewayConfigWriteOrRespond({
      snapshot,
      writeOptions,
      nextConfig: parsed.writeConfig,
      context,
      disconnectSharedAuthClients,
      awaitRuntimeApplication: shouldAwaitGatewayConfigApplication({
        changedPaths,
        nextConfig: parsed.writeConfig,
      }),
      respond,
    });
    if (!writeResult) {
      return;
    }
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
      preparedSecretsSnapshot,
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
