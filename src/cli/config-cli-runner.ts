import { isDeepStrictEqual } from "node:util";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveManagedUnsetPathsForWrite } from "../config/config-path-mutation.js";
import { replaceConfigFile } from "../config/config.js";
import { AUTO_MANAGED_CONFIG_META_PATHS } from "../config/io.meta.js";
import { prepareConfigWriteTopology } from "../config/io.write-topology.js";
import { ConfigMutationConflictError } from "../config/mutation-conflict.js";
import { resolveConfigPath } from "../config/paths.js";
import { readBestEffortRuntimeConfigSchema } from "../config/runtime-schema.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { coerceSecretRef } from "../config/types.secrets.js";
import { diffConfigPaths } from "../gateway/config-diff.js";
import { buildGatewayReloadPlan } from "../gateway/config-reload-plan.js";
import { resolveGatewayReloadSettings } from "../gateway/config-reload-settings.js";
import { danger, info } from "../globals.js";
import { formatErrorMessage } from "../infra/errors.js";
import { withPluginMetadataCollectionScope } from "../plugins/plugin-metadata-collection.js";
import type { RuntimeEnv } from "../runtime.js";
import { ExitError, writeRuntimeJson } from "../runtime.js";
import { resolveConfigSecretTargetByPath } from "../secrets/target-registry.js";
import { toDotPath } from "../shared/dot-path.js";
import {
  formatPluginInstallConfigSetError,
  type ConfigMutationOptions,
  type ConfigSetOperation,
  type ParsedConfigSetOperation,
} from "./config-cli-input.js";
import {
  normalizeConfigMutationExplicitSetPath,
  normalizeConfigMutationModelRefs,
} from "./config-cli-model-normalization.js";
import {
  assertNonDestructiveReplacement,
  formatConfigSetPath,
  formatConfigUnsetMissingPathMessage,
  getAtPath,
  mergeAtPath,
  setAtPath,
  type JsonSchemaRecord,
  type PathSegment,
  unsetAtPath,
} from "./config-cli-path.js";
import { ConfigMutationAgentRoster } from "./config-cli-roster.js";
import {
  assertStrictConfigForMutation,
  loadValidConfigForWrite,
  validateConfigMutation,
} from "./config-cli-validation.js";
import {
  ConfigSetDryRunValidationError,
  printConfigDryRunResult,
  type ConfigSetDryRunResult,
} from "./config-set-dryrun.js";
import { exitCliAfterOutput } from "./one-shot-exit.js";

const GATEWAY_AUTH_MODE_PATH: PathSegment[] = ["gateway", "auth", "mode"];
const PLUGIN_INSTALL_RECORD_PATH_PREFIX: PathSegment[] = ["plugins", "installs"];

function pathStartsWith(path: readonly PathSegment[], prefix: readonly PathSegment[]): boolean {
  return prefix.every((segment, index) => path[index] === segment);
}

function pathEquals(path: readonly PathSegment[], expected: readonly PathSegment[]): boolean {
  return (
    path.length === expected.length && path.every((segment, index) => segment === expected[index])
  );
}

function valueHasAutoManagedChild(value: unknown, childPath: readonly PathSegment[]): boolean {
  let cursor: unknown = value;
  for (const segment of childPath) {
    if (!isRecord(cursor)) {
      return false;
    }
    if (!Object.hasOwn(cursor, segment)) {
      return false;
    }
    cursor = cursor[segment];
  }
  return cursor !== undefined;
}

function operationClobbersAncestorChild(
  operation: ParsedConfigSetOperation,
  managedPath: readonly PathSegment[],
  merge?: boolean,
): boolean {
  if (operation.mutation === "delete") {
    return true;
  }
  const childPath = managedPath.slice(operation.requestedPath.length);
  const isMerge = operation.mutation === "merge" || (merge && operation.mutation !== "replace");
  return isMerge ? valueHasAutoManagedChild(operation.value, childPath) : true;
}

function findAutoManagedMetaTargets(
  operations: readonly ParsedConfigSetOperation[],
  merge?: boolean,
): readonly PathSegment[][] {
  const matches: PathSegment[][] = [];
  const seen = new Set<string>();
  const record = (path: readonly PathSegment[]) => {
    const key = toDotPath(path);
    if (!seen.has(key)) {
      seen.add(key);
      matches.push([...path]);
    }
  };
  for (const operation of operations) {
    const direct = AUTO_MANAGED_CONFIG_META_PATHS.some((path) =>
      pathStartsWith(operation.requestedPath, path),
    );
    if (direct) {
      record(operation.requestedPath);
      continue;
    }
    for (const managedPath of AUTO_MANAGED_CONFIG_META_PATHS) {
      if (
        operation.requestedPath.length < managedPath.length &&
        pathStartsWith(managedPath, operation.requestedPath) &&
        operationClobbersAncestorChild(operation, managedPath, merge)
      ) {
        record(managedPath);
      }
    }
  }
  return matches;
}

