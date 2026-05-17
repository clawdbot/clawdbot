import { hashTextSha256 } from "./hash.js";
import type { SandboxBrowserConfig, SandboxDockerConfig, SandboxWorkspaceAccess } from "./types.js";

export const SANDBOX_DOCKER_EXPLICIT_ENV_POLICY_EPOCH = "explicit-config-env-v1";

type SandboxHashInput = {
  docker: SandboxDockerConfig;
  dockerEnvPolicyEpoch?: string;
  workspaceAccess: SandboxWorkspaceAccess;
  workspaceDir: string;
  agentWorkspaceDir: string;
  mountFormatVersion: number;
};

type SandboxBrowserHashInput = {
  docker: SandboxDockerConfig;
  dockerEnvPolicyEpoch?: string;
  browser: Pick<
    SandboxBrowserConfig,
    | "cdpPort"
    | "cdpSourceRange"
    | "vncPort"
    | "noVncPort"
    | "headless"
    | "enableNoVnc"
    | "autoStartTimeoutMs"
  >;
  securityEpoch: string;
  workspaceAccess: SandboxWorkspaceAccess;
  workspaceDir: string;
  agentWorkspaceDir: string;
  mountFormatVersion: number;
};

function normalizeForHash(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map(normalizeForHash).filter((item): item is unknown => item !== undefined);
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).toSorted(([a], [b]) => a.localeCompare(b));
    const normalized: Record<string, unknown> = {};
    for (const [key, entryValue] of entries) {
      const next = normalizeForHash(entryValue);
      if (next !== undefined) {
        normalized[key] = next;
      }
    }
    return normalized;
  }
  return value;
}

export function computeSandboxConfigHash(input: SandboxHashInput): string {
  return computeHash(input);
}

export function computeSandboxBrowserConfigHash(input: SandboxBrowserHashInput): string {
  return computeHash(input);
}

function computeHash(input: unknown): string {
  const payload = normalizeForHash(input);
  const raw = JSON.stringify(payload);
  return hashTextSha256(raw);
}
