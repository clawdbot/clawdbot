// Narrow shared secret-ref helpers for plugin config and secret-contract paths.

import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginIntegrationSecretProviderConfig } from "../config/types.secrets.js";
import { sameFileIdentity } from "../infra/fs-safe-advanced.js";
import {
  assertValidPluginModelProviderId,
  assertValidPluginSecretProviderAlias,
  buildPluginSecretRefSetupPlan,
  parsePluginSecretTargetSpecifier,
} from "../secrets/plugin-setup-plan.js";
import { createPrivateWindowsPlanFile } from "../secrets/private-plan-file.js";
import {
  resolveTrustedExecutablePath,
  resolveTrustedPlanDirectoryPath,
} from "../secrets/trusted-plan-path.js";

type PlanFileIdentity = { dev: bigint; ino: bigint };

type SecretRefSetupCommand = {
  command(name: string): SecretRefSetupCommand;
  description(value: string): SecretRefSetupCommand;
  option(
    flags: string,
    description: string,
    defaultValueOrParser?: string | ((value: string, previous?: string[]) => string[]),
    defaultValue?: string[],
  ): SecretRefSetupCommand;
  action<TOptions>(fn: (options: TOptions) => void | Promise<void>): SecretRefSetupCommand;
};

type SecretRefSetupOptions = {
  planOut?: string;
  providerAlias?: string;
  openaiId?: string;
  anthropicId?: string;
  openrouterId?: string;
  providerKey?: string[];
  target?: string[];
};

type SecretRefProviderStatus = {
  configured: boolean;
  source?: string;
  command?: string;
  pluginIntegration?: {
    pluginId: string;
    integrationId: string;
  };
};

type SecretRefProviderMapping = {
  providerId: string;
  secretId: string;
};

type SecretRefConfigTargetMapping = {
  path: string;
  agentId?: string;
  secretId: string;
};

type PluginSecretRefSetupCliParams = {
  productName: string;
  secretIdLabel: string;
  secretIdPlaceholder: string;
  defaultProviderAlias: string;
  pluginIntegration: {
    pluginId: string;
    integrationId: string;
  };
  normalizeSecretId: (label: string, value: string) => string;
  defaultPlanPath: () => string;
  beforeApplyCommands?: readonly string[];
};

function throwPlanFileError(error: unknown, planPath: string): never {
  if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
    throw new Error(`Plan path already exists; choose a new --plan-out path: ${planPath}`, {
      cause: error,
    });
  }
  throw error;
}