function formatAutoManagedMetaError(paths: readonly PathSegment[][]): string {
  const targets = paths.map(toDotPath);
  const subject = targets.length === 1 ? targets[0] : targets.join(", ");
  return [
    `${subject} is auto-managed by OpenClaw and cannot be edited; the value would be overwritten on the next config write.`,
    "",
    "These fields are stamped on every config write to record the OpenClaw version and timestamp that produced the file.",
  ].join("\n");
}

function pruneInactiveGatewayAuthCredentials(params: {
  root: Record<string, unknown>;
  operations: ConfigSetOperation[];
}): string[] {
  const touchedMode = params.operations.some(({ requestedPath }) =>
    pathEquals(requestedPath, GATEWAY_AUTH_MODE_PATH),
  );
  const gateway = params.root.gateway;
  if (!touchedMode || !isRecord(gateway)) {
    return [];
  }
  const auth = gateway.auth;
  if (!isRecord(auth)) {
    return [];
  }
  const mode = typeof auth.mode === "string" ? auth.mode.trim() : "";
  const removedPaths: string[] = [];
  const remove = (key: "token" | "password") => {
    if (Object.hasOwn(auth, key)) {
      delete auth[key];
      removedPaths.push(`gateway.auth.${key}`);
    }
  };
  if (mode === "token") {
    remove("password");
  } else if (mode === "password") {
    remove("token");
  } else if (mode === "trusted-proxy") {
    remove("token");
    remove("password");
  }
  return removedPaths;
}

function collectChangedLeafPaths(value: unknown, prefix: string): string[] {
  if (!isRecord(value)) {
    return [prefix];
  }
  const entries = Object.entries(value);
  return entries.length === 0
    ? [prefix]
    : entries.flatMap(([key, child]) =>
        collectChangedLeafPaths(child, prefix ? `${prefix}.${key}` : key),
      );
}

function expandActualChangedPaths(
  actualPaths: string[],
  requestedPaths: string[],
  before: OpenClawConfig,
  after: OpenClawConfig,
): string[] {
  const expanded = new Set<string>();
  for (const actualPath of actualPaths) {
    const descendants = requestedPaths.filter(
      (requested) => requested !== actualPath && requested.startsWith(`${actualPath}.`),
    );
    if (descendants.length > 0) {
      descendants.forEach((path) => expanded.add(path));
      continue;
    }
    const path = actualPath === "<root>" ? [] : actualPath.split(".");
    const beforeValue = getAtPath(before, path);
    const afterValue = getAtPath(after, path);
    const changedValue = beforeValue.found && !afterValue.found ? beforeValue : afterValue;
    const paths =
      beforeValue.found !== afterValue.found
        ? collectChangedLeafPaths(changedValue.value, actualPath)
        : [actualPath];
    paths.forEach((entry) => expanded.add(entry));
  }
  return [...expanded];
}

function configApplyHintForOperations(
  operations: readonly ConfigSetOperation[],
  beforeConfig: OpenClawConfig,
  afterConfig: OpenClawConfig,
): string {
  const requestedPaths = operations.map(({ requestedPath }) => toDotPath(requestedPath));
  const paths = expandActualChangedPaths(
    diffConfigPaths(beforeConfig, afterConfig),
    requestedPaths,
    beforeConfig,
    afterConfig,
  );
  if (paths.length === 0) {
    return "No gateway restart needed.";
  }
  if (paths.some((path) => path === "plugins.entries" || path.startsWith("plugins.entries."))) {
    return "Restart the gateway to apply.";
  }
  const plan = buildGatewayReloadPlan(paths, { candidateConfig: afterConfig });
  if (
    plan.restartGateway ||
    (plan.hotReasons.length > 0 && resolveGatewayReloadSettings(afterConfig).mode === "off")
  ) {
    return "Restart the gateway to apply.";
  }
  return plan.hotReasons.length > 0
    ? "Change will apply without restarting the gateway."
    : "No gateway restart needed.";
}

async function loadMutationSchema(): Promise<JsonSchemaRecord | undefined> {
  try {
    return (await readBestEffortRuntimeConfigSchema()).schema as JsonSchemaRecord;
  } catch {
    return undefined;
  }
}

