import { z } from "zod";

export type CodexAppServerTransportMode = "stdio" | "websocket";
export type CodexAppServerApprovalPolicy = "never" | "on-request" | "on-failure" | "untrusted";
export type CodexAppServerSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type CodexAppServerApprovalsReviewer = "user" | "guardian_subagent";

export type CodexAppServerStartOptions = {
  transport: CodexAppServerTransportMode;
  command: string;
  args: string[];
  url?: string;
  authToken?: string;
  headers: Record<string, string>;
};

export type CodexAppServerRuntimeOptions = {
  start: CodexAppServerStartOptions;
  requestTimeoutMs: number;
  approvalPolicy: CodexAppServerApprovalPolicy;
  sandbox: CodexAppServerSandboxMode;
  approvalsReviewer: CodexAppServerApprovalsReviewer;
  serviceTier?: string;
};

export type CodexPluginConfig = {
  discovery?: {
    enabled?: boolean;
    timeoutMs?: number;
  };
  appServer?: {
    transport?: CodexAppServerTransportMode;
    command?: string;
    args?: string[] | string;
    url?: string;
    authToken?: string;
    headers?: Record<string, string>;
    requestTimeoutMs?: number;
    approvalPolicy?: CodexAppServerApprovalPolicy;
    sandbox?: CodexAppServerSandboxMode;
    approvalsReviewer?: CodexAppServerApprovalsReviewer;
    serviceTier?: string;
  };
};

export const CODEX_APP_SERVER_CONFIG_KEYS = [
  "transport",
  "command",
  "args",
  "url",
  "authToken",
  "headers",
  "requestTimeoutMs",
  "approvalPolicy",
  "sandbox",
  "approvalsReviewer",
  "serviceTier",
] as const;

const codexAppServerTransportSchema = z.enum(["stdio", "websocket"]);
const codexAppServerApprovalPolicySchema = z.enum([
  "never",
  "on-request",
  "on-failure",
  "untrusted",
]);
const codexAppServerSandboxSchema = z.enum(["read-only", "workspace-write", "danger-full-access"]);
const codexAppServerApprovalsReviewerSchema = z.enum(["user", "guardian_subagent"]);

const codexPluginConfigSchema = z
  .object({
    discovery: z
      .object({
        enabled: z.boolean().optional(),
        timeoutMs: z.number().positive().optional(),
      })
      .strict()
      .optional(),
    appServer: z
      .object({
        transport: codexAppServerTransportSchema.optional(),
        command: z.string().optional(),
        args: z.union([z.array(z.string()), z.string()]).optional(),
        url: z.string().optional(),
        authToken: z.string().optional(),
        headers: z.record(z.string(), z.string()).optional(),
        requestTimeoutMs: z.number().positive().optional(),
        approvalPolicy: codexAppServerApprovalPolicySchema.optional(),
        sandbox: codexAppServerSandboxSchema.optional(),
        approvalsReviewer: codexAppServerApprovalsReviewerSchema.optional(),
        serviceTier: z.string().optional(),
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
  const command =
    readNonEmptyString(config.command) ?? env.OPENCLAW_CODEX_APP_SERVER_BIN ?? "codex";
  const args = resolveArgs(config.args, env.OPENCLAW_CODEX_APP_SERVER_ARGS);
  const headers = normalizeHeaders(config.headers);
  const authToken = readNonEmptyString(config.authToken);
  const url = readNonEmptyString(config.url);
  if (transport === "websocket" && !url) {
    throw new Error(
      "plugins.entries.codex.config.appServer.url is required when appServer.transport is websocket",
    );
  }

  return {
    start: {
      transport,
      command,
      args: args.length > 0 ? args : ["app-server", "--listen", "stdio://"],
      ...(url ? { url } : {}),
      ...(authToken ? { authToken } : {}),
      headers,
    },
    requestTimeoutMs: normalizePositiveNumber(config.requestTimeoutMs, 60_000),
    approvalPolicy:
      resolveApprovalPolicy(config.approvalPolicy) ??
      resolveApprovalPolicy(env.OPENCLAW_CODEX_APP_SERVER_APPROVAL_POLICY) ??
      "never",
    sandbox:
      resolveSandbox(config.sandbox) ??
      resolveSandbox(env.OPENCLAW_CODEX_APP_SERVER_SANDBOX) ??
      "workspace-write",
    approvalsReviewer:
      resolveApprovalsReviewer(config.approvalsReviewer) ??
      (env.OPENCLAW_CODEX_APP_SERVER_GUARDIAN === "1" ? "guardian_subagent" : "user"),
    ...(readNonEmptyString(config.serviceTier)
      ? { serviceTier: readNonEmptyString(config.serviceTier) }
      : {}),
  };
}

export function codexAppServerStartOptionsKey(options: CodexAppServerStartOptions): string {
  return JSON.stringify({
    transport: options.transport,
    command: options.command,
    args: options.args,
    url: options.url ?? null,
    authToken: options.authToken ? "<set>" : null,
    headers: Object.entries(options.headers).toSorted(([left], [right]) =>
      left.localeCompare(right),
    ),
  });
}

function resolveTransport(value: unknown): CodexAppServerTransportMode {
  return value === "websocket" ? "websocket" : "stdio";
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
  return value === "guardian_subagent" || value === "user" ? value : undefined;
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
