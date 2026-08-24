// Config gateway methods: validation, redaction, secrets, reload planning.
import { isDeepStrictEqual } from "node:util";
import {
  hasSensitiveUrlHintTag,
  SENSITIVE_URL_HINT_TAG,
} from "@openclaw/net-policy/redact-sensitive-url";
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
import { resolveModelIdNormalizationPolicies } from "../../config/io.context.js";
import {
  createConfigIO,
  parseConfigJson5,
  readConfigFileSnapshot,
  readConfigFileSnapshotForWrite,
  resolveConfigSnapshotHash,
} from "../../config/io.js";
import { projectSourceOntoRuntimeShape } from "../../config/io.write-prepare.js";
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
import {
  buildRuntimeConfigSchemaForConfig,
  loadGatewayRuntimeConfigSchema,
} from "../../config/runtime-schema.js";
import { lookupConfigSchema, type ConfigSchemaResponse } from "../../config/schema.js";
import type { ConfigValidationIssue, OpenClawConfig } from "../../config/types.openclaw.js";
import {
  validateConfigObjectRawWithPlugins,
  validateConfigObjectWithPlugins,
} from "../../config/validation.js";
import { isBuiltInModelProviderOverlayId } from "../../config/zod-schema.core.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { isPlainObject } from "../../infra/plain-object.js";
import { getActivePluginRegistryVersion } from "../../plugins/runtime.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import {
  isRetryableSecretDegradationReason,
  redactSecretDegradationReason,
} from "../../secrets/runtime-degraded-state.js";
import {
  prepareSecretsRuntimeSnapshot,
  type PreparedSecretsRuntimeSnapshot,
} from "../../secrets/runtime.js";
import type { ConfigUiHints } from "../../shared/config-ui-hints-types.js";
import { diffConfigPaths } from "../config-diff.js";
import { invalidateConfigGetResponseCache, readConfigGetResponse } from "../config-get-response.js";
import { resolveConfigReloadMetadata } from "../config-reload-plan.js";
import type { GatewayConfigRevisionProjector } from "../config-revision-token.js";
import {
  getCachedConfigSchemaResponse,
  invalidateConfigSchemaResponseCache,
  setCachedConfigSchemaResponse,
} from "../config-schema-response-cache.js";
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

/**
 * Memoizes buildRuntimeConfigSchemaForConfig for the lifetime of one request handler.
 *
 * The write RPCs need hints for the pre-write config at several sites (sentinel restore, the noop
 * acknowledgement, the pre/post redaction union), all reading the same snapshot object, and every
 * fresh build repeats manifest-registry resolution that can miss the plugin lifecycle snapshot.
 * The memo is keyed on the config object's IDENTITY, never on its content: ownership is derived
 * from the exact object handed in, so two deeply-equal configs read at different times must still
 * build separately or a write that moves channel ownership would redact under the departed owner,
 * the stale-schema defect the per-config builds exist to prevent. Handlers create one memo per
 * invocation and never store it wider, so no build outlives the request that produced it.
 */
function createRequestScopedSchemaBuilder(): typeof buildRuntimeConfigSchemaForConfig {
  // A WeakMap in this closure (rather than threading each build result by hand) keeps the call
  // sites one-liners while the entries still die with the handler invocation that created them.
  const built = new WeakMap<OpenClawConfig, ConfigSchemaResponse>();
  return (config) => {
    let response = built.get(config);
    if (!response) {
      response = buildRuntimeConfigSchemaForConfig(config);
      built.set(config, response);
    }
    return response;
  };
}

