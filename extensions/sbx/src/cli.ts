// Sbx plugin module implements cli behavior.
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ResolvedSbxPluginConfig } from "./config.js";
import { spawnSbx } from "./spawn.js";

type SbxCliResult = { code: number; stdout: string; stderr: string };

/** Run the configured `sbx` CLI binary, buffering stdout/stderr as text. */
export async function runSbxCli(params: {
  config: ResolvedSbxPluginConfig;
  args: string[];
  timeoutMs?: number;
  allowFailure?: boolean;
}): Promise<SbxCliResult> {
  const result = await spawnSbx([params.config.command, ...params.args], {
    timeoutMs: params.timeoutMs ?? params.config.timeoutMs,
    allowFailure: true,
  }).catch((error: unknown) => {
    if (params.allowFailure) {
      throw error;
    }
    return {
      code: 1,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from(error instanceof Error ? error.message : String(error)),
    };
  });
  return {
    code: result.code,
    stdout: result.stdout.toString("utf8"),
    stderr: result.stderr.toString("utf8"),
  };
}

type SbxLsEntry = {
  name: string;
  status?: string;
};

type SbxLsOutput = SbxLsEntry[] | { sandboxes?: SbxLsEntry[] };

/** Look up a sandbox by name via `sbx ls --json`. */
export async function findSbxSandboxByName(params: {
  config: ResolvedSbxPluginConfig;
  name: string;
}): Promise<SbxLsEntry | null> {
  const result = await runSbxCli({ config: params.config, args: ["ls", "--json"] });
  if (result.code !== 0) {
    return null;
  }
  let parsed: SbxLsOutput;
  try {
    parsed = JSON.parse(result.stdout || "{}") as SbxLsOutput;
  } catch {
    return null;
  }
  // `sbx ls --json` returns `{ "sandboxes": [...] }`; tolerate a bare array
  // too in case a future/older CLI build changes the wire shape.
  const entries = Array.isArray(parsed) ? parsed : (parsed.sandboxes ?? []);
  return entries.find((entry) => entry.name === params.name) ?? null;
}

/** Build a stable, sbx-name-safe sandbox identifier from a scope key. */
export function buildSbxSandboxName(scopeKey: string): string {
  const trimmed = scopeKey.trim() || "session";
  const safe = normalizeLowercaseStringOrEmpty(trimmed)
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const hash = Array.from(trimmed).reduce(
    (acc, char) => ((acc * 33) ^ char.charCodeAt(0)) >>> 0,
    5381,
  );
  return `openclaw-${safe || "session"}-${hash.toString(16).slice(0, 8)}`;
}
