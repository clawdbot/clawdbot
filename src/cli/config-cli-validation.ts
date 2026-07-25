import { isRecord as isPlainRecord } from "@openclaw/normalization-core/record-coerce";
import type { ConfigFileSnapshot } from "../config/config.js";
import { readConfigFileSnapshot } from "../config/config.js";
import { formatConfigIssueLines } from "../config/issue-format.js";
import { attachConfigIssueDiagnostics } from "../config/issue-location.js";
import { isPluginPackagingRuntimeOutputInvalidConfigSnapshot } from "../config/recovery-policy.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  coerceSecretRef,
  resolveSecretInputRef,
  type PluginIntegrationSecretProviderConfig,
  type SecretRef,
} from "../config/types.secrets.js";
import { validateConfigObjectRawWithPlugins } from "../config/validation.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { type RuntimeEnv, defaultRuntime } from "../runtime.js";
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
import type { ConfigSetOperation } from "./config-cli-input.js";
import { formatPluginPackagingRuntimeOutputRecoveryHint } from "./config-recovery-hints.js";
import type { ConfigSetDryRunError } from "./config-set-dryrun.js";

function formatInvalidConfigRepairHint(
  snapshot: Pick<ConfigFileSnapshot, "valid" | "issues" | "warnings" | "legacyIssues">,
  doctorMessage: string,
): string {
  return isPluginPackagingRuntimeOutputInvalidConfigSnapshot(snapshot)
    ? formatPluginPackagingRuntimeOutputRecoveryHint()
    : `Run \`${formatCliCommand("openclaw doctor --fix")}\` ${doctorMessage}`;
}

export async function loadValidConfig(runtime: RuntimeEnv = defaultRuntime) {
  const snapshot = await readConfigFileSnapshot();
  if (snapshot.valid) {
    return snapshot;
  }
  runtime.error(`OpenClaw config is invalid: ${shortenHomePath(snapshot.path)}`);
  const displayIssues = attachConfigIssueDiagnostics(snapshot.issues, {
    raw: snapshot.raw,
    parsed: snapshot.parsed,
    effective: snapshot.sourceConfig,
    configPath: snapshot.path,
    formatPathForDisplay: true,
    includeReceivedValueHint: true,
  });
  for (const line of formatConfigIssueLines(displayIssues, "-", { normalizeRoot: true })) {
    runtime.error(line);
  }
  runtime.error(formatInvalidConfigRepairHint(snapshot, "to repair, then retry."));
  runtime.exit(1);
  return snapshot;
}

export { formatInvalidConfigRepairHint };

function collectSecretRefsFromUnknown(value: unknown): SecretRef[] {
  const refs: SecretRef[] = [];
  const visit = (candidate: unknown) => {
    const ref = coerceSecretRef(candidate);
    if (ref) {
      refs.push(ref);
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
    } else if (isPlainRecord(candidate)) {
      Object.values(candidate).forEach(visit);
    }
  };
  visit(value);
  return refs;
}

export function collectDryRunRefs(params: {
  config: OpenClawConfig;
  operations: ConfigSetOperation[];
}): SecretRef[] {
  const refsByKey = new Map<string, SecretRef>();
  const targetPaths = new Set<string>();
  const providerAliases = new Set<string>();
  let includeAllDiscoveredRefs = false;

  for (const operation of params.operations) {
    if (operation.assignedRef) {
      refsByKey.set(secretRefKey(operation.assignedRef), operation.assignedRef);
    }
    for (const ref of collectSecretRefsFromUnknown(operation.value)) {
      refsByKey.set(secretRefKey(ref), ref);
    }
    if (operation.touchedSecretTargetPath) {
      targetPaths.add(operation.touchedSecretTargetPath);
    }
    if (operation.touchedProviderAlias) {
      providerAliases.add(operation.touchedProviderAlias);
    }
    includeAllDiscoveredRefs ||= operation.touchesAllSecretRefs === true;
  }

  if (!includeAllDiscoveredRefs && targetPaths.size === 0 && providerAliases.size === 0) {
    return [...refsByKey.values()];
  }

  const defaults = params.config.secrets?.defaults;
  for (const target of discoverConfigSecretTargets(params.config)) {
    const { ref } = resolveSecretInputRef({
      value: target.value,
      refValue: target.refValue,
      defaults,
    });
    if (
      ref &&
      (includeAllDiscoveredRefs ||
        targetPaths.has(target.path) ||
        providerAliases.has(ref.provider))
    ) {
      refsByKey.set(secretRefKey(ref), ref);
    }
  }
  return [...refsByKey.values()];
}

export async function collectDryRunResolvabilityErrors(params: {
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
        message: String(err),
        ref: `${ref.source}:${ref.provider}:${ref.id}`,
      });
    }
  }
  return failures;
}