function parseValidateConfigFromRawOrRespond(
  params: unknown,
  requestName: string,
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>,
  respond: RespondFn,
  buildSchemaForConfig: typeof buildRuntimeConfigSchemaForConfig,
  modelIdNormalizationPolicies?: Parameters<typeof normalizeSubmittedConfigModelRefs>[1],
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
  // Sentinels are restored against this snapshot, so the hints must describe it. The cached schema
  // is keyed on plugin registry version alone and can still describe the previous channel owner.
  const restored = restoreRedactedValues(
    parsedRes.parsed,
    snapshot.config,
    buildSchemaForConfig(snapshot.config).uiHints,
  );
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
}): { validationCandidate: OpenClawConfig; config: OpenClawConfig } | null {
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
  const sourceValidated = validateConfigObjectRawWithPlugins(validationCandidate);
  if (!sourceValidated.ok) {
    respondInvalid(sourceValidated.issues);
    return null;
  }
  const validated = validateConfigObjectWithPlugins(validationCandidate);
  if (!validated.ok) {
    respondInvalid(validated.issues);
    return null;
  }
  return { validationCandidate: validationCandidate as OpenClawConfig, config: validated.config };
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
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: params.config,
      includeAuthStoreRefs: false,
      allowUnavailableSecretOwners: true,
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

export function clearConfigSchemaResponseCacheForTests() {
  invalidateConfigSchemaResponseCache();
  invalidateConfigGetResponseCache();
}

function clearConfigSchemaResponseCache() {
  invalidateConfigSchemaResponseCache();
}

/**
 * Union the redaction-relevant hints of the pre-write and committed schemas.
 *
 * Neither side alone is safe. The committed schema is required so a write that ACTIVATES a
 * replacement redacts under the owner it selects. But the committed schema alone drops a claimant
 * the write REMOVED, and a value that claimant declared sensitive can survive under a shared
 * channel, so the acknowledgement would return it unredacted.
 *
 * Both attributes the redaction path consults travel here: `redactConfigObject` and the system
 * agent gate on `sensitive === true || hasSensitiveUrlHintTag(hint)`, so carrying only the former
 * would still leak a URL-embedded credential the removed owner alone tagged.
 */
function unionRedactionUiHints(
  previous: ConfigUiHints | undefined,
  committed: ConfigUiHints | undefined,
): ConfigUiHints | undefined {
  if (!previous) {
    return committed;
  }
  if (!committed) {
    return previous;
  }
  const merged: ConfigUiHints = { ...committed };
  for (const [path, hint] of Object.entries(previous)) {
    const sensitive = hint?.sensitive === true;
    const urlSecret = hasSensitiveUrlHintTag(hint);
    if (!sensitive && !urlSecret) {
      continue;
    }
    const owned = merged[path];
    const tags =
      urlSecret && !hasSensitiveUrlHintTag(owned)
        ? [...(owned?.tags ?? []), SENSITIVE_URL_HINT_TAG]
        : owned?.tags;
    merged[path] = {
      ...owned,
      ...(sensitive ? { sensitive: true } : {}),
      ...(tags ? { tags } : {}),
    };
  }
  return merged;
}

async function respondWithConfigRestartWrite(params: {
  requestParams: unknown;
  kind: ConfigRestartWriteKind;
  mode: ConfigRestartWriteMode;
  writeResult: ConfigWriteCommitResult;
  /** Config as it stood before the write, so a claimant this write removed still redacts. */
  previousConfig: OpenClawConfig;
  /** Request-scoped memoized builder, shared with the caller's earlier pre-write hint builds. */
  buildSchemaForConfig: typeof buildRuntimeConfigSchemaForConfig;
  changedPaths: string[];
  actor: ReturnType<typeof resolveControlPlaneActor>;
  context: GatewayRequestContext;
  respond: RespondFn;
  preparedSecretsSnapshot: PreparedSecretsRuntimeSnapshot;
}): Promise<void> {
  clearConfigSchemaResponseCache();
  // Redact under the owner the committed config selects. Hints captured before the write describe
  // the previous owner, so a write that activates a replacement could return a field that owner
  // marks sensitive. Clearing the cache above is not enough: the caller already holds stale hints.
  // Union with the pre-write hints so a claimant this write removed still redacts its own fields.
  const uiHints = unionRedactionUiHints(
    params.buildSchemaForConfig(params.previousConfig).uiHints,
    params.buildSchemaForConfig(params.writeResult.config).uiHints,
  );
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
      config: redactConfigObject(params.writeResult.config, uiHints),
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

function loadSchemaWithPlugins(): ConfigSchemaResponse {
  const pluginRegistryVersion = getActivePluginRegistryVersion();
  const cached = getCachedConfigSchemaResponse(pluginRegistryVersion);
  if (cached) {
    return cached;
  }

  // Plugin schema metadata is process-stable until config write or registry activation. Every
  // accepted config candidate invalidates this from the reload path, which is what covers a
  // hot-reloaded ownership change that leaves the registry version untouched.
  const response = loadGatewayRuntimeConfigSchema();
  setCachedConfigSchemaResponse(pluginRegistryVersion, response);
  return response;
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
        loadUiHints: (config) => buildRuntimeConfigSchemaForConfig(config).uiHints,
        revisionProjector: context.configRevisionProjector,
      }),
      undefined,
    );
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
    const writeSnapshot = await readConfigWriteSnapshotOrRespond(
      params,
      respond,
      context.configRevisionProjector,
    );
    if (!writeSnapshot) {
      return;
    }
    const { snapshot, writeOptions } = writeSnapshot;
    const buildSchemaForConfig = createRequestScopedSchemaBuilder();
    const parsed = parseValidateConfigFromRawOrRespond(
      params,
      "config.set",
      snapshot,
      respond,
      buildSchemaForConfig,
      resolveModelIdNormalizationPolicies(writeOptions.basePluginMetadataSnapshot),
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
    clearConfigSchemaResponseCache();
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
        config: redactConfigObject(
          writeResult.config,
          // Take the pre-write hints from the config that was actually on disk, as the
          // patch and apply paths do. The parsed schema comes from a cache keyed on plugin
          // registry version alone, and ownership can move through a config reload without
          // advancing that key, which would leave the departing claimant's only sensitive
          // hint out of the union and return its retained value here.
          unionRedactionUiHints(
            buildSchemaForConfig(snapshot.config).uiHints,
            buildSchemaForConfig(writeResult.config).uiHints,
          ),
        ),
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
    const buildSchemaForConfig = createRequestScopedSchemaBuilder();
    const modelIdNormalizationPolicies = resolveModelIdNormalizationPolicies(
      writeOptions.basePluginMetadataSnapshot,
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
    const merged = applyMergePatch(snapshot.config, normalizedPatch, {
      // Arrays with stable ids behave like maps for partial control-plane edits.
      mergeObjectArraysById: true,
      replaceArrayPaths: replacePaths,
    });
    const restoredMerge = restoreRedactedValues(
      merged,
      snapshot.config,
      buildSchemaForConfig(snapshot.config).uiHints,
    );
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
        uiHints: buildSchemaForConfig(snapshot.config).uiHints,
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
        uiHints: buildSchemaForConfig(validatedConfig).uiHints,
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
      previousConfig: snapshot.config,
      buildSchemaForConfig,
      changedPaths,
      actor,
      context,
      respond,
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
    const buildSchemaForConfig = createRequestScopedSchemaBuilder();
    const parsed = parseValidateConfigFromRawOrRespond(
      params,
      "config.apply",
      snapshot,
      respond,
      buildSchemaForConfig,
      resolveModelIdNormalizationPolicies(writeOptions.basePluginMetadataSnapshot),
    );
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
      previousConfig: snapshot.config,
      buildSchemaForConfig,
      changedPaths,
      actor,
      context,
      respond,
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
