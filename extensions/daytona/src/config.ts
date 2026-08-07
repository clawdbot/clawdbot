// Daytona sandbox plugin config schema and resolution.
import path from "node:path";
import { buildPluginConfigSchema, type OpenClawPluginConfigSchema } from "openclaw/plugin-sdk/core";
import {
  formatPluginConfigIssue,
  mapPluginConfigIssues,
} from "openclaw/plugin-sdk/extension-shared";
import { MAX_TIMER_TIMEOUT_SECONDS } from "openclaw/plugin-sdk/number-runtime";
import { buildOptionalSecretInputSchema, type SecretInput } from "openclaw/plugin-sdk/secret-input";
import { z } from "zod";

export type ResolvedDaytonaPluginConfig = {
  apiKey?: SecretInput;
  apiUrl?: string;
  target?: string;
  snapshot?: string;
  autoStopInterval?: number;
  autoDeleteInterval?: number;
  networkBlockAll?: boolean;
  remoteWorkspaceDir: string;
  remoteAgentWorkspaceDir: string;
  timeoutMs: number;
};

const DEFAULT_REMOTE_WORKSPACE_DIR = "/home/daytona/workspace";
const DEFAULT_REMOTE_AGENT_WORKSPACE_DIR = "/home/daytona/agent";
const DEFAULT_TIMEOUT_MS = 120_000;

const nonEmptyTrimmedString = (message: string) =>
  z.string({ error: message }).trim().min(1, { error: message });

const optionalMinutesInterval = (field: string) =>
  z
    .int({ error: `${field} must be an integer number of minutes >= 0` })
    .min(0, { error: `${field} must be an integer number of minutes >= 0` })
    .optional();

const DaytonaPluginConfigSchema = z.strictObject({
  apiKey: buildOptionalSecretInputSchema(),
  apiUrl: nonEmptyTrimmedString("apiUrl must be a non-empty string").optional(),
  target: nonEmptyTrimmedString("target must be a non-empty string").optional(),
  snapshot: nonEmptyTrimmedString("snapshot must be a non-empty string").optional(),
  autoStopInterval: optionalMinutesInterval("autoStopInterval"),
  autoDeleteInterval: optionalMinutesInterval("autoDeleteInterval"),
  networkBlockAll: z.boolean({ error: "networkBlockAll must be a boolean" }).optional(),
  remoteWorkspaceDir: nonEmptyTrimmedString(
    "remoteWorkspaceDir must be a non-empty string",
  ).optional(),
  remoteAgentWorkspaceDir: nonEmptyTrimmedString(
    "remoteAgentWorkspaceDir must be a non-empty string",
  ).optional(),
  timeoutSeconds: z
    .number({
      error: `timeoutSeconds must be a number between 1 and ${MAX_TIMER_TIMEOUT_SECONDS}`,
    })
    .min(1, { error: "timeoutSeconds must be a number >= 1" })
    .max(MAX_TIMER_TIMEOUT_SECONDS, {
      error: `timeoutSeconds must be a number <= ${MAX_TIMER_TIMEOUT_SECONDS}`,
    })
    .optional(),
});

function normalizeDaytonaRemotePath(
  value: string | undefined,
  fallback: string,
  fieldName: string,
): string {
  const candidate = value ?? fallback;
  const normalized = path.posix.normalize(candidate.trim() || fallback);
  if (!normalized.startsWith("/")) {
    throw new Error(`Daytona ${fieldName} must be an absolute POSIX path: ${candidate}`);
  }
  const trimmed = normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
  if (trimmed === "/") {
    throw new Error(`Daytona ${fieldName} must not be the filesystem root: ${candidate}`);
  }
  return trimmed;
}

export function createDaytonaPluginConfigSchema(): OpenClawPluginConfigSchema {
  return buildPluginConfigSchema(DaytonaPluginConfigSchema, {
    safeParse(value) {
      if (value === undefined) {
        return { success: true, data: undefined };
      }
      const parsed = DaytonaPluginConfigSchema.safeParse(value);
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

export function resolveDaytonaPluginConfig(value: unknown): ResolvedDaytonaPluginConfig {
  if (value === undefined) {
    return {
      remoteWorkspaceDir: DEFAULT_REMOTE_WORKSPACE_DIR,
      remoteAgentWorkspaceDir: DEFAULT_REMOTE_AGENT_WORKSPACE_DIR,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    };
  }

  const parsed = DaytonaPluginConfigSchema.safeParse(value);
  if (!parsed.success) {
    const message = formatPluginConfigIssue(parsed.error.issues[0]);
    throw new Error(`Invalid daytona plugin config: ${message}`);
  }
  const cfg = parsed.data;
  const remoteWorkspaceDir = normalizeDaytonaRemotePath(
    cfg.remoteWorkspaceDir,
    DEFAULT_REMOTE_WORKSPACE_DIR,
    "remoteWorkspaceDir",
  );
  const remoteAgentWorkspaceDir = normalizeDaytonaRemotePath(
    cfg.remoteAgentWorkspaceDir,
    DEFAULT_REMOTE_AGENT_WORKSPACE_DIR,
    "remoteAgentWorkspaceDir",
  );
  // Distinct roots keep workspace/agent mount resolution unambiguous in the
  // shared remote fs bridge; nested roots would shadow each other.
  if (
    remoteWorkspaceDir === remoteAgentWorkspaceDir ||
    remoteWorkspaceDir.startsWith(`${remoteAgentWorkspaceDir}/`) ||
    remoteAgentWorkspaceDir.startsWith(`${remoteWorkspaceDir}/`)
  ) {
    throw new Error(
      `Daytona remoteWorkspaceDir and remoteAgentWorkspaceDir must be distinct, non-nested paths: ${remoteWorkspaceDir}, ${remoteAgentWorkspaceDir}`,
    );
  }
  return {
    apiKey: cfg.apiKey,
    apiUrl: cfg.apiUrl,
    target: cfg.target,
    snapshot: cfg.snapshot,
    autoStopInterval: cfg.autoStopInterval,
    autoDeleteInterval: cfg.autoDeleteInterval,
    networkBlockAll: cfg.networkBlockAll,
    remoteWorkspaceDir,
    remoteAgentWorkspaceDir,
    timeoutMs:
      typeof cfg.timeoutSeconds === "number"
        ? Math.floor(cfg.timeoutSeconds * 1000)
        : DEFAULT_TIMEOUT_MS,
  };
}
