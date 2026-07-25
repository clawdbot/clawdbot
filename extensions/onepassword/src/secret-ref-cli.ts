import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { resolveSecretPlanTargetByPath } from "openclaw/plugin-sdk/secret-ref-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { encodeOnePasswordSecretId } from "../onepassword-secret-id.js";

type CommandLike = {
  command(name: string): CommandLike;
  description(value: string): CommandLike;
  option(
    flags: string,
    description: string,
    defaultValueOrParser?: string | ((value: string, previous?: string[]) => string[]),
    defaultValue?: string[],
  ): CommandLike;
  action<TOptions>(fn: (options: TOptions) => void | Promise<void>): CommandLike;
};

type SecretRef = {
  source: "exec";
  provider: string;
  id: string;
};

type SecretsPlanTarget = {
  type: string;
  path: string;
  pathSegments: string[];
  agentId?: string;
  providerId?: string;
  accountId?: string;
  ref: SecretRef;
};

type OnePasswordExecProviderConfig = {
  source: "exec";
  pluginIntegration: {
    pluginId: "onepassword";
    integrationId: "onepassword";
  };
};

type ProviderSecretMapping = {
  providerId: string;
  secretId: string;
};

type ConfigTargetSecretMapping = {
  path: string;
  agentId?: string;
  secretId: string;
};

type SecretsApplyPlan = {
  version: 1;
  protocolVersion: 1;
  generatedAt: string;
  generatedBy: "manual";
  providerUpserts: Record<string, OnePasswordExecProviderConfig>;
  targets: SecretsPlanTarget[];
};

type RegisterOnePasswordSecretRefCommandsParams = {
  command: CommandLike;
  config: OpenClawConfig;
};

type StatusOptions = {
  json?: boolean;
  providerAlias?: string;
};

type SetupOptions = {
  planOut?: string;
  providerAlias?: string;
  openaiId?: string;
  anthropicId?: string;
  openrouterId?: string;
  providerKey?: string[];
  target?: string[];
};

type ProviderStatus = {
  configured: boolean;
  source?: string;
  command?: string;
  pluginIntegration?: {
    pluginId: string;
    integrationId: string;
  };
};

const ONEPASSWORD_PROVIDER_ALIAS = "onepassword";
const SECRET_PROVIDER_ALIAS_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const MODEL_PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FORBIDDEN_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