export async function runConfigOperations(params: {
  runtime: RuntimeEnv;
  operations: ParsedConfigSetOperation[];
  options: ConfigMutationOptions;
  successMode: "set" | "patch";
}) {
  const { runtime, operations: parsedOperations, options } = params;
  if (
    parsedOperations.some(({ requestedPath }) =>
      pathStartsWith(requestedPath, PLUGIN_INSTALL_RECORD_PATH_PREFIX),
    )
  ) {
    throw new Error(formatPluginInstallConfigSetError());
  }
  const autoManagedTargets = findAutoManagedMetaTargets(parsedOperations, options.merge);
  if (autoManagedTargets.length > 0) {
    throw new Error(formatAutoManagedMetaError(autoManagedTargets));
  }
  const mutationStart = await loadValidConfigForWrite(runtime);
  const { snapshot } = mutationStart;
  // Parsing stays metadata-free. Bind sibling refs and schema exemptions only to
  // the same prepared collection that owns this mutation's validation and write.
  const operations = withPluginMetadataCollectionScope(
    expectDefined(mutationStart.writeOptions.basePluginMetadata, "config mutation plugin metadata"),
    () =>
      parsedOperations.map(({ validatedRef, ...operation }): ConfigSetOperation => {
        const resolved = coerceSecretRef(operation.value)
          ? resolveConfigSecretTargetByPath(operation.requestedPath, operation.pathTokens)
          : undefined;
        return Object.assign(operation, {
          setPath:
            resolved?.entry.secretShape === "sibling_ref" && resolved.refPathSegments
              ? resolved.refPathSegments
              : operation.requestedPath,
          ...(validatedRef && resolved ? { schemaValidated: true } : {}),
        });
      }),
    {
      config: snapshot.sourceConfig,
      compatibleConfigs: [snapshot.config, snapshot.runtimeConfig],
      env: process.env,
    },
  );
  // Mutate resolved config so runtime defaults never leak into the authored file.
  const next = structuredClone(snapshot.resolved) as Record<string, unknown>;
  const currentConfig = normalizeConfigMutationModelRefs(snapshot.resolved);
  const mutationSchema = await loadMutationSchema();
  const roster = new ConfigMutationAgentRoster(next, snapshot.sourceConfigBeforeMigrations);
  let unsetPaths: PathSegment[][] = [];
  const explicitSetPaths: PathSegment[][] = [];
  const appliedOperations: ConfigSetOperation[] = [];
  const recordOperation = (operation: ConfigSetOperation): PathSegment[] => {
    const writePath = roster.writePath(operation.setPath);
    const renamesAgent =
      operation.setPath[1] === "list" &&
      writePath[1] === "entries" &&
      writePath.length === 4 &&
      writePath[3] === "id";
    // Renaming moves the entire entry. Validate its surviving fields under the new
    // identity, but retain the exact authored write path for persistence.
    const setPath = normalizeConfigMutationExplicitSetPath(
      renamesAgent ? writePath.slice(0, 3) : writePath,
    );
    appliedOperations.push({ ...operation, setPath });
    return writePath;
  };
  for (const operation of operations) {
    const merge =
      operation.mutation === "merge" || (options.merge && operation.mutation !== "replace");
    roster.prepare(operation, Boolean(merge));
    if (operation.mutation === "delete") {
      const writePath = recordOperation(operation);
      const unsetResult = unsetAtPath(next, operation.setPath);
      if (!unsetResult.removed && operation.inputMode === "unset") {
        const requestedPath = formatConfigSetPath(operation.requestedPath, operation.pathTokens);
        const runtimeOnly = getAtPath(snapshot.runtimeConfig, operation.setPath).found;
        const message = formatConfigUnsetMissingPathMessage({ path: requestedPath, runtimeOnly });
        if (options.dryRun && options.json) {
          throw new ConfigSetDryRunValidationError({
            ok: false,
            operations: 1,
            configPath: snapshot.path,
            inputModes: ["unset"],
            checks: { schema: false, resolvability: false, resolvabilityComplete: false },
            refsChecked: 0,
            skippedExecRefs: 0,
            errors: [
              {
                kind: "missing-path",
                message: runtimeOnly
                  ? message
                  : `Config path not found: ${requestedPath}. Nothing was changed.`,
              },
            ],
          });
        }
        if (!options.dryRun) {
          assertStrictConfigForMutation(
            currentConfig,
            mutationStart.writeOptions.basePluginMetadata,
          );
        }
        throw new Error(message);
      }
      if (!unsetResult.removed || unsetResult.leafContainer !== "array") {
        unsetPaths.push(writePath);
      }
      continue;
    }
    const pathOptions = {
      numericObjectKeys: params.successMode === "patch",
      pathTokens: operation.pathTokens,
      quotedNumericSegments: operation.quotedNumericSegments,
      schema: mutationSchema,
    };
    if (merge) {
      mergeAtPath(next, operation.setPath, operation.value, pathOptions);
    } else {
      assertNonDestructiveReplacement({
        root: next,
        path: operation.setPath,
        value: operation.value,
        allowReplace: options.replace || operation.mutation === "replace",
      });
      setAtPath(next, operation.setPath, operation.value, pathOptions);
    }
    explicitSetPaths.push(recordOperation(operation));
  }
  roster.finish();
  // A later operation can recreate a deleted path, including through a roster alias.
  // Only final deletions may be replayed by the persistence owner.
  unsetPaths = unsetPaths.filter((path) => !getAtPath(next, path).found);
  const removedGatewayAuthPaths = pruneInactiveGatewayAuthCredentials({ root: next, operations });
  let nextConfig = normalizeConfigMutationModelRefs(next as OpenClawConfig);
  const normalizedExplicitSetPaths = explicitSetPaths.map(normalizeConfigMutationExplicitSetPath);
  if (options.dryRun) {
    nextConfig = prepareConfigWriteTopology({
      snapshot,
      pluginMetadata: mutationStart.writeOptions.basePluginMetadata,
      nextConfig,
      options: { explicitSetPaths: normalizedExplicitSetPaths },
      unsetPaths: resolveManagedUnsetPathsForWrite(unsetPaths),
      env: process.env,
    }).nextConfig;
  }
  const validation = await validateConfigMutation({
    config: nextConfig,
    previousConfig: currentConfig,
    operations: appliedOperations,
    options,
    configPath: snapshot.path,
    unchanged: params.successMode === "set" && isDeepStrictEqual(currentConfig, nextConfig),
    pluginMetadataSnapshot: mutationStart.writeOptions.basePluginMetadata,
  });
  if (validation.kind === "dry-run") {
    printConfigDryRunResult(validation.result, runtime, options.json);
    return;
  }
  if (validation.kind === "unchanged") {
    runtime.log(info("No change"));
    return;
  }

  await replaceConfigFile({
    nextConfig,
    snapshot,
    ...(snapshot.hash !== undefined ? { baseHash: snapshot.hash } : {}),
    writeOptions: {
      ...mutationStart.writeOptions,
      auditOrigin: "cli",
      ...(unsetPaths.length > 0 ? { unsetPaths } : {}),
      ...(normalizedExplicitSetPaths.length > 0
        ? { explicitSetPaths: normalizedExplicitSetPaths }
        : {}),
    },
  });
  if (removedGatewayAuthPaths.length > 0) {
    runtime.log(
      info(
        `Removed inactive ${removedGatewayAuthPaths.join(", ")} for gateway.auth.mode=${nextConfig.gateway?.auth?.mode ?? "<unset>"}.`,
      ),
    );
  }
  const hint = configApplyHintForOperations(operations, currentConfig, nextConfig);
  if (params.successMode === "set" && operations.length === 1) {
    const operation = operations[0];
    const action = operation?.mutation === "delete" ? "Removed" : "Updated";
    const requestedPath = formatConfigSetPath(
      operation?.requestedPath ?? [],
      operation?.pathTokens,
      nextConfig,
    );
    runtime.log(info(`${action} ${requestedPath}. ${hint}`));
  } else if (params.successMode === "set") {
    runtime.log(info(`Updated ${operations.length} config paths. ${hint}`));
  } else {
    runtime.log(info(`Applied ${operations.length} config update(s). ${hint}`));
  }
}

