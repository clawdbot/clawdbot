import crypto from "node:crypto";

import type { SandboxDockerConfig, SandboxWorkspaceAccess } from "./types.js";

type SandboxHashInput = {
  docker: SandboxDockerConfig;
  workspaceAccess: SandboxWorkspaceAccess;
  workspaceDir: string;
  agentWorkspaceDir: string;
};

function isPrimitive(value: unknown): value is string | number | boolean | bigint | symbol | null {
  return value === null || (typeof value !== "object" && typeof value !== "function");
}

function normalizeForHash(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    const normalized = value
      .map(normalizeForHash)
      .filter((item): item is unknown => item !== undefined);
    const primitives = normalized.filter(isPrimitive);
    if (primitives.length === normalized.length) {
      return [...primitives].sort((a, b) => String(a).localeCompare(String(b)));
    }
    return normalized;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    const normalized: Record<string, unknown> = {};
    for (const [key, entryValue] of entries) {
      const next = normalizeForHash(entryValue);
      if (next !== undefined) normalized[key] = next;
    }
    return normalized;
  }
  return value;
}

export function computeSandboxConfigHash(input: SandboxHashInput): string {
  const payload = normalizeForHash(input);
  const raw = JSON.stringify(payload);
  return crypto.createHash("sha1").update(raw).digest("hex");
}
