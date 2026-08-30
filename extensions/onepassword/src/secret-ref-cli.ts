import { randomUUID } from "node:crypto";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import {
  DEFAULT_SECRET_FILE_MAX_BYTES,
  tryReadSecretFileSync,
} from "openclaw/plugin-sdk/secret-file-runtime";
import { createPluginSecretRefSetupCli } from "openclaw/plugin-sdk/secret-ref-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { resolveTrustedOnePasswordCli } from "../onepassword-op-path.js";
import { encodeOnePasswordSecretId } from "../onepassword-secret-id.js";

const ONEPASSWORD_PROVIDER_ALIAS = "onepassword";
type PluginSecretRefSetupCli = ReturnType<typeof createPluginSecretRefSetupCli>;

function normalizeOnePasswordSecretId(label: string, value: string): string {
  try {
    return encodeOnePasswordSecretId(value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${label} 1Password SecretRef id: ${detail}`, { cause: error });
  }
}

const onePasswordSecretRefSetupCli: PluginSecretRefSetupCli = createPluginSecretRefSetupCli({
  productName: "1Password",
  secretIdLabel: "1Password SecretRef id",
  secretIdPlaceholder: "1password-secret-id",
  defaultProviderAlias: ONEPASSWORD_PROVIDER_ALIAS,
  pluginIntegration: {
    pluginId: "onepassword",
    integrationId: "onepassword",
  },
  normalizeSecretId: normalizeOnePasswordSecretId,
  defaultPlanPath: () =>
    path.join(resolvePreferredOpenClawTmpDir(), `openclaw-1password-secrets-${randomUUID()}.json`),
  beforeApplyCommands: [
    "openclaw plugins enable onepassword",
    "openclaw onepassword secretref status",
  ],
});

type CommandLike = Parameters<typeof onePasswordSecretRefSetupCli.registerSetupCommand>[0];

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

function writeLine(message = ""): void {
  process.stdout.write(`${message}\n`);
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
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

async function runStatus(
  params: RegisterOnePasswordSecretRefCommandsParams,
  options: StatusOptions,
): Promise<void> {
  const { providerAlias, provider, providerReady } = onePasswordSecretRefSetupCli.inspectProvider(
    params.config,
    options.providerAlias,
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
  writeLine();
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
  onePasswordSecretRefSetupCli.registerSetupCommand(secretRef);
}

export const testing = { inspectSecretRefReadiness };
