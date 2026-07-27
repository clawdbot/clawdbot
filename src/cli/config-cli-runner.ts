import { uniqueValues } from "@openclaw/normalization-core/string-normalization";
import { replaceConfigFile } from "../config/config.js";
import { AUTO_MANAGED_CONFIG_META_PATHS } from "../config/io.meta.js";
import { formatConfigIssueLines } from "../config/issue-format.js";
import { readBestEffortRuntimeConfigSchema } from "../config/runtime-schema.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { collectUnsupportedSecretRefPolicyIssues } from "../config/validation.js";
import { diffConfigPaths } from "../gateway/config-diff.js";
import { buildGatewayReloadPlan } from "../gateway/config-reload-plan.js";
import { resolveGatewayReloadSettings } from "../gateway/config-reload-settings.js";
import { danger, info } from "../globals.js";
import type { RuntimeEnv } from "../runtime.js";
import { writeRuntimeJson } from "../runtime.js";
import { shortenHomePath } from "../utils.js";
import {
  ConfigSetDryRunValidationError,
  formatPluginInstallConfigSetError,
  type ConfigMutationOptions,
  type ConfigSetOperation,
} from "./config-cli-input.js";
import {
  normalizeConfigMutationExplicitSetPath,
  normalizeConfigMutationModelRefs,
} from "./config-cli-model-normalization.js";
import {
  assertNonDestructiveReplacement,
  getAtPath,
  mergeAtPath,
  setAtPath,
  toDotPath,
  type JsonSchemaRecord,
  type PathSegment,
  unsetAtPath,
} from "./config-cli-path.js";
import {
  collectDryRunRefs,
  collectDryRunResolvabilityErrors,
  collectDryRunSchemaErrors,
  collectDryRunStaticErrorsForSkippedExecRefs,
  collectPluginIntegrationProviderErrors,
  dedupeDryRunErrors,
  formatDryRunFailureMessage,
  loadValidConfig,
  selectDryRunRefsForResolution,
} from "./config-cli-validation.js";
import { checkTouchedTextModelRefs } from "./config-model-validation.js";
import type { ConfigSetDryRunError, ConfigSetDryRunResult } from "./config-set-dryrun.js";

const GATEWAY_AUTH_MODE_PATH: PathSegment[] = ["gateway", "auth", "mode"];
const PLUGIN_INSTALL_RECORD_PATH_PREFIX: PathSegment[] = ["plugins", "installs"];
const CONFIG_SET_POLICY_ERROR_MAX_ISSUES = 5;

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
    if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) {
      return false;
    }
    const record = cursor as Record<string, unknown>;
    if (!Object.hasOwn(record, segment)) {
      return false;
    }
    cursor = record[segment];
  }
  return cursor !== undefined;
}

