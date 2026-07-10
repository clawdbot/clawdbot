/**
 * Stable sandbox config hashing.
 *
 * Normalizes hash inputs so container reuse changes only when security, mount, workspace, or image policy changes.
 */
import { hashTextSha256 } from "./hash.js";
import type { SandboxBrowserConfig, SandboxDockerConfig, SandboxWorkspaceAccess } from "./types.js";

/**
 * Stable sandbox config hashing for container reuse decisions.
 *
 * Undefined values and object key order are normalized so semantically equal
 * configs keep the same hash while security epoch changes force recreation.
 */
export const SANDBOX_DOCKER_EXPLICIT_ENV_POLICY_EPOCH = "explicit-config-env-v1";

type SandboxHashInput = {
  docker: SandboxDockerConfig;
  dockerEnvPolicyEpoch?: string;
  workspaceAccess: SandboxWorkspaceAccess;
  workspaceDir: string;
  agentWorkspaceDir: string;
  mountFormatVersion: number;
  createArgsEpoch: string;
  readOnlyWorkspaceSkillMounts?: readonly string[];
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
  createArgsEpoch: string;
  readOnlyWorkspaceSkillMounts?: readonly string[];
};

function normalizeForHash(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map(normalizeForHash).filter((item): item is unknown => item !== undefined);
  }
  if (value && typeof value === "object") {
    // Sort object keys recursively so JSON serialization is deterministic.
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

/** Computes the sandbox container config hash. */
export function computeSandboxConfigHash(input: SandboxHashInput): string {
  return computeHash(input);
}

/** Computes the browser-enabled sandbox container config hash. */
export function computeSandboxBrowserConfigHash(input: SandboxBrowserHashInput): string {
  return computeHash(input);
}

function computeHash(input: unknown): string {
  const payload = normalizeForHash(input);
  const raw = JSON.stringify(payload);
  return hashTextSha256(raw);
}
