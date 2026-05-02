import path from "node:path";
import { buildPluginConfigSchema, type OpenClawPluginConfigSchema } from "openclaw/plugin-sdk/core";
import {
  formatPluginConfigIssue,
  mapPluginConfigIssues,
} from "openclaw/plugin-sdk/extension-shared";
import { z } from "openclaw/plugin-sdk/zod";

type OpenShellPluginConfig = {
  mode?: "mirror" | "remote";
  command?: string;
  gateway?: string;
  gatewayEndpoint?: string;
  from?: string;
  policy?: string;
  providers?: string[];
  gpu?: boolean;
  autoProviders?: boolean;
  remoteWorkspaceDir?: string;
  remoteAgentWorkspaceDir?: string;
  timeoutSeconds?: number;
};

export type ResolvedOpenShellPluginConfig = {
  mode: "mirror" | "remote";
  command: string;
  gateway?: string;
  gatewayEndpoint?: string;
  from: string;
  policy?: string;
  providers: string[];
  gpu: boolean;
  autoProviders: boolean;
  remoteWorkspaceDir: string;
  remoteAgentWorkspaceDir: string;
  timeoutMs: number;
};

const DEFAULT_COMMAND = "openshell";
const DEFAULT_MODE = "mirror";
const DEFAULT_SOURCE = "openclaw";
const DEFAULT_REMOTE_WORKSPACE_DIR = "/sandbox";
const DEFAULT_REMOTE_AGENT_WORKSPACE_DIR = "/agent";
const DEFAULT_TIMEOUT_MS = 120_000;
const OPEN_SHELL_MANAGED_REMOTE_ROOTS = [
  DEFAULT_REMOTE_WORKSPACE_DIR,
  DEFAULT_REMOTE_AGENT_WORKSPACE_DIR,
] as const;

function normalizeProviders(value: string[] | undefined): string[] {
  const seen = new Set<string>();
  const providers: string[] = [];
  for (const entry of value ?? []) {
    const normalized = entry.trim();
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    providers.push(normalized);
  }
  return providers;
}

const nonEmptyTrimmedString = (message: string) =>
  z.string({ error: message }).trim().min(1, { error: message });

const OpenShellPluginConfigSchema = z.strictObject({
  mode: z.enum(["mirror", "remote"], { error: "mode must be one of mirror, remote" }).optional(),
  command: nonEmptyTrimmedString("command must be a non-empty string").optional(),
  gateway: nonEmptyTrimmedString("gateway must be a non-empty string").optional(),
  gatewayEndpoint: nonEmptyTrimmedString("gatewayEndpoint must be a non-empty string").optional(),
  from: nonEmptyTrimmedString("from must be a non-empty string").optional(),
  policy: nonEmptyTrimmedString("policy must be a non-empty string").optional(),
  providers: z
    .array(
      z.string({ error: "providers must be an array of strings" }).trim().min(1, {
        error: "providers must be an array of strings",
      }),
      {
        error: "providers must be an array of strings",
      },
    )
    .optional(),
  gpu: z.boolean({ error: "gpu must be a boolean" }).optional(),
  autoProviders: z.boolean({ error: "autoProviders must be a boolean" }).optional(),
  remoteWorkspaceDir: nonEmptyTrimmedString(
    "remoteWorkspaceDir must be a non-empty string",
  ).optional(),
  remoteAgentWorkspaceDir: nonEmptyTrimmedString(
    "remoteAgentWorkspaceDir must be a non-empty string",
  ).optional(),
  timeoutSeconds: z
    .number({ error: "timeoutSeconds must be a number >= 1" })
    .min(1, { error: "timeoutSeconds must be a number >= 1" })
    .optional(),
});

function isManagedOpenShellRemotePath(value: string): boolean {
  return OPEN_SHELL_MANAGED_REMOTE_ROOTS.some(
    (root) => value === root || value.startsWith(`${root}/`),
  );
}

function normalizeOpenShellRemotePath(
  value: string | undefined,
  fallback: string,
  fieldName = "remote path",
): string {
  const candidate = value ?? fallback;
  const normalized = path.posix.normalize(candidate.trim() || fallback);
  if (!normalized.startsWith("/")) {
    throw new Error(`OpenShell ${fieldName} must be absolute: ${candidate}`);
  }
  if (!isManagedOpenShellRemotePath(normalized)) {
    throw new Error(
      `OpenShell ${fieldName} must stay under ${OPEN_SHELL_MANAGED_REMOTE_ROOTS.join(" or ")}: ${candidate}`,
    );
  }
  return normalized;
}

export function createOpenShellPluginConfigSchema(): OpenClawPluginConfigSchema {
  return buildPluginConfigSchema(OpenShellPluginConfigSchema, {
    safeParse(value) {
      if (value === undefined) {
        return { success: true, data: undefined };
      }
      const parsed = OpenShellPluginConfigSchema.safeParse(value);
      if (parsed.success) {
        return { success: true, data: parsed.data };
      }
      return {
        success: false,
        error: {
          issues: mapPluginConfigIssues(parsed.error.issues),
        },
      };
    },
  });
}

export function resolveOpenShellPluginConfig(value: unknown): ResolvedOpenShellPluginConfig {
  if (value === undefined) {
    // The built-in defaults are managed OpenShell roots, so they do not need to
    // flow back through normalizeOpenShellRemotePath.
    return {
      mode: DEFAULT_MODE,
      command: DEFAULT_COMMAND,
      gateway: undefined,
      gatewayEndpoint: undefined,
      from: DEFAULT_SOURCE,
      policy: undefined,
      providers: [],
      gpu: false,
      autoProviders: true,
      remoteWorkspaceDir: DEFAULT_REMOTE_WORKSPACE_DIR,
      remoteAgentWorkspaceDir: DEFAULT_REMOTE_AGENT_WORKSPACE_DIR,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    };
  }

  const parsed = OpenShellPluginConfigSchema.safeParse(value);
  if (!parsed.success) {
    const message = formatPluginConfigIssue(parsed.error.issues[0]);
    throw new Error(`Invalid openshell plugin config: ${message}`);
  }
  const cfg = parsed.data as OpenShellPluginConfig;
  const mode = cfg.mode ?? DEFAULT_MODE;
  return {
    mode,
    command: cfg.command ?? DEFAULT_COMMAND,
    gateway: cfg.gateway,
    gatewayEndpoint: cfg.gatewayEndpoint,
    from: cfg.from ?? DEFAULT_SOURCE,
    policy: cfg.policy,
    providers: normalizeProviders(cfg.providers),
    gpu: cfg.gpu ?? false,
    autoProviders: cfg.autoProviders ?? true,
    remoteWorkspaceDir: normalizeOpenShellRemotePath(
      cfg.remoteWorkspaceDir,
      DEFAULT_REMOTE_WORKSPACE_DIR,
      "remoteWorkspaceDir",
    ),
    remoteAgentWorkspaceDir: normalizeOpenShellRemotePath(
      cfg.remoteAgentWorkspaceDir,
      DEFAULT_REMOTE_AGENT_WORKSPACE_DIR,
      "remoteAgentWorkspaceDir",
    ),
    timeoutMs:
      typeof cfg.timeoutSeconds === "number"
        ? Math.floor(cfg.timeoutSeconds * 1000)
        : DEFAULT_TIMEOUT_MS,
  };
}