function writeLine(message = ""): void {
  process.stdout.write(`${message}\n`);
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseDotPath(pathname: string): string[] {
  return pathname
    .split(".")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function toDotPath(segments: string[]): string {
  return segments.join(".");
}

function assertValidProviderAlias(value: string): void {
  if (!SECRET_PROVIDER_ALIAS_PATTERN.test(value)) {
    throw new Error(
      `Invalid provider alias "${value}". Use lowercase letters, numbers, underscores, or hyphens.`,
    );
  }
}

function assertValidModelProviderId(label: string, value: string): void {
  if (!MODEL_PROVIDER_ID_PATTERN.test(value)) {
    throw new Error(`Invalid ${label} model provider id: ${value}`);
  }
}

function normalizeOnePasswordSecretId(label: string, value: string): string {
  try {
    return encodeOnePasswordSecretId(value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${label} 1Password SecretRef id: ${detail}`, { cause: error });
  }
}

function readProviderStatus(config: OpenClawConfig, providerAlias: string): ProviderStatus {
  const provider = config.secrets?.providers?.[providerAlias];
  if (!isRecord(provider)) {
    return { configured: false };
  }
  const base = {
    configured: true,
    source: normalizeOptionalString(provider.source),
  };
  if (provider.source !== "exec") {
    return base;
  }
  if ("pluginIntegration" in provider) {
    return {
      ...base,
      pluginIntegration: provider.pluginIntegration as ProviderStatus["pluginIntegration"],
    };
  }
  return {
    ...base,
    command: normalizeOptionalString(provider.command),
  };
}

function isOnePasswordIntegrationProvider(value: unknown): boolean {
  if (!isRecord(value) || value.source !== "exec" || !isRecord(value.pluginIntegration)) {
    return false;
  }
  return (
    value.pluginIntegration.pluginId === "onepassword" &&
    value.pluginIntegration.integrationId === "onepassword"
  );
}

function resolveStatusProviderAlias(config: OpenClawConfig, requestedAlias?: string): string {
  const explicitAlias = normalizeOptionalString(requestedAlias);
  if (explicitAlias) {
    assertValidProviderAlias(explicitAlias);
    return explicitAlias;
  }
  if (readProviderStatus(config, ONEPASSWORD_PROVIDER_ALIAS).configured) {
    return ONEPASSWORD_PROVIDER_ALIAS;
  }
  const configuredAliases = Object.entries(config.secrets?.providers ?? {})
    .filter(([, provider]) => isOnePasswordIntegrationProvider(provider))
    .map(([alias]) => alias)
    .toSorted();
  if (configuredAliases.length > 1) {
    throw new Error(
      `Multiple 1Password provider aliases are configured (${configuredAliases.join(", ")}). Use --provider-alias <alias>.`,
    );
  }
  return configuredAliases[0] ?? ONEPASSWORD_PROVIDER_ALIAS;
}

function resolveOpCommand(): string {
  return normalizeOptionalString(process.env.CLAW_1PASSWORD_OP) ?? "op";
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function isConfiguredOpCommandAvailable(command: string): Promise<boolean | undefined> {
  if (!path.isAbsolute(command)) {
    return undefined;
  }
  return pathExists(command);
}

function buildProviderConfig(): OnePasswordExecProviderConfig {
  return {
    source: "exec",
    pluginIntegration: {
      pluginId: "onepassword",
      integrationId: "onepassword",
    },
  };
}

function createModelApiKeyTarget(params: {
  providerAlias: string;
  providerId: string;
  secretId: string;
}): SecretsPlanTarget {
  assertValidModelProviderId("target", params.providerId);
  return {
    type: "models.providers.apiKey",
    path: `models.providers.${params.providerId}.apiKey`,
    pathSegments: ["models", "providers", params.providerId, "apiKey"],
    providerId: params.providerId,
    ref: {
      source: "exec",
      provider: params.providerAlias,
      id: params.secretId,
    },
  };
}

function parseTargetSpecifier(value: string): {
  path: string;
  agentId?: string;
} {
  if (value.startsWith("auth-profiles:")) {
    const remainder = value.slice("auth-profiles:".length);
    const separatorIndex = remainder.indexOf(":");
    const agentId = separatorIndex >= 0 ? remainder.slice(0, separatorIndex) : "";
    const targetPath = separatorIndex >= 0 ? remainder.slice(separatorIndex + 1) : "";
    if (!agentId || !targetPath) {
      throw new Error(`Invalid --target auth-profiles target: ${value}`);
    }
    return { agentId, path: targetPath };
  }
  return {
    path: value.startsWith("openclaw:") ? value.slice("openclaw:".length) : value,
  };
}

function createConfigSecretTarget(params: {
  providerAlias: string;
  path: string;
  agentId?: string;
  secretId: string;
}): SecretsPlanTarget {
  const pathSegments = parseDotPath(params.path);
  const normalizedPath = toDotPath(pathSegments);
  if (
    pathSegments.length === 0 ||
    normalizedPath !== params.path ||
    pathSegments.some((segment) => FORBIDDEN_PATH_SEGMENTS.has(segment))
  ) {
    throw new Error(`Invalid --target config path: ${params.path}`);
  }
  const resolved = resolveSecretPlanTargetByPath({
    configFile: params.agentId ? "auth-profiles.json" : "openclaw.json",
    pathSegments,
  });
  if (!resolved) {
    throw new Error(`Unknown or unsupported 1Password setup target path: ${params.path}`);
  }
  return {
    type: resolved.targetType,
    path: normalizedPath,
    pathSegments,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(resolved.providerId ? { providerId: resolved.providerId } : {}),
    ...(resolved.accountId ? { accountId: resolved.accountId } : {}),
    ref: {
      source: "exec",
      provider: params.providerAlias,
      id: params.secretId,
    },
  };
}

function parseProviderKeyMappings(values: string[] | undefined): ProviderSecretMapping[] {
  return (values ?? []).map((value) => {
    const separator = value.indexOf("=");
    if (separator <= 0 || separator === value.length - 1) {
      throw new Error(
        `Invalid --provider-key value "${value}". Use <model-provider-id>=<1password-secret-id>.`,
      );
    }
    const providerId = value.slice(0, separator).trim();
    assertValidModelProviderId("--provider-key", providerId);
    const secretId = normalizeOnePasswordSecretId(
      `--provider-key ${providerId}`,
      value.slice(separator + 1).trim(),
    );
    return { providerId, secretId };
  });
}

function parseConfigTargetMappings(values: string[] | undefined): ConfigTargetSecretMapping[] {
  return (values ?? []).map((value) => {
    const separator = value.indexOf("=");
    if (separator <= 0 || separator === value.length - 1) {
      throw new Error(
        `Invalid --target value "${value}". Use <openclaw-config-path>=<1password-secret-id>.`,
      );
    }
    const target = parseTargetSpecifier(value.slice(0, separator).trim());
    const secretId = normalizeOnePasswordSecretId(
      `--target ${target.path}`,
      value.slice(separator + 1).trim(),
    );
    return Object.assign(
      { path: target.path, secretId },
      target.agentId ? { agentId: target.agentId } : {},
    );
  });
}

function collectProviderSecrets(options: {
  openaiId?: string;
  anthropicId?: string;
  openrouterId?: string;
  providerKey?: string[];
}): ProviderSecretMapping[] {
  const providerSecrets: ProviderSecretMapping[] = [];
  if (options.openaiId) {
    providerSecrets.push({ providerId: "openai", secretId: options.openaiId });
  }
  if (options.anthropicId) {
    providerSecrets.push({ providerId: "anthropic", secretId: options.anthropicId });
  }
  if (options.openrouterId) {
    providerSecrets.push({ providerId: "openrouter", secretId: options.openrouterId });
  }
  providerSecrets.push(...parseProviderKeyMappings(options.providerKey));

  const seen = new Set<string>();
  for (const entry of providerSecrets) {
    const normalized = entry.providerId.toLowerCase();
    if (seen.has(normalized)) {
      throw new Error(`Duplicate model provider id in 1Password setup: ${entry.providerId}`);
    }
    seen.add(normalized);
  }
  return providerSecrets;
}

function assertNoDuplicatePlanTargets(targets: SecretsPlanTarget[]): void {
  const seen = new Set<string>();
  for (const target of targets) {
    const key = target.agentId
      ? `auth-profiles:${target.agentId}:${target.path}`
      : `openclaw:${target.path}`;
    if (seen.has(key)) {
      throw new Error(`Duplicate secret target path in 1Password setup: ${target.path}`);
    }
    seen.add(key);
  }
}

function buildPlan(params: {
  providerAlias: string;
  providerConfig: OnePasswordExecProviderConfig;
  providerSecrets: ProviderSecretMapping[];
  configTargetSecrets?: ConfigTargetSecretMapping[];
}): SecretsApplyPlan {
  const targets = [
    ...params.providerSecrets.map((entry) =>
      createModelApiKeyTarget({
        providerAlias: params.providerAlias,
        providerId: entry.providerId,
        secretId: entry.secretId,
      }),
    ),
    ...(params.configTargetSecrets ?? []).map((entry) =>
      createConfigSecretTarget({
        providerAlias: params.providerAlias,
        path: entry.path,
        ...(entry.agentId ? { agentId: entry.agentId } : {}),
        secretId: entry.secretId,
      }),
    ),
  ];
  assertNoDuplicatePlanTargets(targets);
  return {
    version: 1,
    protocolVersion: 1,
    generatedAt: new Date().toISOString(),
    generatedBy: "manual",
    providerUpserts: {
      [params.providerAlias]: params.providerConfig,
    },
    targets,
  };
}

async function promptOptionalSecretId(label: string): Promise<string | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return undefined;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return normalizeOptionalString(
      await rl.question(`${label} 1Password SecretRef id (blank to skip): `),
    );
  } finally {
    rl.close();
  }
}

async function promptProviderSecrets(options: SetupOptions): Promise<ProviderSecretMapping[]> {
  const openaiId =
    normalizeOptionalString(options.openaiId) ?? (await promptOptionalSecretId("OpenAI"));
  const anthropicId =
    normalizeOptionalString(options.anthropicId) ?? (await promptOptionalSecretId("Anthropic"));
  const openrouterId =
    normalizeOptionalString(options.openrouterId) ?? (await promptOptionalSecretId("OpenRouter"));
  const normalizedOpenaiId = openaiId
    ? normalizeOnePasswordSecretId("OpenAI", openaiId)
    : undefined;
  const normalizedAnthropicId = anthropicId
    ? normalizeOnePasswordSecretId("Anthropic", anthropicId)
    : undefined;
  const normalizedOpenrouterId = openrouterId
    ? normalizeOnePasswordSecretId("OpenRouter", openrouterId)
    : undefined;
  return collectProviderSecrets({
    ...(normalizedOpenaiId ? { openaiId: normalizedOpenaiId } : {}),
    ...(normalizedAnthropicId ? { anthropicId: normalizedAnthropicId } : {}),
    ...(normalizedOpenrouterId ? { openrouterId: normalizedOpenrouterId } : {}),
    providerKey: options.providerKey,
  });
}

async function runStatus(config: OpenClawConfig, options: StatusOptions): Promise<void> {
  const providerAlias = resolveStatusProviderAlias(config, options.providerAlias);
  const provider = readProviderStatus(config, providerAlias);
  const opCommand = resolveOpCommand();
  const result = {
    providerAlias,
    provider,
    opCommand,
    opCommandAvailable: await isConfiguredOpCommandAvailable(opCommand),
  };
  if (options.json) {
    writeJson(result);
    return;
  }
  writeLine(`1Password provider: ${provider.configured ? "configured" : "not configured"}`);
  if (provider.source) {
    writeLine(`Source: ${provider.source}`);
  }
  if (provider.command) {
    writeLine(`Command: ${provider.command}`);
  }
  if (provider.pluginIntegration) {
    writeLine(
      `Plugin integration: ${provider.pluginIntegration.pluginId}:${provider.pluginIntegration.integrationId}`,
    );
  }
  writeLine(`op command: ${result.opCommand}`);
  if (result.opCommandAvailable !== undefined) {
    writeLine(`op command exists: ${result.opCommandAvailable ? "yes" : "no"}`);
  }
  writeLine("Auth: onepassword service-account token file");
}

async function writePlanFile(plan: SecretsApplyPlan, requestedPath?: string): Promise<string> {
  const planPath =
    normalizeOptionalString(requestedPath) ??
    path.join(resolvePreferredOpenClawTmpDir(), `openclaw-1password-secrets-${randomUUID()}.json`);
  try {
    await fs.writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      throw new Error(`Plan path already exists; choose a new --plan-out path: ${planPath}`, {
        cause: error,
      });
    }
    throw error;
  }
  return planPath;
}

async function runSetup(options: SetupOptions): Promise<void> {
  const providerAlias =
    normalizeOptionalString(options.providerAlias) ?? ONEPASSWORD_PROVIDER_ALIAS;
  assertValidProviderAlias(providerAlias);
  const providerSecrets = await promptProviderSecrets(options);
  const plan = buildPlan({
    providerAlias,
    providerConfig: buildProviderConfig(),
    providerSecrets,
    configTargetSecrets: parseConfigTargetMappings(options.target),
  });
  const planPath = await writePlanFile(plan, options.planOut);
  writeLine(`Plan written to ${planPath}`);
  writeLine(`Targets: ${plan.targets.length}`);
  writeLine("");
  writeLine("Next steps:");
  writeLine("  openclaw plugins enable onepassword");
  writeLine(`  openclaw secrets apply --from ${planPath} --dry-run --allow-exec`);
  writeLine(`  openclaw secrets apply --from ${planPath} --allow-exec`);
  writeLine("  openclaw secrets audit --check --allow-exec");
  writeLine("  openclaw secrets reload");
}

export function registerOnePasswordSecretRefCommands(
  params: RegisterOnePasswordSecretRefCommandsParams,
): void {
  const secretRef = params.command.command("secretref").description("Manage 1Password SecretRefs");
  secretRef
    .command("status")
    .description("Show 1Password SecretRef provider status")
    .option("--json", "Print JSON status")
    .option("--provider-alias <alias>", "Secret provider alias to inspect")
    .action((options: StatusOptions) => runStatus(params.config, options));
  secretRef
    .command("setup")
    .description("Create a 1Password SecretRef setup plan")
    .option("--plan-out <path>", "Write the generated secrets apply plan to a path")
    .option(
      "--provider-alias <alias>",
      "Secret provider alias to configure",
      ONEPASSWORD_PROVIDER_ALIAS,
    )
    .option("--openai-id <id>", "1Password SecretRef id for models.providers.openai.apiKey")
    .option("--anthropic-id <id>", "1Password SecretRef id for models.providers.anthropic.apiKey")
    .option("--openrouter-id <id>", "1Password SecretRef id for models.providers.openrouter.apiKey")
    .option(
      "--provider-key <provider=id>",
      "1Password SecretRef id for any models.providers.<provider>.apiKey target",
      (value: string, previous: string[] = []) => [...previous, value],
      [],
    )
    .option(
      "--target <path=id>",
      "1Password SecretRef id for any known SecretRef target path",
      (value: string, previous: string[] = []) => [...previous, value],
      [],
    )
    .action((options: SetupOptions) => runSetup(options));
}

export const testing = {
  buildPlan,
  buildProviderConfig,
  collectProviderSecrets,
  createModelApiKeyTarget,
  createConfigSecretTarget,
  parseConfigTargetMappings,
  parseProviderKeyMappings,
  writePlanFile,
};