function operationClobbersAncestorChild(
  operation: ConfigSetOperation,
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
  operations: readonly ConfigSetOperation[],
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

export function assertConfigPathIsNotAutoManaged(path: PathSegment[]): void {
  const targets = findAutoManagedMetaTargets([
    { inputMode: "json", requestedPath: path, setPath: path, value: undefined, mutation: "delete" },
  ]);
  if (targets.length > 0) {
    throw new Error(formatAutoManagedMetaError(targets));
  }
}

function pruneInactiveGatewayAuthCredentials(params: {
  root: Record<string, unknown>;
  operations: ConfigSetOperation[];
}): string[] {
  const touchedMode = params.operations.some(({ requestedPath }) =>
    pathEquals(requestedPath, GATEWAY_AUTH_MODE_PATH),
  );
  const gateway = params.root.gateway;
  if (!touchedMode || !gateway || typeof gateway !== "object" || Array.isArray(gateway)) {
    return [];
  }
  const auth = (gateway as Record<string, unknown>).auth;
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) {
    return [];
  }
  const authRecord = auth as Record<string, unknown>;
  const mode = typeof authRecord.mode === "string" ? authRecord.mode.trim() : "";
  const removedPaths: string[] = [];
  const remove = (key: "token" | "password") => {
    if (Object.hasOwn(authRecord, key)) {
      delete authRecord[key];
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
  if (!value || typeof value !== "object" || Array.isArray(value)) {
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

export function configApplyHintForOperations(
  operations: ReadonlyArray<{ requestedPath?: PathSegment[] }>,
  beforeConfig: OpenClawConfig,
  afterConfig: OpenClawConfig,
): string {
  const requestedPaths: string[] = [];
  for (const operation of operations) {
    if (!operation.requestedPath) {
      return "Restart the gateway to apply.";
    }
    requestedPaths.push(toDotPath(operation.requestedPath));
  }
  const paths = expandActualChangedPaths(
    diffConfigPaths(beforeConfig, afterConfig),
    requestedPaths,
    beforeConfig,
    afterConfig,
  );
  if (
    paths.length === 0 ||
    paths.some((path) => path === "plugins.entries" || path.startsWith("plugins.entries."))
  ) {
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
    return structuredClone((await readBestEffortRuntimeConfigSchema()).schema) as JsonSchemaRecord;
  } catch {
    return undefined;
  }
}

function formatPolicyFailure(issues: string[]): string {
  const lines = [
    "Config policy validation failed: unsupported SecretRef usage was detected.",
    ...issues.slice(0, CONFIG_SET_POLICY_ERROR_MAX_ISSUES).map((issue) => `- ${issue}`),
  ];
  if (issues.length > CONFIG_SET_POLICY_ERROR_MAX_ISSUES) {
    lines.push(`- ... ${issues.length - CONFIG_SET_POLICY_ERROR_MAX_ISSUES} more`);
  }
  return lines.join("\n");
}

export async function runConfigOperations(params: {
  runtime: RuntimeEnv;
  operations: ConfigSetOperation[];
  options: ConfigMutationOptions;
  successMode: "set" | "patch";
}) {
  const { runtime, operations, options } = params;
  if (
    operations.some(({ requestedPath }) =>
      pathStartsWith(requestedPath, PLUGIN_INSTALL_RECORD_PATH_PREFIX),
    )
  ) {
    throw new Error(formatPluginInstallConfigSetError());
  }
  const autoManagedTargets = findAutoManagedMetaTargets(operations, options.merge);
  if (autoManagedTargets.length > 0) {
    throw new Error(formatAutoManagedMetaError(autoManagedTargets));
  }
  const snapshot = await loadValidConfig(runtime);
  // Mutate resolved config so runtime defaults never leak into the authored file.
  const next = structuredClone(snapshot.resolved) as Record<string, unknown>;
  const currentConfig = normalizeConfigMutationModelRefs(
    structuredClone(snapshot.resolved) as OpenClawConfig,
  );
  const mutationSchema = await loadMutationSchema();
  const unsetPaths: PathSegment[][] = [];
  const explicitSetPaths: PathSegment[][] = [];
  for (const operation of operations) {
    if (operation.mutation === "delete") {
      unsetAtPath(next, operation.setPath);
      unsetPaths.push(operation.setPath);
      continue;
    }
    explicitSetPaths.push(operation.setPath);
    if (operation.mutation === "merge" || (options.merge && operation.mutation !== "replace")) {
      mergeAtPath(next, operation.setPath, operation.value, {
        numericObjectKeys: params.successMode === "patch",
        schema: mutationSchema,
      });
    } else {
      assertNonDestructiveReplacement({
        root: next,
        path: operation.setPath,
        value: operation.value,
        allowReplace: options.replace || operation.mutation === "replace",
      });
      setAtPath(next, operation.setPath, operation.value, {
        numericObjectKeys: params.successMode === "patch",
        schema: mutationSchema,
      });
    }
  }
  const removedGatewayAuthPaths = pruneInactiveGatewayAuthCredentials({ root: next, operations });
  const nextConfig = normalizeConfigMutationModelRefs(next as OpenClawConfig);
  const normalizedExplicitSetPaths = explicitSetPaths.map(normalizeConfigMutationExplicitSetPath);
  const policyIssueLines = formatConfigIssueLines(
    collectUnsupportedSecretRefPolicyIssues(nextConfig),
    "",
    { normalizeRoot: true },
  ).map((line) => line.trim());
  const pluginIntegrationErrors = collectPluginIntegrationProviderErrors({
    config: nextConfig,
    operations,
  });

  if (options.dryRun) {
    const hasJsonMode = operations.some(({ inputMode }) => inputMode === "json");
    const hasBuilderMode = operations.some(({ inputMode }) => inputMode === "builder");
    const hasUnsetMode = operations.some(({ inputMode }) => inputMode === "unset");
    const requiresFullSchemaValidation = operations.some(
      (operation) =>
        operation.inputMode === "unset" ||
        (operation.inputMode === "json" && operation.schemaValidated !== true),
    );
    const checksRefs = hasJsonMode || hasBuilderMode || hasUnsetMode;
    const refs = checksRefs ? collectDryRunRefs({ config: nextConfig, operations }) : [];
    const selectedRefs = selectDryRunRefsForResolution({
      refs,
      allowExecInDryRun: Boolean(options.allowExec),
    });
    const errors: ConfigSetDryRunError[] = [];
    const modelRefCheck = await checkTouchedTextModelRefs({
      config: nextConfig,
      previousConfig: currentConfig,
      touchedPaths: operations.map(({ setPath }) => setPath),
      redactDependencyValues: true,
    });
    errors.push(...modelRefCheck.errors.map((message) => ({ kind: "model" as const, message })));
    if ((!hasJsonMode || !requiresFullSchemaValidation) && policyIssueLines.length > 0) {
      errors.push(...policyIssueLines.map((message) => ({ kind: "schema" as const, message })));
    }
    errors.push(...pluginIntegrationErrors);
    if (requiresFullSchemaValidation) {
      errors.push(...collectDryRunSchemaErrors(nextConfig));
    }
    if (checksRefs) {
      errors.push(
        ...collectDryRunStaticErrorsForSkippedExecRefs({
          refs: selectedRefs.skippedExecRefs,
          config: nextConfig,
        }),
        ...(await collectDryRunResolvabilityErrors({
          refs: selectedRefs.refsToResolve,
          config: nextConfig,
        })),
      );
    }
    const dedupedErrors = dedupeDryRunErrors(errors);
    const dryRunResult: ConfigSetDryRunResult = {
      ok: dedupedErrors.length === 0,
      operations: operations.length,
      configPath: snapshot.path,
      inputModes: uniqueValues(operations.map(({ inputMode }) => inputMode)),
      checks: {
        schema:
          requiresFullSchemaValidation ||
          policyIssueLines.length > 0 ||
          pluginIntegrationErrors.length > 0,
        resolvability: checksRefs || modelRefCheck.refsTotal > 0,
        resolvabilityComplete:
          (checksRefs || modelRefCheck.refsTotal > 0) &&
          selectedRefs.skippedExecRefs.length === 0 &&
          modelRefCheck.refsChecked === modelRefCheck.refsTotal,
      },
      refsChecked: selectedRefs.refsToResolve.length + modelRefCheck.refsChecked,
      skippedExecRefs: selectedRefs.skippedExecRefs.length,
      ...(dedupedErrors.length > 0 ? { errors: dedupedErrors } : {}),
    };
    if (dedupedErrors.length > 0) {
      if (options.json) {
        throw new ConfigSetDryRunValidationError(dryRunResult);
      }
      throw new Error(
        formatDryRunFailureMessage({
          errors: dedupedErrors,
          skippedExecRefs: selectedRefs.skippedExecRefs.length,
        }),
      );
    }
    if (options.json) {
      writeRuntimeJson(runtime, dryRunResult);
    } else {
      if (!dryRunResult.checks.schema && !dryRunResult.checks.resolvability) {
        runtime.log(
          info(
            "Dry run note: value mode does not run schema/resolvability checks. Use --strict-json, builder flags, or batch mode to enable validation checks.",
          ),
        );
      }
      if (dryRunResult.skippedExecRefs > 0) {
        runtime.log(
          info(
            `Dry run note: skipped ${dryRunResult.skippedExecRefs} exec SecretRef resolvability check(s). Re-run with --allow-exec to execute exec providers during dry-run.`,
          ),
        );
      }
      runtime.log(
        info(
          `Dry run successful: ${operations.length} update(s) validated against ${shortenHomePath(snapshot.path)}.`,
        ),
      );
    }
    return;
  }

  if (policyIssueLines.length > 0) {
    throw new Error(formatPolicyFailure(policyIssueLines));
  }
  if (pluginIntegrationErrors.length > 0) {
    throw new Error(
      [
        "Config validation failed: plugin-managed SecretRef provider integration is invalid.",
        ...pluginIntegrationErrors.map((error) => `- ${error.message}`),
      ].join("\n"),
    );
  }
  const modelRefCheck = await checkTouchedTextModelRefs({
    config: nextConfig,
    previousConfig: currentConfig,
    touchedPaths: operations.map(({ setPath }) => setPath),
    redactDependencyValues: true,
  });
  if (modelRefCheck.errors[0]) {
    throw new Error(modelRefCheck.errors[0]);
  }

  await replaceConfigFile({
    nextConfig,
    ...(snapshot.hash !== undefined ? { baseHash: snapshot.hash } : {}),
    writeOptions: {
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
    runtime.log(info(`${action} ${toDotPath(operation?.requestedPath ?? [])}. ${hint}`));
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
  if (
    params.options.dryRun &&
    params.options.json &&
    params.err instanceof ConfigSetDryRunValidationError
  ) {
    writeRuntimeJson(params.runtime, params.err.result);
    params.runtime.exit(1);
    return;
  }
  params.runtime.error(danger(String(params.err)));
  params.runtime.exit(1);
}
