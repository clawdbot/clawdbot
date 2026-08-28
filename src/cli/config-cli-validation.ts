import { isRecord as isPlainRecord } from "@openclaw/normalization-core/record-coerce";
import { uniqueValues } from "@openclaw/normalization-core/string-normalization";
import type { ConfigFileSnapshot } from "../config/config.js";
import { readConfigFileSnapshotForWrite } from "../config/config.js";
import { formatConfigIssueLines, normalizeConfigIssues } from "../config/issue-format.js";
import { renderConfigValidationIssueLines } from "../config/issue-location.js";
import { isPluginPackagingRuntimeOutputInvalidConfigSnapshot } from "../config/recovery-policy.js";
import type { ConfigValidationIssue } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  coerceSecretRef,
  isSecretRef,
  resolveSecretInputRef,
  type SecretRef,
} from "../config/types.secrets.js";
import {
  collectUnsupportedSecretRefPolicyIssues,
  validateConfigObjectRawWithPlugins,
} from "../config/validation.js";
import { formatErrorMessage } from "../infra/errors.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { type RuntimeEnv, defaultRuntime, writeRuntimeJson } from "../runtime.js";
import { assertSecureExecCommandPath } from "../secrets/exec-provider-path-validation.js";
import {
  isPluginIntegrationSecretProviderConfig,
  resolveSecretProviderIntegrationConfig,
} from "../secrets/provider-integrations.js";
import {
  formatExecSecretRefIdValidationMessage,
  isValidExecSecretRefId,
  secretRefKey,
} from "../secrets/ref-contract.js";
import { resolveSecretRefValue } from "../secrets/resolve.js";
import { discoverConfigSecretTargets } from "../secrets/target-registry.js";
import { shortenHomePath } from "../utils.js";
import { formatCliCommand } from "./command-format.js";
import type { ConfigMutationOptions, ConfigSetOperation } from "./config-cli-input.js";
import { getAtPath } from "./config-cli-path.js";
import { checkTouchedTextModelRefs } from "./config-model-validation.js";
import { formatPluginPackagingRuntimeOutputRecoveryHint } from "./config-recovery-hints.js";
import type { ConfigSetDryRunError, ConfigSetDryRunResult } from "./config-set-dryrun.js";
import { formatCliJsonFailure } from "./failure-output.js";
import { exitCliAfterOutput } from "./one-shot-exit.js";

function formatInvalidConfigRepairHint(
  snapshot: Pick<ConfigFileSnapshot, "valid" | "issues" | "warnings" | "legacyIssues">,
  doctorMessage: string,
): string {
  return isPluginPackagingRuntimeOutputInvalidConfigSnapshot(snapshot)
    ? formatPluginPackagingRuntimeOutputRecoveryHint()
    : `Run \`${formatCliCommand("openclaw doctor --fix")}\` ${doctorMessage}`;
}

export function ensureValidConfigSnapshotForCli(
  snapshot: ConfigFileSnapshot,
  runtime: RuntimeEnv,
  options: { json?: boolean } = {},
): void {
  if (snapshot.valid) {
    return;
  }
  if (options.json) {
    writeRuntimeJson(runtime, {
      ...formatCliJsonFailure(`OpenClaw config is invalid: ${shortenHomePath(snapshot.path)}`),
      issues: normalizeConfigIssues(snapshot.issues),
    });
    exitCliAfterOutput(runtime, 1);
  }
  runtime.error(`OpenClaw config is invalid: ${shortenHomePath(snapshot.path)}`);
  for (const line of renderConfigValidationIssueLines(snapshot)) {
    runtime.error(line);
  }
  runtime.error(formatInvalidConfigRepairHint(snapshot, "to repair, then retry."));
  exitCliAfterOutput(runtime, 1);
}

export async function loadValidConfigForWrite(runtime: RuntimeEnv = defaultRuntime) {
  const prepared = await readConfigFileSnapshotForWrite();
  ensureValidConfigSnapshotForCli(prepared.snapshot, runtime);
  return prepared;
}

export { formatInvalidConfigRepairHint };

export async function strictlyValidateConfigSnapshotForCli(
  snapshot: ConfigFileSnapshot,
  pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "manifestRegistry">,
): Promise<ConfigFileSnapshot> {
  if (!snapshot.valid) {
    return snapshot;
  }
  const validated = validateConfigObjectRawWithPlugins(snapshot.sourceConfig, {
    semanticValidation: "strict",
    pluginMetadataSnapshot,
  });
  const issues = validated.ok
    ? await collectConfigSecretProviderErrors({ config: snapshot.runtimeConfig })
    : validated.issues;
  return issues.length === 0 ? snapshot : { ...snapshot, valid: false, issues };
}

