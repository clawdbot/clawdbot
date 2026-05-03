import type { OpenClawConfig } from "../config/types.js";
import { isValidEnvSecretRefId, type SecretRef } from "../config/types.secrets.js";
import { formatErrorMessage } from "../infra/errors.js";
import { encodeJsonPointerToken } from "../secrets/json-pointer.js";
import { getProviderEnvVars } from "../secrets/provider-env-vars.js";
import {
  formatExecSecretRefIdValidationMessage,
  isValidExecSecretRefId,
  isValidFileSecretRefId,
  resolveDefaultSecretProviderAlias,
} from "../secrets/ref-contract.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import {
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
} from "../shared/string-coerce.js";
import type { WizardPrompter } from "../wizard/prompts.js";

const secretResolveLoader = createLazyImportLoader(() => import("../secrets/resolve.js"));

function loadSecretResolve() {
  return secretResolveLoader.load();
}

const ENV_SOURCE_LABEL_RE = /(?:^|:\s)([A-Z][A-Z0-9_]*)$/;

type SecretRefChoice = "env" | "provider"; // pragma: allowlist secret

export type SecretRefSetupPromptCopy = {
  sourceMessage?: string;
  envVarMessage?: string;
  envVarPlaceholder?: string;
  envVarFormatError?: string;
  envVarMissingError?: (envVar: string) => string;
  noProvidersMessage?: string;
  envValidatedMessage?: (envVar: string) => string;
  providerValidatedMessage?: (provider: string, id: string, source: "file" | "exec") => string;
};

export function extractEnvVarFromSourceLabel(source: string): string | undefined {
  const match = ENV_SOURCE_LABEL_RE.exec(source.trim());
  return match?.[1];
}

function resolveDefaultProviderEnvVar(
  provider: string,
  config?: OpenClawConfig,
): string | undefined {
  const envVars = getProviderEnvVars(provider, {
    ...(config ? { config } : {}),
    includeUntrustedWorkspacePlugins: false,
  });
  return envVars?.find((candidate) => normalizeOptionalString(candidate) !== undefined);
}

function resolveDefaultFilePointerId(provider: string): string {
  return `/providers/${encodeJsonPointerToken(provider)}/apiKey`;
}

export function resolveRefFallbackInput(params: {
  config: OpenClawConfig;
  provider: string;
  preferredEnvVar?: string;
  env?: NodeJS.ProcessEnv;
}): { ref: SecretRef; resolvedValue: string } {
  const fallbackEnvVar =
    params.preferredEnvVar ??
    getProviderEnvVars(params.provider, {
      config: params.config,
      includeUntrustedWorkspacePlugins: false,
    }).find((candidate) => normalizeOptionalString(candidate) !== undefined);
  if (!fallbackEnvVar) {
    throw new Error(
      `No default environment variable mapping found for provider "${params.provider}". Set a provider-specific env var, or re-run setup in an interactive terminal to configure a ref.`,
    );
  }
  const env = params.env ?? process.env;
  const value = normalizeOptionalString(env[fallbackEnvVar]);
  if (!value) {
    throw new Error(
      `Environment variable "${fallbackEnvVar}" is required for --secret-input-mode ref in non-interactive setup.`,
    );
  }
  return {
    ref: {
      source: "env",
      provider: resolveDefaultSecretProviderAlias(params.config, "env", {
        preferFirstProviderForSource: true,
      }),
      id: fallbackEnvVar,
    },
    resolvedValue: value,
  };
}

async function promptEnvSecretRefForSetup(params: {
  provider: string;
  config: OpenClawConfig;
  prompter: WizardPrompter;
  defaultEnvVar: string;
  copy?: SecretRefSetupPromptCopy;
  env?: NodeJS.ProcessEnv;
}): Promise<{ ref: SecretRef; resolvedValue: string }> {
  const env = params.env ?? process.env;
  const envVarRaw = await params.prompter.text({
    message: params.copy?.envVarMessage ?? "Environment variable name",
    initialValue: params.defaultEnvVar || undefined,
    placeholder: params.copy?.envVarPlaceholder ?? "OPENAI_API_KEY",
    validate: (value) => {
      const candidate = value.trim();
      if (!isValidEnvSecretRefId(candidate)) {
        return (
          params.copy?.envVarFormatError ??
          'Use an env var name like "OPENAI_API_KEY" (uppercase letters, numbers, underscores).'
        );
      }
      if (!normalizeOptionalString(env[candidate])) {
        return (
          params.copy?.envVarMissingError?.(candidate) ??
          `Environment variable "${candidate}" is missing or empty in this session.`
        );
      }
      return undefined;
    },
  });
  const envCandidate = normalizeStringifiedOptionalString(envVarRaw) ?? "";
  const envVar =
    envCandidate && isValidEnvSecretRefId(envCandidate) ? envCandidate : params.defaultEnvVar;
  if (!envVar) {
    throw new Error(
      `No valid environment variable name provided for provider "${params.provider}".`,
    );
  }
  const resolvedValue = normalizeOptionalString(env[envVar]);
  if (!resolvedValue) {
    throw new Error(`Environment variable "${envVar}" is missing or empty in this session.`);
  }
  const ref: SecretRef = {
    source: "env",
    provider: resolveDefaultSecretProviderAlias(params.config, "env", {
      preferFirstProviderForSource: true,
    }),
    id: envVar,
  };
  await params.prompter.note(
    params.copy?.envValidatedMessage?.(envVar) ??
      `Validated environment variable ${envVar}. OpenClaw will store a reference, not the key value.`,
    "Reference validated",
  );
  return { ref, resolvedValue };
}

