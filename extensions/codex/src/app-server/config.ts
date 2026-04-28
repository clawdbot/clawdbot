import { createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import type { CodexSandboxPolicy, CodexServiceTier } from "./protocol.js";

const START_OPTIONS_KEY_SECRET = randomBytes(32);

export type CodexAppServerTransportMode = "stdio" | "websocket";
export type CodexAppServerPolicyMode = "yolo" | "guardian";
export type CodexAppServerApprovalPolicy = "never" | "on-request" | "on-failure" | "untrusted";
export type CodexAppServerSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type CodexAppServerApprovalsReviewer = "user" | "auto_review" | "guardian_subagent";
export type CodexAppServerCommandSource = "managed" | "resolved-managed" | "config" | "env";

export type CodexComputerUseConfig = {
  enabled?: boolean;
  autoInstall?: boolean;
  marketplaceDiscoveryTimeoutMs?: number;
  marketplaceSource?: string;
  marketplacePath?: string;
  marketplaceName?: string;
  pluginName?: string;
  mcpServerName?: string;
};

export type ResolvedCodexComputerUseConfig = {
  enabled: boolean;
  autoInstall: boolean;
  marketplaceDiscoveryTimeoutMs: number;
  pluginName: string;
  mcpServerName: string;
  marketplaceSource?: string;
  marketplacePath?: string;
  marketplaceName?: string;
};

export type CodexAppServerStartOptions = {
  transport: CodexAppServerTransportMode;
  command: string;
  commandSource?: CodexAppServerCommandSource;
  args: string[];
  url?: string;
  authToken?: string;
  headers: Record<string, string>;
  env?: Record<string, string>;
  clearEnv?: string[];
};

export type CodexAppServerRuntimeOptions = {
  start: CodexAppServerStartOptions;
  requestTimeoutMs: number;
  approvalPolicy: CodexAppServerApprovalPolicy;
  sandbox: CodexAppServerSandboxMode;
  approvalsReviewer: CodexAppServerApprovalsReviewer;
  serviceTier?: CodexServiceTier;
};

export type CodexPluginConfig = {
  discovery?: {
    enabled?: boolean;
    timeoutMs?: number;
  };
  computerUse?: CodexComputerUseConfig;
  appServer?: {
    mode?: CodexAppServerPolicyMode;
    transport?: CodexAppServerTransportMode;
    command?: string;
    args?: string[] | string;
    url?: string;
    authToken?: string;
    headers?: Record<string, string>;
    clearEnv?: string[];
    requestTimeoutMs?: number;
    approvalPolicy?: CodexAppServerApprovalPolicy;
    sandbox?: CodexAppServerSandboxMode;
    approvalsReviewer?: CodexAppServerApprovalsReviewer;
    serviceTier?: CodexServiceTier | null;
    defaultWorkspaceDir?: string;
  };
};

export const CODEX_APP_SERVER_CONFIG_KEYS = [
  "mode",
  "transport",
  "command",
  "args",
  "url",
  "authToken",
  "headers",
  "clearEnv",
  "requestTimeoutMs",
  "approvalPolicy",
  "sandbox",
  "approvalsReviewer",
  "serviceTier",
  "defaultWorkspaceDir",
] as const;

export const CODEX_COMPUTER_USE_CONFIG_KEYS = [
  "enabled",
  "autoInstall",
  "marketplaceDiscoveryTimeoutMs",
  "marketplaceSource",
  "marketplacePath",
  "marketplaceName",
  "pluginName",
  "mcpServerName",
] as const;

export const DEFAULT_CODEX_COMPUTER_USE_PLUGIN_NAME = "computer-use";
export const DEFAULT_CODEX_COMPUTER_USE_MCP_SERVER_NAME = "computer-use";
export const DEFAULT_CODEX_COMPUTER_USE_MARKETPLACE_DISCOVERY_TIMEOUT_MS = 60_000;

const codexAppServerTransportSchema = z.enum(["stdio", "websocket"]);
const codexAppServerPolicyModeSchema = z.enum(["yolo", "guardian"]);
const codexAppServerApprovalPolicySchema = z.enum([
  "never",
  "on-request",
  "on-failure",
  "untrusted",
]);
const codexAppServerSandboxSchema = z.enum(["read-only", "workspace-write", "danger-full-access"]);
const codexAppServerApprovalsReviewerSchema = z.enum(["user", "auto_review", "guardian_subagent"]);
const codexAppServerServiceTierSchema = z.preprocess(
  (value) => (value === null ? null : resolveServiceTier(value)),
  z.enum(["fast", "flex"]).nullable().optional(),
);

const codexPluginConfigSchema = z
  .object({
    discovery: z
      .object({
        enabled: z.boolean().optional(),
        timeoutMs: z.number().positive().optional(),
      })
      .strict()
      .optional(),
    computerUse: z
      .object({
        enabled: z.boolean().optional(),
        autoInstall: z.boolean().optional(),
        marketplaceDiscoveryTimeoutMs: z.number().positive().optional(),
        marketplaceSource: z.string().optional(),
        marketplacePath: z.string().optional(),
        marketplaceName: z.string().optional(),
        pluginName: z.string().optional(),
        mcpServerName: z.string().optional(),
      })
      .strict()
      .optional(),
    appServer: z
      .object({
        mode: codexAppServerPolicyModeSchema.optional(),
        transport: codexAppServerTransportSchema.optional(),
        command: z.string().optional(),
        args: z.union([z.array(z.string()), z.string()]).optional(),
        url: z.string().optional(),
        authToken: z.string().optional(),
        headers: z.record(z.string(), z.string()).optional(),
        clearEnv: z.array(z.string()).optional(),
        requestTimeoutMs: z.number().positive().optional(),
        approvalPolicy: codexAppServerApprovalPolicySchema.optional(),
        sandbox: codexAppServerSandboxSchema.optional(),
        approvalsReviewer: codexAppServerApprovalsReviewerSchema.optional(),
        serviceTier: codexAppServerServiceTierSchema,
        defaultWorkspaceDir: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export function readCodexPluginConfig(value: unknown): CodexPluginConfig {
  const parsed = codexPluginConfigSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

export function resolveCodexAppServerRuntimeOptions(
  params: {
    pluginConfig?: unknown;
    env?: NodeJS.ProcessEnv;
  } = {},
): CodexAppServerRuntimeOptions {
  const env = params.env ?? process.env;
  const config = readCodexPluginConfig(params.pluginConfig).appServer ?? {};
  const transport = resolveTransport(config.transport);
  const configCommand = readNonEmptyString(config.command);
  const envCommand = readNonEmptyString(env.OPENCLAW_CODEX_APP_SERVER_BIN);
  const command = configCommand ?? envCommand ?? "codex";
  const commandSource: CodexAppServerCommandSource = configCommand
    ? "config"
    : envCommand
      ? "env"
      : "managed";
  const args = resolveArgs(config.args, env.OPENCLAW_CODEX_APP_SERVER_ARGS);
  const headers = normalizeHeaders(config.headers);
  const clearEnv = normalizeStringList(config.clearEnv);
  const authToken = readNonEmptyString(config.authToken);
  const url = readNonEmptyString(config.url);
  const policyMode =
    resolvePolicyMode(config.mode) ??
    resolvePolicyMode(env.OPENCLAW_CODEX_APP_SERVER_MODE) ??
    "yolo";
  const serviceTier = resolveServiceTier(config.serviceTier);
  if (transport === "websocket" && !url) {
    throw new Error(
      "plugins.entries.codex.config.appServer.url is required when appServer.transport is websocket",
    );
  }

  return {
    start: {
      transport,
      command,
      commandSource,
      args: args.length > 0 ? args : ["app-server", "--listen", "stdio://"],
      ...(url ? { url } : {}),
      ...(authToken ? { authToken } : {}),
      headers,
      ...(transport === "stdio" && clearEnv.length > 0 ? { clearEnv } : {}),
    },
    requestTimeoutMs: normalizePositiveNumber(config.requestTimeoutMs, 60_000),
    approvalPolicy:
      resolveApprovalPolicy(config.approvalPolicy) ??
      resolveApprovalPolicy(env.OPENCLAW_CODEX_APP_SERVER_APPROVAL_POLICY) ??
      (policyMode === "guardian" ? "on-request" : "never"),
    sandbox:
      resolveSandbox(config.sandbox) ??
      resolveSandbox(env.OPENCLAW_CODEX_APP_SERVER_SANDBOX) ??
      (policyMode === "guardian" ? "workspace-write" : "danger-full-access"),
    approvalsReviewer:
      resolveApprovalsReviewer(config.approvalsReviewer) ??
      (policyMode === "guardian" ? "auto_review" : "user"),
    ...(serviceTier ? { serviceTier } : {}),
  };
}

export function resolveCodexComputerUseConfig(
  params: {
    pluginConfig?: unknown;
    env?: NodeJS.ProcessEnv;
    overrides?: Partial<CodexComputerUseConfig>;
  } = {},
): ResolvedCodexComputerUseConfig {
  const env = params.env ?? process.env;
  const config = readCodexPluginConfig(params.pluginConfig).computerUse ?? {};
  const marketplaceSource =
    readNonEmptyString(params.overrides?.marketplaceSource) ??
    readNonEmptyString(config.marketplaceSource) ??
    readNonEmptyString(env.OPENCLAW_CODEX_COMPUTER_USE_MARKETPLACE_SOURCE);
  const marketplacePath =
    readNonEmptyString(params.overrides?.marketplacePath) ??
    readNonEmptyString(config.marketplacePath) ??
    readNonEmptyString(env.OPENCLAW_CODEX_COMPUTER_USE_MARKETPLACE_PATH);
  const marketplaceName =
    readNonEmptyString(params.overrides?.marketplaceName) ??
    readNonEmptyString(config.marketplaceName) ??
    readNonEmptyString(env.OPENCLAW_CODEX_COMPUTER_USE_MARKETPLACE_NAME);
  const autoInstall =
    params.overrides?.autoInstall ??
    config.autoInstall ??
    readBooleanEnv(env.OPENCLAW_CODEX_COMPUTER_USE_AUTO_INSTALL) ??
    false;
  const marketplaceDiscoveryTimeoutMs = normalizePositiveNumber(
    params.overrides?.marketplaceDiscoveryTimeoutMs ??
      config.marketplaceDiscoveryTimeoutMs ??
      readNumberEnv(env.OPENCLAW_CODEX_COMPUTER_USE_MARKETPLACE_DISCOVERY_TIMEOUT_MS),
    DEFAULT_CODEX_COMPUTER_USE_MARKETPLACE_DISCOVERY_TIMEOUT_MS,
  );
  const enabled =
    params.overrides?.enabled ??
    config.enabled ??
    readBooleanEnv(env.OPENCLAW_CODEX_COMPUTER_USE) ??
    Boolean(autoInstall || marketplaceSource || marketplacePath || marketplaceName);

  return {
    enabled,
    autoInstall,
    marketplaceDiscoveryTimeoutMs,
    pluginName:
      readNonEmptyString(params.overrides?.pluginName) ??
      readNonEmptyString(config.pluginName) ??
      readNonEmptyString(env.OPENCLAW_CODEX_COMPUTER_USE_PLUGIN_NAME) ??
      DEFAULT_CODEX_COMPUTER_USE_PLUGIN_NAME,
    mcpServerName:
      readNonEmptyString(params.overrides?.mcpServerName) ??
      readNonEmptyString(config.mcpServerName) ??
      readNonEmptyString(env.OPENCLAW_CODEX_COMPUTER_USE_MCP_SERVER_NAME) ??
      DEFAULT_CODEX_COMPUTER_USE_MCP_SERVER_NAME,
    ...(marketplaceSource ? { marketplaceSource } : {}),
    ...(marketplacePath ? { marketplacePath } : {}),
    ...(marketplaceName ? { marketplaceName } : {}),
  };
}

export function codexAppServerStartOptionsKey(
  options: CodexAppServerStartOptions,
  params: { authProfileId?: string } = {},
): string {
  return JSON.stringify({
    transport: options.transport,
    command: options.command,
    commandSource: options.commandSource ?? null,
    args: options.args,
    url: options.url ?? null,
    authToken: hashSecretForKey(options.authToken, "authToken"),
    headers: Object.entries(options.headers).toSorted(([left], [right]) =>
      left.localeCompare(right),
    ),
    env: Object.entries(options.env ?? {})
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, hashSecretForKey(value, `env:${key}`)]),
    clearEnv: [...(options.clearEnv ?? [])].toSorted(),
    authProfileId: params.authProfileId ?? null,
  });
}

export function codexSandboxPolicyForTurn(
  mode: CodexAppServerSandboxMode,
  cwd: string,
): CodexSandboxPolicy {
  if (mode === "danger-full-access") {
    return { type: "dangerFullAccess" };
  }
  if (mode === "read-only") {
    return { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false };
  }
  return {
    type: "workspaceWrite",
    writableRoots: [cwd],
    readOnlyAccess: { type: "fullAccess" },
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function resolveTransport(value: unknown): CodexAppServerTransportMode {
  return value === "websocket" ? "websocket" : "stdio";
}

function resolvePolicyMode(value: unknown): CodexAppServerPolicyMode | undefined {
  return value === "guardian" || value === "yolo" ? value : undefined;
}

function resolveApprovalPolicy(value: unknown): CodexAppServerApprovalPolicy | undefined {
  return value === "on-request" ||
    value === "on-failure" ||
    value === "untrusted" ||
    value === "never"
    ? value
    : undefined;
}

function resolveSandbox(value: unknown): CodexAppServerSandboxMode | undefined {
  return value === "read-only" || value === "workspace-write" || value === "danger-full-access"
    ? value
    : undefined;
}

function resolveApprovalsReviewer(value: unknown): CodexAppServerApprovalsReviewer | undefined {
  return value === "auto_review" || value === "guardian_subagent" || value === "user"
    ? value
    : undefined;
}

function resolveServiceTier(value: unknown): CodexServiceTier | undefined {
  return value === "fast" || value === "flex" ? value : undefined;
}

function normalizePositiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, child]) => [key.trim(), readNonEmptyString(child)] as const)
      .filter((entry): entry is readonly [string, string] => Boolean(entry[0] && entry[1])),
  );
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => readNonEmptyString(entry))
    .filter((entry): entry is string => entry !== undefined);
}

function readBooleanEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function readNumberEnv(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function resolveArgs(configArgs: unknown, envArgs: string | undefined): string[] {
  if (Array.isArray(configArgs)) {
    return configArgs
      .map((entry) => readNonEmptyString(entry))
      .filter((entry): entry is string => entry !== undefined);
  }
  if (typeof configArgs === "string") {
    return splitShellWords(configArgs);
  }
  return splitShellWords(envArgs ?? "");
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function hashSecretForKey(value: string | undefined, label: string): string | null {
  if (!value) {
    return null;
  }
  return createHmac("sha256", START_OPTIONS_KEY_SECRET)
    .update(label)
    .update("\0")
    .update(value)
    .digest("hex");
}

function splitShellWords(value: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (const char of value) {
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) {
    words.push(current);
  }
  return words;
}
