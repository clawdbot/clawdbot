import { randomUUID } from "node:crypto";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { isRecord } from "openclaw/plugin-sdk/channel-secret-basic-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import {
  DEFAULT_SECRET_FILE_MAX_BYTES,
  tryReadSecretFileSync,
} from "openclaw/plugin-sdk/secret-file-runtime";
import { pluginSecretRefSetup } from "openclaw/plugin-sdk/secret-ref-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import {
  resolveTrustedOnePasswordCli,
  resolveTrustedOnePasswordDirectoryPath,
} from "../onepassword-op-path.js";
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

type SecretsApplyPlan = ReturnType<typeof pluginSecretRefSetup.buildPlan>;

type RegisterOnePasswordSecretRefCommandsParams = {
  command: CommandLike;
  config: OpenClawConfig;
  tokenFile: string;
  env?: NodeJS.ProcessEnv;
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

type SecretRefReadiness = {
  opCommand: string;
  opBinaryPath: string | null;
  opStatus: "ready" | "not-found" | "untrusted";
  tokenFile: string;
  tokenFileStatus: "ready" | "missing-or-unsafe";
  prerequisitesReady: boolean;
};

type ReadinessDependencies = {
  resolveTrustedCli?: typeof resolveTrustedOnePasswordCli;
  readTokenFile?: (filePath: string) => string | undefined;
};

type WritePlanFileDependencies = {
  platform?: NodeJS.Platform;
  createPrivateWindowsFile?: (filePath: string, content: string) => Promise<void>;
  resolveTrustedPlanDirectory?: typeof resolveTrustedOnePasswordDirectoryPath;
};

const ONEPASSWORD_PROVIDER_ALIAS = "onepassword";

function writeLine(message = ""): void {
  process.stdout.write(`${message}\n`);
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

type CommandShell = "cmd" | "posix" | "powershell";

function quoteCliArg(value: string, shell: CommandShell): string {
  if (/\r|\n/u.test(value)) {
    throw new Error("Command argument cannot contain CR or LF");
  }
  if (shell === "cmd") {
    if (/[%!]/u.test(value)) {
      throw new Error("Interactive Command Prompt cannot safely quote paths containing % or !");
    }
    const escaped = value.replaceAll('"', '\\"');
    return /[ \t"&|<>^()]/u.test(value) ? `"${escaped}"` : escaped || '""';
  }
  if (shell === "powershell") {
    return `'${value.replaceAll("'", "''")}'`;
  }
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function renderApplyCommands(
  planPath: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const render = (shell: CommandShell, extraIndent = "") => {
    const quotedPlanPath = quoteCliArg(planPath, shell);
    return [
      `${extraIndent}openclaw secrets apply --from ${quotedPlanPath} --dry-run --allow-exec`,
      `${extraIndent}openclaw secrets apply --from ${quotedPlanPath} --allow-exec`,
    ];
  };
  if (platform !== "win32") {
    return render("posix");
  }
  // Windows cannot reveal which parent shell will receive these copy-paste commands.
  // Print native variants instead of emitting syntax that is unsafe in the other shell.
  const powershellCommands = ["PowerShell:", ...render("powershell", "  ")];
  if (/[%!]/u.test(planPath)) {
    return [
      ...powershellCommands,
      "Command Prompt: unavailable for paths containing % or !; use PowerShell.",
    ];
  }
  return [...powershellCommands, "Command Prompt:", ...render("cmd", "  ")];
}

function assertValidProviderAlias(value: string): void {
  pluginSecretRefSetup.assertValidProviderAlias(value);
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

async function inspectSecretRefReadiness(
  params: { env: NodeJS.ProcessEnv; tokenFile: string },
  dependencies: ReadinessDependencies = {},
): Promise<SecretRefReadiness> {
  const resolveTrustedCli = dependencies.resolveTrustedCli ?? resolveTrustedOnePasswordCli;
  const readTokenFile =
    dependencies.readTokenFile ??
    ((filePath: string) =>
      tryReadSecretFileSync(filePath, "1Password service account token", {
        maxBytes: DEFAULT_SECRET_FILE_MAX_BYTES,
        rejectHardlinks: false,
        rejectSymlink: true,
      }));
  const configuredOpCommand = normalizeOptionalString(params.env.CLAW_1PASSWORD_OP);
  const opCommand = configuredOpCommand ?? "op";
  const { opBinaryPath, opStatus } = await (async () => {
    try {
      const resolvedPath =
        (await resolveTrustedCli({
          ...(configuredOpCommand ? { configuredPath: configuredOpCommand } : {}),
          pathEnv: params.env.PATH,
        })) ?? null;
      return {
        opBinaryPath: resolvedPath,
        opStatus: resolvedPath ? ("ready" as const) : ("not-found" as const),
      };
    } catch {
      return { opBinaryPath: null, opStatus: "untrusted" as const };
    }
  })();

  const tokenFileStatus: SecretRefReadiness["tokenFileStatus"] = (() => {
    try {
      return readTokenFile(params.tokenFile) ? "ready" : "missing-or-unsafe";
    } catch {
      return "missing-or-unsafe";
    }
  })();
  return {
    opCommand,
    opBinaryPath,
    opStatus,
    tokenFile: params.tokenFile,
    tokenFileStatus,
    prerequisitesReady: opStatus === "ready" && tokenFileStatus === "ready",
  };
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

function parseTargetSpecifier(value: string): {
  path: string;
  agentId?: string;
} {
  return pluginSecretRefSetup.parseTargetSpecifier("1Password", value);
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
    pluginSecretRefSetup.assertValidModelProviderId("--provider-key", providerId);
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

function buildPlan(params: {
  providerAlias: string;
  providerConfig: OnePasswordExecProviderConfig;
  providerSecrets: ProviderSecretMapping[];
  configTargetSecrets?: ConfigTargetSecretMapping[];
}): SecretsApplyPlan {
  const plan = pluginSecretRefSetup.buildPlan({ productName: "1Password", ...params });
  if (plan.targets.length === 0) {
    throw new Error(
      "No SecretRef targets selected. Pass --openai-id, --anthropic-id, --openrouter-id, --provider-key, or --target.",
    );
  }
  return plan;
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

async function runStatus(
  params: RegisterOnePasswordSecretRefCommandsParams,
  options: StatusOptions,
): Promise<void> {
  const config = params.config;
  const providerAlias = resolveStatusProviderAlias(config, options.providerAlias);
  const provider = readProviderStatus(config, providerAlias);
  const providerReady = isOnePasswordIntegrationProvider(
    config.secrets?.providers?.[providerAlias],
  );
  const readiness = await inspectSecretRefReadiness({
    env: params.env ?? process.env,
    tokenFile: params.tokenFile,
  });
  const issues = [
    ...(providerReady
      ? []
      : [provider.configured ? "provider-misconfigured" : "provider-not-configured"]),
    ...(readiness.opStatus === "ready" ? [] : [`op-${readiness.opStatus}`]),
    ...(readiness.tokenFileStatus === "ready" ? [] : ["token-file-missing-or-unsafe"]),
  ];
  const result = {
    providerAlias,
    provider,
    providerReady,
    ...readiness,
    ready: providerReady && readiness.prerequisitesReady,
    issues,
  };
  if (options.json) {
    writeJson(result);
    return;
  }
  writeLine(
    `1Password provider: ${providerReady ? "ready" : provider.configured ? "misconfigured" : "not configured"}`,
  );
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
  writeLine(`op command: ${readiness.opCommand}`);
  writeLine(`op status: ${readiness.opStatus}`);
  if (readiness.opBinaryPath) {
    writeLine(`op binary: ${readiness.opBinaryPath}`);
  }
  writeLine(`token file: ${readiness.tokenFileStatus}`);
  writeLine(`prerequisites ready: ${readiness.prerequisitesReady ? "yes" : "no"}`);
  writeLine(`ready: ${result.ready ? "yes" : "no"}`);
  if (issues.length === 0) {
    return;
  }
  writeLine("");
  writeLine("Next actions:");
  if (!providerReady) {
    writeLine("  Generate and apply a 1Password SecretRef setup plan.");
  }
  if (readiness.opStatus === "not-found") {
    writeLine("  Install the official 1Password CLI or set CLAW_1PASSWORD_OP.");
  } else if (readiness.opStatus === "untrusted") {
    writeLine("  Use an absolute 1Password CLI path that is not replaceable by another user.");
  }
  if (readiness.tokenFileStatus !== "ready") {
    writeLine(`  Create a non-empty service-account token file at ${readiness.tokenFile}.`);
  }
}

async function writePlanFile(
  plan: SecretsApplyPlan,
  requestedPath?: string,
  dependencies: WritePlanFileDependencies = {},
): Promise<string> {
  const requestedPlanPath =
    normalizeOptionalString(requestedPath) ??
    path.join(resolvePreferredOpenClawTmpDir(), `openclaw-1password-secrets-${randomUUID()}.json`);
  const content = `${JSON.stringify(plan, null, 2)}\n`;
  const requestedPlanPathAbsolute = path.resolve(requestedPlanPath);
  const planDirectory = await (
    dependencies.resolveTrustedPlanDirectory ?? resolveTrustedOnePasswordDirectoryPath
  )(path.dirname(requestedPlanPathAbsolute));
  // Write through the canonical directory returned by the trust check. Reusing the requested
  // alias would let another local account retarget a writable parent symlink after validation.
  const planPath = path.join(planDirectory, path.basename(requestedPlanPathAbsolute));
  const platform = dependencies.platform ?? process.platform;
  // Validate the exact canonical path before the exclusive write. Follow-up command rendering
  // must not fail after leaving a plan behind that the next setup attempt cannot overwrite.
  renderApplyCommands(planPath, platform);
  await pluginSecretRefSetup.writePlanFile({
    planPath,
    content,
    platform,
    createPrivateWindowsFile: dependencies.createPrivateWindowsFile,
  });
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
  writeLine("  openclaw onepassword secretref status");
  for (const command of renderApplyCommands(planPath)) {
    writeLine(`  ${command}`);
  }
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
    .action((options: StatusOptions) => runStatus(params, options));
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
  parseConfigTargetMappings,
  parseProviderKeyMappings,
  quoteCliArg,
  renderApplyCommands,
  inspectSecretRefReadiness,
  writePlanFile,
};