export function handleConfigMutationError(params: {
  err: unknown;
  runtime: RuntimeEnv;
  options: ConfigMutationOptions;
}) {
  if (params.err instanceof ExitError) {
    throw params.err;
  }
  const isConflict = params.err instanceof ConfigMutationConflictError;
  const detail = formatErrorMessage(params.err);
  const message = isConflict
    ? `The config file changed while this command was writing (${detail}), so nothing was changed. Re-run the same command to pick up the new file and try again.`
    : detail;
  if (params.options.dryRun && params.options.json) {
    if (params.err instanceof ConfigSetDryRunValidationError) {
      writeRuntimeJson(params.runtime, params.err.result);
      exitCliAfterOutput(params.runtime, 1);
    }
    const result: ConfigSetDryRunResult = {
      ok: false,
      operations: 0,
      configPath: resolveConfigPath(),
      inputModes: [],
      checks: { schema: false, resolvability: false, resolvabilityComplete: false },
      refsChecked: 0,
      skippedExecRefs: 0,
      errors: [{ kind: isConflict ? "conflict" : "schema", message }],
    };
    writeRuntimeJson(params.runtime, result);
    params.runtime.error(danger(message));
    exitCliAfterOutput(params.runtime, 1);
  }
  params.runtime.error(danger(message));
  exitCliAfterOutput(params.runtime, 1);
}