export function collectDryRunStaticErrorsForSkippedExecRefs(params: {
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

export function selectDryRunRefsForResolution(params: {
  refs: SecretRef[];
  allowExecInDryRun: boolean;
}): { refsToResolve: SecretRef[]; skippedExecRefs: SecretRef[] } {
  const refsToResolve: SecretRef[] = [];
  const skippedExecRefs: SecretRef[] = [];
  for (const ref of params.refs) {
    (ref.source === "exec" && !params.allowExecInDryRun ? skippedExecRefs : refsToResolve).push(
      ref,
    );
  }
  return { refsToResolve, skippedExecRefs };
}

export function collectDryRunSchemaErrors(config: OpenClawConfig): ConfigSetDryRunError[] {
  const validated = validateConfigObjectRawWithPlugins(config);
  if (validated.ok) {
    return [];
  }
  return formatConfigIssueLines(validated.issues, "-", { normalizeRoot: true }).map((message) => ({
    kind: "schema",
    message,
  }));
}

function touchesSecretProviderCollection(path: readonly string[]): boolean {
  return (
    (path.length === 1 && path[0] === "secrets") ||
    (path.length === 2 && path[0] === "secrets" && path[1] === "providers")
  );
}

export function collectPluginIntegrationProviderErrors(params: {
  config: OpenClawConfig;
  operations: ConfigSetOperation[];
}): ConfigSetDryRunError[] {
  const providers = params.config.secrets?.providers ?? {};
  let validateAllProviders = false;
  const touchedProviderAliases = new Set<string>();
  for (const operation of params.operations) {
    if (operation.touchedProviderAlias) {
      touchedProviderAliases.add(operation.touchedProviderAlias);
    }
    if (operation.assignedRef) {
      touchedProviderAliases.add(operation.assignedRef.provider);
    }
    for (const ref of collectSecretRefsFromUnknown(operation.value)) {
      touchedProviderAliases.add(ref.provider);
    }
    validateAllProviders ||= touchesSecretProviderCollection(operation.setPath);
  }
  if (!validateAllProviders && touchedProviderAliases.size === 0) {
    return [];
  }
  const integrationProviders: Array<{
    alias: string;
    provider: PluginIntegrationSecretProviderConfig;
  }> = [];
  for (const [alias, provider] of Object.entries(providers)) {
    if (
      (validateAllProviders || touchedProviderAliases.has(alias)) &&
      isPluginIntegrationSecretProviderConfig(provider)
    ) {
      integrationProviders.push({ alias, provider });
    }
  }
  if (integrationProviders.length === 0) {
    return [];
  }
  const manifestRegistry = loadPluginMetadataSnapshot({
    config: params.config,
    env: process.env,
  }).manifestRegistry;
  const errors: ConfigSetDryRunError[] = [];
  for (const { alias, provider } of integrationProviders) {
    const resolved = resolveSecretProviderIntegrationConfig({
      manifestRegistry,
      providerAlias: alias,
      providerConfig: provider,
      config: params.config,
      env: process.env,
    });
    if (!resolved.ok) {
      errors.push({ kind: "schema", message: `secrets.providers.${alias}: ${resolved.reason}` });
    }
  }
  return errors;
}

export function dedupeDryRunErrors(errors: ConfigSetDryRunError[]): ConfigSetDryRunError[] {
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

export function formatDryRunFailureMessage(params: {
  errors: ConfigSetDryRunError[];
  skippedExecRefs: number;
}): string {
  const missingPathErrors = params.errors.filter((error) => error.kind === "missing-path");
  const schemaErrors = params.errors.filter((error) => error.kind === "schema");
  const resolveErrors = params.errors.filter((error) => error.kind === "resolvability");
  const modelErrors = params.errors.filter((error) => error.kind === "model");
  const lines: string[] = missingPathErrors.map((error) => error.message);
  if (schemaErrors.length > 0) {
    lines.push(
      "Dry run failed: config schema validation failed.",
      ...schemaErrors.map((error) => `- ${error.message}`),
    );
  }
  if (resolveErrors.length > 0) {
    lines.push(
      `Dry run failed: ${resolveErrors.length} SecretRef assignment(s) could not be resolved.`,
      ...resolveErrors
        .slice(0, 5)
        .map((error) => `- ${error.ref ?? "<unknown-ref>"} -> ${error.message}`),
    );
    if (resolveErrors.length > 5) {
      lines.push(`- ... ${resolveErrors.length - 5} more`);
    }
  }
  if (modelErrors.length > 0) {
    lines.push(
      "Dry run failed: model reference validation failed.",
      ...modelErrors.map((error) => `- ${error.message}`),
    );
  }
  if (params.skippedExecRefs > 0) {
    lines.push(
      `Dry run note: skipped ${params.skippedExecRefs} exec SecretRef resolvability check(s). Re-run with --allow-exec to execute exec providers during dry-run.`,
    );
  }
  return lines.join("\n");
}