type ConfigMutationSecretSelection = {
  refs: SecretRef[];
  // Undefined selects every remaining provider after a collection replacement/deletion.
  providerAliases: Set<string> | undefined;
};

function pathContains(parent: readonly string[], child: readonly string[]): boolean {
  return parent.length <= child.length && parent.every((part, index) => part === child[index]);
}

function selectConfigMutationSecrets(
  config: OpenClawConfig,
  operations: ConfigSetOperation[],
): ConfigMutationSecretSelection {
  const paths = operations.map(({ setPath }) => setPath);
  const changedProviders = new Set<string>();
  const changedDefaults = new Set<string>();
  let allProviders = false;
  for (const path of paths) {
    if (path[0] !== "secrets") {
      continue;
    }
    if (path.length === 1 || path[1] === "providers") {
      const alias = path[2];
      if (alias === undefined) {
        allProviders = true;
      } else {
        changedProviders.add(alias);
      }
    }
    if (path.length === 1 || path[1] === "defaults") {
      changedDefaults.add(path[2] ?? "*");
    }
  }

  const refsByKey = new Map<string, SecretRef>();
  const record = (ref: SecretRef) => refsByKey.set(secretRefKey(ref), ref);
  const defaults = config.secrets?.defaults;
  const ownedPaths: string[][] = [];
  const overlaps = (targetPath: string[]) =>
    paths.some((path) => pathContains(path, targetPath) || pathContains(targetPath, path));
  for (const target of discoverConfigSecretTargets(config)) {
    ownedPaths.push(target.pathSegments);
    if (target.refPathSegments) {
      ownedPaths.push(target.refPathSegments);
    }
    const { explicitRef, ref } = resolveSecretInputRef({
      value: target.value,
      refValue: target.refValue,
      defaults,
    });
    if (!ref) {
      continue;
    }
    const usesDefault = !isSecretRef(explicitRef ? target.refValue : target.value);
    if (
      allProviders ||
      changedProviders.has(ref.provider) ||
      overlaps(target.pathSegments) ||
      (target.refPathSegments && overlaps(target.refPathSegments)) ||
      (usesDefault && (changedDefaults.has("*") || changedDefaults.has(ref.source)))
    ) {
      record(ref);
    }
  }

  // Inspect only surviving values, never discarded batch assignments. Registry-owned
  // fields above also preserve explicit sibling-ref precedence over inline fallbacks.
  const visit = (value: unknown, path: string[]): void => {
    if (ownedPaths.some((ownedPath) => pathContains(ownedPath, path))) {
      return;
    }
    const ref = coerceSecretRef(value, defaults);
    if (ref) {
      record(ref);
    } else if (Array.isArray(value) || isPlainRecord(value)) {
      for (const [key, child] of Object.entries(value)) {
        visit(child, [...path, key]);
      }
    }
  };
  for (const path of paths) {
    visit(getAtPath(config, path).value, path);
  }
  const refs = [...refsByKey.values()];
  return {
    refs,
    providerAliases: allProviders
      ? undefined
      : new Set([...changedProviders, ...refs.map((ref) => ref.provider)]),
  };
}

async function collectDryRunResolvabilityErrors(params: {
  refs: SecretRef[];
  config: OpenClawConfig;
}): Promise<ConfigSetDryRunError[]> {
  const failures: ConfigSetDryRunError[] = [];
  for (const ref of params.refs) {
    try {
      await resolveSecretRefValue(ref, { config: params.config, env: process.env });
    } catch (err) {
      failures.push({
        kind: "resolvability",
        message: formatErrorMessage(err),
        ref: `${ref.source}:${ref.provider}:${ref.id}`,
      });
    }
  }
  return failures;
}