async function writeSecretPlanFile(params: {
  planPath: string;
  content: string;
  platform?: NodeJS.Platform;
  createPrivateWindowsFile?: (filePath: string, content: string) => Promise<void>;
}): Promise<void> {
  const platform = params.platform ?? process.platform;
  if (platform === "win32") {
    await (params.createPrivateWindowsFile ?? createPrivateWindowsPlanFile)(
      params.planPath,
      params.content,
    ).catch((error: unknown) => throwPlanFileError(error, params.planPath));
    return;
  }
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let identity: PlanFileIdentity | undefined;
  try {
    handle = await fs.open(params.planPath, "wx", 0o600);
    identity = await handle.stat({ bigint: true });
    await handle.chmod(0o600);
    if (((await handle.stat()).mode & 0o777) !== 0o600) {
      throw new Error("Unable to verify owner-only permissions for the generated plan file.");
    }
    const pathStat = await fs.lstat(params.planPath, { bigint: true });
    const handleStat = await handle.stat({ bigint: true });
    // Keep the pathname and open handle bound to the same new file before secrets are written.
    if (
      pathStat.isSymbolicLink() ||
      !sameFileIdentity(identity, handleStat) ||
      !sameFileIdentity(identity, pathStat)
    ) {
      throw new Error("Generated plan path changed during permission setup.");
    }
    await handle.writeFile(params.content, "utf8");
    await handle.sync();
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
      throwPlanFileError(error, params.planPath);
    }
    if (identity) {
      try {
        const current = await fs.lstat(params.planPath, { bigint: true });
        if (!current.isSymbolicLink() && sameFileIdentity(current, identity)) {
          await fs.rm(params.planPath, { force: true });
        }
      } catch {
        // The write failure is authoritative; cleanup is best effort.
      }
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

type CommandShell = "cmd" | "posix" | "powershell";

function quoteSecretRefCliArg(value: string, shell: CommandShell): string {
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

function renderSecretRefApplyCommands(
  planPath: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const render = (shell: CommandShell, indent = "") => {
    const quotedPlanPath = quoteSecretRefCliArg(planPath, shell);
    return [
      `${indent}openclaw secrets apply --from ${quotedPlanPath} --dry-run --allow-exec`,
      `${indent}openclaw secrets apply --from ${quotedPlanPath} --allow-exec`,
    ];
  };
  if (platform !== "win32") {
    return render("posix");
  }
  // The parent shell is unknown, so emit native variants instead of unsafe hybrid syntax.
  const powershellCommands = ["PowerShell:", ...render("powershell", "  ")];
  if (/[%!]/u.test(planPath)) {
    return [
      ...powershellCommands,
      "Command Prompt: unavailable for paths containing % or !; use PowerShell.",
    ];
  }
  return [...powershellCommands, "Command Prompt:", ...render("cmd", "  ")];
}

function readSecretRefProviderStatus(
  config: OpenClawConfig,
  providerAlias: string,
): SecretRefProviderStatus {
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
      pluginIntegration: provider.pluginIntegration as SecretRefProviderStatus["pluginIntegration"],
    };
  }
  return {
    ...base,
    command: normalizeOptionalString(provider.command),
  };
}

function writeSecretRefCliLine(message = ""): void {
  process.stdout.write(`${message}\n`);
}

/** Build the canonical setup/status adapter shared by plugin-owned SecretRef CLIs. */
export function createPluginSecretRefSetupCli(params: PluginSecretRefSetupCliParams) {
  const isIntegrationProvider = (value: unknown): boolean =>
    isRecord(value) &&
    value.source === "exec" &&
    isRecord(value.pluginIntegration) &&
    value.pluginIntegration.pluginId === params.pluginIntegration.pluginId &&
    value.pluginIntegration.integrationId === params.pluginIntegration.integrationId;

  const inspectProvider = (config: OpenClawConfig, requestedAlias?: string) => {
    const explicitAlias = normalizeOptionalString(requestedAlias);
    let providerAlias: string;
    if (explicitAlias) {
      assertValidPluginSecretProviderAlias(explicitAlias);
      providerAlias = explicitAlias;
    } else {
      const configuredAliases = Object.entries(config.secrets?.providers ?? {})
        .filter(([, provider]) => isIntegrationProvider(provider))
        .map(([alias]) => alias)
        .toSorted();
      if (configuredAliases.length > 1) {
        throw new Error(
          `Multiple ${params.productName} provider aliases are configured (${configuredAliases.join(", ")}). Use --provider-alias <alias>.`,
        );
      }
      providerAlias = configuredAliases[0] ?? params.defaultProviderAlias;
    }
    return {
      providerAlias,
      provider: readSecretRefProviderStatus(config, providerAlias),
      providerReady: isIntegrationProvider(config.secrets?.providers?.[providerAlias]),
    };
  };

  const parseProviderKeyMappings = (values: string[] | undefined): SecretRefProviderMapping[] =>
    (values ?? []).map((value) => {
      const separator = value.indexOf("=");
      if (separator <= 0 || separator === value.length - 1) {
        throw new Error(
          `Invalid --provider-key value "${value}". Use <model-provider-id>=<${params.secretIdPlaceholder}>.`,
        );
      }
      const providerId = value.slice(0, separator).trim();
      assertValidPluginModelProviderId("--provider-key", providerId);
      return {
        providerId,
        secretId: params.normalizeSecretId(
          `--provider-key ${providerId}`,
          value.slice(separator + 1).trim(),
        ),
      };
    });

  const parseConfigTargetMappings = (
    values: string[] | undefined,
  ): SecretRefConfigTargetMapping[] =>
    (values ?? []).map((value) => {
      const separator = value.indexOf("=");
      if (separator <= 0 || separator === value.length - 1) {
        throw new Error(
          `Invalid --target value "${value}". Use <openclaw-config-path>=<${params.secretIdPlaceholder}>.`,
        );
      }
      const target = parsePluginSecretTargetSpecifier(
        params.productName,
        value.slice(0, separator).trim(),
      );
      const secretId = params.normalizeSecretId(
        `--target ${target.path}`,
        value.slice(separator + 1).trim(),
      );
      return Object.assign(
        { path: target.path, secretId },
        target.agentId ? { agentId: target.agentId } : {},
      );
    });

  const promptOptionalSecretId = async (label: string): Promise<string | undefined> => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      return undefined;
    }
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return normalizeOptionalString(
        await readline.question(`${label} ${params.secretIdLabel} (blank to skip): `),
      );
    } finally {
      readline.close();
    }
  };

  const collectProviderSecrets = async (
    options: SecretRefSetupOptions,
  ): Promise<SecretRefProviderMapping[]> => {
    const commonProviders = [
      { providerId: "openai", label: "OpenAI", value: options.openaiId },
      { providerId: "anthropic", label: "Anthropic", value: options.anthropicId },
      { providerId: "openrouter", label: "OpenRouter", value: options.openrouterId },
    ] as const;
    const providerSecrets: SecretRefProviderMapping[] = [];
    for (const provider of commonProviders) {
      const value =
        normalizeOptionalString(provider.value) ?? (await promptOptionalSecretId(provider.label));
      if (value) {
        providerSecrets.push({
          providerId: provider.providerId,
          secretId: params.normalizeSecretId(provider.label, value),
        });
      }
    }
    providerSecrets.push(...parseProviderKeyMappings(options.providerKey));
    const seen = new Set<string>();
    for (const entry of providerSecrets) {
      const normalized = entry.providerId.toLowerCase();
      if (seen.has(normalized)) {
        throw new Error(
          `Duplicate model provider id in ${params.productName} setup: ${entry.providerId}`,
        );
      }
      seen.add(normalized);
    }
    return providerSecrets;
  };

  const runSetup = async (options: SecretRefSetupOptions): Promise<void> => {
    const providerAlias =
      normalizeOptionalString(options.providerAlias) ?? params.defaultProviderAlias;
    assertValidPluginSecretProviderAlias(providerAlias);
    const providerConfig: PluginIntegrationSecretProviderConfig = {
      source: "exec",
      pluginIntegration: params.pluginIntegration,
    };
    const plan = buildPluginSecretRefSetupPlan({
      productName: params.productName,
      providerAlias,
      providerConfig,
      providerSecrets: await collectProviderSecrets(options),
      configTargetSecrets: parseConfigTargetMappings(options.target),
    });
    if (plan.targets.length === 0) {
      throw new Error(
        "No SecretRef targets selected. Pass --openai-id, --anthropic-id, --openrouter-id, --provider-key, or --target.",
      );
    }
    const requestedPlanPath = normalizeOptionalString(options.planOut) ?? params.defaultPlanPath();
    const absolutePlanPath = path.resolve(requestedPlanPath);
    const planDirectory = await resolveTrustedPlanDirectoryPath(path.dirname(absolutePlanPath));
    // Use the verified canonical parent for both the write and copy-paste commands.
    const planPath = path.join(planDirectory, path.basename(absolutePlanPath));
    const applyCommands = renderSecretRefApplyCommands(planPath);
    await writeSecretPlanFile({
      planPath,
      content: `${JSON.stringify(plan, null, 2)}\n`,
    });
    writeSecretRefCliLine(`Plan written to ${planPath}`);
    writeSecretRefCliLine(`Targets: ${plan.targets.length}`);
    writeSecretRefCliLine();
    writeSecretRefCliLine("Next steps:");
    for (const command of params.beforeApplyCommands ?? []) {
      writeSecretRefCliLine(`  ${command}`);
    }
    for (const command of applyCommands) {
      writeSecretRefCliLine(`  ${command}`);
    }
    writeSecretRefCliLine("  openclaw secrets audit --check --allow-exec");
    writeSecretRefCliLine("  openclaw secrets reload");
  };

  const registerSetupCommand = (command: SecretRefSetupCommand): void => {
    command
      .command("setup")
      .description(`Create a ${params.productName} SecretRef setup plan`)
      .option("--plan-out <path>", "Write the generated secrets apply plan to a path")
      .option(
        "--provider-alias <alias>",
        "Secret provider alias to configure",
        params.defaultProviderAlias,
      )
      .option("--openai-id <id>", `${params.secretIdLabel} for models.providers.openai.apiKey`)
      .option(
        "--anthropic-id <id>",
        `${params.secretIdLabel} for models.providers.anthropic.apiKey`,
      )
      .option(
        "--openrouter-id <id>",
        `${params.secretIdLabel} for models.providers.openrouter.apiKey`,
      )
      .option(
        "--provider-key <provider=id>",
        `${params.secretIdLabel} for any models.providers.<provider>.apiKey target`,
        (value: string, previous: string[] = []) => [...previous, value],
        [],
      )
      .option(
        "--target <path=id>",
        `${params.secretIdLabel} for any known SecretRef target path`,
        (value: string, previous: string[] = []) => [...previous, value],
        [],
      )
      .action((options: SecretRefSetupOptions) => runSetup(options));
  };

  return { inspectProvider, registerSetupCommand };
}

export { coerceSecretRef } from "../config/types.secrets.js";
export type { SecretInput, SecretRef } from "../config/types.secrets.js";
export { resolveSecretRefValues } from "../secrets/resolve.js";
export { applyResolvedAssignments, createResolverContext } from "../secrets/runtime-shared.js";

/** Shared validation and apply-plan construction for plugin-owned SecretRef setup CLIs. */
export const pluginSecretRefSetup = {
  assertValidModelProviderId: assertValidPluginModelProviderId,
  assertValidProviderAlias: assertValidPluginSecretProviderAlias,
  buildPlan: buildPluginSecretRefSetupPlan,
  parseTargetSpecifier: parsePluginSecretTargetSpecifier,
  resolveTrustedDirectoryPath: resolveTrustedPlanDirectoryPath,
  resolveTrustedExecutablePath,
  writePlanFile: writeSecretPlanFile,
};