async function promptProviderSecretRefForSetup(params: {
  provider: string;
  config: OpenClawConfig;
  prompter: WizardPrompter;
  defaultFilePointer: string;
  copy?: SecretRefSetupPromptCopy;
  env?: NodeJS.ProcessEnv;
}): Promise<{ ref: SecretRef; resolvedValue: string }> {
  const externalProviders = Object.entries(params.config.secrets?.providers ?? {}).filter(
    ([, provider]) => provider?.source === "file" || provider?.source === "exec",
  );
  if (externalProviders.length === 0) {
    await params.prompter.note(
      params.copy?.noProvidersMessage ??
        "No file/exec secret providers are configured yet. Add one under secrets.providers, or select Environment variable.",
      "No providers configured",
    );
    throw new Error("retry");
  }

  const defaultProvider = resolveDefaultSecretProviderAlias(params.config, "file", {
    preferFirstProviderForSource: true,
  });
  const selectedProvider = await params.prompter.select<string>({
    message: "Select secret provider",
    initialValue:
      externalProviders.find(([providerName]) => providerName === defaultProvider)?.[0] ??
      externalProviders[0]?.[0],
    options: externalProviders.map(([providerName, provider]) => ({
      value: providerName,
      label: providerName,
      hint: provider?.source === "exec" ? "Exec provider" : "File provider",
    })),
  });
  const providerEntry = params.config.secrets?.providers?.[selectedProvider];
  if (!providerEntry || (providerEntry.source !== "file" && providerEntry.source !== "exec")) {
    await params.prompter.note(
      `Provider "${selectedProvider}" is not a file/exec provider.`,
      "Invalid provider",
    );
    throw new Error("retry");
  }

  const idPrompt =
    providerEntry.source === "file"
      ? "Secret id (JSON pointer for json mode, or 'value' for singleValue mode)"
      : "Secret id for the exec provider";
  const idDefault =
    providerEntry.source === "file"
      ? providerEntry.mode === "singleValue"
        ? "value"
        : params.defaultFilePointer
      : `${params.provider}/apiKey`;
  const idRaw = await params.prompter.text({
    message: idPrompt,
    initialValue: idDefault,
    placeholder: providerEntry.source === "file" ? "/providers/openai/apiKey" : "openai/api-key",
    validate: (value) => {
      const candidate = value.trim();
      if (!candidate) {
        return "Secret id cannot be empty.";
      }
      if (
        providerEntry.source === "file" &&
        providerEntry.mode !== "singleValue" &&
        !isValidFileSecretRefId(candidate)
      ) {
        return 'Use an absolute JSON pointer like "/providers/openai/apiKey".';
      }
      if (
        providerEntry.source === "file" &&
        providerEntry.mode === "singleValue" &&
        candidate !== "value"
      ) {
        return 'singleValue mode expects id "value".';
      }
      if (providerEntry.source === "exec" && !isValidExecSecretRefId(candidate)) {
        return formatExecSecretRefIdValidationMessage();
      }
      return undefined;
    },
  });
  const id = normalizeStringifiedOptionalString(idRaw) || idDefault;
  const ref: SecretRef = {
    source: providerEntry.source,
    provider: selectedProvider,
    id,
  };

  try {
    const { resolveSecretRefString } = await loadSecretResolve();
    const resolvedValue = await resolveSecretRefString(ref, {
      config: params.config,
      env: params.env ?? process.env,
    });
    await params.prompter.note(
      params.copy?.providerValidatedMessage?.(selectedProvider, id, providerEntry.source) ??
        `Validated ${providerEntry.source} reference ${selectedProvider}:${id}. OpenClaw will store a reference, not the key value.`,
      "Reference validated",
    );
    return { ref, resolvedValue };
  } catch (error) {
    await params.prompter.note(
      [
        `Could not validate provider reference ${selectedProvider}:${id}.`,
        formatErrorMessage(error),
        "Check your provider configuration and try again.",
      ].join("\n"),
      "Reference check failed",
    );
    throw new Error("retry", { cause: error });
  }
}

export async function promptSecretRefForSetup(params: {
  provider: string;
  config: OpenClawConfig;
  prompter: WizardPrompter;
  preferredEnvVar?: string;
  copy?: SecretRefSetupPromptCopy;
  env?: NodeJS.ProcessEnv;
}): Promise<{ ref: SecretRef; resolvedValue: string }> {
  const defaultEnvVar =
    params.preferredEnvVar ?? resolveDefaultProviderEnvVar(params.provider, params.config) ?? "";
  const defaultFilePointer = resolveDefaultFilePointerId(params.provider);
  let sourceChoice: SecretRefChoice = "env"; // pragma: allowlist secret

  while (true) {
    const sourceRaw: SecretRefChoice = await params.prompter.select<SecretRefChoice>({
      message: params.copy?.sourceMessage ?? "Where is this API key stored?",
      initialValue: sourceChoice,
      options: [
        {
          value: "env",
          label: "Environment variable",
          hint: "Reference a variable from your runtime environment",
        },
        {
          value: "provider",
          label: "Configured secret provider",
          hint: "Use a configured file or exec secret provider",
        },
      ],
    });
    const source: SecretRefChoice = sourceRaw === "provider" ? "provider" : "env";
    sourceChoice = source;

    if (source === "env") {
      return await promptEnvSecretRefForSetup({
        provider: params.provider,
        config: params.config,
        prompter: params.prompter,
        defaultEnvVar,
        copy: params.copy,
        env: params.env,
      });
    }

    try {
      return await promptProviderSecretRefForSetup({
        provider: params.provider,
        config: params.config,
        prompter: params.prompter,
        defaultFilePointer,
        copy: params.copy,
        env: params.env,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "retry") {
        continue;
      }
      throw error;
    }
  }
}