function collectDryRunStaticErrorsForSkippedExecRefs(params: {
  refs: SecretRef[];
  config: OpenClawConfig;
}): ConfigSetDryRunError[] {
  const failures: ConfigSetDryRunError[] = [];
  for (const ref of params.refs) {
    const id = ref.id.trim();
    const refLabel = `${ref.source}:${ref.provider}:${id}`;
    if (!id) {
      failures.push({
        kind: "resolvability",
        message: "Error: Secret reference id is empty.",
        ref: refLabel,
      });
      continue;
    }
    if (!isValidExecSecretRefId(id)) {
      failures.push({
        kind: "resolvability",
        message: `Error: ${formatExecSecretRefIdValidationMessage()} (ref: ${refLabel}).`,
        ref: refLabel,
      });
      continue;
    }
    const providerConfig = params.config.secrets?.providers?.[ref.provider];
    if (!providerConfig) {
      failures.push({
        kind: "resolvability",
        message: `Error: Secret provider "${ref.provider}" is not configured (ref: ${refLabel}).`,
        ref: refLabel,
      });
      continue;
    }
    if (providerConfig.source !== ref.source) {
      failures.push({
        kind: "resolvability",
        message: `Error: Secret provider "${ref.provider}" has source "${providerConfig.source}" but ref requests "${ref.source}".`,
        ref: refLabel,
      });
    }
  }
  return failures;
}

function selectDryRunRefsForResolution(params: { refs: SecretRef[]; allowExecInDryRun: boolean }): {
  refsToResolve: SecretRef[];
  skippedExecRefs: SecretRef[];
} {
  const refsToResolve: SecretRef[] = [];
  const skippedExecRefs: SecretRef[] = [];
  for (const ref of params.refs) {
    (ref.source === "exec" && !params.allowExecInDryRun ? skippedExecRefs : refsToResolve).push(
      ref,
    );
  }
  return { refsToResolve, skippedExecRefs };
}

function collectStrictConfigErrors(
  config: OpenClawConfig,
  pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "manifestRegistry">,
): ConfigSetDryRunError[] {
  const validated = validateConfigObjectRawWithPlugins(config, {
    semanticValidation: "strict",
    pluginMetadataSnapshot,
  });
  if (validated.ok) {
    return [];
  }
  return formatConfigIssueLines(validated.issues, "-", { normalizeRoot: true }).map((message) => ({
    kind: "schema",
    message,
  }));
}

export function assertStrictConfigForMutation(
  config: OpenClawConfig,
  pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "manifestRegistry">,
): void {
  const errors = collectStrictConfigErrors(config, pluginMetadataSnapshot);
  if (errors.length === 0) {
    return;
  }
  throw new Error(
    ["Config validation failed.", ...errors.map((error) => `- ${error.message}`)].join("\n"),
  );
}

async function collectConfigSecretProviderErrors(params: {
  config: OpenClawConfig;
  selection?: ConfigMutationSecretSelection;
}): Promise<ConfigValidationIssue[]> {
  const providers = params.config.secrets?.providers ?? {};
  const issues: ConfigValidationIssue[] = [];
  let manifestRegistry: PluginMetadataSnapshot["manifestRegistry"] | undefined;
  for (const [alias, provider] of Object.entries(providers)) {
    if (params.selection?.providerAliases && !params.selection.providerAliases.has(alias)) {
      continue;
    }
    const providerPath = `secrets.providers.${alias}`;
    if (isPluginIntegrationSecretProviderConfig(provider)) {
      // Preserve write-time manifest validation without adding executable-path
      // policy to plugin integrations; activation owns their materialized command.
      if (!params.selection) {
        continue;
      }
      manifestRegistry ??= loadPluginMetadataSnapshot({
        config: params.config,
        env: process.env,
      }).manifestRegistry;
      const resolved = resolveSecretProviderIntegrationConfig({
        manifestRegistry,
        providerAlias: alias,
        providerConfig: provider,
        config: params.config,
        env: process.env,
      });
      if (!resolved.ok) {
        issues.push({ path: providerPath, message: resolved.reason });
      }
    } else if (isPlainRecord(provider) && "command" in provider) {
      try {
        await assertSecureExecCommandPath({
          command: provider.command,
          label: `${providerPath}.command`,
          trustedDirs: provider.trustedDirs,
        });
      } catch (err) {
        issues.push({ path: `${providerPath}.command`, message: formatErrorMessage(err) });
      }
    }
  }
  return issues;
}

function dedupeDryRunErrors(errors: ConfigSetDryRunError[]): ConfigSetDryRunError[] {
  const deduped: ConfigSetDryRunError[] = [];
  const seen = new Set<string>();
  for (const error of errors) {
    const key =
      error.kind === "resolvability"
        ? `${error.kind}\u0000${error.ref ?? ""}\u0000${error.message}`
        : `${error.kind}\u0000${error.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(error);
    }
  }
  return deduped;
}

/** Validates one final candidate and decides whether the runner may preview, skip, or write it. */
export async function validateConfigMutation(params: {
  config: OpenClawConfig;
  previousConfig: OpenClawConfig;
  operations: ConfigSetOperation[];
  options: ConfigMutationOptions;
  configPath: string;
  unchanged: boolean;
  pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "manifestRegistry">;
}): Promise<{ kind: "dry-run"; result: ConfigSetDryRunResult } | { kind: "unchanged" | "write" }> {
  const { config, operations, options, pluginMetadataSnapshot } = params;
  const policyIssues = formatConfigIssueLines(collectUnsupportedSecretRefPolicyIssues(config), "", {
    normalizeRoot: true,
  }).map((line) => line.trim());
  const selection = selectConfigMutationSecrets(config, operations);
  const providerErrors = formatConfigIssueLines(
    await collectConfigSecretProviderErrors({ config, selection }),
    "",
  ).map((message): ConfigSetDryRunError => ({ kind: "schema", message }));
  if (!options.dryRun) {
    if (policyIssues.length > 0) {
      throw new Error(
        [
          "Config policy validation failed: unsupported SecretRef usage was detected.",
          ...policyIssues.slice(0, 5).map((issue) => `- ${issue}`),
          ...(policyIssues.length > 5 ? [`- ... ${policyIssues.length - 5} more`] : []),
        ].join("\n"),
      );
    }
    if (providerErrors.length > 0) {
      throw new Error(
        [
          "Config validation failed: SecretRef provider configuration is invalid.",
          ...providerErrors.map((error) => `- ${error.message}`),
        ].join("\n"),
      );
    }
    if (params.unchanged) {
      assertStrictConfigForMutation(config, pluginMetadataSnapshot);
      return { kind: "unchanged" };
    }
  }

  const modelCheck = await checkTouchedTextModelRefs({
    config,
    previousConfig: params.previousConfig,
    touchedPaths: operations.map(({ setPath }) => setPath),
    redactDependencyValues: true,
  });
  if (!options.dryRun) {
    if (modelCheck.errors[0]) {
      throw new Error(modelCheck.errors[0]);
    }
    return { kind: "write" };
  }

  const inputModes = uniqueValues(operations.map(({ inputMode }) => inputMode));
  const checksRefs = inputModes.some((mode) => mode !== "value");
  const requiresFullSchema = operations.some(
    (operation) =>
      operation.inputMode === "unset" ||
      (operation.inputMode === "json" && operation.schemaValidated !== true),
  );
  const { refsToResolve, skippedExecRefs } = selectDryRunRefsForResolution({
    refs: checksRefs ? selection.refs : [],
    allowExecInDryRun: Boolean(options.allowExec),
  });
  const errors: ConfigSetDryRunError[] = modelCheck.errors.map((message) => ({
    kind: "model",
    message,
  }));
  if (!requiresFullSchema) {
    errors.push(
      ...policyIssues.map((message): ConfigSetDryRunError => ({ kind: "schema", message })),
    );
  }
  errors.push(...providerErrors);
  if (requiresFullSchema) {
    errors.push(...collectStrictConfigErrors(config, pluginMetadataSnapshot));
  }
  if (checksRefs) {
    errors.push(
      ...collectDryRunStaticErrorsForSkippedExecRefs({ refs: skippedExecRefs, config }),
      ...(await collectDryRunResolvabilityErrors({ refs: refsToResolve, config })),
    );
  }
  const failures = dedupeDryRunErrors(errors);
  return {
    kind: "dry-run",
    result: {
      ok: failures.length === 0,
      operations: operations.length,
      configPath: params.configPath,
      inputModes,
      checks: {
        schema: requiresFullSchema || policyIssues.length > 0 || providerErrors.length > 0,
        resolvability: checksRefs || modelCheck.refsTotal > 0,
        resolvabilityComplete:
          (checksRefs || modelCheck.refsTotal > 0) &&
          skippedExecRefs.length === 0 &&
          modelCheck.refsChecked === modelCheck.refsTotal,
      },
      refsChecked: refsToResolve.length + modelCheck.refsChecked,
      skippedExecRefs: skippedExecRefs.length,
      ...(failures.length > 0 ? { errors: failures } : {}),
    },
  };
}
